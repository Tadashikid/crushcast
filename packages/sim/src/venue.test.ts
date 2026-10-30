import { describe, expect, it } from 'vitest';
import { line4, rasterise, type Venue } from './venue';
import stadium from '../../../venues/stadium.json';

const venue = stadium as unknown as Venue;

describe('venue', () => {
  it('line4 is 4-connected (no diagonal gaps)', () => {
    const pts: [number, number][] = [];
    line4(0, 0, 7, 3, (x, y) => pts.push([x, y]));
    expect(pts.at(-1)).toEqual([7, 3]);
    for (let i = 1; i < pts.length; i++)
      expect(Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1])).toBe(1);
  });

  it('stadium rasterises: facade blocked, gates and sources walkable', () => {
    const g = rasterise(venue);
    const at = (x: number, y: number) => g.walkable[y * g.width + x];
    expect(at(100, 60)).toBe(0);
    expect(g.gateCells).toHaveLength(venue.gates.length);
    for (const cells of g.gateCells) {
      expect(cells.length).toBeGreaterThan(0);
      for (const i of cells) expect(g.walkable[i]).toBe(1);
    }
    for (const s of venue.sources) {
      const [[x0, y0], [x1, y1]] = s.area;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) expect(at(x, y)).toBe(1);
    }
  });

  it('rejects out-of-bounds geometry', () => {
    expect(() => rasterise({ ...venue, walls: [[[0, 0], [999, 0]]] })).toThrow(/outside/);
  });
});
