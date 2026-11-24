/** A document as one HTML page without scripts or fetched content; also the form pal-document prints as a PDF. */
import type { Align, Block, Document, Inline } from './markdown.ts';
import { embeddedImage } from './images.ts';

const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export type HtmlOptions = { title: string; printed?: boolean };

export function renderHtml(document: Document, options: HtmlOptions): string {
  const printed = !!options.printed;
  const inline = (children: Inline[]): string => children.map(child => {
    switch (child.type) {
      case 'text': return escape(child.text);
      case 'code': return `<code>${escape(child.text)}</code>`;
      case 'break': return '<br>';
      case 'strong': return `<b>${inline(child.children)}</b>`;
      case 'em': return `<i>${inline(child.children)}</i>`;
      case 'del': return `<s>${inline(child.children)}</s>`;
      case 'link': return `<a href="${escape(child.href)}">${inline(child.children)}</a>`;
      case 'note': return printed ? `<sup>${child.number}</sup>` : `<sup><a href="#note-${child.number}">${child.number}</a></sup>`;
      case 'image': { const image = embeddedImage(child.src); return image ? `<img src="data:${image.mime};base64,${image.data.toString('base64')}" alt="${escape(child.alt)}"${printed ? ` width="${Math.min(image.width, 640)}"` : ''}>` : `<i>[${escape(child.alt || 'image')}]</i>`; }
    }
  }).join('');
  // Alignment is named either way: a printed heading cell is centered unless it says otherwise.
  const cell = (tag: 'th' | 'td', children: Inline[], align: Align) => `<${tag}${align && align !== 'left' ? ` align="${align}"` : printed ? ' align="left"' : ''}${printed ? ' style="border-width:1px;border-style:solid;border-color:#c3ccd8"' : ''}>${inline(children)}</${tag}>`;
  const render = (blocks: Block[], tight = false): string => blocks.map((block, index) => {
    switch (block.type) {
      case 'heading': return `<h${block.level}>${inline(block.children)}</h${block.level}>`;
      // A list item's own line is not a paragraph of its own; only further ones are set apart.
      case 'paragraph': return tight && index === 0 && blocks[1]?.type !== 'paragraph' ? inline(block.children) : `<p>${inline(block.children)}</p>`;
      case 'code': return printed ? `<table width="100%" cellpadding="7" cellspacing="0" bgcolor="#f3f5f8"><tr><td><pre>${escape(block.text)}</pre></td></tr></table><p class="gap">&nbsp;</p>` : `<pre><code>${escape(block.text)}</code></pre>`;
      case 'quote': return printed ? `<table width="100%" cellpadding="0" cellspacing="0"><tr><td width="3" bgcolor="#c3ccd8"></td><td style="padding-left:9px;color:#4a5568">${render(block.blocks)}</td></tr></table><p class="gap">&nbsp;</p>` : `<blockquote>${render(block.blocks)}</blockquote>`;
      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul';
        const tasks = block.items.every(item => item.task !== undefined);
        return `<${tag}${block.ordered && block.start !== 1 ? ` start="${block.start}"` : ''}${tasks ? ' style="list-style-type:none"' : ''}>${block.items.map(item => `<li>${item.task === undefined ? '' : item.task ? '☑ ' : '☐ '}${render(item.blocks, true)}</li>`).join('')}</${tag}>${printed && !tight ? '<p class="gap">&nbsp;</p>' : ''}`;
      }
      case 'table': {
        const open = printed ? '<table width="100%" cellpadding="5" cellspacing="0" style="border-collapse:collapse">' : '<table>';
        return `${open}<thead><tr${printed ? ' bgcolor="#eaeef3"' : ''}>${block.head.map((children, column) => cell('th', children, block.align[column])).join('')}</tr></thead><tbody>${block.rows.map(row => `<tr>${row.map((children, column) => cell('td', children, block.align[column])).join('')}</tr>`).join('')}</tbody></table>${printed ? '<p class="gap">&nbsp;</p>' : ''}`;
      }
      case 'rule': return '<hr>';
    }
  }).join('\n');
  const notes = document.notes.length ? `<hr><ol>${document.notes.map(note => `<li id="note-${note.number}">${inline(note.children)}</li>`).join('')}</ol>` : '';
  const style = printed
    ? 'body{font-size:10.5pt;color:#1a2230}h1{font-size:20pt}h2{font-size:15pt}h3{font-size:12.5pt}h4,h5,h6{font-size:11pt}pre,code{font-family:monospace;font-size:9.5pt}a{color:#0b5394;text-decoration:none}p.gap{font-size:5pt;margin:0}th{font-weight:bold}'
    : 'body{font:16px/1.55 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1a2230}pre{background:#f3f5f8;padding:.75rem;overflow:auto;border-radius:6px}code{font-family:ui-monospace,monospace;font-size:.92em}blockquote{border-left:4px solid #c3ccd8;margin:0;padding-left:1rem}table{border-collapse:collapse}th,td{border:1px solid #c3ccd8;padding:.35rem .6rem}th{background:#eaeef3}img{max-width:100%}a{color:#0b5394}@media(prefers-color-scheme:dark){body{background:#10151d;color:#e4e9f0}pre,th{background:#1b2430}th,td{border-color:#3a4657}a{color:#8ab8ff}}';
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${escape(options.title)}</title>${printed ? '' : '<meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">'}<style>${style}</style></head>\n<body>\n${render(document.blocks)}\n${notes}\n</body></html>\n`;
}
