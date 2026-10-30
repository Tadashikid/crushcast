// Control-room logic, UI-free. Owns the live-sim worker, the forecast worker pool and the relay socket.
// UI reads `store` (React: useUi) and `latest` (canvas, every animation frame) and calls `actions`.
// Swapping the UI means rewriting App.tsx only.

import { describe, pairCandidates, rank, singleCandidates, type Action, type FutureResult, type Plan } from '@crushcast/autopilot';
import { SIM, type PhoneRoute, type Scenario, type SimState, type Venue, type ZoneStat } from '@crushcast/sim';
import { useSyncExternalStore } from 'react';
import venueJson from '../../../../venues/stadium.json';
import calm from '../../../../scenarios/calm.json';
import surge from '../../../../scenarios/announcement-surge.json';

export const venue = venueJson as unknown as Venue;
export const SCENARIOS: Record<string, Scenario> = { calm: calm as unknown as Scenario, surge: surge as unknown as Scenario };
const SEARCH_EVERY_MS = 15000;

export interface Frame {
  t: number;
  n: number;
  xy: Float32Array; // interleaved x,y in cells
  phones: { num: number; x: number; y: number }[];
  density: Float32Array; // people/m², binW × binH
  binW: number;
  binH: number;
  gateOpen: number[];
  gateCap: number[];
  gateQueue: number[];
  gateArrival: number[];
  gateAdmit: number[];
  zones: ZoneStat[];
  entered: number;
  withheld: number;
}

export type LiveIn =
  | { type: 'reset'; scenario: Scenario }
  | { type: 'speed'; speed: number }
  | { type: 'arrive'; source: string; count: number; phoneNum: number }
  | { type: 'crisis'; kind: 'announcement' | 'closeGate' | 'rain'; target?: string }
  | { type: 'apply'; actions: Action[] }
  | { type: 'snapshot' };

export interface Status { level: 'green' | 'amber' | 'red'; message: string }
export interface PhoneInfo { emoji: string; source: string; arrived: boolean }

export interface Ui {
  frame?: Frame; // throttled copy for panels (~2/s)
  phones: Record<number, PhoneInfo>;
  baseline?: FutureResult;
  plans: Plan[];
  selected: number;
  searching: boolean;
  searchMs?: number;
  searchedAt?: number; // sim seconds of the snapshot
  futuresRun?: number;
  status: Status;
  joinUrl?: string;
  connected: boolean;
  speed: number;
  scenario: string;
  log: string[];
}

let ui: Ui = {
  phones: {}, plans: [], selected: 0, searching: false, connected: false, speed: 4, scenario: 'calm', log: [],
  status: { level: 'green', message: 'Starting…' },
};
const listeners = new Set<() => void>();
const set = (patch: Partial<Ui>) => { ui = { ...ui, ...patch }; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useUi = () => useSyncExternalStore(subscribe, () => ui);
export const getUi = () => ui;

/** Newest frame, for the canvas loop (no React re-render per step). */
export let latest: Frame | undefined;

const clock = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const log = (msg: string) => set({ log: [`${clock(latest?.t ?? 0)} ${msg}`, ...ui.log].slice(0, 8) });

// ---- live sim worker ----
const live = new Worker(new URL('./live.worker.ts', import.meta.url), { type: 'module' });
const toLive = (m: LiveIn) => live.postMessage(m);
let snapWaiter: ((s: SimState) => void) | undefined;
let lastPanel = 0;
live.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'frame') {
    latest = m.frame;
    const now = performance.now();
    if (now - lastPanel > 500) { lastPanel = now; set({ frame: m.frame }); updateStatus(); }
  } else if (m.type === 'routes') sendRoutes(m.routes);
  else if (m.type === 'snapshot') { snapWaiter?.(m.snap); snapWaiter = undefined; }
};

// ---- forecast worker pool ----
const pool = Array.from({ length: Math.max(2, (navigator.hardwareConcurrency || 4) - 1) },
  () => new Worker(new URL('./future.worker.ts', import.meta.url), { type: 'module' }));

function runAll(snap: SimState, jobs: Action[][]): Promise<FutureResult[]> {
  return new Promise((resolve, reject) => {
    const out: FutureResult[] = new Array(jobs.length);
    let next = 0, done = 0;
    if (!jobs.length) return resolve(out);
    const feed = (w: Worker) => {
      if (next >= jobs.length) return;
      const id = next++;
      w.onmessage = (e) => { out[id] = e.data; if (++done === jobs.length) resolve(out); else feed(w); };
      w.onerror = (err) => reject(err);
      w.postMessage({ snap, actions: jobs[id] });
    };
    pool.forEach(feed);
  });
}

async function search() {
  if (ui.searching || !latest) return;
  set({ searching: true });
  const t0 = performance.now();
  try {
    const snap = await new Promise<SimState>((r) => { snapWaiter = r; toLive({ type: 'snapshot' }); });
    const [baseline, ...singles] = await runAll(snap, [[], ...singleCandidates(snap)]);
    const pairs = await runAll(snap, pairCandidates(snap, singles));
    set({ baseline, plans: rank(baseline, [...singles, ...pairs]), selected: 0, searchMs: performance.now() - t0,
      searchedAt: snap.t, futuresRun: 1 + singles.length + pairs.length });
    updateStatus();
  } catch (err) {
    log(`autopilot failed: ${String(err)}`);
  } finally {
    set({ searching: false });
  }
}

