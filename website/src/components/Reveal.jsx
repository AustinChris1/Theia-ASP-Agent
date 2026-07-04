import { motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';

// Premium expo-out easing used across the site.
export const EASE = [0.22, 1, 0.36, 1];

// Single element fade + slide on scroll into view.
export function Reveal({ children, delay = 0, y = 18, className = '', as = 'div' }) {
  const M = motion[as] ?? motion.div;
  return (
    <M
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.7, delay, ease: EASE }}
    >
      {children}
    </M>
  );
}

// Container that staggers its <Item> children when the group scrolls into view.
export function Stagger({ children, className = '', gap = 0.08, as = 'div' }) {
  const M = motion[as] ?? motion.div;
  return (
    <M
      className={className}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: '-60px' }}
      variants={{ show: { transition: { staggerChildren: gap } } }}
    >
      {children}
    </M>
  );
}

export function Item({ children, className = '', y = 20, as = 'div' }) {
  const M = motion[as] ?? motion.div;
  return (
    <M
      className={className}
      variants={{
        hidden: { opacity: 0, y },
        show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: EASE } },
      }}
    >
      {children}
    </M>
  );
}

// Counts a number up when it scrolls into view. Handles a non-numeric prefix /
// suffix (e.g. "<60s" counts to 60, keeping the "<" and "s"). Static if no digits.
export function CountUp({ value, className = '', duration = 1100 }) {
  const m = String(value).match(/^(\D*)(\d[\d,]*)(.*)$/);
  const target = m ? Number(m[2].replace(/,/g, '')) : null;
  const ref = useRef(null);
  const [n, setN] = useState(0);

  useEffect(() => {
    if (target == null || !ref.current) return;
    let raf, start, done = false;
    const obs = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting || done) return;
        done = true;
        const step = (t) => {
          if (!start) start = t;
          const p = Math.min(1, (t - start) / duration);
          const eased = 1 - Math.pow(1 - p, 3);
          setN(Math.round(eased * target));
          if (p < 1) raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
        obs.disconnect();
      },
      { threshold: 0.5 },
    );
    obs.observe(ref.current);
    return () => { obs.disconnect(); cancelAnimationFrame(raf); };
  }, [target, duration]);

  if (target == null) return <span className={className} ref={ref}>{value}</span>;
  return <span className={className} ref={ref}>{m[1]}{n.toLocaleString()}{m[3]}</span>;
}
