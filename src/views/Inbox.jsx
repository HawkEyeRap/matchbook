import React, { useRef, useState } from 'react';
import { CountUp, StatusMark, WORDS } from '../ui/marks.jsx';
import { STATUS_GROUP } from '../store.js';
import { FINDING_META } from '../engine/resolve.js';
import { money, round2, fmtDate } from '../engine/util.js';
import { SAMPLE_FILES } from '../data/sampleFiles.js';
import { ingestFile, b64ToBytes } from '../ingest/index.js';
import { routeResults } from '../ingest/route.js';

const whole = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const GROUPS = [
  { key: 'you', label: 'Needs you', bg: 'var(--hatch)' },
  { key: 'work', label: 'In progress', bg: 'var(--muted)' },
  { key: 'open', label: 'Not started', bg: 'var(--hair)' },
  { key: 'done', label: 'Closed', bg: 'var(--ink)' },
];
const inFrame = (() => { try { return window.self !== window.top; } catch { return true; } })();

export default function Inbox({ cases, analyses, dispatch, policy, go, toast, intake, setIntake, detail }) {
  const open = cases.filter((c) => !['resolved', 'escalated', 'rejected'].includes(c.status));
  const atStake = round2(open.reduce((s, c) => s + analyses[c.id].plan.atStake, 0));
  const discounts = open.map((c) => analyses[c.id].plan.discount).filter(Boolean);
  const discountAmt = round2(discounts.reduce((s, d) => s + d.amount, 0));
  const recovered = round2(cases.filter((c) => c.status === 'resolved').reduce((s, c) => {
    const p = analyses[c.id].plan;
    return s + (p.isDispute ? p.atStake : p.type === 'fraud_hold' ? p.total : 0) + (c.verification?.release?.discount || 0);
  }, 0));
  const counts = cases.reduce((m, c) => ({ ...m, [STATUS_GROUP[c.status]]: (m[STATUS_GROUP[c.status]] || 0) + 1 }), {});
  const flagged = cases.filter((c) => c.flag).length;
  const swept = cases.filter((c) => !c.flag).length;
  const maxStake = Math.max(1, ...cases.map((c) => analyses[c.id].plan.atStake));
  const allClosed = cases.length && !open.length;

  return (
    <>
      <section className="hero" data-tour="hero">
        <h1 className="rise">
          {allClosed ? <>Every exception is <em>closed.</em></> : <>Ramp caught {WORDS[flagged] ?? flagged} exceptions.<br />Matchbook <em>closes</em> them.</>}
        </h1>
        <p className="sub">
          Bills that Bill Pay’s 3-way match blocked{swept ? `, plus ${WORDS[swept] ?? swept} it couldn’t see` : ''}. Matchbook finds the root cause, drafts the fix, and follows up until the bill is paid. You approve every action.
        </p>
      </section>

      <section className="stake" data-tour="stake">
        <div>
          <div className="label">Variance at stake</div>
          <div className="big"><CountUp value={atStake} format={whole} /></div>
          <div className="notes">
            {recovered > 0 && <span>✓ {money(recovered)} recovered or protected so far</span>}
            {discountAmt > 0 && <span className="muted">{money(discountAmt)} in early-payment discounts expire by {fmtDate(discounts.map((d) => d.deadline).sort()[0])}</span>}
          </div>
        </div>
        <div>
          <div className="label" style={{ marginBottom: 16 }}>Queue by status</div>
          <div className="qbar">{GROUPS.filter((g) => counts[g.key]).map((g) => <i key={g.key} title={`${counts[g.key]} ${g.label.toLowerCase()}`} style={{ width: `${(counts[g.key] / cases.length) * 100}%`, background: g.bg }} />)}</div>
          <div className="qlegend">{GROUPS.map((g) => <div key={g.key}><span className="sw" style={{ background: g.bg }} /><b className="tab">{counts[g.key] || 0}</b>{g.label}</div>)}</div>
        </div>
      </section>

      <Intake cases={cases} dispatch={dispatch} policy={policy} go={go} toast={toast} rows={intake} setRows={setIntake} />

      <section className="ledger">
        <div className="lhead">
          {['Case', 'Vendor', 'Issue', 'Bill', 'At stake', 'Status', ''].map((h, i) => <div key={i} className={`label ${i === 3 || i === 4 ? 'r' : ''}`}>{h}</div>)}
        </div>
        <ul data-tour="queue">
          {cases.map((c, i) => {
            const a = analyses[c.id];
            const diagnosed = !['new', 'investigating'].includes(c.status);
            const meta = a.primary ? FINDING_META[a.primary.code] : null;
            const stake = a.plan.atStake;
            return (
              <li key={c.id} className="rise" style={{ animationDelay: `${0.1 + i * 0.04}s` }}>
                <a className="lrow" href={`#case-${c.id}`} onClick={(e) => { e.preventDefault(); go(`case-${c.id}`); }}>
                  <div className="c-id mono" style={{ fontSize: 11, color: 'var(--muted)' }}>{c.id}</div>
                  <div className="c-v" style={{ minWidth: 0 }}>
                    <div className="vend">{a.ctx.vendor.name}</div>
                    <div className="sub">{c.invoice.id} · {c.invoice.date}{c.source === 'upload' ? ` · ${c.invoice.fileName || 'uploaded'}` : ''}</div>
                  </div>
                  <div className="c-issue issue">
                    {diagnosed && meta ? <span className="tag on">{meta.label}</span> : c.flag ? <span className="tag">{shortFlag(c.flag)}</span> : <span className="tag redline">Price vs contract</span>}
                    <span className="muted" style={{ fontSize: 12.5 }}>{diagnosed ? a.plan.label.toLowerCase() : c.flag ? 'flagged by Bill Pay' : 'missed by 3-way match'}</span>
                    {detail === 'detailed' && <span style={{ flexBasis: '100%', fontSize: 12.5 }}>{c.flag || 'Invoice and PO agree, so 3-way match passed; the PO price is above the agreement.'}</span>}
                  </div>
                  <div className="c-amt amt r tab">{money(a.match.totals.invoice)}</div>
                  <div className="c-var r">
                    {stake ? <span className={`var tab ${c.status === 'new' ? 'faint' : ''}`}>{money(stake)}</span> : <span className="label">no dispute</span>}
                    <div className="mag"><i className={c.status === 'new' ? 'off' : ''} style={{ width: `${stake ? Math.max(1.5, (stake / maxStake) * 100) : 0}%` }} /></div>
                  </div>
                  <div className="c-st"><StatusMark status={c.status} /></div>
                  <div className="go" aria-hidden="true">→</div>
                </a>
              </li>
            );
          })}
        </ul>
      </section>

      <footer className="foot">
        <p>Ramp catches it. Matchbook closes it.</p>
        <p className="label">Fictional vendors and figures · demo data</p>
      </footer>
    </>
  );
}

