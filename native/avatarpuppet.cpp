#include "avatarpuppet.h"

#include "avatarskeleton.h"
#include "referenceart.h"

#include <QFileInfo>
#include <QHash>
#include <QImage>
#include <QImageReader>
#include <QMatrix4x4>
#include <QMetaType>
#include <QPointer>
#include <QQueue>
#include <QQuickWindow>
#include <QSGImageNode>
#include <QSGOpacityNode>
#include <QSGTexture>
#include <QSGTransformNode>
#include <QTransform>
#include <QThreadPool>

#include <algorithm>
#include <cmath>
#include <functional>
#include <limits>

namespace {

constexpr qreal defaultReferenceWidth = 192.0;
constexpr qreal defaultReferenceHeight = 208.0;
constexpr qreal maximumDefinitionCoordinate = 1000000.0;
// Each cutout keeps area-averaged half-size copies. Painted atlases are drawn
// several times larger than the desktop pet, and bilinear sampling alone
// aliases (shimmers) at those reductions on both GPU and software backends.
constexpr int maximumTextureLevel = 4;
constexpr int minimumLevelSide = 4;
// Five gesture routes plus an authored carried loop, decoded one atlas at a time.
constexpr int maximumSurfaceFrames = 384;
// Cache neighboring drawings for click/reverse transitions without retaining
// a second unbounded copy of a 300-frame surface atlas.
constexpr int maximumPreparedSurfaceFrames = 16;
constexpr qreal heldSurfaceDeformationScale = 0.35;
constexpr int surfaceDeformationTransitionFrames = 8;

struct RawBone
{
    AvatarSkeleton::Bone bone;
    QString parentName;
    int parent = -1;
};

struct Part
{
    struct SurfaceFrame
    {
        QRect sourceRect;
        QRect blinkSourceRect;
        qreal deformationScale = 1.0;
    };

