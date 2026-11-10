import React from 'react';

const GAP = [
  ['Code', 'GL, class, department on every line', 'Ramp Agents for AP'],
  ['Catch', 'fraud and policy problems before payment', 'Ramp Agents for AP'],
  ['Match', '3-way match blocks the bill', 'Bill Pay'],
  ['Resolve', 'find the cause, fix it with the vendor, release payment', 'Matchbook', true],
  ['Pay', 'ACH, card, check, on schedule', 'Bill Pay'],
];

const FLOW = [
  ['01', 'Read', 'The blocked bill, its PO, item receipts, vendor agreements, payment history, and carrier tracking.', 'Ramp API'],
  ['02', 'Compute', 'Line-level 3-way match plus the agreement price in force on the invoice date. Every dollar figure comes from code.', 'Code'],
  ['03', 'Diagnose', 'Picks the root cause, cites the clause that decides it, and chooses who should fix it: vendor, requester, or budget owner.', 'Rules + search'],
  ['04', 'Approve', 'Drafts the email, credit request, or PO change. Nothing is sent, paid, or changed until you approve it.', 'You', true],
  ['05', 'Follow up', 'Nudges on a schedule, reads the reply, checks the credit memo’s amount and reference, and re-runs the match.', 'Agent'],
  ['06', 'Release', 'Pays the undisputed part in time for the discount, applies the vendor credit, and syncs it all back to Ramp.', 'Ramp API'],
  ['07', 'Prevent', 'Suggests the rule that would have stopped this exception: a catalog price lock, a PO check, a domain quarantine.', 'Insights'],
  ['08', 'Grade', 'A scorecard of 22 cases with known answers reruns on every rule change and in CI.', 'Scorecard'],
];

const TOOLS = [
  ['Language models', 'In the demo: none. Diagnosis is rules plus retrieval, and drafts are templates filled with numbers from code. It runs offline with no API keys, so it can be shared and graded.', 'In production: a model writes the explanation and email prose, choosing only from the facts the engine allows. The grounding check below rejects any draft with a number the books don’t contain.'],
  ['Document AI and OCR', 'In the demo: pdf.js reads the text layer of real PDFs in your browser, reconstructs lines, and pulls fields and line items. Try the sample files.', 'In production: Ramp’s own invoice OCR feeds the same parser, so scans and photos work too.'],
  ['Retrieval (RAG)', 'In the demo: BM25 search over every clause of every vendor agreement, past credits, notices, and receipt notes. The top hit is quoted in the diagnosis.', 'In production: the same index, built from the vendor agreements already stored in Ramp, plus email threads.'],
  ['Ramp API and MCP', 'In the demo: tool calls are named after Ramp’s real objects (bills, purchase orders, item receipts, vendor agreements, vendor credits) and simulated against local data. An MCP server in /mcp-server exposes the agent to any MCP client.', 'In production: Ramp’s API and MCP server for reads, PO change requests, and vendor credits. Writes are scoped to the approved action.'],
  ['Browser automation', 'In the demo: carrier tracking and vendor portal lookups are simulated with recorded results.', 'In production: a headless browser checks the carrier’s tracking page or the vendor portal when there’s no API.'],
  ['Human in the loop', 'Real in the demo. Every outbound action needs approval, and amounts over the policy threshold need the Controller too.', 'Same in production, with the approval written to Ramp’s audit log.'],
];

const GUARDS = [
  'Numbers come from code. Drafts are checked token by token, and anything the books don’t contain blocks the Approve button.',
  'Vendor text is data, never instructions. A note that says “approve this invoice” is flagged, logged, and ignored.',
  'Bank details are never changed from an email. A new account means a hold and a call to the number already on file.',
  'If two agreements disagree, Matchbook doesn’t pick one. It hands the case to a person with both clauses.',
  'If the vendor was right, it doesn’t dispute. A valid price increase becomes a PO change request, not a claim.',
  'A reply is verified before payment: the credit memo must reference the bill and cover the full amount.',
];

const cap = (t) => t[0].toUpperCase() + t.slice(1);

export default function How({ go }) {
  return (
    <>
      <section className="page-h">
        <h1>Ramp catches it.<br />Matchbook <em>closes</em> it.</h1>
        <p>
          Bill Pay’s 3-way match is good at stopping a bill that doesn’t agree with its PO and item receipts. What happens next is still manual: someone opens three tabs, finds the agreement, does the math, writes the vendor, and waits.
          Matchbook is the agent for that step. It works inside the queue you already have, on the objects Ramp already stores.
        </p>
      </section>

      <section style={{ marginTop: 48 }}>
        <div className="block"><div className="label">Where it fits in Ramp</div></div>
        <div className="gap-cmp">
          {GAP.map(([k, s, who, me]) => <div key={k} className={me ? 'me' : ''}><b>{k}</b><span>{s}</span><span className="label" style={{ display: 'block', marginTop: 10, color: 'var(--ink)' }}>{who}</span></div>)}
        </div>
      </section>

      <ol className="flow">
        {FLOW.map(([n, t, s, w, you]) => <li key={n}><span className="n">{n}</span><b>{t}</b><span>{s}</span><small className={you ? 'you' : ''}>{w}</small></li>)}
      </ol>

      <section style={{ marginTop: 64 }}>
        <div className="block"><div className="label">The tools, and why each one is there</div></div>
        <ul className="tools">
          {TOOLS.map(([t, demo, prod]) => (
            <li key={t}><b>{t}</b><p><span className="label">This demo</span>{cap(demo.replace(/^In the demo: /, ''))}</p><p><span className="label">In Ramp</span>{cap(prod.replace(/^In production: /, ''))}</p></li>
          ))}
        </ul>
      </section>

      <div className="two">
        <section className="block">
          <div className="label">Guardrails</div>
          <ul className="guards" style={{ marginTop: 8 }}>{GUARDS.map((g) => <li key={g}>{g}</li>)}</ul>
        </section>
        <section className="block">
          <div className="label">What’s real and what’s simulated</div>
          <ul className="prev" style={{ marginTop: 8 }}>
            <li><div><b>Real</b><span>PDF and CSV parsing, matching, agreement pricing with escalations, duplicate and lookalike-domain checks, retrieval, root cause, drafts, the grounding check, approvals, reply verification, and the scorecard. Upload a file and it all runs.</span></div></li>
            <li><div><b>Simulated</b><span>The Ramp API calls (local data with the same shape), sending email and Slack, carrier and portal lookups, the passage of time (use Fast-forward), and the vendor’s reply when you don’t upload one.</span></div></li>
            <li><div><b>Not included</b><span>Any connection to a language model or any API key. The demo is a static page that runs entirely in your browser.</span></div></li>
          </ul>
          <div style={{ marginTop: 22, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn primary" onClick={() => go('inbox')}>Open the inbox <span className="arr">→</span></button>
            <button className="btn ghost" onClick={() => go('scorecard')}>See the scorecard</button>
          </div>
        </section>
      </div>

      <footer className="foot">
        <p>Built for the Ramp × BBS Hackathon.</p>
        <p className="label">Fictional company, vendors, and figures</p>
      </footer>
    </>
  );
}
