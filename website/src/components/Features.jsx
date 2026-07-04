import { engine } from '../lib/content.js';
import { Stagger, Item } from './Reveal.jsx';
import SectionHeading from './SectionHeading.jsx';

export default function Features() {
  return (
    <section id="engine" className="border-t border-stone-200">
      <div className="mx-auto max-w-6xl px-6 py-24 sm:px-8 sm:py-28">
        <SectionHeading eyebrow={engine.eyebrow} heading={engine.heading} sub={engine.sub} />
        <Stagger gap={0.05} className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {engine.features.map((f) => (
            <Item key={f.title}>
              <div className="group h-full rounded-2xl border border-stone-200 bg-card p-5 transition duration-300 hover:-translate-y-1 hover:border-accent/40 hover:shadow-[0_16px_46px_-24px_rgba(12,107,70,0.3)]">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-stone-200 bg-paper text-lg transition-colors duration-300 group-hover:border-accent/30">
                  {f.icon}
                </div>
                <h3 className="mt-4 font-display text-[15.5px] font-semibold leading-snug text-ink">{f.title}</h3>
                <p className="mt-2 text-[13px] leading-relaxed text-stone-600">{f.body}</p>
              </div>
            </Item>
          ))}
        </Stagger>
      </div>
    </section>
  );
}
