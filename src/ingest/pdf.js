// PDF → text lines, using pdf.js on the main thread (no worker file to host, works offline
// and inside a sandboxed page). Lines are rebuilt from text positions, top to bottom.

import * as pdfjsNs from 'pdfjs-dist/legacy/build/pdf.js';
import * as workerNs from 'pdfjs-dist/legacy/build/pdf.worker.js';

const pick = (ns, key) => (ns && ns[key] ? ns : ns?.default && ns.default[key] ? ns.default : ns);
const pdfjs = pick(pdfjsNs, 'getDocument');
const worker = pick(workerNs, 'WorkerMessageHandler');

function setup() {
  if (typeof globalThis !== 'undefined' && !globalThis.pdfjsWorker && worker?.WorkerMessageHandler) {
    globalThis.pdfjsWorker = worker; // pdf.js uses this as an in-process "fake worker"
  }
}

/** Returns [{ text, items: [{ str, x, w }] , y, page }] in reading order. */
export async function pdfToLines(bytes) {
  setup();
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const doc = await pdfjs.getDocument({ data: data.slice(), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const rows = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const x = it.transform[4];
      const y = it.transform[5];
      let row = rows.find((r) => Math.abs(r.y - y) <= 2.5);
      if (!row) { row = { y, items: [] }; rows.push(row); }
      row.items.push({ str: it.str, x, w: it.width || 0 });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) {
      r.items.sort((a, b) => a.x - b.x);
      let text = '';
      let end = null;
      for (const it of r.items) {
        if (end != null) text += it.x - end > 14 ? '   ' : it.x - end > 1.5 ? ' ' : '';
        text += it.str;
        end = it.x + it.w;
      }
      out.push({ text: text.replace(/\s+$/, ''), items: r.items, y: r.y, page: p });
    }
  }
  await doc.destroy();
  return out;
}
