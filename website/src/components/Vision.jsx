import { brand, vision } from '../lib/content.js';
import { Reveal } from './Reveal.jsx';
import SectionHeading from './SectionHeading.jsx';

export default function Vision() {
  return (
    <section id="partners" className="border-t border-stone-200">
      <div className="mx-auto max-w-6xl px-6 py-24 sm:px-8 sm:py-28">
        <SectionHeading eyebrow={vision.eyebrow} heading={vision.heading} sub={vision.sub} />

        <div className="mt-14 grid items-stretch gap-6 lg:grid-cols-2">
          <Reveal>
            <ul className="space-y-5">
              {vision.bullets.map((b) => (
                <li key={b} className="flex items-start gap-3.5 border-b border-stone-200 pb-5 last:border-0">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                  <span className="text-[15px] leading-relaxed text-stone-700">{b}</span>
                </li>
              ))}
            </ul>
          </Reveal>

          <Reveal delay={0.1}>
            <div className="flex h-full flex-col justify-center rounded-3xl bg-ink p-8 text-paper sm:p-10">
              <h3 className="font-display text-3xl font-medium">{vision.ctaTitle}</h3>
              <p className="mt-3 text-[15px] leading-relaxed text-paper/65">{vision.ctaBody}</p>
              <div className="mt-7 flex flex-wrap gap-3">
                <a
                  href={`mailto:${brand.contactEmail}`}
                  className="rounded-full bg-accent px-6 py-3 text-sm font-semibold text-white transition-transform duration-200 hover:-translate-y-0.5"
                >
                  {vision.cta}
                </a>
                <a
                  href={brand.telegram}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full border border-white/20 px-6 py-3 text-sm font-semibold text-paper transition-colors duration-200 hover:bg-white/5"
                >
                  See it live
                </a>
              </div>
              <div className="mt-6 font-mono text-[12px] text-paper/45">{brand.contactEmail}</div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
