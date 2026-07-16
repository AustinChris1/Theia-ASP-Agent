import { AbsoluteFill, Sequence, useCurrentFrame, interpolate, spring, useVideoConfig } from 'remotion';
import data from './data.json';

const C = {
  bg: '#060d18', panel: '#0b1626', panel2: '#0a1422', edge: '#173352', cyan: '#22d3ee',
  text: '#e6f1ff', dim: '#7d97b0', faint: '#48607a', green: '#4ade80', red: '#f87171', amber: '#fbbf24',
};
const MONO = 'ui-monospace, "Cascadia Code", "Fira Code", Consolas, monospace';
const SANS = '"Segoe UI", Inter, system-ui, sans-serif';

const TOTAL = 2670;
const usd = (n) => n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(0)}M` : `$${Math.round(n).toLocaleString()}`;
const short = (a) => `${a.slice(0, 8)}…${a.slice(-6)}`;
// eased 0..1 reveal
const rev = (f, s, d = 20) => interpolate(f, [s, s + d], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: (t) => 1 - Math.pow(1 - t, 3) });

const Bg = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ background: `radial-gradient(1500px 900px at 50% 32%, #12293f 0%, ${C.bg} 64%)` }} />
      <AbsoluteFill style={{
        backgroundImage: `linear-gradient(${C.edge} 1px, transparent 1px), linear-gradient(90deg, ${C.edge} 1px, transparent 1px)`,
        backgroundSize: '64px 64px', opacity: 0.13,
        transform: `translateY(${(f * 0.22) % 64}px)`,
      }} />
    </AbsoluteFill>
  );
};

// Persistent chrome so no scene is a lone panel on empty background.
const Chrome = ({ skill, step }) => {
  const f = useCurrentFrame();
  const pulse = 0.55 + 0.45 * Math.sin(f / 7);
  return (
    <>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 4, background: '#0a1422' }}>
        <div style={{ height: '100%', width: `${(step / TOTAL) * 100}%`, background: C.cyan, opacity: 0.9 }} />
      </div>
      <div style={{ position: 'absolute', top: 30, left: 54, right: 54, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
          <div style={{ width: 30, height: 30, borderRadius: 999, background: `radial-gradient(circle at 42% 40%, #7ee7f5 0 14%, #0a1422 15% 36%, ${C.cyan} 37% 44%, #123049 45% 100%)` }} />
          <div style={{ fontFamily: SANS, fontSize: 25, fontWeight: 700, color: C.text, letterSpacing: 0.4 }}>Theia</div>
          <div style={{ fontFamily: MONO, fontSize: 19, color: C.faint }}>Agent #6004</div>
        </div>
        {skill && <div style={{ fontFamily: MONO, fontSize: 20, color: C.cyan, letterSpacing: 1 }}>{skill}</div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 9, height: 9, borderRadius: 9, background: C.green, opacity: pulse }} />
          <div style={{ fontFamily: MONO, fontSize: 18, color: C.dim }}>LIVE · X Layer 196</div>
        </div>
      </div>
    </>
  );
};

const Caption = ({ children }) => (
  <div style={{ position: 'absolute', bottom: 46, left: 0, right: 0, textAlign: 'center', padding: '0 150px' }}>
    <span style={{
      fontFamily: SANS, fontSize: 33, fontWeight: 500, lineHeight: 1.45, color: C.text,
      background: 'rgba(4,10,20,.82)', padding: '11px 20px', borderRadius: 10,
      WebkitBoxDecorationBreak: 'clone', boxDecorationBreak: 'clone',
    }}>{children}</span>
  </div>
);

const Stage = ({ children }) => (
  <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', paddingTop: 34, paddingBottom: 96 }}>{children}</AbsoluteFill>
);

