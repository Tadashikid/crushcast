// Venue + scenario data formats (CLAUDE.md §5) and grid rasterisation.
// Pure TS: no DOM, no Node APIs — runs in browser, workers and Node.

export type Point = [number, number];
export type Rect = [Point, Point]; // [[x0,y0],[x1,y1]] inclusive, axis-aligned

export interface Gate {
  id: string;
  line: [Point, Point];
  capacityPerMin: number;
  open: boolean;
  reserve?: boolean;
}

export interface Area {
  id: string;
  area: Rect;
  label: string;
}

export interface Venue {
  name: string;
  cellSize: number; // metres per cell
  width: number; // cells
  height: number; // cells
  walls: Point[][]; // polylines
  gates: Gate[]; // gate lines are carved out of walls
  sources: Area[];
  zones: Area[];
}

export interface ScenarioEvent {
  atMin: number;
  type: 'announcement' | 'closeGate' | 'rain';
  source?: string;
  gate?: string;
  multiplier?: number;
  forMin?: number;
}

export interface Scenario {
  durationMin: number;
  arrivals: Record<string, [number, number][]>; // source -> [minute, peoplePerMinute] steps
  events: ScenarioEvent[];
  label: string;
}

export interface Grid {
  width: number;
  height: number;
  walkable: Uint8Array; // 1 = walkable, index = y * width + x
  gateCells: Int32Array[]; // per gate (same order as venue.gates), cell indices
}

// 4-connected Bresenham: never steps diagonally, so 8-neighbour agents can't leak through diagonal walls.
export function line4(x0: number, y0: number, x1: number, y1: number, cb: (x: number, y: number) => void) {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy, x = x0, y = y0;
  for (;;) {
    cb(x, y);
    if (x === x1 && y === y1) return;
    const e2 = 2 * err;
    if (e2 - dy > dx - e2) { err += dy; x += sx; } else { err += dx; y += sy; }
  }
}

export function rasterise(v: Venue): Grid {
  const { width, height } = v;
  const inBounds = ([x, y]: Point, what: string) => {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height)
      throw new Error(`${what}: point [${x},${y}] outside ${width}x${height} grid`);
  };

  const walkable = new Uint8Array(width * height).fill(1);
  for (const poly of v.walls) {
    poly.forEach((p) => inBounds(p, 'wall'));
    for (let i = 1; i < poly.length; i++) {
      const [a, b] = [poly[i - 1], poly[i]];
      line4(a[0], a[1], b[0], b[1], (x, y) => { walkable[y * width + x] = 0; });
    }
  }

  const gateCells = v.gates.map((g) => {
    g.line.forEach((p) => inBounds(p, `gate ${g.id}`));
    const cells: number[] = [];
    line4(g.line[0][0], g.line[0][1], g.line[1][0], g.line[1][1], (x, y) => {
      const i = y * width + x;
      walkable[i] = 1;
      cells.push(i);
    });
    return Int32Array.from(cells);
  });

  for (const a of [...v.sources, ...v.zones]) a.area.forEach((p) => inBounds(p, `area ${a.id}`));

  return { width, height, walkable, gateCells };
}
