// One forecast future per message. The engine runs several of these in parallel.
import { runFuture, AP, type Action } from '@crushcast/autopilot';
import type { SimState } from '@crushcast/sim';

self.onmessage = (e: MessageEvent<{ snap: SimState; actions: Action[] }>) => {
  postMessage(runFuture(e.data.snap, e.data.actions, AP.HORIZON_MIN, 1));
};
