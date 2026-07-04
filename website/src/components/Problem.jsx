import { problem } from '../lib/content.js';
import { Stagger, Item } from './Reveal.jsx';
import SectionHeading from './SectionHeading.jsx';

export default function Problem() {
  return (
    <section id="problem" className="border-t border-stone-200">
      <div className="mx-auto max-w-6xl px-6 py-24 sm:px-8 sm:py-28">
        <SectionHeading eyebrow={problem.eyebrow} heading={problem.heading} sub={problem.sub} />
        <Stagger className="mt-14 grid gap-5 md:grid-cols-3">
          {problem.cards.map((c) => (
            <Item key={c.title}>
              <div className="h-full rounded-2xl border border-stone-200 bg-card p-6 transition duration-300 hover:-translate-y-1 hover:border-stone-300 hover:shadow-[0_16px_46px_-24px_rgba(0,0,0,0.25)]">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-stone-200 bg-paper text-lg">
                  {c.icon}
                </div>
                <h3 className="mt-5 font-display text-lg font-semibold text-ink">{c.title}</h3>
                <p className="mt-2.5 text-[14px] leading-relaxed text-stone-600">{c.body}</p>
              </div>
            </Item>
          ))}
        </Stagger>
      </div>
    </section>
  );
}
