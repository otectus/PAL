/** A two-page PDF: page 1 has text, page 2 only a drawn rectangle (what a scan looks like to a text extractor). */
export function pdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
    null, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 6 0 R /Resources << >> >>', null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = (body: string) => `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
  objects[3] = stream('BT /F1 18 Tf 20 120 Td (Quarterly revenue rose) Tj ET');
  objects[5] = stream('0 0 1 rg 20 20 200 100 re f');
  let out = '%PDF-1.4\n'; const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(out.length); out += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
