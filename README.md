# CrushCast

Team Git Ghosts (AH-23) · AfterHours 1.0, DBIT Bengaluru.

A browser control room that simulates a crowd around a venue, forecasts crush risk 10 minutes ahead, tests candidate fixes in fast-forward, and sends joined phones a personal route.

## Run

```bash
npm install
npm start                      # build + serve: control at http://localhost:8080, phones at /join
npm test
npm run sim                    # headless 30-min run, per-minute gate/zone table
npm run autopilot -- 10 --all  # at live minute 10: forecast + every candidate plan, ranked
npm run server                 # :8080 — control at http://localhost:8080 (laptop only), phones at /join
```

Phones over the internet: `cloudflared tunnel --url http://localhost:8080`, then restart the server with `PUBLIC_URL=<the https url>`. The control room refuses tunnelled connections.

## Layout

- `packages/sim`: pure TS crowd simulation (venue format, grid, engine, phone routes)
- `packages/autopilot`: pure TS forecast + plan search (snapshot, futures, actions, scoring)
- `apps/web`: minimal control room (React + canvas, sim in a Web Worker, futures in a worker pool) and phone page (no framework)
- `server`: express + ws relay (phone join/arrive/crisis → control, routes/status → phones, reconnect resend)
- `venues/`, `scenarios/`: JSON data (synthetic venue; scenarios are illustrative)

## Credits

TypeScript, tsx, Vitest, Express, ws, Vite, React, qrcode.
