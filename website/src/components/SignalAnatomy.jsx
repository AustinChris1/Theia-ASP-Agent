import { anatomy } from '../lib/content.js';
import { Reveal, Stagger, Item } from './Reveal.jsx';
import SectionHeading from './SectionHeading.jsx';
import SignalCard from './SignalCard.jsx';

// Breaks down what sits inside an alert. The clean animated mockup on the left,
// the three parts every signal carries annotated on the right.
export default function SignalAnatomy() {
  return (
    <section id="anatomy" className="border-t border-stone-200">
      <div className="mx-auto max-w-6xl px-6 py-24 sm:px-8 sm:py-28">
        <SectionHeading eyebrow={anatomy.eyebrow} heading={anatomy.heading} sub={anatomy.sub} />

        <div className="mt-16 grid items-center gap-14 lg:grid-cols-[minmax(0,0.9fr)_1fr] lg:gap-20">
          <Reveal className="flex justify-center lg:justify-start">
            <SignalCard />
          </Reveal>

          <Stagger className="flex flex-col gap-9">
            {anatomy.points.map((p, i) => (
              <Item key={p.title}>
                <div className="relative border-l border-stone-200 pl-6">
                  <div className="absolute -left-px top-0 h-9 w-px bg-accent" />
                  <div className="font-mono text-[12px] text-accent">{`0${i + 1}`}</div>
                  <h3 className="mt-2 font-display text-xl font-semibold text-ink">{p.title}</h3>
                  <p className="mt-2.5 text-[14.5px] leading-relaxed text-stone-600">{p.body}</p>
                </div>
              </Item>
            ))}
          </Stagger>
        </div>
      </div>
    </section>
  );
}