const Panel = ({ title, children, style }) => (
  <div style={{ background: C.panel, border: `1px solid ${C.edge}`, borderRadius: 14, boxShadow: '0 26px 80px rgba(0,0,0,.5)', overflow: 'hidden', ...style }}>
    {title && (
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '11px 18px', borderBottom: `1px solid ${C.edge}`, background: C.panel2 }}>
        <div style={{ width: 11, height: 11, borderRadius: 9, background: '#ff5f57' }} />
        <div style={{ width: 11, height: 11, borderRadius: 9, background: '#febc2e' }} />
        <div style={{ width: 11, height: 11, borderRadius: 9, background: '#28c840' }} />
        <div style={{ marginLeft: 11, fontFamily: MONO, fontSize: 16, color: C.dim }}>{title}</div>
      </div>
    )}
    <div style={{ padding: '18px 24px' }}>{children}</div>
  </div>
);

const Title = () => {
  const f = useCurrentFrame(); const { fps } = useVideoConfig();
  const s = spring({ frame: f, fps, config: { damping: 200 } });
  const o2 = rev(f, 40, 26);
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ transform: `scale(${interpolate(s, [0, 1], [0.9, 1])})`, opacity: s, textAlign: 'center' }}>
        <div style={{ width: 132, height: 132, borderRadius: 999, margin: '0 auto 26px', background: `radial-gradient(circle at 42% 40%, #7ee7f5 0 12%, #0a1422 13% 34%, ${C.cyan} 35% 41%, #123049 42% 100%)`, boxShadow: `0 0 80px rgba(34,211,238,.45)` }} />
        <div style={{ fontFamily: SANS, fontSize: 104, fontWeight: 700, color: C.text, letterSpacing: -1 }}>Theia</div>
        <div style={{ fontFamily: MONO, fontSize: 29, color: C.cyan, marginTop: 10 }}>Crypto intelligence, sold to agents</div>
      </div>
      <div style={{ opacity: o2, display: 'flex', gap: 40, marginTop: 46, fontFamily: MONO, fontSize: 21, color: C.dim }}>
        <span>Agent #6004</span><span style={{ color: C.faint }}>│</span>
        <span>6 skills</span><span style={{ color: C.faint }}>│</span>
        <span>x402 · A2MCP · A2A</span>
      </div>
      <Caption>AI agents can trade now. They just cannot see.</Caption>
    </AbsoluteFill>
  );
};