    QString name;
    int bone = -1;
    QRect sourceRect;
    QRectF rect;
    qreal z = 0.0;
    // Fixed artwork rotation about the bone origin, in clockwise degrees. It
    // aligns a painted limb with its bone without resampling the atlas.
    qreal rotation = 0.0;
    AvatarSkeleton::Transform local;
    int order = 0;
    QString opacityChannel;
    QString visibilityChannel;
    qreal visibilityMin = -std::numeric_limits<qreal>::infinity();
    qreal visibilityMax = std::numeric_limits<qreal>::infinity();
    bool mirrorX = false;
    bool surfaceMotion = false;
    QRect blinkSourceRect;
    // Frame zero is always the part's ordinary sourceRect/blinkSourceRect.
    QVector<SurfaceFrame> surfaceFrames;
};

struct PartImages
{
    QVector<QVector<QImage>> frames;
    QVector<QVector<QImage>> blinks;
    QVector<quint64> uses;
};

QString imagePath(const QUrl &source)
{
    if (source.isLocalFile())
        return source.toLocalFile();
    if (source.scheme() == QLatin1String("qrc"))
        return QLatin1Char(':') + source.path();
    if (source.scheme().isEmpty())
        return source.toString();
    return {};
}

struct ImageCache
{
    QString atlasKey;
    QImage atlas;
};

ImageCache &imageCache()
{
    // Synchronous callers and asynchronous GUI-side completions share one
    // most-recent atlas. A generated surface atlas is hundreds of decoded
    // megabytes; live async puppets pin only their own implicitly shared image.
    static ImageCache cache;
    return cache;
}

QImage decodeAtlas(const QString &path);

QImage cachedAtlas(const QString &path, const QString &key)
{
    ImageCache &cache = imageCache();
    if (!key.isEmpty() && cache.atlasKey == key && !cache.atlas.isNull())
        return cache.atlas;
    QImage image = decodeAtlas(path);
    if (image.isNull())
        return image;
    cache.atlasKey = key;
    cache.atlas = image;
    return image;
}

QImage decodeAtlas(const QString &path)
{
    QImageReader reader(path);
    reader.setAutoTransform(true);
    QImage image = reader.read();
    if (!image.isNull())
        image = image.convertToFormat(QImage::Format_ARGB32_Premultiplied);
    return image;
}

struct AsyncAtlasRecipient
{
    std::function<bool()> current;
    std::function<void(const QImage &)> deliver;
};

struct AsyncAtlasJob
{
    QString key;
    QString path;
    QVector<AsyncAtlasRecipient> recipients;
};

struct AsyncAtlasState
{
    QHash<QString, std::shared_ptr<AsyncAtlasJob>> jobs;
    QQueue<std::shared_ptr<AsyncAtlasJob>> queued;
    std::shared_ptr<AsyncAtlasJob> active;
};

AsyncAtlasState &asyncAtlasState()
{
    // All state access happens through the GUI-side request/completion paths.
    static AsyncAtlasState state;
    return state;
}

QObject *asyncAtlasDispatcher()
{
    // Deliberately process-lifetime: workers can always enqueue completion
    // without racing destruction of an AvatarPuppet or application child.
    static QObject *dispatcher = new QObject;
    return dispatcher;
}

void startNextAsyncAtlasJob();

void finishAsyncAtlasJob(const QString &key, QImage image)
{
    AsyncAtlasState &state = asyncAtlasState();
    const std::shared_ptr<AsyncAtlasJob> job = state.jobs.take(key);
    if (!job || job != state.active)
        return;
    state.active.reset();
    bool delivered = false;
    for (const AsyncAtlasRecipient &recipient : job->recipients) {
        if (!recipient.current())
            continue;
        if (!delivered && !image.isNull()) {
            ImageCache &cache = imageCache();
            cache.atlasKey = key;
            cache.atlas = image;
        }
        delivered = true;
        recipient.deliver(image);
    }
    startNextAsyncAtlasJob();
}

void startNextAsyncAtlasJob()
{
    AsyncAtlasState &state = asyncAtlasState();
    if (state.active)
        return;
    while (!state.queued.isEmpty()) {
        const std::shared_ptr<AsyncAtlasJob> job = state.queued.dequeue();
        QVector<AsyncAtlasRecipient> current;
        current.reserve(job->recipients.size());
        for (const AsyncAtlasRecipient &recipient : std::as_const(job->recipients))
            if (recipient.current())
                current.append(recipient);
        job->recipients = std::move(current);
        if (job->recipients.isEmpty()) {
            state.jobs.remove(job->key);
            continue;
        }
        state.active = job;
        QObject *const dispatcher = asyncAtlasDispatcher();
        QThreadPool::globalInstance()->start([key = job->key, path = job->path,
                                               dispatcher] {
            QImage image = decodeAtlas(path);
            QMetaObject::invokeMethod(dispatcher,
                    [key, image = std::move(image)]() mutable {
                finishAsyncAtlasJob(key, std::move(image));
            }, Qt::QueuedConnection);
        });
        return;
    }
}

void requestAsyncAtlas(const QString &key, const QString &path,
                       AsyncAtlasRecipient recipient)
{
    AsyncAtlasState &state = asyncAtlasState();
    ImageCache &cache = imageCache();
    if (!key.isEmpty() && key == cache.atlasKey && !cache.atlas.isNull()) {
        QMetaObject::invokeMethod(asyncAtlasDispatcher(),
                [recipient = std::move(recipient), image = cache.atlas] {
            if (recipient.current())
                recipient.deliver(image);
        }, Qt::QueuedConnection);
        return;
    }
    const auto existing = state.jobs.constFind(key);
    if (existing != state.jobs.cend()) {
        (*existing)->recipients.append(std::move(recipient));
        return;
    }
    auto job = std::make_shared<AsyncAtlasJob>();
    job->key = key;
    job->path = path;
    job->recipients.append(std::move(recipient));
    state.jobs.insert(key, job);
    state.queued.enqueue(job);
    startNextAsyncAtlasJob();
}

QVector<QImage> textureLevels(const QImage &crop)
{
    // Pad to a multiple of the coarsest divisor so each level is an exact
    // reduction: the painted region keeps its registration at every level.
    constexpr int step = 1 << maximumTextureLevel;
    QImage padded(((crop.width() + step - 1) / step) * step,
                  ((crop.height() + step - 1) / step) * step,
                  QImage::Format_ARGB32_Premultiplied);
    padded.fill(Qt::transparent);
    for (int y = 0; y < crop.height(); ++y)
        std::copy_n(reinterpret_cast<const QRgb *>(crop.constScanLine(y)), crop.width(),
                    reinterpret_cast<QRgb *>(padded.scanLine(y)));
    QVector<QImage> levels{crop};
    for (int level = 1; level <= maximumTextureLevel; ++level) {
        const int divisor = 1 << level;
        if (crop.width() / divisor < minimumLevelSide || crop.height() / divisor < minimumLevelSide)
            break;
        // Premultiplied area averaging; every level is reduced from the crop.
        levels.append(padded.scaled(padded.size() / divisor, Qt::IgnoreAspectRatio,
                                    Qt::SmoothTransformation));
    }
    return levels;
}

bool finiteNumber(const QVariant &value, qreal *number)
{
    bool ok = false;
    const qreal candidate = value.toDouble(&ok);
    if (!ok || !std::isfinite(candidate))
        return false;
    *number = candidate;
    return true;
}

bool boundedNumber(const QVariant &value, qreal *number)
{
    return finiteNumber(value, number)
            && std::abs(*number) <= maximumDefinitionCoordinate;
}

bool optionalNumber(const QVariantMap &map, const char *key, qreal fallback,
                    qreal *number, QString *error)
{
    const auto found = map.constFind(QLatin1String(key));
    if (found == map.cend()) {
        *number = fallback;
        return true;
    }
    if (!boundedNumber(*found, number)) {
        *error = QStringLiteral("%1 must be a finite bounded number")
                         .arg(QLatin1String(key));
        return false;
    }
    return true;
}

bool optionalChannel(const QVariantMap &map, const char *key, QString *channel,
                     QString *error)
{
    const auto found = map.constFind(QLatin1String(key));
    if (found == map.cend()) {
        channel->clear();
        return true;
    }
    if (found->metaType().id() != QMetaType::QString) {
        *error = QStringLiteral("%1 must be a channel string")
                         .arg(QLatin1String(key));
        return false;
    }
    *channel = found->toString();
    return true;
}

bool optionalBoolean(const QVariantMap &map, const char *key, bool fallback,
                     bool *value, QString *error)
{
    const auto found = map.constFind(QLatin1String(key));
    if (found == map.cend()) {
        *value = fallback;
        return true;
    }
    if (found->metaType().id() != QMetaType::Bool) {
        *error = QStringLiteral("%1 must be a boolean").arg(QLatin1String(key));
        return false;
    }
    *value = found->toBool();
    return true;
}

bool numberList(const QVariant &value, int expected, QVector<qreal> *numbers)
{
    if (!value.canConvert<QVariantList>())
        return false;
    const QVariantList list = value.toList();
    if (list.size() != expected)
        return false;
    numbers->clear();
    numbers->reserve(expected);
    for (const QVariant &entry : list) {
        qreal number = 0.0;
        if (!boundedNumber(entry, &number))
            return false;
        numbers->append(number);
    }
    return true;
}

bool pixelRect(const QVariant &value, QRect *rect)
{
    if (value.metaType().id() != QMetaType::QVariantList)
        return false;
    const QVariantList list = value.toList();
    if (list.size() != 4)
        return false;
    QVector<qreal> coordinates;
    coordinates.reserve(4);
    for (const QVariant &entry : list) {
        const int type = entry.metaType().id();
        qreal coordinate = 0.0;
        if (type == QMetaType::QString || type == QMetaType::Bool
                || !boundedNumber(entry, &coordinate)) {
            return false;
        }
        coordinates.append(coordinate);
    }
    if (coordinates[0] < 0.0 || coordinates[1] < 0.0
            || coordinates[2] <= 0.0 || coordinates[3] <= 0.0
            || coordinates[0] != std::floor(coordinates[0])
            || coordinates[1] != std::floor(coordinates[1])
            || coordinates[2] != std::floor(coordinates[2])
            || coordinates[3] != std::floor(coordinates[3])) {
        return false;
    }
    *rect = QRect(int(coordinates[0]), int(coordinates[1]),
                  int(coordinates[2]), int(coordinates[3]));
    return true;
}

QMatrix4x4 matrixFor(const AvatarSkeleton::Transform &transform)
{
    return QMatrix4x4(float(transform.m11), float(transform.m12), 0.0f,
                      float(transform.dx),
                      float(transform.m21), float(transform.m22), 0.0f,
                      float(transform.dy),
                      0.0f, 0.0f, 1.0f, 0.0f,
                      0.0f, 0.0f, 0.0f, 1.0f);
}

class PuppetNode final : public QSGNode
{
public:
    struct RenderPart
    {
        QSGTransformNode *transform = nullptr;
        QSGOpacityNode *opacity = nullptr;
        QSGImageNode *image = nullptr;
        int part = -1;
        ReferenceArt::Pose surfacePose;
        bool surfacePoseValid = false;
        int surfaceFrame = -1;
        int surfaceLevel = -1;
        int surfaceOriginalFrame = -1;
        int surfaceOriginalLevel = -1;
        int surfaceWinkFrame = -1;
        int surfaceWinkLevel = -1;
        ReferenceArt::WinkSelection surfaceWink;
        QSGTexture *surfaceOriginal = nullptr;
        QSGTexture *surfaceDynamic = nullptr;
    };

