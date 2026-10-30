// Relay between phones and the control room (CLAUDE.md §9). One room. The sim lives in the control browser;
// the server only validates phone input, forwards it, and remembers the last route/status for reconnects.
//
// Security: the tunnel makes this public. Control (the `role=control` socket and the page at /) is loopback-only and
// refused for anything that came through a proxy (cloudflared adds cf-connecting-ip). Phones get a server-issued
// id + secret key, so nobody can claim another phone's id, and every phone message is rebuilt from validated fields.

import express from 'express';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MAX_ARRIVE = 300; // people per "I'm arriving" tap
const BURST = 5, REFILL_MS = 500; // phone rate limit: 5 messages burst, then 2/s
const ID = /^[\w-]{1,32}$/;
const EMOJI = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]{1,16}$/u;
const CRISES = ['announcement', 'closeGate', 'rain'];

interface Phone { key: string; ws?: WebSocket; emoji?: string; source?: string; lastRoute?: unknown }

export function isLocal(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? '';
  return !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'] && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(a);
}

export function lanUrl(port: number): string {
  for (const list of Object.values(networkInterfaces()))
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) return `http://${i.address}:${port}`;
  return `http://localhost:${port}`;
}

/** Rebuilds a phone message from validated fields; the phoneId always comes from the socket, never the payload. */
export function cleanPhoneMsg(m: unknown, phoneId: string): Record<string, unknown> | null {
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  if (o.type === 'join') {
    if (typeof o.source !== 'string' || !ID.test(o.source)) return null;
    const emoji = typeof o.emoji === 'string' && EMOJI.test(o.emoji) ? o.emoji : '🙂';
    return { type: 'join', phoneId, emoji, source: o.source };
  }
  if (o.type === 'arrive') {
    const count = Math.round(Number(o.count));
    if (!(count >= 1)) return null;
    return { type: 'arrive', phoneId, count: Math.min(count, MAX_ARRIVE) };
  }
  if (o.type === 'crisis') {
    if (typeof o.kind !== 'string' || !CRISES.includes(o.kind)) return null;
    if (o.target !== undefined && (typeof o.target !== 'string' || !ID.test(o.target))) return null;
    return { type: 'crisis', phoneId, kind: o.kind, ...(o.target ? { target: o.target } : {}) };
  }
  return null;
}

const parse = (raw: RawData): unknown => {
  try { return JSON.parse(raw.toString()); } catch { return null; }
};
const send = (ws: WebSocket | undefined, m: unknown) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
};

export function startServer({ port = 8080, publicUrl = process.env.PUBLIC_URL } = {}): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const phones = new Map<string, Phone>();
  let control: WebSocket | undefined; // ponytail: one control room, newest connection wins
  let lastStatus: unknown;
  let nextId = 1;

  const app = express();
  app.get('/api/join-url', (_req, res) => { res.json({ url: `${publicUrl ?? lanUrl(port)}/join` }); });
  const dist = `${ROOT}apps/web/dist`; // one Vite build: control at /, phone page at /join, shared /assets
  app.use('/join', express.static(`${dist}/join`));
  app.use('/assets', express.static(`${dist}/assets`));
  app.use((req, res, next) => (isLocal(req) ? next() : res.redirect('/join/')));
  app.use(express.static(dist));

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

  wss.on('connection', (ws, req) => {
    const q = new URL(req.url ?? '', 'http://x').searchParams;

    if (q.get('role') === 'control') {
      if (!isLocal(req)) return ws.close(1008, 'control is local-only');
      control?.close();
      control = ws;
      send(ws, { type: 'phones', phones: [...phones].map(([phoneId, p]) => ({ phoneId, emoji: p.emoji, source: p.source, online: !!p.ws })) });
      ws.on('message', (raw) => {
        const m = parse(raw) as Record<string, unknown> | null;
        if (m?.type === 'route' && typeof m.phoneId === 'string') {
          const p = phones.get(m.phoneId);
          if (p) { p.lastRoute = m; send(p.ws, m); }
        } else if (m?.type === 'status') {
          lastStatus = m;
          for (const p of phones.values()) send(p.ws, m);
        }
      });
      ws.on('close', () => { if (control === ws) control = undefined; });
      return;
    }

    // phone: resume with id+key, else issue a fresh identity
    let phoneId = q.get('phoneId') ?? '';
    let p = phones.get(phoneId);
    if (!p || p.key !== q.get('key')) {
      phoneId = `p${nextId++}`;
      p = { key: randomUUID() };
      phones.set(phoneId, p);
    }
    const phone = p;
    phone.ws?.close();
    phone.ws = ws;
    send(ws, { type: 'hello', phoneId, key: phone.key });
    if (phone.lastRoute) send(ws, phone.lastRoute);
    if (lastStatus) send(ws, lastStatus);

    let tokens = BURST, last = Date.now();
    ws.on('message', (raw) => {
      const now = Date.now();
      tokens = Math.min(BURST, tokens + (now - last) / REFILL_MS);
      last = now;
      if (tokens < 1) return;
      tokens--;
      const m = cleanPhoneMsg(parse(raw), phoneId);
      if (!m) return;
      if (m.type === 'join') { phone.emoji = m.emoji as string; phone.source = m.source as string; }
      send(control, m);
    });
    ws.on('close', () => { if (phone.ws === ws) phone.ws = undefined; });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    wss.on('error', () => {}); // listen errors surface via `server`; don't crash twice
    server.listen(port, () => {
      const addr = server.address();
      resolve({
        server,
        port: typeof addr === 'object' && addr ? addr.port : port,
        close: () => new Promise<void>((r) => { wss.clients.forEach((c) => c.terminate()); wss.close(); server.close(() => r()); }),
      });
    });
  });
}
