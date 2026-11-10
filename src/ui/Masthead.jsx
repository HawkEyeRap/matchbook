import React from 'react';
import { Matchstick, Seg } from './marks.jsx';
import { COMPANY } from '../data/scenarios.js';

export const NAV = [
  ['inbox', 'Inbox'],
  ['scorecard', 'Scorecard'],
  ['sandbox', 'Sandbox'],
  ['insights', 'Insights'],
  ['how', 'How it works'],
  ['settings', 'Settings'],
];

export default function Masthead({ section, view, go, detail, setDetail, onTour, onReset }) {
  const current = view.startsWith('case-') ? 'inbox' : view;
  return (
    <header className="mast">
      <div className="mast-row">
        <a className="logo" href="#inbox" onClick={(e) => { e.preventDefault(); go('inbox'); }}><Matchstick />Matchbook</a>
        <div className="mast-section">{section}</div>
        <nav className="nav" aria-label="Sections">
          {NAV.map(([id, label]) => (
            <a key={id} href={`#${id}`} data-tour={`nav-${id}`} aria-current={current === id ? 'page' : undefined} onClick={(e) => { e.preventDefault(); go(id); }}>{label}</a>
          ))}
        </nav>
      </div>
      <div className="rule" style={{ marginTop: 14 }} />
      <div className="mast-sub">
        <Seg label="Level of detail" value={detail} options={[['simple', 'Simple'], ['detailed', 'Detailed']]} onChange={setDetail} />
        <span>{COMPANY.name} · Ramp Bill Pay</span>
        <span className="grow" />
        <span className="dotlive"><i />Runs offline · no model, no API keys</span>
        <button className="tourbtn" onClick={onTour}>Tour</button>
        <button className="textbtn" onClick={onReset}>Reset demo</button>
      </div>
    </header>
  );
}
