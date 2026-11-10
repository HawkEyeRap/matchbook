import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PenCircle, PenStrike, Seg, StatusMark } from '../ui/marks.jsx';
import { effectiveAction } from '../store.js';
import { FINDING_META, expectedReply } from '../engine/resolve.js';
import { allowedTokens, checkGrounding, factsText } from '../engine/guard.js';
import { tokenize } from '../engine/retrieval.js';
import { money, num, fmtDate, addDays, round2 } from '../engine/util.js';
import { ingestFile } from '../ingest/index.js';
import { routeResults } from '../ingest/route.js';

const delayFor = (s) => Math.min(900, Math.max(260, s.ms * 0.42));
const PRICE_CODES = new Set(['PRICE_OVER_CONTRACT', 'PO_PRICE_STALE', 'CONTRACT_CONFLICT']);

export default function Case({ c, a, cases, dispatch, policy, go, toast, detail }) {
  const total = a.steps.length;
  const running = c.status === 'investigating';
  const fresh = c.status === 'new';
  const [shown, setShown] = useState(fresh || running ? 0 : total);
  const aRef = useRef(a); aRef.current = a;
  const statusRef = useRef(c.status); statusRef.current = c.status;

  useEffect(() => { if (!fresh && !running) setShown(total); }, [fresh, running, total]);
  useEffect(() => {
    if (!running) return undefined;
    if (shown >= total) { dispatch({ type: 'TRACE_DONE', id: c.id, a }); return undefined; }
    const t = setTimeout(() => setShown((s) => s + 1), delayFor(a.steps[shown]));
    return () => clearTimeout(t);
  }, [shown, running]); // eslint-disable-line
  useEffect(() => () => { if (statusRef.current === 'investigating') dispatch({ type: 'TRACE_DONE', id: c.id, a: aRef.current }); }, []); // eslint-disable-line

  const seen = a.steps.slice(0, shown);
  const has = (tool) => seen.some((s) => s.tool === tool);
  const diagnosed = !fresh && (has('agent.diagnose') || !running);
  const showA = !fresh && (has('match.three_way') || !running);
  const showD = !fresh && !running;
  const after = ['waiting', 'resolved', 'escalated', 'rejected'].includes(c.status);

  return (
    <article>
      <section className="case-top" data-tour="title">
        <div style={{ minWidth: 0 }}>
          <div className="crumbs">
            <a href="#inbox" onClick={(e) => { e.preventDefault(); go('inbox'); }}>← Inbox</a>
            <span className="faint">/</span><span>{c.id}</span><span className="faint">/</span>
            <StatusMark status={c.status} />
          </div>
          <h1 className="rise">{a.ctx.vendor.name}</h1>
          <div className="case-meta">
            <span>{c.invoice.id}</span><span>{c.invoice.date}</span><span>{a.ctx.po?.id || 'no PO'}</span><span className="tab">{money(a.match.totals.invoice)}</span><span>{c.invoice.terms}</span>
          </div>
          <p className="case-flag">
            {c.flag ? <><b>Ramp blocked this bill:</b> {c.flag}.</> : <><span className="r">Not flagged by Ramp:</span> the invoice and PO agree, so 3-way match passed. Matchbook’s contract sweep caught it.</>}
          </p>
        </div>
        <div className="corr-slot">{diagnosed && a.correction && <Correction k={a.correction} resolved={c.status === 'resolved'} />}</div>
      </section>

      <Rail c={c} a={a} shown={shown} />
      <ActionRow c={c} a={a} cases={cases} dispatch={dispatch} policy={policy} toast={toast} running={running} onSkip={() => dispatch({ type: 'TRACE_DONE', id: c.id, a })} />

      <section className="body">
        <div className="trace-col" data-tour="trace">
          <Trace a={a} shown={shown} running={running} detail={detail} fresh={fresh} />
        </div>
        <div style={{ minWidth: 0 }}>
          {fresh && <Placeholder />}
          {showA && <Mismatch a={a} detail={detail} />}
          {showA && a.primary && PRICE_CODES.has(a.primary.code) && a.ctx.contracts.length > 0 && <Agreements a={a} />}
          {diagnosed && <Diagnosis a={a} detail={detail} />}
          {showD && <Fix c={c} a={a} dispatch={dispatch} toast={toast} detail={detail} />}
          {after && <FollowUp c={c} a={a} detail={detail} />}
          {showD && detail === 'detailed' && <Documents c={c} a={a} />}
        </div>
      </section>
    </article>
  );
}

function Correction({ k, resolved }) {
  const long = k.from.length > 7 || k.to.length > 7;
  return (
    <div className={`corr ${long ? 'long' : ''}`}>
      <div className="label lab">{k.label}</div>
      <div className="row">
        <span className="from">{k.from}<PenStrike delay={0.3} /></span>
        <span className="to"><PenCircle delay={0.7} /><span>{k.to}</span></span>
      </div>
      <div className="cap">{resolved ? 'Corrected by Matchbook' : k.caption}</div>
    </div>
  );
}

