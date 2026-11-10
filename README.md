# Matchbook

**Ramp catches it. Matchbook closes it.** An agent for Ramp Bill Pay that resolves invoice exceptions instead of just flagging them.

Built for the Ramp × BBS Hackathon.

> Bill Pay already reads invoices, codes them, routes approvals, catches fraud signals, and runs 3-way matching. When a match fails, a person still has to work out *why*, write to the vendor, chase the reply, and check the fix. Matchbook does that part, and a person approves anything that leaves the building or moves money.

**Runs entirely in the browser. No language model, no API keys, no accounts.** Open it, drop in the sample PDFs, and everything you see is computed from those files.

---

## The problem

About one in five invoices fails straight-through processing. Ardent Partners’ AP research puts the average exception rate at **19.9%**, and APQC-based benchmarks put manual handling at **45–60 minutes per exception**. For a company paying 5,000 bills a month, that’s roughly 1,000 exceptions and 650+ AP hours a month, spent in email threads outside the finance system while early-payment discounts expire.

Detecting the mismatch isn’t the hard part. Bill Pay already does that. The hard part is that **the same flag can have opposite right answers**:

| Bill Pay says | What actually happened | The right fix |
|---|---|---|
| Unit price exceeds PO | Vendor billed its list price; the agreement fixes prices through 2027 | Credit memo request citing §3.1 |
| Unit price exceeds PO | Vendor gave valid notice of a contractual increase; **our** PO is stale | PO change request. Don’t dispute. |
| Billed units not received | 40 cases were backordered; vendor billed the order, not the shipment | Corrected invoice; bill the rest on shipment |
| Billed units not received | UPS shows a signature; the requester never logged the item receipt | Slack the requester, not the vendor |
| Remit-to differs from vendor | Lookalike domain asking to change bank details | Hold, call the number on file. Never reply. |
| *(nothing; 3-way match passed)* | Invoice and PO agree, but both are above the vendor agreement | Contract sweep catches it → credit memo |
| Unit price exceeds PO | Two vendor agreements are in force with different prices | Don’t guess. Hand to the Controller with both clauses. |

## What it does

1. **Reads** the blocked bill, its PO, item receipts, vendor agreements, payment history, and carrier tracking (the same objects Ramp stores).
2. **Computes** a line-level match against the PO, the item receipt, *and* the agreement price in force on the invoice date, including escalation clauses and notice periods. Every dollar comes from code.
3. **Diagnoses** the root cause with retrieval over every agreement clause and vendor history, and cites the clause that decides it.
4. **Drafts the fix** for that cause: credit memo request, corrected invoice, item-receipt nudge, PO change request, duplicate rejection, missing-document request, fraud hold with a call-back script, or a hand-off when the agreements conflict. Three tones (friendly, firm, final notice).
5. **Waits for approval.** AP approves; the Controller co-signs above a threshold; the budget owner approves PO changes. Nothing is sent or paid without sign-off.
6. **Follows up** on a schedule, reads the vendor’s reply (upload the sample credit memo), checks the amount and reference, re-runs the match on a corrected invoice, and releases payment.
7. **Protects cash** by paying the undisputed part in time to keep the early-payment discount.
8. **Prevents the next one** with a rule suggestion per root cause.
9. **Grades itself.** A 22-case scorecard runs in the browser and in CI.

## Run it

```bash
npm install
npm run dev            # http://localhost:5173
npm test               # engine, ingestion, and the 22-case scorecard
npm run build:single   # one self-contained HTML file in dist-single/
```

No install? Open [`matchbook.html`](matchbook.html) in any browser. It’s the whole app in one file and works offline (fonts aside).

The first visit opens a short guided tour (replay it from **Tour** in the top bar). A three-minute walkthrough is in [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md).

### Try it with real files

The [`samples/`](samples/) folder has invoice PDFs in three different vendor layouts, a Ramp-style CSV export, two credit memos, and a corrected invoice. Drag any of them onto **Inbox → Add bills**, or click **Run** next to a sample. Each file is parsed from its PDF text layer, matched to the vendor, PO, receipt, and agreement, and investigated. Nothing is pre-scripted: open `ferro-FIF-60318.pdf` and you’ll see Matchbook resolve a one-digit PO typo and then decide the vendor was *right*.

To see verification, approve the Northwind case (NWP-30917), then drop in `northwind-credit-memo-CM-4918-short.pdf`. Matchbook rejects it as $200 short and drafts a reply. Drop in `northwind-credit-memo-CM-4917.pdf` and it releases payment.

