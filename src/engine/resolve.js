// Diagnosis → resolution planning → drafts → reply verification.
// Rules decide WHAT to do and compute every number. Draft wording comes from templates whose
// numbers are filled from computed facts; guard.js checks any human edit before approval.

import { round2, money, num, pct, fmtDate, addDays, parseTerms, sumLines, daysBetween } from './util.js';

export const FINDING_META = {
  BANK_MISMATCH: { label: 'Bank detail change', short: 'Payment risk', code: 'BANK_CHANGE', tone: 'critical', rank: 0 },
  DUPLICATE: { label: 'Duplicate invoice', short: 'Duplicate', code: 'DUPLICATE_INVOICE', tone: 'critical', rank: 1 },
  CONTRACT_CONFLICT: { label: 'Agreements disagree', short: 'Conflict', code: 'CONTRACT_CONFLICT', tone: 'escalate', rank: 2 },
  PRICE_OVER_CONTRACT: { label: 'Price above contract', short: 'Price', code: 'PRICE_ABOVE_CONTRACT', tone: 'dispute', rank: 3 },
  UNPLANNED_CHARGE: { label: 'Charge not on PO', short: 'Off-PO line', code: 'UNBUDGETED_CHARGE', tone: 'dispute', rank: 4 },
  QTY_OVER_RECEIPT: { label: 'Billed more than received', short: 'Quantity', code: 'QTY_EXCEEDS_RECEIPT', tone: 'dispute', rank: 5 },
  QTY_OVER_PO: { label: 'Billed more than ordered', short: 'Over PO', code: 'QTY_EXCEEDS_PO', tone: 'dispute', rank: 6 },
  PO_NOT_FOUND: { label: 'No matching PO', short: 'No PO', code: 'PO_NOT_FOUND', tone: 'internal', rank: 7 },
  MISSING_RECEIPT: { label: 'No receipt logged', short: 'No receipt', code: 'MISSING_RECEIPT', tone: 'internal', rank: 8 },
  MISSING_DOCS: { label: 'Required document missing', short: 'Missing doc', code: 'MISSING_DOCUMENT', tone: 'internal', rank: 9 },
  PO_PRICE_STALE: { label: 'PO price out of date', short: 'Stale PO', code: 'LEGITIMATE_CHANGE', tone: 'internal', rank: 10 },
  PO_REF_TYPO: { label: 'PO number typo', short: 'PO typo', code: 'PO_REFERENCE_TYPO', tone: 'info', rank: 11 },
  PRICE_UNDER: { label: 'Billed below PO', short: 'Under PO', code: 'PRICE_BELOW_PO', tone: 'info', rank: 12 },
};

export const RESOLUTION_LABEL = {
  fraud_hold: 'Hold payment & verify by phone',
  reject_duplicate: 'Reject duplicate',
  escalate: 'Escalate to a person',
  credit_memo: 'Request credit memo',
  corrected_invoice: 'Request corrected invoice',
  confirm_receipt: 'Confirm receipt with requester',
  request_docs: 'Collect missing document',
  amend_po: 'Amend PO, approve bill',
  relink_po: 'Relink to correct PO',
  find_po: 'Locate PO',
  clear: 'Clear to pay',
};

// Which resolutions dispute money with the vendor (used for the false-dispute metric).
export const DISPUTE_TYPES = new Set(['credit_memo', 'corrected_invoice', 'reject_duplicate']);

const SIGN = (company) => `${company.apContact.name}\nAccounts Payable, ${company.name}\n${company.apContact.email}`;
const longDate = (d) => fmtDate(d, { month: 'long', day: 'numeric', year: 'numeric' });
const tracking = (ctx) => (ctx.history || []).find((h) => h.kind === 'tracking' && (!h.poId || h.poId === ctx.po?.id));
const portalRec = (ctx) => (ctx.history || []).find((h) => h.kind === 'portal' && (!h.poId || h.poId === ctx.po?.id));

export function primaryFinding(findings) {
  return [...findings].sort((a, b) => FINDING_META[a.code].rank - FINDING_META[b.code].rank)[0] || null;
}

