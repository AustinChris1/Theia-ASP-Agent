import { toolkit } from '../lib/content.js';
import { Reveal, Stagger, Item } from './Reveal.jsx';
import SectionHeading from './SectionHeading.jsx';
import Shot from './Shot.jsx';

// On-demand tools, each shown with its real screenshot. The cornered-float view
// is featured (board plus drill-down), the rest sit in a compact row.
export default function Toolkit() {
  const { holdings, tools } = toolkit;
  return (
    <section id="toolkit" className="border-t border-stone-200">
      <div className="mx-auto max-w-6xl px-6 py-24 sm:px-8 sm:py-28">
        <SectionHeading eyebrow={toolkit.eyebrow} heading={toolkit.heading} sub={toolkit.sub} />

        {/* Featured: exchange holdings, board then drill-down */}
        <Reveal className="mt-16">
          <div className="grid items-center gap-12 rounded-3xl border border-stone-200 bg-card p-8 sm:p-10 lg:grid-cols-[1fr_auto] lg:gap-16">
            <div className="max-w-xl">
              <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent">Exchange holdings</div>
              <h3 className="mt-3 font-display text-2xl font-semibold leading-tight text-ink sm:text-[1.7rem]">
                {holdings.title}
              </h3>
              <p className="mt-4 text-[15px] leading-relaxed text-stone-600">{holdings.body}</p>
            </div>
            <div className="flex justify-center gap-5 sm:gap-6">
              <Shot
                src="/TExchangeHoldings.jpg"
                alt="Exchange holdings board, pick a venue"
                caption={holdings.boardCaption}
                className="w-full max-w-[196px]"
              />
              <Shot
                src="/EXHoldDetails.jpg"
                alt="Bitget top holdings ranked by percentage of supply"
                caption={holdings.detailCaption}
                className="hidden w-full max-w-[196px] sm:block"
              />
            </div>
          </div>
        </Reveal>

        {/* The other on-demand tools */}
        <Stagger className="mt-6 grid gap-6 sm:grid-cols-3">
          {tools.map((t) => (
            <Item key={t.title}>
              <div className="flex h-full flex-col rounded-3xl border border-stone-200 bg-card p-6 transition duration-300 hover:-translate-y-1 hover:border-accent/40 hover:shadow-[0_16px_46px_-24px_rgba(26,86,176,0.28)]">
                <Shot src={t.img} alt={t.title} caption={t.caption} className="mx-auto w-full max-w-[210px]" />
                <h3 className="mt-6 font-display text-[16.5px] font-semibold text-ink">{t.title}</h3>
                <p className="mt-2 text-[13.5px] leading-relaxed text-stone-600">{t.body}</p>
              </div>
            </Item>
          ))}
        </Stagger>
      </div>
    </section>
  );
}
