import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractPdf } from './extract';
import { openPdf, PdfParseError } from './pdf';

/**
 * A one-page PDF built by hand rather than committed as a binary fixture, so the test has no
 * opaque blob: the object table and xref are visible in `minimalPdf` below.
 */
function minimalPdf(text = 'Waves and Optics'): Uint8Array {
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  bodies[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  bodies.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= bodies.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

test('a real PDF is read on-device and its text recovered', async () => {
  const bytes = minimalPdf('Waves and Optics');
  const reader = await openPdf(bytes);
  try {
    assert.equal(reader.pages, 1);
    const outcome = await extractPdf(bytes, reader);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.match(outcome.result.text, /Waves and Optics/);
    assert.equal(outcome.result.method, 'pdf');
    assert.equal(outcome.result.partial, false);
  } finally {
    await reader.close();
  }
});

test('a document over the page limit is refused before any page is rendered', async () => {
  const bytes = minimalPdf();
  await assert.rejects(() => openPdf(bytes, { maxPdfPages: 0 }), (error: unknown) => {
    assert.ok(error instanceof PdfParseError);
    assert.equal(error.code, 'unsupported');
    return true;
  });
});

test('a damaged or non-PDF file fails cleanly rather than wedging the job', async () => {
  const bytes = new TextEncoder().encode('this is definitely not a pdf');
  await assert.rejects(() => openPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof PdfParseError);
    assert.equal(error.code, 'malformed');
    assert.match(error.message, /could not be opened|damaged/);
    return true;
  });
});

test('closing a reader twice is safe, so cleanup paths cannot throw', async () => {
  const reader = await openPdf(minimalPdf());
  await reader.close();
  await assert.doesNotReject(() => reader.close());
});
