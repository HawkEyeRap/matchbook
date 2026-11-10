// Deterministic line-level matching: invoice ↔ purchase order ↔ item receipt ↔ vendor agreements.
// Numbers are owned here, never by a model. Every finding carries the exact figures it was
// computed from so drafts, the scorecard, and the audit trail can cite them.

import { round2, round4, lineTotal, sumLines, daysBetween, editDistance, normalizeInvoiceId } from './util.js';

export const DEFAULT_POLICY = {
  priceTolerancePct: 2, // pass if variance ≤ 2% AND ≤ $50 per line
  priceToleranceAbs: 50,
  controllerThreshold: 5000, // disputes or holds above this also need the Controller
  followUpDays: 3,
  maxNudges: 2,
  contractSweep: true, // compare PO prices to agreements even when invoice = PO
  autonomy: { vendorEmail: 'approve', followUps: 'auto', internalPings: 'auto', poAmendment: 'approve' },
};

/** Price an agreement allows for a SKU on a date, applying an escalation only if notice was valid. */
export function contractPriceOn(contract, sku, date) {
  const p = contract?.prices?.[sku];
  if (!p) return null;
  const esc = p.escalation;
  if (esc && date >= esc.effective) {
    const noticeGiven = daysBetween(esc.noticeDate, esc.effective);
    if (noticeGiven >= esc.noticeDays) {
      return { price: round4(p.unitPrice * (1 + esc.pct / 100)), base: p.unitPrice, escalated: true, escalation: { ...esc, noticeGiven }, contractId: contract.id };
    }
    return { price: p.unitPrice, base: p.unitPrice, escalated: false, escalation: { ...esc, noticeGiven, rejected: true }, contractId: contract.id };
  }
  return { price: p.unitPrice, base: p.unitPrice, escalated: false, contractId: contract.id };
}

/** Every agreement price in force for a SKU on a date. More than one distinct price is a conflict. */
export function pricesInForce(contracts, sku, date) {
  return (contracts || []).map((c) => {
    const cp = contractPriceOn(c, sku, date);
    return cp ? { ...cp, title: c.title, clause: c.clauses.find((k) => /pric/i.test(k.title))?.id || c.clauses[0]?.id } : null;
  }).filter(Boolean);
}

const withinTolerance = (varAmt, varPct, policy) => Math.abs(varPct) <= policy.priceTolerancePct && Math.abs(varAmt) <= policy.priceToleranceAbs;

// Instructions aimed at automation or reviewers inside vendor-supplied text.
const INJECTION = [
  /\b(ignore|disregard|skip|bypass)\b[^.]{0,40}\b(instruction|review|check|match|approval|policy)/i,
  /\b(approve|release|pay)\b[^.]{0,40}\b(without|no)\b[^.]{0,20}\b(review|approval|check)/i,
  /\b(automated|automation|AI|assistant|system|agent)s?\b[^.]{0,30}\b(must|should|shall|approve|release)/i,
  /\bSYSTEM\s*:/,
  /\bpre-?approved\b/i,
];
export function scanVendorText(text) {
  if (!text) return null;
  const hits = INJECTION.filter((re) => re.test(text));
  return hits.length ? { text, patterns: hits.length } : null;
}

