// Forecast + plan search (CLAUDE.md §7). Pure TS: runs in workers and in Node (eval).
// Flow: snapshot(live) → singleCandidates → runFuture each → pairCandidates → runFuture each → rank.
// searchPlans() does all of it synchronously; the control app spreads the runFuture calls over a worker pool.

import { SIM, baseRate, step, type SimState } from '@crushcast/sim';
import { AP } from './config';

export type Action =
  | { type: 'openGate'; gate: string }
  | { type: 'closeGate'; gate: string }
  | { type: 'boostGate'; gate: string }
  | { type: 'holdSource'; source: string; forMin: number }
  | { type: 'rerouteSource'; source: string; gate: string } // new arrivals from source go to gate
  | { type: 'redirect'; from: string; to: string } // stewards send half of from's approaching crowd to `to`
  | { type: 'capArrivals'; factor: number };

export interface FutureResult {
  actions: Action[];
  score: number;
  dangerPersonMin: number;
  peakDensity: number;
  timeToRedByZone: Record<string, number | null>; // minutes from now, null = stays below red
  enteredBy10: number;
  outsideAtEnd: number; // on the map + withheld upstream
  frames: Uint8Array[]; // FRAME_W × FRAME_H, every FRAME_EVERY_S
}

export interface Plan extends FutureResult {
  baselineDangerPersonMin: number;
  dangerAvoided: number;
}

const gi = (st: SimState, id: string) => st.venue.gates.findIndex((g) => g.id === id);
const si = (st: SimState, id: string) => st.venue.sources.findIndex((s) => s.id === id);

/** Copy of every per-run typed array; venue, grid, distance maps and scenario stay shared (read-only). */
export function cloneState(st: SimState): SimState {
  const c = { ...st } as Record<string, unknown>;
  for (const k of Object.keys(c)) {
    const v = c[k];
    if (ArrayBuffer.isView(v)) c[k] = (v as Uint8Array).slice();
  }
  return c as unknown as SimState;
}

/**
 * Forecast start point. ASSUMPTION: arrivals continue at today's demand per source
 * (scenario rate × any active surge multiplier) for the whole horizon; future events are unknown.
 */
export function snapshot(st: SimState): SimState {
  const c = cloneState(st);
  const minute = st.t / 60;
  const arrivals: Record<string, [number, number][]> = {};
  st.venue.sources.forEach((s, i) => {
    const mult = st.t < st.srcMultUntil[i] ? st.srcMult[i] : 1;
    arrivals[s.id] = [[0, baseRate(st, i, minute) * mult]];
  });
  c.scenario = { durationMin: Infinity, arrivals, events: [], label: 'forecast: current arrivals persist' };
  c.nextEvent = 0;
  c.srcMult.fill(1);
  c.srcMultUntil.fill(0);
  return c;
}

/** Mutates st. Used both inside futures and on the live sim when the operator presses Apply. */
export function applyAction(st: SimState, a: Action) {
  const { width: w } = st.grid;
  const cell = (i: number) => (st.y[i] | 0) * w + (st.x[i] | 0);
  switch (a.type) {
    case 'openGate': {
      const g = gi(st, a.gate);
      if (g < 0) return;
      st.gateOpen[g] = 1;
      // people who can now see a clearly closer gate switch to it
      const margin = SIM.TARGET_BIAS_M / st.venue.cellSize;
      for (let i = 0; i < st.n; i++) if (st.dist[g][cell(i)] + margin < st.dist[st.target[i]][cell(i)]) st.target[i] = g;
      return;
    }
    case 'closeGate': {
      const g = gi(st, a.gate);
      if (g >= 0) st.gateOpen[g] = 0; // step() retargets its crowd
      return;
    }
    case 'boostGate': {
      const g = gi(st, a.gate);
      if (g >= 0) st.gateCap[g] *= AP.BOOST;
      return;
    }
    case 'holdSource': {
      const s = si(st, a.source);
      if (s >= 0) st.srcHoldUntil[s] = st.t + a.forMin * 60;
      return;
    }
    case 'rerouteSource': {
      const s = si(st, a.source), g = gi(st, a.gate);
      if (s >= 0 && g >= 0) st.srcReroute[s] = g;
      return;
    }
    case 'redirect': {
      const f = gi(st, a.from), t = gi(st, a.to);
      if (f < 0 || t < 0) return;
      const admitCells = SIM.ADMIT_RADIUS_M / st.venue.cellSize;
      let k = 0;
      for (let i = 0; i < st.n; i++)
        if (st.target[i] === f && st.dist[f][cell(i)] > admitCells && k++ % 2 === 0) st.target[i] = t;
      return;
    }
    case 'capArrivals':
      st.srcMult.fill(a.factor);
      st.srcMultUntil.fill(Infinity);
      return;
  }
}