function shortFlag(f) {
  if (/price/i.test(f)) return 'Price';
  if (/received/i.test(f)) return 'Not received';
  if (/duplicate/i.test(f)) return 'Duplicate';
  if (/remit|bank/i.test(f)) return 'Remit-to';
  if (/not on/i.test(f)) return 'Off-PO line';
  if (/attachment/i.test(f)) return 'Attachment';
  if (/quantity/i.test(f)) return 'Quantity';
  if (/PO .* not found/i.test(f)) return 'PO';
  return 'Flagged';
}

function Intake({ cases, dispatch, policy, go, toast, rows, setRows }) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showSamples, setShowSamples] = useState(true);
  const input = useRef(null);
  const live = useRef(cases); live.current = cases;

  const handle = async (files) => {
    if (!files.length) return;
    setBusy(true);
    try {
      const parsed = [];
      for (const f of files) parsed.push(...(await ingestFile(f)));
      const { actions, rows: out } = routeResults(parsed, { cases: live.current, policy });
      actions.forEach((a) => dispatch(a));
      setRows((r) => [...out.map((x) => ({ ...x, key: Math.random() })), ...r].slice(0, 30));
      const ex = out.filter((x) => x.status === 'exception').length;
      const ok = out.filter((x) => x.status === 'clean').length;
      const rep = out.filter((x) => x.status.startsWith('reply')).length;
      toast([ex && `${ex} exception${ex > 1 ? 's' : ''} added`, ok && `${ok} clean`, rep && `${rep} repl${rep > 1 ? 'ies' : 'y'} checked`].filter(Boolean).join(' · ') || 'Done');
    } finally { setBusy(false); }
  };
  const runSample = (s) => handle([{ name: s.name, bytes: b64ToBytes(s.b64) }]);
  const runAll = () => handle(SAMPLE_FILES.filter((s) => s.kind === 'invoice').map((s) => ({ name: s.name, bytes: b64ToBytes(s.b64) })));

  return (
    <section
      className={`intake ${over ? 'over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); handle([...e.dataTransfer.files]); }}
    >
      <div className="intake-head" data-tour="intake">
        <div className="t">
          <b>Add bills</b>
          <span>Drop invoice PDFs, a CSV export, or a vendor’s reply. Each file is read, matched to its PO, receipt, and agreement, and investigated. Nothing here is pre-scripted.</span>
        </div>
        <input ref={input} type="file" multiple hidden accept=".pdf,.csv,.json,.txt" onChange={(e) => { handle([...e.target.files]); e.target.value = ''; }} />
        <button className="btn dark" onClick={() => input.current?.click()} disabled={busy}>{busy ? 'Reading…' : 'Choose files'}</button>
        <button className="btn ghost" onClick={() => setShowSamples((v) => !v)} aria-expanded={showSamples}>{showSamples ? 'Hide samples' : 'Try a sample'}</button>
      </div>
      {showSamples && (
        <div className="samples">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <span className="label">Sample files · the same files are in the repo’s /samples folder</span>
            <button className="btn primary sm" onClick={runAll} disabled={busy}>Run all 8 invoice files <span className="arr">→</span></button>
          </div>
          <div className="sample-grid">
            {SAMPLE_FILES.map((s) => (
              <div key={s.name} className="sample">
                <span className="n">{s.name}<span className="kind-tag">{s.kind === 'reply' ? 'vendor reply' : s.mime.includes('csv') ? 'csv' : 'pdf'}</span></span>
                <span className="d">{s.title}</span>
                <span className="e">{s.expect}</span>
                <span className="acts">
                  {!inFrame && <a className="btn ghost sm" href={`data:${s.mime};base64,${s.b64}`} download={s.name}>Save</a>}
                  <button className="btn dark sm" onClick={() => runSample(s)} disabled={busy}>Run</button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {rows.length > 0 && (
        <div className="results" aria-live="polite">
          {rows.map((r) => (
            <div key={r.key} className="result">
              <span className={`g ${['exception', 'reply-fail', 'error'].includes(r.status) ? 'red' : ''}`}>{{ exception: '●', clean: '✓', 'reply-ok': '✓', 'reply-fail': '✗', early: '…', error: '!' }[r.status]}</span>
              <div style={{ minWidth: 0 }}>
                <b>{r.title}</b>
                <div className="det">{r.detail}</div>
                {r.warnings?.length > 0 && <div className="det red">{r.warnings.join(' ')}</div>}
                <div className="fn">{r.fileName}</div>
              </div>
              {r.caseId ? <button className="btn ghost sm" onClick={() => go(`case-${r.caseId}`)}>Open <span className="arr">→</span></button> : <span />}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
