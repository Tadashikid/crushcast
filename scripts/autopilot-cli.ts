// Headless autopilot check: run the live scenario to minute M, then search plans.
// npm run autopilot -- [minute] [scenarioFile] [--all]
import { readFileSync } from 'node:fs';
import { createSim, step, SIM, type Scenario, type Venue } from '@crushcast/sim';
import { searchPlans, type Action } from '@crushcast/autopilot';

const all = process.argv.includes('--all');
const [minute = '10', scenarioFile = 'scenarios/announcement-surge.json'] = process.argv.slice(2).filter((a) => a !== '--all');
const venue: Venue = JSON.parse(readFileSync('venues/stadium.json', 'utf8'));
const scenario: Scenario = JSON.parse(readFileSync(scenarioFile, 'utf8'));
const live = createSim(venue, scenario, 1);
for (let k = 0; k < (+minute * 60) / SIM.DT; k++) step(live);

const fmt = (a: Action[]) => a.map((x) => Object.values(x).join(' ')).join(' + ') || 'do nothing';
const t0 = performance.now();
const { baseline, plans, futuresRun } = searchPlans(live, 1, undefined, all ? Infinity : 3);
const ms = performance.now() - t0;

console.log(`live minute ${minute}: ${live.n} outside, queues ${venue.gates.map((g, i) => `${g.id}=${live.gateQueue[i]}`).join(' ')}`);
console.log(`time to red (baseline): ${JSON.stringify(baseline.timeToRedByZone)}`);
console.log(`\n${'plan'.padEnd(52)} score  danger p·min  peak/m²  entered  outside`);
for (const r of [baseline, ...plans])
  console.log(`${fmt(r.actions).padEnd(52)} ${r.score.toFixed(0).padStart(5)}  ${r.dangerPersonMin.toFixed(0).padStart(12)}  ${r.peakDensity.toFixed(1).padStart(7)}  ${String(r.enteredBy10).padStart(7)}  ${String(r.outsideAtEnd).padStart(7)}`);
console.log(`\n${futuresRun} futures in ${ms.toFixed(0)} ms single-threaded, ${baseline.frames.length} frames each`);
