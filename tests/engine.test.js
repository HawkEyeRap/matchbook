import { describe, it, expect } from 'vitest';
import { INVOICES, contextFor, VENDORS } from '../src/data/scenarios.js';
import { investigate } from '../src/engine/agent.js';
import { DEFAULT_POLICY, contractPriceOn, findDuplicate } from '../src/engine/match.js';
import { simulateReply, verifyReply } from '../src/engine/resolve.js';
import { bm25, buildCorpus } from '../src/engine/retrieval.js';
import { allowedTokens, checkGrounding } from '../src/engine/guard.js';
import { normalizeInvoiceId, parseTerms, editDistance } from '../src/engine/util.js';

const run = (id, policy = DEFAULT_POLICY, patch) => {
  const inv = structuredClone(INVOICES.find((i) => i.id === id));
  if (patch) patch(inv);
  return investigate(contextFor(inv), policy);
};

describe('scenario outcomes', () => {
  const expected = {
    'NWP-30917': ['PRICE_OVER_CONTRACT', 'credit_memo', 1000],
    'SLS-118204': ['QTY_OVER_RECEIPT', 'corrected_invoice', 740],
    'BAV-5521': ['MISSING_RECEIPT', 'confirm_receipt', 0],
    'RW10388-A': ['DUPLICATE', 'reject_duplicate', 0],
    'FIF-60233': ['PO_PRICE_STALE', 'amend_po', 0],
    'AF-77310': ['UNPLANNED_CHARGE', 'credit_memo', 1381],
    'MPC-2093': ['BANK_MISMATCH', 'fraud_hold', 0],
    'CFS-4410': ['MISSING_DOCS', 'request_docs', 0],
  };
  for (const [id, [code, type, disputed]] of Object.entries(expected)) {
    it(`${id} → ${type}`, () => {
      const r = run(id);
      expect(r.primary.code).toBe(code);
      expect(r.plan.type).toBe(type);
      expect(r.plan.disputed).toBeCloseTo(disputed, 2);
      expect(r.plan.approvals.length).toBeGreaterThan(0);
    });
  }
});

describe('matching rules', () => {
  it('applies a contract escalation only with valid notice', () => {
    const r = run('FIF-60233');
    expect(r.match.lines[0].contract.escalated).toBe(true);
    expect(r.match.lines[0].contract.price).toBeCloseTo(0.884, 4);
  });

  it('turns a valid price change into a dispute when notice was too short', () => {
    const ctx = contextFor(INVOICES.find((i) => i.id === 'FIF-60233'));
    const contract = structuredClone(ctx.contract);
    contract.prices['HEX-M10'].escalation.noticeDate = '2026-09-20'; // 11 days notice
    const cp = contractPriceOn(contract, 'HEX-M10', '2026-11-01');
    expect(cp.escalated).toBe(false);
    expect(cp.escalation.rejected).toBe(true);
  });

  it('respects the price tolerance policy', () => {
    const loose = { ...DEFAULT_POLICY, priceTolerancePct: 10, priceToleranceAbs: 2000 };
    const r = run('NWP-30917', loose);
    expect(r.plan.type).toBe('clear');
  });

  it('a sandbox edit changes the outcome: correct the price and the bill clears', () => {
    const r = run('NWP-30917', DEFAULT_POLICY, (inv) => { inv.lines[0].unitPrice = 4.2; });
    expect(r.findings).toHaveLength(0);
    expect(r.plan.type).toBe('clear');
    expect(r.plan.payable).toBeCloseTo(10920, 2);
  });

  it('combines price and quantity problems into one corrected-invoice request', () => {
    const r = run('NWP-30917', DEFAULT_POLICY, (inv) => { inv.lines[1].qty = 260; });
    expect(r.plan.type).toBe('corrected_invoice');
    // 60 extra rolls of tape are over both PO and receipt; counted once, not twice.
    expect(r.plan.disputed).toBeCloseTo(1000 + 60 * 2.1, 2);
  });

  it('resolves a transposed PO number', () => {
    const r = run('NWP-30917', DEFAULT_POLICY, (inv) => { inv.poRef = 'PO-4147'; });
    expect(r.ctx.po.id).toBe('PO-4417');
    expect(r.findings.some((f) => f.code === 'PO_REF_TYPO')).toBe(true);
  });

  it('flags a bank change even when everything else matches', () => {
    const r = run('NWP-30917', DEFAULT_POLICY, (inv) => { inv.lines[0].unitPrice = 4.2; inv.remitTo = { name: 'Other Bank', last4: '9999' }; });
    expect(r.plan.type).toBe('fraud_hold');
    expect(r.plan.payable).toBe(0);
  });

  it('routes large disputes to the Controller', () => {
    const r = run('NWP-30917', DEFAULT_POLICY, (inv) => { inv.lines[0].unitPrice = 7.0; });
    expect(r.plan.approvals.map((a) => a.key)).toContain('controller');
  });

  it('captures the early-payment discount on the undisputed amount', () => {
    const r = run('NWP-30917');
    expect(r.plan.discount.amount).toBeCloseTo(10920 * 0.02, 2);
  });
});

