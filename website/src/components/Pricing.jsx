import { brand, pricing } from '../lib/content.js';
import { Reveal } from './Reveal.jsx';
import SectionHeading from './SectionHeading.jsx';

export default function Pricing() {
  const p = pricing.plan;
  return (
    <section id="pricing" className="border-t border-stone-200">
      <div className="mx-auto max-w-6xl px-6 py-24 sm:px-8 sm:py-28">
        <SectionHeading eyebrow={pricing.eyebrow} heading={pricing.heading} sub={pricing.sub} />

        <Reveal className="mt-14 max-w-md">
          <div className="overflow-hidden rounded-3xl border border-stone-200 bg-card p-8">
            <div className="font-mono text-[12px] uppercase tracking-[0.16em] text-accent">{p.name}</div>
            <div className="mt-4 flex items-end gap-2">
              <span className="font-display text-6xl font-medium leading-none text-ink">{p.price}</span>
              <span className="mb-1.5 text-sm text-stone-500">{p.cadence}</span>
            </div>
            <div className="mt-3 inline-flex rounded-full border border-stone-200 bg-paper px-3 py-1 font-mono text-[11px] text-stone-600">
              {p.trial}
            </div>

            <ul className="mt-7 space-y-3">
              {p.features.map((f) => (
                <li key={f} className="flex items-start gap-3 text-[14px] text-stone-700">
                  <Check />
                  <span>{f}</span>
                </li>
              ))}
            </ul>

            <a
              href={brand.telegram}
              target="_blank"
              rel="noreferrer"
              className="mt-8 block rounded-full bg-accent py-3.5 text-center text-sm font-semibold text-white transition-transform duration-200 hover:-translate-y-0.5"
            >
              {p.cta}
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Check() {
  return (
    <svg className="mt-0.5 h-4 w-4 shrink-0 text-accent" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M5 10.5 L8.5 14 L15 6.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
