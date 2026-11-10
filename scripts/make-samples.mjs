// Generates the sample documents in /samples (real PDFs with text layers, a CSV bill export)
// and embeds them in src/data/sampleFiles.js so the hosted demo can run them too.
//   node scripts/make-samples.mjs

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = 'samples';
mkdirSync(OUT, { recursive: true });

const INK = rgb(0.08, 0.08, 0.07);
const GREY = rgb(0.42, 0.41, 0.39);
const LINE = rgb(0.82, 0.8, 0.77);
const fmtAmt = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtUnit = (n) => (Math.round(n * 100) === n * 100 ? fmtAmt(n) : String(n));
const fmtQty = (n) => n.toLocaleString('en-US');
const BILL_TO = ['Halcyon Robotics', 'Accounts Payable', '2200 Mission College Blvd', 'Santa Clara, CA 95054', 'ap@halcyonrobotics.com'];

async function doc() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const f = await pdf.embedFont(StandardFonts.Helvetica);
  const b = await pdf.embedFont(StandardFonts.HelveticaBold);
  const t = (s, x, y, o = {}) => page.drawText(String(s), { x, y, size: o.size || 9.5, font: o.bold ? b : f, color: o.color || INK });
  const r = (s, xr, y, o = {}) => { const font = o.bold ? b : f; const size = o.size || 9.5; t(s, xr - font.widthOfTextAtSize(String(s), size), y, o); };
  const hr = (y, x1 = 48, x2 = 564, th = 0.6, c = LINE) => page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: th, color: c });
  return { pdf, page, t, r, hr, f, b };
}

const lineTotal = (l) => Math.round(l.qty * l.unit * 100) / 100;
const sum = (ls) => Math.round(ls.reduce((s, l) => s + lineTotal(l), 0) * 100) / 100;

// Template A: classic. Item | Description | Qty | Unit price | Amount
async function classic(s) {
  const { pdf, t, r, hr } = await doc();
  t(s.vendor.name, 48, 740, { size: 16, bold: true });
  s.vendor.address.forEach((l, i) => t(l, 48, 722 - i * 12, { color: GREY }));
  t(`${s.vendor.email}  ·  ${s.vendor.phone}`, 48, 722 - s.vendor.address.length * 12, { color: GREY });
  r(s.title || 'INVOICE', 564, 738, { size: 22, bold: true });
  const kv = [['Invoice No.:', s.id], ['Invoice Date:', s.date], ['PO Number:', s.po], ['Terms:', s.terms], ...(s.servicePeriod ? [['Service Period:', s.servicePeriod]] : [])];
  kv.forEach(([k, v], i) => { t(k, 390, 712 - i * 13, { color: GREY }); r(v, 564, 712 - i * 13, { bold: true }); });
  t('Bill To', 48, 640, { bold: true });
  BILL_TO.forEach((l, i) => t(l, 48, 626 - i * 12));
  if (s.subtitle) t(s.subtitle, 330, 640, { bold: true, color: GREY });
  let y = 548;
  hr(y + 14, 48, 564, 1.2, INK);
  t('Item', 48, y, { bold: true }); t('Description', 132, y, { bold: true }); r('Qty', 400, y, { bold: true }); r('Unit Price', 482, y, { bold: true }); r('Amount', 564, y, { bold: true });
  hr(y - 6);
  y -= 22;
  for (const l of s.lines) {
    t(l.sku || '', 48, y); t(l.desc, 132, y); r(fmtQty(l.qty), 400, y); r(fmtUnit(l.unit), 482, y); r(fmtAmt(lineTotal(l)), 564, y);
    y -= 18;
  }
  hr(y + 8);
  const total = sum(s.lines);
  r('Subtotal', 482, y - 8, { color: GREY }); r(fmtAmt(total), 564, y - 8);
  r('Tax', 482, y - 22, { color: GREY }); r('0.00', 564, y - 22);
  r('Total Due', 482, y - 40, { bold: true, size: 11 }); r(`$${fmtAmt(total)}`, 564, y - 40, { bold: true, size: 11 });
  t('Remit to', 48, 170, { bold: true });
  t(`Bank: ${s.remit.bank}   Account ending ${s.remit.last4}`, 48, 156);
  if (s.notes) { t('Notes:', 48, 130, { bold: true }); t(s.notes, 48, 116, { size: 8.5 }); }
  t(s.footer || 'Thank you for your business.', 48, 60, { color: GREY, size: 8.5 });
  return pdf.save();
}

