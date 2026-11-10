import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import Masthead from './ui/Masthead.jsx';
import Tour, { buildSteps } from './ui/Tour.jsx';
import { store } from './ui/marks.jsx';
import { reducer, initialCases, analyze } from './store.js';
import { DEFAULT_POLICY } from './engine/match.js';
import Inbox from './views/Inbox.jsx';
import Case from './views/Case.jsx';
import Scorecard from './views/Scorecard.jsx';
import Sandbox from './views/Sandbox.jsx';
import Insights from './views/Insights.jsx';
import How from './views/How.jsx';
import Settings from './views/Settings.jsx';

const PAGES = ['inbox', 'scorecard', 'sandbox', 'insights', 'how', 'settings'];
const SECTION = { inbox: 'Exhibit 01 / The queue', scorecard: 'Exhibit 03 / The scorecard', sandbox: 'Exhibit 04 / Try to break it', insights: 'Exhibit 05 / What it costs', how: 'Exhibit 06 / How it works', settings: 'Exhibit 07 / The rules' };
const TOUR_KEY = 'matchbook.tour.v2';

const readHash = () => {
  const h = (typeof location !== 'undefined' && location.hash.replace('#', '')) || '';
  return PAGES.includes(h) || h.startsWith('case-') ? h : 'inbox';
};

export default function App() {
  const [view, setView] = useState(readHash);
  const [policy, setPolicy] = useState(DEFAULT_POLICY);
  const [cases, dispatch] = useReducer(reducer, DEFAULT_POLICY, initialCases);
  const [detail, setDetailState] = useState(() => store.get('matchbook.detail', 'simple'));
  const [toasts, setToasts] = useState([]);
  const [intake, setIntake] = useState([]);
  const [tourOpen, setTourOpen] = useState(false);

  const setDetail = (v) => { setDetailState(v); store.set('matchbook.detail', v); };

  useEffect(() => {
    const on = () => setView(readHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => { window.scrollTo(0, 0); }, [view]);

  useEffect(() => {
    if (store.get(TOUR_KEY, '') === 'done') return undefined;
    const t = setTimeout(() => setTourOpen(true), 700);
    return () => clearTimeout(t);
  }, []);

  const toast = useCallback((text) => {
    const id = Math.random();
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  const analyses = useMemo(() => Object.fromEntries(cases.map((c) => [c.id, analyze(c, policy, cases)])), [cases, policy]);

  const go = useCallback((id) => {
    if (location.hash.replace('#', '') !== id) location.hash = id;
    setView(id);
  }, []);

  // Tour setup: open the Northwind case in a ready-to-approve state so every part exists.
  const latest = useRef({ cases, analyses }); latest.current = { cases, analyses };
  const prepCase = useCallback(() => {
    const { cases: cs, analyses: an } = latest.current;
    const ok = (c) => ['new', 'investigating', 'review'].includes(c.status);
    const pick = cs.find((c) => c.id === 'NWP-30917' && ok(c)) || cs.find((c) => ok(c) && an[c.id].plan.type === 'credit_memo') || cs.find(ok) || cs[0];
    if (pick.status === 'new' || pick.status === 'investigating') dispatch({ type: 'TRACE_DONE', id: pick.id, a: an[pick.id] });
    go(`case-${pick.id}`);
  }, [go]);
  const steps = useMemo(() => buildSteps({ prepCase, gotoInbox: () => go('inbox') }), [prepCase, go]);
  const closeTour = useCallback(() => { setTourOpen(false); store.set(TOUR_KEY, 'done'); }, []);

  const reset = () => { dispatch({ type: 'RESET', policy: DEFAULT_POLICY }); setPolicy(DEFAULT_POLICY); setIntake([]); go('inbox'); toast('Demo reset to its starting state'); };

  const caseId = view.startsWith('case-') ? view.slice(5) : null;
  const current = caseId ? cases.find((c) => c.id === caseId) : null;
  const section = current ? `Exhibit 02 / ${current.id}` : SECTION[view] || SECTION.inbox;
  const shared = { cases, analyses, dispatch, policy, go, toast, detail };

  return (
    <div className="wrap">
      <Masthead section={section} view={view} go={go} detail={detail} setDetail={setDetail} onTour={() => setTourOpen(true)} onReset={reset} />
      <main>
        {view === 'inbox' && <Inbox {...shared} intake={intake} setIntake={setIntake} />}
        {caseId && (current ? <Case key={current.id} c={current} a={analyses[current.id]} {...shared} /> : <p className="page-h muted">That case doesn’t exist. <a href="#inbox" onClick={(e) => { e.preventDefault(); go('inbox'); }}>Back to the inbox</a>.</p>)}
        {view === 'scorecard' && <Scorecard policy={policy} detail={detail} />}
        {view === 'sandbox' && <Sandbox {...shared} />}
        {view === 'insights' && <Insights {...shared} />}
        {view === 'how' && <How go={go} />}
        {view === 'settings' && <Settings policy={policy} setPolicy={setPolicy} cases={cases} toast={toast} />}
      </main>
      <Tour open={tourOpen} steps={steps} onClose={closeTour} />
      <div className="toasts" aria-live="polite">{toasts.map((t) => <div key={t.id} className="toast">{t.text}</div>)}</div>
    </div>
  );
}
