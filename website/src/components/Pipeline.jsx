import { pipeline } from '../lib/content.js';
import { Stagger, Item } from './Reveal.jsx';
import SectionHeading from './SectionHeading.jsx';

export default function Pipeline() {
  return (
    <section id="how" className="border-t border-stone-200">
      <div className="mx-auto max-w-6xl px-6 py-24 sm:px-8 sm:py-28">
        <SectionHeading eyebrow={pipeline.eyebrow} heading={pipeline.heading} sub={pipeline.sub} />

        <div className="relative mt-16">
          <div className="absolute left-0 right-0 top-[22px] hidden h-px bg-stone-200 lg:block" />
          <Stagger gap={0.1} className="grid gap-8 sm:grid-cols-2 lg:grid-cols-5">
            {pipeline.steps.map((s) => (
              <Item key={s.n}>
                <div className="relative">
                  <div className="relative z-10 flex h-11 w-11 items-center justify-center rounded-full border border-stone-300 bg-paper font-mono text-[13px] font-medium text-accent">
                    {s.n}
                  </div>
                  <h3 className="mt-5 font-display text-[17px] font-semibold text-ink">{s.title}</h3>
                  <p className="mt-2 text-[13.5px] leading-relaxed text-stone-600">{s.body}</p>
                </div>
              </Item>
            ))}
          </Stagger>
        </div>
      </div>
    </section>
  );
}
