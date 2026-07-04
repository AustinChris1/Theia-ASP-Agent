import { useEffect, useState } from 'react';
import { brand, nav } from '../lib/content.js';

export default function Nav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-all duration-300 ${
        scrolled ? 'border-b border-stone-200/80 bg-paper/85 backdrop-blur-xl' : 'border-b border-transparent'
      }`}
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4 sm:px-8">
        <a href="#top" className="flex items-center gap-2.5">
          <img
            src="/theia.png"
            alt="Theia"
            className="h-7 w-7 shrink-0 rounded-lg object-cover object-[50%_28%] ring-1 ring-stone-300/70"
          />
          <span className="font-display text-[17px] font-semibold tracking-tight text-ink">{brand.name}</span>
        </a>

        <nav className="hidden items-center gap-9 md:flex">
          {nav.map((n) => (
            <a
              key={n.href}
              href={n.href}
              className="text-[13.5px] font-medium text-stone-500 transition-colors hover:text-ink"
            >
              {n.label}
            </a>
          ))}
        </nav>

        <a
          href={brand.telegram}
          target="_blank"
          rel="noreferrer"
          className="rounded-full bg-ink px-4 py-2 text-[13px] font-semibold text-paper transition-transform duration-200 hover:-translate-y-0.5"
        >
          Open in Telegram
        </a>
      </div>
    </header>
  );
}
