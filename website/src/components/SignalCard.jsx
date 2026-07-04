import { motion } from 'framer-motion';
import { hero } from '../lib/content.js';
import { EASE } from './Reveal.jsx';

// Dark "terminal" mockup of a real alert. The deliberate dark-on-light contrast
// reads as "the product" sitting on the page.
export default function SignalCard() {
  const s = hero.signal;
  return (
    <div className="relative w-full max-w-md">
      <div className="absolute -inset-4 -z-10 rounded-[28px] bg-ink/5 blur-2xl" />
      <div className="overflow-hidden rounded-2xl border border-ink/10 bg-[#16140f] shadow-[0_24px_70px_-30px_rgba(0,0,0,0.55)]">
        {/* title bar */}
        <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-3">
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-rose-400/80" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-300/70" />
            <span className="h-2.5 w-2.5 rounded-full bg-sky-400/70" />
          </div>
          <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-white/35">signal</span>
        </div>

        <div className="p-5">
          <div className="flex items-center justify-between">
            <div className="font-mono text-[15px] font-medium text-rose-300">
              {s.side} · {s.symbol}
            </div>
            <span className="rounded-md border border-rose-400/25 bg-rose-400/10 px-2 py-0.5 font-mono text-[10.5px] font-medium text-rose-300">
              {s.tier}
            </span>
          </div>
          <div className="mt-1.5 font-mono text-[11.5px] text-white/40">
            {s.confidence} confidence · {s.trigger}
          </div>

          <div className="mt-4 space-y-2.5">
            {s.rows.map((r, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: -6 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, margin: '-40px' }}
                transition={{ delay: 0.15 + i * 0.11, duration: 0.45, ease: EASE }}
                className="flex items-start gap-2.5 text-[13px] leading-snug text-white/75"
              >
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-sky-400" />
                <span>{r}</span>
              </motion.div>
            ))}
          </div>

          <div className="mt-4 rounded-xl border border-white/[0.07] bg-white/[0.025] p-3.5">
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/35">Trade plan</div>
            <div className="mt-2 space-y-1.5">
              {s.plan.map((p, i) => (
                <div key={i} className="font-mono text-[12px] text-white/55">{p}</div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
