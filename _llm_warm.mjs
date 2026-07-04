const KEY = 'sk_live_0jlIlIrUDbxzKLKoy7OSogxXGdw3kma0F1sJ6Iy4n3_o9V-E7k_aaVLkuXotffspo';
const M = 'deepseek-ai/DeepSeek-V3-0324';
async function one(n) {
  const t = Date.now();
  try {
    const r = await fetch('https://api.hyperbolic.xyz/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: M, messages: [{ role: 'user', content: 'Reply with only: OK' }], max_tokens: 10, temperature: 0 }),
      signal: AbortSignal.timeout(80000),
    });
    const ms = ((Date.now() - t) / 1000).toFixed(1);
    const j = r.ok ? await r.json() : null;
    console.log(`call ${n}: ${r.ok ? 'OK' : 'HTTP ' + r.status} in ${ms}s — "${(j?.choices?.[0]?.message?.content || '').trim()}"`);
  } catch (e) { console.log(`call ${n}: FAILED in ${((Date.now() - t) / 1000).toFixed(1)}s — ${e.message}`); }
}
for (let i = 1; i <= 3; i++) await one(i);