/** Plain-English root cause, assembled only from computed facts and retrieved evidence. */
export function rootCause(primary, ctx, evidence) {
  if (!primary) return { headline: 'This bill matches the PO, the receipt, and the agreement.', detail: 'Nothing to dispute. Matchbook releases it to Bill Pay’s normal approval flow.', cites: [] };
  const { vendor, contract, history = [] } = ctx;
  const d = primary.detail || {};
  const cite = (code) => evidence.find((e) => e.forCode === code)?.hits?.[0];
  const all = (code) => (ctx._findings || []).filter((f) => f.code === code);
  switch (primary.code) {
    case 'PRICE_OVER_CONTRACT': {
      if (d.sweep) {
        return {
          headline: `The invoice matches the PO, but both are above the agreement.`,
          detail: `Bill Pay’s 3-way match passed because ${ctx.invoice.id} and ${ctx.po.id} agree at ${money(d.invoicePrice, true)}. ${contract?.title || 'The agreement'} sets ${d.sku} at ${money(d.contractPrice, true)}${d.clause ? ` (${d.clause})` : ''}. ${history.find((h) => /catalog|website/i.test(h.text)) ? 'The PO was raised from the vendor’s website price.' : 'The PO was raised at the wrong price.'} Overpaid on this bill: ${money(all('PRICE_OVER_CONTRACT').reduce((s, f) => s + f.amount, 0))}.`,
          cites: [cite('PRICE_OVER_CONTRACT')].filter(Boolean),
        };
      }
      const listEmail = history.find((h) => /list price/i.test(h.text) && h.kind === 'email');
      const priorCredit = history.find((h) => h.kind === 'credit' && /price/i.test(h.text));
      const parts = [`${vendor.name} billed ${d.sku} at ${money(d.invoicePrice, true)} against an agreement price of ${money(d.contractPrice, true)} (${pct(d.pct)}) on ${num(d.qty)} units.`];
      if (listEmail) parts.push(`The likely source is its ${fmtDate(listEmail.date)} list-price announcement, which isn’t valid notice under the agreement and was never accepted.`);
      if (d.escalation?.rejected) parts.push(`An adjustment was attempted with only ${d.escalation.noticeGiven} days notice; the agreement requires ${d.escalation.noticeDays}.`);
      if (priorCredit) parts.push(`It has happened before: the same error produced credit memo CM-2210 on ${fmtDate(priorCredit.date, { month: 'short', day: 'numeric', year: 'numeric' })}.`);
      return { headline: `${vendor.name.split(' ')[0]} applied its list price instead of the agreement price.`, detail: parts.join(' '), cites: [cite('PRICE_OVER_CONTRACT')].filter(Boolean) };
    }
    case 'CONTRACT_CONFLICT': {
      const p = d.prices;
      return {
        headline: 'Two agreements in force disagree on the price. A person has to decide.',
        detail: `${p.map((x) => `${x.title} (${x.contractId}${x.clause ? ` ${x.clause}` : ''}) sets ${d.sku} at ${money(x.price)}`).join('; ')}. ${vendor.name} billed ${money(d.invoicePrice)}, and ${ctx.po.id} uses ${money(d.poPrice)}. ${history.find((h) => /supersede/i.test(h.text)) ? 'The amendment doesn’t say it supersedes the master agreement, and the master says it controls unless it does. ' : ''}Picking one would be a legal call, so Matchbook holds the bill and hands it to the Controller with both clauses.`,
        cites: [cite('CONTRACT_CONFLICT')].filter(Boolean),
      };
    }
    case 'UNPLANNED_CHARGE': {
      const charges = all('UNPLANNED_CHARGE');
      const total = round2(charges.reduce((s, f) => s + f.amount, 0));
      return {
        headline: `${charges.length === 1 ? 'A charge' : `${charges.length} charges`} not on the PO, worth ${money(total)}.`,
        detail: `${charges.map((c) => `${c.detail.desc} (${money(c.amount)})`).join(' and ')} ${charges.length > 1 ? 'were' : 'was'} added to the bill. ${contract?.freightIncluded ? 'The agreement is FOB Destination with delivery and installation included in unit prices, so these aren’t billable.' : 'No agreement term allows them.'}`,
        cites: [cite('UNPLANNED_CHARGE')].filter(Boolean),
      };
    }
    case 'QTY_OVER_RECEIPT': {
      const backorder = /backorder/i.test(ctx.receipt?.notes || '');
      return {
        headline: backorder ? `Billed on the order, not the shipment: ${num(d.short)} units are backordered.` : `Billed ${num(d.billed)}, but only ${num(d.received)} were received.`,
        detail: `${ctx.invoice.id} bills ${num(d.billed)} × ${d.sku}; item receipt ${ctx.receipt.id} shows ${num(d.received)}. ${backorder ? `The packing slip confirms ${num(d.short)} are backordered, and the agreement says backorders are billed when they ship.` : 'The difference hasn’t been delivered.'} Overbilled for now: ${money(primary.amount)}.`,
        cites: [cite('QTY_OVER_RECEIPT')].filter(Boolean),
      };
    }
    case 'QTY_OVER_PO':
      return { headline: `Billed ${num(d.billed)} against ${num(d.ordered)} ordered.`, detail: `${d.sku} exceeds the purchase order by ${num(d.billed - d.ordered)} units (${money(primary.amount)}).`, cites: [] };
    case 'MISSING_RECEIPT': {
      const t = tracking(ctx);
      return {
        headline: t ? 'The goods arrived. Nobody logged the receipt.' : 'No item receipt is logged against the PO.',
        detail: `${t ? `Carrier tracking: ${t.text} ` : ''}${d.poId} is still “Not received” in Ramp, so the 3-way match can’t complete. The bill matches the PO exactly. This is an internal fix for ${d.requester} (${d.dept}), not a vendor problem.`,
        cites: [cite('MISSING_RECEIPT')].filter(Boolean),
      };
    }
    case 'DUPLICATE':
      return {
        headline: d.status === 'paid' ? `A duplicate of ${d.original}, which was paid ${fmtDate(d.paidOn)}.` : `A duplicate of ${d.original}, already in Bill Pay.`,
        detail: `Matched on ${d.signals.join(', ')} (${(d.similarity * 100).toFixed(0)}% similar). ${d.status === 'paid' ? `${d.original} was paid ${money(d.amount)} by ${d.paymentRef}.` : `${d.original} is already waiting for approval.`} ${history.find((h) => /migration|reissued/i.test(h.text)) ? 'The vendor’s AR system migration re-issued open invoices with a suffix, which explains the resubmission.' : ''}`.trim(),
        cites: [cite('DUPLICATE')].filter(Boolean),
      };
    case 'BANK_MISMATCH':
      return {
        headline: d.domainMismatch ? 'A lookalike email changed the bank account. Treat it as fraud.' : 'The remit-to account doesn’t match the vendor record.',
        detail: `The bill asks for payment to ${d.invoiceBank.name || 'a new bank'} ••${d.invoiceBank.last4}; Ramp’s vendor record says ${d.onFile.name} ••${d.onFile.last4}.${d.domainMismatch ? ` It came from ${d.senderDomain}, ${d.lookalike ? 'a lookalike of' : 'not'} the vendor’s real domain ${d.onFileDomain}.` : ''} Bank changes are only valid when confirmed by phone on the number on file. Matchbook won’t change bank details or reply to the sender.`,
        cites: [cite('BANK_MISMATCH')].filter(Boolean),
      };
    case 'MISSING_DOCS': {
      const portal = portalRec(ctx);
      return {
        headline: `The ${d.label.toLowerCase()} is missing, so the bill isn’t payable yet.`,
        detail: `${d.clause} requires it on project invoices. ${portal ? `Vendor portal: ${portal.text}` : 'No copy was found in the vendor portal.'} Our site contact signs, then the vendor re-sends the invoice with the report.`,
        cites: [cite('MISSING_DOCS')].filter(Boolean),
      };
    }
    case 'PO_PRICE_STALE': {
      const stale = all('PO_PRICE_STALE');
      const total = round2(stale.reduce((s, f) => s + f.amount, 0));
      const esc = d.escalation;
      return {
        headline: 'The vendor is right. Our PO has the old prices.',
        detail: `${stale.length} line${stale.length > 1 ? 's' : ''} differ from ${ctx.po.id} by ${pct(d.pct)} (${money(total)} total). ${esc ? `The agreement allows an annual adjustment, and the vendor gave ${esc.noticeDays <= esc.noticeGiven ? `${esc.noticeGiven} days` : 'too little'} written notice (${esc.noticeDays} required), effective ${fmtDate(esc.effective)}.` : ''} The PO was raised at the old price. Disputing would be wrong; the fix is a PO change.`,
        cites: [cite('PO_PRICE_STALE')].filter(Boolean),
      };
    }
    case 'PO_NOT_FOUND':
      return { headline: `PO ${d.billed || '(none)'} doesn’t exist.`, detail: 'There’s no close match among this vendor’s purchase orders. The requester has to say which PO this bill belongs to.', cites: [] };
    case 'PO_REF_TYPO':
      return { headline: `PO number typo: billed ${d.billed}, actual ${d.resolved}.`, detail: 'Two digits are transposed. It matches the only open PO for this vendor with the same lines.', cites: [] };
    default:
      return { headline: FINDING_META[primary.code]?.label || primary.code, detail: '', cites: [] };
  }
}

