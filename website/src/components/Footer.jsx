import { brand, footer, nav } from '../lib/content.js';

export default function Footer() {
  return (
    <footer className="border-t border-stone-200">
      <div className="mx-auto max-w-6xl px-6 py-14 sm:px-8">
        <div className="flex flex-col items-start justify-between gap-8 sm:flex-row">
          <div className="max-w-sm">
            <div className="flex items-center gap-2.5">
              <img
                src="/theia.png"
                alt="Theia"
                className="h-6.5 w-6.5 shrink-0 rounded-lg object-cover object-[50%_28%] ring-1 ring-stone-300/70"
              />
              <span className="font-display text-[16px] font-semibold text-ink">{brand.name}</span>
            </div>
            <p className="mt-4 text-[12.5px] leading-relaxed text-stone-500">{footer.note}</p>
          </div>

          <div className="flex flex-wrap gap-x-8 gap-y-2">
            {nav.map((n) => (
              <a key={n.href} href={n.href} className="text-[13.5px] text-stone-500 transition-colors hover:text-ink">
                {n.label}
              </a>
            ))}
            <a href={brand.telegram} target="_blank" rel="noreferrer" className="text-[13.5px] text-stone-500 transition-colors hover:text-ink">
              Telegram
            </a>
          </div>
        </div>

        <div className="mt-12 border-t border-stone-200 pt-6 font-mono text-[11.5px] text-stone-400">
          {new Date().getFullYear()} {brand.name}. {brand.blurb}.
        </div>
      </div>
    </footer>
  );
}