    ~PuppetNode() override
    {
        for (RenderPart &part : parts) {
            if (!part.surfaceOriginal && !part.surfaceDynamic)
                continue;
            part.image->setOwnsTexture(false);
            delete part.surfaceDynamic;
            delete part.surfaceOriginal;
        }
    }

    quint64 revision = 0;
    QVector<int> levels;
    QVector<RenderPart> parts;
};

} // namespace

struct AvatarPuppet::Private
{
    QUrl source;
    QVariantMap definition;
    QVariantMap pose;
    int surfaceFrame = 0;
    QString sourceKey;
    QSizeF referenceSize{defaultReferenceWidth, defaultReferenceHeight};
    QVector<AvatarSkeleton::Bone> bones;
    QVector<Part> parts;
    QVector<PartImages> partImages;
    QImage retainedAtlas;
    quint64 imageUse = 0;
    quint64 revision = 0;
    bool ready = false;
    bool validationOnly = false;
    bool asynchronous = false;
    QString error;
};

AvatarPuppet::AvatarPuppet(QQuickItem *parent)
    : QQuickItem(parent), d(std::make_unique<Private>())
{
    setFlag(ItemHasContents, true);
    setImplicitSize(defaultReferenceWidth, defaultReferenceHeight);
}

AvatarPuppet::~AvatarPuppet() = default;

QUrl AvatarPuppet::source() const
{
    return d->source;
}

void AvatarPuppet::setSource(const QUrl &source)
{
    if (d->source == source)
        return;
    d->source = source;
    emit sourceChanged();
    loadSource();
}

QVariantMap AvatarPuppet::definition() const
{
    return d->definition;
}

void AvatarPuppet::setDefinition(const QVariantMap &definition)
{
    if (d->definition == definition)
        return;
    d->definition = definition;
    emit definitionChanged();
    rebuild();
}

QVariantMap AvatarPuppet::pose() const
{
    return d->pose;
}

void AvatarPuppet::setPose(const QVariantMap &pose)
{
    if (d->pose == pose)
        return;
    d->pose = pose;
    emit poseChanged();
    update();
}

int AvatarPuppet::surfaceFrame() const
{
    return d->surfaceFrame;
}

void AvatarPuppet::setSurfaceFrame(int frame)
{
    if (d->surfaceFrame == frame)
        return;
    d->surfaceFrame = frame;
    if (d->ready && !d->validationOnly) {
        QString preparationError;
        if (!prepareFrameImages(frame, &preparationError))
            setStatus(false, preparationError);
    }
    emit surfaceFrameChanged();
    update();
}

bool AvatarPuppet::asynchronous() const
{
    return d->asynchronous;
}

void AvatarPuppet::setAsynchronous(bool asynchronous)
{
    if (d->asynchronous == asynchronous)
        return;
    d->asynchronous = asynchronous;
    emit asynchronousChanged();
    rebuild();
}

bool AvatarPuppet::ready() const
{
    return d->ready;
}

void AvatarPuppet::setValidationOnly(bool validationOnly)
{
    if (d->validationOnly == validationOnly)
        return;
    d->validationOnly = validationOnly;
    rebuild();
}

QString AvatarPuppet::error() const
{
    return d->error;
}

void AvatarPuppet::setStatus(bool ready, const QString &error)
{
    const bool readyDidChange = d->ready != ready;
    const bool errorDidChange = d->error != error;
    d->ready = ready;
    d->error = error;
    if (errorDidChange)
        emit errorChanged();
    if (readyDidChange)
        emit readyChanged();
}

void AvatarPuppet::loadSource()
{
    d->retainedAtlas = {};
    d->sourceKey.clear();
    const QString path = imagePath(d->source);
    if (!path.isEmpty()) {
        const QString canonical = QFileInfo(path).canonicalFilePath();
        d->sourceKey = canonical.isEmpty() ? path : canonical;
    }
    rebuild();
}

