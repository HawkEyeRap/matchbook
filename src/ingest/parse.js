// Turns document text into a bill (or a vendor reply) Matchbook can match.
// Deterministic extraction: labelled fields by pattern, line items by checking that
// quantity × unit price = amount on each row, vendor by the Ramp vendor record.
// In production this is the slot for a document-AI / OCR service on scanned images;
// the output shape stays the same.

import { VENDORS, POS, COMPANY, resolvePO } from '../data/scenarios.js';
import { editDistance, round2 } from '../engine/util.js';

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

export function toISODate(s) {
  if (!s) return null;
  const t = s.trim().replace(/\./g, '');
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
  m = t.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mo = monthOf(m[1]);
    if (mo) return `${m[3]}-${pad(mo)}-${pad(m[2])}`;
  }
  m = t.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  if (m && monthOf(m[2])) return `${m[3]}-${pad(monthOf(m[2]))}-${pad(m[1])}`;
  return null;
}

function monthOf(s) {
  const k = s.toLowerCase();
  return MONTHS[k.slice(0, 4)] ?? MONTHS[k.slice(0, 3)] ?? null;
}

export function normTerms(raw) {
  if (!raw) return null;
  const m = raw.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+)\s*,?\s*net\s*(\d+)/i);
  if (m) return `${m[1]}/${m[2]} Net ${m[3]}`;
  const n = raw.match(/net\s*(\d+)/i);
  if (n) return `Net ${n[1]}`;
  return /due on receipt/i.test(raw) ? 'Due on receipt' : raw;
}

const DATE_RE = '([A-Za-z]{3,9}\\.?\\s+\\d{1,2},?\\s+\\d{4}|\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}\\/\\d{1,2}\\/\\d{4}|\\d{1,2}\\s+[A-Za-z]{3,9}\\s+\\d{4})';
const DOC_ID = '([A-Z]{1,6}-?\\d[A-Z0-9-]*)';
const NUM = /^\(?-?\$?\d[\d,]*(\.\d+)?\)?$/;
const SKU = /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)+$/;
const toNum = (s) => Number(String(s).replace(/[$,()]/g, ''));

