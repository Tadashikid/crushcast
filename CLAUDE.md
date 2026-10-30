# CrushCast — Handover for Claude Code

> Team **Git Ghosts** (Team ID **AH-23**) · AfterHours 1.0, DBIT Bengaluru · 24-hour build, 9:30 AM 30 Oct → 9:30 AM 31 Oct 2026
> Members: Samarth Anil, Sumedh Mulay, Pramegha M, Sai Siddarth B
> Theme 03: Simulation, Digital Twins & Synthetic Data

Put this file in the repo root (optionally copy it to `CLAUDE.md` so Claude Code loads it automatically). Read it fully before writing code.

---

## 0. Hackathon rules that constrain the code

- All code must be written **during** the 24-hour window. No pre-written project code.
- Allowed: APIs, open-source libraries, open-source templates. Credit every library in the README.
- GitHub repo is compulsory, must have a **README**, and there are **mandatory commit checkpoints** → commit at least every hour with clear messages.
- Finalists must show a **demo or video** → keep the app demo-stable at all times; record a backup video.
- Venue: LAN cable per desk; Wi-Fi not guaranteed. The core demo must work **offline on one laptop**; phones are a bonus layer.

---

## 1. What CrushCast is (one paragraph)

A browser-based control room that simulates a crowd around a venue, **forecasts crush risk 10 minutes ahead**, **tests candidate fixes in fast-forward** (open a gate, hold the metro exit, reroute a road…), shows **"do nothing" vs "best plan" futures side by side**, and on **Apply** changes the live crowd and **sends each joined phone a personal route** ("Use Gate 9, 2 min walk"). Judges join the crowd from their phones via QR, trigger crises, and watch the system steer them to safety.

Motivation (for README/pitch): 4 June 2025, Chinnaswamy Stadium, Bengaluru — 11 dead, 33 injured; venue built for 35,000, an estimated 2–3 lakh people came; small gates; conflicting announcements (Tribune India / PTI, 5 June 2025). Treat this respectfully; any "replay" is an **illustrative reconstruction from public reports**, never a claim about what happened.

**Pitch line:** "It plays the next 10 minutes of the crowd in fast-forward, tries every fix, and tells police which one keeps people safe."

---

## 2. Scope

| Tier | Features |
|---|---|
| **Must** | Live crowd sim + density heat map · 10-min forecast with time-to-danger per zone · autopilot over ~15 candidate plans · side-by-side futures player · Apply · phone join (QR) · phone personal routes · "why" panel (arrivals vs capacity) |
| **Should** | Crisis buttons (close gate, fake announcement, rain) · illustrative replay scenario with "warning lead time" · evaluation harness (Tests 1–3) |
| **Stretch** (only after Checkpoint 2) | Draw-any-venue editor · safe-capacity number · webcam people counter (TF.js COCO-SSD) · PA announcement text (Kannada/Hindi/English) |

**Non-goals:** face recognition, real CCTV ingestion, real venue CAD, user accounts, cloud deployment of the simulation.

---

## 3. Tech stack (single language: TypeScript)

- Node.js 20 LTS, npm workspaces monorepo
- Frontend: Vite + React + TypeScript, **PixiJS** (ParticleContainer for thousands of dots), Zustand, Tailwind, Recharts (small charts), `qrcode`
- Workers: native Web Workers + **Comlink**
- Server: `express` + `ws`, `nanoid`
- Public URL for phones: `cloudflared tunnel --url http://localhost:8080` (prints `https://*.trycloudflare.com`)
- Tests/eval: `vitest` for unit tests; eval scripts run the same packages in Node (`tsx`)
- Optional: Python + matplotlib only for README plots

---

## 4. Repo layout

```
crushcast/
  CLAUDE.md / CRUSHCAST_HANDOVER.md
  README.md                 what, why, how to run, assumptions, honest eval results, credits
  package.json              npm workspaces
  packages/
    sim/                    PURE TS, no DOM. Engine, distance maps, gates, arrivals, density, RNG
    autopilot/              PURE TS. Clone, forecast, action library, scoring, plan search
  apps/
    control/                React control room (Vite). Live sim runs in a Worker; futures in a worker pool
    join/                   Tiny phone page (Vite) — join, arrive, crisis buttons, route screen
  server/                   express + ws: rooms, QR, message relay, serves built apps
  venues/stadium.json
  scenarios/*.json
  eval/                     test1_autopilot.ts, test2_forecast.ts, test3_fundamental.ts, outputs/*.csv
```

