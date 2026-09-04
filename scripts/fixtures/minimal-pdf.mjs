/**
 * A deterministic minimal 2-page PDF builder for adapter tests (G5.3). Hand-assembles a valid
 * PDF 1.4 with Helvetica text per page — no dependency, byte-deterministic (fixed offsets computed
 * from the same constant strings on every call), ASCII-only so no font-encoding surprises.
 *
 * Exported as .mjs (not .ts) so both the pipeline and the cli e2e test suites can import it without
 * a build step, mirroring synthetic-mule-project.mjs.
 */

/** Build a PDF whose pages each render the given text lines (top-down, 14pt leading). */
export function buildMinimalPdf(pages) {
  // object numbers: 1 catalog, 2 pages, then per page: content-stream obj + page obj, font last.
  const fontObjNum = 3 + pages.length * 2;
  const pageObjNums = [];
  for (let i = 0; i < pages.length; i++) pageObjNums.push(4 + i * 2);

  let content = '%PDF-1.4\n';
  const offsets = [];
  const push = (body) => {
    offsets.push(Buffer.byteLength(content, 'latin1'));
    content += `${body}\n`;
  };

  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj');
  const kids = pageObjNums.map((n) => `${n} 0 R`).join(' ');
  push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj`);
  for (let i = 0; i < pages.length; i++) {
    const contentObj = 3 + i * 2;
    const pageObj = 4 + i * 2;
    // one BT/ET per line — Td is relative, so independent text blocks keep absolute positions honest
    const stream = pages[i]
      .map((line, li) => `BT /F1 12 Tf 72 ${720 - li * 14} Td (${line}) Tj ET`)
      .join('\n');
    push(
      `${contentObj} 0 obj\n<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream\nendobj`,
    );
    push(
      `${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObj} 0 R /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> >>\nendobj`,
    );
  }
  push(`${fontObjNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj`);

  const size = fontObjNum + 1;
  const xrefStart = Buffer.byteLength(content, 'latin1');
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  content += `${xref}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(content, 'latin1');
}
