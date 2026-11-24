// pal-document: prints one HTML file PAL wrote as a PDF. It reads that file and writes the PDF; it opens nothing else,
// and only images the file itself carries are drawn. The broker runs it without network access.
//   pal-document INPUT.html OUTPUT.pdf A4|Letter TITLE
#include <QAbstractTextDocumentLayout>
#include <QFile>
#include <QFontDatabase>
#include <QGuiApplication>
#include <QPageLayout>
#include <QPageSize>
#include <QPainter>
#include <QPdfWriter>
#include <QTextDocument>
#include <QUrl>
#include <cstdio>

namespace {
constexpr qint64 inputLimit = 24 * 1024 * 1024;
constexpr int pageLimit = 2000;
class Document : public QTextDocument {
protected:
    QVariant loadResource(int type, const QUrl &name) override {
        return name.scheme() == QLatin1String("data") ? QTextDocument::loadResource(type, name) : QVariant();
    }
};
int fail(const char *message) { std::fprintf(stderr, "%s\n", message); return 1; }
}

int main(int argc, char **argv) {
    qputenv("QT_QPA_PLATFORM", "offscreen");
    QGuiApplication app(argc, argv);
    const auto arguments = app.arguments();
    if (arguments.size() != 5) return fail("usage: pal-document INPUT.html OUTPUT.pdf A4|Letter TITLE");
    QFile input(arguments[1]);
    if (!input.open(QIODevice::ReadOnly) || input.size() > inputLimit) return fail("The document could not be read");
    const QString html = QString::fromUtf8(input.readAll());
    QPdfWriter writer(arguments[2]);
    writer.setResolution(300);
    writer.setPageSize(QPageSize(arguments[3] == QLatin1String("Letter") ? QPageSize::Letter : QPageSize::A4));
    if (!writer.setPageMargins(QMarginsF(20, 18, 20, 16), QPageLayout::Millimeter)) return fail("The page size is not supported");
    writer.setTitle(arguments[4].left(300));
    writer.setCreator(QStringLiteral("PAL"));

    Document document;
    document.setDocumentMargin(0);
    document.setUndoRedoEnabled(false);
    QFont font = QGuiApplication::font();
    font.setPointSizeF(10.5);
    document.setDefaultFont(font);
    document.documentLayout()->setPaintDevice(&writer);
    document.setHtml(html);
    const qreal footer = writer.resolution() * 0.32;
    const QSizeF page(writer.width(), writer.height() - footer);
    document.setPageSize(page);
    const int count = document.pageCount();
    if (count > pageLimit) return fail("This document has more than 2,000 pages");
    QPainter painter;
    if (!painter.begin(&writer)) return fail("The PDF could not be written");
    QFont small = font;
    small.setPointSizeF(8.5);
    for (int index = 0; index < count; ++index) {
        if (index && !writer.newPage()) { painter.end(); return fail("The PDF could not be written"); }
        painter.save();
        painter.translate(0, -index * page.height());
        QAbstractTextDocumentLayout::PaintContext context;
        context.palette.setColor(QPalette::Text, QColor(0x1a, 0x22, 0x30));
        context.clip = QRectF(0, index * page.height(), page.width(), page.height());
        painter.setClipRect(context.clip);
        document.documentLayout()->draw(&painter, context);
        painter.restore();
        painter.setFont(small);
        painter.setPen(QColor(0x66, 0x70, 0x85));
        painter.drawText(QRectF(0, page.height(), page.width(), footer), Qt::AlignRight | Qt::AlignBottom, QStringLiteral("%1 / %2").arg(index + 1).arg(count));
    }
    if (!painter.end()) return fail("The PDF could not be written");
    std::printf("%d\n", count);
    return 0;
}