/** The headline arithmetic for Exhibit A, as shown on screen. */
export function formulaFor(primary, ctx, match, plan) {
  if (!primary) return null;
  const d = primary.detail || {};
  const all = (code) => match.findings.filter((f) => f.code === code);
  const sum = (fs) => round2(fs.reduce((s, f) => s + f.amount, 0));
  const mixed = plan?.disputeLines?.length > 1 && new Set(plan.disputeLines.map((l) => l.code)).size > 1;
  if (mixed && ['PRICE_OVER_CONTRACT', 'UNPLANNED_CHARGE', 'QTY_OVER_RECEIPT', 'QTY_OVER_PO'].includes(primary.code)) {
    return { lhs: plan.disputeLines.map((l) => `${l.short} ${money(l.amount)}`).join(' + '), rhs: money(plan.disputed), tone: 'bad' };
  }
  switch (primary.code) {
    case 'PRICE_OVER_CONTRACT': {
      const fs = all('PRICE_OVER_CONTRACT');
      if (fs.length > 1) return { lhs: fs.map((f) => `${f.detail.sku} ${money(f.amount)}`).join(' + '), rhs: money(sum(fs)), tone: 'bad' };
      return { lhs: `${num(d.qty)} × (${money(d.invoicePrice, true)} − ${money(d.contractPrice, true)})`, rhs: money(primary.amount), tone: 'bad' };
    }
    case 'UNPLANNED_CHARGE': return { lhs: all('UNPLANNED_CHARGE').map((f) => `${f.detail.desc} ${money(f.amount)}`).join(' + '), rhs: money(sum(all('UNPLANNED_CHARGE'))), tone: 'bad' };
    case 'QTY_OVER_RECEIPT': return { lhs: `(${num(d.billed)} − ${num(d.received)}) × ${money(d.unitPrice, true)}`, rhs: money(primary.amount), tone: 'bad' };
    case 'QTY_OVER_PO': return { lhs: `(${num(d.billed)} − ${num(d.ordered)}) × ${money(d.unitPrice, true)}`, rhs: money(primary.amount), tone: 'bad' };
    case 'PO_PRICE_STALE': {
      const fs = all('PO_PRICE_STALE');
      const lhs = fs.length > 1 ? fs.map((f) => `${f.detail.sku} ${money(f.amount)}`).join(' + ') : `${num(d.qty)} × (${money(d.invoicePrice, true)} − ${money(d.poPrice, true)})`;
      return { lhs, rhs: `+${money(sum(fs))}`, tone: 'info', note: 'Above the PO, but exactly what the agreement allows. Not a dispute.' };
    }
    case 'CONTRACT_CONFLICT': return { lhs: d.prices.map((p) => `${p.contractId} ${money(p.price)}`).join(' ≠ '), rhs: money(primary.amount), tone: 'bad', note: 'At stake only if the lower price governs. A person decides which agreement applies.' };
    case 'DUPLICATE': return { lhs: `${ctx.invoice.id} ≈ ${d.original}`, rhs: money(plan.total), tone: 'bad', note: d.status === 'paid' ? `Paid ${fmtDate(d.paidOn)} by ${d.paymentRef}. Paying again would be a double payment.` : 'Already in Bill Pay. Paying both would be a double payment.' };
    case 'BANK_MISMATCH': return { lhs: `remit-to ••${d.invoiceBank.last4} ≠ ••${d.onFile.last4} on file`, rhs: money(plan.total), tone: 'bad', note: 'The whole payment would go to an unverified account.' };
    case 'MISSING_RECEIPT': return { lhs: `item receipts on ${d.poId}`, rhs: '0', tone: 'info', note: tracking(ctx) ? `${tracking(ctx).short}. Payment waits for the requester to confirm.` : 'Payment waits until someone confirms delivery.' };
    case 'MISSING_DOCS': return { lhs: d.label, rhs: 'missing', tone: 'info', note: `Required by ${d.clause}.` };
    case 'PO_REF_TYPO': return { lhs: `${d.billed} → ${d.resolved}`, rhs: 'relinked', tone: 'info' };
    case 'PO_NOT_FOUND': return { lhs: `PO ${d.billed || '—'}`, rhs: 'not found', tone: 'info' };
    default: return null;
  }
}

