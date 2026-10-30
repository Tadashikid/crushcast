import { describe, expect, it } from 'vitest';
import { applyEvent, createSim, spawnGroup, step, zoneStats, type SimState } from './sim';
import type { Scenario, Venue } from './venue';
import stadium from '../../../venues/stadium.json';
import surge from '../../../scenarios/announcement-surge.json';

const venue = stadium as unknown as Venue;
const scenario = surge as unknown as Scenario;
const run = (st: SimState, steps: number, each?: (st: SimState) => void) => {
  for (let k = 0; k < steps; k++) { step(st); each?.(st); }
};
const G = (id: string) => venue.gates.findIndex((g) => g.id === id);

describe('sim invariants', () => {
  it('no live agent inside a wall cell, and spawned == inside + entered (every step)', () => {
    const st = createSim(venue, scenario, 7);
    const { width: w, walkable } = st.grid;
    let inWall = 0, leaks = 0;
    run(st, 1200, (s) => {
      for (let i = 0; i < s.n; i++) if (!walkable[(s.y[i] | 0) * w + (s.x[i] | 0)]) inWall++;
      if (s.spawned !== s.n + s.entered) leaks++;
    });
    expect(inWall).toBe(0);
    expect(leaks).toBe(0);
    expect(st.entered).toBeGreaterThan(0);
    expect(st.dropped).toBe(0);
  });

  it('closed gate admits nobody', () => {
    const st = createSim(venue, scenario, 3);
    run(st, 1200);
    expect(st.gateEntered[G('G9')]).toBe(0);
  });

  it('closing a gate mid-run stops admissions there and retargets its crowd', () => {
    const st = createSim(venue, scenario, 3);
    run(st, 600);
    applyEvent(st, { atMin: 0, type: 'closeGate', gate: 'G3' });
    const before = st.gateEntered[G('G3')];
    run(st, 300);
    expect(st.gateEntered[G('G3')]).toBe(before);
    for (let i = 0; i < st.n; i++) expect(st.target[i]).not.toBe(G('G3'));
  });

  it('is deterministic for a fixed seed, and differs across seeds', () => {
    const a = createSim(venue, scenario, 42), b = createSim(venue, scenario, 42), c = createSim(venue, scenario, 43);
    run(a, 400); run(b, 400); run(c, 400);
    expect(b.n).toBe(a.n);
    expect(b.entered).toBe(a.entered);
    expect(b.x.slice(0, b.n)).toEqual(a.x.slice(0, a.n));
    expect(c.x.slice(0, c.n)).not.toEqual(a.x.slice(0, a.n));
  });

  it('queues form at gates under the surge', () => {
    const st = createSim(venue, scenario, 1);
    run(st, 1200); // 10 min, past the minute-8 announcement
    expect(Math.max(...st.gateQueue)).toBeGreaterThan(20);
    expect(Math.max(...zoneStats(st).map((z) => z.maxDensity))).toBeGreaterThan(1);
  });

  it('phone group spawns with the phone on exactly one agent', () => {
    const st = createSim(venue, { ...scenario, arrivals: {} }, 1);
    expect(spawnGroup(st, 'metro', 200, 7)).toBe(200);
    expect(st.n).toBe(200);
    expect(Array.from(st.phoneId.slice(0, st.n)).filter((p) => p === 7)).toHaveLength(1);
    expect(spawnGroup(st, 'nope', 5)).toBe(0);
  });
});