// Template B: modern. Description | SKU | Rate | Qty | Total (rate before quantity)
async function modern(s) {
  const { pdf, page, t, r, hr } = await doc();
  page.drawRectangle({ x: 0, y: 700, width: 612, height: 92, color: rgb(0.11, 0.12, 0.13) });
  t(s.vendor.name, 48, 752, { size: 17, bold: true, color: rgb(1, 1, 1) });
  t(`${s.vendor.address.join(', ')}`, 48, 734, { color: rgb(0.8, 0.8, 0.8), size: 8.5 });
  t(`${s.vendor.email}  |  ${s.vendor.phone}`, 48, 720, { color: rgb(0.8, 0.8, 0.8), size: 8.5 });
  r(`Invoice #${s.id}`, 564, 752, { size: 13, bold: true, color: rgb(1, 1, 1) });
  t('Date issued', 48, 670, { color: GREY }); t(s.date, 140, 670, { bold: true });
  t('Purchase order', 48, 656, { color: GREY }); t(s.po, 140, 656, { bold: true });
  t('Payment terms', 48, 642, { color: GREY }); t(s.terms, 140, 642, { bold: true });
  t('Billed to', 360, 670, { color: GREY });
  BILL_TO.slice(0, 4).forEach((l, i) => t(l, 360, 656 - i * 12));
  let y = 570;
  t('Description', 48, y, { bold: true }); t('SKU', 290, y, { bold: true }); r('Rate', 420, y, { bold: true }); r('Qty', 480, y, { bold: true }); r('Total', 564, y, { bold: true });
  hr(y - 6, 48, 564, 1, INK);
  y -= 22;
  for (const l of s.lines) {
    t(l.desc, 48, y); t(l.sku || '', 290, y); r(fmtUnit(l.unit), 420, y); r(fmtQty(l.qty), 480, y); r(fmtAmt(lineTotal(l)), 564, y);
    hr(y - 7);
    y -= 20;
  }
  const total = sum(s.lines);
  r('Amount due', 480, y - 16, { bold: true, size: 12 }); r(`$${fmtAmt(total)}`, 564, y - 16, { bold: true, size: 12 });
  t('Payment details', 48, 190, { bold: true });
  t(`Bank: ${s.remit.bank}`, 48, 176); t(`Account ending ${s.remit.last4}`, 48, 163);
  if (s.notes) { t('Notes:', 48, 130, { bold: true }); wrap(s.notes, 92).forEach((l, i) => t(l, 48, 116 - i * 11, { size: 8.5 })); }
  return pdf.save();
}

// Template C: letterhead with a remittance box. Qty | Description | Unit price | Line total
async function letterhead(s) {
  const { pdf, page, t, r, hr } = await doc();
  t(s.vendor.name.toUpperCase(), 48, 744, { size: 14, bold: true });
  t(s.vendor.address.join('  ·  '), 48, 728, { size: 8.5, color: GREY });
  hr(718, 48, 564, 1.4, INK);
  t('INVOICE', 48, 690, { size: 20, bold: true });
  const kv = [['Invoice number:', s.id], ['Date:', s.date], ['PO #:', s.po], ['Terms:', s.terms], ...(s.servicePeriod ? [['Service period:', s.servicePeriod]] : [])];
  kv.forEach(([k, v], i) => { t(k, 330, 694 - i * 13, { color: GREY }); t(v, 430, 694 - i * 13, { bold: true }); });
  t('Customer', 48, 660, { color: GREY }); BILL_TO.slice(0, 2).forEach((l, i) => t(l, 48, 646 - i * 12));
  let y = 580;
  r('Qty', 80, y, { bold: true }); t('Description', 100, y, { bold: true }); r('Unit price', 470, y, { bold: true }); r('Line total', 564, y, { bold: true });
  hr(y - 6, 48, 564, 1, INK);
  y -= 22;
  for (const l of s.lines) {
    r(fmtQty(l.qty), 80, y); t(`${l.sku ? `${l.sku}  ` : ''}${l.desc}`, 100, y); r(fmtUnit(l.unit), 470, y); r(fmtAmt(lineTotal(l)), 564, y);
    y -= 18;
  }
  hr(y + 8);
  const total = sum(s.lines);
  r('Balance due', 470, y - 12, { bold: true, size: 11 }); r(`$${fmtAmt(total)}`, 564, y - 12, { bold: true, size: 11 });
  page.drawRectangle({ x: 48, y: 120, width: 300, height: 74, borderColor: INK, borderWidth: 1 });
  t('PLEASE REMIT TO', 60, 178, { bold: true, size: 8.5 });
  t(`Bank: ${s.remit.bank}`, 60, 162);
  t(`Account no. ****${s.remit.last4}`, 60, 148);
  t(`Questions: ${s.vendor.email}`, 60, 132, { size: 8.5 });
  if (s.notes) t(s.notes, 48, 96, { size: 8.5, bold: true });
  return pdf.save();
}