`packages/sim` and `packages/autopilot` must never import browser APIs so they run in the browser, in workers, and in Node.

---

## 5. Data formats (agree first, then build in parallel)

### Venue (`venues/stadium.json`) — grid coordinates in cells (cell = 0.5 m)
```json
{
  "name": "Stadium X (synthetic)",
  "cellSize": 0.5, "width": 320, "height": 200,
  "walls":   [[[0,0],[320,0]], [[40,60],[280,60]]],
  "gates":   [{"id":"G3","line":[[150,60],[156,60]],"capacityPerMin":90,"open":true},
              {"id":"G9","line":[[250,60],[256,60]],"capacityPerMin":120,"open":false,"reserve":true}],
  "sources": [{"id":"metro","area":[[10,180],[30,195]],"label":"Metro exit"},
              {"id":"road","area":[[300,150],[318,190]],"label":"Main road"}],
  "zones":   [{"id":"gate3-front","area":[[140,62],[166,80]],"label":"Gate 3 approach"}]
}
```
Walls are polylines (rasterise with Bresenham, thickness 1–2 cells). Areas are axis-aligned rectangles `[[x0,y0],[x1,y1]]`.

### Scenario (`scenarios/announcement-surge.json`)
```json
{
  "durationMin": 30,
  "arrivals": {"metro": [[0,300],[10,600]], "road": [[0,200]]},
  "events": [{"atMin": 8, "type": "announcement", "source": "metro", "multiplier": 3, "forMin": 5}],
  "label": "Illustrative scenario"
}
```
`arrivals[source]` = list of `[minute, peoplePerMinute]` step changes.

### WebSocket messages (JSON)
```jsonc
// phone -> server -> control
{"type":"join","phoneId":"p7","emoji":"🦊","source":"metro"}
{"type":"arrive","phoneId":"p7","count":200}
{"type":"crisis","kind":"announcement"|"closeGate"|"rain","target":"metro"|"G3"}
// control -> server -> phone
{"type":"route","phoneId":"p7","gate":"G9","etaSec":120,"arrow":"left","text":"Use Gate 9, 2 min walk"}
{"type":"status","level":"green"|"amber"|"red","message":"..."}
```
Rooms: a single default room is fine for the hackathon (`room=main`).

### Plan (autopilot → UI)
```json
{"actions":[{"type":"openGate","gate":"G9"},{"type":"holdSource","source":"metro","forMin":3}],
 "dangerPersonMin": 0, "baselineDangerPersonMin": 0, "peakDensity": 0, "framesId": "f-42"}
```
(Numbers are placeholders — never hard-code results.)

---

## 6. Simulation spec (`packages/sim`)

**State (typed arrays, capacity MAX_AGENTS = 8000):**
`x, y, vFree: Float32Array` · `target: Int16Array` (gate index) · `alive: Uint8Array` · `phoneId: Int16Array` (−1 if none) · gate states (open, capacityPerMin, token bucket) · source states (rate, hold-until) · sim time · seeded RNG state (use a small deterministic PRNG like mulberry32; **same seed ⇒ same future**).

**Grid:** `width × height` cells; `walkable: Uint8Array`.

**Distance maps:** for each gate, BFS/Dijkstra (8-neighbour, diagonal cost √2) from gate cells over walkable cells → `Float32Array` per gate. Recompute only when venue/walls change.

