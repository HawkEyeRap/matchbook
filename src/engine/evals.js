// The scorecard: every seeded exception, every sample file, and every vendor reply, with the
// answer a careful AP specialist would give. Runs in the browser (Scorecard page) and in CI (npm test).

import { INVOICES, contextFor } from '../data/scenarios.js';
import { investigate } from './agent.js';
import { verifyReply } from './resolve.js';
import { allowedTokens, checkGrounding, factsText } from './guard.js';
import { DEFAULT_POLICY } from './match.js';
import { sumLines } from './util.js';

export const EVAL_CASES = [
  { key: 'list_price', title: 'Vendor used its list price', bill: 'NWP-30917', expect: { root: 'PRICE_OVER_CONTRACT', type: 'credit_memo', amount: 1000, dispute: true, cites: ['§3.1'] } },
  { key: 'backorder', title: 'Billed for backordered units', bill: 'SLS-118204', expect: { root: 'QTY_OVER_RECEIPT', type: 'corrected_invoice', amount: 740, dispute: true, cites: ['§4.3'] } },
  { key: 'no_receipt', title: 'Delivered but not received in Ramp', bill: 'BAV-5521', expect: { root: 'MISSING_RECEIPT', type: 'confirm_receipt', amount: 0, dispute: false, cites: ['§3.2'] } },
  { key: 'duplicate', title: 'Re-issued invoice, already paid', bill: 'RW10388-A', expect: { root: 'DUPLICATE', type: 'reject_duplicate', amount: 12400, dispute: true, cites: ['§4.4'] } },
  { key: 'legit_increase', title: 'Valid contractual price increase', bill: 'FIF-60233', expect: { root: 'PO_PRICE_STALE', type: 'amend_po', amount: 465.6, dispute: false, cites: ['§5.3'] } },
  { key: 'unplanned', title: 'Freight and surcharge not on PO', bill: 'AF-77310', expect: { root: 'UNPLANNED_CHARGE', type: 'credit_memo', amount: 1381, dispute: true, cites: ['§6.1'], guardrail: true } },
  { key: 'bank_change', title: 'Bank change from a lookalike domain', bill: 'MPC-2093', expect: { root: 'BANK_MISMATCH', type: 'fraud_hold', amount: 6240, dispute: false, cites: ['§8.1'] } },
  { key: 'missing_doc', title: 'Missing signed completion report', bill: 'CFS-4410', expect: { root: 'MISSING_DOCS', type: 'request_docs', amount: 0, dispute: false, cites: ['§7.3'] } },
  { key: 'sweep', title: 'PO and bill both above contract', bill: 'KOS-55120', expect: { root: 'PRICE_OVER_CONTRACT', type: 'credit_memo', amount: 525, dispute: true, cites: ['§2.1'] } },
  { key: 'conflict', title: 'Two agreements disagree', bill: 'TIG-20931', expect: { root: 'CONTRACT_CONFLICT', type: 'escalate', amount: 120, dispute: false, cites: ['§14'] } },
  { key: 'pdf_price', title: 'PDF: list price again', file: 'northwind-NWP-31244.pdf', expect: { root: 'PRICE_OVER_CONTRACT', type: 'credit_memo', amount: 720, dispute: true, fields: { id: 'NWP-31244', poRef: 'PO-4502', date: '2026-11-06', terms: '2/10 Net 30' } } },
  { key: 'pdf_clean', title: 'PDF: clean bill passes through', file: 'summit-lab-SLS-118391.pdf', expect: { root: 'CLEAN', type: 'clear', amount: 0, dispute: false, fields: { id: 'SLS-118391', poRef: 'PO-4507' } } },
  { key: 'pdf_fees', title: 'PDF: add-on fees, different layout', file: 'alder-finch-AF-77402.pdf', expect: { root: 'UNPLANNED_CHARGE', type: 'credit_memo', amount: 458, dispute: true, fields: { id: 'AF-77402', date: '2026-11-05' } } },
  { key: 'pdf_bank', title: 'PDF: new bank, lookalike sender', file: 'meridian-print-MPC-2117.pdf', expect: { root: 'BANK_MISMATCH', type: 'fraud_hold', amount: 2496, dispute: false, fields: { id: 'MPC-2117', date: '2026-11-07' } } },
  { key: 'pdf_dup', title: 'PDF: re-issued paid invoice', file: 'redwood-RW-10241-R.pdf', expect: { root: 'DUPLICATE', type: 'reject_duplicate', amount: 12400, dispute: true, fields: { servicePeriod: 'Sep 2026' } } },
  { key: 'pdf_stale', title: 'PDF: PO typo and stale PO', file: 'ferro-FIF-60318.pdf', expect: { root: 'PO_PRICE_STALE', type: 'amend_po', amount: 310.4, dispute: false, fields: { poRef: 'PO-4562' } } },
  { key: 'pdf_receipt', title: 'PDF: nothing received yet', file: 'brightline-BAV-5560.pdf', expect: { root: 'MISSING_RECEIPT', type: 'confirm_receipt', amount: 0, dispute: false } },
  { key: 'csv_clean', title: 'CSV: signed project invoice', file: 'ramp-bill-export.csv', bill: 'CFS-4431', expect: { root: 'CLEAN', type: 'clear', amount: 0, dispute: false } },
  { key: 'csv_backorder', title: 'CSV: billed for backorder', file: 'ramp-bill-export.csv', bill: 'SLS-118402', expect: { root: 'QTY_OVER_RECEIPT', type: 'corrected_invoice', amount: 740, dispute: true } },
  { key: 'reply_ok', title: 'Reply: credit memo for the right amount', file: 'northwind-credit-memo-CM-4917.pdf', answers: 'NWP-30917', expect: { verified: true } },
  { key: 'reply_short', title: 'Reply: credit memo $200 short', file: 'northwind-credit-memo-CM-4918-short.pdf', answers: 'NWP-30917', expect: { verified: false } },
  { key: 'reply_corrected', title: 'Reply: corrected invoice re-matches', file: 'summit-lab-corrected-SLS-118204-R.pdf', answers: 'SLS-118204', expect: { verified: true } },
];

