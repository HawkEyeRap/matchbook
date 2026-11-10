import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PenCircle, PenStrike } from './marks.jsx';

// A guided tour that never jumps. Each step runs as one sequence:
//   fade the card out → run the step's setup → wait for the target → scroll and wait until the
//   scroll has fully settled → glide the spotlight → place the card while hidden → fade it in.
// The page can't be scrolled by hand during the tour, entrance animations are paused, and a
// newer step cancels an older sequence, so fast clicking can't leave things half-moved.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const PAD = 8;
const TIP_H = 250;

async function waitFor(selector, timeout, alive) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeout) {
    if (!alive()) return null;
    const el = document.querySelector(selector);
    if (el && el.getBoundingClientRect().height > 0) return el;
    await frame();
  }
  return null;
}

async function scrollSettle(alive) {
  let last = window.scrollY; let still = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 1400) {
    await frame();
    if (!alive()) return;
    if (Math.abs(window.scrollY - last) < 0.5) { if (++still >= 6) return; } else still = 0;
    last = window.scrollY;
  }
}

function scrollTargetFor(el) {
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight;
  const max = document.documentElement.scrollHeight - vh;
  const docTop = window.scrollY + r.top;
  if (r.top >= 20 && r.bottom + TIP_H + 28 <= vh) return window.scrollY; // already well placed
  if (r.height + TIP_H + 40 <= vh) return clamp(docTop - (vh - (r.height + TIP_H + 16)) / 2, 0, max);
  return clamp(docTop - 24, 0, max);
}

function measure(el) {
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight;
  const y = Math.max(8, r.top - PAD);
  let h = r.bottom + PAD - y;
  const maxH = vh - y - 12;
  if (h > maxH) h = Math.max(80, Math.min(maxH, vh * 0.62));
  return { x: r.left - PAD, y, w: r.width + PAD * 2, h };
}

