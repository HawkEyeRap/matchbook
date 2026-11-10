import React, { useState } from 'react';
import { FINDING_META } from '../engine/resolve.js';
import { money, num, round2 } from '../engine/util.js';

// Illustrative 90-day pilot mix for a ~5,000 bill/month company (labeled as such in the UI).
const PILOT_MIX = { PRICE_OVER_CONTRACT: 41, MISSING_RECEIPT: 33, QTY_OVER_RECEIPT: 27, PO_PRICE_STALE: 18, UNPLANNED_CHARGE: 15, MISSING_DOCS: 12, DUPLICATE: 9, CONTRACT_CONFLICT: 4, BANK_MISMATCH: 3 };
const VENDOR_FIX = new Set(['PRICE_OVER_CONTRACT', 'QTY_OVER_RECEIPT', 'UNPLANNED_CHARGE', 'DUPLICATE', 'QTY_OVER_PO']);

const PREVENT = {
  PRICE_OVER_CONTRACT: (a) => (a.findings.some((f) => f.detail?.sweep)
    ? { title: `Check PO prices against the agreement before the PO is sent`, text: `${a.ctx.po.id} went out at ${money(a.primary.detail.poPrice, true)} while ${a.ctx.contract?.id} says ${money(a.primary.detail.contractPrice, true)}. 3-way match can’t catch a PO that is wrong to begin with.` }
    : { title: `Lock agreement prices into ${a.ctx.vendor.name}’s catalog`, text: `Bill Pay would block ${a.primary.detail.sku} above ${money(a.primary.detail.contractPrice, true)} at intake.${a.ctx.history.some((h) => h.kind === 'credit') ? ' This vendor has made the same pricing error before.' : ''}` }),
  DUPLICATE: (a) => ({ title: 'Normalize invoice numbers before the duplicate check', text: `${a.ctx.invoice.id} differs from the paid bill only by a suffix. Stripping “-A”, “-R”, “REV”, and spacing catches re-issues.` }),
  BANK_MISMATCH: (a) => ({ title: 'Quarantine lookalike sender domains', text: `${a.ctx.invoice.senderDomain} imitates ${a.ctx.vendor.domain}. Route any bill from an unknown domain to the Controller before anyone opens it.` }),
  PO_PRICE_STALE: (a) => ({ title: 'Amend open POs the day a price notice is acknowledged', text: `${a.ctx.vendor.name}’s increase was in the agreement, but ${a.ctx.po.id} kept the old price. Matchbook can draft the PO change request when the notice lands.` }),
  MISSING_RECEIPT: (a) => ({ title: 'Ask requesters for the item receipt when the carrier marks delivered', text: `${a.ctx.po.requester} gets a Slack nudge on delivery day, before the bill ever reaches AP.` }),
  UNPLANNED_CHARGE: (a) => ({ title: `Print “freight and delivery included” on ${a.ctx.vendor.name} POs`, text: 'The agreement already says so. Restating it on the PO stops the add-on line before it’s billed.' }),
  QTY_OVER_RECEIPT: (a) => ({ title: `Remind ${a.ctx.vendor.name} to bill on shipment`, text: 'Their agreement requires it. One note to their AR team prevents repeat backorder billing.' }),
  MISSING_DOCS: (a) => ({ title: 'Collect sign-off when the vendor portal marks a job done', text: `Matchbook can watch ${a.ctx.vendor.portal || 'the vendor portal'} and ask ${a.ctx.po.requester} to sign before the invoice arrives.` }),
  CONTRACT_CONFLICT: (a) => ({ title: `Retire superseded agreements for ${a.ctx.vendor.name}`, text: `${a.ctx.contracts.map((k) => k.id).join(' and ')} are both in force with different prices. Procurement should end one so the next bill has a single answer.` }),
};