function Rail({ c, a, shown }) {
  const last = a.plan.type === 'reject_duplicate' ? 'Voided' : 'Paid';
  const labels = ['Flagged', 'Read', 'Diagnosed', 'Drafted', 'Approval', 'Sent', 'Follow-up', last];
  const seen = a.steps.slice(0, shown).map((s) => s.tool);
  let idx = 0;
  if (c.status === 'investigating') idx = seen.includes('agent.diagnose') ? 3 : seen.includes('match.three_way') ? 2 : 1;
  else if (c.status === 'review') idx = 4;
  else if (c.status === 'waiting') idx = 6;
  else if (c.status === 'resolved') idx = 8;
  else if (c.status === 'escalated' || c.status === 'rejected') idx = 5;
  return (
    <>
      <div className="rail" style={{ '--n': 8 }} aria-label="Progress">
        {labels.map((l, i) => <div key={l} className={i < idx ? 'past' : i === idx && idx < 8 && c.status !== 'escalated' && c.status !== 'rejected' ? 'now' : ''}><span>{l}</span></div>)}
      </div>
      {(c.status === 'escalated' || c.status === 'rejected') && <div className="label red" style={{ marginTop: 12 }}>↳ {c.status === 'escalated' ? 'Handed to a person after approval' : 'You took over after approval was offered'}</div>}
    </>
  );
}