**Step (dt = 0.5 s simulated):**
1. Spawn arrivals per source: `rate(t) × dt / 60` with fractional accumulator; random positions inside source area; `vFree` ~ uniform(1.1, 1.5) m/s; target = gate with lowest distance from spawn among open gates (+ small random bias) unless a reroute action applies.
2. Density bins 1 m × 1 m (2 × 2 cells): count alive agents per bin → `density` (people/m²).
3. For each agent: direction = negative gradient of its gate's distance map at its cell (compare neighbours; normalise). Speed = `vFree × f(ρ)` where `f` is a decreasing speed–density factor reaching ~0 near jam density (start with a Weidmann-style form; parameters in `config.ts`, **label as assumptions**). Add small push away from denser neighbouring bins + jitter. Move; if the new cell is a wall, try sliding along x or y; else stay.
4. Gates: agents within 1 m of an open gate line queue; each step a gate admits up to `capacityPerMin × dt / 60` (token bucket); admitted agents are removed (`alive = 0`, count as entered). Closed gate admits 0.
5. Apply timed events (announcement multiplier, rain → vFree × 0.8).

**Outputs per step:** density grid (Float32Array), per-zone stats (count, max density), per-gate stats (arrivals/min heading there, admitted/min, queue length), totals (spawned, inside, entered).

**Invariants (unit tests):** no alive agent inside a wall cell · `spawned == inside + entered` · closed gate admits nobody · deterministic with fixed seed.

**Performance budget:** 5,000 agents at ≥ 30 fps rendering, sim at ≥ 2 steps/s real time on the demo laptop; one 10-minute future (1,200 steps) < 1 s in a worker.

**Danger bands (configurable, shown in legend as assumptions):** green / amber / red by bin density. Start with amber > 2 people/m², red > 4 people/m² and tune; cite sources in README before quoting thresholds as facts.

---

## 7. Forecast + autopilot spec (`packages/autopilot`)

- `snapshot(state)` → deep copy (typed array `.slice()`), plus current arrival estimate (EWMA of last 60 s).
- `runFuture(snapshot, actions, minutes=10, seed)` → `{ dangerPersonMin, peakDensity, timeToRedByZone, enteredBy10, frames }` where `frames` = density grids downsampled (e.g. 80 × 50) every 10 simulated seconds (60 frames).
- **Danger person-minutes** = Σ over steps Σ over bins with density > red: `count × dt / 60`.
- **Score** = dangerPersonMin + 0.1 × peopleStillOutsideAt10 + actionCost (closeGate 2, holdSource 3/min, others 1). Lower is better. Keep weights in config.
- **Action library:** `openGate(g)`, `closeGate(g)`, `boostGate(g, +50%)`, `holdSource(s, 3 min)`, `rerouteSource(s, g)`, `capArrivals(total, factor)`.
- **Candidates:** baseline (no action) + all feasible single actions (~8–12) + top-3 pairs from the best singles ≈ 15 futures.
- **Worker pool:** `navigator.hardwareConcurrency - 1` workers (min 2) via Comlink; run every 15 s of wall clock or on demand; target < 10 s for all 15 futures.
- **Output:** top 3 plans + baseline, with frames for the side-by-side player; "danger avoided" = baseline − plan.

---

## 8. UI spec (`apps/control`) — designer leads look & feel

Layout (1920×1080 target, must also work at 1366×768):
- **Main map (left ~65%)**: venue walls, gates (open/closed state), sources, agents as dots (phone agents larger with emoji), density heat overlay, zone labels.
- **Right panel**: status banner ("Dangerous density at Gate 3 in 6 min"), **Why panel** per gate ("140/min arriving · 90/min capacity · queue +50/min" — computed live, not hard-coded), top plan cards with "danger avoided", **Apply** button, crisis buttons, agent count & FPS (hidden behind a debug toggle).
- **Futures view**: two synced mini-maps playing baseline vs selected plan frames with a time scrubber (0–10 min); red/green outcome labels.
- **QR code** for the join URL in a corner.
- Colour: calm neutrals; density uses a sequential green→amber→red scale; one accent colour for the recommended plan. Large readable text for projection.

`apps/join` (phone, mobile-first): emoji + approach picker → big **I'm arriving** button → crisis buttons (if enabled) → **route screen** (huge arrow, gate name, ETA, short text). Reconnect automatically.

---

## 9. Server spec (`server/`)

