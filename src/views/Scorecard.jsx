import React, { useEffect, useRef, useState } from 'react';
import { runEvals, EVAL_CASES } from '../engine/evals.js';
import { FINDING_META, RESOLUTION_LABEL } from '../engine/resolve.js';
import { SAMPLE_FILES } from '../data/sampleFiles.js';
import { ingestFile, b64ToBytes } from '../ingest/index.js';
import { money } from '../engine/util.js';

const ingest = (name) => {
  const s = SAMPLE_FILES.find((f) => f.name === name);
  if (!s) return Promise.resolve([{ kind: 'error', error: `Missing sample ${name}` }]);
  return ingestFile({ name, bytes: b64ToBytes(s.b64) });
};

const CHECK_LABEL = {
  root: 'root cause', resolution: 'resolution', amount: 'amount', noFalseDispute: 'no false dispute', citations: 'citations',
  draftsTraced: 'drafts traced', guardrail: 'injection ignored', parsed: 'parsed', verified: 'verdict', paymentGate: 'payment gate', ran: 'ran',
};
const pct = (x) => `${Math.round(x * 100)}%`;

export default function Scorecard({ policy, detail }) {
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ms, setMs] = useState(0);
  const alive = useRef(true);

  const run = async () => {
    setBusy(true);
    const t0 = performance.now();
    const out = await runEvals({ ingest, policy });
    if (!alive.current) return;
    setMs(performance.now() - t0);
    setRes(out);
    setBusy(false);
  };
  useEffect(() => { alive.current = true; run(); return () => { alive.current = false; }; }, [policy]); // eslint-disable-line

  const m = res?.metrics;
  const tiles = m ? [
    ['Cases passed', `${m.passed}/${m.total}`, m.passed === m.total ? '' : 'red', 'every check on every case'],
    ['Root cause', pct(m.rootCause), m.rootCause < 1 ? 'red' : '', 'matched an AP specialist'],
    ['Dollar amount', pct(m.amount), m.amount < 1 ? 'red' : '', 'to the cent'],
    ['False disputes', pct(m.falseDispute), m.falseDispute > 0 ? 'red' : '', 'vendor wrongly accused'],
    ['Fields read', pct(m.extraction), m.extraction < 1 ? 'red' : '', 'from PDFs and CSV'],
    ['Replies judged', pct(m.replies), m.replies < 1 ? 'red' : '', 'credit memos and corrections'],
  ] : EVAL_CASES.slice(0, 6).map((_, i) => [['Cases passed', 'Root cause', 'Dollar amount', 'False disputes', 'Fields read', 'Replies judged'][i], '…', 'faint', 'running']);

  return (
    <>
      <section className="page-h">
        <h1>Graded, <em>not</em> vibes.</h1>
        <p>
          {EVAL_CASES.length} cases with the answer a careful AP specialist would give: the ten bills in the queue, eight sample files parsed from scratch, and three vendor replies.
          Each one checks the root cause, the resolution, the dollar amount to the cent, whether it accused a vendor who was right, whether the evidence cites the right clause, and whether every number in every draft traces back to the books.
          It reruns live whenever you change a rule in Settings, and the same suite runs in CI with <code className="mono">npm test</code>.
        </p>
      </section>

      <section className="metrics" aria-live="polite">
        {tiles.map(([k, v, cls, s]) => (
          <div key={k}><div className="label">{k}</div><div className={`v ${cls}`}>{v}</div><div className="s">{s}</div></div>
        ))}
      </section>
      <div style={{ marginTop: 16, display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn dark sm" onClick={run} disabled={busy}>{busy ? 'Running…' : 'Run again'}</button>
        <span className="label">{res ? `${res.rows.length} cases · ${Math.round(ms)}ms in your browser · same code as the queue` : 'Parsing sample files…'}</span>
      </div>

      <section className="sc">
        <table>
          <thead>
            <tr><th style={{ width: 34 }}>#</th><th>Case</th><th>Expected</th><th>Matchbook</th><th>Checks</th><th style={{ textAlign: 'right' }}>Result</th></tr>
          </thead>
          <tbody>
            {(res?.rows || []).map((r) => (
              <tr key={r.key}>
                <td className="m mono">{String(r.n).padStart(2, '0')}</td>
                <td>
                  <div className="t">{r.title}</div>
                  <div className="m">{r.answers ? `${r.file} → answers ${r.answers}` : r.file ? `${r.file}${r.bill ? ` · ${r.bill}` : ''}` : `${r.bill} · seeded bill`}</div>
                </td>
                <td>{r.answers ? <span>{r.expect.verified ? 'Accept, release payment' : 'Reject, ask again'}</span> : <Expect e={r.expect} />}</td>
                <td>{r.got.error ? <span className="red">{r.got.error}</span> : r.answers ? <span>{r.got.verified ? 'Accepted' : 'Rejected'} · {money(r.got.amount)}{r.got.release ? ` · releases ${money(r.got.release)}` : ''}</span> : <Got g={r.got} />}</td>
                <td><div className="cks">{Object.entries(r.checks).filter(([k]) => detail === 'detailed' || !k.startsWith('field:') || !r.checks[k]).map(([k, v]) => <span key={k} className={v ? '' : 'no'}>{v ? '✓' : '✗'} {CHECK_LABEL[k] || k.replace('field:', '')}</span>)}</div></td>
                <td style={{ textAlign: 'right' }}><span className={`ok ${r.pass ? '' : 'no'}`}>{r.pass ? 'PASS' : 'FAIL'}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <p className="fine">Dollar figures are the amount Matchbook would dispute, hold, or change. “No false dispute” fails if Matchbook asks a vendor for money back on a bill that was correct, which is the most expensive mistake an AP agent can make with a supplier.</p>
    </>
  );
}

function Expect({ e }) {
  return (
    <span>
      {e.root === 'CLEAN' ? 'Clean' : FINDING_META[e.root].label}
      <span className="m mono" style={{ display: 'block' }}>{RESOLUTION_LABEL[e.type]}{e.amount ? ` · ${money(e.amount)}` : ''}{e.dispute ? ' · dispute' : ''}</span>
    </span>
  );
}

function Got({ g }) {
  return (
    <span>
      {g.root === 'CLEAN' ? 'Clean' : FINDING_META[g.root]?.label || g.root}
      <span className="m mono" style={{ display: 'block' }}>{RESOLUTION_LABEL[g.type]}{g.amount ? ` · ${money(g.amount)}` : ''}{g.cites?.length ? ` · ${g.cites.filter((c) => c.startsWith('§')).slice(0, 2).join(' ')}` : ''}</span>
    </span>
  );
}