const norm = (s) => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function first(text, re) {
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

export function findVendor(text, emails) {
  const t = norm(text);
  for (const v of Object.values(VENDORS)) {
    const key = norm(v.name).split(' ').slice(0, 2).join(' ');
    if (t.includes(key)) return { vendor: v, by: 'name' };
  }
  for (const e of emails) {
    const dom = e.split('@')[1].toLowerCase();
    const v = Object.values(VENDORS).find((x) => x.domain === dom);
    if (v) return { vendor: v, by: 'domain' };
  }
  for (const e of emails) {
    const dom = e.split('@')[1].toLowerCase().replace(/\.\w+$/, '');
    const v = Object.values(VENDORS).find((x) => editDistance(x.domain.replace(/\.\w+$/, ''), dom) <= 3);
    if (v) return { vendor: v, by: 'lookalike domain' };
  }
  return null;
}

function headerOrder(line) {
  const l = line.toLowerCase();
  const qi = l.search(/\b(qty|quantity|units?)\b/);
  const pi = l.search(/\b(unit price|unit|rate|price)\b/);
  return qi >= 0 && pi >= 0 ? (qi < pi ? 'qty-first' : 'price-first') : 'qty-first';
}

function parseRow(text, order) {
  const tokens = text.trim().split(/\s+/);
  const nums = tokens.map((t, i) => ({ t, i })).filter((x) => NUM.test(x.t) && /\d/.test(x.t));
  const skuTok = tokens.find((t) => SKU.test(t) && !/^PO-/.test(t));
  let qty; let unit; let amount; let used = [];
  let conf = 0.97;
  if (nums.length >= 3) {
    // The amount is the last number; find the pair before it whose product equals it.
    const c = nums[nums.length - 1];
    const C = toNum(c.t);
    let pair = null;
    for (let j = nums.length - 2; j >= 1 && !pair; j--) {
      for (let i = j - 1; i >= 0; i--) {
        if (Math.abs(toNum(nums[i].t) * toNum(nums[j].t) - C) <= Math.max(0.011, C * 0.0005)) { pair = [nums[i], nums[j]]; break; }
      }
    }
    const [a, b] = pair || [];
    const A = a ? toNum(a.t) : NaN; const B = b ? toNum(b.t) : NaN;
    if (pair) {
      const aInt = Number.isInteger(A) && !/\./.test(a.t);
      const bInt = Number.isInteger(B) && !/\./.test(b.t);
      if (aInt && !bInt) { qty = A; unit = B; } else if (bInt && !aInt) { qty = B; unit = A; } else if (order === 'price-first') { unit = A; qty = B; } else { qty = A; unit = B; }
      amount = C; used = [a.i, b.i, c.i];
    }
  }
  if (amount == null && nums.length >= 1) {
    const c = nums[nums.length - 1];
    amount = toNum(c.t); qty = 1; unit = amount; used = [c.i]; conf = 0.9;
    if (nums.length >= 2 && Math.abs(toNum(nums[nums.length - 2].t) - amount) < 0.005) used.push(nums[nums.length - 2].i);
  }
  if (amount == null) return null;
  const desc = tokens.filter((t, i) => !used.includes(i) && t !== skuTok && !/^\$$/.test(t)).join(' ').replace(/\s+[|·]\s*$/, '').trim();
  return { sku: skuTok || null, desc, qty, unitPrice: unit, amount: round2(amount), conf };
}

function similarity(a, b) {
  const A = new Set(norm(a).split(' ').filter((w) => w.length > 2));
  const B = new Set(norm(b).split(' ').filter((w) => w.length > 2));
  if (!A.size || !B.size) return 0;
  let n = 0; A.forEach((w) => { if (B.has(w)) n++; });
  return n / Math.min(A.size, B.size);
}

/** Parse plain text lines (from a PDF or a text file). */
export function parseDocumentLines(lines, { fileName } = {}) {
  const textLines = lines.map((l) => (typeof l === 'string' ? l : l.text));
  const text = textLines.join('\n');
  const head = textLines.slice(0, 12).join(' ');
  const isCredit = /credit\s+memo/i.test(head);
  const warnings = [];

  const emails = [...new Set((text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map((e) => e.toLowerCase()))].filter((e) => !e.endsWith(`@${COMPANY.domain}`));
  const found = findVendor(text.replace(new RegExp(COMPANY.name, 'gi'), ''), emails);

  const total = (() => {
    const re = isCredit
      ? /(?:total\s+credit|credit\s+total|credit\s+amount|amount\s+credited|total)\s*:?\s*\$?\s*([\d,]+\.\d{2})/gi
      : /(?:total\s+due|amount\s+due|balance\s+due|invoice\s+total|total)\s*:?\s*\$?\s*([\d,]+\.\d{2})/gi;
    let m; let last = null;
    while ((m = re.exec(text))) last = toNum(m[1]);
    return last;
  })();

  if (isCredit) {
    const id = first(text, /credit\s*memo\s*(?:no\.?|number|#)?\s*:?\s*#?\s*(CM-?\d[\w-]*)/i) || first(text, /\b(CM-\d{3,})\b/);
    const ref = first(text, new RegExp(`(?:applies\\s+to|against|re:?|for)\\s+invoice\\s*(?:no\\.?|number|#)?\\s*:?\\s*#?\\s*${DOC_ID}`, 'i'));
    if (!found) return { kind: 'error', fileName, error: 'Couldn’t tell which vendor sent this credit memo.' };
    if (total == null) return { kind: 'error', fileName, error: 'Couldn’t find the credit amount.' };
    return { kind: 'credit_memo', fileName, vendorId: found.vendor.id, artifact: { type: 'Credit memo', id: id || 'CM-?', ref, amount: total, source: fileName }, fields: { id, ref, amount: total, vendor: found.vendor.name } };
  }

  const id = first(text, new RegExp(`invoice\\s*(?:no\\.?|number|#)\\s*:?\\s*#?\\s*${DOC_ID}`, 'i')) || first(text, new RegExp(`invoice\\s+#?${DOC_ID}`, 'i'));
  const poRaw = first(text, /(?:p\.?\s?o\.?|purchase\s+order)\s*(?:no\.?|number|#)?\s*:?\s*#?\s*(PO[-\s]?\d{3,6})/i) || first(text, /\b(PO-\d{3,6})\b/i);
  const poRef = poRaw ? poRaw.toUpperCase().replace(/\s/g, '-').replace(/^PO(\d)/, 'PO-$1') : null;
  const dateLine = textLines.find((l) => /(invoice\s+date|date\s+issued|issue\s+date|^\s*date\b|\bdate\s*:)/i.test(l) && !/\bdue\b/i.test(l)) || '';
  const date = toISODate(first(dateLine, new RegExp(`(?:invoice\\s+date|date\\s+issued|issue\\s+date|date)\\s*:?\\s*${DATE_RE}`, 'i')));
  const termsRaw = first(text, /(\d+(?:\.\d+)?\s*\/\s*\d+\s*,?\s*net\s*\d+|net\s*\d+|due\s+on\s+receipt)/i);
  const terms = normTerms(termsRaw);
  const sp = text.match(/service\s+period\s*:?\s*([A-Za-z]{3,9})\s+(\d{4})/i);
  const servicePeriod = sp && monthOf(sp[1]) ? `${MON3[monthOf(sp[1]) - 1]} ${sp[2]}` : null;
  const last4 = first(text, /(?:account|acct)\.?\s*(?:no\.?|number|#)?\s*:?\s*(?:ending\s+(?:in\s+)?|[*•xX]{2,}\s*)(\d{4})\b/i);
  const bankName = first(text, /(?:bank(?:\s+name)?|remit\s+to)\s*:\s*([A-Z][A-Za-z.&' ]+?(?:\s+Bank)?)(?=\s{2,}|\s*[·|,]|\s+account|\s+acct|$)/im);
  const notesIdx = textLines.findIndex((l) => /^\s*(notes?|remarks|message)\s*:/i.test(l) || /note to (automated|ap)|SYSTEM\s*:/i.test(l));
  const notes = notesIdx >= 0 ? textLines.slice(notesIdx, notesIdx + 3).filter((l, i) => i === 0 || !/total|remit|thank/i.test(l)).join(' ').replace(/^\s*(notes?|remarks|message)\s*:\s*/i, '').trim() : null;

  // Line items: rows between the column header and the totals.
  const h = textLines.findIndex((l) => /\b(description|item)\b/i.test(l) && /\b(qty|quantity|units?)\b/i.test(l));
  const items = [];
  if (h >= 0) {
    const order = headerOrder(textLines[h]);
    for (let i = h + 1; i < textLines.length; i++) {
      const l = textLines[i];
      if (/\b(subtotal|sub-total|total|amount due|balance due|tax)\b/i.test(l)) break;
      if (!l.trim()) continue;
      const row = parseRow(l, order);
      if (row) items.push(row);
      else if (items.length && !/\d/.test(l)) items[items.length - 1].desc += ` ${l.trim()}`;
    }
  }

  if (!found) return { kind: 'error', fileName, error: 'Couldn’t match the vendor to a Ramp vendor record. In production this routes to vendor onboarding.', fields: { id, poRef, total } };
  if (!items.length) return { kind: 'error', fileName, error: 'Couldn’t find any line items on this document.', fields: { id, vendor: found.vendor.name } };

  const vendor = found.vendor;
  const { po } = resolvePO(vendor.id, poRef);
  for (const it of items) {
    if (!it.sku && po) {
      const best = po.lines.map((pl) => ({ pl, s: similarity(it.desc, pl.desc) })).sort((a, b) => b.s - a.s)[0];
      if (best && best.s >= 0.6) { it.sku = best.pl.sku; it.conf = Math.min(it.conf, 0.93); }
    }
    if (it.sku && po && !po.lines.some((pl) => pl.sku === it.sku)) {
      // A SKU printed on the invoice that the PO doesn't have stays as-is; the match will flag it.
    }
  }
  const sum = round2(items.reduce((s, it) => s + it.amount, 0));
  if (total != null && Math.abs(sum - total) > 0.01) {
    warnings.push(`Line items add to ${sum.toFixed(2)} but the document total is ${total.toFixed(2)}.`);
    items.forEach((it) => { it.conf = Math.min(it.conf, 0.8); });
  }
  if (!id) warnings.push('No invoice number found.');
  if (!date) warnings.push('No invoice date found.');

  const senderEmail = emails.find((e) => !e.endsWith(`@${COMPANY.domain}`)) || null;
  const corrected = /corrected\s+invoice|replaces\s+invoice/i.test(head) || /-R$/i.test(id || '');
  const invoice = {
    id: id || `UPLOAD-${Date.now() % 100000}`,
    vendorId: vendor.id,
    poRef: poRef || '',
    date: date || null,
    terms: terms || vendor.terms,
    receivedVia: senderEmail || 'Upload',
    senderDomain: senderEmail ? senderEmail.split('@')[1] : vendor.domain,
    servicePeriod,
    remitTo: last4 ? { name: (bankName || '').replace(/\s+account.*$/i, '').trim() || 'Bank', last4 } : { ...vendor.bank },
    notes,
    lines: items.map(({ sku, desc, qty, unitPrice, conf }) => ({ sku, desc, qty, unitPrice, conf })),
    attachments: /completion\s+report/i.test(text) && /signed/i.test(text) ? ['completion_report'] : [],
    source: 'upload',
    fileName,
  };
  return { kind: 'invoice', fileName, corrected, invoice, vendorMatchedBy: found.by, total, warnings };
}

// ---------------------------------------------------------------- CSV / JSON

export function parseCSV(text) {
  const rows = [];
  let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const COLS = {
  vendor: /^vendor( name)?$/i, id: /^invoice (number|no\.?|#)$|^bill (number|id)$/i, date: /^invoice date$|^date$/i, po: /^po( number| #|)$|^purchase order$/i,
  terms: /^(payment )?terms$/i, last4: /remit.*(last ?4|account)/i, email: /^(sender )?email$/i, desc: /^(line )?description$/i, sku: /^sku$|^item$/i,
  qty: /^qty$|^quantity$/i, unit: /^unit price$|^rate$|^price$/i, attach: /^attachments?$/i, period: /^service period$/i, notes: /^notes?$/i,
};

export function parseBillsCSV(text, { fileName } = {}) {
  const rows = parseCSV(text);
  if (rows.length < 2) return [{ kind: 'error', fileName, error: 'The CSV has no rows.' }];
  const header = rows[0].map((h) => h.trim());
  const col = Object.fromEntries(Object.entries(COLS).map(([k, re]) => [k, header.findIndex((h) => re.test(h))]));
  if (col.id < 0 || col.qty < 0 || col.unit < 0) return [{ kind: 'error', fileName, error: 'The CSV needs at least Invoice number, Quantity, and Unit price columns.' }];
  const byId = new Map();
  for (const r of rows.slice(1)) {
    const get = (k) => (col[k] >= 0 ? (r[col[k]] || '').trim() : '');
    const id = get('id');
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, { id, vendor: get('vendor'), date: get('date'), po: get('po'), terms: get('terms'), last4: get('last4'), email: get('email'), attach: get('attach'), period: get('period'), notes: get('notes'), lines: [] });
    byId.get(id).lines.push({ desc: get('desc'), sku: get('sku') || null, qty: toNum(get('qty')), unitPrice: toNum(get('unit')), conf: 0.99 });
  }
  return [...byId.values()].map((b) => {
    const found = findVendor(b.vendor, b.email ? [b.email] : []);
    if (!found) return { kind: 'error', fileName, error: `${b.id}: vendor “${b.vendor}” isn’t a Ramp vendor.` };
    const v = found.vendor;
    const poRef = (b.po || '').toUpperCase();
    const { po } = resolvePO(v.id, poRef);
    for (const l of b.lines) {
      if (!l.sku && po) {
        const best = po.lines.map((pl) => ({ pl, s: similarity(l.desc, pl.desc) })).sort((x, y) => y.s - x.s)[0];
        if (best && best.s >= 0.6) l.sku = best.pl.sku;
      }
    }
    return {
      kind: 'invoice', fileName,
      invoice: {
        id: b.id, vendorId: v.id, poRef, date: toISODate(b.date), terms: normTerms(b.terms) || v.terms,
        receivedVia: b.email || 'CSV import', senderDomain: b.email ? b.email.split('@')[1] : v.domain,
        servicePeriod: b.period || null, remitTo: b.last4 ? { name: v.bank.name, last4: b.last4.slice(-4) } : { ...v.bank },
        notes: b.notes || null, lines: b.lines, attachments: b.attach ? b.attach.split(/[;|]/).map((s) => s.trim().toLowerCase().replace(/\s+/g, '_')) : [],
        source: 'upload', fileName,
      },
      vendorMatchedBy: found.by, warnings: [],
    };
  });
}

export function parseBillsJSON(text, { fileName } = {}) {
  let data;
  try { data = JSON.parse(text); } catch { return [{ kind: 'error', fileName, error: 'This JSON file couldn’t be read.' }]; }
  const list = Array.isArray(data) ? data : data.bills || [data];
  return list.map((b) => {
    const found = b.vendorId && VENDORS[b.vendorId] ? { vendor: VENDORS[b.vendorId], by: 'id' } : findVendor(b.vendor || b.vendorName || '', b.email ? [b.email] : []);
    if (!found) return { kind: 'error', fileName, error: `${b.id || 'A bill'}: vendor isn’t a Ramp vendor.` };
    const v = found.vendor;
    return { kind: 'invoice', fileName, vendorMatchedBy: found.by, warnings: [], invoice: {
      id: b.id || b.invoiceNumber, vendorId: v.id, poRef: (b.poRef || b.po || '').toUpperCase(), date: toISODate(b.date) || b.date, terms: b.terms || v.terms,
      receivedVia: b.email || 'JSON import', senderDomain: b.email ? b.email.split('@')[1] : v.domain, servicePeriod: b.servicePeriod || null,
      remitTo: b.remitTo || { ...v.bank }, notes: b.notes || null, attachments: b.attachments || [], source: 'upload', fileName,
      lines: (b.lines || []).map((l) => ({ sku: l.sku || null, desc: l.desc || l.description || '', qty: Number(l.qty ?? l.quantity), unitPrice: Number(l.unitPrice ?? l.unit_price), conf: 0.99 })),
    } };
  });
}

export { POS };
