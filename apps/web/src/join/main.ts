// Phone page: pick emoji + approach → "I'm arriving" → route screen. No framework; reconnects on its own.
import venue from '../../../../venues/stadium.json';
import '../style.css';

const EMOJIS = ['🦊', '🐯', '🐼', '🦁', '🐸', '🐙', '🦄', '🐝'];
const ARROWS: Record<string, string> = { up: '⬆️', down: '⬇️', left: '⬅️', right: '➡️' };

interface Saved { phoneId?: string; key?: string; emoji: string; source: string; joined: boolean; arrived: boolean }
const load = (): Saved => {
  try { return { emoji: EMOJIS[0], source: venue.sources[0].id, joined: false, arrived: false, ...JSON.parse(localStorage.getItem('crushcast') ?? '{}') }; }
  catch { return { emoji: EMOJIS[0], source: venue.sources[0].id, joined: false, arrived: false }; }
};
const s = load();
const save = () => { try { localStorage.setItem('crushcast', JSON.stringify(s)); } catch { /* private mode: state lives for this tab only */ } };

let route: { gate: string; etaSec: number; arrow: string; text: string } | undefined;
let status: { level: string; message: string } | undefined;
let online = false;
let ws: WebSocket | undefined;
let retry = 1000;

const app = document.getElementById('app')!;
app.className = 'phone';

function connect() {
  const q = new URLSearchParams({ role: 'phone', ...(s.phoneId && s.key ? { phoneId: s.phoneId, key: s.key } : {}) });
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?${q}`);
  ws.onopen = () => { online = true; retry = 1000; render(); };
  ws.onclose = () => { online = false; render(); setTimeout(connect, retry); retry = Math.min(retry * 2, 8000); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'hello') {
      if (m.phoneId !== s.phoneId) route = undefined; // new identity (server restarted): old route is meaningless
      s.phoneId = m.phoneId; s.key = m.key; save();
      if (s.joined) send({ type: 'join', emoji: s.emoji, source: s.source });
    } else if (m.type === 'route') route = m;
    else if (m.type === 'status') status = m;
    render();
  };
}
const send = (m: unknown) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

function render() {
  app.replaceChildren();
  if (!online) app.append(el('p', { className: 'muted' }, 'Connecting…'));

  if (!s.joined) {
    app.append(
      el('h1', {}, 'Join the crowd'),
      el('p', {}, 'Pick your emoji'),
      el('div', { className: 'grid' }, ...EMOJIS.map((e) => el('button', { className: e === s.emoji ? 'on' : '', onclick: () => { s.emoji = e; render(); } }, e))),
      el('p', {}, 'Where are you coming from?'),
      el('div', { className: 'grid' }, ...venue.sources.map((src) =>
        el('button', { className: src.id === s.source ? 'on' : '', onclick: () => { s.source = src.id; render(); } }, src.label))),
      el('button', { className: 'big', onclick: () => { s.joined = true; save(); send({ type: 'join', emoji: s.emoji, source: s.source }); render(); } }, 'Join'),
    );
    return;
  }

  if (status) app.append(el('div', { className: `status ${status.level}` }, status.message));

  if (!s.arrived) {
    app.append(
      el('h1', {}, `${s.emoji} at ${venue.sources.find((x) => x.id === s.source)?.label ?? s.source}`),
      el('button', { className: 'big', onclick: () => { s.arrived = true; save(); send({ type: 'arrive', count: 200 }); render(); } }, "I'm arriving"),
      el('p', { className: 'muted' }, 'You arrive with a group of 200 people.'),
    );
  } else if (!route) {
    app.append(el('h1', {}, s.emoji), el('p', {}, 'Waiting for directions…'));
  } else if (!route.gate) {
    app.append(el('div', { className: 'arrow' }, '✅'), el('p', { className: 'gate' }, route.text));
  } else {
    app.append(
      el('div', { className: 'arrow' }, ARROWS[route.arrow] ?? '⬆️'),
      el('div', { className: 'gate' }, route.gate.replace(/^G/, 'Gate ')),
      el('p', {}, route.text),
      el('p', { className: 'muted' }, 'Arrow is relative to the venue map (up = towards the stadium).'),
    );
  }

  if (s.arrived) {
    const myGate = route?.gate || venue.gates.find((g) => g.open)?.id;
    app.append(el('div', { className: 'crises' },
      el('h3', {}, 'Cause trouble'),
      el('button', { onclick: () => send({ type: 'crisis', kind: 'announcement', target: s.source }) }, '📢 Fake announcement'),
      el('button', { onclick: () => send({ type: 'crisis', kind: 'closeGate', target: myGate }) }, `🚫 Close ${myGate ?? 'a gate'}`),
      el('button', { onclick: () => send({ type: 'crisis', kind: 'rain' }) }, '🌧 Rain'),
    ));
  }
}

render();
connect();