function ActionRow({ c, a, cases, dispatch, policy, toast, running, onSkip }) {
  const input = useRef(null);
  const exp = expectedReply(a.plan, a.ctx);
  const upload = async (file) => {
    if (!file) return;
    const parsed = await ingestFile(file);
    const { actions, rows } = routeResults(parsed, { cases, policy });
    actions.forEach((x) => dispatch(x));
    const mine = rows.find((r) => r.caseId === c.id) || rows[0];
    toast(mine ? `${mine.title}: ${mine.detail}` : 'Nothing in that file matched this case.');
  };
  return (
    <div className="actrow">
      {c.status === 'new' && (
        <>
          <button className="btn primary" onClick={() => dispatch({ type: 'START', id: c.id })}>Run Matchbook <span className="arr">→</span></button>
          <span className="hint">Reads the bill, PO, item receipts, and vendor agreements, computes the variance in code, and drafts the fix for your approval.</span>
        </>
      )}
      {running && (<><span className="working"><i className="pulse" />Matchbook is working</span><button className="textbtn" onClick={onSkip}>Skip ahead</button></>)}
      {c.status === 'review' && <a className="ready" href="#fix" onClick={(e) => { e.preventDefault(); document.getElementById('fix')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>● Ready for your approval ↓</a>}
      {c.status === 'waiting' && (
        <>
          <button className="btn dark" onClick={() => dispatch({ type: 'FAST_FORWARD', id: c.id })}>Fast-forward follow-up <span>⟫</span></button>
          {exp && ['credit_memo', 'invoice'].includes(exp.kind) && (
            <>
              <input ref={input} type="file" hidden accept=".pdf,.csv,.json,.txt" onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
              <button className="btn ghost" onClick={() => input.current?.click()}>Upload the vendor’s reply</button>
            </>
          )}
          <span className="hint">Day {c.day}. Waiting for {exp?.text}. Matchbook follows up every {policy.followUpDays} days until it arrives.</span>
        </>
      )}
      {c.status === 'resolved' && <span className="stamp">{a.plan.type === 'reject_duplicate' ? 'Voided · synced to Ramp' : a.plan.type === 'fraud_hold' ? 'Verified · paid · synced' : 'Paid · synced to Ramp'}</span>}
      {c.status === 'escalated' && <div className="handed"><div className="label red">Handed to a person</div><p>{a.ctx.company.controller.name} and Procurement have both agreements and the clause on precedence. The bill stays on hold until they decide.</p></div>}
      {c.status === 'rejected' && <div className="handed"><div className="label red">You took over</div><p>Nothing was sent. The bill stays blocked in Bill Pay with Matchbook’s findings attached.</p></div>}
    </div>
  );
}

function Trace({ a, shown, running, detail, fresh }) {
  const [full, setFull] = useState(detail === 'detailed');
  useEffect(() => setFull(detail === 'detailed'), [detail]);
  const steps = a.steps.slice(0, shown);
  return (
    <div>
      <div className="trace-head">
        <span className="label">Agent trace {running && <i className="pulse" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--red)', display: 'inline-block' }} />}</span>
        <Seg label="Trace view" value={full ? 'full' : 'steps'} options={[['steps', 'Steps'], ['full', 'Full log']]} onChange={(v) => setFull(v === 'full')} />
      </div>
      {fresh && <p className="muted" style={{ marginTop: 14, fontSize: 13.5 }}>Nothing yet. Run Matchbook to start.</p>}
      <ol className="steps">
        {steps.map((s) => (
          <li key={s.id}>
            <span className={`g ${s.tone === 'bad' || s.warn ? 'bad' : ''}`}>{s.glyph}</span>
            <span className="l">{s.label}</span>
            <span className={`v ${s.tone === 'bad' ? 'bad' : ''}`}>{s.value}</span>
            {full && <span className="detail"><span className="tool">{s.tool}</span> <span className="ms">{s.ms}ms</span><br />{s.detail}</span>}
          </li>
        ))}
        {running && shown < a.steps.length && <li><span className="g pending pulse">○</span><span className="l pending">{a.steps[shown].label}…</span><span /></li>}
      </ol>
      {!running && !fresh && <div className="trace-foot">{a.steps.length} steps · {(a.steps.reduce((s, x) => s + x.ms, 0) / 1000).toFixed(1)}s of tool time · append-only audit log</div>}
    </div>
  );
}

function Exhibit({ letter, title, note, children, id, tour }) {
  return (
    <section className="ex" id={id} data-tour={tour}>
      <div className="ex-head"><span className="label">Exhibit {letter} <span className="faint">/</span> {title}</span>{note && <span className="label" style={{ textAlign: 'right' }}>{note}</span>}</div>
      <div className="ex-body">{children}</div>
    </section>
  );
}

function Placeholder() {
  const steps = [
    ['01', 'Read', 'bill, PO, receipts, agreements', 'Ramp API'],
    ['02', 'Compute', 'the exact variance', 'Code'],
    ['03', 'Diagnose', 'root cause, with citations', 'Rules + search'],
    ['04', 'Approve', 'nothing is sent without you', 'You'],
  ];
  return (
    <div className="placeholder">
      <div className="label">What happens next</div>
      <ol>{steps.map(([n, t, s, w], i) => <li key={n}><span className={`n ${i === 3 ? 'y' : ''}`}>{n}</span><b>{t}</b><span>{s}</span><small>{w}</small></li>)}</ol>
    </div>
  );
}

function barParts(a) {
  const p = a.plan; const t = p.total;
  const code = a.primary?.code;
  if (!code) return [{ v: t, cls: 'ok', label: 'matches the PO, receipt, and agreement' }];
  switch (code) {
    case 'PRICE_OVER_CONTRACT': case 'UNPLANNED_CHARGE': case 'QTY_OVER_RECEIPT': case 'QTY_OVER_PO':
      return [{ v: t - p.disputed, cls: 'ok', label: 'matches the PO, receipt, and agreement' }, { v: p.disputed, cls: 'bad', label: code === 'QTY_OVER_RECEIPT' ? 'billed but not delivered' : code === 'UNPLANNED_CHARGE' ? 'not on the PO' : 'overbilled' }];
    case 'PO_PRICE_STALE': return [{ v: t, cls: 'ok', label: 'correct as billed under the agreement' }];
    case 'CONTRACT_CONFLICT': return [{ v: t - a.primary.amount, cls: 'ok', label: 'agrees at the lower price' }, { v: a.primary.amount, cls: 'bad', label: 'depends on which agreement governs' }];
    case 'DUPLICATE': return [{ v: t, cls: 'bad', label: a.primary.detail.status === 'paid' ? 'already paid' : 'already in Bill Pay' }];
    case 'BANK_MISMATCH': return [{ v: t, cls: 'bad', label: 'would go to an unverified account' }];
    case 'MISSING_RECEIPT': return [{ v: t, cls: 'ok', label: 'held until the requester confirms delivery' }];
    case 'MISSING_DOCS': return [{ v: t, cls: 'ok', label: 'held until the signed report arrives' }];
    default: return [{ v: t, cls: 'ok', label: 'on hold' }];
  }
}

function Mismatch({ a, detail }) {
  const f = a.formula;
  const parts = barParts(a).filter((x) => x.v > 0.004);
  return (
    <Exhibit letter="A" title="The mismatch" note="Computed in code" tour="mismatch">
      {f ? (
        <>
          <div className="formula"><span className="lhs">{f.lhs}</span><span className={`rhs ${f.tone === 'info' ? 'info' : ''}`}>= {f.rhs}</span></div>
          {f.note && <p className="fnote">{f.note}</p>}
        </>
      ) : <p className="serif" style={{ fontSize: 32 }}>Clean. Nothing to dispute.</p>}
      <div className="billbar">
        <div className="bar">{parts.map((p, i) => <i key={i} className={`${p.cls} grow-x`} style={{ width: `${(p.v / a.plan.total) * 100}%`, animationDelay: `${i * 0.6}s`, ...(p.label.startsWith('held') ? { background: 'var(--muted)' } : {}) }} />)}</div>
        <div className="leg">{parts.map((p, i) => <span key={i}><span className="sw" style={{ background: p.cls === 'bad' ? 'var(--hatch)' : p.label.startsWith('held') ? 'var(--muted)' : 'var(--ink)' }} /><b className="tab">{money(p.v)}</b>{p.label}</span>)}</div>
      </div>
      <MatchGrid a={a} />
      {detail === 'detailed' && (
        <div style={{ marginTop: 28, borderTop: '1px dashed var(--hair)', paddingTop: 18 }}>
          <div className="label" style={{ marginBottom: 10 }}>Engine findings</div>
          <ul style={{ display: 'grid', gap: 10 }}>
            {a.findings.map((x, i) => (
              <li key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 200px) minmax(0, 1fr)', gap: 12 }}>
                <span className="mono" style={{ fontSize: 11, color: FINDING_META[x.code].tone === 'info' ? 'var(--ink)' : 'var(--red)' }}>{FINDING_META[x.code].code}</span>
                <span style={{ fontSize: 13.5 }}>{FINDING_META[x.code].label}{x.amount ? ` · ${money(x.amount)}` : ''}{x.detail?.sku ? ` · ${x.detail.sku}` : ''}</span>
              </li>
            ))}
            {a.guardrails.map((g, i) => <li key={`g${i}`} className="mono red" style={{ fontSize: 11 }}>VENDOR_TEXT_INSTRUCTION · ignored and logged</li>)}
          </ul>
        </div>
      )}
    </Exhibit>
  );
}

function Cell({ v, n, s = 'ok' }) {
  return (
    <div className={`cell ${s}`}>
      <div className="v">{s === 'bad' && <small>✗</small>}{s === 'ok' && v !== '' && <small className="ok">✓</small>}{v}</div>
      {n && <div className="n">{n}</div>}
    </div>
  );
}

function MatchGrid({ a }) {
  const { match, ctx } = a;
  const cols = [['Invoice', ctx.invoice.id], ['Purchase order', ctx.po?.id || '—'], ['Item receipt', ctx.receipt?.id || (ctx.po?.service ? 'service' : 'none')], ['Agreement', ctx.contracts.map((c) => c.id).join(' · ') || '—']];
  return (
    <div className="grid4">
      <div className="in">
        <div className="g4row g4head"><div />{cols.map(([k, id]) => <div key={k}><div className="label">{k}</div><div className="id">{id}</div></div>)}</div>
        {match.lines.map((l) => {
          const conflict = l.flags.includes('CONTRACT_CONFLICT');
          const priceBad = l.flags.some((f) => ['PRICE_OVER_CONTRACT', 'UNPLANNED_CHARGE', 'CONTRACT_CONFLICT'].includes(f));
          const stale = l.flags.includes('PO_PRICE_STALE');
          const sweep = a.findings.some((f) => f.lineIdx === l.idx && f.detail?.sweep);
          const short = l.flags.includes('QTY_OVER_RECEIPT') || l.flags.includes('MISSING_RECEIPT');
          const overPo = l.flags.includes('QTY_OVER_PO');
          const ref = l.contract?.price ?? l.po?.unitPrice;
          return (
            <div key={l.idx} className="g4line">
              <div className="what"><b>{l.sku || 'no SKU'}</b><span>{l.desc}</span></div>
              <div className="g4row">
                <div className="label" style={{ paddingLeft: 4 }}>Unit price</div>
                <Cell v={money(l.inv.unitPrice, true)} s={priceBad ? 'bad' : 'ok'} n={priceBad && ref != null && !conflict && l.po ? `+${money(round2((l.inv.unitPrice - ref) * 10000) / 10000, true)} / unit` : !l.po ? 'not on PO' : undefined} />
                {l.po ? <Cell v={money(l.po.unitPrice, true)} s={stale || sweep ? 'bad' : 'ok'} n={stale ? 'stale price' : sweep ? 'above agreement' : undefined} /> : <Cell v="—" s="bad" n="not on PO" />}
                <Cell v="" s="muted" />
                {conflict ? <Cell v={l.prices.map((p) => money(p.price)).join(' / ')} s="bad" n={`${l.prices.length} agreements disagree`} />
                  : l.contract ? <Cell v={money(l.contract.price, true)} s="neutral" n={l.contract.escalated ? `+${l.contract.escalation.pct}% from ${fmtDate(l.contract.escalation.effective)}` : 'governs'} /> : <Cell v="—" s="muted" />}
              </div>
              <div className="g4row">
                <div className="label" style={{ paddingLeft: 4 }}>Quantity</div>
                <Cell v={num(l.inv.qty)} s={short || overPo ? 'bad' : 'ok'} n={l.flags.includes('QTY_OVER_RECEIPT') ? `${num(l.inv.qty - l.received)} more than received` : undefined} />
                {l.po ? <Cell v={num(l.po.qty)} s={overPo ? 'bad' : 'ok'} /> : <Cell v="—" s="bad" n="not on PO" />}
                {l.received != null ? <Cell v={num(l.received)} s={short ? 'bad' : 'ok'} /> : ctx.po?.service || !l.po ? <Cell v="—" s="muted" /> : <Cell v="none" s="bad" n="nothing logged" />}
                <Cell v="" s="muted" />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const t = (s) => new Date(`${s}T00:00:00Z`).getTime();

function Agreements({ a }) {
  const sku = a.primary.detail?.sku || a.match.lines[0]?.sku;
  const inv = a.ctx.invoice.date;
  const po = a.ctx.po?.date;
  const rows = a.ctx.contracts.map((k) => {
    const p = k.prices[sku];
    if (!p) return { k, segs: [] };
    const esc = p.escalation;
    const segs = esc && (a.match.lines.find((l) => l.sku === sku)?.contract?.escalated || a.primary.code === 'PO_PRICE_STALE')
      ? [{ from: k.effective, to: esc.effective, price: p.unitPrice }, { from: esc.effective, to: k.expires, price: Math.round(p.unitPrice * (1 + esc.pct / 100) * 10000) / 10000 }]
      : [{ from: k.effective, to: k.expires, price: p.unitPrice }];
    return { k, segs };
  });
  const dates = [inv, ...(po ? [po] : []), ...a.ctx.contracts.flatMap((k) => [k.effective, k.expires])];
  const lo = Math.min(...dates.map(t)); const hi = Math.max(...dates.map(t));
  const pad = (hi - lo) * 0.03;
  const x = (s) => ((t(s) - lo + pad) / (hi - lo + 2 * pad)) * 100;
  const conflict = a.primary.code === 'CONTRACT_CONFLICT';
  return (
    <Exhibit letter="B" title="Which agreement applied" note={`${a.ctx.contracts.length} in force on ${fmtDate(inv)}`}>
      <div className="tl">
        {rows.map(({ k, segs }) => (
          <div key={k.id} className="tl-row">
            <div className="k">{k.title}<small>{k.id}</small></div>
            <div className="tl-track">
              <div className="line" style={{ left: `${x(k.effective)}%`, width: `${x(k.expires) - x(k.effective)}%` }} />
              {segs.map((s, i) => {
                const live = s.from <= inv && inv <= s.to;
                return <div key={i} className={`seg ${live ? (conflict ? 'bad' : 'live') : 'off'}`} title={`${money(s.price, true)} · ${s.from} → ${s.to}`} style={{ left: `calc(${x(s.from)}% + ${i ? 1 : 0}px)`, width: `calc(${x(s.to) - x(s.from)}% - ${i ? 2 : 0}px)`, animationDelay: `${i * 0.1}s` }}>{money(s.price, true)}</div>;
              })}
              <div className="tl-mark" style={{ left: `${x(inv)}%`, top: -4, bottom: -4 }} />
              {po && <div className="tl-po" style={{ left: `${x(po)}%`, top: -4, bottom: -4 }} />}
            </div>
          </div>
        ))}
        <div className="tl-row" style={{ marginTop: 18 }}>
          <div />
          <div className="tl-track" style={{ height: 18 }}>
            <span className="mono red" style={{ position: 'absolute', left: `${x(inv)}%`, transform: x(inv) > 60 ? 'translateX(-100%)' : 'none', fontSize: 10, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', whiteSpace: 'nowrap', padding: '0 6px' }}>Invoice · {fmtDate(inv)}</span>
            {po && Math.abs(x(po) - x(inv)) > 18 && <span className="mono" style={{ position: 'absolute', left: `${x(po)}%`, transform: x(po) > 60 ? 'translateX(-100%)' : 'none', fontSize: 10, letterSpacing: '.06em', textTransform: 'uppercase', whiteSpace: 'nowrap', padding: '0 6px', color: 'var(--ink-2)' }}>PO · {fmtDate(po)}</span>}
          </div>
        </div>
      </div>
      <div className="tl-legend">
        <span><span className="sw" style={{ background: conflict ? 'var(--hatch)' : 'var(--ink)' }} />{conflict ? 'conflicting prices in force' : 'price in force on the invoice date'}</span>
        <span><span className="sw" style={{ background: 'var(--paper-2)', boxShadow: 'inset 0 0 0 1px var(--hair)' }} />not in force</span>
        <span><span className="sw" style={{ background: 'var(--red)', width: 2 }} />invoice date</span>
        {po && <span><span className="sw" style={{ borderLeft: '1px dashed var(--ink)', width: 2, borderRadius: 0 }} />PO date</span>}
      </div>
    </Exhibit>
  );
}

const SRC = { contract: 'Agreement', credit: 'Past credit', note: 'Note', email: 'Email', tracking: 'Carrier', payment: 'Payment', notice: 'Notice', portal: 'Portal', receipt: 'Receipt' };

function Diagnosis({ a, detail }) {
  const meta = a.primary ? FINDING_META[a.primary.code] : null;
  const hits = [...new Map(a.evidence.flatMap((e) => e.hits.slice(0, 2)).map((h) => [h.id, h])).values()];
  const quotes = hits.filter((h) => h.source === 'contract').slice(0, a.primary?.code === 'CONTRACT_CONFLICT' ? 2 : 1);
  const docs = [['Invoice', a.ctx.invoice.id], a.ctx.po && ['PO', a.ctx.po.id], a.ctx.receipt && ['Receipt', a.ctx.receipt.id]].filter(Boolean);
  return (
    <Exhibit letter="C" title="Diagnosis" tour="diagnosis">
      <div className="dx">
        <div>
          <div className="code">{meta?.code || 'CLEAN'}</div>
          <h3>{meta?.label || 'No exception'}</h3>
          <div className="chips">
            {docs.map(([k, v]) => <span key={v} className="chip"><span>{k}</span>{v}</span>)}
            {hits.slice(0, 4).map((h) => <span key={h.id} className="chip"><span>{SRC[h.source] || h.source}</span>{h.source === 'contract' ? h.ref : h.date || h.ref}</span>)}
          </div>
        </div>
        <div className="why"><b style={{ fontWeight: 400, color: 'var(--ink)' }}>{a.cause.headline}</b> {a.cause.detail}</div>
      </div>
      {a.guardrails.map((g, i) => (
        <div key={i} className="inj">
          <span className="x">!</span>
          <div><div className="label red">Instruction in vendor text · ignored and logged</div><p>“{g.text}”</p></div>
        </div>
      ))}
      {quotes.map((q) => (
        <figure key={q.id} className="quote">
          <blockquote>“<span className="mark">{q.text}</span>”</blockquote>
          <figcaption>{q.origin} · {q.ref} {q.title.replace(/^§[\d.]+\s*/, '')}</figcaption>
        </figure>
      ))}
      {detail === 'detailed' && (
        <div style={{ marginTop: 28, borderTop: '1px dashed var(--hair)', paddingTop: 18 }}>
          <div className="label" style={{ marginBottom: 10 }}>Evidence retrieved (BM25 over agreements and vendor history)</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              {hits.map((h) => (
                <tr key={h.id} style={{ borderBottom: '1px solid var(--hair)', verticalAlign: 'top' }}>
                  <td className="mono muted" style={{ fontSize: 11, padding: '8px 12px 8px 0', whiteSpace: 'nowrap' }}>{SRC[h.source] || h.source} {h.ref}</td>
                  <td style={{ fontSize: 13, padding: '8px 12px 8px 0' }}>{h.text}</td>
                  <td className="mono muted" style={{ fontSize: 11, padding: '8px 0', textAlign: 'right' }}>{h.relevance.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Exhibit>
  );
}

const TOKEN = /(\$\s?\d[\d,]*(?:\.\d+)?|\b(?:[A-Z]{2,4}-?\d{3,6}(?:-[A-Z0-9]+)?|PO-\d{4}|GRN-\d{4}|CM-\d{4})\b|\b\d+(?:\.\d+)?\s?%|••\s?\d{4})/g;

function Highlighted({ text }) {
  const parts = text.split(TOKEN);
  return parts.map((p, i) => (i % 2 ? <span key={i} className="num" title="Filled from the books">{p}</span> : <React.Fragment key={i}>{p}</React.Fragment>));
}

function Letter({ c, a, x, editable, dispatch, allowed }) {
  const [editing, setEditing] = useState(false);
  const eff = x.eff;
  const body = `${eff.subject || ''}\n${eff.body}`;
  const g = checkGrounding(body, allowed);
  const count = (body.match(TOKEN) || []).length;
  const slack = eff.kind !== 'email';
  return (
    <div className={`letter ${slack ? 'slack' : ''}`}>
      <dl>
        <dt>{eff.kind === 'call' ? 'CALL' : slack ? 'SLACK' : 'TO'}</dt><dd>{eff.to}</dd>
        {!slack && <><dt>FROM</dt><dd>{a.ctx.company.apContact.email}</dd></>}
        {eff.subject && <><dt>SUBJECT</dt><dd>{editing ? <input id={`s-${c.id}-${x.i}`} value={eff.subject} onChange={(e) => dispatch({ type: 'EDIT', id: c.id, idx: x.i, patch: { subject: e.target.value, body: eff.body, by: 'Dana' } })} /> : eff.subject}</dd></>}
      </dl>
      <div className="lsep" />
      {editing ? (
        <textarea id={`b-${c.id}-${x.i}`} aria-label="Message" value={eff.body} onChange={(e) => dispatch({ type: 'EDIT', id: c.id, idx: x.i, patch: { body: e.target.value, subject: eff.subject, by: 'Dana' } })} />
      ) : (
        <div className="lbody"><Highlighted text={eff.body} /></div>
      )}
      <div className="ltools">
        {eff.kind === 'call'
          ? <span className="trace-ok">Use only the number on file.</span>
          : g.ok
            ? <span className="trace-ok">✓ Every number traced · {count} from the books · 0 typed by hand</span>
            : <span className="trace-ok bad">✗ Can’t trace {g.unknown.map((u, k) => <code key={k}>{u.value}</code>)} Fix it before approving.</span>}
        {editable && eff.kind !== 'call' && (
          <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {x.raw.tones && <Seg label="Tone" value={eff.editedBy ? '' : eff.tone || 'friendly'} options={Object.keys(x.raw.tones).map((k) => [k, k === 'final' ? 'Final notice' : k[0].toUpperCase() + k.slice(1)])} onChange={(v) => { setEditing(false); dispatch({ type: 'EDIT', id: c.id, idx: x.i, patch: { tone: v, body: undefined, subject: undefined, by: undefined } }); }} />}
            {eff.editedBy && <button className="textbtn" onClick={() => { setEditing(false); dispatch({ type: 'REVERT', id: c.id, idx: x.i }); }}>Revert</button>}
            <button className="textbtn" onClick={() => setEditing((v) => !v)}>{editing ? 'Done editing' : 'Edit'}</button>
          </span>
        )}
      </div>
    </div>
  );
}

function Fix({ c, a, dispatch, toast, detail }) {
  const { plan } = a;
  const editable = c.status === 'review';
  const allowed = useMemo(() => allowedTokens(factsText(a)), [a]);
  const acts = plan.actions.map((raw, i) => ({ raw, i, eff: effectiveAction(c, i, raw) }));
  const msgs = acts.filter((x) => x.eff.kind !== 'ledger');
  const ledger = acts.filter((x) => x.eff.kind === 'ledger');
  const blocked = msgs.some((x) => x.eff.kind !== 'call' && !checkGrounding(`${x.eff.subject || ''}\n${x.eff.body}`, allowed).ok);
  const next = plan.approvals.find((ap) => !c.approvals[ap.key]);
  const isLast = next && next.key === plan.approvals[plan.approvals.length - 1].key;
  const label = !next ? '' : next.key !== 'ap' ? `Approve as ${next.name.split(' ')[0]}` : isLast ? ({ clear: 'Approve & pay', escalate: 'Hand off', amend_po: 'Approve', confirm_receipt: 'Send', fraud_hold: 'Approve hold' }[plan.type] || 'Approve & send') : 'Approve';
  const figs = [];
  if (plan.type === 'fraud_hold') figs.push(['On hold', plan.total, 'bad']);
  else if (plan.type === 'reject_duplicate') figs.push(['Not paid twice', plan.total, 'bad']);
  else if (plan.type === 'escalate') figs.push(['In question', plan.atStake, 'bad']);
  else if (plan.type === 'amend_po') figs.push(['PO change', plan.amendDelta, '']);
  else if (plan.disputed) figs.push(['Disputed', plan.disputed, 'bad']);
  if (!['reject_duplicate', 'escalate', 'fraud_hold'].includes(plan.type)) figs.push([['confirm_receipt', 'request_docs'].includes(plan.type) ? 'Pay once confirmed' : 'Pay now', plan.payable, '']);
  if (plan.discount) figs.push(['Discount kept', plan.discount.amount, '']);

  return (
    <Exhibit letter="D" title="The fix" note={editable ? 'Waiting for your approval' : 'Approved'} id="fix">
      <div data-tour="fix">
        <div className="fix-top"><h3>{plan.label}</h3><span className="label">{Math.round(plan.confidence * 100)}% confidence</span></div>
        <div className="figs">{figs.map(([k, v, cls]) => <div key={k}><span className="label">{k}</span><span className={`v ${cls}`}>{money(v)}</span></div>)}</div>
        {plan.type === 'fraud_hold' && <div className="callout red"><span className="label">Rule</span><span>Matchbook never changes bank details or replies to the sender. It verifies by phone on the number already on file.</span></div>}
        {plan.discount && c.status !== 'resolved' && plan.type !== 'fraud_hold' && <div className="callout"><span className="label">Cash</span><span>Pay {money(plan.payable)} by {fmtDate(plan.discount.deadline)} to keep the {plan.discount.pct}% early-payment discount. The dispute doesn’t have to hold up the rest of the bill.</span></div>}
        {msgs[0] && <Letter key={msgs[0].i} c={c} a={a} x={msgs[0]} editable={editable} dispatch={dispatch} allowed={allowed} />}
      </div>
      {msgs.slice(1).map((x) => <Letter key={x.i} c={c} a={a} x={x} editable={editable} dispatch={dispatch} allowed={allowed} />)}
      {ledger.length > 0 && (
        <ul className="ledger-acts">
          {ledger.map((x) => <li key={x.i}><span className="g">▤</span><div><b>{x.eff.title}</b><span>{x.eff.body}</span></div></li>)}
        </ul>
      )}
      <div className="approve" data-tour="approve">
        <div className="approvers">
          {plan.approvals.map((ap) => {
            const done = !!c.approvals[ap.key] || (!editable && c.status !== 'rejected');
            return <span key={ap.key} className={`who ${done ? 'done' : ''}`}>{ap.name}<span className="label">{ap.role}</span></span>;
          })}
        </div>
        {editable && next && (
          <div className="btns">
            <button className={`btn ${isLast ? 'primary' : 'dark'}`} disabled={blocked} title={blocked ? 'Fix the flagged figures first' : ''}
              onClick={() => { dispatch({ type: 'APPROVE', id: c.id, key: next.key, by: next.name, role: next.role, a }); if (isLast) toast(plan.type === 'escalate' ? 'Handed to the Controller' : plan.type === 'clear' ? 'Payment released' : 'Approved. Matchbook sent it and is tracking the reply.'); }}>
              {label} <span className="arr">→</span>
            </button>
            <button className="btn ghost" onClick={() => { dispatch({ type: 'REJECT', id: c.id, by: a.ctx.company.apContact.name, a }); toast('You took over. Nothing was sent.'); }}>Reject, I’ll handle it</button>
            <span className="note">{next.key !== 'ap' ? `Demo: approve on ${next.name.split(' ')[0]}’s behalf. ` : ''}Nothing leaves the building without your sign-off.</span>
          </div>
        )}
        {(detail === 'detailed' || editable) && plan.approvals.length > 0 && <div className="note">{plan.approvals.map((ap) => `${ap.role}: ${ap.reason}`).join(' · ')}</div>}
      </div>
      {plan.alternatives.length > 0 && (
        <details className="more">
          <summary>Other options Matchbook considered</summary>
          <ul>{plan.alternatives.map((o) => <li key={o.label}><b style={{ fontWeight: 500 }}>{o.label}.</b> {o.text}</li>)}</ul>
        </details>
      )}
    </Exhibit>
  );
}

function FollowUp({ c, a, detail }) {
  const { plan } = a;
  const out = c.events.find((e) => e.kind === 'email' || e.kind === 'slack' || e.kind === 'call' || e.kind === 'escalate');
  const nudges = c.events.filter((e) => e.kind === 'nudge');
  const replyEv = c.reply;
  const maxDay = Math.max(5, c.day + 1);
  const pos = (d) => `${(d / maxDay) * 100}%`;
  const pts = [];
  if (out) pts.push({ d: 0, k: 'out', l: { reject_duplicate: 'Notice sent', fraud_hold: 'Hold placed', escalate: 'Handed off', confirm_receipt: 'Asked requester', amend_po: 'Asked budget owner' }[plan.type] || 'Request sent' });
  nudges.forEach((_, i) => pts.push({ d: plan.followUp ? (i + 1) * plan.followUp.cadenceDays : i + 1, k: 'nudge', l: 'Follow-up' }));
  if (replyEv) pts.push({ d: c.day, k: 'in', l: replyEv.artifact?.type || 'Reply' });
  const v = c.verification;
  return (
    <Exhibit letter="E" title="Follow-up" note={`Simulated day ${c.day}`}>
      {c.status !== 'rejected' && (
        <div className="fu">
          <div className="line" />
          <div className="prog" style={{ width: pos(c.day) }} />
          {Array.from({ length: maxDay + 1 }, (_, i) => <span key={i} className="day" style={{ left: pos(i) }}>D{i}</span>)}
          {pts.map((p, i) => <div key={i} className={`pt ${p.k}`} style={{ left: pos(p.d), animationDelay: `${0.15 + i * 0.2}s` }}><i /><span>{p.l}</span></div>)}
        </div>
      )}
      {replyEv && (
        <div className="reply">
          <q>{replyEv.body}</q>
          {v && <ul className="checks">{v.checks.map((ck, i) => <li key={i} className={ck.ok ? '' : 'bad'}>{ck.ok ? '✓' : '✗'} {ck.text}</li>)}</ul>}
          {v && !v.ok && v.ask && <div className="letter slack" style={{ marginTop: 0 }}><span className="label">Drafted reply to {a.ctx.vendor.contact}</span><div className="lsep" /><div className="lbody">{v.ask}</div></div>}
        </div>
      )}
      {c.status === 'resolved' && v?.release && (
        <div className="paid">
          <span className="big">{money(v.release.amount)}</span>
          <span className="s">paid by {v.release.method} to {a.ctx.vendor.bank.name} {v.release.account}{plan.isDispute && plan.disputed ? ` · ${money(plan.disputed)} recovered` : ''}{v.release.discount ? ` · ${money(v.release.discount)} discount kept` : ''}</span>
        </div>
      )}
      {c.status === 'resolved' && plan.type === 'reject_duplicate' && <div className="paid"><span className="big">{money(plan.total)}</span><span className="s">not paid twice</span></div>}
      {detail === 'detailed' && (
        <div style={{ marginTop: 28 }}>
          <div className="label" style={{ marginBottom: 8 }}>Audit log</div>
          <ul className="log">
            {[...c.events].reverse().map((e, i) => (
              <li key={i}><i className={['flag', 'verify-fail', 'reject', 'escalate'].includes(e.kind) ? 'r' : ''} /><div>{e.title}{e.body && <small>{e.body}</small>}</div><time>{e.t}</time></li>
            ))}
          </ul>
        </div>
      )}
    </Exhibit>
  );
}

function Documents({ c, a }) {
  const { ctx, match } = a;
  const inv = ctx.invoice;
  const bankBad = a.findings.some((f) => f.code === 'BANK_MISMATCH');
  return (
    <Exhibit letter="F" title="Documents on file" note={inv.fileName ? `Parsed from ${inv.fileName}` : 'From Ramp'}>
      <div className="ovx">
        <div className="paper-doc">
          <div className="ph">
            <div><div style={{ fontWeight: 600, fontSize: 15 }}>{ctx.vendor.name}</div><div className="faint" style={{ fontSize: 11.5 }}>{inv.receivedVia}</div></div>
            <div className="serif" style={{ fontSize: 26, letterSpacing: '.08em', color: 'var(--muted)' }}>INVOICE</div>
          </div>
          <div className="ph" style={{ fontFamily: 'var(--f-mono)', fontSize: 11.5 }}>
            <div>No. {inv.id}<br />Date {inv.date}<br />PO {inv.poRef}<br />Terms {inv.terms}</div>
            <div className={bankBad ? 'hl' : ''} style={{ textAlign: 'right' }}>Remit to {inv.remitTo.name} ••{inv.remitTo.last4}{bankBad && <span className="hn">On file: ••{ctx.vendor.bank.last4}</span>}</div>
          </div>
          <table>
            <thead><tr><th>Description</th><th className="r">Qty</th><th className="r">Unit price</th><th className="r">Amount</th></tr></thead>
            <tbody>
              {match.lines.map((l) => {
                const pf = a.findings.find((f) => f.lineIdx === l.idx && ['PRICE_OVER_CONTRACT', 'PO_PRICE_STALE', 'CONTRACT_CONFLICT'].includes(f.code));
                const qf = a.findings.find((f) => f.lineIdx === l.idx && ['QTY_OVER_RECEIPT', 'QTY_OVER_PO'].includes(f.code));
                const lf = a.findings.find((f) => f.lineIdx === l.idx && f.code === 'UNPLANNED_CHARGE');
                return (
                  <tr key={l.idx}>
                    <td className={lf ? 'hl' : ''}>{l.desc}{lf && <span className="hn">Not on {ctx.po?.id}</span>}</td>
                    <td className={`r ${qf ? 'hl' : ''}`}>{num(l.inv.qty)}{qf && <span className="hn">{qf.code === 'QTY_OVER_RECEIPT' ? `received ${num(qf.detail.received)}` : `ordered ${num(qf.detail.ordered)}`}</span>}</td>
                    <td className={`r ${pf ? 'hl' : ''}`}>{money(l.inv.unitPrice, true)}{pf && pf.code !== 'CONTRACT_CONFLICT' && <span className="hn">{pf.code === 'PO_PRICE_STALE' ? `PO ${money(pf.detail.poPrice, true)}` : `agreement ${money(pf.detail.contractPrice, true)}`}</span>}</td>
                    <td className="r">{money(l.inv.total)}</td>
                  </tr>
                );
              })}
              <tr><td colSpan={3} className="r" style={{ fontWeight: 600, borderBottom: 0 }}>Total due</td><td className="r" style={{ fontWeight: 600, borderBottom: 0 }}>{money(match.totals.invoice)}</td></tr>
            </tbody>
          </table>
          {inv.notes && <p style={{ marginTop: 12, fontSize: 11.5 }} className="hl">Notes: {inv.notes}</p>}
        </div>
      </div>
      <ul className="docs-list" style={{ marginTop: 18 }}>
        {ctx.po && <li><b>Purchase order {ctx.po.id}</b><span>{ctx.po.requester} · {fmtDate(ctx.po.date)} · {money(match.totals.po)}</span></li>}
        {ctx.receipt && <li><b>Item receipt {ctx.receipt.id}</b><span>{fmtDate(ctx.receipt.date)} · {ctx.receipt.notes}</span></li>}
        {ctx.contracts.map((k) => <li key={k.id}><b>{k.title}</b><span>{k.id} · {k.effective} → {k.expires}</span></li>)}
      </ul>
    </Exhibit>
  );
}

export { addDays };
