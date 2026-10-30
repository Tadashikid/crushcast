// Crowd engine (CLAUDE.md §6). Agents live in typed arrays, kept dense: index < n is alive,
// removal swaps the last agent in. Pure TS, deterministic for a fixed seed.

import { SIM } from './config';
import { rasterise, type Grid, type Scenario, type ScenarioEvent, type Venue } from './venue';

export interface SimState {
  venue: Venue;
  scenario: Scenario;
  grid: Grid;
  dist: Float32Array[]; // per gate, metres-in-cells to the gate line (Infinity = unreachable)

  t: number; // simulated seconds
  seed: number; // mulberry32 state
  nextEvent: number; // index into scenario.events (sorted by atMin)
  rainUntil: number;

  n: number; // live agents
  x: Float32Array; // cells
  y: Float32Array;
  vFree: Float32Array; // m/s
  target: Int16Array; // gate index
  phoneId: Int16Array; // -1 if none

  gateOpen: Uint8Array;
  gateCap: Float32Array; // people/min
  gateTokens: Float32Array;
  gateQueue: Uint16Array; // agents within QUEUE_STAT_RADIUS_M, last step
  gateEntered: Uint32Array;
  gateArrivalRate: Float32Array; // people/min newly heading to gate (EWMA ~1 min)
  gateAdmitRate: Float32Array; // people/min admitted (EWMA ~1 min)

  srcAcc: Float32Array; // fractional spawn accumulator
  srcMult: Float32Array;
  srcMultUntil: Float32Array;
  srcHoldUntil: Float32Array;
  srcReroute: Int16Array; // gate index or -1
  srcRate: Float32Array; // people/min actually spawned (EWMA ~1 min)

  spawned: number;
  entered: number;
  withheld: number; // people kept upstream by holds/caps (still outside, just not on the map)
  dropped: number; // arrivals lost to MAX_AGENTS (a full source area just delays arrivals instead)

  binW: number;
  binH: number;
  counts: Float32Array; // raw agents per bin
  density: Float32Array; // smoothed people/m² per bin
}

