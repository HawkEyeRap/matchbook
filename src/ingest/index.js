// One entry point for every file someone drops in: invoices (PDF, CSV, JSON, TXT)
// and vendor replies (credit memo or corrected invoice PDFs).

import { pdfToLines } from './pdf.js';
import { parseDocumentLines, parseBillsCSV, parseBillsJSON } from './parse.js';

const ext = (name = '') => name.toLowerCase().split('.').pop();

/** file: a File/Blob with .name, or { name, bytes } */
export async function ingestFile(file) {
  const name = file.name || 'upload';
  const e = ext(name);
  try {
    // Note: modern browsers give Blob a bytes() *method*, so check for an actual byte array.
    const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(await file.arrayBuffer());
    if (e === 'pdf' || (bytes[0] === 0x25 && bytes[1] === 0x50)) {
      const lines = await pdfToLines(bytes);
      if (!lines.length) return [{ kind: 'error', fileName: name, error: 'This PDF has no text layer (it’s a scan). Scanned images go through OCR in production.' }];
      return [parseDocumentLines(lines, { fileName: name })];
    }
    const text = new TextDecoder().decode(bytes);
    if (e === 'csv') return parseBillsCSV(text, { fileName: name });
    if (e === 'json') return parseBillsJSON(text, { fileName: name });
    if (e === 'txt' || e === 'eml') return [parseDocumentLines(text.split(/\r?\n/), { fileName: name })];
    if (['png', 'jpg', 'jpeg', 'heic', 'webp', 'tif', 'tiff'].includes(e)) return [{ kind: 'error', fileName: name, error: 'Images need OCR, which this offline demo doesn’t include. Try a PDF, CSV, or JSON file.' }];
    return [{ kind: 'error', fileName: name, error: `.${e} files aren’t supported. Use PDF, CSV, JSON, or TXT.` }];
  } catch (err) {
    return [{ kind: 'error', fileName: name, error: `Couldn’t read this file (${err?.message || err}).` }];
  }
}

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
