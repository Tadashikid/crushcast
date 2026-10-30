// Minimal control room. Presentation only — all behaviour comes from engine.ts.
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { AP, describe, type FutureResult } from '@crushcast/autopilot';
import { SIM } from '@crushcast/sim';
import { actions, getUi, latest, SCENARIOS, useUi, venue } from './engine';
import { COLORS, drawHeat, drawVenue } from './draw';

const S = 3; // px per cell on the live map

export function App() {
  const ui = useUi();
  const plan = ui.plans[ui.selected];
  return (
    <div className="layout">
      <section className="left">
        <MapView />
        {ui.baseline && plan && <Futures baseline={ui.baseline} plan={plan} />}
      </section>
      <aside className="panel">
        <div className={`banner ${ui.status.level}`}>{ui.status.message}</div>
        <Why />
        <Plans />
        <Crises />
        <Join />
        <Legend />
        <Debug />
      </aside>
    </div>
  );
}

function MapView() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    c.width = venue.width * S;
    c.height = venue.height * S;
    const ctx = c.getContext('2d')!;
    let raf = 0, frames = 0, fps = 0, t0 = performance.now();
    const draw = () => {
      const f = latest;
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(0, 0, c.width, c.height);
      if (f) drawHeat(ctx, f.density, f.binW, f.binH);
      drawVenue(ctx, venue, f?.gateOpen ?? venue.gates.map((g) => +g.open), S);
      if (f) {
        ctx.fillStyle = COLORS.dot;
        for (let i = 0; i < f.n; i++) ctx.fillRect(f.xy[2 * i] * S - 1, f.xy[2 * i + 1] * S - 1, 2, 2);
        ctx.font = '22px system-ui, sans-serif';
        const phones = getUi().phones;
        for (const p of f.phones) ctx.fillText(phones[p.num]?.emoji ?? '📱', p.x * S - 11, p.y * S + 8);
      }
      frames++;
      if (performance.now() - t0 > 1000) { fps = frames; frames = 0; t0 = performance.now(); }
      ctx.fillStyle = COLORS.text;
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(`${fps} fps`, 6, c.height - 6);
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} className="map" />;
}

function MiniMap({ r, k, title }: { r: FutureResult; k: number; title: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, c.width, c.height);
    const frame = r.frames[Math.min(k, r.frames.length - 1)];
    if (frame) drawHeat(ctx, frame, AP.FRAME_W, AP.FRAME_H, 1 / AP.FRAME_SCALE);
    const open = venue.gates.map((g, i) => +(getUi().frame?.gateOpen[i] ?? g.open) || +r.actions.some((a) => a.type === 'openGate' && a.gate === g.id));
    drawVenue(ctx, venue, open, c.width / venue.width, false);
  }, [r, k]);
  const bad = r.dangerPersonMin > 0.5;
  return (
    <figure>
      <figcaption>{title}</figcaption>
      <canvas ref={ref} width={venue.width * 1.5} height={venue.height * 1.5} />
      <div className={bad ? 'outcome red' : 'outcome green'}>
        {r.dangerPersonMin.toFixed(0)} person-min in red · peak {r.peakDensity.toFixed(1)}/m²
      </div>
    </figure>
  );
}

function Futures({ baseline, plan }: { baseline: FutureResult; plan: FutureResult }) {
  const [k, setK] = useState(baseline.frames.length - 1);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setK((k) => (k + 1) % baseline.frames.length), 120);
    return () => clearInterval(id);
  }, [playing, baseline.frames.length]);
  return (
    <div className="futures">
      <div className="minis">
        <MiniMap r={baseline} k={k} title="Do nothing" />
        <MiniMap r={plan} k={k} title={plan.actions.map(describe).join(' + ')} />
      </div>
      <div className="scrub">
        <button onClick={() => setPlaying(!playing)}>{playing ? 'Pause' : 'Play'}</button>
        <input type="range" min={0} max={baseline.frames.length - 1} value={k} onChange={(e) => setK(+e.target.value)} />
        <span>+{(((k + 1) * AP.FRAME_EVERY_S) / 60).toFixed(1)} min</span>
      </div>
    </div>
  );
}

