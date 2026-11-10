#!/usr/bin/env node
// Matchbook MCP server: exposes the same engine the web app uses as MCP tools, so any
// MCP client (an internal Ramp agent runtime, an IDE, a desktop assistant) can
// investigate and resolve invoice exceptions.
//
// In production these tools wrap Ramp's API (bills, purchase orders, item receipts,
// vendors, payments). In this repo they run against the demo dataset.
//
//   npm run mcp            # stdio transport
//   Register it in any MCP client as a stdio server: node mcp-server/server.js

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { INVOICES, contextFor } from '../src/data/scenarios.js';
import { investigate } from '../src/engine/agent.js';
import { DEFAULT_POLICY } from '../src/engine/match.js';
import { FINDING_META } from '../src/engine/resolve.js';
import { money } from '../src/engine/util.js';

const server = new McpServer({ name: 'matchbook', version: '1.0.0' });
const json = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const find = (id) => INVOICES.find((i) => i.id === id);

server.registerTool('list_exceptions', {
  title: 'List invoice exceptions',
  description: 'List bills that failed Bill Pay matching, with the primary finding, amount at stake, and recommended resolution.',
  inputSchema: {},
}, async () => json(INVOICES.map((inv) => {
  const a = investigate(contextFor(inv), DEFAULT_POLICY);
  return { bill: inv.id, vendor: a.ctx.vendor.name, total: money(a.match.totals.invoice), finding: a.primary ? FINDING_META[a.primary.code].label : 'none', resolution: a.plan.label, atStake: money(a.plan.atStake) };
})));

server.registerTool('investigate_exception', {
  title: 'Investigate an exception',
  description: 'Run the full investigation on one bill: fetch PO/receipt/contract, line-level 3-way match, retrieval over contract clauses and vendor history, root cause, and a resolution plan with drafts and required approvals. Read-only.',
  inputSchema: { billId: z.string().describe('Bill / invoice number, e.g. NWP-30917') },
}, async ({ billId }) => {
  const inv = find(billId);
  if (!inv) return { isError: true, content: [{ type: 'text', text: `No bill ${billId}. Call list_exceptions for valid IDs.` }] };
  const a = investigate(contextFor(inv), DEFAULT_POLICY);
  return json({
    bill: inv.id, vendor: a.ctx.vendor.name,
    rootCause: a.cause, findings: a.findings.map((f) => ({ code: f.code, label: FINDING_META[f.code].label, amount: f.amount })),
    evidence: a.evidence.map((e) => ({ for: e.forCode, top: e.hits.slice(0, 2).map((h) => ({ ref: h.title, relevance: h.relevance, text: h.text })) })),
    plan: { type: a.plan.type, label: a.plan.label, disputed: a.plan.disputed, payable: a.plan.payable, discount: a.plan.discount, confidence: a.plan.confidence, approvals: a.plan.approvals, actions: a.plan.actions },
    trace: a.steps.map((s) => `${s.tool}: ${s.label} — ${s.detail}`),
  });
});

server.registerTool('check_invoice', {
  title: 'Check an invoice against a PO',
  description: 'Match arbitrary invoice data against the purchase order, receipt, and contract on file. Use for new bills or what-if checks. Read-only; never sends anything.',
  inputSchema: {
    vendorId: z.string().describe('Vendor ID, e.g. V-NWP'),
    invoiceId: z.string(),
    poRef: z.string(),
    date: z.string().describe('YYYY-MM-DD'),
    terms: z.string().default('Net 30'),
    remitToLast4: z.string().optional(),
    lines: z.array(z.object({ sku: z.string().nullable(), desc: z.string(), qty: z.number(), unitPrice: z.number() })),
  },
}, async (args) => {
  const base = INVOICES.find((i) => i.vendorId === args.vendorId);
  if (!base) return { isError: true, content: [{ type: 'text', text: `Unknown vendor ${args.vendorId}` }] };
  const inv = { ...base, id: args.invoiceId, poRef: args.poRef, date: args.date, terms: args.terms, remitTo: { ...base.remitTo, last4: args.remitToLast4 || base.remitTo.last4 }, lines: args.lines.map((l) => ({ ...l, conf: 1 })) };
  const a = investigate(contextFor(inv), DEFAULT_POLICY);
  return json({ finding: a.primary?.code || 'none', rootCause: a.cause.headline, resolution: a.plan.label, disputed: a.plan.disputed, payable: a.plan.payable });
});

await server.connect(new StdioServerTransport());
