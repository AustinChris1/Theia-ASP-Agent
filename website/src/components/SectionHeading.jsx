import { Reveal } from './Reveal.jsx';

export default function SectionHeading({ eyebrow, heading, sub, className = '' }) {
  return (
    <Reveal className={`max-w-2xl ${className}`}>
      {eyebrow && (
        <div className="font-mono text-[11px] uppercase tracking-[0.22em] text-accent">{eyebrow}</div>
      )}
      <h2 className="mt-4 font-display text-[2rem] font-medium leading-[1.08] text-ink sm:text-[2.6rem]">
        {heading}
      </h2>
      {sub && <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-stone-600">{sub}</p>}
    </Reveal>
  );
}