// ---- status banner (sent to phones too) ----
function updateStatus() {
  const f = ui.frame;
  if (!f) return;
  const redNow = f.zones.filter((z) => z.maxDensity > SIM.RED);
  let s: Status = { level: 'green', message: 'All approaches below danger level' };
  if (redNow.length) s = { level: 'red', message: `Dangerous density now at ${redNow.map((z) => z.label).join(', ')}` };
  else if (ui.baseline) {
    const soon = Object.entries(ui.baseline.timeToRedByZone)
      .filter((e): e is [string, number] => e[1] !== null)
      .sort((a, b) => a[1] - b[1])[0];
    if (soon) {
      const left = soon[1] - (f.t - (ui.searchedAt ?? f.t)) / 60;
      const label = venue.zones.find((z) => z.id === soon[0])?.label ?? soon[0];
      s = { level: 'amber', message: `Dangerous density at ${label} in ~${Math.max(1, Math.round(left))} min if nothing changes` };
    }
  }
  if (s.message !== ui.status.message) { set({ status: s }); send({ type: 'status', ...s }); }
}

// ---- relay socket ----
let ws: WebSocket | undefined;
const send = (m: unknown) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
const phoneNum = (id: unknown) => {
  const n = typeof id === 'string' ? Number(id.slice(1)) : NaN;
  return Number.isInteger(n) && n > 0 && n < 32767 ? n : -1;
};

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=control`);
  ws.onopen = () => set({ connected: true });
  ws.onclose = () => { set({ connected: false }); setTimeout(connect, 2000); };
  ws.onmessage = (e) => onServer(JSON.parse(e.data));
}

function onServer(m: Record<string, unknown>) {
  if (m.type === 'phones') {
    const phones = { ...ui.phones };
    for (const p of m.phones as { phoneId: string; emoji?: string; source?: string }[]) {
      const n = phoneNum(p.phoneId);
      if (n > 0 && p.source) phones[n] = { emoji: p.emoji ?? '🙂', source: p.source, arrived: phones[n]?.arrived ?? false };
    }
    set({ phones });
    return;
  }
  const n = phoneNum(m.phoneId);
  if (n < 0) return;
  const info = ui.phones[n];
  if (m.type === 'join') {
    set({ phones: { ...ui.phones, [n]: { emoji: m.emoji as string, source: m.source as string, arrived: info?.arrived ?? false } } });
    log(`${m.emoji} joined at ${m.source}`);
  } else if (m.type === 'arrive') {
    const source = info?.source ?? venue.sources[0].id;
    toLive({ type: 'arrive', source, count: m.count as number, phoneNum: info?.arrived ? -1 : n }); // phone rides its first group only
    set({ phones: { ...ui.phones, [n]: { emoji: info?.emoji ?? '🙂', source, arrived: true } } });
    log(`${info?.emoji ?? '🙂'} arrived with ${m.count} people at ${source}`);
  } else if (m.type === 'crisis') {
    actions.crisis(m.kind as 'announcement' | 'closeGate' | 'rain', m.target as string | undefined, info?.emoji);
  }
}

// ---- phone routes: send only when something a person would notice changed ----
const lastRoute = new Map<number, string>();
function sendRoutes(routes: PhoneRoute[]) {
  const present = new Set<number>();
  for (const r of routes) {
    present.add(r.phoneId);
    const key = `${r.gate}|${r.arrow}|${Math.round(r.etaSec / 30)}`;
    if (lastRoute.get(r.phoneId) === key) continue;
    lastRoute.set(r.phoneId, key);
    send({ ...r, phoneId: `p${r.phoneId}` });
  }
  for (const [num, key] of lastRoute) {
    if (present.has(num) || key === 'in') continue;
    lastRoute.set(num, 'in');
    send({ type: 'route', phoneId: `p${num}`, gate: '', etaSec: 0, arrow: 'up', text: "You're inside — enjoy the match!" });
  }
}

// ---- what the UI can do ----
export const actions = {
  select: (i: number) => set({ selected: i }),
  apply(i: number) {
    const p = ui.plans[i];
    if (!p) return;
    toLive({ type: 'apply', actions: p.actions });
    log(`Applied: ${p.actions.map(describe).join(' + ')}`);
    set({ plans: [], baseline: undefined });
    setTimeout(search, 1500);
  },
  gate(id: string, open: boolean) {
    toLive({ type: 'apply', actions: [{ type: open ? 'openGate' : 'closeGate', gate: id }] });
    log(`${open ? 'Opened' : 'Closed'} ${id} manually`);
  },
  crisis(kind: 'announcement' | 'closeGate' | 'rain', target?: string, by = '🎛️') {
    toLive({ type: 'crisis', kind, target });
    log(`${by} crisis: ${kind}${target ? ` (${target})` : ''}`);
    setTimeout(search, 1500);
  },
  speed(speed: number) { toLive({ type: 'speed', speed }); set({ speed }); },
  reset(name: string) {
    toLive({ type: 'reset', scenario: SCENARIOS[name] });
    lastRoute.clear();
    set({ scenario: name, plans: [], baseline: undefined, phones: {}, log: [] });
  },
  search,
};

export function start() {
  fetch('/api/join-url').then((r) => r.json()).then((j) => set({ joinUrl: j.url })).catch(() => {});
  actions.reset('calm');
  toLive({ type: 'speed', speed: ui.speed });
  connect();
  setInterval(search, SEARCH_EVERY_MS);
}