const near = (a, b) => Math.abs((a || 0) - (b || 0)) < 0.01;

function grade(a, e) {
  const root = a.primary?.code || 'CLEAN';
  const allowed = allowedTokens(factsText(a));
  const drafts = a.plan.actions.filter((x) => x.kind === 'email' || x.kind === 'internal');
  const ungrounded = drafts.flatMap((x) => Object.values(x.tones || { b: x.body }).flatMap((b) => checkGrounding(`${x.subject || ''}\n${b}`, allowed).unknown));
  const hitRefs = new Set(a.evidence.flatMap((ev) => ev.hits.map((h) => h.ref)));
  const checks = {
    root: root === e.root,
    resolution: a.plan.type === e.type,
    amount: near(a.plan.atStake, e.amount),
    noFalseDispute: a.plan.isDispute === e.dispute,
    citations: (e.cites || []).every((c) => hitRefs.has(c)),
    draftsTraced: ungrounded.length === 0,
  };
  if (e.guardrail) checks.guardrail = a.guardrails.length > 0;
  return { got: { root, type: a.plan.type, amount: a.plan.atStake, dispute: a.plan.isDispute, cites: [...hitRefs].slice(0, 4) }, checks };
}

/**
 * ingest(fileName) → parse results (array) for sample files; omit to skip file-based cases.
 * Returns { rows, metrics }.
 */
export async function runEvals({ ingest, policy = DEFAULT_POLICY } = {}) {
  const rows = [];
  const fileCache = new Map();
  const parsed = async (name) => {
    if (!fileCache.has(name)) fileCache.set(name, await ingest(name));
    return fileCache.get(name);
  };
  let n = 0;
  for (const ev of EVAL_CASES) {
    n++;
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    try {
      if (ev.answers) {
        if (!ingest) continue;
        const [r] = await parsed(ev.file);
        const orig = investigate(contextFor(INVOICES.find((i) => i.id === ev.answers)), policy);
        let artifact;
        if (r.kind === 'credit_memo') artifact = r.artifact;
        else {
          const re = investigate(contextFor(r.invoice), policy);
          const issues = re.findings.filter((f) => !['DUPLICATE', 'PO_REF_TYPO', 'PRICE_UNDER'].includes(f.code));
          artifact = { type: 'Corrected invoice', id: r.invoice.id, ref: ev.answers, amount: sumLines(r.invoice.lines), rematch: { clean: !issues.length, issues: issues.map((f) => f.code) } };
        }
        const v = verifyReply(orig.plan, { artifact }, orig.ctx);
        const checks = { parsed: r.kind !== 'error', verified: v.ok === ev.expect.verified, paymentGate: ev.expect.verified ? !!v.release : !v.release };
        rows.push({ n, ...ev, source: ev.file, got: { verified: v.ok, release: v.release?.amount ?? 0, amount: artifact.amount }, checks, pass: Object.values(checks).every(Boolean), ms: (performance?.now?.() ?? Date.now()) - t0 });
        continue;
      }
      let invoice;
      let fieldChecks = {};
      if (ev.file) {
        if (!ingest) continue;
        const results = await parsed(ev.file);
        const r = results.find((x) => x.kind === 'invoice' && (!ev.bill || x.invoice.id === ev.bill));
        if (!r) { rows.push({ n, ...ev, source: ev.file, got: { error: results[0]?.error || 'not parsed' }, checks: { parsed: false }, pass: false, ms: 0 }); continue; }
        invoice = r.invoice;
        for (const [k, v] of Object.entries(ev.expect.fields || {})) fieldChecks[`field:${k}`] = invoice[k] === v;
      } else {
        invoice = INVOICES.find((i) => i.id === ev.bill);
      }
      const a = investigate(contextFor(invoice), policy);
      const g = grade(a, ev.expect);
      const checks = { ...(ev.file ? { parsed: true } : {}), ...fieldChecks, ...g.checks };
      rows.push({ n, ...ev, source: ev.file || 'Seeded bill', got: g.got, checks, pass: Object.values(checks).every(Boolean), ms: (performance?.now?.() ?? Date.now()) - t0 });
    } catch (err) {
      rows.push({ n, ...ev, source: ev.file || 'Seeded bill', got: { error: String(err?.message || err) }, checks: { ran: false }, pass: false, ms: 0 });
    }
  }
  const graded = rows.filter((r) => !r.answers);
  const disputesExpectedNo = graded.filter((r) => r.expect.dispute === false);
  const metrics = {
    passed: rows.filter((r) => r.pass).length,
    total: rows.length,
    rootCause: ratio(graded, (r) => r.checks.root),
    amount: ratio(graded, (r) => r.checks.amount),
    falseDispute: disputesExpectedNo.length ? disputesExpectedNo.filter((r) => r.got.dispute).length / disputesExpectedNo.length : 0,
    traced: ratio(graded, (r) => r.checks.draftsTraced),
    extraction: ratio(rows.filter((r) => r.file && !r.answers), (r) => Object.entries(r.checks).filter(([k]) => k.startsWith('field:') || k === 'parsed').every(([, v]) => v)),
    replies: ratio(rows.filter((r) => r.answers), (r) => r.pass),
  };
  return { rows, metrics };
}

const ratio = (list, fn) => (list.length ? list.filter(fn).length / list.length : 1);
