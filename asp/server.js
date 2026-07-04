// asp/server.js — the ASP service host.
//
// Two surfaces over the same six skills:
//   1. x402-gated HTTP endpoints  POST /skills/<name>  (the monetized A2MCP path
//      OKX registers; returns a 402 challenge, then the paid JSON on settlement).
//   2. A spec-compliant MCP endpoint  POST /mcp  (Streamable HTTP, stateless) that
//      exposes the same skills as MCP tools for MCP-native agents / the demo.
// Plus free discovery: GET / (manifest), GET /health, GET /.well-known/x402.
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { config } from './config.js';
import { bootEngine } from './engine.js';
import { SKILLS, SKILLS_BY_NAME, skillManifest } from './skills/index.js';
import { x402Gate, paymentInfo } from './payments/x402.js';
import { scoreboard, computeLedger, anchorCommand } from './reputation/ledger.js';
import { assessJob } from './a2a/deep-desk.js';

// ── Map a skill's tiny JSON input schema to a zod raw shape for MCP tools ──────
function zodShapeFor(skill) {
  const shape = {};
  for (const [key, spec] of Object.entries(skill.inputSchema?.properties || {})) {
    let z1;
    if (spec.enum) z1 = z.enum(spec.enum);
    else if (spec.type === 'number') z1 = z.number();
    else z1 = z.string();
    if (spec.description) z1 = z1.describe(spec.description);
    if (!(skill.inputSchema?.required || []).includes(key)) z1 = z1.optional();
    shape[key] = z1;
  }
  return shape;
}

// ── Build a fresh MCP server exposing the six skills (stateless per request) ──
function buildMcpServer(engine) {
  const server = new McpServer({ name: `${config.server.name}-asp`, version: '1.0.0' });
  for (const skill of SKILLS) {
    server.registerTool(
      skill.name,
      {
        title: skill.title,
        description: `${skill.description} (Price: $${skill.priceUsdt} USDT per call via x402 on the HTTP endpoint.)`,
        inputSchema: zodShapeFor(skill),
      },
      async (args) => {
        const result = await skill.run(args, engine);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: !result.ok,
        };
      },
    );
  }
  return server;
}

/** Build the Express app around an already-booted engine. */
export function createApp(engine) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  const manifest = () => ({
    name: config.server.name,
    kind: 'a2mcp',
    description: 'Theia: institutional-grade crypto confluence, manipulation, CEX-flow, insider, and liquidation intelligence. Pay-per-call via x402.',
    endpoints: {
      http: `${config.server.publicUrl.replace(/\/$/, '')}/skills/<name>`,
      mcp: `${config.server.publicUrl.replace(/\/$/, '')}/mcp`,
    },
    payment: paymentInfo(),
    skills: skillManifest(),
    engineStatus: engine?.status ?? null,
  });

  // ── Free discovery routes ───────────────────────────────────────────────────
  app.get('/', (_req, res) => res.json(manifest()));
  app.get('/manifest', (_req, res) => res.json(manifest()));
  app.get('/.well-known/x402', (_req, res) => res.json(paymentInfo()));
  app.get('/health', (_req, res) => res.json({ ok: true, provider: config.server.name, status: engine?.status ?? null }));

  // Verifiable-alpha scoreboard (free, public): real resolved-signal win-rate +
  // the Merkle root anchored on X Layer. `?full=1` returns the per-signal leaves.
  app.get('/reputation', async (req, res) => {
    try {
      if (req.query.full === '1') {
        const ledger = await computeLedger(engine?.signalTracker);
        return res.json({ ...ledger, anchor: anchorCommand(ledger.merkleRoot) });
      }
      res.json(await scoreboard(engine?.signalTracker));
    } catch (e) {
      res.status(500).json({ ok: false, error: { code: 'internal', message: e.message } });
    }
  });

  // ── A2A Deep Desk quote (free): conviction filter + scope, no full audit ────
  // The full escrow-backed audit runs only after job_accepted via the onchainos
  // CLI. This endpoint lets a User Agent see whether Theia will take the job.
  app.post('/a2a/quote', async (req, res) => {
    try {
      const { description, budgetUsdt } = req.body || {};
      const assessment = await assessJob({ description, budgetUsdt }, engine);
      res.json({ service: 'Theia Deep Desk', paymentMode: 'escrow', ...assessment });
    } catch (e) {
      res.status(500).json({ ok: false, error: { code: 'internal', message: e.message } });
    }
  });

  // ── x402-gated skill endpoints (the monetized A2MCP surface) ────────────────
  for (const skill of SKILLS) {
    app.post(
      `/skills/${skill.name}`,
      x402Gate({ priceUsdt: skill.priceUsdt, description: `${skill.title}: ${skill.description}` }),
      async (req, res) => {
        try {
          const result = await skill.run(req.body || {}, engine);
          res.status(result.ok ? 200 : 400).json(result);
        } catch (e) {
          res.status(500).json({ ok: false, skill: skill.name, error: { code: 'internal', message: e.message } });
        }
      },
    );
  }

  // ── MCP endpoint (stateless Streamable HTTP) ────────────────────────────────
  app.post('/mcp', async (req, res) => {
    let transport;
    let server;
    try {
      server = buildMcpServer(engine);
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { transport?.close?.(); server?.close?.(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: `MCP error: ${e.message}` }, id: null });
      }
    }
  });
  const mcpMethodNotAllowed = (_req, res) =>
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless MCP: use POST).' }, id: null });
  app.get('/mcp', mcpMethodNotAllowed);
  app.delete('/mcp', mcpMethodNotAllowed);

  return app;
}

/** Boot the engine, then start the HTTP server. */
export async function start() {
  console.log(`[asp] booting Theia engine (this warms market-data monitors)...`);
  const engine = await bootEngine();
  const app = createApp(engine);
  const port = config.server.port;
  app.listen(port, () => {
    console.log(`[asp] Theia ASP listening on :${port}`);
    console.log(`[asp] manifest: ${config.server.publicUrl}/  | x402 mode: ${paymentInfo().mode}`);
    console.log(`[asp] skills: ${SKILLS.map((s) => s.name).join(', ')}`);
  });
  return { app, engine };
}

// Run when invoked directly (node asp/server.js).
const isMain = process.argv[1] && process.argv[1].endsWith('server.js');
if (isMain) {
  start().catch((e) => { console.error(`[asp] fatal: ${e.stack || e.message}`); process.exit(1); });
}

export default { createApp, start };