export default function Tour({ open, steps, onClose }) {
  const [i, setI] = useState(0);
  const [shownIdx, setShownIdx] = useState(0);
  const [visible, setVisible] = useState(false);
  const [spot, setSpot] = useState({ x: 0, y: 0, w: 0, h: 0, on: false });
  const [instant, setInstant] = useState(true);
  const [tip, setTip] = useState({ x: 0, y: 0 });
  const tipRef = useRef(null);
  const nextRef = useRef(null);
  const elRef = useRef(null);
  const token = useRef(0);
  const spotRef = useRef(spot); spotRef.current = spot;
  const last = steps.length - 1;

  const placeTip = useCallback((r) => {
    const t = tipRef.current;
    if (!t) return;
    const vw = window.innerWidth; const vh = window.innerHeight;
    const tw = t.offsetWidth; const th = t.offsetHeight; const m = 16;
    if (!r) { setTip({ x: (vw - tw) / 2, y: Math.max(16, (vh - th) / 2) }); return; }
    const cx = clamp(r.x + r.w / 2 - tw / 2, 16, vw - tw - 16);
    const bottom = r.y + r.h;
    if (vh - bottom >= th + m + 8) setTip({ x: cx, y: bottom + m });
    else if (r.y >= th + m + 8) setTip({ x: cx, y: r.y - th - m });
    else if (vw - (r.x + r.w) >= tw + m + 16) setTip({ x: r.x + r.w + m, y: clamp(r.y, 16, vh - th - 16) });
    else if (r.x >= tw + m + 16) setTip({ x: r.x - tw - m, y: clamp(r.y, 16, vh - th - 16) });
    else setTip({ x: (vw - tw) / 2, y: vh - th - 16 });
  }, []);

  const run = useCallback(async (idx) => {
    const my = ++token.current;
    const alive = () => my === token.current;
    setVisible(false);
    await wait(spotRef.current.on || idx > 0 ? 200 : 0);
    if (!alive()) return;
    const step = steps[idx];
    step.before?.();
    setShownIdx(idx);
    if (!step.target) {
      elRef.current = null;
      setSpot((s) => ({ ...s, on: false }));
      await frame(); await frame();
      if (!alive()) return;
      placeTip(null);
      setVisible(true);
      return;
    }
    const el = await waitFor(step.target, 3000, alive);
    if (!alive()) return;
    if (!el) { setSpot((s) => ({ ...s, on: false })); await frame(); placeTip(null); setVisible(true); return; }
    elRef.current = el;
    await frame(); await frame();
    if (!alive()) return;
    const to = scrollTargetFor(el);
    if (Math.abs(to - window.scrollY) > 2) {
      window.scrollTo({ top: to, behavior: reduced() ? 'auto' : 'smooth' });
      await scrollSettle(alive);
      if (!alive()) return;
    }
    const r = measure(el);
    const wasOn = spotRef.current.on;
    if (!wasOn) {
      setInstant(true);
      setSpot({ ...r, on: false });
      await frame(); await frame();
      setSpot({ ...r, on: true });
      await wait(reduced() ? 0 : 300);
      setInstant(false);
    } else {
      setSpot({ ...r, on: true });
      await wait(reduced() ? 0 : 520);
    }
    if (!alive()) return;
    placeTip(r);
    await frame();
    if (!alive()) return;
    setVisible(true);
    nextRef.current?.focus({ preventScroll: true });
  }, [steps, placeTip]);

  // Open/close: lock manual scrolling and pause entrance animations while touring.
  useEffect(() => {
    if (!open) return undefined;
    document.documentElement.classList.add('touring');
    setI(0);
    const stop = (e) => e.preventDefault();
    const keys = (e) => {
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(e.key)) e.preventDefault();
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setI((v) => Math.min(last, v + 1));
      if (e.key === 'ArrowLeft') setI((v) => Math.max(0, v - 1));
    };
    window.addEventListener('wheel', stop, { passive: false });
    window.addEventListener('touchmove', stop, { passive: false });
    window.addEventListener('keydown', keys);
    return () => {
      token.current++;
      document.documentElement.classList.remove('touring');
      window.removeEventListener('wheel', stop);
      window.removeEventListener('touchmove', stop);
      window.removeEventListener('keydown', keys);
      setVisible(false);
      setSpot((s) => ({ ...s, on: false }));
    };
  }, [open, last, onClose]);

  useEffect(() => { if (open) run(i); }, [open, i, run]);

  // Follow the target if the window resizes or the element changes size.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const refresh = () => {
      const el = elRef.current;
      if (!el || !spotRef.current.on) { if (!el) placeTip(null); return; }
      const r = measure(el);
      setInstant(true);
      setSpot({ ...r, on: true });
      placeTip(r);
      requestAnimationFrame(() => setInstant(false));
    };
    window.addEventListener('resize', refresh);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { if (visible) refresh(); }) : null;
    if (ro && elRef.current) ro.observe(elRef.current);
    return () => { window.removeEventListener('resize', refresh); ro?.disconnect(); };
  }, [open, visible, placeTip, shownIdx]);

  if (!open) return null;
  const step = steps[shownIdx];
  const counted = steps.filter((s) => s.target).length;
  const pos = steps.slice(0, shownIdx + 1).filter((s) => s.target).length;

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      <div className={`tour-scrim ${!spot.on ? 'on' : ''}`} />
      <div className={`tour-spot ${instant ? 'instant' : ''}`} style={{ transform: `translate(${spot.x}px, ${spot.y}px)`, width: spot.w, height: spot.h, opacity: spot.on ? 1 : 0 }} />
      <div ref={tipRef} className={`tour-tip ${step.hero === 'welcome' ? 'hero' : ''} ${visible ? 'on' : ''}`} style={{ left: tip.x, top: tip.y }}>
        {step.hero === 'welcome' && <WelcomeHero key={`h${shownIdx}-${visible}`} />}
        {step.hero === 'done' && <div className="tour-done" aria-hidden="true">✓</div>}
        {step.target && <span className="label">{pos} of {counted}{step.kicker ? ` · ${step.kicker}` : ''}</span>}
        <h3 id="tour-title" style={step.hero === 'done' ? { marginTop: 14 } : undefined}>{step.title}</h3>
        <p>{step.body}</p>
        <div className="tour-foot">
          <div className="tour-dots" aria-hidden="true">{steps.map((_, k) => <i key={k} className={k === shownIdx ? 'on' : ''} />)}</div>
          {shownIdx > 0 && shownIdx < last && <button className="btn ghost sm" onClick={() => setI((v) => Math.max(0, v - 1))}>Back</button>}
          <button ref={nextRef} className="btn primary sm" onClick={() => (i < last ? setI((v) => Math.min(last, v + 1)) : onClose())}>{step.cta || (shownIdx === last ? 'Done' : 'Next')} <span className="arr">→</span></button>
        </div>
        {shownIdx < last && <button className="tour-skip" onClick={onClose}>Skip the tour</button>}
      </div>
    </div>
  );
}

