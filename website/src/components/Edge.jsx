import { edge, tech } from '../lib/content.js';
import { Reveal, Stagger, Item } from './Reveal.jsx';
import SectionHeading from './SectionHeading.jsx';
import Shot from './Shot.jsx';

export default function Edge() {
  return (
    <section className="border-t border-stone-200">
      <div className="mx-auto max-w-6xl px-6 py-24 sm:px-8 sm:py-28">
        <SectionHeading eyebrow={edge.eyebrow} heading={edge.heading} sub={edge.sub} />

        <Stagger className="mt-14 grid gap-5 lg:grid-cols-3">
          {edge.points.map((p, i) => (
            <Item key={p.title}>
              <div className="h-full rounded-2xl border border-stone-200 bg-card p-6">
                <div className="font-mono text-sm font-medium text-accent">{`0${i + 1}`}</div>
                <h3 className="mt-3 font-display text-lg font-semibold text-ink">{p.title}</h3>
                <p className="mt-2.5 text-[14px] leading-relaxed text-stone-600">{p.body}</p>
              </div>
            </Item>
          ))}
        </Stagger>

        {/* real win-rate scoreboard, straight from the bot */}
        <Reveal className="mt-6">
          <div className="grid items-center gap-12 rounded-3xl border border-stone-200 bg-card p-8 sm:p-10 lg:grid-cols-[1fr_auto] lg:gap-16">
            <div className="max-w-lg">
              <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent">Receipts</div>
              <h3 className="mt-3 font-display text-2xl font-semibold leading-tight text-ink sm:text-[1.7rem]">{edge.receipts.title}</h3>
              <p className="mt-4 text-[15px] leading-relaxed text-stone-600">{edge.receipts.body}</p>
            </div>
            <Shot
              src="/Stats.jpg"
              alt="Signal stats: win rate broken out by strength tier and by trigger"
              caption={edge.receipts.caption}
              className="mx-auto w-full max-w-[236px]"
            />
          </div>
        </Reveal>

        {/* dark punctuation panel for the tech credibility */}
        <Reveal className="mt-6">
          <div className="rounded-3xl bg-ink p-8 text-paper sm:p-10">
            <h3 className="font-display text-xl font-medium">{tech.heading}</h3>
            <p className="mt-2 text-sm text-paper/55">{tech.sub}</p>
            <div className="mt-8 grid gap-x-10 gap-y-7 sm:grid-cols-2 lg:grid-cols-3">
              {tech.items.map((t) => (
                <div key={t.label} className="border-t border-white/10 pt-4">
                  <div className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-sky-400">{t.label}</div>
                  <div className="mt-1.5 text-[13.5px] leading-snug text-paper/70">{t.body}</div>
                </div>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
