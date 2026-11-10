// Case lifecycle. In production each transition is a Ramp Bill Pay state change plus an
// outbound action (email, Slack, call task, vendor credit, PO change) recorded in the audit log.

import { INVOICES, DEMO_NOW, contextFor } from './data/scenarios.js';
import { investigate } from './engine/agent.js';
import { DEFAULT_POLICY } from './engine/match.js';
import { simulateReply, verifyReply } from './engine/resolve.js';
import { money, num, fmtDate, addDays, sumLines } from './engine/util.js';

export const STATUS_LABEL = {
  new: 'Not started', investigating: 'Working', review: 'Needs you', waiting: 'Following up',
  resolved: 'Closed', escalated: 'With a person', rejected: 'You took over',
};
export const STATUS_GROUP = { new: 'open', investigating: 'work', review: 'you', waiting: 'work', resolved: 'done', escalated: 'done', rejected: 'done' };

/** Bill Pay's own flag, phrased the way Ramp phrases its 3-way match alerts. */
export function rampFlag(a, source) {
  if (source === 'contract_sweep') return null;
  const f = (code) => a.findings.find((x) => x.code === code);
  const x = f('BANK_MISMATCH') || f('DUPLICATE') || f('CONTRACT_CONFLICT') || f('PRICE_OVER_CONTRACT') || f('PO_PRICE_STALE') || f('UNPLANNED_CHARGE') || f('QTY_OVER_RECEIPT') || f('QTY_OVER_PO') || f('MISSING_RECEIPT') || f('MISSING_DOCS') || f('PO_REF_TYPO') || f('PO_NOT_FOUND');
  if (!x) return 'Manual review requested';
  const d = x.detail || {};
  switch (x.code) {
    case 'BANK_MISMATCH': return 'Remit-to account differs from the vendor record';
    case 'DUPLICATE': return `Possible duplicate of ${d.original}`;
    case 'CONTRACT_CONFLICT': return `Unit price exceeds PO by ${money(d.invoicePrice - d.poPrice)} on ${d.sku}`;
    case 'PRICE_OVER_CONTRACT': return d.sweep ? null : `Unit price exceeds PO by ${money(d.invoicePrice - d.poPrice, true)} on ${d.sku}`;
    case 'PO_PRICE_STALE': { const n = a.findings.filter((y) => y.code === 'PO_PRICE_STALE').length; return `Unit price exceeds PO on ${n} line${n > 1 ? 's' : ''}`; }
    case 'UNPLANNED_CHARGE': { const n = a.findings.filter((y) => y.code === 'UNPLANNED_CHARGE').length; return `${n} line item${n > 1 ? 's' : ''} not on ${a.ctx.po?.id || 'the PO'}`; }
    case 'QTY_OVER_RECEIPT': return `${num(d.short)} billed units have not been received`;
    case 'QTY_OVER_PO': return `Billed quantity exceeds PO by ${num(d.billed - d.ordered)} units`;
    case 'MISSING_RECEIPT': return `${num(sumLines(a.ctx.invoice.lines.map((l) => ({ qty: l.qty, unitPrice: 1 }))))} billed units have not been received`;
    case 'MISSING_DOCS': return 'Missing a required attachment';
    case 'PO_REF_TYPO': case 'PO_NOT_FOUND': return `PO ${a.ctx.invoice.poRef || ''} not found`;
    default: return 'Manual review requested';
  }
}

export const slug = (id) => String(id).replace(/[^A-Za-z0-9-]/g, '-');

