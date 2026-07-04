const KEY = 'sk_live_0jlIlIrUDbxzKLKoy7OSogxXGdw3kma0F1sJ6Iy4n3_o9V-E7k_aaVLkuXotffspo';
const BASE = 'https://api.hyperbolic.xyz/v1/chat/completions';
// First, print the FULL available-model list from the error
const r0 = await fetch(BASE, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` }, body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }) });
console.log('AVAILABLE:', (await r0.text()).slice(0, 400));
console.log('---');
async function timed(model) {
  const t = Date.now();
  try {
    const r = await fetch(BASE, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'In one sentence: what is a short squeeze?' }], max_tokens: 60, temperature: 0.3 }), signal: AbortSignal.timeout(45000) });
    const ms = Date.now() - t;
    const j = r.ok ? await r.json() : null;
    console.log(`${model.padEnd(40)} ${r.ok ? 'OK' : 'HTTP ' + r.status} in ${ms}ms ${j ? '— "' + (j?.choices?.[0]?.message?.content||'').slice(0,70) + '"' : ''}`);
  } catch (e) { console.log(`${model.padEnd(40)} FAILED ${Date.now()-t}ms — ${e.message}`); }
}
for (const m of ['deepseek-ai/DeepSeek-V3-0324', 'meta-llama/Llama-3.3-70B-Instruct']) { await timed(m); await timed(m); }