void AvatarPuppet::rebuild()
{
    d->bones.clear();
    d->parts.clear();
    d->partImages.clear();
    d->referenceSize = QSizeF(defaultReferenceWidth, defaultReferenceHeight);
    ++d->revision;

    QString validationError;
    bool versionOk = false;
    const int version = d->definition.value(QStringLiteral("version")).toInt(&versionOk);
    if (!versionOk || version != 1)
        validationError = QStringLiteral("definition version must be 1");

    QVector<qreal> reference;
    if (validationError.isEmpty()
            && (!numberList(d->definition.value(QStringLiteral("referenceSize")), 2,
                            &reference)
                || reference[0] <= 0.0 || reference[1] <= 0.0)) {
        validationError = QStringLiteral("referenceSize must contain two positive numbers");
    }

    QVariantList boneValues;
    if (validationError.isEmpty()) {
        boneValues = d->definition.value(QStringLiteral("bones")).toList();
        if (boneValues.isEmpty())
            validationError = QStringLiteral("bones must be a non-empty list");
    }

    QVector<RawBone> rawBones;
    QHash<QString, int> rawBoneIndex;
    if (validationError.isEmpty()) {
        rawBones.reserve(boneValues.size());
        for (int index = 0; index < boneValues.size(); ++index) {
            const QVariantMap map = boneValues[index].toMap();
            const QString name = map.value(QStringLiteral("name")).toString();
            if (name.isEmpty()) {
                validationError = QStringLiteral("bone %1 has no name").arg(index);
                break;
            }
            if (rawBoneIndex.contains(name)) {
                validationError = QStringLiteral("duplicate bone '%1'").arg(name);
                break;
            }
            RawBone raw;
            raw.bone.name = name;
            raw.parentName = map.value(QStringLiteral("parent")).toString();
            QString detail;
            if (!optionalNumber(map, "x", 0.0, &raw.bone.x, &detail)
                    || !optionalNumber(map, "y", 0.0, &raw.bone.y, &detail)
                    || !optionalChannel(map, "angle", &raw.bone.angleChannel, &detail)
                    || !optionalChannel(map, "offsetX", &raw.bone.offsetXChannel, &detail)
                    || !optionalChannel(map, "offsetY", &raw.bone.offsetYChannel, &detail)) {
                validationError = QStringLiteral("bone '%1': %2").arg(name, detail);
                break;
            }
            rawBoneIndex.insert(name, rawBones.size());
            rawBones.append(raw);
        }
    }

    if (validationError.isEmpty()) {
        for (RawBone &bone : rawBones) {
            if (bone.parentName.isEmpty())
                continue;
            const auto parent = rawBoneIndex.constFind(bone.parentName);
            if (parent == rawBoneIndex.cend()) {
                validationError = QStringLiteral("bone '%1' has unknown parent '%2'")
                                          .arg(bone.bone.name, bone.parentName);
                break;
            }
            bone.parent = *parent;
        }
    }

    QVector<int> order;
    if (validationError.isEmpty()) {
        QVector<quint8> state(rawBones.size(), 0);
        std::function<bool(int)> visit = [&](int index) {
            if (state[index] == 2)
                return true;
            if (state[index] == 1) {
                validationError = QStringLiteral("bone hierarchy contains a cycle at '%1'")
                                          .arg(rawBones[index].bone.name);
                return false;
            }
            state[index] = 1;
            if (rawBones[index].parent >= 0 && !visit(rawBones[index].parent))
                return false;
            state[index] = 2;
            order.append(index);
            return true;
        };
        for (int index = 0; index < rawBones.size() && validationError.isEmpty(); ++index)
            visit(index);
    }

    QHash<QString, int> boneIndex;
    if (validationError.isEmpty()) {
        QVector<int> remap(rawBones.size(), -1);
        for (int oldIndex : order) {
            AvatarSkeleton::Bone bone = rawBones[oldIndex].bone;
            bone.parent = rawBones[oldIndex].parent < 0
                    ? -1 : remap[rawBones[oldIndex].parent];
            remap[oldIndex] = d->bones.size();
            boneIndex.insert(bone.name, d->bones.size());
            d->bones.append(bone);
        }
    }

    QVariantList partValues;
    if (validationError.isEmpty()) {
        partValues = d->definition.value(QStringLiteral("parts")).toList();
        if (partValues.isEmpty())
            validationError = QStringLiteral("parts must be a non-empty list");
    }

    QHash<QString, bool> partNames;
    if (validationError.isEmpty()) {
        d->parts.reserve(partValues.size());
        for (int index = 0; index < partValues.size(); ++index) {
            const QVariantMap map = partValues[index].toMap();
            Part part;
            part.name = map.value(QStringLiteral("name")).toString();
            if (part.name.isEmpty()) {
                validationError = QStringLiteral("part %1 has no name").arg(index);
                break;
            }
            if (partNames.contains(part.name)) {
                validationError = QStringLiteral("duplicate part '%1'").arg(part.name);
                break;
            }
            partNames.insert(part.name, true);
            const QString boneName = map.value(QStringLiteral("bone")).toString();
            const auto bone = boneIndex.constFind(boneName);
            if (bone == boneIndex.cend()) {
                validationError = QStringLiteral("part '%1' has unknown bone '%2'")
                                          .arg(part.name, boneName);
                break;
            }
            part.bone = *bone;
            part.order = index;

            QVector<qreal> sourceRect;
            if (!numberList(map.value(QStringLiteral("sourceRect")), 4, &sourceRect)
                    || sourceRect[0] < 0.0 || sourceRect[1] < 0.0
                    || sourceRect[2] <= 0.0 || sourceRect[3] <= 0.0
                    || sourceRect[0] != std::floor(sourceRect[0])
                    || sourceRect[1] != std::floor(sourceRect[1])
                    || sourceRect[2] != std::floor(sourceRect[2])
                    || sourceRect[3] != std::floor(sourceRect[3])) {
                validationError = QStringLiteral("part '%1' has an invalid sourceRect")
                                          .arg(part.name);
                break;
            }
            part.sourceRect = QRect(int(sourceRect[0]), int(sourceRect[1]),
                                    int(sourceRect[2]), int(sourceRect[3]));

            QVector<qreal> rect;
            if (!numberList(map.value(QStringLiteral("rect")), 4, &rect)
                    || rect[2] <= 0.0 || rect[3] <= 0.0) {
                validationError = QStringLiteral("part '%1' has an invalid rect")
                                          .arg(part.name);
                break;
            }
            part.rect = QRectF(rect[0], rect[1], rect[2], rect[3]);

            QString detail;
            if (!optionalNumber(map, "z", 0.0, &part.z, &detail)
                    || !optionalNumber(map, "rotation", 0.0, &part.rotation, &detail)
                    || !optionalChannel(map, "opacityChannel", &part.opacityChannel,
                                        &detail)
                    || !optionalBoolean(map, "surfaceMotion", false,
                                        &part.surfaceMotion, &detail)) {
                validationError = QStringLiteral("part '%1': %2").arg(part.name, detail);
                break;
            }
            part.local = AvatarSkeleton::rotation(part.rotation);
            part.mirrorX = map.value(QStringLiteral("mirrorX"), false).toBool();

            const auto blinkValue = map.constFind(QStringLiteral("blinkSourceRect"));
            if (blinkValue != map.cend()) {
                QVector<qreal> blinkRect;
                if (!numberList(*blinkValue, 4, &blinkRect)
                        || blinkRect[0] < 0.0 || blinkRect[1] < 0.0
                        || blinkRect[2] <= 0.0 || blinkRect[3] <= 0.0
                        || blinkRect[0] != std::floor(blinkRect[0])
                        || blinkRect[1] != std::floor(blinkRect[1])
                        || blinkRect[2] != std::floor(blinkRect[2])
                        || blinkRect[3] != std::floor(blinkRect[3])) {
                    validationError = QStringLiteral("part '%1' has an invalid blinkSourceRect")
                                              .arg(part.name);
                    break;
                }
                part.blinkSourceRect = QRect(int(blinkRect[0]), int(blinkRect[1]),
                                             int(blinkRect[2]), int(blinkRect[3]));
                if (!part.surfaceMotion) {
                    validationError = QStringLiteral("part '%1': blinkSourceRect requires surfaceMotion")
                                              .arg(part.name);
                    break;
                }
                if (part.blinkSourceRect.size() != part.sourceRect.size()) {
                    validationError = QStringLiteral("part '%1': blinkSourceRect must match sourceRect size")
                                              .arg(part.name);
                    break;
                }
            }

            part.surfaceFrames.append(Part::SurfaceFrame{
                    part.sourceRect, part.blinkSourceRect, 1.0});
            const auto surfaceFramesValue = map.constFind(QStringLiteral("surfaceFrames"));
            if (surfaceFramesValue != map.cend()) {
                if (!part.surfaceMotion) {
                    validationError = QStringLiteral("part '%1': surfaceFrames requires surfaceMotion")
                                              .arg(part.name);
                    break;
                }
                if (surfaceFramesValue->metaType().id() != QMetaType::QVariantList) {
                    validationError = QStringLiteral("part '%1': surfaceFrames must be a list")
                                              .arg(part.name);
                    break;
                }
                const QVariantList frames = surfaceFramesValue->toList();
                if (frames.size() > maximumSurfaceFrames) {
                    validationError = QStringLiteral("part '%1': surfaceFrames exceeds %2 entries")
                                              .arg(part.name).arg(maximumSurfaceFrames);
                    break;
                }
                const qreal mainAspect = qreal(part.sourceRect.width())
                        / part.sourceRect.height();
                for (int frameIndex = 0; frameIndex < frames.size(); ++frameIndex) {
                    if (frames[frameIndex].metaType().id() != QMetaType::QVariantMap) {
                        validationError = QStringLiteral("part '%1': surface frame %2 must be an object")
                                                  .arg(part.name).arg(frameIndex + 1);
                        break;
                    }
                    const QVariantMap frameMap = frames[frameIndex].toMap();
                    Part::SurfaceFrame frame;
                    if (!pixelRect(frameMap.value(QStringLiteral("sourceRect")),
                                   &frame.sourceRect)) {
                        validationError = QStringLiteral("part '%1': surface frame %2 has an invalid sourceRect")
                                                  .arg(part.name).arg(frameIndex + 1);
                        break;
                    }
                    const qreal aspect = qreal(frame.sourceRect.width())
                            / frame.sourceRect.height();
                    if (std::abs(aspect / mainAspect - 1.0) > 0.01) {
                        validationError = QStringLiteral("part '%1': surface frame %2 aspect ratio differs from frame 0")
                                                  .arg(part.name).arg(frameIndex + 1);
                        break;
                    }
                    const auto frameBlink = frameMap.constFind(
                            QStringLiteral("blinkSourceRect"));
                    if (frameBlink != frameMap.cend()) {
                        if (!pixelRect(*frameBlink, &frame.blinkSourceRect)) {
                            validationError = QStringLiteral("part '%1': surface frame %2 has an invalid blinkSourceRect")
                                                      .arg(part.name).arg(frameIndex + 1);
                            break;
                        }
                        if (frame.blinkSourceRect.size() != frame.sourceRect.size()) {
                            validationError = QStringLiteral("part '%1': surface frame %2 blinkSourceRect must match sourceRect size")
                                                      .arg(part.name).arg(frameIndex + 1);
                            break;
                        }
                    }
                    part.surfaceFrames.append(frame);
                }
                if (!validationError.isEmpty())
                    break;
            }

            const auto visibilityValue = map.constFind(QStringLiteral("visibleWhen"));
            if (visibilityValue != map.cend()) {
                const QVariantMap visibility = visibilityValue->toMap();
                QString visibilityError;
                if (!optionalChannel(visibility, "channel", &part.visibilityChannel,
                                     &visibilityError)
                        || part.visibilityChannel.isEmpty()) {
                    validationError = QStringLiteral("part '%1': visibleWhen requires a channel")
                                              .arg(part.name);
                    break;
                }
                if (visibility.contains(QStringLiteral("min"))
                        && !boundedNumber(visibility.value(QStringLiteral("min")),
                                          &part.visibilityMin)) {
                    validationError = QStringLiteral("part '%1': visibleWhen min is invalid")
                                              .arg(part.name);
                    break;
                }
                if (visibility.contains(QStringLiteral("max"))
                        && !boundedNumber(visibility.value(QStringLiteral("max")),
                                          &part.visibilityMax)) {
                    validationError = QStringLiteral("part '%1': visibleWhen max is invalid")
                                              .arg(part.name);
                    break;
                }
                if (part.visibilityMin >= part.visibilityMax) {
                    validationError = QStringLiteral("part '%1': visibleWhen range is empty")
                                              .arg(part.name);
                    break;
                }
            }
            d->parts.append(part);
        }
    }

    if (validationError.isEmpty()) {
        // Authored routes start at connected neutral and retrace the same
        // frames on return. Ease secondary deformation down over the opening
        // frames instead of applying the full neutral warp to a drawing that
        // already contains its own body, hair, light and shade.
        const QVariantMap routes = d->definition.value(QStringLiteral("surfaceSequences"))
                                           .toMap().value(QStringLiteral("routes"))
                                           .toMap();
        for (auto route = routes.cbegin(); route != routes.cend(); ++route) {
            const QVariantList frames = route.value().toMap()
                                                .value(QStringLiteral("frames"))
                                                .toList();
            const int transition = std::min(surfaceDeformationTransitionFrames,
                                            int(frames.size()) - 1);
            if (transition <= 0)
                continue;
            for (int index = 1; index < frames.size(); ++index) {
                bool frameOk = false;
                const int frame = frames[index].toInt(&frameOk);
                if (!frameOk)
                    continue;
                const qreal progress = ReferenceArt::smoothStep(
                        0.0, 1.0, qreal(std::min(index, transition)) / transition);
                const qreal scale = 1.0
                        - (1.0 - heldSurfaceDeformationScale) * progress;
                for (Part &part : d->parts) {
                    if (part.surfaceMotion && frame > 0
                            && frame < part.surfaceFrames.size()) {
                        part.surfaceFrames[frame].deformationScale = std::min(
                                part.surfaceFrames[frame].deformationScale, scale);
                    }
                }
            }
        }
    }

    if (validationError.isEmpty()) {
        std::stable_sort(d->parts.begin(), d->parts.end(), [](const Part &left,
                                                              const Part &right) {
            return left.z < right.z;
        });
    }

    // Validation only: the atlas's stored size is enough to check every rectangle against it.
    QImage atlas;
    QRect atlasRect;
    if (validationError.isEmpty() && (d->validationOnly || d->asynchronous)) {
        QImageReader reader(imagePath(d->source));
        reader.setAutoTransform(true);
        const QSize size = reader.canRead() ? reader.size() : QSize();
        if (!size.isValid() || size.isEmpty())
            validationError = QStringLiteral("source atlas could not be read");
        atlasRect = QRect(QPoint(), size);
    } else if (validationError.isEmpty()) {
        atlas = cachedAtlas(imagePath(d->source), d->sourceKey);
        if (atlas.isNull())
            validationError = QStringLiteral("source atlas could not be loaded");
        atlasRect = atlas.rect();
    }

    if (validationError.isEmpty()) {
        for (const Part &part : std::as_const(d->parts)) {
            PartImages images;
            images.frames.resize(part.surfaceFrames.size());
            images.blinks.resize(part.surfaceFrames.size());
            images.uses.resize(part.surfaceFrames.size());
            for (int frameIndex = 0; frameIndex < part.surfaceFrames.size(); ++frameIndex) {
                const Part::SurfaceFrame &frame = part.surfaceFrames[frameIndex];
                if (!atlasRect.contains(frame.sourceRect)) {
                    validationError = QStringLiteral("part '%1' surface frame %2 sourceRect is outside the atlas")
                                              .arg(part.name).arg(frameIndex);
                    break;
                }
                if (!frame.blinkSourceRect.isNull()
                        && !atlasRect.contains(frame.blinkSourceRect)) {
                    validationError = QStringLiteral("part '%1' surface frame %2 blinkSourceRect is outside the atlas")
                                              .arg(part.name).arg(frameIndex);
                    break;
                }
            }
            if (!validationError.isEmpty())
                break;
            d->partImages.append(images);
        }
        if (validationError.isEmpty() && !d->validationOnly && !d->asynchronous
                && !prepareFrameImages(d->surfaceFrame, &validationError)) {
            // prepareFrameImages supplies the diagnostic.
        }
    }

    if (!validationError.isEmpty()) {
        d->bones.clear();
        d->parts.clear();
        d->partImages.clear();
        setStatus(false, validationError);
    } else if (d->asynchronous && !d->validationOnly) {
        d->referenceSize = QSizeF(reference[0], reference[1]);
        setImplicitSize(d->referenceSize.width(), d->referenceSize.height());
        setStatus(false, {});
        const quint64 revision = d->revision;
        const QString path = imagePath(d->source);
        const QString key = d->sourceKey.isEmpty() ? path : d->sourceKey;
        QPointer<AvatarPuppet> guard(this);
        // Source and definition bindings change in one QML turn. Defer starting
        // the worker so only the final consistent pair pays for a decode.
        QMetaObject::invokeMethod(this, [guard, revision, path, key] {
            if (!guard || guard->d->revision != revision)
                return;
            if (!guard->d->retainedAtlas.isNull()) {
                guard->finishSourceLoad(revision, guard->d->retainedAtlas);
                return;
            }
            requestAsyncAtlas(key, path, AsyncAtlasRecipient{
                [guard, revision] {
                    return guard && guard->d->revision == revision
                            && guard->d->asynchronous && !guard->d->validationOnly;
                },
                [guard, revision](const QImage &image) {
                    if (guard)
                        guard->finishSourceLoad(revision, image);
                }});
        }, Qt::QueuedConnection);
    } else {
        d->referenceSize = QSizeF(reference[0], reference[1]);
        setImplicitSize(d->referenceSize.width(), d->referenceSize.height());
        setStatus(true, {});
    }
    update();
}

