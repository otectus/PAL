#include "avatarstartup.h"
#include "avatarpuppet.h"
#include <QPainter>
#include <algorithm>
#include <cmath>

namespace {
QRectF rectangle(const QVariant &value) {
    const auto fields = value.toList();
    return {fields.at(0).toDouble(), fields.at(1).toDouble(), fields.at(2).toDouble(), fields.at(3).toDouble()};
}

struct Cutout {
    QVariantMap part;
    QRect crop;
    QRectF target;
    QImage envelope;
};

void draw(QPainter &painter, const Cutout &cutout, const QVariantMap &bones, const QImage &atlas, bool mask) {
    const auto matrix = bones.value(cutout.part.value("bone").toString()).toList();
    painter.save();
    painter.setTransform(QTransform(matrix.at(0).toDouble(), matrix.at(2).toDouble(),
                                    matrix.at(1).toDouble(), matrix.at(3).toDouble(),
                                    matrix.at(4).toDouble(), matrix.at(5).toDouble()), true);
    painter.rotate(cutout.part.value("rotation").toDouble());
    if (cutout.part.value("mirrorX").toBool()) {
        painter.translate(cutout.target.center().x() * 2, 0);
        painter.scale(-1, 1);
    }
    if (mask && !cutout.envelope.isNull()) painter.drawImage(cutout.target, cutout.envelope);
    else painter.drawImage(cutout.target, atlas, cutout.crop);
    painter.restore();
}
}

AvatarStartup::Art AvatarStartup::render(const QVariantMap &definition, const QString &atlasPath) {
    AvatarPuppet rig;
    rig.setValidationOnly(true);
    rig.setDefinition(definition);
    rig.setSource(QUrl::fromLocalFile(atlasPath));
    if (!rig.ready()) return {};
    const QImage atlas(atlasPath);
    if (atlas.isNull()) return {};

    const QSize logical(192, 208);
    QVector<Cutout> cutouts;
    for (const auto &value : definition.value("parts").toList()) {
        const auto part = value.toMap();
        Cutout cutout{part, rectangle(part.value("sourceRect")).toRect(), rectangle(part.value("rect")), {}};
        if (part.value("surfaceMotion").toBool()) {
            const QSize size(std::clamp(int(std::ceil(cutout.target.width())), 1, logical.width()),
                             std::clamp(int(std::ceil(cutout.target.height())), 1, logical.height()));
            cutout.envelope = QImage(size, QImage::Format_ARGB32_Premultiplied);
            cutout.envelope.fill(Qt::transparent);
            QPainter envelope(&cutout.envelope);
            envelope.setRenderHint(QPainter::SmoothPixmapTransform);
            envelope.drawImage(cutout.envelope.rect(), atlas, cutout.crop);
            for (const auto &frame : part.value("surfaceFrames").toList())
                envelope.drawImage(cutout.envelope.rect(), atlas, rectangle(frame.toMap().value("sourceRect")));
        }
        cutouts.append(std::move(cutout));
    }
    std::stable_sort(cutouts.begin(), cutouts.end(), [](const Cutout &a, const Cutout &b) {
        return a.part.value("z").toDouble() < b.part.value("z").toDouble();
    });

    Art result{QImage(logical * 2, QImage::Format_ARGB32_Premultiplied), QImage(logical, QImage::Format_ARGB32_Premultiplied)};
    result.still.fill(Qt::transparent);
    result.mask.fill(Qt::transparent);
    const auto poses = definition.value("poses").toMap();
    const auto neutral = poses.value("0").toMap().value("joints").toMap();
    rig.setPose(neutral);
    const auto restingBones = rig.boneTransforms();
    QPainter still(&result.still);
    still.setRenderHint(QPainter::SmoothPixmapTransform);
    still.scale(2, 2);
    for (const auto &cutout : cutouts) {
        const QString opacity = cutout.part.value("opacityChannel").toString();
        still.setOpacity(opacity.isEmpty() ? 1 : std::clamp(neutral.value(opacity).toDouble(), 0., 1.));
        const auto visibility = cutout.part.value("visibleWhen").toMap();
        if (!visibility.isEmpty()) {
            const double channel = neutral.value(visibility.value("channel").toString()).toDouble();
            if (channel < visibility.value("min", -INFINITY).toDouble() || channel >= visibility.value("max", INFINITY).toDouble()) continue;
        }
        draw(still, cutout, restingBones, atlas, false);
    }
    still.end();

    // Cover every authored pose and carry pivot, including hands and hair at their furthest extent.
    QPainter mask(&result.mask);
    for (const auto &pose : poses) {
        rig.setPose(pose.toMap().value("joints").toMap());
        const auto bones = rig.boneTransforms();
        for (const QPointF pivot : {QPointF(0,0), QPointF(192,0), QPointF(0,208), QPointF(192,208), QPointF(96,208)}) {
            for (const int angle : {-7, 0, 7}) {
                mask.save();
                mask.translate(3.84 + pivot.x() * .96, 3.32 + pivot.y() * .96);
                mask.rotate(angle);
                mask.translate(-pivot.x() * .96, -pivot.y() * .96);
                mask.scale(.96, .96);
                for (const auto &cutout : cutouts) draw(mask, cutout, bones, atlas, true);
                mask.restore();
            }
        }
    }
    mask.end();
    return result;
}
