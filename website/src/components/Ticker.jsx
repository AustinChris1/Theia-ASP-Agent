import { ticker } from '../lib/content.js';

// Seamless marquee of what the engine watches. The track is duplicated and the
// CSS translates it -50%, so the loop is continuous with no jump.
export default function Ticker() {
  const items = [...ticker, ...ticker];
  return (
    <div className="border-y border-stone-200 bg-card/40 py-4">
      <div className="marquee-mask overflow-hidden">
        <div className="animate-marquee flex w-max items-center gap-0 whitespace-nowrap">
          {items.map((t, i) => (
            <span key={i} className="flex items-center">
              <span className="px-6 font-mono text-[12.5px] uppercase tracking-[0.14em] text-stone-500">{t}</span>
              <span className="text-accent/50">{'/'}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