void AvatarPuppet::finishSourceLoad(quint64 revision, QImage image)
{
    if (revision != d->revision || !d->asynchronous || d->validationOnly)
        return;
    if (image.isNull()) {
        setStatus(false, QStringLiteral("source atlas could not be loaded"));
        update();
        return;
    }
    d->retainedAtlas = std::move(image);
    QString preparationError;
    if (!prepareFrameImages(d->surfaceFrame, &preparationError)) {
        d->retainedAtlas = {};
        setStatus(false, preparationError);
        update();
        return;
    }
    // All connected routes leave neutral through authored frame one. Preparing
    // it after the worker decode removes the remaining first-click crop cost.
    if (d->surfaceFrame == 0) {
        bool hasFirstAuthoredFrame = false;
        for (const Part &part : std::as_const(d->parts))
            hasFirstAuthoredFrame |= part.surfaceMotion && part.surfaceFrames.size() > 1;
        if (hasFirstAuthoredFrame && !prepareFrameImages(1, &preparationError)) {
            d->retainedAtlas = {};
            setStatus(false, preparationError);
            update();
            return;
        }
    }
    setStatus(true, {});
    update();
}

bool AvatarPuppet::prepareFrameImages(int requestedFrame, QString *error)
{
    QVector<int> selectedFrames(d->parts.size(), 0);
    bool preparationNeeded = false;
    for (int index = 0; index < d->parts.size(); ++index) {
        const Part &part = d->parts[index];
        if (part.surfaceMotion && requestedFrame >= 0
                && requestedFrame < part.surfaceFrames.size()) {
            selectedFrames[index] = requestedFrame;
        }
        PartImages &images = d->partImages[index];
        const int selected = selectedFrames[index];
        preparationNeeded |= images.frames[selected].isEmpty();
        if (!images.frames[selected].isEmpty())
            images.uses[selected] = ++d->imageUse;
    }
    if (!preparationNeeded)
        return true;

    const QImage atlas = d->retainedAtlas.isNull()
            ? cachedAtlas(imagePath(d->source), d->sourceKey) : d->retainedAtlas;
    if (atlas.isNull()) {
        *error = QStringLiteral("source atlas could not be loaded while preparing surface frame");
        return false;
    }
    for (int index = 0; index < d->parts.size(); ++index) {
        const Part &part = d->parts[index];
        const int frameIndex = selectedFrames[index];
        PartImages &images = d->partImages[index];
        if (!images.frames[frameIndex].isEmpty())
            continue;
        if (part.surfaceMotion) {
            int prepared = 0;
            int oldest = -1;
            quint64 oldestUse = std::numeric_limits<quint64>::max();
            for (int candidate = 0; candidate < images.frames.size(); ++candidate) {
                if (images.frames[candidate].isEmpty())
                    continue;
                ++prepared;
                if (candidate != frameIndex && images.uses[candidate] < oldestUse) {
                    oldest = candidate;
                    oldestUse = images.uses[candidate];
                }
            }
            if (prepared >= maximumPreparedSurfaceFrames && oldest >= 0) {
                images.frames[oldest].clear();
                images.blinks[oldest].clear();
                images.uses[oldest] = 0;
            }
        }
        const Part::SurfaceFrame &frame = part.surfaceFrames[frameIndex];
        images.frames[frameIndex] = textureLevels(atlas.copy(frame.sourceRect));
        if (!frame.blinkSourceRect.isNull())
            images.blinks[frameIndex] = textureLevels(atlas.copy(frame.blinkSourceRect));
        images.uses[frameIndex] = ++d->imageUse;
    }
    return true;
}

