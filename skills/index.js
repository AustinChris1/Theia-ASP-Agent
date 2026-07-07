// A2MCP skill registry. Each skill: { name, title, description, priceUsdt, inputSchema, run }.
import signal from './signal.js';
import manipulation from './manipulation-check.js';
import cexFlow from './cex-flow.js';
import insider from './insider-scan.js';
import liqmap from './liqmap.js';
import cexHoldings from './cex-holdings.js';

export const SKILLS = [signal, manipulation, cexFlow, insider, liqmap, cexHoldings];

export const SKILLS_BY_NAME = Object.fromEntries(SKILLS.map((s) => [s.name, s]));

export function skillManifest() {
  return SKILLS.map((s) => ({
    name: s.name,
    title: s.title,
    description: s.description,
    priceUsdt: s.priceUsdt,
    inputSchema: s.inputSchema,
  }));
}

export default SKILLS;
