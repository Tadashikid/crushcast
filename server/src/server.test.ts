import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { cleanPhoneMsg, startServer } from './server';

let srv: Awaited<ReturnType<typeof startServer>>;
let base = '';
beforeAll(async () => {
  srv = await startServer({ port: 0, publicUrl: 'https://demo.example' });
  base = `ws://127.0.0.1:${srv.port}/ws`;
});
afterAll(() => srv.close());

/** Connects and queues every message; next(type) resolves with the next message of that type. */
function client(query: string, headers?: Record<string, string>) {
  const ws = new WebSocket(`${base}?${query}`, { headers });
  const inbox: Record<string, unknown>[] = [];
  const waiters: [string, (m: Record<string, unknown>) => void][] = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    const w = waiters.findIndex(([t]) => t === m.type);
    if (w >= 0) waiters.splice(w, 1)[0][1](m); else inbox.push(m);
  });
  const next = (type: string) => new Promise<Record<string, unknown>>((resolve) => {
    const i = inbox.findIndex((m) => m.type === type);
    if (i >= 0) resolve(inbox.splice(i, 1)[0]); else waiters.push([type, resolve]);
  });
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  return { ws, next, closed, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

describe('server relay', () => {
  it('phone → control: server-assigned id overrides a spoofed one', async () => {
    const control = client('role=control');
    await control.next('phones');
    const phone = client('role=phone');
    const { phoneId } = await phone.next('hello');
    phone.send({ type: 'join', phoneId: 'p999', emoji: '🦊', source: 'metro' });
    expect(await control.next('join')).toEqual({ type: 'join', phoneId, emoji: '🦊', source: 'metro' });
    phone.send({ type: 'arrive', count: 100000 });
    expect(await control.next('arrive')).toEqual({ type: 'arrive', phoneId, count: 300 });
    control.ws.close(); phone.ws.close();
  });

  it('control → phone route is delivered and resent on reconnect with the key', async () => {
    const control = client('role=control');
    await control.next('phones');
    const p1 = client('role=phone');
    const { phoneId, key } = await p1.next('hello');
    const route = { type: 'route', phoneId, gate: 'G9', etaSec: 120, arrow: 'left', text: 'Use Gate 9, ~2 min' };
    control.send(route);
    expect(await p1.next('route')).toEqual(route);
    p1.ws.close();
    await p1.closed;

    const back = client(`role=phone&phoneId=${phoneId}&key=${key}`);
    expect((await back.next('hello')).phoneId).toBe(phoneId);
    expect(await back.next('route')).toEqual(route);

    const thief = client(`role=phone&phoneId=${phoneId}&key=wrong`);
    expect((await thief.next('hello')).phoneId).not.toBe(phoneId);
    control.ws.close(); back.ws.close(); thief.ws.close();
  });

  it('status is broadcast to phones', async () => {
    const control = client('role=control');
    await control.next('phones');
    const phone = client('role=phone');
    await phone.next('hello');
    control.send({ type: 'status', level: 'red', message: 'Dangerous density at Gate 3 in 6 min' });
    expect((await phone.next('status')).level).toBe('red');
    control.ws.close(); phone.ws.close();
  });

  it('refuses control through the tunnel', async () => {
    const c = client('role=control', { 'cf-connecting-ip': '203.0.113.9' });
    expect(await c.closed).toBe(1008);
  });

  it('serves the public join url', async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/join-url`);
    expect(await res.json()).toEqual({ url: 'https://demo.example/join' });
  });
});

describe('cleanPhoneMsg', () => {
  it('rejects junk and rebuilds valid messages', () => {
    expect(cleanPhoneMsg(null, 'p1')).toBeNull();
    expect(cleanPhoneMsg({ type: 'route', phoneId: 'p2' }, 'p1')).toBeNull(); // phones can't send routes
    expect(cleanPhoneMsg({ type: 'join', source: '<script>' }, 'p1')).toBeNull();
    expect(cleanPhoneMsg({ type: 'join', source: 'metro', emoji: 'hello world' }, 'p1')).toEqual({ type: 'join', phoneId: 'p1', emoji: '🙂', source: 'metro' });
    expect(cleanPhoneMsg({ type: 'arrive', count: -5 }, 'p1')).toBeNull();
    expect(cleanPhoneMsg({ type: 'crisis', kind: 'nuke' }, 'p1')).toBeNull();
    expect(cleanPhoneMsg({ type: 'crisis', kind: 'closeGate', target: 'G3', extra: 1 }, 'p1')).toEqual({ type: 'crisis', phoneId: 'p1', kind: 'closeGate', target: 'G3' });
  });
});
