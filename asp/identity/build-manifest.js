// asp/identity/build-manifest.js — emit the exact OKX service array for
// `onchainos agent create --service '<json>'`, kept in sync with the skill
// registry + config. Run: node asp/identity/build-manifest.js
//
// One A2MCP service per skill (each has its own endpoint + fixed USDT fee), plus
// one A2A "Theia Deep Desk" service (escrow, negotiated). Service names are
// 5-30 char noun phrases; descriptions are 2 parts (capability / what you provide),
// no links, no tech-stack, no disclaimers, per okx-agent-identity register rules.
import { SKILLS } from '../skills/index.js';
import { config } from '../config.js';

const base = config.server.publicUrl.replace(/\/$/, '');

// Curated registration metadata per skill (the SKILL.md descriptions are longer
// and richer; these are the on-chain listing forms).
const META = {
  theia_signal: {
    name: 'Theia Confluence Signal',
    capability: 'Full confluence-scored trade read for any listed token: side, strength tier, confidence, scored reasons, and a complete trade plan with entry, stop, TP1-3 and leverage.',
    provide: 'Provide: 1. token symbol (e.g. BTC). Optional: 2. side bias LONG or SHORT.',
  },
  theia_manipulation_check: {
    name: 'Theia Manipulation Check',
    capability: 'Pump-and-dump and wash-trade risk read as a 0-100 percent score with flags, from futures-to-spot leverage, volume versus market cap, thin float, and holder concentration.',
    provide: 'Provide: 1. token symbol.',
  },
  theia_cex_flow: {
    name: 'Theia CEX Flow',
    capability: 'Direction and materiality of supply moving into or out of exchange cold custody for a token, scored against market cap; deposits flag distribution staging, withdrawals flag accumulation.',
    provide: 'Provide: 1. token symbol.',
  },
  theia_insider_scan: {
    name: 'Theia Insider Scan',
    capability: 'Largest non-exchange insider holders of a token across Ethereum and BSC ranked by percent of supply, with top-10 concentration; exchange and infrastructure wallets are filtered out.',
    provide: 'Provide: 1. token symbol. Optional: 2. max holders.',
  },
  theia_liqmap: {
    name: 'Theia Liquidation Map',
    capability: 'Leverage-liquidation heatmap for a perp: clusters of long liquidations below price and short liquidations above, each with distance, notional, and dominant leverage, plus nearest magnets.',
    provide: 'Provide: 1. token symbol with a perp market.',
  },
  theia_cex_holdings: {
    name: 'Theia Cornered Float',
    capability: 'Exchange cold-wallet concentration: for a token, how much of supply sits in CEX cold storage; for an exchange, the tokens it holds the largest share of. On-chain across Ethereum and BSC.',
    provide: 'Provide: 1. a token symbol or an exchange name.',
  },
};

const a2mcpServices = SKILLS.map((s) => {
  const m = META[s.name];
  return {
    name: m.name,
    description: `${m.capability}\n${m.provide}`,
    type: 'A2MCP',
    fee: String(s.priceUsdt),
    endpoint: `${base}/skills/${s.name}`,
  };
});

const a2aService = {
  name: 'Theia Deep Desk',
  description:
    'A full escrow-backed audit across a token set: manipulation risk, insider distribution, CEX flow, cornered float, and liquidation magnets, delivered as a structured report and released on your sign-off.\n' +
    'Provide: 1. the list of token symbols. 2. what you want assessed. 3. the budget.',
  type: 'A2A',
  fee: '', // A2A fee is negotiated; may be left empty.
};

const services = [...a2mcpServices, a2aService];

// Emit both the pretty array (for review) and the compact one-line form the CLI
// expects. Print to stdout; redirect to a file if you want it saved.
if (process.argv.includes('--compact')) {
  process.stdout.write(JSON.stringify(services));
} else {
  console.log(JSON.stringify(services, null, 2));
}

export { services, a2mcpServices, a2aService };
export default services;
