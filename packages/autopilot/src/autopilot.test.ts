import { describe, expect, it } from 'vitest';
import { createSim, phoneRoutes, spawnGroup, step, SIM, type Scenario, type SimState, type Venue } from '@crushcast/sim';
import { applyAction, runFuture, searchPlans, snapshot } from './autopilot';
import { AP } from './config';
import stadium from '../../../venues/stadium.json';
import surge from '../../../scenarios/announcement-surge.json';

const venue = stadium as unknown as Venue;
const scenario = surge as unknown as Scenario;
const liveAt = (min: number) => {
  const st = createSim(venue, scenario, 1);
  for (let k = 0; k < (min * 60) / SIM.DT; k++) step(st);
  return st;
};
const G = (st: SimState, id: string) => st.venue.gates.findIndex((g) => g.id === id);

describe('autopilot', () => {
  const live = liveAt(10); // two minutes into the metro surge

  it('runFuture is deterministic and never touches the snapshot', () => {
    const snap = snapshot(live);
    const before = { n: snap.n, x: snap.x.slice(), open: snap.gateOpen.slice(), t: snap.t };
    const a = runFuture(snap, [{ type: 'openGate', gate: 'G9' }], 2, 5);
    const b = runFuture(snap, [{ type: 'openGate', gate: 'G9' }], 2, 5);
    expect(b.dangerPersonMin).toBe(a.dangerPersonMin);
    expect(b.frames).toEqual(a.frames);
    expect(snap.n).toBe(before.n);
    expect(snap.t).toBe(before.t);
    expect(snap.x).toEqual(before.x);
    expect(snap.gateOpen).toEqual(before.open);
  });

  it('produces one frame per FRAME_EVERY_S at FRAME_W × FRAME_H', () => {
    const r = runFuture(snapshot(live), [], 10);
    expect(r.frames).toHaveLength((10 * 60) / AP.FRAME_EVERY_S);
    expect(r.frames[0]).toHaveLength(AP.FRAME_W * AP.FRAME_H);
  });

  it('finds a plan that beats doing nothing during the surge', () => {
    const { baseline, plans } = searchPlans(live, 1, 2);
    expect(baseline.dangerPersonMin).toBeGreaterThan(0);
    expect(plans).toHaveLength(3);
    expect(plans[0].score).toBeLessThan(baseline.score);
    expect(plans[0].dangerAvoided).toBeGreaterThan(0);
  });

  it('holdSource stops spawns there and counts the held people as still outside', () => {
    const st = snapshot(live);
    applyAction(st, { type: 'holdSource', source: 'metro', forMin: 1 });
    const spawned = st.spawned;
    for (let k = 0; k < 60 / SIM.DT; k++) step(st);
    expect(st.withheld).toBeGreaterThan(0);
    expect(st.spawned - spawned).toBeLessThan(200); // only bus + road (≈130/min) kept arriving
  });

  it('open G9 + redirect G3→G9 moves crowd and phone routes follow targets', () => {
    const st = snapshot(live);
    spawnGroup(st, 'metro', 50, 7);
    expect(phoneRoutes(st).find((r) => r.phoneId === 7)?.text).toMatch(/^Use Gate 3, ~\d+ min$/);
    const onG3 = () => Array.from(st.target.slice(0, st.n)).filter((g) => g === G(st, 'G3')).length;
    const before = onG3();
    applyAction(st, { type: 'openGate', gate: 'G9' });
    applyAction(st, { type: 'redirect', from: 'G3', to: 'G9' });
    expect(onG3()).toBeLessThan(before * 0.6);
    for (let i = 0; i < st.n; i++)
      if (st.phoneId[i] >= 0) expect(phoneRoutes(st)[0].gate).toBe(st.venue.gates[st.target[i]].id);
  });
});