- `express` serves built `apps/control` at `/` and `apps/join` at `/join`.
- `ws` endpoint `/ws?role=control|phone`; relay phone → control and control → specific phone (`route`) or all (`status`).
- `/api/join-url` returns the public URL (read from env `PUBLIC_URL`, set from the cloudflared output) for the QR code.
- Must survive phones disconnecting/reconnecting; keep last route per phone and resend on reconnect.

---

## 10. Milestones & acceptance criteria

| Checkpoint | Clock | Must be true |
|---|---|---|
| **CP0** | 10:30 AM | Repo + workspaces + data formats committed; venue JSON loads and renders walls/gates |
| **CP1** | 2:30 PM | 1,000–3,000 agents walk to gates; queues form at gates; heat map shows density; a phone tap on `/join` adds people |
| **CP2** | 7:30 PM | Full loop end to end: forecast → 15 futures → side-by-side → Apply changes live sim → phones receive routes; Why panel live |
| **CP3 / freeze** | 1:30 AM | 5,000 agents smooth; crisis buttons; replay scenario + warning lead time; Test 1 runs; README run steps |
| **Final** | 9:00 AM | Tests 1–3 results (measured) + plots in README; backup video recorded; last commit |

Fallback rule: if CP1 slips past 4:00 PM, drop phone routes to an on-screen list and protect the core loop.

---

## 11. Evaluation (`eval/`) — publish only measured numbers

1. **Autopilot effect:** 30 randomised scenarios (fixed seeds). Policies: no action · reactive rule ("open every gate once any zone is red") · CrushCast autopilot. Metrics: danger person-minutes, peak density, entered by minute 30. Output CSV + bar chart.
2. **Forecast accuracy:** noisy "truth" run (different seed) vs forecasts made at minutes 5/10/15. Metrics: time-to-red error (min), density MAE at +5/+10 min. Baseline: persistence.
3. **Model sanity:** straight corridor at rising densities → flow (people/m/s) vs density curve; compare shape with the published fundamental diagram.

---

## 12. Demo script (finals, ~3 min)

1. Calm map + Chinnaswamy hook (facts only).
2. Judges scan QR, tap **I'm arriving** → their emoji dots appear.
3. A judge presses **Fake announcement** → surge.
4. Gate 3 amber; banner with time-to-danger; Why panel shows arrivals vs capacity.
5. Futures side by side: "do nothing" red vs "open Gate 9 + hold metro 3 min" green, danger avoided.
6. **Apply** → judges' phones show "Use Gate 9" → dots turn → heat map cools.
7. Replay: warning lead time (from our run). 8. Eval slide from README. 9. Close.

Pre-demo setup: tunnel running, QR visible, 4 team phones pre-joined, agent count set to the rehearsed value, backup video open on a second laptop.

---

## 13. Working agreement for Claude Code

- Build **vertical slices** that keep the app runnable; never leave `main` broken. Commit after each working slice (hourly minimum).
- Keep all tunable numbers in `packages/sim/src/config.ts` and `packages/autopilot/src/config.ts`; label assumptions in comments and in the UI legend.
- Prefer simple, fast, deterministic code over clever code. Typed arrays in hot loops; no per-agent objects in the sim.
- Never fabricate metrics, citations or results in UI text or README. Placeholders must look like placeholders.
- Write unit tests for the sim invariants (section 6) early.
- When unsure about a requirement, choose the option that protects the live demo.

### Suggested first prompts
1. "Scaffold the npm-workspaces monorepo in section 4 with Vite React apps `control` and `join`, packages `sim` and `autopilot`, and an express+ws `server`. Add scripts `dev`, `build`, `test`."
2. "Implement `packages/sim` per section 6: venue loading/rasterisation, distance maps, step function, gates, arrivals, density bins, seeded RNG, plus vitest invariants."
3. "Render the sim in `apps/control` with PixiJS from a Web Worker: walls, gates, dots, heat overlay at 30 fps."
4. "Implement `packages/autopilot` per section 7 with a Comlink worker pool and expose top-3 plans + frames."
5. "Build the futures side-by-side player, Why panel, Apply flow, and server relay for phone join/arrive/crisis/route per sections 8–9."
6. "Add `eval/` scripts for Tests 1–3 writing CSVs, and update README with run steps and assumptions."
