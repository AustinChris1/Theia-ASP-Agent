import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { EASE } from './Reveal.jsx';

// A real dark Telegram screenshot in a clean device frame, sat on the light page.
// The screenshots already carry their own status bar, so the frame stays minimal:
// a near-black bezel, a soft drop shadow and a faint ring for edge definition.
//
// Clicking opens the capture full-size in an animated popup (scrollable for the
// tall ones) instead of navigating away. A very tall capture can be capped with
// `cropClass` and a `fade`, so it teases the depth at hero height in place.
export default function Shot({
  src,
  alt,
  caption,
  className = '',
  frameClass = '',
  cropClass = '',
  fade = false,
  hint,
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <figure className={className}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Expand: ${alt}`}
        className="group relative block w-full cursor-zoom-in text-left"
      >
        <span className="pointer-events-none absolute -inset-4 -z-10 rounded-[3rem] bg-ink/[0.07] blur-2xl" />
        <span
          className={`relative block overflow-hidden rounded-[2.1rem] border-[7px] border-[#100f16] bg-[#100f16] shadow-[0_34px_90px_-45px_rgba(23,21,15,0.7)] ring-1 ring-black/[0.06] transition-transform duration-500 group-hover:-translate-y-1.5 ${frameClass}`}
        >
          <span className={`block overflow-hidden ${cropClass}`}>
            <img src={src} alt={alt} loading="lazy" decoding="async" className="block w-full select-none" />
          </span>
          {fade && (
            <span className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-b from-transparent to-[#100f16]" />
          )}
          {fade && hint && (
            <span className="absolute inset-x-0 bottom-4 flex justify-center">
              <span className="rounded-full border border-white/15 bg-white/[0.08] px-3 py-1 font-mono text-[10px] tracking-wide text-white/80 backdrop-blur-sm transition-colors group-hover:border-white/30 group-hover:text-white">
                {hint}
              </span>
            </span>
          )}
        </span>
      </button>
      {caption && (
        <figcaption className="mt-3.5 text-center font-mono text-[11px] tracking-tight text-stone-500">
          {caption}
        </figcaption>
      )}

      <AnimatePresence>
        {open && (
          <motion.div
            className="fixed inset-0 z-[100] flex justify-center overflow-y-auto overscroll-contain bg-ink/75 px-4 py-10 backdrop-blur-md sm:py-14"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22 }}
            onClick={() => setOpen(false)}
          >
            <motion.figure
              className="relative m-auto"
              initial={{ opacity: 0, scale: 0.92, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.94, y: 12 }}
              transition={{ duration: 0.4, ease: EASE }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="overflow-hidden rounded-[2rem] border-[7px] border-[#100f16] bg-[#100f16] shadow-[0_40px_120px_-30px_rgba(0,0,0,0.7)]">
                <img src={src} alt={alt} className="block w-[min(340px,82vw)] select-none" />
              </div>
              {caption && (
                <figcaption className="mt-3 text-center font-mono text-[11px] tracking-tight text-paper/70">
                  {caption}
                </figcaption>
              )}
            </motion.figure>

            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="fixed right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-white/10 text-lg text-paper backdrop-blur-md transition-colors hover:bg-white/20"
            >
              ✕
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </figure>
  );
}
