// Canvas drawing for the live map and the futures mini-maps. Colours live here (canvas can't read CSS vars cheaply).
import { SIM, type Venue } from '@crushcast/sim';

export const COLORS = {
  bg: '#f4f3ef',
  wall: '#3b3b3b',
  gateOpen: '#1f9d55',
  gateClosed: '#c0392b',
  source: 'rgba(70,110,200,0.15)',
  zone: 'rgba(0,0,0,0.35)',
  dot: '#24324a',
  text: '#333',
  band: { green: [46, 160, 67], amber: [235, 160, 20], red: [215, 40, 40] } as Record<string, number[]>,
};

const scratch = document.createElement('canvas');

/** Density grid (values × k = people/m²) as a smoothed green/amber/red overlay covering the whole canvas. */
export function drawHeat(ctx: CanvasRenderingContext2D, values: ArrayLike<number>, w: number, h: number, k = 1) {
  scratch.width = w;
  scratch.height = h;
  const img = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const rho = values[i] * k;
    if (rho < 0.3) continue;
    const band = rho > SIM.RED ? 'red' : rho > SIM.AMBER ? 'amber' : 'green';
    const [r, g, b] = COLORS.band[band];
    img.data.set([r, g, b, band === 'red' ? 210 : band === 'amber' ? 170 : 90], i * 4);
  }
  scratch.getContext('2d')!.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(scratch, 0, 0, ctx.canvas.width, ctx.canvas.height);
}

/** Walls, gates (open/closed), sources and zones. `s` = pixels per cell. */
export function drawVenue(ctx: CanvasRenderingContext2D, v: Venue, gateOpen: number[], s: number, labels = true) {
  const p = (c: number) => (c + 0.5) * s;
  ctx.font = `${Math.max(10, s * 4)}px system-ui, sans-serif`;
  ctx.lineCap = 'round';

  for (const src of v.sources) {
    const [[x0, y0], [x1, y1]] = src.area;
    ctx.fillStyle = COLORS.source;
    ctx.fillRect(x0 * s, y0 * s, (x1 - x0 + 1) * s, (y1 - y0 + 1) * s);
    if (labels) { ctx.fillStyle = COLORS.text; ctx.fillText(src.label, x0 * s, y0 * s - 4); }
  }
  if (labels) {
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = COLORS.zone;
    ctx.lineWidth = 1;
    for (const z of v.zones) {
      const [[x0, y0], [x1, y1]] = z.area;
      ctx.strokeRect(x0 * s, y0 * s, (x1 - x0 + 1) * s, (y1 - y0 + 1) * s);
    }
    ctx.setLineDash([]);
  }

  ctx.strokeStyle = COLORS.wall;
  ctx.lineWidth = Math.max(2, s);
  for (const poly of v.walls) {
    ctx.beginPath();
    poly.forEach(([x, y], i) => (i ? ctx.lineTo(p(x), p(y)) : ctx.moveTo(p(x), p(y))));
    ctx.stroke();
  }

  v.gates.forEach((g, i) => {
    const [[x0, y0], [x1, y1]] = g.line;
    ctx.strokeStyle = gateOpen[i] ? COLORS.gateOpen : COLORS.gateClosed;
    ctx.lineWidth = Math.max(3, s * 2);
    ctx.beginPath();
    ctx.moveTo(p(x0), p(y0));
    ctx.lineTo(p(x1), p(y1));
    ctx.stroke();
    if (labels) { ctx.fillStyle = ctx.strokeStyle; ctx.fillText(`${g.id}${gateOpen[i] ? '' : ' (closed)'}`, x0 * s, y0 * s - 8); }
  });
}