describe('duplicates and helpers', () => {
  it('normalizes invoice numbers', () => {
    expect(normalizeInvoiceId('RW10388-A')).toBe(normalizeInvoiceId('rw-10388'));
    expect(normalizeInvoiceId('INV 2041 REV')).toBe('INV2041');
  });
  it('detects duplicates by period and amount', () => {
    const d = findDuplicate({ id: 'X-1', lines: [{ qty: 1, unitPrice: 12400 }], servicePeriod: 'Sep 2026' }, [{ id: 'RW-10241', amount: 12400, servicePeriod: 'Sep 2026', paidOn: '2026-09-29', paymentRef: 'ACH-54870' }]);
    expect(d.original).toBe('RW-10241');
  });
  it('parses payment terms', () => {
    expect(parseTerms('2/10 Net 30')).toEqual({ discountPct: 2, discountDays: 10, netDays: 30 });
    expect(parseTerms('Net 45').netDays).toBe(45);
  });
  it('measures transpositions as one edit', () => {
    expect(editDistance('PO-4417', 'PO-4147')).toBe(1);
  });
});

describe('retrieval', () => {
  it('ranks the fixed-pricing clause first for a price dispute', () => {
    const ctx = contextFor(INVOICES[0]);
    const hits = bm25(buildCorpus(ctx), 'fixed unit prices term increase price adjustment notice acceptance list price');
    expect(['§3.1', '§3.4']).toContain(hits[0].ref);
  });
});

describe('verification', () => {
  it('releases payment only when the credit memo amount matches', () => {
    const r = run('NWP-30917');
    const reply = simulateReply(r.plan, r.ctx);
    expect(verifyReply(r.plan, reply, r.ctx).release.amount).toBeCloseTo(10920, 2);
    reply.artifact.amount = 500;
    const v = verifyReply(r.plan, reply, r.ctx);
    expect(v.ok).toBe(false);
    expect(v.release).toBeNull();
  });
  it('never releases payment for a voided duplicate', () => {
    const r = run('RW10388-A');
    expect(verifyReply(r.plan, simulateReply(r.plan, r.ctx), r.ctx).release).toBeNull();
  });
});

describe('grounding guard', () => {
  const facts = 'Invoice NWP-30917 $11,920.00, contract $4.20, billed $4.60, credit $1,000.00, PO-4417, +9.5%';
  const allowed = allowedTokens(facts);
  it('passes text that only reuses known figures', () => {
    expect(checkGrounding('Please credit $1,000.00 on NWP-30917 (PO-4417).', allowed).ok).toBe(true);
  });
  it('flags a hallucinated amount or document', () => {
    const r = checkGrounding('Please credit $1,200.00 against CM-9999.', allowed);
    expect(r.ok).toBe(false);
    expect(r.unknown.map((u) => u.value)).toEqual(expect.arrayContaining(['$1,200.00', 'CM-9999']));
  });
  it('vendor master is never mutated by the agent', () => {
    run('MPC-2093');
    expect(VENDORS['V-MPC'].bank.last4).toBe('2290');
  });
});