export function rand(st: SimState): number {
  let t = (st.seed = (st.seed + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// candidate headings: [cos, sin, angle cost] for 0, ±30°, ±60° off the gradient
const STEER = [0, Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3].flatMap((a) => [Math.cos(a), Math.sin(a), Math.abs(a) * SIM.STEER_ANGLE_COST]);

const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

// 8-neighbour Dijkstra from seed cells; diagonals cost √2 and may not cut wall corners.
export function distanceMap(grid: Grid, seeds: Int32Array): Float32Array {
  const { width: w, height: h, walkable } = grid;
  const d = new Float32Array(w * h).fill(Infinity);
  const hk: number[] = [], hi: number[] = [];
  const push = (k: number, i: number) => {
    let c = hk.length;
    hk.push(k); hi.push(i);
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (hk[p] <= k) break;
      hk[c] = hk[p]; hi[c] = hi[p]; c = p;
    }
    hk[c] = k; hi[c] = i;
  };
  for (const i of seeds) { d[i] = 0; push(0, i); }
  while (hk.length) {
    const k = hk[0], i = hi[0];
    const lk = hk.pop()!, li = hi.pop()!;
    if (hk.length) {
      let c = 0;
      for (;;) {
        let ch = 2 * c + 1;
        if (ch >= hk.length) break;
        if (ch + 1 < hk.length && hk[ch + 1] < hk[ch]) ch++;
        if (hk[ch] >= lk) break;
        hk[c] = hk[ch]; hi[c] = hi[ch]; c = ch;
      }
      hk[c] = lk; hi[c] = li;
    }
    if (k > d[i]) continue;
    const x = i % w, y = (i / w) | 0;
    for (const [ox, oy] of NB) {
      const nx = x + ox, ny = y + oy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (!walkable[j]) continue;
      if (ox && oy && !(walkable[y * w + nx] && walkable[ny * w + x])) continue;
      // fround: compare in float32 like d[], else a rounded-up store re-queues the same cell forever
      const nd = Math.fround(k + (ox && oy ? Math.SQRT2 : 1));
      if (nd < d[j]) { d[j] = nd; push(nd, j); }
    }
  }
  return d;
}

export function createSim(venue: Venue, scenario: Scenario, seed = 1): SimState {
  const srcIds = venue.sources.map((s) => s.id), gateIds = venue.gates.map((g) => g.id);
  for (const id of Object.keys(scenario.arrivals))
    if (!srcIds.includes(id)) throw new Error(`scenario arrivals: unknown source ${id}`);

  const grid = rasterise(venue);
  const G = venue.gates.length, S = venue.sources.length, M = SIM.MAX_AGENTS;
  const binW = Math.ceil(grid.width / SIM.BIN_CELLS), binH = Math.ceil(grid.height / SIM.BIN_CELLS);
  const st: SimState = {
    venue, grid,
    scenario: { ...scenario, events: [...scenario.events].sort((a, b) => a.atMin - b.atMin) },
    dist: grid.gateCells.map((c) => distanceMap(grid, c)),
    t: 0, seed: seed | 0, nextEvent: 0, rainUntil: 0,
    n: 0,
    x: new Float32Array(M), y: new Float32Array(M), vFree: new Float32Array(M),
    target: new Int16Array(M), phoneId: new Int16Array(M).fill(-1),
    gateOpen: Uint8Array.from(venue.gates, (g) => +g.open),
    gateCap: Float32Array.from(venue.gates, (g) => g.capacityPerMin),
    gateTokens: new Float32Array(G), gateQueue: new Uint16Array(G), gateEntered: new Uint32Array(G),
    gateArrivalRate: new Float32Array(G), gateAdmitRate: new Float32Array(G),
    srcAcc: new Float32Array(S), srcMult: new Float32Array(S).fill(1), srcMultUntil: new Float32Array(S),
    srcHoldUntil: new Float32Array(S), srcReroute: new Int16Array(S).fill(-1), srcRate: new Float32Array(S),
    spawned: 0, entered: 0, withheld: 0, dropped: 0,
    binW, binH, counts: new Float32Array(binW * binH), density: new Float32Array(binW * binH),
  };
  for (const e of st.scenario.events) {
    if (e.source && !srcIds.includes(e.source)) throw new Error(`event: unknown source ${e.source}`);
    if (e.gate && !gateIds.includes(e.gate)) throw new Error(`event: unknown gate ${e.gate}`);
  }
  return st;
}

/** Scenario arrival rate (people/min) for source index s at simulated minute m, before multipliers/holds. */
export function baseRate(st: SimState, s: number, m: number): number {
  let r = 0;
  for (const [min, ppm] of st.scenario.arrivals[st.venue.sources[s].id] ?? []) if (min <= m) r = ppm;
  return r;
}

/** Scenario events and live crises go through here (crisis = event at the current time). */
export function applyEvent(st: SimState, e: ScenarioEvent) {
  const forS = (e.forMin ?? 5) * 60;
  if (e.type === 'announcement') {
    const s = st.venue.sources.findIndex((x) => x.id === e.source);
    if (s < 0) return;
    st.srcMult[s] = e.multiplier ?? 3;
    st.srcMultUntil[s] = st.t + forS;
  } else if (e.type === 'closeGate') {
    const g = st.venue.gates.findIndex((x) => x.id === e.gate);
    if (g >= 0) st.gateOpen[g] = 0;
  } else if (e.type === 'rain') {
    st.rainUntil = st.t + forS;
  }
}

/** Nearest open gate (+ random bias) from `cell`, honouring source s's reroute. s = -1 for no source. */
export function chooseTarget(st: SimState, cell: number, s: number): number {
  const r = s >= 0 ? st.srcReroute[s] : -1;
  if (r >= 0 && st.gateOpen[r]) return r;
  const bias = SIM.TARGET_BIAS_M / st.venue.cellSize;
  let best = -1, bestD = Infinity, nearest = 0, nearestD = Infinity;
  for (let g = 0; g < st.dist.length; g++) {
    const d = st.dist[g][cell];
    if (d < nearestD) { nearestD = d; nearest = g; }
    if (!st.gateOpen[g]) continue;
    const db = d + rand(st) * bias;
    if (db < bestD) { bestD = db; best = g; }
  }
  return best >= 0 ? best : nearest; // no open gate: walk to the nearest and wait
}

const binOf = (st: SimState, x: number, y: number) => ((y / SIM.BIN_CELLS) | 0) * st.binW + ((x / SIM.BIN_CELLS) | 0);

/** Spawn one agent in source s. Returns false if the source area is full (unless forced) or at MAX_AGENTS. */
function spawnOne(st: SimState, s: number, phoneId = -1, force = false): boolean {
  if (st.n >= SIM.MAX_AGENTS) return false;
  const { width: w, walkable } = st.grid;
  const [[x0, y0], [x1, y1]] = st.venue.sources[s].area;
  let x = 0, y = 0, ok = false;
  for (let tries = 0; tries < 10 && !ok; tries++) {
    x = x0 + rand(st) * (x1 - x0 + 1);
    y = y0 + rand(st) * (y1 - y0 + 1);
    ok = !!walkable[(y | 0) * w + (x | 0)] && (force || st.counts[binOf(st, x, y)] < SIM.BIN_CAP);
  }
  if (!ok) return false;
  st.counts[binOf(st, x, y)]++;
  const i = st.n++;
  st.x[i] = x; st.y[i] = y;
  st.vFree[i] = SIM.V_FREE_MIN + rand(st) * (SIM.V_FREE_MAX - SIM.V_FREE_MIN);
  st.target[i] = chooseTarget(st, (y | 0) * w + (x | 0), s);
  st.phoneId[i] = phoneId;
  st.spawned++;
  return true;
}

/** A phone tapping "I'm arriving": `count` people appear at the source; the last one carries the phone (back of the group, so it lives long enough to be rerouted). */
export function spawnGroup(st: SimState, sourceId: string, count: number, phoneId = -1): number {
  const s = st.venue.sources.findIndex((x) => x.id === sourceId);
  if (s < 0) return 0;
  let made = 0;
  for (let k = 0; k < count; k++) if (spawnOne(st, s, k === count - 1 ? phoneId : -1, true)) made++;
  return made;
}

function removeAgent(st: SimState, i: number) {
  const last = --st.n;
  st.x[i] = st.x[last]; st.y[i] = st.y[last]; st.vFree[i] = st.vFree[last];
  st.target[i] = st.target[last]; st.phoneId[i] = st.phoneId[last];
  st.phoneId[last] = -1;
}

function computeDensity(st: SimState) {
  const { binW, binH, counts, density } = st;
  const B = SIM.BIN_CELLS, binArea = (B * st.venue.cellSize) ** 2;
  counts.fill(0);
  for (let i = 0; i < st.n; i++) counts[binOf(st, st.x[i], st.y[i])]++;
  for (let by = 0; by < binH; by++)
    for (let bx = 0; bx < binW; bx++) {
      let sum = 0, k = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = bx + dx, y = by + dy;
          if (x < 0 || y < 0 || x >= binW || y >= binH) continue;
          sum += counts[y * binW + x]; k++;
        }
      density[by * binW + bx] = sum / (k * binArea);
    }
}

export function speedFactor(rho: number): number {
  if (rho >= SIM.RHO_JAM) return SIM.MIN_SPEED_FACTOR;
  if (rho < 0.01) return 1;
  const f = 1 - Math.exp(-SIM.WEIDMANN_GAMMA * (1 / rho - 1 / SIM.RHO_JAM));
  return Math.max(SIM.MIN_SPEED_FACTOR, f);
}

export function step(st: SimState) {
  const dt = SIM.DT, alpha = dt / 60, cs = st.venue.cellSize;
  const { width: w, walkable } = st.grid;
  const G = st.dist.length, S = st.venue.sources.length;

  // 1. timed events
  const ev = st.scenario.events;
  while (st.nextEvent < ev.length && ev[st.nextEvent].atMin * 60 <= st.t) applyEvent(st, ev[st.nextEvent++]);

  // 2. arrivals
  const headed = new Float32Array(G);
  for (let s = 0; s < S; s++) {
    // srcMult > 1 is a surge (more demand), < 1 is a cap (demand kept upstream)
    const mult = st.t < st.srcMultUntil[s] ? st.srcMult[s] : 1;
    const demand = baseRate(st, s, st.t / 60) * Math.max(1, mult);
    const rate = st.t < st.srcHoldUntil[s] ? 0 : demand * Math.min(1, mult);
    st.withheld += ((demand - rate) * dt) / 60;
    st.srcAcc[s] += (rate * dt) / 60;
    let made = 0;
    if (st.n >= SIM.MAX_AGENTS) { const lost = Math.floor(st.srcAcc[s]); st.dropped += lost; st.srcAcc[s] -= lost; }
    while (st.srcAcc[s] >= 1 && spawnOne(st, s)) { st.srcAcc[s]--; made++; headed[st.target[st.n - 1]]++; }
    st.srcRate[s] += alpha * ((made * 60) / dt - st.srcRate[s]);
  }

  // 3. density
  computeDensity(st);

  // 4. movement
  let anyOpen = false;
  for (let g = 0; g < G; g++) if (st.gateOpen[g]) anyOpen = true;
  const B = SIM.BIN_CELLS, { binW, binH, density, counts } = st;
  const rain = st.t < st.rainUntil ? SIM.RAIN_SPEED : 1;
  const probe = SIM.STEER_PROBE_M / cs;
  const at = (bx: number, by: number) =>
    density[Math.min(binH - 1, Math.max(0, by)) * binW + Math.min(binW - 1, Math.max(0, bx))];

  let b0 = 0;
  const free = (px: number, py: number) => {
    if (!walkable[(py | 0) * w + (px | 0)]) return false;
    const b = binOf(st, px, py);
    return b === b0 || counts[b] < SIM.BIN_CAP;
  };

  for (let i = 0; i < st.n; i++) {
    let x = st.x[i], y = st.y[i];
    const cx = x | 0, cy = y | 0, c = cy * w + cx;
    if (anyOpen && !st.gateOpen[st.target[i]]) { st.target[i] = chooseTarget(st, c, -1); headed[st.target[i]]++; }
    const D = st.dist[st.target[i]], d0 = D[c];
    if (!(d0 > 0.5) || d0 === Infinity) continue; // at the gate line (waiting) or unreachable

    let gx = 0, gy = 0;
    for (const [ox, oy] of NB) {
      const j = (cy + oy) * w + cx + ox;
      const dn = D[j];
      if (!walkable[j] || dn === Infinity) continue;
      const k = (d0 - dn) / (ox && oy ? 2 : 1);
      gx += k * ox; gy += k * oy;
    }
    const gl = Math.hypot(gx, gy) || 1;
    const ux = gx / gl, uy = gy / gl;
    const bx = (x / B) | 0, by = (y / B) | 0;
    let hx = ux, hy = uy, bestCost = Infinity;
    for (let a = 0; a < STEER.length; a += 3) {
      const cos = STEER[a], sin = STEER[a + 1];
      const rx = ux * cos - uy * sin, ry = ux * sin + uy * cos;
      const px = x + rx * probe, py = y + ry * probe;
      if (!walkable[(py | 0) * w + (px | 0)]) continue;
      const cost = at((px / B) | 0, (py / B) | 0) + STEER[a + 2];
      if (cost < bestCost) { bestCost = cost; hx = rx; hy = ry; }
    }
    let dx = hx + (rand(st) - 0.5) * 2 * SIM.JITTER;
    let dy = hy + (rand(st) - 0.5) * 2 * SIM.JITTER;
    const dl = Math.hypot(dx, dy) || 1;
    dx /= dl; dy /= dl;

    // two half-steps so a max-speed move (≤1.5 cells) can never hop a 1-cell wall
    const half = (st.vFree[i] * speedFactor(at(bx, by)) * rain * dt) / cs / 2;
    // a full bin (BIN_CAP) blocks entry like a wall, so density can't exceed physical packing
    b0 = binOf(st, x, y);
    for (let k = 0; k < 2; k++) {
      const nx = x + dx * half, ny = y + dy * half;
      if (free(nx, ny)) { x = nx; y = ny; }
      else if (free(nx, y)) x = nx;
      else if (free(x, ny)) y = ny;
    }
    const b1 = binOf(st, x, y);
    if (b1 !== b0) { counts[b0]--; counts[b1]++; }
    st.x[i] = x; st.y[i] = y;
  }

  // 5. gates: token bucket, admit agents within ADMIT_RADIUS of their open gate
  const admitCells = SIM.ADMIT_RADIUS_M / cs, queueCells = SIM.QUEUE_STAT_RADIUS_M / cs;
  const admitted = new Float32Array(G);
  for (let g = 0; g < G; g++) {
    const perStep = (st.gateCap[g] * dt) / 60;
    st.gateTokens[g] = st.gateOpen[g] ? Math.min(st.gateTokens[g] + perStep, perStep + 1) : 0;
    st.gateQueue[g] = 0;
  }
  for (let i = st.n - 1; i >= 0; i--) {
    const g = st.target[i], d = st.dist[g][(st.y[i] | 0) * w + (st.x[i] | 0)];
    if (d <= queueCells) st.gateQueue[g]++;
    if (st.gateOpen[g] && d <= admitCells && st.gateTokens[g] >= 1) {
      st.gateTokens[g]--;
      admitted[g]++;
      st.gateEntered[g]++;
      st.entered++;
      removeAgent(st, i);
    }
  }
  for (let g = 0; g < G; g++) {
    st.gateArrivalRate[g] += alpha * ((headed[g] * 60) / dt - st.gateArrivalRate[g]);
    st.gateAdmitRate[g] += alpha * ((admitted[g] * 60) / dt - st.gateAdmitRate[g]);
  }

  st.t += dt;
}

export interface ZoneStat { id: string; label: string; count: number; maxDensity: number }

export function zoneStats(st: SimState): ZoneStat[] {
  const B = SIM.BIN_CELLS;
  return st.venue.zones.map(({ id, label, area: [[x0, y0], [x1, y1]] }) => {
    let count = 0, maxDensity = 0;
    for (let i = 0; i < st.n; i++) if (st.x[i] >= x0 && st.x[i] < x1 + 1 && st.y[i] >= y0 && st.y[i] < y1 + 1) count++;
    for (let by = (y0 / B) | 0; by <= ((y1 / B) | 0); by++)
      for (let bx = (x0 / B) | 0; bx <= ((x1 / B) | 0); bx++) maxDensity = Math.max(maxDensity, st.density[by * st.binW + bx]);
    return { id, label, count, maxDensity };
  });
}

export interface PhoneRoute {
  type: 'route';
  phoneId: number;
  gate: string;
  etaSec: number;
  arrow: 'up' | 'down' | 'left' | 'right'; // map-relative (up = towards the stadium)
  text: string;
}

/** Current route for every phone-carrying agent: target gate, walk + queue wait, first-step direction. */
export function phoneRoutes(st: SimState): PhoneRoute[] {
  const { width: w, walkable } = st.grid, cs = st.venue.cellSize;
  const out: PhoneRoute[] = [];
  for (let i = 0; i < st.n; i++) {
    if (st.phoneId[i] < 0) continue;
    const g = st.target[i], D = st.dist[g], cx = st.x[i] | 0, cy = st.y[i] | 0;
    let bx = 0, by = -1, best = D[cy * w + cx];
    for (const [ox, oy] of NB) {
      const j = (cy + oy) * w + cx + ox;
      if (walkable[j] && D[j] < best) { best = D[j]; bx = ox; by = oy; }
    }
    const arrow = Math.abs(by) >= Math.abs(bx) ? (by < 0 ? 'up' : 'down') : bx > 0 ? 'right' : 'left';
    const walk = (D[cy * w + cx] * cs) / st.vFree[i];
    const wait = st.gateCap[g] > 0 ? (st.gateQueue[g] / st.gateCap[g]) * 60 : 0;
    const etaSec = Math.round(walk + wait);
    const gate = st.venue.gates[g].id;
    out.push({ type: 'route', phoneId: st.phoneId[i], gate, etaSec, arrow,
      text: `Use ${gate.replace(/^G/, 'Gate ')}, ~${Math.max(1, Math.round(etaSec / 60))} min` });
  }
  return out;
}
