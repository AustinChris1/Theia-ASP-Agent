import { motion } from 'framer-motion';
import { brand, hero, stats } from '../lib/content.js';
import { EASE, CountUp } from './Reveal.jsx';
import Shot from './Shot.jsx';

const lineV = {
  hidden: { y: '120%' },
  show: (i) => ({ y: 0, transition: { duration: 0.85, delay: 0.08 + i * 0.09, ease: EASE } }),
};
const fadeV = {
  hidden: { opacity: 0, y: 14 },
  show: (i) => ({ opacity: 1, y: 0, transition: { duration: 0.7, delay: 0.45 + i * 0.08, ease: EASE } }),
};

function Line({ i, className = '', children }) {
  return (
    <span className="block overflow-hidden pb-[0.06em]">
      <motion.span className={`block ${className}`} custom={i} variants={lineV} initial="hidden" animate="show">
        {children}
      </motion.span>
    </span>
  );
}

export default function Hero() {
  return (
    <section id="top" className="relative overflow-hidden">
      {/* soft accent wash, no grid */}
      <div className="pointer-events-none absolute -right-40 -top-40 -z-10 h-[560px] w-[560px] rounded-full bg-accent/10 blur-[120px]" />
      <div className="pointer-events-none absolute -left-40 top-40 -z-10 h-[420px] w-[420px] rounded-full bg-amber-200/30 blur-[130px]" />

      <div className="mx-auto grid max-w-6xl items-center gap-16 px-6 pb-20 pt-36 sm:px-8 lg:grid-cols-[1.05fr_0.95fr] lg:pt-44">
        <div>
          <motion.div
            custom={0}
            variants={fadeV}
            initial="hidden"
            animate="show"
            className="inline-flex items-center gap-2 rounded-full border border-stone-300/80 bg-card/60 px-3.5 py-1.5 font-mono text-[11px] tracking-tight text-stone-600"
          >
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
            </span>
            {hero.badge}
          </motion.div>

          <h1 className="mt-7 font-display text-[2.7rem] font-medium leading-[1.0] tracking-[-0.02em] text-ink sm:text-[3.9rem] lg:text-[4.4rem]">
            <Line i={0}>{hero.titleLead}</Line>
            <Line i={1} className="italic text-accent">{hero.titleAccent}</Line>
            <Line i={2}>{hero.titleTail}</Line>
          </h1>

          <motion.p
            custom={1}
            variants={fadeV}
            initial="hidden"
            animate="show"
            className="mt-7 max-w-xl text-[16px] leading-relaxed text-stone-600"
          >
            {hero.sub}
          </motion.p>

          <motion.div custom={2} variants={fadeV} initial="hidden" animate="show" className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-4">
            <a
              href={brand.telegram}
              target="_blank"
              rel="noreferrer"
              className="rounded-full bg-ink px-6 py-3 text-sm font-semibold text-paper transition-transform duration-200 hover:-translate-y-0.5"
            >
              {hero.ctaPrimary}
            </a>
            <a href="#how" className="group inline-flex items-center gap-1.5 text-sm font-semibold text-ink">
              {hero.ctaSecondary}
              <span className="transition-transform duration-200 group-hover:translate-x-1">{'→'}</span>
            </a>
          </motion.div>

          <motion.div
            custom={3}
            variants={fadeV}
            initial="hidden"
            animate="show"
            className="mt-14 grid max-w-lg grid-cols-2 gap-x-6 gap-y-6 border-t border-stone-200 pt-8 sm:grid-cols-4"
          >
            {stats.map((s) => (
              <div key={s.label}>
                <CountUp value={s.value} className="font-mono text-2xl font-medium text-ink" />
                <div className="mt-1 text-[11.5px] leading-tight text-stone-500">{s.label}</div>
              </div>
            ))}
          </motion.div>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 28 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.3, ease: EASE }}
          className="flex justify-center lg:justify-end"
        >
          <Shot
            src="/Signal.jpg"
            alt="A real Theia long signal on THE, fully reasoned with a trade plan"
            cropClass="max-h-[540px]"
            fade
            hint="Read the full alert"
            className="w-full max-w-[300px]"
          />
        </motion.div>
      </div>
    </section>
  );
}
