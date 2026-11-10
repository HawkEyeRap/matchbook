// Grounding guard for model-written text.
// The model may rephrase a draft, but it may not introduce a number, document ID,
// or bank detail that the deterministic engine did not produce. Anything new is
// flagged and the draft is blocked from approval until a human edits it.

const MONEY = /\$\s?\d[\d,]*(?:\.\d+)?/g;
const IDS = /\b(?:[A-Z]{2,4}-?\d{3,6}(?:-[A-Z0-9]+)?|PO-\d{4}|GRN-\d{4}|CM-\d{4})\b/g;
const PCT = /\b\d+(?:\.\d+)?\s?%/g;
const LAST4 = /••\s?\d{4}|ending (?:in )?\d{4}/gi;

const normMoney = (s) => Number(s.replace(/[$,\s]/g, '')).toFixed(2);

export function allowedTokens(...texts) {
  const joined = texts.join('\n');
  return {
    money: new Set((joined.match(MONEY) || []).map(normMoney)),
    ids: new Set(joined.match(IDS) || []),
    pct: new Set((joined.match(PCT) || []).map((p) => p.replace(/\s/g, ''))),
    last4: new Set((joined.match(LAST4) || []).map((s) => s.replace(/\D/g, ''))),
  };
}

/** Returns { ok, unknown: [{kind, value}] } for every figure in `text` not present in the facts. */
export function checkGrounding(text, allowed) {
  const unknown = [];
  for (const m of text.match(MONEY) || []) if (!allowed.money.has(normMoney(m))) unknown.push({ kind: 'amount', value: m });
  for (const m of text.match(IDS) || []) if (!allowed.ids.has(m)) unknown.push({ kind: 'document ID', value: m });
  for (const m of text.match(PCT) || []) if (!allowed.pct.has(m.replace(/\s/g, ''))) unknown.push({ kind: 'percentage', value: m });
  for (const m of text.match(LAST4) || []) if (!allowed.last4.has(m.replace(/\D/g, ''))) unknown.push({ kind: 'bank detail', value: m });
  return { ok: unknown.length === 0, unknown };
}

/**
 * Every figure the engine produced for one analysis. Drafts and human edits are checked
 * against this set, so a draft passes only if each amount, document ID, percentage and
 * bank digit traces back to a computed value or a record on file.
 */
export function factsText(a) {
  const { ctx, plan, match } = a;
  const money2 = (v) => `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} $${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const vals = [match.totals.invoice, match.totals.po, plan.disputed, plan.payable, plan.total, plan.amendDelta, plan.discount?.amount, ...plan.disputeLines.map((l) => l.amount)];
  for (const l of match.lines) vals.push(l.inv.unitPrice, l.inv.total, l.po?.unitPrice, l.po?.total, l.contract?.price, l.priceVar?.amount, ...(l.prices || []).map((p) => p.price));
  for (const f of match.findings) vals.push(f.amount);
  return [
    [plan.discount?.pct, ...match.findings.map((f) => f.detail?.escalation?.pct)].filter((p) => p != null).map((p) => `${p}% ${Number(p).toFixed(1)}%`).join(' '),
    (ctx.invoice.terms || '').replace(/(\d+)\//, '$1% '),
    vals.filter((v) => v != null && !Number.isNaN(v)).map(money2).join(' '),
    `${ctx.invoice.id} ${ctx.po?.id || ''} ${ctx.receipt?.id || ''} ${(ctx.contracts || []).map((c) => c.id).join(' ')}`,
    JSON.stringify((ctx.contracts || []).flatMap((c) => c.clauses)),
    (ctx.history || []).map((h) => h.text).join('\n'),
    `••${ctx.vendor.bank.last4} ending ${ctx.vendor.bank.last4} ••${ctx.invoice.remitTo?.last4} ending ${ctx.invoice.remitTo?.last4}`,
    match.findings.map((f) => [f.detail?.original, f.detail?.paymentRef, f.detail?.resolved, f.detail?.billed].filter((x) => typeof x === 'string').join(' ')).join(' '),
  ].join('\n');
}
