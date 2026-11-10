// Retrieval over a vendor's contract clauses, history, receipts, and email notes.
// A real BM25 ranker (k1=1.2, b=0.75) with light stemming. In production this layer
// becomes a hybrid search (BM25 + embeddings) over every contract and vendor thread
// in the customer's Ramp account; the interface stays the same.

const STOP = new Set('a an and are as at be by for from has have in is it its of on or that the this to was were will with shall any all not no only per than upon each may must'.split(' '));

export function tokenize(text = '') {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9$.%\s-]/g, ' ')
    .split(/[\s-]+/)
    .map((t) => t.replace(/[.]+$/, ''))
    .filter((t) => t && !STOP.has(t))
    .map(stem);
}

function stem(t) {
  if (t.length <= 4) return t;
  return t.replace(/(ings|ing|ed|es|s)$/, '').replace(/(ment|ation)$/, '');
}

/** Build a searchable corpus for one exception's context. */
export function buildCorpus(ctx) {
  const docs = [];
  const contracts = ctx.contracts?.length ? ctx.contracts : ctx.contract ? [ctx.contract] : [];
  for (const k of contracts) {
    for (const c of k.clauses || []) {
      docs.push({ id: `${k.id}${c.id}`, source: 'contract', ref: c.id, contractId: k.id, title: `${c.id} ${c.title}`, text: c.text, origin: `${k.title} (${k.id})` });
    }
  }
  for (const h of ctx.history || []) {
    docs.push({ id: h.id, source: h.kind, ref: h.date, title: historyTitle(h), text: h.text, origin: 'Vendor history', date: h.date });
  }
  if (ctx.receipt?.notes) {
    docs.push({ id: ctx.receipt.id, source: 'receipt', ref: ctx.receipt.id, title: `${ctx.receipt.id} receiving note`, text: ctx.receipt.notes, origin: 'Item receipt' });
  }
  return docs;
}

function historyTitle(h) {
  const label = { credit: 'Vendor credit', note: 'Account note', email: 'Email', tracking: 'Carrier tracking', payment: 'Payment', notice: 'Written notice', portal: 'Vendor portal' }[h.kind] || 'Record';
  return `${label} · ${h.date}`;
}

export function bm25(docs, query, { k1 = 1.2, b = 0.75, k = 3 } = {}) {
  const tokenized = docs.map((d) => tokenize(`${d.title} ${d.text}`));
  const N = docs.length || 1;
  const avgdl = tokenized.reduce((s, t) => s + t.length, 0) / N;
  const df = new Map();
  tokenized.forEach((toks) => new Set(toks).forEach((t) => df.set(t, (df.get(t) || 0) + 1)));
  const q = [...new Set(tokenize(query))];

  const scored = docs.map((doc, i) => {
    const toks = tokenized[i];
    const tf = new Map();
    toks.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
    let score = 0;
    const hits = [];
    for (const term of q) {
      const f = tf.get(term);
      if (!f) continue;
      const idf = Math.log(1 + (N - df.get(term) + 0.5) / (df.get(term) + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * toks.length) / avgdl)));
      hits.push(term);
    }
    return { ...doc, score, hits };
  });

  const ranked = scored.filter((d) => d.score > 0).sort((a, b2) => b2.score - a.score);
  const top = ranked[0]?.score || 1;
  return ranked.slice(0, k).map((d) => ({ ...d, relevance: Math.round((d.score / top) * 100) / 100 }));
}

/** Query templates the agent issues per finding type. */
export const QUERIES = {
  PRICE_OVER_CONTRACT: 'fixed unit prices term increase price adjustment notice acceptance list price',
  PO_PRICE_STALE: 'annual price adjustment written notice effective adjusted prices purchase order date',
  UNPLANNED_CHARGE: 'freight delivery fuel surcharge included unit prices credit charge',
  QTY_OVER_RECEIPT: 'partial shipment backordered invoice quantities shipped corrected invoice packing slip',
  QTY_OVER_PO: 'invoice quantities shipped purchase order corrected invoice',
  MISSING_RECEIPT: 'delivery acceptance proof of delivery carrier signed receipt',
  DUPLICATE: 'invoiced once duplicate reissued replacement voided paid ACH',
  BANK_MISMATCH: 'bank remittance payment details change confirmed phone officer',
  MISSING_DOCS: 'completion report signed attach invoice portal signature',
  PO_REF_TYPO: 'invoice reference valid purchase order',
  CONTRACT_CONFLICT: 'pricing schedule conflict amendment supersedes order of precedence master agreement',
};