async function creditMemo(s) {
  const { pdf, t, r, hr } = await doc();
  t(s.vendor.name, 48, 740, { size: 16, bold: true });
  s.vendor.address.forEach((l, i) => t(l, 48, 722 - i * 12, { color: GREY }));
  t(`${s.vendor.email}  ·  ${s.vendor.phone}`, 48, 722 - s.vendor.address.length * 12, { color: GREY });
  r('CREDIT MEMO', 564, 738, { size: 20, bold: true });
  [['Credit Memo No.:', s.id], ['Date:', s.date], ['Applies to Invoice:', s.ref], ['PO Number:', s.po]].forEach(([k, v], i) => { t(k, 380, 712 - i * 13, { color: GREY }); r(v, 564, 712 - i * 13, { bold: true }); });
  t('Customer', 48, 640, { bold: true }); BILL_TO.slice(0, 2).forEach((l, i) => t(l, 48, 626 - i * 12));
  let y = 560;
  t('Description', 48, y, { bold: true }); r('Credit', 564, y, { bold: true });
  hr(y - 6, 48, 564, 1, INK);
  y -= 22;
  for (const l of s.lines) { t(l.desc, 48, y); r(fmtAmt(l.amount), 564, y); y -= 18; }
  const total = Math.round(s.lines.reduce((x, l) => x + l.amount, 0) * 100) / 100;
  r('Total Credit', 482, y - 14, { bold: true, size: 11 }); r(`$${fmtAmt(total)}`, 564, y - 14, { bold: true, size: 11 });
  t(s.message || 'This credit will be applied to your account.', 48, 160, { color: GREY });
  return pdf.save();
}