export function threeWayMatch(ctx, policy = DEFAULT_POLICY) {
  const { invoice, po, receipt, vendor } = ctx;
  const contracts = ctx.contracts || (ctx.contract ? [ctx.contract] : []);
  const findings = [];
  const lines = invoice.lines.map((il, idx) => {
    const inv = { qty: il.qty, unitPrice: il.unitPrice, total: lineTotal(il) };
    const pol = il.sku && po ? po.lines.find((l) => l.sku === il.sku) : null;
    const rec = il.sku && receipt ? receipt.lines.find((l) => l.sku === il.sku) : null;
    const prices = il.sku ? pricesInForce(contracts, il.sku, invoice.date) : [];
    const distinct = [...new Set(prices.map((p) => p.price))];
    const cp = distinct.length === 1 ? prices.find((p) => p.contractId === ctx.contract?.id) || prices[0] : null;
    const row = { idx, sku: il.sku, desc: il.desc, conf: il.conf ?? 1, inv, po: pol ? { qty: pol.qty, unitPrice: pol.unitPrice, total: lineTotal(pol) } : null, received: rec ? rec.qty : null, contract: cp, prices, flags: [] };

    if (!pol) {
      row.flags.push('UNPLANNED_CHARGE');
      findings.push({ code: 'UNPLANNED_CHARGE', lineIdx: idx, amount: inv.total, detail: { desc: il.desc, freightIncluded: !!ctx.contract?.freightIncluded } });
      return row;
    }

    const priceVar = round4(il.unitPrice - pol.unitPrice);
    const priceVarAmt = round2(priceVar * il.qty);
    const priceVarPct = pol.unitPrice ? (priceVar / pol.unitPrice) * 100 : 0;
    row.priceVar = { unit: priceVar, amount: priceVarAmt, pct: priceVarPct };

    if (distinct.length > 1) {
      // Two agreements in force disagree. Code can't pick the governing one; a person must.
      const low = Math.min(...distinct);
      row.flags.push('CONTRACT_CONFLICT');
      findings.push({ code: 'CONTRACT_CONFLICT', lineIdx: idx, amount: round2(Math.max(0, il.unitPrice - low) * il.qty), detail: { sku: il.sku, desc: il.desc, prices, invoicePrice: il.unitPrice, poPrice: pol.unitPrice, qty: il.qty } });
    } else if (priceVar !== 0 && !withinTolerance(priceVarAmt, priceVarPct, policy)) {
      const contractPrice = cp?.price ?? pol.unitPrice;
      const matchesContract = Math.abs(il.unitPrice - contractPrice) / contractPrice < 0.005;
      if (matchesContract && priceVar > 0) {
        row.flags.push('PO_PRICE_STALE');
        findings.push({ code: 'PO_PRICE_STALE', lineIdx: idx, amount: priceVarAmt, detail: { sku: il.sku, poPrice: pol.unitPrice, invoicePrice: il.unitPrice, contractPrice, pct: priceVarPct, escalation: cp?.escalation, qty: il.qty } });
      } else if (il.unitPrice > contractPrice) {
        row.flags.push('PRICE_OVER_CONTRACT');
        findings.push({ code: 'PRICE_OVER_CONTRACT', lineIdx: idx, amount: round2((il.unitPrice - contractPrice) * il.qty), detail: { sku: il.sku, desc: il.desc, invoicePrice: il.unitPrice, contractPrice, poPrice: pol.unitPrice, qty: il.qty, pct: ((il.unitPrice - contractPrice) / contractPrice) * 100, escalation: cp?.escalation, clause: cp?.clause } });
      } else if (priceVar < 0) {
        row.flags.push('PRICE_UNDER');
        findings.push({ code: 'PRICE_UNDER', lineIdx: idx, amount: priceVarAmt, detail: { sku: il.sku, invoicePrice: il.unitPrice, poPrice: pol.unitPrice } });
      }
    } else if (policy.contractSweep && cp && il.unitPrice > cp.price) {
      // Contract sweep: invoice agrees with the PO, so 3-way match passes, but both exceed the agreement.
      const over = round2((il.unitPrice - cp.price) * il.qty);
      const pctOver = ((il.unitPrice - cp.price) / cp.price) * 100;
      if (!withinTolerance(over, pctOver, policy)) {
        row.flags.push('PRICE_OVER_CONTRACT');
        findings.push({ code: 'PRICE_OVER_CONTRACT', lineIdx: idx, amount: over, detail: { sku: il.sku, desc: il.desc, invoicePrice: il.unitPrice, contractPrice: cp.price, poPrice: pol.unitPrice, qty: il.qty, pct: pctOver, sweep: true, clause: cp.clause } });
      }
    }

    if (il.qty > pol.qty) {
      row.flags.push('QTY_OVER_PO');
      findings.push({ code: 'QTY_OVER_PO', lineIdx: idx, amount: round2((il.qty - pol.qty) * il.unitPrice), detail: { sku: il.sku, desc: il.desc, billed: il.qty, ordered: pol.qty, unitPrice: il.unitPrice } });
    }

    if (!po.service) {
      if (!receipt) {
        row.flags.push('MISSING_RECEIPT');
      } else if (!po.blanket && rec && il.qty > rec.qty) {
        const short = il.qty - rec.qty;
        row.flags.push('QTY_OVER_RECEIPT');
        findings.push({ code: 'QTY_OVER_RECEIPT', lineIdx: idx, amount: round2(short * il.unitPrice), detail: { sku: il.sku, desc: il.desc, billed: il.qty, received: rec.qty, short, unitPrice: il.unitPrice } });
      }
    }
    return row;
  });

  if (po && !po.service && !receipt) {
    findings.push({ code: 'MISSING_RECEIPT', amount: sumLines(invoice.lines), detail: { poId: po.id, requester: po.requester, dept: po.dept, daysSinceInvoice: daysBetween(invoice.date, ctx.now) } });
  }
  if (ctx.poResolvedFrom) findings.push({ code: 'PO_REF_TYPO', amount: 0, detail: { billed: ctx.poResolvedFrom, resolved: po.id } });
  if (!po) findings.push({ code: 'PO_NOT_FOUND', amount: sumLines(invoice.lines), detail: { billed: invoice.poRef } });

  const dup = findDuplicate(invoice, ctx.paidBills || [], ctx.openBills || []);
  if (dup) findings.push({ code: 'DUPLICATE', amount: sumLines(invoice.lines), detail: dup });

  const bank = checkRemittance(invoice, vendor);
  if (bank) findings.push({ code: 'BANK_MISMATCH', amount: sumLines(invoice.lines), detail: bank });

  for (const req of ctx.contract?.requiredAttachments || []) {
    if (!(invoice.attachments || []).includes(req.key)) findings.push({ code: 'MISSING_DOCS', amount: sumLines(invoice.lines), detail: { ...req } });
  }

  return {
    lines,
    findings,
    guardrails: [scanVendorText(invoice.notes)].filter(Boolean),
    totals: { invoice: sumLines(invoice.lines), po: po ? sumLines(po.lines) : 0 },
  };
}