| Page | What it shows |
|---|---|
| **Inbox** | Ten blocked bills, the variance at stake, and file intake. |
| **Case** | The red-pen correction, the agent trace, and exhibits: the mismatch (computed), which agreement applied (timeline), the diagnosis (with the clause), the fix (drafts with every number traced), and the follow-up. |
| **Scorecard** | 22 graded cases: root cause, resolution, amount to the cent, false disputes, citations, grounded drafts, field extraction, reply verdicts. |
| **Sandbox** | Edit any bill and watch the investigation recompute on every keystroke. |
| **Insights** | Labor saved, root-cause mix, cycle time, and prevention rules from the queue. |
| **How it works** | Where Matchbook fits in Ramp, the tool choices, guardrails, and what’s simulated. |
| **Settings** | Tolerances, thresholds, follow-up cadence, autonomy per action. Changes re-run everything. |

### MCP server

The same engine is exposed as MCP tools (`list_exceptions`, `investigate_exception`, `check_invoice`, …) so any agent runtime can call it.

```bash
npm run mcp     # stdio transport
```

## How it’s built

```
src/
  data/scenarios.js     Halcyon Robotics: vendors, POs, item receipts, agreements, paid bills, history
  data/sampleFiles.js   the /samples files, embedded so the hosted demo works offline
  ingest/               pdf.js text extraction → field and line-item parser → routing (new bill vs vendor reply)
  engine/match.js       line-level 3-way match + agreement pricing, duplicates, remit-to, vendor-text scan
  engine/retrieval.js   BM25 over agreement clauses, vendor history, receipt notes
  engine/resolve.js     root cause, formula, plan, drafts, approvals, reply verification
  engine/guard.js       grounding check: every number in a draft must exist in the books
  engine/agent.js       the investigation as a sequence of named tool calls (the trace)
  engine/evals.js       the 22-case scorecard
  store.js              case state machine: new → investigating → review → waiting → resolved
  views/, ui/           React views; editorial design, light theme
mcp-server/server.js    MCP tools over the same engine
scripts/make-samples.mjs  generates the sample PDFs and CSV with pdf-lib
```

### Decisions that matter

- **Code owns the numbers.** Matching, tolerances, agreement pricing, and every dollar figure are deterministic. The grounding guard checks every token in a draft against the facts and disables Approve if anything can’t be traced.
- **No model in the demo, on purpose.** It makes the demo shareable with no keys, reproducible for graders, and honest about what the engine does. In production a model would only rephrase from the allowed facts, behind the same guard.
- **The agreement is the third document.** 3-way match compares the invoice to the PO and receipt; Matchbook adds the vendor agreement, which is how it tells “vendor overbilled” from “our PO is stale”, and how it catches bills where the PO itself was wrong.
- **Vendor text is data, never instructions.** An “approve this invoice” note on a bill is flagged and ignored.
- **Route to whoever can fix it.** Many exceptions are internal (missing item receipt, stale PO, missing sign-off). Those go to a teammate, not the vendor.
- **Verify, then pay.** A reply has to reference the bill and cover the full amount before payment is released.

More in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## What’s real and what’s simulated

**Real:** PDF and CSV parsing, matching, agreement pricing, duplicate and lookalike-domain checks, prompt-injection flagging, retrieval, root cause, drafts, the grounding guard, approvals, reply verification, discount math, the scorecard, the MCP server, tests.

**Simulated:** Ramp API calls (local data in the same shape), sending email and Slack, carrier and vendor-portal lookups (recorded results), the passage of time (Fast-forward), and the vendor’s reply when you don’t upload one.

## Credits

The editorial design direction (paper, ink, and one red pen; numbered exhibits; the correction mark; the match grid; the contract timeline; the live scorecard) and several product ideas (contract sweep, conflicting agreements, prompt-injection handling, code-filled numbers in drafts) come from Eason Gan’s version of Matchbook. This repo combines that design with the ingestion, engine, and workflow.

## Sources

- Ardent Partners AP benchmarks (19.9% exception rate), summarized by [Tailride](https://tailride.so/blog/invoice-management-statistics-2026)
- Manual exception handling time, APQC benchmarks via [Peakflo](https://peakflo.co/blog/ai-agents-exception-management-accounts-payable-guide)
- Ramp Bill Pay: [ramp.com/bill-pay](https://ramp.com/bill-pay/) · [Agents for AP](https://ramp.com/blog/ramp-ap-agents-announcement)

All companies, people, and figures in the demo are fictional.