// --- Signal: terminal (left) + confidence gauge & plan ladder (right) ---
const Signal = () => {
  const f = useCurrentFrame();
  const d = data.signal;
  const cmd = `curl -X POST .../skills/theia_signal -d '{"token":"${d.token}"}'`;
  const n = Math.floor(interpolate(f, [0, 38], [0, cmd.length], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
  const conf = Math.round(d.confidence * rev(f, 52, 40));

  const p = d.plan;
  const lo = Math.min(p.sl, p.entry), hi = p.tp3;
  const pos = (v) => 100 - ((v - lo) / (hi - lo)) * 100;
  const rungs = [
    { k: 'TP3', v: p.tp3, c: C.green }, { k: 'TP2', v: p.tp2, c: C.green },
    { k: 'TP1', v: p.tp1, c: C.green }, { k: 'entry', v: p.entry, c: C.cyan }, { k: 'stop', v: p.sl, c: C.red },
  ];

  return (
    <Stage>
      <div style={{ display: 'flex', gap: 22, alignItems: 'stretch' }}>
        <Panel title={`theia_signal · ${d.token}`} style={{ width: 1090 }}>
          <div style={{ fontFamily: MONO, fontSize: 19, lineHeight: 1.62, minHeight: 476 }}>
            <div style={{ color: C.text, marginBottom: 10 }}>
              <span style={{ color: C.green }}>$ </span>{cmd.slice(0, n)}
              {f < 44 && <span style={{ color: C.cyan }}>▋</span>}
            </div>
            {f > 46 && <div style={{ color: C.faint }}>{'{'}</div>}
            {f > 50 && (
              <div style={{ fontSize: 25, color: C.text, opacity: rev(f, 50, 14) }}>
                {'  '}"side": <span style={{ color: C.green, fontWeight: 700 }}>"{d.side}"</span>,{'  '}
                "confidence": <span style={{ color: C.cyan, fontWeight: 700 }}>{conf}</span>,{'  '}
                "tier": <span style={{ color: C.amber }}>"{d.tier}"</span>
              </div>
            )}
            {f > 96 && <div style={{ color: C.faint, marginTop: 8 }}>{'  "reasons": ['}</div>}
            {d.reasons.map((r, i) => {
              const s = 108 + i * 24;
              if (f < s) return null;
              return (
                <div key={i} style={{ opacity: rev(f, s, 12), transform: `translateX(${interpolate(rev(f, s, 12), [0, 1], [-14, 0])}px)`, color: r.points > 0 ? C.green : C.red, whiteSpace: 'nowrap' }}>
                  {'    '}{r.text.slice(0, 54)} <span style={{ color: C.faint }}>({r.points > 0 ? '+' : ''}{r.points})</span>
                </div>
              );
            })}
            {f > 240 && <div style={{ color: C.faint, opacity: rev(f, 240, 12) }}>{'  ],'}</div>}
            {f > 252 && <div style={{ color: C.faint, opacity: rev(f, 252, 12) }}>{'  "tradePlan": { … }'}</div>}
            {f > 264 && <div style={{ color: C.faint, opacity: rev(f, 264, 12) }}>{'}'}</div>}
          </div>
        </Panel>

        <Panel title="trade plan" style={{ width: 470 }}>
          <div style={{ minHeight: 476, position: 'relative' }}>
            <div style={{ fontFamily: MONO, fontSize: 16, color: C.dim, marginBottom: 6 }}>deterministic levels</div>
            <div style={{ position: 'relative', height: 384, marginTop: 10, borderLeft: `2px solid ${C.edge}`, marginLeft: 8 }}>
              {rungs.map((r, i) => {
                const s = 300 + i * 26;
                const o = rev(f, s, 18);
                return (
                  <div key={r.k} style={{ position: 'absolute', top: `${pos(r.v)}%`, left: 0, right: 0, opacity: o, transform: `translate(${interpolate(o, [0, 1], [18, 0])}px, -50%)`, display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 22, height: 2, background: r.c }} />
                    <div style={{ width: 9, height: 9, borderRadius: 9, background: r.c }} />
                    <div style={{ fontFamily: MONO, fontSize: 17, color: C.dim, width: 46 }}>{r.k}</div>
                    <div style={{ fontFamily: MONO, fontSize: 21, color: r.c, fontWeight: r.k === 'entry' ? 700 : 400 }}>{r.v.toLocaleString()}</div>
                  </div>
                );
              })}
            </div>
            <div style={{ opacity: rev(f, 440, 22), display: 'flex', gap: 26, marginTop: 16, fontFamily: MONO }}>
              <div><div style={{ fontSize: 15, color: C.faint }}>R:R</div><div style={{ fontSize: 27, color: C.text }}>{p.rr1}</div></div>
              <div><div style={{ fontSize: 15, color: C.faint }}>leverage</div><div style={{ fontSize: 27, color: C.text }}>{p.lev}x</div></div>
              <div><div style={{ fontSize: 15, color: C.faint }}>horizon</div><div style={{ fontSize: 27, color: C.cyan }}>{p.horizon}</div></div>
            </div>
          </div>
        </Panel>
      </div>
      <Caption>One call: a side, a scored confidence, every reason it fired, and a full trade plan.</Caption>
    </Stage>
  );
};

// --- x402 paywall ---
const Paywall = () => {
  const f = useCurrentFrame();
  const rows = [
    ['scheme', '"exact"', C.text], ['network', '"eip155:196"', C.cyan],
    ['asset', '"0x779ded…713736"  // USDT', C.text], ['payTo', '"0xa81fb868…2003"', C.text],
  ];
  const steps = [['Agent calls the skill', 60], ['402 + payment terms', 120], ['Signs USDT on X Layer', 180], ['Replays, gets data', 240]];
  return (
    <Stage>
      <div style={{ display: 'flex', gap: 22 }}>
        <Panel title="x402 · live endpoint" style={{ width: 1010 }}>
          <div style={{ fontFamily: MONO, fontSize: 19, lineHeight: 1.6, minHeight: 400 }}>
            <div style={{ color: C.text, marginBottom: 12 }}><span style={{ color: C.green }}>$ </span>curl -i -X POST .../skills/theia_signal</div>
            <div style={{ opacity: rev(f, 40, 14), fontSize: 32, color: C.amber, fontWeight: 700, marginBottom: 10 }}>HTTP/1.1 402 Payment Required</div>
            <div style={{ opacity: rev(f, 58, 14), color: C.faint, marginBottom: 16, whiteSpace: 'nowrap' }}>PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6MSwiYWNjZXB0cyI6…</div>
            {rows.map(([k, v, c], i) => (
              <div key={k} style={{ opacity: rev(f, 78 + i * 18, 14) }}>
                <span style={{ color: C.faint }}>{'  '}{k.padEnd(9)}</span><span style={{ color: c }}>{v}</span>
              </div>
            ))}
            <div style={{ opacity: rev(f, 168, 18), marginTop: 20, fontSize: 22, color: C.green }}>→ pays in USDT, replays, gets the signal</div>
          </div>
        </Panel>
        <Panel title="flow" style={{ width: 470 }}>
          <div style={{ minHeight: 400, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 20 }}>
            {steps.map(([s, at], i) => {
              const o = rev(f, at, 20);
              return (
                <div key={i} style={{ opacity: 0.28 + 0.72 * o, display: 'flex', alignItems: 'center', gap: 14 }}>
                  <div style={{ width: 34, height: 34, borderRadius: 999, border: `2px solid ${o > 0.6 ? C.cyan : C.edge}`, color: o > 0.6 ? C.cyan : C.faint, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontSize: 17 }}>{i + 1}</div>
                  <div style={{ fontFamily: SANS, fontSize: 22, color: o > 0.6 ? C.text : C.faint }}>{s}</div>
                </div>
              );
            })}
            <div style={{ opacity: rev(f, 250, 20), marginTop: 12, padding: '14px 16px', background: C.panel2, borderRadius: 10, border: `1px solid ${C.edge}` }}>
              <div style={{ fontFamily: MONO, fontSize: 15, color: C.faint }}>no account · no API key</div>
              <div style={{ fontFamily: MONO, fontSize: 15, color: C.faint }}>no subscription</div>
            </div>
          </div>
        </Panel>
      </div>
      <Caption>No signup. The agent hits a 402, pays cents of USDT on X Layer, and replays.</Caption>
    </Stage>
  );
};

// --- Manipulation ---
const Manip = () => {
  const f = useCurrentFrame();
  const d = data.manip;
  const g = rev(f, 14, 44);
  const m = d.measured || {};
  const bars = [
    { k: 'futures 24h vol', v: m.futuresToSpotRatio, unit: '× spot', w: Math.min(100, (m.futuresToSpotRatio / 2) * 100), c: C.red },
    { k: 'volume / market cap', v: m.volumeToMarketCap, unit: '×', w: Math.min(100, (m.volumeToMarketCap / 2) * 100), c: C.amber },
    { k: 'circulating float', v: m.circulatingFloatPct, unit: '%', w: m.circulatingFloatPct, c: C.amber },
  ];
  return (
    <Stage>
      <div style={{ display: 'flex', gap: 22 }}>
        <Panel title={`theia_manipulation_check · ${d.token}`} style={{ width: 900 }}>
          <div style={{ minHeight: 420, fontFamily: MONO }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
              <div style={{ fontSize: 104, fontWeight: 700, color: C.red, fontFamily: SANS, lineHeight: 1.05 }}>{Math.round(d.riskPct * g)}%</div>
              <div>
                <div style={{ fontSize: 30, color: C.red, textTransform: 'uppercase', letterSpacing: 2 }}>{d.level}</div>
                <div style={{ fontSize: 19, color: C.dim }}>manipulation risk</div>
              </div>
            </div>
            <div style={{ height: 15, background: C.panel2, borderRadius: 8, overflow: 'hidden', margin: '16px 0 30px' }}>
              <div style={{ width: `${d.riskPct * g}%`, height: '100%', background: `linear-gradient(90deg, ${C.amber}, ${C.red})` }} />
            </div>
            {bars.map((b, i) => {
              const o = rev(f, 70 + i * 30, 24);
              return (
                <div key={i} style={{ opacity: o, marginBottom: 20 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 19, color: C.dim, marginBottom: 6 }}>
                    <span>{b.k}</span><span style={{ color: b.c, fontSize: 23, fontWeight: 700 }}>{b.v}{b.unit}</span>
                  </div>
                  <div style={{ height: 12, background: C.panel2, borderRadius: 6, overflow: 'hidden' }}>
                    <div style={{ width: `${b.w * o}%`, height: '100%', background: b.c, opacity: 0.85 }} />
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
        <Panel title="flags raised" style={{ width: 580 }}>
          <div style={{ minHeight: 420, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 18 }}>
            {d.flags.map((fl, i) => {
              const o = rev(f, 160 + i * 34, 22);
              return (
                <div key={i} style={{ opacity: o, transform: `translateX(${interpolate(o, [0, 1], [22, 0])}px)`, display: 'flex', alignItems: 'center', gap: 14, padding: '16px 18px', background: 'rgba(248,113,113,.09)', border: `1px solid rgba(248,113,113,.34)`, borderRadius: 10 }}>
                  <div style={{ fontSize: 26 }}>⚠</div>
                  <div style={{ fontFamily: MONO, fontSize: 23, color: C.red }}>{fl}</div>
                </div>
              );
            })}
          </div>
        </Panel>
      </div>
      <Caption>Is it being manipulated? Traded more in futures than spot, at twice its own market cap.</Caption>
    </Stage>
  );
};

// --- Insider: the moat ---
const Insider = () => {
  const f = useCurrentFrame();
  const d = data.insider;
  const g = rev(f, 16, 42);
  const R = 92, CIRC = 2 * Math.PI * R;
  return (
    <Stage>
      <div style={{ display: 'flex', gap: 22 }}>
        <Panel title={`theia_insider_scan · ${d.token}`} style={{ width: 1030 }}>
          <div style={{ minHeight: 420, fontFamily: MONO }}>
            <div style={{ fontSize: 19, color: C.dim, marginBottom: 16 }}>largest non-exchange holders. Exchange, burn and bridge wallets filtered out</div>
            {d.holders.map((h, i) => {
              const o = rev(f, 60 + i * 30, 24);
              const big = h.pct > 10;
              return (
                <div key={i} style={{ opacity: o, display: 'flex', alignItems: 'center', gap: 16, marginBottom: 15 }}>
                  <div style={{ fontSize: 19, color: C.faint, width: 26 }}>{i + 1}</div>
                  <div style={{ fontSize: 19, color: C.dim, width: 200 }}>{short(h.addr)}</div>
                  <div style={{ flex: 1, height: 26, background: C.panel2, borderRadius: 6, overflow: 'hidden' }}>
                    <div style={{ width: `${Math.min(100, (h.pct / 30) * 100) * o}%`, height: '100%', background: big ? C.red : C.cyan, opacity: 0.85 }} />
                  </div>
                  <div style={{ fontSize: 26, color: big ? C.red : C.text, width: 120, textAlign: 'right', fontWeight: big ? 700 : 400 }}>{h.pct}%</div>
                </div>
              );
            })}
            <div style={{ opacity: rev(f, 240, 24), marginTop: 18, fontSize: 21, color: C.dim }}>
              scanned <span style={{ color: C.text }}>{d.holderCount}</span> holders across Ethereum and BSC
            </div>
          </div>
        </Panel>
        <Panel title="top-10 concentration" style={{ width: 450 }}>
          <div style={{ minHeight: 420, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <svg width={240} height={240} style={{ transform: 'rotate(-90deg)' }}>
              <circle cx={120} cy={120} r={R} fill="none" stroke={C.panel2} strokeWidth={26} />
              <circle cx={120} cy={120} r={R} fill="none" stroke={C.red} strokeWidth={26} strokeLinecap="round"
                strokeDasharray={CIRC} strokeDashoffset={CIRC * (1 - (d.top10 / 100) * g)} />
            </svg>
            <div style={{ position: 'absolute', textAlign: 'center' }}>
              <div style={{ fontFamily: SANS, fontSize: 62, fontWeight: 700, color: C.red }}>{Math.round(d.top10 * g)}%</div>
              <div style={{ fontFamily: MONO, fontSize: 16, color: C.dim }}>top 10 wallets</div>
            </div>
            <div style={{ opacity: rev(f, 250, 24), marginTop: 30, textAlign: 'center', fontFamily: MONO, fontSize: 19, color: C.dim }}>
              one wallet alone holds<br /><span style={{ color: C.red, fontSize: 34, fontWeight: 700 }}>{d.holders[0]?.pct}%</span>
            </div>
          </div>
        </Panel>
      </div>
      <Caption>Are insiders holding the float? One wallet holds {d.holders[0]?.pct}% of the supply.</Caption>
    </Stage>
  );
};

// --- Liquidation map ---
const LiqMap = () => {
  const f = useCurrentFrame();
  const d = data.liqmap;
  const rows = [...d.above.map((x) => ({ ...x, side: 'short' })), ...d.below.map((x) => ({ ...x, side: 'long' }))].sort((a, b) => b.price - a.price);
  const max = Math.max(...rows.map((r) => r.usd));
  return (
    <Stage>
      <div style={{ display: 'flex', gap: 22 }}>
        <Panel title={`theia_liqmap · ${d.token}`} style={{ width: 1140 }}>
          <div style={{ minHeight: 420, fontFamily: MONO, fontSize: 19 }}>
            <div style={{ color: C.dim, marginBottom: 16 }}>liquidation clusters, priced to where leverage dies</div>
            {rows.map((r, i) => {
              const o = rev(f, 30 + i * 26, 22);
              const isPrice = false;
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 13, opacity: o }}>
                  <div style={{ width: 116, color: C.text, textAlign: 'right', fontSize: 21 }}>{r.price.toLocaleString()}</div>
                  <div style={{ width: 74, color: r.dist > 0 ? C.red : C.green, fontSize: 17 }}>{r.dist > 0 ? '+' : ''}{r.dist}%</div>
                  <div style={{ flex: 1, height: 26, background: C.panel2, borderRadius: 6, overflow: 'hidden' }}>
                    <div style={{ width: `${(r.usd / max) * 100 * o}%`, height: '100%', background: r.side === 'short' ? C.red : C.green, opacity: 0.82 }} />
                  </div>
                  <div style={{ width: 92, color: r.side === 'short' ? C.red : C.green, fontSize: 21 }}>{usd(r.usd)}</div>
                  <div style={{ width: 58, color: C.faint, fontSize: 17 }}>{r.lev}x</div>
                </div>
              );
            })}
            <div style={{ opacity: rev(f, 210, 24), marginTop: 22, fontFamily: MONO, fontSize: 19, color: C.faint }}>
              spot price {d.price?.toLocaleString()} · clusters priced from open interest and leverage bands
            </div>
          </div>
        </Panel>
        <Panel title="total exposure" style={{ width: 420 }}>
          <div style={{ minHeight: 420, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 34 }}>
            <div style={{ opacity: rev(f, 150, 26) }}>
              <div style={{ fontFamily: MONO, fontSize: 17, color: C.dim, marginBottom: 6 }}>above price (shorts)</div>
              <div style={{ fontFamily: SANS, fontSize: 54, fontWeight: 700, color: C.red }}>{usd(d.totalAbove)}</div>
            </div>
            <div style={{ opacity: rev(f, 185, 26) }}>
              <div style={{ fontFamily: MONO, fontSize: 17, color: C.dim, marginBottom: 6 }}>below price (longs)</div>
              <div style={{ fontFamily: SANS, fontSize: 54, fontWeight: 700, color: C.green }}>{usd(d.totalBelow)}</div>
            </div>
            <div style={{ opacity: rev(f, 240, 26), fontFamily: MONO, fontSize: 18, color: C.faint, lineHeight: 1.5 }}>
              billions in leverage, mapped to the price that kills it
            </div>
          </div>
        </Panel>
      </div>
      <Caption>And where the liquidation magnets sit, so an agent knows what price hunts it.</Caption>
    </Stage>
  );
};

const Trust = () => {
  const f = useCurrentFrame();
  const items = [
    ['OKX-native', 'Prices, funding, OI, orderbook and CVD straight from OKX v5'],
    ['Deterministic', 'Scored in code. An LLM narrates it, but never decides'],
    ['Pay per call', 'Cents in USDT on X Layer. No account, no subscription'],
  ];
  return (
    <Stage>
      <div style={{ display: 'flex', gap: 26 }}>
        {items.map(([h, s], i) => {
          const o = rev(f, i * 16, 24);
          return (
            <div key={i} style={{ opacity: o, transform: `translateY(${interpolate(o, [0, 1], [22, 0])}px)`, width: 420, padding: '36px 30px', background: C.panel, border: `1px solid ${C.edge}`, borderRadius: 14, boxShadow: '0 22px 60px rgba(0,0,0,.45)' }}>
              <div style={{ fontFamily: SANS, fontSize: 38, fontWeight: 700, color: C.cyan, marginBottom: 14 }}>{h}</div>
              <div style={{ fontFamily: SANS, fontSize: 23, color: C.dim, lineHeight: 1.45 }}>{s}</div>
            </div>
          );
        })}
      </div>
      <Caption>Six skills. Built on OKX data, deterministic, and auditable.</Caption>
    </Stage>
  );
};

const Outro = () => {
  const f = useCurrentFrame(); const { fps } = useVideoConfig();
  const s = spring({ frame: f, fps, config: { damping: 200 } });
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ textAlign: 'center', opacity: s, transform: `scale(${interpolate(s, [0, 1], [0.94, 1])})` }}>
        <div style={{ width: 96, height: 96, borderRadius: 999, margin: '0 auto 22px', background: `radial-gradient(circle at 42% 40%, #7ee7f5 0 12%, #0a1422 13% 34%, ${C.cyan} 35% 41%, #123049 42% 100%)`, boxShadow: `0 0 60px rgba(34,211,238,.4)` }} />
        <div style={{ fontFamily: SANS, fontSize: 84, fontWeight: 700, color: C.text }}>Theia</div>
        <div style={{ fontFamily: MONO, fontSize: 31, color: C.cyan, marginTop: 12 }}>Agent #6004 · live on OKX.AI</div>
        <div style={{ fontFamily: MONO, fontSize: 23, color: C.faint, marginTop: 30 }}>#OKXAI</div>
      </div>
    </AbsoluteFill>
  );
};

const S = [
  { c: Title, from: 0, dur: 180, skill: null },
  { c: Signal, from: 180, dur: 570, skill: 'theia_signal' },
  { c: Paywall, from: 750, dur: 330, skill: 'x402 · pay per call' },
  { c: Manip, from: 1080, dur: 420, skill: 'theia_manipulation_check' },
  { c: Insider, from: 1500, dur: 450, skill: 'theia_insider_scan' },
  { c: LiqMap, from: 1950, dur: 390, skill: 'theia_liqmap' },
  { c: Trust, from: 2340, dur: 210, skill: null },
  { c: Outro, from: 2550, dur: 120, skill: null },
];

export const Demo = () => {
  const f = useCurrentFrame();
  const cur = S.filter((s) => f >= s.from).pop();
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <Bg />
      {S.map((s, i) => (
        <Sequence key={i} from={s.from} durationInFrames={s.dur}><s.c /></Sequence>
      ))}
      <Chrome skill={cur?.skill} step={f} />
    </AbsoluteFill>
  );
};
