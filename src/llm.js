// Optional LLM layer (Hyperbolic — OpenAI-compatible chat completions).
//
// Used ONLY for LANGUAGE tasks on the periphery: writing the /brief narrative,
// understanding news headlines. NEVER in the trade-decision path — scoring, sizing
// and firing stay deterministic and auditable. An LLM there would add latency,
// non-determinism and hallucination to a money decision, which is strictly worse.
//
// FAIL-SOFT by contract: every function returns null on any failure (no key, HTTP
// error, timeout, bad shape) so callers fall straight back to their non-LLM logic.
// Enabled only when HYPERBOLIC_API_KEY (or LLM_API_KEY) is set; off by default.

const BASE = (process.env.HYPERBOLIC_BASE_URL || 'https://api.hyperbolic.xyz/v1').replace(/\/+$/, '');
// Model IDs are account-specific. Hyperbolic's ambassador/free tier exposes only
// large models (deepseek-ai/DeepSeek-V3-0324, meta-llama/Llama-3.3-70B-Instruct,
// deepseek-ai/DeepSeek-R1, Qwen/Qwen3-Coder-480B-A35B-Instruct) — all of which are
// SLOW (30-45s+), so this layer is best for BACKGROUND tasks, not interactive ones.
const DEFAULT_MODEL = process.env.LLM_MODEL || 'deepseek-ai/DeepSeek-V3-0324';
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 45_000);

const apiKey = () => process.env.HYPERBOLIC_API_KEY || process.env.LLM_API_KEY || null;

export function llmEnabled() { return !!apiKey(); }

// One-line boot status so it's visible in the logs whether the LLM is wired and where.
export function llmStatus() {
  if (!apiKey()) return null;
  return { base: BASE, model: DEFAULT_MODEL, briefOn: process.env.LLM_BRIEF === '1' };
}

// One chat completion. Returns the assistant text, or null on ANY failure.
export async function llmChat({ system = null, user, model = DEFAULT_MODEL, maxTokens = 400, temperature = 0.4 } = {}) {
  const key = apiKey();
  if (!key || !user) return null;
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
        temperature,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) { console.warn(`[llm] HTTP ${res.status}`); return null; }
    const j = await res.json();
    const text = j?.choices?.[0]?.message?.content;
    return (typeof text === 'string' && text.trim()) ? text.trim() : null;
  } catch (err) {
    console.warn(`[llm] chat failed: ${err.message}`);
    return null;
  }
}

// Telegram-Markdown safety: LLM prose can contain *, _, [, ], ` that break the
// parser mid-message. Escape them so the paragraph renders literally. Also strips
// stray leading/trailing quotes/backticks a model sometimes wraps output in.
export function escapeTgMarkdown(s) {
  return String(s ?? '')
    .replace(/^["'`\s]+|["'`\s]+$/g, '')
    .replace(/([_*\[\]`])/g, '\\$1');
}
