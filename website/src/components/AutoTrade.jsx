import { autotrade } from '../lib/content.js';
import { Reveal, Stagger, Item } from './Reveal.jsx';
import SectionHeading from './SectionHeading.jsx';
import Shot from './Shot.jsx';

export default function AutoTrade() {
  const s = autotrade.showcase;
  return (
    <section id="autotrade" className="border-t border-stone-200">
      <div className="mx-auto max-w-6xl px-6 py-24 sm:px-8 sm:py-28">
        <SectionHeading eyebrow={autotrade.eyebrow} heading={autotrade.heading} sub={autotrade.sub} />
        <Stagger className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {autotrade.points.map((p) => (
            <Item key={p.title}>
              <div className="flex h-full flex-col rounded-2xl border border-stone-200 bg-card p-6 transition duration-300 hover:-translate-y-1 hover:border-stone-300 hover:shadow-[0_16px_46px_-24px_rgba(0,0,0,0.22)]">
                <div className="text-xl">{p.icon}</div>
                <h3 className="mt-4 font-display text-[15.5px] font-semibold text-ink">{p.title}</h3>
                <p className="mt-2 text-[13px] leading-relaxed text-stone-600">{p.body}</p>
              </div>
            </Item>
          ))}
        </Stagger>

        <Reveal className="mt-6">
          <div className="grid items-center gap-12 rounded-3xl border border-stone-200 bg-card p-8 sm:p-10 lg:grid-cols-[1fr_auto] lg:gap-16">
            <div className="max-w-lg">
              <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent">Full control</div>
              <h3 className="mt-3 font-display text-2xl font-semibold leading-tight text-ink sm:text-[1.7rem]">{s.title}</h3>
              <p className="mt-4 text-[15px] leading-relaxed text-stone-600">{s.body}</p>
            </div>
            <div className="flex justify-center gap-5 sm:gap-6">
              <Shot
                src="/AutoTradeControls.jpg"
                alt="Auto-trade controls, live and armed"
                caption={s.controlsCaption}
                className="w-full max-w-[196px]"
              />
              <Shot
                src="/Notifications.jpg"
                alt="Alert controls, choose which alerts you receive"
                caption={s.notifyCaption}
                className="hidden w-full max-w-[196px] sm:block"
              />
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