export function findDuplicate(invoice, paidBills, openBills = []) {
  const key = normalizeInvoiceId(invoice.id);
  const total = sumLines(invoice.lines);
  const candidates = [
    ...paidBills.map((b) => ({ ...b, status: 'paid' })),
    ...openBills.map((b) => ({ id: b.id, amount: b.amount ?? sumLines(b.lines || []), servicePeriod: b.servicePeriod, status: 'open', date: b.date })),
  ];
  for (const b of candidates) {
    if (b.status === 'paid' && b.id === invoice.id) continue;
    const sameNumber = normalizeInvoiceId(b.id) === key;
    const sameAmount = Math.abs(b.amount - total) < 1;
    const samePeriod = invoice.servicePeriod && b.servicePeriod === invoice.servicePeriod;
    if ((sameNumber && sameAmount) || (sameAmount && samePeriod)) {
      return {
        original: b.id, status: b.status, paidOn: b.paidOn || null, paymentRef: b.paymentRef || null, amount: b.amount, servicePeriod: b.servicePeriod,
        signals: [sameNumber && 'same invoice number', sameAmount && 'same amount', samePeriod && 'same service period'].filter(Boolean),
        similarity: sameNumber && sameAmount && samePeriod ? 0.99 : sameNumber && sameAmount ? 0.96 : 0.86,
      };
    }
  }
  return null;
}

export function checkRemittance(invoice, vendor) {
  if (!vendor || !invoice.remitTo?.last4) return null;
  const bankChanged = invoice.remitTo.last4 !== vendor.bank.last4;
  const domainMismatch = !!invoice.senderDomain && invoice.senderDomain !== vendor.domain;
  if (!bankChanged) return null; // A different sender domain alone is logged, not blocked.
  const dist = domainMismatch ? editDistance(invoice.senderDomain.replace(/\.\w+$/, ''), vendor.domain.replace(/\.\w+$/, '')) : 0;
  return {
    bankChanged, domainMismatch,
    onFile: vendor.bank, invoiceBank: invoice.remitTo,
    senderDomain: invoice.senderDomain, onFileDomain: vendor.domain,
    lookalike: domainMismatch && dist > 0 && dist <= 3,
    phoneOnFile: vendor.phone,
  };
}
