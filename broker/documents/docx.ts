/** A document as a Word file (Office Open XML), written without any other program. */
import { zipFilesAsync } from '../artifacts/zip.ts';
import type { Align, Block, Document, Inline } from './markdown.ts';
import { embeddedImage, type Embedded } from './images.ts';

export type Page = 'A4' | 'Letter';
/** Twentieths of a point. */
const pages: Record<Page, { width: number; height: number }> = { A4: { width: 11906, height: 16838 }, Letter: { width: 12240, height: 15840 } };
const margin = 1134;
const xml = (text: string) => text.replace(/[^\x09\x0a\x0d\x20-퟿-�\u{10000}-\u{10ffff}]/gu, '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
type Style = { bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean; link?: boolean };

class Writer {
  relations: { id: string; type: string; target: string; external?: boolean }[] = [];
  media: { name: string; data: Buffer }[] = [];
  lists: { ordered: boolean; start: number }[] = [];
  private nextImage = 1;
  private width: number;
  constructor(page: Page) { this.width = pages[page].width - 2 * margin; }
  private relation(type: string, target: string, external = false) {
    const known = this.relations.find(item => item.type === type && item.target === target);
    if (known) return known.id;
    const id = `rId${this.relations.length + 10}`;
    this.relations.push({ id, type, target, external }); return id;
  }
  private properties(style: Style) {
    const parts = [style.code ? '<w:rStyle w:val="InlineCode"/>' : style.link ? '<w:rStyle w:val="Hyperlink"/>' : '', style.bold ? '<w:b/>' : '', style.italic ? '<w:i/>' : '', style.strike ? '<w:strike/>' : ''].join('');
    return parts ? `<w:rPr>${parts}</w:rPr>` : '';
  }
  private run(text: string, style: Style) {
    return text.split('\n').map((line, index) => `<w:r>${this.properties(style)}${index ? '<w:br/>' : ''}<w:t xml:space="preserve">${xml(line)}</w:t></w:r>`).join('');
  }
  inline(children: Inline[], style: Style = {}): string {
    return children.map(child => {
      switch (child.type) {
        case 'text': return this.run(child.text, style);
        case 'code': return this.run(child.text, { ...style, code: true });
        case 'break': return '<w:r><w:br/></w:r>';
        case 'strong': return this.inline(child.children, { ...style, bold: true });
        case 'em': return this.inline(child.children, { ...style, italic: true });
        case 'del': return this.inline(child.children, { ...style, strike: true });
        case 'link': return `<w:hyperlink r:id="${this.relation('hyperlink', child.href, true)}" w:history="1">${this.inline(child.children, { ...style, link: true })}</w:hyperlink>`;
        case 'note': return `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>${child.number}</w:t></w:r>`;
        case 'image': { const image = embeddedImage(child.src); return image ? this.picture(image, child.alt) : this.run(`[${child.alt || 'image'}]`, { ...style, italic: true }); }
      }
    }).join('');
  }
  private picture(image: Embedded, alt: string) {
    const number = this.nextImage++, name = `image${number}.${image.mime === 'image/png' ? 'png' : 'jpeg'}`;
    this.media.push({ name, data: image.data });
    const id = this.relation('image', 'media/' + name), emu = 9525, widest = this.width * 635;
    const scale = Math.min(1, widest / (image.width * emu)), cx = Math.round(image.width * emu * scale), cy = Math.round(image.height * emu * scale);
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${number}" name="Image ${number}" descr="${xml(alt)}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${number}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  }
  paragraph(children: string, properties = '') { return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}${children}</w:p>`; }
  blocks(blocks: Block[], context: { quote?: number; list?: { id: number; level: number }; indent?: number } = {}): string {
    const place = context.quote ? '<w:pStyle w:val="Quote"/>' + (context.quote > 1 ? `<w:ind w:left="${360 * context.quote}"/>` : '') : context.indent !== undefined ? `<w:pStyle w:val="ListParagraph"/><w:ind w:left="${context.indent}"/>` : '';
    return blocks.map(block => {
      switch (block.type) {
        case 'heading': return this.paragraph(this.inline(block.children), `<w:pStyle w:val="Heading${block.level}"/>`);
        case 'paragraph': return this.paragraph(this.inline(block.children), place);
        case 'code': return this.paragraph(block.text.split('\n').map((line, index) => `<w:r>${index ? '<w:br/>' : ''}<w:t xml:space="preserve">${xml(line)}</w:t></w:r>`).join(''), '<w:pStyle w:val="CodeBlock"/>' + (context.indent ? `<w:ind w:left="${context.indent}"/>` : ''));
        case 'quote': return this.blocks(block.blocks, { ...context, quote: (context.quote || 0) + 1 });
        case 'list': return this.list(block, context);
        case 'table': return this.table(block);
        case 'rule': return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="C3CCD8"/></w:pBdr></w:pPr></w:p>';
      }
    }).join('');
  }
  private list(block: Extract<Block, { type: 'list' }>, context: { list?: { id: number; level: number }; quote?: number }) {
    const level = Math.min(8, context.list ? context.list.level + 1 : 0);
    // Each ordered list counts for itself, from its own first number.
    const id = this.lists.push({ ordered: block.ordered, start: block.start });
    const indent = 360 * (level + 1) + 360 * (context.quote || 0);
    return block.items.map(item => {
      const [first, ...rest] = item.blocks;
      const lead = item.task === undefined ? '' : this.run(item.task ? '☑ ' : '☐ ', {});
      const numbering = item.task !== undefined ? `<w:pStyle w:val="ListParagraph"/><w:ind w:left="${indent}" w:hanging="300"/>` : `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${id}"/></w:numPr>`;
      const body = first?.type === 'paragraph' ? this.paragraph(lead + this.inline(first.children), numbering) : this.paragraph(lead, numbering) + (first ? this.blocks([first], { list: { id, level }, indent, quote: undefined }) : '');
      return body + this.blocks(rest, { list: { id, level }, indent });
    }).join('');
  }
  private table(block: Extract<Block, { type: 'table' }>) {
    const columns = block.head.length, width = Math.floor(this.width / columns);
    const justify = (align: Align) => align === 'center' || align === 'right' ? `<w:jc w:val="${align}"/>` : '';
    const cell = (children: Inline[], align: Align, header: boolean) => `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="EAEEF3"/>' : ''}</w:tcPr>${this.paragraph(this.inline(children, header ? { bold: true } : {}), '<w:spacing w:before="40" w:after="40"/>' + justify(align))}</w:tc>`;
    const row = (cells: Inline[][], header = false) => `<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells.map((children, column) => cell(children, block.align[column], header)).join('')}</w:tr>`;
    return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/><w:tblLook w:val="0420" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${`<w:gridCol w:w="${width}"/>`.repeat(columns)}</w:tblGrid>${row(block.head, true)}${block.rows.map(cells => row(cells)).join('')}</w:tbl>${this.paragraph('', '<w:spacing w:before="0" w:after="60"/>')}`;
  }
}
const namespaces = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
function styles() {
  const paragraph = (id: string, name: string, ppr: string, rpr: string, based = 'Normal', next = 'Normal') => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${id === 'Normal' ? '' : `<w:basedOn w:val="${based}"/><w:next w:val="${next}"/>`}<w:qFormat/>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}</w:style>`;
  const sizes = [32, 26, 23, 22, 21, 21];
  return `${head}<w:styles ${namespaces}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>`
    + paragraph('Title', 'Title', '<w:spacing w:after="240"/>', '<w:b/><w:sz w:val="40"/>')
    + sizes.map((size, index) => paragraph(`Heading${index + 1}`, `heading ${index + 1}`, `<w:keepNext/><w:keepLines/><w:spacing w:before="${index < 2 ? 320 : 240}" w:after="100"/><w:outlineLvl w:val="${index}"/>`, `<w:b/><w:sz w:val="${size}"/>`)).join('')
    + paragraph('Quote', 'Quote', '<w:pBdr><w:left w:val="single" w:sz="24" w:space="10" w:color="C3CCD8"/></w:pBdr><w:ind w:left="360"/>', '<w:color w:val="4A5568"/>')
    + paragraph('CodeBlock', 'Code Block', '<w:shd w:val="clear" w:color="auto" w:fill="F3F5F8"/><w:spacing w:before="60" w:after="160" w:line="240" w:lineRule="auto"/>', '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="18"/>')
    + paragraph('ListParagraph', 'List Paragraph', '<w:spacing w:after="60"/><w:ind w:left="360"/><w:contextualSpacing/>', '')
    + paragraph('Footer', 'footer', '<w:jc w:val="right"/>', '<w:color w:val="667085"/><w:sz w:val="17"/>')
    + '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0B5394"/><w:u w:val="single"/></w:rPr></w:style><w:style w:type="character" w:styleId="InlineCode"><w:name w:val="Inline Code"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F3F5F8"/></w:rPr></w:style>'
    + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(side => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="C3CCD8"/>`).join('') + '</w:tblBorders></w:tblPr></w:style></w:styles>';
}
function numbering(lists: Writer['lists']) {
  const bullets = ['•', '◦', '▪'], formats = ['decimal', 'lowerLetter', 'lowerRoman'];
  const levels = (ordered: boolean) => Array.from({ length: 9 }, (_item, level) => `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${ordered ? formats[level % 3] : 'bullet'}"/><w:lvlText w:val="${ordered ? `%${level + 1}.` : bullets[level % 3]}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${360 * (level + 1)}" w:hanging="360"/></w:pPr></w:lvl>`).join('');
  return `${head}<w:numbering ${namespaces}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels(false)}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels(true)}</w:abstractNum>`
    + lists.map((list, index) => `<w:num w:numId="${index + 1}"><w:abstractNumId w:val="${list.ordered ? 1 : 0}"/>${list.ordered ? Array.from({ length: 9 }, (_item, level) => `<w:lvlOverride w:ilvl="${level}"><w:startOverride w:val="${list.start}"/></w:lvlOverride>`).join('') : ''}</w:num>`).join('') + '</w:numbering>';
}
export async function renderDocx(document: Document, options: { title: string; page: Page; created: number }): Promise<Buffer> {
  const writer = new Writer(options.page), page = pages[options.page];
  // A document that opens with its own heading keeps it as the title; nothing is said twice.
  const body = writer.blocks(document.blocks);
  const notes = document.notes.length ? '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="C3CCD8"/></w:pBdr></w:pPr></w:p>' + document.notes.map(note => writer.paragraph(`<w:r><w:t xml:space="preserve">${note.number}. </w:t></w:r>` + writer.inline(note.children))).join('') : '';
  const section = `<w:sectPr><w:footerReference w:type="default" r:id="rId3"/><w:pgSz w:w="${page.width}" w:h="${page.height}"/><w:pgMar w:top="${margin}" w:right="${margin}" w:bottom="${margin}" w:left="${margin}" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>`;
  const content = `${head}<w:document ${namespaces}><w:body>${body}${notes}${section}</w:body></w:document>`;
  const field = (name: string) => `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${name} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
  const footer = `${head}<w:ftr ${namespaces}><w:p><w:pPr><w:pStyle w:val="Footer"/></w:pPr>${field('PAGE')}<w:r><w:t xml:space="preserve"> / </w:t></w:r>${field('NUMPAGES')}</w:p></w:ftr>`;
  const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const when = new Date(options.created).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const files: [string, string | Buffer][] = [
    ['[Content_Types].xml', `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`],
    ['_rels/.rels', `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${office}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`],
    ['word/document.xml', content], ['word/styles.xml', styles()], ['word/numbering.xml', numbering(writer.lists)], ['word/footer1.xml', footer],
    ['word/_rels/document.xml.rels', `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${office}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${office}/numbering" Target="numbering.xml"/><Relationship Id="rId3" Type="${office}/footer" Target="footer1.xml"/>${writer.relations.map(item => `<Relationship Id="${item.id}" Type="${office}/${item.type}" Target="${xml(item.target)}"${item.external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`],
    // The title and time only: no account, computer or user name.
    ['docProps/core.xml', `${head}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(options.title)}</dc:title><dc:creator>PAL</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${when}</dcterms:created></cp:coreProperties>`],
    ...writer.media.map(item => ['word/media/' + item.name, item.data] as [string, Buffer]),
  ];
  return zipFilesAsync(files.map(([name, data]) => ({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(data) })));
}