void AvatarPuppet::itemChange(ItemChange change, const ItemChangeData &value)
{
    // A new pixel ratio can need a different texture level even when the
    // pose is static (reduced motion, previews).
    if (change == ItemDevicePixelRatioHasChanged)
        update();
    QQuickItem::itemChange(change, value);
}

QVariantMap AvatarPuppet::boneTransforms() const
{
    QVariantMap output;
    const QVector<AvatarSkeleton::Transform> transforms =
            AvatarSkeleton::worldTransforms(d->bones, d->pose);
    for (int index = 0; index < d->bones.size(); ++index) {
        const auto &transform = transforms[index];
        output.insert(d->bones[index].name,
                      QVariantList{transform.m11, transform.m12,
                                   transform.m21, transform.m22,
                                   transform.dx, transform.dy});
    }
    return output;
}

QSGNode *AvatarPuppet::updatePaintNode(QSGNode *oldNode, UpdatePaintNodeData *)
{
    if (!d->ready || !window() || width() <= 0.0 || height() <= 0.0) {
        delete oldNode;
        return nullptr;
    }

    const qreal scale = std::min(width() / d->referenceSize.width(),
                                 height() / d->referenceSize.height());
    // Sample each cutout from the smallest level that still has at least one
    // texel per device pixel, including any scaling applied by ancestors.
    bool mapped = false;
    const QTransform scene = itemTransform(nullptr, &mapped);
    const qreal sceneScale = mapped ? std::sqrt(std::abs(scene.determinant())) : 1.0;
    const qreal deviceScale = scale * window()->effectiveDevicePixelRatio()
            * (std::isfinite(sceneScale) && sceneScale > 0.0 ? sceneScale : 1.0);
    QVector<int> levels(d->parts.size(), 0);
    QVector<int> selectedFrames(d->parts.size(), 0);
    QVector<int> nodeLevels(d->parts.size(), 0);
    for (int index = 0; index < d->parts.size(); ++index) {
        const Part &part = d->parts[index];
        if (part.surfaceMotion && d->surfaceFrame >= 0
                && d->surfaceFrame < part.surfaceFrames.size()) {
            selectedFrames[index] = d->surfaceFrame;
        }
        const int frame = selectedFrames[index];
        const QRect sourceRect = part.surfaceFrames[frame].sourceRect;
        const qreal density = deviceScale
                * std::max(part.rect.width() / sourceRect.width(),
                           part.rect.height() / sourceRect.height());
        if (density > 0.0 && density < 1.0)
            levels[index] = std::min(int(std::floor(std::log2(1.0 / density))),
                                     int(d->partImages[index].frames[frame].size()) - 1);
        // Surface nodes swap their own frame/level texture without rebuilding
        // the surrounding rigid scene graph.
        nodeLevels[index] = part.surfaceMotion ? -1 : levels[index];
    }

    auto *root = dynamic_cast<PuppetNode *>(oldNode);
    if (!root || root->revision != d->revision || root->levels != nodeLevels) {
        delete oldNode;
        root = new PuppetNode;
        root->revision = d->revision;
        root->levels = nodeLevels;
        root->parts.reserve(d->parts.size());
        for (int index = 0; index < d->parts.size(); ++index) {
            const Part &part = d->parts[index];
            const int frame = selectedFrames[index];
            const int level = levels[index];
            const QRect sourceRect = part.surfaceFrames[frame].sourceRect;
            QSGTexture *texture = window()->createTextureFromImage(
                    d->partImages[index].frames[frame][level]);
            if (!texture) {
                delete root;
                return nullptr;
            }
            texture->setFiltering(QSGTexture::Linear);

            auto *transformNode = new QSGTransformNode;
            auto *opacityNode = new QSGOpacityNode;
            QSGImageNode *imageNode = window()->createImageNode();
            imageNode->setTexture(texture);
            imageNode->setOwnsTexture(!part.surfaceMotion);
            imageNode->setFiltering(QSGTexture::Linear);
            // Level 0 is the crop itself; coarser levels hold it in their corner.
            const qreal divisor = qreal(1 << level);
            imageNode->setSourceRect(level == 0
                    ? QRectF(QPointF(), texture->textureSize())
                    : QRectF(0, 0, sourceRect.width() / divisor,
                             sourceRect.height() / divisor));
            imageNode->setRect(part.rect);
            imageNode->setTextureCoordinatesTransform(part.mirrorX
                    ? QSGImageNode::MirrorHorizontally : QSGImageNode::NoTransform);
            opacityNode->appendChildNode(imageNode);
            transformNode->appendChildNode(opacityNode);
            root->appendChildNode(transformNode);
            PuppetNode::RenderPart rendered;
            rendered.transform = transformNode;
            rendered.opacity = opacityNode;
            rendered.image = imageNode;
            rendered.part = index;
            if (part.surfaceMotion) {
                rendered.surfaceOriginal = texture;
                rendered.surfaceOriginalFrame = frame;
                rendered.surfaceOriginalLevel = level;
            }
            root->parts.append(rendered);
        }
    }

    const QVector<AvatarSkeleton::Transform> bones =
            AvatarSkeleton::worldTransforms(d->bones, d->pose);
    const qreal originX = (width() - d->referenceSize.width() * scale) * 0.5;
    const qreal originY = height() - d->referenceSize.height() * scale;
    const AvatarSkeleton::Transform fit{scale, 0.0, 0.0, scale, originX, originY};

    for (PuppetNode::RenderPart &renderPart : root->parts) {
        const Part &part = d->parts[renderPart.part];
        renderPart.transform->setMatrix(matrixFor(AvatarSkeleton::compose(
                fit, AvatarSkeleton::compose(bones[part.bone], part.local))));
        qreal opacity = part.opacityChannel.isEmpty()
                ? 1.0 : AvatarSkeleton::channelValue(d->pose, part.opacityChannel);
        opacity = std::clamp(opacity, 0.0, 1.0);
        if (!part.visibilityChannel.isEmpty()) {
            const qreal value = AvatarSkeleton::channelValue(d->pose,
                                                              part.visibilityChannel);
            if (value < part.visibilityMin || value >= part.visibilityMax)
                opacity = 0.0;
        }
        renderPart.opacity->setOpacity(opacity);

        if (part.surfaceMotion) {
            const int frame = selectedFrames[renderPart.part];
            const int level = levels[renderPart.part];
            const Part::SurfaceFrame &frameDefinition = part.surfaceFrames[frame];
            const PartImages &images = d->partImages[renderPart.part];
            ReferenceArt::Pose surfacePose;
            surfacePose.breathLift = ReferenceArt::finiteClamp(
                    AvatarSkeleton::channelValue(d->pose, QStringLiteral("breathLift")),
                    -2.0, 2.0);
            surfacePose.bodyTilt = ReferenceArt::finiteClamp(
                    AvatarSkeleton::channelValue(d->pose, QStringLiteral("bodyTilt")),
                    -4.0, 4.0);
            surfacePose.headTilt = ReferenceArt::finiteClamp(
                    AvatarSkeleton::channelValue(d->pose, QStringLiteral("headTilt")),
                    -9.0, 9.0);
            surfacePose.headX = ReferenceArt::finiteClamp(
                    AvatarSkeleton::channelValue(d->pose, QStringLiteral("headX")),
                    -3.0, 3.0);
            surfacePose.headY = ReferenceArt::finiteClamp(
                    AvatarSkeleton::channelValue(d->pose, QStringLiteral("headY")),
                    -3.0, 3.0);
            surfacePose.hipX = ReferenceArt::finiteClamp(
                    AvatarSkeleton::channelValue(d->pose, QStringLiteral("hipX")),
                    -2.5, 2.5);
            surfacePose.hipDrop = ReferenceArt::finiteClamp(
                    AvatarSkeleton::channelValue(d->pose, QStringLiteral("hipDrop")),
                    -3.0, 3.0);
            surfacePose.hairRotation = ReferenceArt::finiteClamp(
                    AvatarSkeleton::channelValue(d->pose, QStringLiteral("hairRotation")),
                    -2.0, 2.0);
            surfacePose.deformationScale = frameDefinition.deformationScale;
            surfacePose.blink = std::clamp(std::max(
                    AvatarSkeleton::channelValue(d->pose, QStringLiteral("blink")),
                    AvatarSkeleton::channelValue(d->pose, QStringLiteral("eyeClose"))),
                    0.0, 1.0);
            surfacePose.wink = std::clamp(
                    AvatarSkeleton::channelValue(d->pose, QStringLiteral("wink")),
                    0.0, 1.0);
            if (images.blinks[frame].isEmpty()) {
                surfacePose.blink = 0.0;
                surfacePose.wink = 0.0;
            }
            if (!renderPart.surfacePoseValid
                    || renderPart.surfacePose != surfacePose
                    || renderPart.surfaceFrame != frame
                    || renderPart.surfaceLevel != level) {
                const bool rest = !ReferenceArt::hasDeformation(surfacePose)
                        && surfacePose.blink <= 0.0 && surfacePose.wink <= 0.0;
                if (rest) {
                    if (!renderPart.surfaceOriginal
                            || renderPart.surfaceOriginalFrame != frame
                            || renderPart.surfaceOriginalLevel != level) {
                        QSGTexture *original = window()->createTextureFromImage(
                                images.frames[frame][level]);
                        if (!original)
                            continue;
                        original->setFiltering(QSGTexture::Linear);
                        renderPart.image->setTexture(original);
                        delete renderPart.surfaceDynamic;
                        renderPart.surfaceDynamic = nullptr;
                        delete renderPart.surfaceOriginal;
                        renderPart.surfaceOriginal = original;
                        renderPart.surfaceOriginalFrame = frame;
                        renderPart.surfaceOriginalLevel = level;
                    } else {
                        renderPart.image->setTexture(renderPart.surfaceOriginal);
                        delete renderPart.surfaceDynamic;
                        renderPart.surfaceDynamic = nullptr;
                    }
                } else {
                    const QImage closed = images.blinks[frame].isEmpty()
                            ? QImage() : images.blinks[frame][level];
                    if (surfacePose.wink > surfacePose.blink
                            && (renderPart.surfaceWinkFrame != frame
                                || renderPart.surfaceWinkLevel != level)) {
                        renderPart.surfaceWink = ReferenceArt::winkSelection(
                                images.frames[frame][level], closed);
                        renderPart.surfaceWinkFrame = frame;
                        renderPart.surfaceWinkLevel = level;
                    }
                    const QImage image = ReferenceArt::render(
                            images.frames[frame][level], closed,
                            part.rect, surfacePose,
                            QSizeF(frameDefinition.sourceRect.width()
                                           / qreal(1 << level),
                                   frameDefinition.sourceRect.height()
                                           / qreal(1 << level)),
                            surfacePose.wink > surfacePose.blink
                                    ? &renderPart.surfaceWink : nullptr);
                    QSGTexture *texture = window()->createTextureFromImage(image);
                    if (!texture)
                        continue;
                    texture->setFiltering(QSGTexture::Linear);
                    renderPart.image->setTexture(texture);
                    delete renderPart.surfaceDynamic;
                    renderPart.surfaceDynamic = texture;
                    if (renderPart.surfaceOriginal
                            && (renderPart.surfaceOriginalFrame != frame
                                || renderPart.surfaceOriginalLevel != level)) {
                        delete renderPart.surfaceOriginal;
                        renderPart.surfaceOriginal = nullptr;
                        renderPart.surfaceOriginalFrame = -1;
                        renderPart.surfaceOriginalLevel = -1;
                    }
                }
                const qreal divisor = qreal(1 << level);
                renderPart.image->setSourceRect(level == 0
                        ? QRectF(QPointF(), renderPart.image->texture()->textureSize())
                        : QRectF(0, 0,
                                 frameDefinition.sourceRect.width() / divisor,
                                 frameDefinition.sourceRect.height() / divisor));
                renderPart.image->setFiltering(QSGTexture::Linear);
                renderPart.surfacePose = surfacePose;
                renderPart.surfacePoseValid = true;
                renderPart.surfaceFrame = frame;
                renderPart.surfaceLevel = level;
            }
        }
    }
    // Joint-only updates must invalidate the software scene graph even after
    // the containing QQuickItem's entry translation has stopped changing.
    root->markDirty(QSGNode::DirtyForceUpdate);
    return root;
}