const gateName = (id: string) => id.replace(/^G/, 'Gate ');

/** Plain-English action text for plan cards, PA scripts and logs. */
export function describe(a: Action): string {
  switch (a.type) {
    case 'openGate': return `Open ${gateName(a.gate)}`;
    case 'closeGate': return `Close ${gateName(a.gate)}`;
    case 'boostGate': return `Add lanes at ${gateName(a.gate)} (+${Math.round((AP.BOOST - 1) * 100)}%)`;
    case 'holdSource': return `Hold ${a.source} arrivals for ${a.forMin} min`;
    case 'rerouteSource': return `Send new ${a.source} arrivals to ${gateName(a.gate)}`;
    case 'redirect': return `Redirect half the ${gateName(a.from)} crowd to ${gateName(a.to)}`;
    case 'capArrivals': return `Meter all arrivals to ${Math.round(a.factor * 100)}%`;
  }
}

export function actionCost(a: Action): number {
  if (a.type === 'closeGate') return AP.COST_CLOSE_GATE;
  if (a.type === 'holdSource') return AP.COST_HOLD_PER_MIN * a.forMin;
  return AP.COST_OTHER;
}

function frame(st: SimState): Uint8Array {
  const { binW, binH, density } = st;
  const out = new Uint8Array(AP.FRAME_W * AP.FRAME_H);
  const fx = binW / AP.FRAME_W, fy = binH / AP.FRAME_H;
  for (let y = 0; y < AP.FRAME_H; y++)
    for (let x = 0; x < AP.FRAME_W; x++) {
      let m = 0; // max, not mean, so a small red pocket still shows
      for (let by = Math.floor(y * fy); by < Math.floor((y + 1) * fy); by++)
        for (let bx = Math.floor(x * fx); bx < Math.floor((x + 1) * fx); bx++) m = Math.max(m, density[by * binW + bx]);
      out[y * AP.FRAME_W + x] = Math.min(255, Math.round(m * AP.FRAME_SCALE));
    }
  return out;
}

/** Plays `minutes` ahead from a snapshot with `actions` applied at t=0. Never mutates `snap`. */
export function runFuture(snap: SimState, actions: Action[], minutes = AP.HORIZON_MIN, seed = 1): FutureResult {
  const st = cloneState(snap);
  st.seed = seed | 0;
  for (const a of actions) applyAction(st, a);

  const B = SIM.BIN_CELLS, dt = SIM.DT;
  const zoneBins = st.venue.zones.map(({ area: [[x0, y0], [x1, y1]] }) => {
    const bins: number[] = [];
    for (let by = (y0 / B) | 0; by <= ((y1 / B) | 0); by++) for (let bx = (x0 / B) | 0; bx <= ((x1 / B) | 0); bx++) bins.push(by * st.binW + bx);
    return bins;
  });
  const timeToRed: (number | null)[] = st.venue.zones.map(() => null);
  const steps = Math.round((minutes * 60) / dt), frameEvery = Math.round(AP.FRAME_EVERY_S / dt);
  const frames: Uint8Array[] = [];
  let danger = 0, peak = 0;

  for (let k = 1; k <= steps; k++) {
    step(st);
    const { density, counts } = st;
    for (let b = 0; b < density.length; b++) {
      const d = density[b];
      if (d > peak) peak = d;
      if (d > SIM.RED) danger += (counts[b] * dt) / 60;
    }
    zoneBins.forEach((bins, z) => {
      if (timeToRed[z] === null && bins.some((b) => density[b] > SIM.RED)) timeToRed[z] = (k * dt) / 60;
    });
    if (k % frameEvery === 0) frames.push(frame(st));
  }

  const cost = actions.reduce((s, a) => s + actionCost(a), 0);
  return {
    actions,
    score: danger + AP.W_OUTSIDE * (st.n + st.withheld - snap.withheld) + cost,
    dangerPersonMin: danger,
    peakDensity: peak,
    timeToRedByZone: Object.fromEntries(st.venue.zones.map((z, i) => [z.id, timeToRed[i]])),
    enteredBy10: st.entered - snap.entered,
    outsideAtEnd: Math.round(st.n + st.withheld - snap.withheld),
    frames,
  };
}

