// Autopilot tunables (CLAUDE.md §7). Weights are design choices, not measured values.

export const AP = {
  HORIZON_MIN: 10,
  FRAME_EVERY_S: 10, // 10-min horizon → 60 frames
  FRAME_W: 80,
  FRAME_H: 50,
  FRAME_SCALE: 20, // frames are Uint8: value = round(people/m² × FRAME_SCALE), so 255 ≈ 12.75/m²

  // score = dangerPersonMin + W_OUTSIDE × peopleStillOutside + action cost. Lower is better.
  W_OUTSIDE: 0.1,
  COST_CLOSE_GATE: 2,
  COST_HOLD_PER_MIN: 3,
  COST_OTHER: 1,

  BOOST: 1.5, // boostGate: +50% capacity (extra lanes / staff), assumption
  HOLD_MIN: 3, // holdSource duration
  CAP_FACTOR: 0.5, // capArrivals: upstream metering to half the arrival rate
  TOP_PAIRS_FROM: 3, // pairs are formed from the best N singles
};
