// Central refresh scheduler, hosted in a dedicated Web Worker.
//
// Worker timers are exempt from Chrome's visibility-based throttling, and
// the design is timestamp-based (absolute fire times compared against
// Date.now() every 250 ms), so even if the interval were clamped the fire
// would only be delayed, never lost.
//
// Protocol (postMessage from offscreen.js):
//   {type: 'arm',       tabId, fireAt}   — (re)set absolute fire time (ms epoch)
//   {type: 'disarm',    tabId}
//   {type: 'disarmAll'}
// Emits: {type: 'fired', tabId}

const timers = new Map(); // tabId -> fireAt (epoch ms)

setInterval(() => {
  const now = Date.now();
  for (const [tabId, fireAt] of timers) {
    if (now >= fireAt) {
      timers.delete(tabId);
      postMessage({ type: 'fired', tabId });
    }
  }
}, 250);

onmessage = (e) => {
  const { type, tabId, fireAt } = e.data || {};
  if (type === 'arm' && Number.isFinite(tabId) && Number.isFinite(fireAt)) {
    timers.set(tabId, fireAt);
  } else if (type === 'disarm') {
    timers.delete(tabId);
  } else if (type === 'disarmAll') {
    timers.clear();
  }
};
