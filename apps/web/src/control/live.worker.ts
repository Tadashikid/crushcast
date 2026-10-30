// Live sim, off the main thread. Steps at `speed` × real time and posts a Frame after every step.
import { applyEvent, createSim, phoneRoutes, spawnGroup, step, SIM, zoneStats, type Scenario, type SimState } from '@crushcast/sim';
import { applyAction, snapshot, type Action } from '@crushcast/autopilot';
import venue from '../../../../venues/stadium.json';
import type { Frame, LiveIn } from './engine';

let st: SimState | undefined;
let speed = 4;
let timer: ReturnType<typeof setInterval> | undefined;
const ROUTES_EVERY = 20; // steps (10 sim-seconds)

function tick() {
  if (!st) return;
  step(st);
  const xy = new Float32Array(st.n * 2);
  const phones: Frame['phones'] = [];
  for (let i = 0; i < st.n; i++) {
    xy[2 * i] = st.x[i];
    xy[2 * i + 1] = st.y[i];
    if (st.phoneId[i] >= 0) phones.push({ num: st.phoneId[i], x: st.x[i], y: st.y[i] });
  }
  const density = st.density.slice();
  const frame: Frame = {
    t: st.t, n: st.n, xy, phones, density, binW: st.binW, binH: st.binH,
    gateOpen: Array.from(st.gateOpen), gateCap: Array.from(st.gateCap), gateQueue: Array.from(st.gateQueue),
    gateArrival: Array.from(st.gateArrivalRate), gateAdmit: Array.from(st.gateAdmitRate),
    zones: zoneStats(st), entered: st.entered, withheld: Math.round(st.withheld),
  };
  postMessage({ type: 'frame', frame }, { transfer: [xy.buffer, density.buffer] });
  if (Math.round(st.t / SIM.DT) % ROUTES_EVERY === 0) postRoutes();
}

const postRoutes = () => st && postMessage({ type: 'routes', routes: phoneRoutes(st) });

function run() {
  clearInterval(timer);
  timer = setInterval(tick, 1000 / ((1 / SIM.DT) * speed));
}

self.onmessage = (e: MessageEvent<LiveIn>) => {
  const m = e.data;
  if (m.type === 'reset') { st = createSim(venue as never, m.scenario as Scenario, 1); run(); return; }
  if (m.type === 'speed') { speed = m.speed; run(); return; }
  if (!st) return;
  if (m.type === 'arrive') spawnGroup(st, m.source, m.count, m.phoneNum);
  else if (m.type === 'crisis') applyEvent(st, { atMin: 0, type: m.kind, source: m.target, gate: m.target, multiplier: 3, forMin: 5 });
  else if (m.type === 'apply') { m.actions.forEach((a: Action) => applyAction(st!, a)); postRoutes(); }
  else if (m.type === 'snapshot') postMessage({ type: 'snapshot', snap: snapshot(st) });
};
