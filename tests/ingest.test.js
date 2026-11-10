import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ingestFile } from '../src/ingest/index.js';
import { routeResults } from '../src/ingest/route.js';
import { runEvals } from '../src/engine/evals.js';
import { initialCases, reducer } from '../src/store.js';
import { DEFAULT_POLICY } from '../src/engine/match.js';

const DIR = join(__dirname, '..', 'samples');
const read = (name) => ingestFile({ name, bytes: new Uint8Array(readFileSync(join(DIR, name))) });

describe('sample files on disk', () => {
  it('ships every sample the app offers', () => {
    const files = readdirSync(DIR);
    for (const f of ['northwind-NWP-31244.pdf', 'summit-lab-SLS-118391.pdf', 'alder-finch-AF-77402.pdf', 'meridian-print-MPC-2117.pdf', 'redwood-RW-10241-R.pdf', 'ferro-FIF-60318.pdf', 'brightline-BAV-5560.pdf', 'ramp-bill-export.csv', 'northwind-credit-memo-CM-4917.pdf', 'northwind-credit-memo-CM-4918-short.pdf', 'summit-lab-corrected-SLS-118204-R.pdf']) {
      expect(files).toContain(f);
    }
  });

  it('reads fields and line items from a PDF invoice', async () => {
    const [r] = await read('northwind-NWP-31244.pdf');
    expect(r.kind).toBe('invoice');
    expect(r.invoice).toMatchObject({ id: 'NWP-31244', vendorId: 'V-NWP', poRef: 'PO-4502', date: '2026-11-06', terms: '2/10 Net 30' });
    expect(r.invoice.lines[0]).toMatchObject({ sku: 'BOX-1294', unitPrice: 4.6 });
  }, 20000);

  it('reads a credit memo as a reply, not a bill', async () => {
    const [r] = await read('northwind-credit-memo-CM-4917.pdf');
    expect(r.kind).toBe('credit_memo');
    expect(r.artifact).toMatchObject({ id: 'CM-4917', ref: 'NWP-30917', amount: 1000 });
  }, 20000);

  it('routes uploads: exceptions join the queue, clean bills pass', async () => {
    const parsed = [...(await read('summit-lab-SLS-118391.pdf')), ...(await read('northwind-NWP-31244.pdf'))];
    const { actions, rows } = routeResults(parsed, { cases: initialCases(DEFAULT_POLICY), policy: DEFAULT_POLICY });
    expect(rows.map((r) => r.status)).toEqual(['clean', 'exception']);
    expect(actions.filter((a) => a.type === 'ADD')).toHaveLength(1);
  }, 20000);

  it('a short credit memo keeps the case open; the right one closes it', async () => {
    let cases = initialCases(DEFAULT_POLICY);
    const id = 'NWP-30917';
    const { analyze } = await import('../src/store.js');
    cases = reducer(cases, { type: 'START', id });
    let a = analyze(cases.find((c) => c.id === id), DEFAULT_POLICY, cases);
    cases = reducer(cases, { type: 'TRACE_DONE', id, a });
    a = analyze(cases.find((c) => c.id === id), DEFAULT_POLICY, cases);
    cases = reducer(cases, { type: 'APPROVE', id, key: 'ap', by: 'Dana', role: 'AP Specialist', a });
    expect(cases.find((c) => c.id === id).status).toBe('waiting');

    const short = routeResults(await read('northwind-credit-memo-CM-4918-short.pdf'), { cases, policy: DEFAULT_POLICY });
    expect(short.rows[0].status).toBe('reply-fail');
    const after = short.actions.reduce(reducer, cases);
    expect(after.find((c) => c.id === id).status).not.toBe('resolved');

    const good = routeResults(await read('northwind-credit-memo-CM-4917.pdf'), { cases, policy: DEFAULT_POLICY });
    expect(good.rows[0].status).toBe('reply-ok');
    const done = good.actions.reduce(reducer, cases);
    expect(done.find((c) => c.id === id).status).toBe('resolved');
  }, 20000);
});

describe('scorecard', () => {
  it('passes all 22 graded cases', async () => {
    const { rows, metrics } = await runEvals({ ingest: read });
    const failed = rows.filter((r) => !r.pass).map((r) => `${r.key}: ${JSON.stringify(r.checks)}`);
    expect(failed).toEqual([]);
    expect(metrics.total).toBe(22);
    expect(metrics.falseDispute).toBe(0);
  }, 60000);
});