function wrap(text, n) {
  const out = []; let cur = '';
  for (const w of text.split(' ')) { if ((cur + ' ' + w).trim().length > n) { out.push(cur.trim()); cur = w; } else cur += ` ${w}`; }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const V = {
  NWP: { name: 'Northwind Packaging Co.', address: ['1840 Harbor Way', 'Oakland, CA 94607'], email: 'ar@northwindpack.com', phone: '(510) 555-0142' },
  SLS: { name: 'Summit Lab Supply', address: ['77 Innovation Dr', 'San Jose, CA 95134'], email: 'billing@summitlab.co', phone: '(408) 555-0117' },
  AFF: { name: 'Alder & Finch Office Furniture', address: ['950 Gilman St', 'Berkeley, CA 94710'], email: 'billing@alderfinch.com', phone: '(510) 555-0179' },
  MPC_FAKE: { name: 'Meridian Print Co.', address: ['410 Townsend St', 'San Francisco, CA 94107'], email: 'billing@meridianprint-co.com', phone: '(415) 555-0300' },
  RIT: { name: 'Redwood IT Services', address: ['500 Howard St', 'San Francisco, CA 94105'], email: 'ap@redwoodit.io', phone: '(415) 555-0124' },
  FIF: { name: 'Ferro Industrial Fasteners', address: ['2201 Industrial Pkwy', 'Stockton, CA 95206'], email: 'receivables@ferrofasteners.com', phone: '(209) 555-0181' },
  BAV: { name: 'Brightline AV', address: ['3300 El Camino Real', 'Palo Alto, CA 94306'], email: 'invoices@brightlineav.com', phone: '(650) 555-0163' },
};

const BOX = 'Corrugated mailer box 12×9×4';
const SAMPLES = [
  { file: 'northwind-NWP-31244.pdf', kind: 'invoice', title: 'Northwind invoice, list price again', expect: 'Price above contract → credit memo for $720.00', make: () => classic({ vendor: V.NWP, id: 'NWP-31244', date: 'Nov 6, 2026', po: 'PO-4502', terms: '2/10 Net 30', remit: { bank: 'Bank of the West', last4: '4471' }, lines: [{ sku: 'BOX-1294', desc: BOX, qty: 1800, unit: 4.6 }, { sku: 'TAPE-48', desc: 'Packing tape 48mm, clear', qty: 150, unit: 2.1 }] }) },
  { file: 'summit-lab-SLS-118391.pdf', kind: 'invoice', title: 'Summit Lab invoice, all correct', expect: 'Clean match → passes straight to approval', make: () => classic({ vendor: V.SLS, id: 'SLS-118391', date: 'Nov 6, 2026', po: 'PO-4507', terms: 'Net 30', remit: { bank: 'Chase', last4: '8820' }, lines: [{ sku: 'NIT-GLV-M', desc: 'Nitrile gloves, medium (case of 1,000)', qty: 200, unit: 18.5 }, { sku: 'IPA-70-4L', desc: 'Isopropyl alcohol 70%, 4L', qty: 40, unit: 22.4 }] }) },
  { file: 'alder-finch-AF-77402.pdf', kind: 'invoice', title: 'Alder & Finch invoice with add-on fees', expect: 'Charges not on PO → credit memo for $458.00', make: () => modern({ vendor: V.AFF, id: 'AF-77402', date: '2026-11-05', po: 'PO-4511', terms: 'Net 30', remit: { bank: 'Wells Fargo', last4: '7740' }, lines: [{ sku: 'ERG-CHR', desc: 'Ergonomic task chair', qty: 10, unit: 389 }, { sku: '', desc: 'Delivery & installation', qty: 1, unit: 420 }, { sku: '', desc: 'Fuel surcharge', qty: 1, unit: 38 }] }) },
  { file: 'meridian-print-MPC-2117.pdf', kind: 'invoice', title: 'Meridian invoice from a lookalike domain', expect: 'New bank account → payment hold and call-back', make: () => letterhead({ vendor: V.MPC_FAKE, id: 'MPC-2117', date: '11/07/2026', po: 'PO-4518', terms: 'Net 30', remit: { bank: 'First Horizon Bank', last4: '5508' }, notes: 'Please note our new banking details effective immediately.', lines: [{ sku: 'BNR-RETRACT', desc: 'Retractable event banner, printed', qty: 8, unit: 312 }] }) },
  { file: 'redwood-RW-10241-R.pdf', kind: 'invoice', title: 'Redwood re-issued September invoice', expect: 'Duplicate of a paid bill → reject', make: () => letterhead({ vendor: V.RIT, id: 'RW-10241-R', date: '11/04/2026', po: 'PO-4390', terms: 'Net 15', servicePeriod: 'September 2026', remit: { bank: 'First Republic', last4: '6612' }, lines: [{ sku: 'MS-MONTHLY', desc: 'Managed IT services, September 2026', qty: 1, unit: 12400 }] }) },
  { file: 'ferro-FIF-60318.pdf', kind: 'invoice', title: 'Ferro invoice at the new contract price', expect: 'PO typo + stale PO → change the PO, don’t dispute', make: () => classic({ vendor: V.FIF, id: 'FIF-60318', date: 'Nov 5, 2026', po: 'PO-4562', terms: '1/10 Net 45', remit: { bank: 'US Bank', last4: '3058' }, lines: [{ sku: 'HEX-M10', desc: 'Hex bolt M10×40, zinc', qty: 8000, unit: 0.884 }, { sku: 'WSH-M10', desc: 'Flat washer M10', qty: 8000, unit: 0.1248 }] }) },
  { file: 'brightline-BAV-5560.pdf', kind: 'invoice', title: 'Brightline invoice, nothing received yet', expect: 'No item receipt → ask the requester', make: () => modern({ vendor: V.BAV, id: 'BAV-5560', date: '2026-11-06', po: 'PO-4530', terms: 'Net 30', remit: { bank: 'SVB', last4: '1903' }, lines: [{ sku: 'DISP-75', desc: '75" 4K conference display', qty: 2, unit: 2180 }, { sku: 'MNT-WALL', desc: 'Tilting wall mount', qty: 6, unit: 165 }] }) },
  { file: 'northwind-credit-memo-CM-4917.pdf', kind: 'reply', title: 'Northwind credit memo, correct amount', expect: 'Approve NWP-30917 first → verifies $1,000.00 and releases payment', make: () => creditMemo({ vendor: V.NWP, id: 'CM-4917', date: 'Nov 9, 2026', ref: 'NWP-30917', po: 'PO-4417', lines: [{ desc: 'Price correction BOX-1294: 2,500 units at $0.40', amount: 1000 }] }) },
  { file: 'northwind-credit-memo-CM-4918-short.pdf', kind: 'reply', title: 'Northwind credit memo, $200 short', expect: 'Approve NWP-30917 first → caught as short, follow-up drafted', make: () => creditMemo({ vendor: V.NWP, id: 'CM-4918', date: 'Nov 9, 2026', ref: 'NWP-30917', po: 'PO-4417', lines: [{ desc: 'Price correction BOX-1294: 2,000 units at $0.40', amount: 800 }] }) },
  { file: 'summit-lab-corrected-SLS-118204-R.pdf', kind: 'reply', title: 'Summit Lab corrected invoice', expect: 'Approve SLS-118204 first → re-matched clean, payment released', make: () => classic({ vendor: V.SLS, id: 'SLS-118204-R', date: 'Nov 9, 2026', po: 'PO-4452', terms: 'Net 30', subtitle: 'CORRECTED INVOICE - replaces SLS-118204', remit: { bank: 'Chase', last4: '8820' }, lines: [{ sku: 'NIT-GLV-M', desc: 'Nitrile gloves, medium (case of 1,000)', qty: 360, unit: 18.5 }, { sku: 'IPA-70-4L', desc: 'Isopropyl alcohol 70%, 4L', qty: 60, unit: 22.4 }] }) },
];

const CSV = [
  'Vendor,Invoice number,Invoice date,PO number,Payment terms,Remit-to account last 4,Sender email,Line description,SKU,Quantity,Unit price,Attachments',
  'Coastline Facilities Services,CFS-4431,2026-11-05,PO-4540,Net 30,5127,billing@coastlinefs.com,"Post-construction deep clean, Building C",SVC-DEEPCLEAN,1,8750.00,Completion report',
  'Summit Lab Supply,SLS-118402,2026-11-07,PO-4544,Net 30,8820,billing@summitlab.co,"Nitrile gloves, medium (case of 1,000)",NIT-GLV-M,300,18.50,',
].join('\n') + '\n';

const embedded = [];
for (const s of SAMPLES) {
  const bytes = await s.make();
  writeFileSync(`${OUT}/${s.file}`, bytes);
  embedded.push({ name: s.file, kind: s.kind, title: s.title, expect: s.expect, mime: 'application/pdf', b64: Buffer.from(bytes).toString('base64') });
}
writeFileSync(`${OUT}/ramp-bill-export.csv`, CSV);
embedded.splice(7, 0, { name: 'ramp-bill-export.csv', kind: 'invoice', title: 'Bill export with two bills (CSV)', expect: 'One clean, one billed for backordered units', mime: 'text/csv', b64: Buffer.from(CSV).toString('base64') });

writeFileSync('src/data/sampleFiles.js', `// Generated by scripts/make-samples.mjs. Same bytes as the files in /samples.\nexport const SAMPLE_FILES = ${JSON.stringify(embedded, null, 1)};\n`);

const readme = `# Sample documents

Drop any of these into Matchbook (**Inbox → Add bills**), or use **Try a sample**. Every file is parsed for real: PDFs are read from their text layer, matched to the Ramp vendor record, the PO, item receipts, and vendor agreements, and then investigated.

| File | What it is | What Matchbook should do |
| --- | --- | --- |
${embedded.map((e) => `| \`${e.name}\` | ${e.title} | ${e.expect} |`).join('\n')}

The three vendor replies (credit memos and the corrected invoice) answer cases already in the queue. Approve the matching case first, then drop the reply in. Matchbook checks the amount and reference before it releases payment.

All companies, people, and figures are fictional. Regenerate with \`node scripts/make-samples.mjs\`.
`;
writeFileSync(`${OUT}/README.md`, readme);
console.log(`Wrote ${embedded.length} samples`);
