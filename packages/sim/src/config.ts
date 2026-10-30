// All tunable sim numbers. ASSUMPTIONS unless a source is cited — show these in the UI legend.

export const SIM = {
  MAX_AGENTS: 8000,
  DT: 0.5, // simulated seconds per step

  V_FREE_MIN: 1.1, // m/s, assumption
  V_FREE_MAX: 1.5, // m/s, assumption

  // Weidmann-style speed–density: f(ρ) = 1 − exp(−γ (1/ρ − 1/ρjam)).
  // γ = 1.913 m⁻², ρjam = 5.4 m⁻² are the commonly quoted Weidmann (1993) values; treat as assumptions until cited.
  WEIDMANN_GAMMA: 1.913,
  RHO_JAM: 5.4,
  MIN_SPEED_FACTOR: 0.05, // assumption: keeps a jammed crowd creeping instead of deadlocking

  BIN_CELLS: 2, // density bin = 2×2 cells = 1 m² at 0.5 m cells
  BIN_CAP: 7, // max people per 1 m² bin (hard packing limit), assumption
  // Density used for speed + danger is smoothed over 3×3 bins (≈9 m²) — a 1 m² bin with one person reads 1/m².

  // Steering: look STEER_PROBE_M ahead along the gradient and ±30°/±60°, take the least crowded heading.
  // Each radian off the shortest path costs STEER_ANGLE_COST people/m². Stops everyone collapsing onto one lane.
  STEER_PROBE_M: 2,
  STEER_ANGLE_COST: 1.5,
  JITTER: 0.15, // random direction noise
  TARGET_BIAS_M: 5, // random extra metres when picking the nearest gate, spreads crowds across gates

  ADMIT_RADIUS_M: 1, // agents within this distance of an open gate can be admitted
  QUEUE_STAT_RADIUS_M: 10, // agents within this distance count towards the gate's queue stat

  RAIN_SPEED: 0.8, // vFree multiplier while raining, assumption

  AMBER: 2, // people/m², assumption — cite before quoting as fact
  RED: 4, // people/m², assumption — cite before quoting as fact
};

export type Band = 'green' | 'amber' | 'red';
export const band = (rho: number): Band => (rho > SIM.RED ? 'red' : rho > SIM.AMBER ? 'amber' : 'green');