function WelcomeHero() {
  return (
    <div className="th" aria-hidden="true">
      <div className="slips">
        <div className="slip"><span className="label">Invoice</span><i /><i /><b>$4.60<PenStrike delay={1.0} /></b></div>
        <div className="slip"><span className="label">PO</span><i /><i /><b>$4.20</b></div>
        <div className="slip"><span className="label">Contract</span><i /><i /><b style={{ padding: '0 6px' }}>$4.20<PenCircle delay={1.25} /></b></div>
      </div>
      <div className="ok-pill">✓ Credit memo drafted</div>
    </div>
  );
}

export function buildSteps({ prepCase, gotoInbox }) {
  return [
    { hero: 'welcome', title: 'Meet Matchbook', body: 'Ramp’s 3-way match blocks a bill that doesn’t agree with its PO or receipt. Matchbook works out why, drafts the fix, and follows up until it’s paid. This tour takes a minute.', cta: 'Show me' },
    { target: '[data-tour="stake"]', before: gotoInbox, kicker: 'Inbox', title: 'What’s at stake', body: 'Every blocked bill and the money riding on it: overbillings, duplicates, and payments to accounts nobody verified.' },
    { target: '[data-tour="queue"]', kicker: 'Inbox', title: 'One row per blocked bill', body: 'Each row shows Ramp’s flag, then Matchbook’s diagnosis once it runs. Red status means a person is needed.' },
    { target: '[data-tour="intake"]', kicker: 'Inbox', title: 'Drop in real files', body: 'Invoice PDFs, a CSV export, or a vendor’s reply. Each one is read and matched for real. Try the samples after the tour.' },
    { target: '[data-tour="title"]', before: prepCase, kicker: 'A case', title: 'The red pen', body: 'Northwind billed $4.60 a box. The agreement says $4.20. Matchbook strikes the wrong figure and circles the right one.' },
    { target: '[data-tour="trace"]', kicker: 'A case', title: 'Every step is a tool call', body: 'It reads the bill, PO, item receipts, vendor agreements, and payment history through Ramp’s API, then searches the agreements for the clause that settles it.' },
    { target: '[data-tour="mismatch"]', kicker: 'A case', title: 'Code does the math', body: 'Quantities, prices, and tolerances are computed in code, never guessed. The grid shows exactly which document disagrees.' },
    { target: '[data-tour="diagnosis"]', kicker: 'A case', title: 'The root cause, with receipts', body: 'A plain-English cause, the evidence it relied on, and the contract clause, highlighted.' },
    { target: '[data-tour="fix"]', kicker: 'A case', title: 'The fix, already drafted', body: 'The right fix for this cause. Every underlined number in the draft was filled in from the books, and edits are checked the same way.' },
    { target: '[data-tour="approve"]', kicker: 'A case', title: 'Nothing leaves without you', body: 'Approve and Matchbook sends it, follows up, checks the vendor’s reply, and releases payment. Or take the case over yourself.' },
    { target: '[data-tour="nav-scorecard"]', kicker: 'Proof', title: 'Check its work', body: 'The scorecard re-runs 22 cases live in your browser, including real PDFs, and grades every answer.' },
    { hero: 'done', title: 'You’re ready', body: 'Approve the Northwind credit memo, then press Fast-forward to watch the follow-up and payment. Replay this tour from the Tour button anytime.', cta: 'Start' },
  ];
}