/** Open gate under the most pressure right now (queue, then arrivals heading there). */
function busiestGate(st: SimState): number {
  let best = -1;
  for (let g = 0; g < st.gateOpen.length; g++) {
    if (!st.gateOpen[g]) continue;
    if (best < 0 || st.gateQueue[g] > st.gateQueue[best] ||
      (st.gateQueue[g] === st.gateQueue[best] && st.gateArrivalRate[g] > st.gateArrivalRate[best])) best = g;
  }
  return best;
}

/** Sources whose nearest open gate (from the middle of their area) is g. */
function sourcesFeeding(st: SimState, g: number): number[] {
  const w = st.grid.width;
  return st.venue.sources.flatMap(({ area: [[x0, y0], [x1, y1]] }, s) => {
    const c = (((y0 + y1) / 2) | 0) * w + (((x0 + x1) / 2) | 0);
    let near = -1;
    for (let k = 0; k < st.dist.length; k++) if (st.gateOpen[k] && (near < 0 || st.dist[k][c] < st.dist[near][c])) near = k;
    return near === g ? [s] : [];
  });
}

/** Feasible single actions (closeGate is crisis-only, never proposed). */
export function singleCandidates(st: SimState): Action[][] {
  const gates = st.venue.gates.map((g) => g.id), out: Action[][] = [];
  const busy = busiestGate(st);
  gates.forEach((id, g) => out.push([st.gateOpen[g] ? { type: 'boostGate', gate: id } : { type: 'openGate', gate: id }]));
  for (const s of st.venue.sources) out.push([{ type: 'holdSource', source: s.id, forMin: AP.HOLD_MIN }]);
  if (busy >= 0) {
    gates.forEach((id, g) => {
      if (g === busy || !st.gateOpen[g]) return;
      out.push([{ type: 'redirect', from: gates[busy], to: id }]);
      for (const s of sourcesFeeding(st, busy)) out.push([{ type: 'rerouteSource', source: st.venue.sources[s].id, gate: id }]);
    });
  }
  out.push([{ type: 'capArrivals', factor: AP.CAP_FACTOR }]);
  return out;
}

/** Pairs of the best singles, plus "open a closed gate AND send people there" for each closed gate. */
export function pairCandidates(st: SimState, singles: FutureResult[]): Action[][] {
  const best = [...singles].sort((a, b) => a.score - b.score).slice(0, AP.TOP_PAIRS_FROM);
  const out: Action[][] = [];
  for (let i = 0; i < best.length; i++) for (let j = i + 1; j < best.length; j++) out.push([...best[i].actions, ...best[j].actions]);
  const busy = busiestGate(st);
  if (busy >= 0) {
    const from = st.venue.gates[busy].id;
    st.venue.gates.forEach((gate, g) => {
      if (st.gateOpen[g]) return;
      out.push([{ type: 'openGate', gate: gate.id }, { type: 'redirect', from, to: gate.id }]);
      for (const s of sourcesFeeding(st, busy))
        out.push([{ type: 'openGate', gate: gate.id }, { type: 'rerouteSource', source: st.venue.sources[s].id, gate: gate.id }]);
    });
  }
  return out;
}

/** Top-k plans by score with "danger avoided" vs the do-nothing future. */
export function rank(baseline: FutureResult, results: FutureResult[], k = 3): Plan[] {
  return [...results]
    .sort((a, b) => a.score - b.score)
    .slice(0, k)
    .map((r) => ({ ...r, baselineDangerPersonMin: baseline.dangerPersonMin, dangerAvoided: baseline.dangerPersonMin - r.dangerPersonMin }));
}

/** Whole search in one thread (Node / eval / tests). Same seed for every future = fair comparison. */
export function searchPlans(live: SimState, seed = 1, minutes = AP.HORIZON_MIN, k = 3) {
  const snap = snapshot(live);
  const run = (a: Action[]) => runFuture(snap, a, minutes, seed);
  const baseline = run([]);
  const singles = singleCandidates(snap).map(run);
  const pairs = pairCandidates(snap, singles).map(run);
  return { baseline, plans: rank(baseline, [...singles, ...pairs], k), futuresRun: 1 + singles.length + pairs.length };
}