export default function Insights({ cases, analyses, toast }) {
  const [vol, setVol] = useState(5000);
  const [rate, setRate] = useState(19.9);
  const [manual, setManual] = useState(45);
  const [review, setReview] = useState(6);
  const [hourly, setHourly] = useState(55);

  const exceptions = Math.round(vol * (rate / 100));
  const hoursSaved = round2((exceptions * Math.max(0, manual - review)) / 60);
  const yearly = round2(hoursSaved * hourly * 12);
  const fte = hoursSaved / 160;

  const session = {};
  for (const c of cases) { const p = analyses[c.id].primary; if (p) session[p.code] = (session[p.code] || 0) + 1; }
  const mix = Object.entries(PILOT_MIX).map(([code, n]) => ({ code, n: n + (session[code] || 0) })).sort((a, b) => b.n - a.n);
  const maxN = mix[0].n;
  const internalShare = Math.round((mix.filter((m) => !VENDOR_FIX.has(m.code) && m.code !== 'BANK_MISMATCH').reduce((s, m) => s + m.n, 0) / mix.reduce((s, m) => s + m.n, 0)) * 100);

  const seen = new Set();
  const prevention = cases.map((c) => analyses[c.id]).filter((a) => a.primary && PREVENT[a.primary.code])
    .map((a) => ({ id: a.ctx.invoice.id, code: a.primary.code, ...PREVENT[a.primary.code](a) }))
    .filter((p) => { const k = p.title; if (seen.has(k)) return false; seen.add(k); return true; });

  return (
    <>
      <section className="page-h">
        <h1>What exceptions <em>cost</em>.</h1>
        <p>The labor Matchbook gives back, what causes exceptions in the first place, and the rule that would stop each one in this inbox from happening again.</p>
      </section>

      <div className="two">
        <section className="block" aria-label="Savings calculator">
          <div className="label">Labor given back</div>
          <div className="g3" style={{ marginTop: 16 }}>
            <Num id="roi-vol" label="Bills per month" value={vol} set={setVol} step={500} />
            <Num id="roi-rate" label="Exception rate %" value={rate} set={setRate} step={0.1} />
            <Num id="roi-hr" label="AP cost per hour $" value={hourly} set={setHourly} step={5} />
            <Num id="roi-man" label="Minutes, by hand" value={manual} set={setManual} step={5} />
            <Num id="roi-rev" label="Minutes, reviewing a draft" value={review} set={setReview} step={1} />
          </div>
          <div className="roi">
            <div><div className="v">{num(exceptions)}</div><div className="s">exceptions a month</div></div>
            <div><div className="v">{num(Math.round(hoursSaved))}</div><div className="s">AP hours back a month ({fte.toFixed(1)} FTE)</div></div>
            <div><div className="v">{money(yearly).replace('.00', '')}</div><div className="s">a year, before any recovered overbilling</div></div>
          </div>
          <p className="fine">Defaults: a 19.9% exception rate from Ardent Partners’ AP research (<a href="https://tailride.so/blog/invoice-management-statistics-2026" target="_blank" rel="noreferrer">summary</a>) and 45 minutes per manual exception from APQC benchmarks cited by <a href="https://peakflo.co/blog/ai-agents-exception-management-accounts-payable-guide" target="_blank" rel="noreferrer">Peakflo</a>. Change them to match your team.</p>
        </section>

        <section className="block" aria-label="Root causes">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}><span className="label" style={{ color: 'var(--ink)' }}>Root causes</span><span className="label">Illustrative 90-day pilot + this inbox</span></div>
          <div className="bars">
            {mix.map((m) => (
              <div key={m.code} className="barrow">
                <span>{FINDING_META[m.code].label}</span>
                <span className="track"><i className="grow-x" style={{ width: `${(m.n / maxN) * 100}%`, background: VENDOR_FIX.has(m.code) ? 'var(--hatch)' : m.code === 'BANK_MISMATCH' ? 'var(--red)' : 'var(--ink)' }} /></span>
                <span className="n">{m.n}</span>
              </div>
            ))}
          </div>
          <div className="tl-legend" style={{ marginTop: 14 }}>
            <span><span className="sw" style={{ background: 'var(--hatch)' }} />needs the vendor</span>
            <span><span className="sw" style={{ background: 'var(--ink)' }} />internal fix</span>
          </div>
          <p className="fine">About {internalShare}% of exceptions are internal: a missing item receipt, a stale PO, a missing sign-off. They look like vendor problems in Bill Pay today. Matchbook sends them to the teammate who can fix them instead of emailing the vendor.</p>
        </section>
      </div>

      <div className="two">
        <section className="block" aria-label="Cycle time">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}><span className="label" style={{ color: 'var(--ink)' }}>Days from flag to payment</span><span className="label">Illustrative</span></div>
          <div className="cyc">
            <Cycle label="By hand" total={8.9} parts={[['Investigate', 2.1, 'var(--hair)', 'var(--ink)'], ['Email chain', 3.4, 'var(--ink)', 'var(--paper)'], ['Chase', 2.6, 'var(--ink-2)', 'var(--paper)'], ['Pay', 0.8, 'var(--hair)', 'var(--ink)']]} />
            <Cycle label="With Matchbook" total={1.8} max={8.9} parts={[['Review', 0.3, 'var(--solar)', 'var(--ink)'], ['Vendor', 1.4, 'var(--solar)', 'var(--ink)'], ['Pay', 0.1, 'var(--ink)', 'var(--paper)']]} />
          </div>
          <p className="fine">Investigation goes from days to seconds. What’s left is the vendor’s turnaround, which automatic follow-ups shorten, and a partial payment keeps the early-payment discount while the dispute is open.</p>
        </section>

        <section className="block" aria-label="Prevention">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}><span className="label" style={{ color: 'var(--ink)' }}>Stop the next one</span><span className="label">From this inbox</span></div>
          <ul className="prev">
            {prevention.map((p) => (
              <li key={p.title}>
                <div style={{ minWidth: 0 }}><b>{p.title}</b><span>{p.text}</span><span className="m">from {p.id}</span></div>
                <button className="btn ghost sm" onClick={() => toast?.('Rule drafted. It goes live after the Controller approves it.')}>Draft rule</button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}

function Num({ id, label, value, set, step }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="number" className="input mono-in" value={value} step={step} min={0} onChange={(e) => set(Number(e.target.value) || 0)} />
    </div>
  );
}

function Cycle({ label, parts, total, max }) {
  const scale = max || total;
  return (
    <div className="cyc-row">
      <span>{label}<b>{total} days</b></span>
      <span className="sb" style={{ width: `${(total / scale) * 100}%`, minWidth: 110 }}>
        {parts.map(([n, d, bg, fg]) => <i key={n} title={`${n}: ${d} days`} style={{ width: `${(d / total) * 100}%`, background: bg, color: fg }}>{d / total > 0.2 ? n : ''}</i>)}
      </span>
    </div>
  );
}
