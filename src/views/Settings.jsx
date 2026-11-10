import React from 'react';
import { Seg } from '../ui/marks.jsx';
import { DEFAULT_POLICY } from '../engine/match.js';
import { COMPANY } from '../data/scenarios.js';
import { money } from '../engine/util.js';

const NUMS = [
  ['priceTolerancePct', 'Price tolerance, %', 'A line passes if it’s within this percent of the agreement or PO price…', 0.5],
  ['priceToleranceAbs', 'Price tolerance, $ per line', '…and within this many dollars. Both must hold.', 10],
  ['controllerThreshold', 'Controller sign-off above, $', `Disputes or holds above this also need ${COMPANY.controller.name}.`, 500],
  ['followUpDays', 'Follow up every, days', 'How long Matchbook waits for a vendor before nudging.', 1],
  ['maxNudges', 'Nudges before escalating', 'After this many, the case goes to a person.', 1],
];

const AUTONOMY = [
  ['vendorEmail', 'Emails to vendors', [['draft', 'Draft only'], ['approve', 'Approve'], ['auto', 'Auto-send']], 'Auto-send applies only under the Controller threshold, with a 15-minute window to stop it.'],
  ['followUps', 'Follow-up nudges', [['approve', 'Approve'], ['auto', 'Automatic']], 'Once the first message is approved, reminders reuse its facts.'],
  ['internalPings', 'Slack to teammates', [['approve', 'Approve'], ['auto', 'Automatic']], 'Asking a requester to log an item receipt or sign a report.'],
  ['poAmendment', 'PO change requests', [['approve', 'Approve']], 'Always needs the budget owner. Not configurable.'],
];

const CONNECTIONS = [
  ['Ramp Bill Pay', 'Bills, purchase orders, item receipts, vendor agreements, vendor credits', 'Simulated with local data'],
  ['Email', `${COMPANY.apContact.email}, sending as the AP team`, 'Simulated'],
  ['Slack', 'Messages to requesters and budget owners', 'Simulated'],
  ['Carrier tracking and vendor portals', 'Headless browser lookups', 'Simulated with recorded results'],
  ['Language model', 'None. Matchbook runs offline with no API keys.', 'Not connected'],
];

export default function Settings({ policy, setPolicy, cases, toast }) {
  const set = (k, v) => setPolicy((p) => ({ ...p, [k]: v }));
  const setAuto = (k, v) => setPolicy((p) => ({ ...p, autonomy: { ...p.autonomy, [k]: v } }));
  const changed = JSON.stringify(policy) !== JSON.stringify(DEFAULT_POLICY);
  return (
    <>
      <section className="page-h">
        <h1>The <em>rules</em> it follows.</h1>
        <p>Every change here re-runs all {cases.length} cases in the inbox and the scorecard immediately, so you can see what a looser tolerance or a lower threshold would have done.</p>
      </section>

      <div className="two">
        <section className="block">
          <div className="label">Matching and sign-off</div>
          {NUMS.map(([k, label, hint, step]) => (
            <div key={k} className="set-row">
              <div><b>{label}</b><span>{hint}</span></div>
              <input aria-label={label} type="number" min={0} step={step} className="input" value={policy[k]} onChange={(e) => set(k, Math.max(0, Number(e.target.value) || 0))} />
            </div>
          ))}
          <div className="set-row">
            <div><b>Contract sweep</b><span>Check PO prices against vendor agreements even when the invoice and PO agree. 3-way match alone can’t see this.</span></div>
            <Seg label="Contract sweep" value={policy.contractSweep ? 'on' : 'off'} options={[['on', 'On'], ['off', 'Off']]} onChange={(v) => set('contractSweep', v === 'on')} />
          </div>
          <div style={{ marginTop: 18, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn ghost sm" disabled={!changed} onClick={() => { setPolicy(DEFAULT_POLICY); toast('Rules back to defaults'); }}>Restore defaults</button>
            <span className="label">Controller threshold now {money(policy.controllerThreshold)}</span>
          </div>
        </section>

        <section className="block">
          <div className="label">What it may do on its own</div>
          {AUTONOMY.map(([k, label, opts, hint]) => (
            <div key={k} className="set-row">
              <div><b>{label}</b><span>{hint}</span></div>
              <Seg label={label} value={policy.autonomy[k]} options={opts} onChange={(v) => setAuto(k, v)} />
            </div>
          ))}
          <div className="label" style={{ marginTop: 40 }}>Connections</div>
          {CONNECTIONS.map(([n, d, s]) => (
            <div key={n} className="set-row">
              <div><b>{n}</b><span>{d}</span></div>
              <span className="label" style={{ color: s === 'Not connected' ? 'var(--ink)' : undefined }}>{s}</span>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
