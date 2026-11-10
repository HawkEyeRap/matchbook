# Sample documents

Drop any of these into Matchbook (**Inbox → Add bills**), or use **Try a sample**. Every file is parsed for real: PDFs are read from their text layer, matched to the Ramp vendor record, the PO, item receipts, and vendor agreements, and then investigated.

| File | What it is | What Matchbook should do |
| --- | --- | --- |
| `northwind-NWP-31244.pdf` | Northwind invoice, list price again | Price above contract → credit memo for $720.00 |
| `summit-lab-SLS-118391.pdf` | Summit Lab invoice, all correct | Clean match → passes straight to approval |
| `alder-finch-AF-77402.pdf` | Alder & Finch invoice with add-on fees | Charges not on PO → credit memo for $458.00 |
| `meridian-print-MPC-2117.pdf` | Meridian invoice from a lookalike domain | New bank account → payment hold and call-back |
| `redwood-RW-10241-R.pdf` | Redwood re-issued September invoice | Duplicate of a paid bill → reject |
| `ferro-FIF-60318.pdf` | Ferro invoice at the new contract price | PO typo + stale PO → change the PO, don’t dispute |
| `brightline-BAV-5560.pdf` | Brightline invoice, nothing received yet | No item receipt → ask the requester |
| `ramp-bill-export.csv` | Bill export with two bills (CSV) | One clean, one billed for backordered units |
| `northwind-credit-memo-CM-4917.pdf` | Northwind credit memo, correct amount | Approve NWP-30917 first → verifies $1,000.00 and releases payment |
| `northwind-credit-memo-CM-4918-short.pdf` | Northwind credit memo, $200 short | Approve NWP-30917 first → caught as short, follow-up drafted |
| `summit-lab-corrected-SLS-118204-R.pdf` | Summit Lab corrected invoice | Approve SLS-118204 first → re-matched clean, payment released |

The three vendor replies (credit memos and the corrected invoice) answer cases already in the queue. Approve the matching case first, then drop the reply in. Matchbook checks the amount and reference before it releases payment.

All companies, people, and figures are fictional. Regenerate with `node scripts/make-samples.mjs`.
