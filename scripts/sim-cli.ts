// Headless run: prints a per-minute table so the sim can be checked without any UI.
// npm run sim -- [scenarioFile] [minutes] [seed]
import { readFileSync } from 'node:fs';
import { createSim, step, zoneStats, band, SIM, type Scenario, type Venue } from '@crushcast/sim';

const [scenarioFile = 'scenarios/announcement-surge.json', minutes = '30', seed = '1'] = process.argv.slice(2);
const venue: Venue = JSON.parse(readFileSync('venues/stadium.json', 'utf8'));
const scenario: Scenario = JSON.parse(readFileSync(scenarioFile, 'utf8'));

const st = createSim(venue, scenario, +seed);
const gates = venue.gates.map((g) => g.id);
console.log(`min  agents entered  ${gates.map((g) => `${g} q/arr/adm`.padEnd(17)).join('')}worst zone`);

const t0 = performance.now();
const stepsPerMin = 60 / SIM.DT;
for (let m = 1; m <= +minutes; m++) {
  for (let k = 0; k < stepsPerMin; k++) step(st);
  const worst = zoneStats(st).reduce((a, b) => (b.maxDensity > a.maxDensity ? b : a));
  const gateCols = gates.map((_, g) =>
    `${st.gateOpen[g] ? '' : 'x'}${st.gateQueue[g]}/${st.gateArrivalRate[g].toFixed(0)}/${st.gateAdmitRate[g].toFixed(0)}`.padEnd(17));
  console.log(`${String(m).padStart(3)}  ${String(st.n).padStart(6)}  ${String(st.entered).padStart(7)}  ${gateCols.join('')}` +
    `${worst.id} ${worst.maxDensity.toFixed(1)}/m² ${band(worst.maxDensity)}`);
}
const ms = performance.now() - t0;
console.log(`\n${minutes} sim-min in ${ms.toFixed(0)} ms (${((ms / +minutes) * 10).toFixed(0)} ms per 10-min future at this load)`);
console.log('q = queue within 10 m · arr/adm = people/min heading / admitted · x = closed');