const at = (day, h = 9, m = 12) => `${fmtDate(addDays(DEMO_NOW, day))}, ${h > 12 ? h - 12 : h}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
let clock = 0;
const nowStamp = (day = 0) => { clock = (clock + 7) % 50; return at(day, 10 + Math.floor(clock / 10), (clock * 7) % 60); };

export function openBillsFor(c, cases) {
  return cases.filter((o) => o.seq < c.seq).map((o) => ({ id: o.invoice.id, vendorId: o.invoice.vendorId, amount: sumLines(o.invoice.lines), servicePeriod: o.invoice.servicePeriod, date: o.invoice.date }));
}

export function analyze(c, policy, cases) {
  return c.frozen || investigate(contextFor(c.invoice, { openBills: openBillsFor(c, cases) }), policy);
}

let seqCounter = 0;
export function newCase(invoice, source = 'bill_pay', policy = DEFAULT_POLICY, cases = []) {
  const seq = ++seqCounter;
  let id = slug(invoice.id);
  let n = 1;
  while (cases.some((c) => c.id === id)) id = `${slug(invoice.id)}-${++n}`;
  const draft = { id, seq, invoice, source };
  const a = investigate(contextFor(invoice, { openBills: openBillsFor(draft, cases) }), policy);
  const flag = rampFlag(a, invoice.source);
  const src = flag === null ? 'contract_sweep' : source; // null: Bill Pay's 3-way match passed it
  return {
    id, seq, invoice, source: src, status: 'new', flag,
    approvals: {}, edits: {}, nudges: 0, day: 0, reply: null, verification: null, frozen: null,
    events: [{ t: source === 'bill_pay' || src === 'contract_sweep' ? at(-Math.max(0, Math.min(6, Math.round((new Date(DEMO_NOW) - new Date(invoice.date)) / 864e5))), 8, 40) : nowStamp(), kind: 'flag', title: flag ? `Bill Pay blocked the bill: ${flag}` : 'Contract sweep flagged the bill', body: flag ? '3-way match failed' : 'Invoice and PO agree, but both are above the agreement price.' }],
  };
}

export function initialCases(policy = DEFAULT_POLICY) {
  seqCounter = 0;
  const list = [];
  for (const inv of INVOICES) list.push(newCase(inv, 'bill_pay', policy, list));
  return list;
}

export function effectiveAction(c, idx, action) {
  const e = c.edits[idx];
  if (!e) return action;
  const body = e.body ?? (e.tone && action.tones ? action.tones[e.tone] : action.body);
  return { ...action, subject: e.subject ?? action.subject, body, editedBy: e.by, tone: e.tone || 'friendly' };
}

const push = (c, ev) => ({ ...c, events: [...c.events, { t: nowStamp(c.day), ...ev }] });

function execute(c, a) {
  let next = { ...c, frozen: a };
  a.plan.actions.forEach((raw, i) => {
    const act = effectiveAction(c, i, raw);
    if (act.kind === 'email') next = push(next, { kind: 'email', title: `Sent to ${act.to}`, body: act.subject, actor: 'Matchbook' });
    if (act.kind === 'internal') next = push(next, { kind: 'slack', title: `Messaged ${act.to}`, body: act.body.split('\n')[0], actor: 'Matchbook' });
    if (act.kind === 'call') next = push(next, { kind: 'call', title: 'Call task created', body: act.title });
    if (act.kind === 'ledger') next = push(next, { kind: 'ledger', title: act.title, body: act.body });
  });
  if (a.plan.type === 'clear') {
    const release = { amount: a.plan.payable, discount: a.plan.discount?.amount || 0, method: 'ACH', date: a.ctx.now, account: `••${a.ctx.vendor.bank.last4}` };
    return push({ ...next, status: 'resolved', verification: { ok: true, checks: [], release } }, { kind: 'paid', title: `Payment released: ${money(release.amount)}` });
  }
  if (a.plan.type === 'escalate') return push({ ...next, status: 'escalated' }, { kind: 'escalate', title: `Handed to ${a.ctx.company.controller.name} with both agreements`, body: 'The bill stays on hold until someone decides which agreement governs.' });
  if (a.plan.followUp) next = push(next, { kind: 'clock', title: `Follow-up scheduled for ${fmtDate(addDays(a.ctx.now, a.plan.followUp.cadenceDays))}`, body: `${a.plan.followUp.auto ? 'Automatic' : 'Drafted for approval'} every ${a.plan.followUp.cadenceDays} days, up to ${a.plan.followUp.maxNudges} times, then escalate to ${a.ctx.company.controller.name}.` });
  return { ...next, status: 'waiting' };
}

function applyReply(c, reply) {
  const a = c.frozen;
  const verification = verifyReply(a.plan, reply, a.ctx);
  let next = push({ ...c, reply }, {
    kind: reply.channel === 'slack' ? 'slack-in' : reply.channel === 'call' ? 'call' : 'email-in',
    title: reply.channel === 'call' ? `Call logged: ${reply.from}` : reply.upload ? `Uploaded ${reply.upload}` : `Reply from ${reply.from}`,
    body: reply.body,
  });
  next = push(next, { kind: verification.ok ? 'verify' : 'verify-fail', title: verification.ok ? `Checked ${reply.artifact.type.toLowerCase()} ${reply.artifact.id}` : `${reply.artifact.type} ${reply.artifact.id} doesn’t resolve it`, body: verification.checks.map((x) => `${x.ok ? '✓' : '✗'} ${x.text}`).join('\n') });
  if (!verification.ok) {
    if (verification.ask) next = push(next, { kind: 'email', title: `Drafted a reply to ${a.ctx.vendor.contact}`, body: verification.ask });
    return { ...next, verification, status: 'waiting' };
  }
  if (verification.applyCredit) next = push(next, { kind: 'ledger', title: `Applied vendor credit ${verification.applyCredit.id} to ${a.ctx.invoice.id}`, body: `${money(verification.applyCredit.amount)} credit recorded in Bill Pay.` });
  if (verification.release) next = push(next, { kind: 'paid', title: `Payment released: ${money(verification.release.amount)} by ${verification.release.method} to ${verification.release.account}`, body: verification.release.discount ? `Early-payment discount kept: ${money(verification.release.discount)}` : '' });
  else if (a.plan.type === 'reject_duplicate') next = push(next, { kind: 'paid', title: `Duplicate voided. ${money(a.plan.total)} not paid twice.` });
  next = push(next, { kind: 'sync', title: 'Bill synced back to Ramp' });
  return { ...next, verification, status: 'resolved' };
}

export function reducer(state, action) {
  const map = (id, fn) => state.map((c) => (c.id === id ? fn(c) : c));
  switch (action.type) {
    case 'START':
      return map(action.id, (c) => (c.status === 'new' ? push({ ...c, status: 'investigating' }, { kind: 'agent', title: 'Matchbook started investigating' }) : c));
    case 'TRACE_DONE':
      return map(action.id, (c) => (c.status === 'investigating' || c.status === 'new' ? push({ ...c, status: 'review' }, { kind: 'agent', title: action.a.cause.headline, body: `Recommended: ${action.a.plan.label}` }) : c));
    case 'APPROVE':
      return map(action.id, (c) => {
        if (c.status !== 'review') return c;
        let next = push({ ...c, approvals: { ...c.approvals, [action.key]: { by: action.by } } }, { kind: 'approve', title: `Approved by ${action.by}`, body: action.role });
        if (action.a.plan.approvals.every((x) => next.approvals[x.key])) next = execute(next, action.a);
        return next;
      });
    case 'REJECT':
      return map(action.id, (c) => push({ ...c, status: 'rejected', frozen: action.a }, { kind: 'reject', title: `${action.by} took over the case`, body: 'Nothing was sent. The bill stays blocked in Bill Pay.' }));
    case 'EDIT':
      return map(action.id, (c) => ({ ...c, edits: { ...c.edits, [action.idx]: { ...c.edits[action.idx], ...action.patch } } }));
    case 'REVERT':
      return map(action.id, (c) => { const e = { ...c.edits }; delete e[action.idx]; return { ...c, edits: e }; });
    case 'FAST_FORWARD':
      return map(action.id, (c) => {
        if (c.status !== 'waiting') return c;
        const a = c.frozen;
        const f = a.plan.followUp;
        if (f && c.nudges < 1 && !c.reply) {
          const day = c.day + f.cadenceDays;
          return push({ ...c, day, nudges: c.nudges + 1 }, { kind: 'nudge', title: `Day ${day}: no reply, so Matchbook followed up`, body: `Follow-up 1 of ${f.maxNudges} sent to ${a.ctx.vendor.email}.` });
        }
        const day = c.day + (f ? 1 : 1);
        return applyReply({ ...c, day }, simulateReply(a.plan, a.ctx));
      });
    case 'REPLY':
      return map(action.id, (c) => (c.status === 'waiting' ? applyReply({ ...c, day: c.day + 1 }, action.reply || simulateReply(c.frozen.plan, c.frozen.ctx)) : c));
    case 'ADD':
      return [...state, action.c];
    case 'RESET':
      return initialCases(action.policy);
    default:
      return state;
  }
}