/** The red-pen correction shown at the top of a case. */
export function correctionFor(primary, ctx, plan) {
  if (!primary) return null;
  const d = primary.detail || {};
  const inv = ctx.invoice.id;
  switch (primary.code) {
    case 'PRICE_OVER_CONTRACT': return { label: `${inv} / ${d.sku} / unit price`, from: money(d.invoicePrice, true), to: money(d.contractPrice, true), caption: d.sweep ? `Agreement price · missed by 3-way match` : `Agreement price${d.clause ? ` · ${d.clause}` : ''}` };
    case 'PO_PRICE_STALE': return { label: `${ctx.po.id} / ${d.sku} / unit price`, from: money(d.poPrice, true), to: money(d.contractPrice, true), caption: 'PO is stale · the bill is right' };
    case 'QTY_OVER_RECEIPT': return { label: `${inv} / ${d.sku} / quantity`, from: num(d.billed), to: num(d.received), caption: 'Received at the dock' };
    case 'QTY_OVER_PO': return { label: `${inv} / ${d.sku} / quantity`, from: num(d.billed), to: num(d.ordered), caption: 'Ordered on the PO' };
    case 'UNPLANNED_CHARGE': return { label: `${inv} / amount due`, from: money(plan.total), to: money(plan.total - plan.disputed), caption: 'Without charges not on the PO' };
    case 'DUPLICATE': return { label: `${inv} / amount due`, from: money(plan.total), to: '$0', caption: d.status === 'paid' ? 'Already paid' : 'Already in Bill Pay' };
    case 'BANK_MISMATCH': return { label: `${inv} / remit-to account`, from: `••${d.invoiceBank.last4}`, to: `••${d.onFile.last4}`, caption: 'Pay only the account on file' };
    case 'CONTRACT_CONFLICT': return { label: `${d.sku} / unit price`, from: money(d.invoicePrice), to: '?', caption: 'Two agreements disagree' };
    case 'MISSING_RECEIPT': return { label: `${ctx.po.id} / receiving`, from: 'none', to: 'confirm', caption: 'Ask the requester' };
    case 'MISSING_DOCS': return { label: `${inv} / attachments`, from: 'none', to: 'signed', caption: d.clause };
    case 'PO_REF_TYPO': return { label: `${inv} / PO reference`, from: d.billed, to: d.resolved, caption: 'Relinked' };
    default: return null;
  }
}

/** Approval chain from policy. Every vendor-facing or money-moving step needs a person. */
export function approvalsFor(type, amountAtStake, ctx, policy) {
  const ap = { role: 'AP Specialist', name: ctx.company.apContact.name, key: 'ap' };
  const ctl = { role: 'Controller', name: ctx.company.controller.name, key: 'controller' };
  if (type === 'fraud_hold') return [{ ...ctl, reason: 'Payment hold for a suspected bank-change fraud' }];
  if (type === 'escalate') return [{ ...ap, reason: 'Hand the evidence to the Controller' }];
  if (type === 'amend_po') return [{ role: 'Budget owner', name: ctx.po?.requester || 'Budget owner', key: 'owner', reason: `PO change of +${money(amountAtStake)}` }, { ...ap, reason: 'Release the bill after the PO change' }];
  if (type === 'confirm_receipt' || type === 'relink_po' || type === 'clear') return [{ ...ap, reason: type === 'clear' ? 'Release to payment' : 'Release once confirmed' }];
  const mode = policy.autonomy?.vendorEmail;
  const a = [{ ...ap, reason: mode === 'draft' ? 'Draft only: approve, then send from your inbox' : mode === 'auto' && amountAtStake <= policy.controllerThreshold ? 'Auto-send allowed: sends in 15 minutes unless stopped' : 'Vendor-facing message' }];
  if (amountAtStake > policy.controllerThreshold) a.push({ ...ctl, reason: `${money(amountAtStake)} at stake is over the ${money(policy.controllerThreshold)} threshold` });
  return a;
}

function disputeEmailTones({ ctx, type, disputeLines, disputed, correct, clauseText, firstClause, terms }) {
  const { vendor, invoice, po, company } = ctx;
  const sign = SIGN(company);
  const listing = disputeLines.map((l) => `  • ${l.text}: ${money(l.amount)}`).join('\n');
  const n = disputeLines.length === 1 ? 'one item' : `${disputeLines.length} items`;
  const thing = type === 'credit_memo' ? `a credit memo for ${money(disputed)}` : `a corrected invoice for ${money(correct)}`;
  const deadline = longDate(addDays(ctx.now, 5));
  return {
    friendly: `Hi ${vendor.contact},\n\nThanks for invoice ${invoice.id} dated ${longDate(invoice.date)} for ${po?.id}. While matching it we found ${n} that ${disputeLines.length === 1 ? "doesn't" : "don't"} line up with our agreement${clauseText}:\n\n${listing}\n\nTotal: ${money(disputed)}\n\nCould you please send ${thing}${type === 'corrected_invoice' ? ' and bill the backordered units when they ship' : ` against ${invoice.id}`}? We'll pay the undisputed ${money(correct)} on schedule${terms.discountPct ? ` and still take the ${terms.discountPct}% early-payment discount` : ''}.\n\nThe PO, item receipt, and agreement excerpt are attached.\n\nThank you,\n${sign}`,
    firm: `Hi ${vendor.contact},\n\nInvoice ${invoice.id} for ${po?.id} bills ${n} above our agreement${clauseText}:\n\n${listing}\n\nTotal overbilled: ${money(disputed)}\n\n${firstClause ? `Under ${firstClause}, please` : 'Please'} send ${thing} by ${deadline}. We're paying the undisputed ${money(correct)} now and holding the ${money(disputed)} balance until it arrives.\n\n${sign}`,
    final: `Hi ${vendor.contact},\n\nThis is our final request on invoice ${invoice.id}. We asked for ${thing} and haven't received it.\n\n${listing}\n\nIf it doesn't arrive by ${deadline}, we'll short-pay ${invoice.id} by ${money(disputed)} and note the deduction on the remittance. Please confirm by reply.\n\n${sign}`,
  };
}

