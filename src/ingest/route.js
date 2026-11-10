// Decide what each parsed document is: a new bill (clean or an exception), or a vendor reply
// that answers a case already in the queue. Pure function: returns reducer actions + result rows.

import { contextFor } from '../data/scenarios.js';
import { investigate } from '../engine/agent.js';
import { newCase, openBillsFor, analyze } from '../store.js';
import { money, sumLines, normalizeInvoiceId } from '../engine/util.js';
import { FINDING_META } from '../engine/resolve.js';

const base = (id) => String(id || '').replace(/-R$/i, '');

export function routeResults(results, { cases, policy }) {
  const work = [...cases];
  const actions = [];
  const rows = [];
  const caseFor = (pred) => work.find(pred);

  for (const r of results) {
    if (r.kind === 'error') { rows.push({ fileName: r.fileName, status: 'error', title: 'Couldn’t read this file', detail: r.error }); continue; }

    if (r.kind === 'credit_memo') {
      const art = r.artifact;
      const c = caseFor((x) => x.invoice.id === art.ref) || caseFor((x) => x.invoice.vendorId === r.vendorId && x.status === 'waiting' && x.frozen?.plan.type === 'credit_memo');
      if (!c) { rows.push({ fileName: r.fileName, status: 'error', title: `Credit memo ${art.id} for ${money(art.amount)}`, detail: `No case is waiting for a credit memo${art.ref ? ` on ${art.ref}` : ''}.` }); continue; }
      const a = analyze(c, policy, work);
      if (c.status !== 'waiting' || a.plan.type !== 'credit_memo') {
        rows.push({ fileName: r.fileName, status: 'early', caseId: c.id, title: `Credit memo ${art.id} answers ${c.invoice.id}`, detail: c.status === 'resolved' ? 'That case is already closed.' : `Approve the credit memo request on ${c.invoice.id} first, then drop this in again.` });
        continue;
      }
      const ok = Math.abs(art.amount - a.plan.disputed) < 0.01 && (!art.ref || art.ref === c.invoice.id);
      actions.push({ type: 'REPLY', id: c.id, reply: { from: `${a.ctx.vendor.contact} <${a.ctx.vendor.email}>`, channel: 'email', subject: `Credit memo ${art.id}`, body: `${money(art.amount)} credit against ${art.ref || c.invoice.id}.`, artifact: art, upload: r.fileName } });
      rows.push({ fileName: r.fileName, status: ok ? 'reply-ok' : 'reply-fail', caseId: c.id, title: `Credit memo ${art.id} → ${c.invoice.id}`, detail: ok ? `Matches the ${money(a.plan.disputed)} requested. Credit applied and payment released.` : `It’s ${money(Math.abs(a.plan.disputed - art.amount))} ${art.amount < a.plan.disputed ? 'short' : 'over'}. Matchbook kept the case open and drafted a reply.` });
      continue;
    }

    const inv = r.invoice;
    // A corrected invoice that answers a waiting case.
    const target = caseFor((x) => x.status === 'waiting' && x.frozen?.plan.type === 'corrected_invoice' && x.invoice.vendorId === inv.vendorId && (base(inv.id) === x.invoice.id || (r.corrected && normalizeInvoiceId(base(inv.id)) === normalizeInvoiceId(x.invoice.id))));
    if (target) {
      const re = investigate(contextFor(inv), policy);
      const issues = re.findings.filter((f) => !['DUPLICATE', 'PO_REF_TYPO', 'PRICE_UNDER'].includes(f.code)).map((f) => FINDING_META[f.code].label);
      const total = sumLines(inv.lines);
      const a = target.frozen;
      actions.push({ type: 'REPLY', id: target.id, reply: { from: `${a.ctx.vendor.contact} <${a.ctx.vendor.email}>`, channel: 'email', subject: `Corrected invoice ${inv.id}`, body: `Corrected invoice ${inv.id} for ${money(total)}.`, artifact: { type: 'Corrected invoice', id: inv.id, ref: target.invoice.id, amount: total, rematch: { clean: !issues.length, issues } }, upload: r.fileName } });
      const ok = !issues.length && Math.abs(total - a.plan.payable) < 0.01;
      rows.push({ fileName: r.fileName, status: ok ? 'reply-ok' : 'reply-fail', caseId: target.id, title: `Corrected invoice ${inv.id} → ${target.invoice.id}`, detail: ok ? `Re-matched clean at ${money(total)}. Payment released.` : `Still doesn’t match: ${issues.join(', ') || `total ${money(total)} vs ${money(a.plan.payable)} expected`}.` });
      continue;
    }
    if (r.corrected) {
      const c = caseFor((x) => x.invoice.id === base(inv.id) && x.invoice.vendorId === inv.vendorId);
      if (c && c.status !== 'waiting') {
        rows.push({ fileName: r.fileName, status: 'early', caseId: c.id, title: `Corrected invoice ${inv.id} answers ${c.invoice.id}`, detail: c.status === 'resolved' ? 'That case is already closed.' : `Approve the corrected-invoice request on ${c.invoice.id} first, then drop this in again.` });
        continue;
      }
    }

    // A new bill: run Bill Pay's match + Matchbook's contract sweep.
    const draft = { seq: Infinity, invoice: inv };
    const a = investigate(contextFor(inv, { openBills: openBillsFor(draft, work) }), policy);
    if (a.plan.type === 'clear') {
      rows.push({ fileName: r.fileName, status: 'clean', title: `${inv.id} · ${a.ctx.vendor.name} · ${money(a.match.totals.invoice)}`, detail: `Matches ${a.ctx.po?.id}, ${a.ctx.po?.service ? 'the signed completion report' : 'the item receipt'}, and the agreement. Passed to Bill Pay’s normal approval.`, warnings: r.warnings });
      continue;
    }
    const c = newCase(inv, 'upload', policy, work);
    work.push(c);
    actions.push({ type: 'ADD', c });
    rows.push({
      fileName: r.fileName, status: 'exception', caseId: c.id,
      title: `${inv.id} · ${a.ctx.vendor.name} · ${money(a.match.totals.invoice)}`,
      detail: c.flag ? `Bill Pay blocked it: ${c.flag}. Added to the queue.` : 'Passed 3-way match, but the contract sweep flagged it. Added to the queue.',
      warnings: r.warnings,
    });
  }
  return { actions, rows };
}
