import React, { useEffect, useRef, useState } from 'react';

/** The logo: a single struck match. */
export function Matchstick({ h = 22 }) {
  return (
    <svg viewBox="0 0 10 28" width={h * 10 / 28} height={h} aria-hidden="true">
      <rect x="4.1" y="8" width="1.8" height="20" rx="0.6" fill="currentColor" />
      <ellipse cx="5" cy="5.6" rx="3.3" ry="4.6" fill="var(--red)" />
    </svg>
  );
}

/** Red pen strike through an incorrect figure. */
export function PenStrike({ delay = 0.3 }) {
  return (
    <svg className="pen" viewBox="0 0 100 20" preserveAspectRatio="none" style={{ left: '-6%', top: '38%', width: '112%', height: '30%', '--d': `${delay}s`, '--dur': '.45s' }} aria-hidden="true">
      <path pathLength="1" d="M 2 12 C 30 9, 62 13, 98 7" strokeWidth="2.4" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Hand-drawn ellipse that draws itself around the corrected figure. */
export function PenCircle({ delay = 0.7 }) {
  return (
    <svg className="pen" viewBox="0 0 240 100" preserveAspectRatio="none" style={{ inset: '-10% -8%', width: '116%', height: '120%', '--d': `${delay}s` }} aria-hidden="true">
      <path pathLength="1" d="M 44 18 C 92 2, 206 4, 228 40 C 244 70, 170 96, 104 92 C 38 88, 6 70, 12 46 C 18 24, 60 10, 138 9" strokeWidth="2.6" />
    </svg>
  );
}

/** Number that eases from its last value to the new one. */
export function CountUp({ value, format }) {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { setShown(value); from.current = value; return undefined; }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (t) => {
      const k = Math.min(1, (t - start) / 1100);
      const e = 1 - Math.pow(1 - k, 5);
      setShown(a + (value - a) * e);
      if (k < 1) raf = requestAnimationFrame(tick); else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); from.current = value; };
  }, [value]);
  return <span>{format(shown)}</span>;
}

export const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
export { store };

export function Seg({ label, value, options, onChange }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map(([v, t]) => <button key={v} role="radio" aria-checked={value === v} onClick={() => onChange(v)}>{t}</button>)}
    </div>
  );
}

export function StatusMark({ status }) {
  const group = { new: 'open', investigating: 'work', review: 'you', waiting: 'work', resolved: 'done', escalated: 'done', rejected: 'done' }[status];
  const text = { new: 'Not started', investigating: 'Working', review: 'Needs you', waiting: 'Following up', resolved: 'Closed', escalated: 'With a person', rejected: 'You took over' }[status];
  return (
    <span className={`status ${group}`}>
      {status === 'resolved' ? <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2 6.5 L5 9 L10 3" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg> : <span className={`d ${status === 'investigating' ? 'pulse' : ''}`} />}
      {text}
    </span>
  );
}