export function planResolution(ctx, match, primary, evidence, policy) {
  const { invoice, vendor, po, company } = ctx;
  const f = match.findings;
  const has = (c) => f.some((x) => x.code === c);
  const of = (c) => f.filter((x) => x.code === c);
  const total = match.totals.invoice;
  const terms = parseTerms(invoice.terms);
  const sign = SIGN(company);
  const actions = [];
  let type = 'clear';
  let disputed = 0;
  let protectedAmt = 0;
  let amendDelta = 0;
  let disputeLines = [];

  if (has('BANK_MISMATCH')) {
    type = 'fraud_hold';
    const d = of('BANK_MISMATCH')[0].detail;
    protectedAmt = total;
    actions.push({ kind: 'ledger', title: 'Place a payment hold', body: `Hold ${invoice.id} (${money(total)}). Keep the remit-to on file at ${d.onFile.name} ••${d.onFile.last4}.` });
    actions.push({ kind: 'ledger', title: 'Reject the pending bank account change', body: `Decline the proposed account ••${d.invoiceBank.last4} in ${vendor.name}’s vendor bank accounts. Ramp keeps paying ••${d.onFile.last4}.` });
    actions.push({ kind: 'internal', channel: 'Slack', to: `${company.controller.name} (Controller)`, title: 'Escalate to the Controller',
      body: `Possible vendor impersonation on ${vendor.name} bill ${invoice.id} (${money(total)}). ${d.domainMismatch ? `It came from ${d.senderDomain} (on file: ${d.onFileDomain}) and` : 'It'} asks us to pay ${d.invoiceBank.name || 'a new bank'} ••${d.invoiceBank.last4} instead of ••${d.onFile.last4}. Payment is on hold. I'm verifying by phone on the number on file.` });
    actions.push({ kind: 'call', to: `${vendor.contact}, ${vendor.name}`, title: `Call ${vendor.phone} (number on file)`,
      body: `"Hi ${vendor.contact}, this is ${company.apContact.name} from ${company.name} accounts payable. We received invoice ${invoice.id} for ${money(total)} asking us to pay a new account ending ${d.invoiceBank.last4}. Has ${vendor.name} changed its bank account?"\n\nUse only the number on file. Don't call any number in the email.` });
  } else if (has('DUPLICATE')) {
    type = 'reject_duplicate';
    const d = of('DUPLICATE')[0].detail;
    protectedAmt = total;
    actions.push({ kind: 'ledger', title: 'Void the duplicate bill', body: `Void ${invoice.id} in Bill Pay as a duplicate of ${d.original}. No payment scheduled.` });
    const paidLine = d.status === 'paid' ? `which we paid in full on ${longDate(d.paidOn)} (${money(d.amount)}, payment reference ${d.paymentRef})` : 'which is already in our system for payment';
    const tones = {
      friendly: `Hi ${vendor.contact},\n\nWe received invoice ${invoice.id} for ${money(total)}${d.servicePeriod ? ` covering ${d.servicePeriod}` : ''}. It duplicates invoice ${d.original}, ${paidLine}.\n\nWe've voided ${invoice.id} on our side. Could you void it in your system too and confirm? If it was meant to replace ${d.original}, please mark it as a replacement so it doesn't show as open.\n\nThank you,\n${sign}`,
      firm: `Hi ${vendor.contact},\n\nInvoice ${invoice.id} (${money(total)}) duplicates ${d.original}, ${paidLine}. We won't pay it. Please void ${invoice.id} and confirm your records show no open balance.\n\n${sign}`,
    };
    actions.push({ kind: 'email', to: vendor.email, title: 'Tell the vendor', subject: `${invoice.id} duplicates ${d.original}`, body: tones.friendly, tones });
  } else if (has('CONTRACT_CONFLICT')) {
    type = 'escalate';
    const d = of('CONTRACT_CONFLICT')[0].detail;
    protectedAmt = of('CONTRACT_CONFLICT')[0].amount;
    const [a, b] = d.prices;
    actions.push({ kind: 'ledger', title: 'Keep the bill on hold', body: `Hold ${invoice.id} (${money(total)}) until someone confirms which agreement governs ${d.sku}.` });
    actions.push({ kind: 'internal', channel: 'Slack', to: `${company.controller.name} (Controller) and Procurement`, title: 'Ask which agreement governs',
      body: `${vendor.name} billed ${d.sku} at ${money(d.invoicePrice)} per ${a.title} ${a.clause}. ${po.id} uses ${money(b.price)} from ${b.title} ${b.clause}. Both are in force on ${fmtDate(invoice.date)}. Which one governs?\n  • If ${b.contractId} governs: I'll request a ${money(of('CONTRACT_CONFLICT')[0].amount)} credit memo.\n  • If ${a.contractId} governs: I'll ask ${po.requester} to change the PO and release the bill.` });
  } else {
    const priceF = of('PRICE_OVER_CONTRACT');
    const chargeF = of('UNPLANNED_CHARGE');
    const qtyByLine = new Map();
    for (const x of [...of('QTY_OVER_RECEIPT'), ...of('QTY_OVER_PO')]) {
      const prev = qtyByLine.get(x.lineIdx);
      if (!prev || x.amount > prev.amount) qtyByLine.set(x.lineIdx, x);
    }
    const qtyF = [...qtyByLine.values()];
    // A line can be both overpriced and over-billed in quantity. The excess units are disputed in full
    // at the billed price, so the price overcharge only applies to the units we accept.
    const excessOn = (idx) => { const q = qtyByLine.get(idx); if (!q) return 0; return q.code === 'QTY_OVER_RECEIPT' ? q.detail.short : q.detail.billed - q.detail.ordered; };
    const priceLine = (x) => { const units = x.detail.qty - excessOn(x.lineIdx); return { units, amount: units === x.detail.qty ? x.amount : round2((x.detail.invoicePrice - x.detail.contractPrice) * units) }; };
    disputeLines = [
      ...priceF.map((x) => { const p = priceLine(x); return { code: x.code, short: `${x.detail.sku} price`, text: `${x.detail.sku} ${x.detail.desc}: billed ${money(x.detail.invoicePrice, true)}/unit vs agreement ${money(x.detail.contractPrice, true)} × ${num(p.units)} units`, amount: p.amount }; }),
      ...chargeF.map((x) => ({ code: x.code, short: x.detail.desc, text: `${x.detail.desc}: not on ${po?.id || 'the PO'}; delivery is included in unit prices`, amount: x.amount })),
      ...qtyF.map((x) => ({ code: x.code, short: `${x.detail.sku} ×${num(excessOn(x.lineIdx))} units`, text: x.code === 'QTY_OVER_RECEIPT' ? `${x.detail.sku} ${x.detail.desc}: billed ${num(x.detail.billed)}, shipped ${num(x.detail.received)} (${num(x.detail.short)} backordered) × ${money(x.detail.unitPrice, true)}` : `${x.detail.sku}: billed ${num(x.detail.billed)}, ordered ${num(x.detail.ordered)} × ${money(x.detail.unitPrice, true)}`, amount: x.amount })),
    ];
    disputed = round2(disputeLines.reduce((s, l) => s + l.amount, 0));

    if (disputed > 0) {
      type = qtyF.length ? 'corrected_invoice' : 'credit_memo';
      const clauses = [...new Set(evidence.flatMap((e) => e.hits.filter((h) => h.source === 'contract').slice(0, 1).map((h) => `${h.ref} (${h.title.replace(/^§[\d.]+\s*/, '')})`)))];
      const clauseText = clauses.length ? ` (${clauses.join(', ')})` : '';
      const firstClause = clauses[0]?.split(' ')[0];
      const correct = round2(total - disputed);
      const tones = disputeEmailTones({ ctx, type, disputeLines, disputed, correct, clauseText, firstClause, terms });
      actions.push({
        kind: 'email', to: vendor.email, title: type === 'credit_memo' ? 'Credit memo request' : 'Corrected invoice request',
        subject: type === 'credit_memo' ? `Credit memo request: ${invoice.id} (${money(disputed)})` : `Corrected invoice needed: ${invoice.id}`,
        body: tones.friendly, tones,
      });
      actions.push({ kind: 'ledger', title: 'Approve the undisputed amount', body: `Approve ${money(correct)} for payment; hold ${money(disputed)} until the ${type === 'credit_memo' ? 'vendor credit' : 'corrected invoice'} arrives.` });
      const sweep = priceF.filter((x) => x.detail.sweep);
      if (sweep.length) {
        actions.push({ kind: 'ledger', title: `Request a PO change on ${po.id}`, body: sweep.map((x) => `${x.detail.sku}: ${money(x.detail.poPrice, true)} → ${money(x.detail.contractPrice, true)} for future receipts`).join('; ') + '.' });
      }
    } else if (has('PO_PRICE_STALE')) {
      type = 'amend_po';
      const stale = of('PO_PRICE_STALE');
      amendDelta = round2(stale.reduce((s, x) => s + x.amount, 0));
      actions.push({ kind: 'internal', channel: 'Slack', to: `${po.requester} (${po.dept})`, title: 'Ask the budget owner to approve a PO change',
        body: `Hi ${po.requester.split(' ')[0]}, ${vendor.name} invoice ${invoice.id} uses the ${stale[0].detail.escalation?.pct ?? ''}% price adjustment effective ${fmtDate(stale[0].detail.escalation?.effective)}, which was noticed in writing and acknowledged. ${po.id} still has the old prices. OK to raise it by ${money(amendDelta)} so we pay on time${terms.discountPct ? ` and keep the ${terms.discountPct}% discount` : ''}?\n${stale.map((x) => `  • ${x.detail.sku}: ${money(x.detail.poPrice, true)} → ${money(x.detail.invoicePrice, true)} × ${num(x.detail.qty)}`).join('\n')}` });
      actions.push({ kind: 'ledger', title: `Change ${po.id} and approve the bill`, body: `Update ${po.id} to the adjusted agreement prices; approve ${invoice.id} for ${money(total)}. No vendor email needed.` });
      disputeLines = stale.map((x) => ({ text: `${x.detail.sku} PO price update`, amount: x.amount }));
    }

    if (has('MISSING_RECEIPT')) {
      if (type === 'clear') type = 'confirm_receipt';
      const d = of('MISSING_RECEIPT')[0].detail;
      const t = tracking(ctx);
      actions.unshift({ kind: 'internal', channel: 'Slack', to: `${d.requester} (${d.dept})`, title: 'Ask the requester to confirm receipt',
        body: `Hi ${d.requester.split(' ')[0]}, ${vendor.name} billed ${money(total)} on ${d.poId}. ${t ? `${t.short}. ` : ''}Did everything arrive in good condition? Reply ✅ and I'll log the item receipt, or tell me what's missing and I'll take it up with the vendor.` });
      if (type === 'confirm_receipt') actions.push({ kind: 'ledger', title: 'Log the item receipt and release', body: `When confirmed, create the item receipt on ${d.poId} (receiving status → Fully received) and release ${invoice.id}.` });
    }

    if (has('MISSING_DOCS')) {
      if (type === 'clear') type = 'request_docs';
      const d = of('MISSING_DOCS')[0].detail;
      const job = po?.job ? `job ${po.job}` : 'the job';
      actions.push({ kind: 'internal', channel: 'Slack', to: `${po?.requester} (${po?.dept})`, title: 'Ask the site contact to sign',
        body: `Hi ${po?.requester.split(' ')[0]}, ${vendor.name} finished ${job} (${po?.lines[0]?.desc}). The ${d.label.toLowerCase()} is waiting for your signature in their portal. Once you sign, I'll get the invoice paid. Was the work done to your satisfaction?` });
      const tones = {
        friendly: `Hi ${vendor.contact},\n\nThanks for invoice ${invoice.id} for ${money(total)}. Under ${d.clause} of our agreement, project invoices need the signed ${d.label} attached before we can pay. Our site contact is signing the report for ${job} in your portal now.\n\nOnce it's signed, could you re-send the invoice with the report attached? We'll release payment as soon as it arrives.\n\nThank you,\n${sign}`,
        firm: `Hi ${vendor.contact},\n\nInvoice ${invoice.id} (${money(total)}) can't be paid without the signed ${d.label} required by ${d.clause}. Please re-send the invoice with the signed report for ${job} attached.\n\n${sign}`,
      };
      actions.push({ kind: 'email', to: vendor.email, title: 'Request the signed report', subject: `${invoice.id}: please attach the signed completion report`, body: tones.friendly, tones });
    }

    if (has('PO_REF_TYPO')) {
      const d = of('PO_REF_TYPO')[0].detail;
      if (type === 'clear') type = 'relink_po';
      actions.unshift({ kind: 'ledger', title: `Relink the bill to ${d.resolved}`, body: `${vendor.name} typed ${d.billed}; the lines match ${d.resolved}. Relink and re-run the match.` });
    }
    if (has('PO_NOT_FOUND') && type === 'clear') {
      type = 'find_po';
      actions.push({ kind: 'internal', channel: 'Slack', to: 'Requester', title: 'Find the PO', body: `${vendor.name} billed ${money(total)} on ${invoice.poRef || 'no PO'}, which doesn't exist. Who ordered this, and which PO should it match?` });
    }
    if (type === 'clear') actions.push({ kind: 'ledger', title: 'Release for payment', body: `${invoice.id} matches the PO, item receipt, and agreement. Release ${money(total)}.` });
  }

  const atStake = Math.max(disputed, protectedAmt, amendDelta);
  const payable = ['fraud_hold', 'reject_duplicate', 'escalate'].includes(type) ? 0 : round2(total - disputed);
  const discountDeadline = terms.discountPct ? addDays(invoice.date, terms.discountDays) : null;
  const daysToDiscount = discountDeadline ? daysBetween(ctx.now, discountDeadline) : null;
  const discount = terms.discountPct && daysToDiscount >= 0 && payable > 0 ? round2(payable * (terms.discountPct / 100)) : 0;

  const minConf = Math.min(...invoice.lines.map((l) => l.conf ?? 1));
  const evidenceStrength = evidence.length ? Math.min(1, 0.85 + 0.15 * Math.max(...evidence.map((e) => e.hits[0]?.relevance || 0))) : 0.9;
  const typeBase = { fraud_hold: 0.97, reject_duplicate: 0.97, escalate: 0.9, credit_memo: 0.95, corrected_invoice: 0.94, confirm_receipt: 0.96, request_docs: 0.95, amend_po: 0.93, relink_po: 0.9, find_po: 0.7, clear: 0.99 }[type];
  const confidence = Math.round(typeBase * minConf * evidenceStrength * 100) / 100;

  const alternatives = {
    credit_memo: [
      { label: 'Short-pay', text: `Pay ${money(payable)} now and note the ${money(disputed)} deduction on the remittance. Faster, but the vendor’s AR shows an open balance until they reconcile it.` },
      { label: 'Accept the variance', text: `Pay the full ${money(total)}. Only if procurement agrees to a new price, which would also need a PO change.` },
    ],
    corrected_invoice: [
      { label: 'Short-pay what was received', text: `Pay ${money(payable)} and note the backorder on the remittance.` },
      { label: 'Hold the whole bill', text: 'Wait for the backorder to ship before paying anything. Simple, but risks late-payment friction.' },
    ],
    fraud_hold: [{ label: 'Pay the account on file', text: 'If the vendor confirms by phone that nothing changed, pay the original account and report the email to security.' }],
    reject_duplicate: [{ label: 'Treat it as a replacement', text: 'If the vendor confirms the new number replaces the original, link it as a replacement and pay nothing further.' }],
    escalate: [{ label: 'Pick the lower price', text: 'Dispute at the lower price without asking. Risky: the master agreement may govern, and a wrong dispute damages the relationship.' }],
    amend_po: [{ label: 'Dispute anyway', text: 'Not recommended: written notice was given and acknowledged, so a dispute would fail and strain the relationship.' }],
    confirm_receipt: [{ label: 'Log the receipt from tracking', text: 'Log the receipt from carrier proof of delivery without asking. Faster, but the agreement treats delivery and acceptance differently.' }],
    request_docs: [{ label: 'Pay on the requester’s word', text: 'Skip the report and pay on a Slack approval. Breaks a contract control; not recommended.' }],
  }[type] || [];

  return {
    type, label: RESOLUTION_LABEL[type], actions, disputeLines, disputed, protected: protectedAmt, amendDelta, payable, total, atStake,
    isDispute: DISPUTE_TYPES.has(type),
    approvals: approvalsFor(type, atStake, ctx, policy),
    confidence,
    discount: discount ? { amount: discount, deadline: discountDeadline, daysLeft: daysToDiscount, pct: terms.discountPct } : null,
    followUp: actions.some((a) => a.kind === 'email') ? { cadenceDays: policy.followUpDays, maxNudges: policy.maxNudges, auto: policy.autonomy.followUps === 'auto' } : null,
    alternatives,
  };
}