function Why() {
  const f = useUi().frame;
  if (!f) return null;
  return (
    <div className="card">
      <h3>Why — gates right now</h3>
      <table>
        <tbody>
          {venue.gates.map((g, i) => {
            const net = Math.round(f.gateArrival[i] - f.gateAdmit[i]);
            return (
              <tr key={g.id}>
                <td><b>{g.id}</b></td>
                <td>{f.gateOpen[i]
                  ? <>{f.gateArrival[i].toFixed(0)}/min arriving · {f.gateCap[i].toFixed(0)}/min capacity · queue {f.gateQueue[i]}{net > 0 ? ` (+${net}/min)` : ''}</>
                  : <i>closed</i>}</td>
                <td><button onClick={() => actions.gate(g.id, !f.gateOpen[i])}>{f.gateOpen[i] ? 'Close' : 'Open'}</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Plans() {
  const ui = useUi();
  return (
    <div className="card">
      <h3>
        Autopilot {ui.searching ? '(searching…)' : ui.searchMs ? `(${ui.futuresRun} futures in ${(ui.searchMs / 1000).toFixed(1)} s)` : ''}
        <button onClick={() => actions.search()} disabled={ui.searching}>Run now</button>
      </h3>
      {!ui.plans.length && <p className="muted">No plans yet — the autopilot runs every 15 s.</p>}
      {ui.plans.map((p, i) => (
        <div key={i} className={`plan ${i === ui.selected ? 'selected' : ''}`} onClick={() => actions.select(i)}>
          <div className="plan-title">{i === 0 && '★ '}{p.actions.map(describe).join(' + ')}</div>
          <div className="muted">
            Danger avoided: <b>{p.dangerAvoided.toFixed(0)} person-min</b> ({p.baselineDangerPersonMin.toFixed(0)} → {p.dangerPersonMin.toFixed(0)}) ·
            peak {p.peakDensity.toFixed(1)}/m² · {p.outsideAtEnd} still outside at +{AP.HORIZON_MIN} min
          </div>
          <button className="apply" onClick={(e) => { e.stopPropagation(); actions.apply(i); }}>Apply</button>
        </div>
      ))}
    </div>
  );
}

function Crises() {
  return (
    <div className="card">
      <h3>Crises</h3>
      {venue.sources.map((s) => (
        <button key={s.id} onClick={() => actions.crisis('announcement', s.id)}>📢 Announcement surge at {s.label}</button>
      ))}
      <button onClick={() => actions.crisis('rain')}>🌧 Rain</button>
    </div>
  );
}

function Join() {
  const url = useUi().joinUrl;
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { if (url && ref.current) QRCode.toCanvas(ref.current, url, { width: 140, margin: 1 }); }, [url]);
  if (!url) return null;
  return (
    <div className="card join">
      <canvas ref={ref} />
      <div><h3>Join the crowd</h3><code>{url}</code></div>
    </div>
  );
}

function Legend() {
  return (
    <p className="muted legend">
      <span className="sw green" /> &lt; {SIM.AMBER} <span className="sw amber" /> {SIM.AMBER}–{SIM.RED} <span className="sw red" /> &gt; {SIM.RED} people/m²
      — thresholds and model parameters are assumptions (see config.ts). Synthetic venue, illustrative scenarios.
    </p>
  );
}

function Debug() {
  const ui = useUi();
  const f = ui.frame;
  return (
    <details className="card">
      <summary>Debug</summary>
      <p>{f ? `t=${(f.t / 60).toFixed(1)} min · ${f.n} outside · ${f.entered} entered · ${f.withheld} held upstream` : '…'} · relay {ui.connected ? 'connected' : 'offline'}</p>
      <p>Speed {[1, 2, 4, 8].map((s) => <button key={s} className={ui.speed === s ? 'on' : ''} onClick={() => actions.speed(s)}>{s}×</button>)}</p>
      <p>Reset {Object.keys(SCENARIOS).map((s) => <button key={s} onClick={() => actions.reset(s)}>{s}</button>)}</p>
      <ul>{ui.log.map((l, i) => <li key={i}>{l}</li>)}</ul>
    </details>
  );
}
