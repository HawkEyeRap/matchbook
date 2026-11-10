// The investigation loop. Each step mirrors a tool call the production agent makes through
// the Ramp Developer API / Ramp MCP (bills, purchase orders, item receipts, vendors, vendor
// agreements, payments), document extraction, browser automation, or retrieval.
// The trace is derived from the real computation, so changing the data changes the story.

import { threeWayMatch, DEFAULT_POLICY } from './match.js';
import { buildCorpus, bm25, QUERIES } from './retrieval.js';
import { primaryFinding, rootCause, planResolution, formulaFor, correctionFor, FINDING_META } from './resolve.js';
import { money, num, pct, fmtDate, sumLines, daysBetween } from './util.js';

export function investigate(rawCtx, policy = DEFAULT_POLICY, opts = {}) {
  const ctx = { ...rawCtx, now: rawCtx.now || opts.now || new Date().toISOString().slice(0, 10) };
  const { invoice, vendor, po, receipt } = ctx;
  const steps = [];
  const step = (tool, kind, glyph, label, value, detail, ms, extra = {}) => steps.push({ id: `${steps.length}`, tool, kind, glyph, label, value, detail, ms, ...extra });

  const total = sumLines(invoice.lines);
  step('ramp.bills.get', 'fetch', '▤', 'Read the bill', money(total), `${vendor.name} · ${invoice.id} · ${invoice.lines.length} line${invoice.lines.length > 1 ? 's' : ''} · terms ${invoice.terms}`, 180);

  const minConf = Math.min(...invoice.lines.map((l) => l.conf ?? 1));
  step('docai.extract', 'extract', '▤', 'Extracted the invoice fields', `${(minConf * 100).toFixed(0)}% min. confidence`, `Line items, PO reference, remit-to account, terms${invoice.fileName ? ` · from ${invoice.fileName}` : ''}`, 640);

  if (po) {
    step('ramp.purchase_orders.get', 'fetch', '▤', 'Read the purchase order', po.id, `${po.requester}, ${po.dept} · ${money(sumLines(po.lines))} · issued ${fmtDate(po.date)}${ctx.poResolvedFrom ? ` · bill said ${ctx.poResolvedFrom}` : ''}`, 150, { warn: !!ctx.poResolvedFrom });
  } else {
    step('ramp.purchase_orders.list', 'fetch', '▤', 'Looked for the purchase order', 'not found', `No PO ${invoice.poRef || ''} for ${vendor.name}`, 150, { warn: true });
  }

  if (po && !po.service) {
    step('ramp.item_receipts.list', 'fetch', '▤', 'Checked item receipts', receipt ? `${num(receipt.lines.reduce((s, l) => s + l.qty, 0))} received` : 'none', receipt ? `${receipt.id} · ${fmtDate(receipt.date)} by ${receipt.receivedBy}` : `${po.id} is “Not received”, ${Math.max(0, daysBetween(invoice.date, ctx.now))} days after the bill`, 140, { warn: !receipt });
  }

  if (ctx.contracts.length) {
    step('ramp.vendor_agreements.list', 'fetch', '§', 'Searched vendor agreements', `${ctx.contracts.length} in force`, ctx.contracts.map((c) => `${c.id} (${fmtDate(c.effective, { month: 'short', year: 'numeric' })}–${fmtDate(c.expires, { month: 'short', year: 'numeric' })})`).join(' · '), 210, { warn: ctx.contracts.length > 1 });
  }

  const t = ctx.history.find((h) => h.kind === 'tracking' && h.poId === po?.id);
  if (po && !po.service && !receipt && t) step('browser.carrier_tracking', 'browser', '↗', 'Checked carrier proof of delivery', 'delivered', t.text, 2100);
  const portal = ctx.history.find((h) => h.kind === 'portal' && h.poId === po?.id);
  if (portal && (ctx.contract?.requiredAttachments || []).length && !(invoice.attachments || []).length) step('browser.vendor_portal', 'browser', '↗', `Opened ${vendor.portal || 'the vendor portal'}`, 'report found', portal.text, 2600);

  const match = threeWayMatch(ctx, policy);
  ctx._findings = match.findings;

  for (const g of match.guardrails) {
    step('guard.vendor_text', 'guard', '!', 'Ignored an instruction in vendor text', 'logged', `“${g.text}”`, 40, { warn: true });
  }

  const lineFlags = match.lines.filter((l) => l.flags.length);
  const lineFindings = match.findings.filter((f) => f.lineIdx != null && f.code !== 'PRICE_UNDER');
  const varianceTotal = lineFindings.reduce((s, f) => s + f.amount, 0);
  step('match.three_way', 'reason', '=', 'Computed the variance in code', lineFlags.length ? money(varianceTotal) : 'clean',
    lineFlags.length
      ? lineFlags.map((l) => `${l.sku || l.desc}: ${l.flags.map((f) => FINDING_META[f]?.label || f).join(', ')}${l.priceVar?.unit ? ` (${pct(l.priceVar.pct)} vs PO)` : ''}`).join(' · ')
      : `All ${match.lines.length} lines within ${policy.priceTolerancePct}% / ${money(policy.priceToleranceAbs)} of PO, receipt, and agreement`,
    90, { tone: lineFlags.length ? 'bad' : 'ok' });

  const sweep = match.findings.find((f) => f.code === 'PRICE_OVER_CONTRACT' && f.detail.sweep);
  if (sweep) step('match.contract_sweep', 'reason', '§', 'Contract sweep: PO price is above the agreement', money(sweep.amount), `Invoice and ${po.id} agree at ${money(sweep.detail.invoicePrice, true)}, so 3-way match passed. The agreement says ${money(sweep.detail.contractPrice, true)}.`, 70, { tone: 'bad' });

  const dup = match.findings.find((f) => f.code === 'DUPLICATE');
  const bank = match.findings.find((f) => f.code === 'BANK_MISMATCH');
  step('ramp.bills.list', 'fetch', '▤', 'Checked payment history', dup ? 'duplicate' : `${ctx.paidBills.length + ctx.openBills.length} bills`, dup ? `Same as ${dup.detail.original} (${dup.detail.status === 'paid' ? `paid ${fmtDate(dup.detail.paidOn)}` : 'open'})` : 'No duplicate by number, amount, or service period', 160, { warn: !!dup, tone: dup ? 'bad' : undefined });
  step('ramp.vendors.bank_accounts', 'fetch', '▤', 'Checked the remit-to account', bank ? 'changed' : `••${vendor.bank.last4}`, bank ? `Bill says ••${bank.detail.invoiceBank.last4}; on file ••${bank.detail.onFile.last4}${bank.detail.domainMismatch ? `; sent from ${bank.detail.senderDomain}` : ''}` : 'Matches the vendor record', 120, { warn: !!bank, tone: bank ? 'bad' : undefined });

  const corpus = buildCorpus(ctx);
  const codes = [...new Set(match.findings.map((f) => f.code))].filter((c) => QUERIES[c]);
  const evidence = codes.map((code) => ({ forCode: code, query: QUERIES[code], hits: bm25(corpus, QUERIES[code], { k: 3 }) })).filter((e) => e.hits.length);
  const topHits = [...new Map(evidence.flatMap((e) => e.hits.slice(0, 2)).map((h) => [h.id, h])).values()];
  step('rag.search', 'retrieve', '§', 'Searched agreements and vendor history', `${topHits.length} cited`, topHits.length ? topHits.slice(0, 4).map((h) => `${h.title} (${h.relevance.toFixed(2)})`).join(' · ') : 'No clauses needed', 320);

  const primary = primaryFinding(match.findings);
  const cause = rootCause(primary, ctx, evidence);
  step('agent.diagnose', 'reason', '◆', primary ? `Diagnosed: ${FINDING_META[primary.code].label}` : 'Diagnosed: clean', primary ? FINDING_META[primary.code].code : 'CLEAN', cause.headline, 1400, { tone: primary ? 'bad' : 'ok' });

  const plan = planResolution(ctx, match, primary, evidence, policy);
  step('policy.check', 'guard', '✓', 'Applied approval policy', `${plan.approvals.length} approver${plan.approvals.length > 1 ? 's' : ''}`, plan.approvals.map((a) => `${a.role}: ${a.reason}`).join(' · '), 60);
  step('draft.compose', 'draft', '✎', `Drafted: ${plan.label}`, plan.actions.length ? `${plan.actions.length} action${plan.actions.length > 1 ? 's' : ''}` : '', plan.actions.map((a) => a.title).join(' → '), 900);

  const formula = formulaFor(primary, ctx, match, plan);
  const correction = correctionFor(primary, ctx, plan);
  return { ctx, steps, match, findings: match.findings, guardrails: match.guardrails, primary, cause, evidence, plan, formula, correction };
}