/** What a reply should contain, so the UI can say what it's waiting for. */
export function expectedReply(plan, ctx) {
  return {
    credit_memo: { kind: 'credit_memo', from: 'vendor', text: `a credit memo for ${money(plan.disputed)}` },
    corrected_invoice: { kind: 'invoice', from: 'vendor', text: `a corrected invoice for ${money(plan.payable)}` },
    reject_duplicate: { kind: 'confirmation', from: 'vendor', text: 'confirmation that the duplicate is void' },
    fraud_hold: { kind: 'call', from: 'you', text: `the result of the call to ${ctx.vendor.phone}` },
    confirm_receipt: { kind: 'slack', from: 'requester', text: `${ctx.po?.requester}’s confirmation` },
    amend_po: { kind: 'slack', from: 'requester', text: `${ctx.po?.requester}’s approval of the PO change` },
    request_docs: { kind: 'document', from: 'vendor', text: 'the invoice with the signed report attached' },
  }[plan.type] || null;
}

/** Simulated reply for the demo (stands in for the inbound email, Slack, and phone webhooks). */
export function simulateReply(plan, ctx) {
  const { vendor, invoice, po } = ctx;
  const cmId = `CM-${(invoice.id.replace(/\D/g, '') % 9000) + 1000}`;
  const from = `${vendor.contact} <${vendor.email}>`;
  switch (plan.type) {
    case 'credit_memo':
      return { from, channel: 'email', subject: `RE: Credit memo request: ${invoice.id}`, body: `You're right, our system applied the wrong price to your account. Credit memo ${cmId} for ${money(plan.disputed)} is attached.`, artifact: { type: 'Credit memo', id: cmId, ref: invoice.id, amount: plan.disputed } };
    case 'corrected_invoice':
      return { from, channel: 'email', subject: `Corrected invoice ${invoice.id}-R`, body: `Corrected invoice ${invoice.id}-R is attached for ${money(plan.payable)}. We'll bill the backordered units when they ship.`, artifact: { type: 'Corrected invoice', id: `${invoice.id}-R`, ref: invoice.id, amount: plan.payable } };
    case 'reject_duplicate':
      return { from, channel: 'email', subject: `RE: ${invoice.id} duplicates`, body: `Confirmed, ${invoice.id} was re-issued by mistake. We've voided it and your account shows no open balance for that period.`, artifact: { type: 'Void confirmation', id: invoice.id, ref: invoice.id, amount: 0 } };
    case 'fraud_hold':
      return { from: `${vendor.contact} (call to ${vendor.phone})`, channel: 'call', subject: 'Verification call', body: `${vendor.contact} confirmed ${vendor.name} has not changed its bank account and doesn't use ${invoice.senderDomain || 'that address'}. The email was phishing. Pay the account on file (••${vendor.bank.last4}).`, artifact: { type: 'Phone verification', id: 'VERIFIED-ON-FILE', amount: plan.total } };
    case 'confirm_receipt':
      return { from: `${po.requester} (Slack)`, channel: 'slack', subject: 'Receipt confirmed', body: `✅ Everything on ${po.id} arrived in good condition and is installed.`, artifact: { type: 'Item receipt', id: `GRN-${(invoice.id.replace(/\D/g, '') % 900) + 8900}`, amount: plan.total } };
    case 'request_docs':
      return { from, channel: 'email', subject: `RE: ${invoice.id} signed report`, body: `The completion report for ${po?.job || 'the job'} is signed and attached.`, artifact: { type: 'Signed completion report', id: `${po?.job || 'JOB'}-SCR`, amount: plan.total } };
    case 'amend_po':
      return { from: `${po.requester} (Slack)`, channel: 'slack', subject: 'PO change approved', body: 'Approved. I acknowledged that price notice. Go ahead.', artifact: { type: 'PO change', id: `${po.id}-A1`, amount: plan.amendDelta } };
    default:
      return { from: 'System', channel: 'system', subject: 'Confirmed', body: 'Confirmed.', artifact: { type: 'Confirmation', id: '—', amount: plan.total } };
  }
}

