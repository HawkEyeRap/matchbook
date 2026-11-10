// Small, dependency-free helpers shared by the engine, the UI, and the MCP server.

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
export const round4 = (n) => Math.round((n + Number.EPSILON) * 10000) / 10000;

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usdPrecise = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });

/** $1,234.50 — unit prices keep up to 4 decimals ($0.884). */
export const money = (n, precise = false) => (precise ? usdPrecise : usd).format(n ?? 0);
export const num = (n) => new Intl.NumberFormat('en-US').format(n ?? 0);
export const pct = (n, digits = 1) => `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;

export const lineTotal = (l) => round2(l.qty * l.unitPrice);
export const sumLines = (lines) => round2(lines.reduce((s, l) => s + lineTotal(l), 0));

const DAY = 86400000;
const toDate = (s) => new Date(`${s}T12:00:00Z`);
export const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / DAY);
export const addDays = (s, d) => new Date(toDate(s).getTime() + d * DAY).toISOString().slice(0, 10);
export const fmtDate = (s, opts = { month: 'short', day: 'numeric' }) => (s ? toDate(s).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' }) : '—');

/** Parse "2/10 Net 30" → { discountPct: 2, discountDays: 10, netDays: 30 }. */
export function parseTerms(terms = '') {
  const m = terms.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+)\s*net\s*(\d+)/i);
  if (m) return { discountPct: +m[1], discountDays: +m[2], netDays: +m[3] };
  const n = terms.match(/net\s*(\d+)/i);
  return { discountPct: 0, discountDays: 0, netDays: n ? +n[1] : 30 };
}

/** Damerau-Levenshtein (optimal string alignment) distance. */
export function editDistance(a = '', b = '') {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** Normalize an invoice number so "RW10388-A", "rw-10388" and "RW 10388 REV" collide. */
export function normalizeInvoiceId(id = '') {
  return id.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(\d)(A|B|R|REV|DUP|CORR|COPY)$/, '$1');
}