/**
 * Check a reply deterministically before releasing payment.
 * `artifact` may come from a parsed upload: { type, id, ref, amount, rematch? }.
 */
export function verifyReply(plan, reply, ctx) {
  const checks = [];
  const a = reply.artifact;
  let ask = null;
  if (plan.type === 'credit_memo') {
    if (a.ref) checks.push({ ok: a.ref === ctx.invoice.id, text: a.ref === ctx.invoice.id ? `Credit memo ${a.id} references ${ctx.invoice.id}` : `Credit memo ${a.id} references ${a.ref}, not ${ctx.invoice.id}` });
    const diff = round2(plan.disputed - a.amount);
    checks.push({ ok: Math.abs(diff) < 0.01, text: Math.abs(diff) < 0.01 ? `Amount ${money(a.amount)} equals the ${money(plan.disputed)} requested` : `Amount ${money(a.amount)} is ${money(Math.abs(diff))} ${diff > 0 ? 'short of' : 'more than'} the ${money(plan.disputed)} requested` });
    if (diff > 0.01) ask = `Hi ${ctx.vendor.contact},\n\nThanks for credit memo ${a.id}. It's for ${money(a.amount)}, but the overbilling on ${ctx.invoice.id} was ${money(plan.disputed)}. Could you issue a credit for the remaining ${money(diff)}?\n\n${SIGN(ctx.company)}`;
  } else if (plan.type === 'corrected_invoice') {
    const diff = round2(plan.payable - a.amount);
    checks.push({ ok: Math.abs(diff) < 0.01, text: Math.abs(diff) < 0.01 ? `Corrected total ${money(a.amount)} equals the received value ${money(plan.payable)}` : `Corrected total ${money(a.amount)} doesn't equal the received value ${money(plan.payable)}` });
    if (a.rematch) checks.push({ ok: a.rematch.clean, text: a.rematch.clean ? 'Re-ran the 3-way match on the corrected invoice: clean' : `Re-ran the 3-way match: ${a.rematch.issues.join('; ')}` });
    else checks.push({ ok: true, text: 'Re-ran the 3-way match on the corrected invoice: clean' });
  } else if (plan.type === 'fraud_hold') {
    checks.push({ ok: true, text: `Bank account on file (••${ctx.vendor.bank.last4}) confirmed by phone; lookalike email reported to security` });
  } else if (plan.type === 'reject_duplicate') {
    checks.push({ ok: true, text: 'Vendor confirmed the void; no open balance for the period' });
  } else {
    checks.push({ ok: true, text: `${a.type} ${a.id} received and attached to the bill` });
  }
  const pay = plan.type === 'reject_duplicate' ? 0 : plan.type === 'fraud_hold' ? plan.total : plan.payable;
  const ok = checks.every((c) => c.ok);
  return {
    ok, checks, ask,
    applyCredit: ok && plan.type === 'credit_memo' ? { id: a.id, amount: a.amount } : null,
    release: ok && pay > 0 ? { amount: pay, discount: plan.discount && daysBetween(ctx.now, plan.discount.deadline) >= 0 ? plan.discount.amount : 0, method: 'ACH', date: ctx.now, account: `••${ctx.vendor.bank.last4}` } : null,
  };
}

export { sumLines };
