// Shared message-type and storage-key constants.
//
// Imported (ES module) by: background/service_worker.js, popup/popup.js,
// offscreen/offscreen.js.
//
// NOTE: content/content.js is a classic (non-module) content script and
// cannot import this file — it uses the same string literals directly.
// This file is the single source of truth: if you change a value here,
// update content/content.js to match.

export const MSG = {
  // popup -> service worker
  START_JOB: 'START_JOB',
  STOP_JOB: 'STOP_JOB',
  PLAY_SOUND: 'PLAY_SOUND', // test button (no loop)
  STOP_SOUND: 'STOP_SOUND',

  // service worker -> offscreen (all carry target: 'offscreen')
  OS_ARM: 'OS_ARM', // one-shot: {tabId, fireAt (epoch ms)} — idempotent re-arm
  OS_DISARM: 'OS_DISARM', // {tabId}
  OS_DISARM_ALL: 'OS_DISARM_ALL',
  OS_PLAY: 'OS_PLAY', // {source, volume, loop, ownerTabId}
  OS_STOP: 'OS_STOP',

  // offscreen -> service worker
  OS_FIRED: 'OS_FIRED', // {tabId}
  OS_AUDIO_STATE: 'OS_AUDIO_STATE', // {playing, soundId, ownerTabId}

  // service worker <-> content script
  CS_READY: 'CS_READY', // content -> SW on every injection: {href}
  CS_SCAN: 'CS_SCAN', // SW -> content: scan live DOM
  CS_FETCH_CHECK: 'CS_FETCH_CHECK', // SW -> content: background fetch + scan
  CS_CLEAR_HIGHLIGHTS: 'CS_CLEAR_HIGHLIGHTS',
  CS_TIMER_UPDATE: 'CS_TIMER_UPDATE', // SW -> content: floating overlay state
};

export const STORAGE = {
  DEFAULTS: 'defaults', // storage.local — settings template for new tabs
  CUSTOM_SOUND: 'customSound', // storage.local — {name, mime, dataUrl}
  OVERLAY_POS_PREFIX: 'overlayPos:', // storage.local — per-origin {left, top}
  JOB_PREFIX: 'job:', // storage.session — per-tab job state
  AUDIO_STATE: 'audioState', // storage.session — {playing, soundId, ownerTabId}
};

export const NOTIFICATION_PREFIX = 'arp-found:'; // + tabId
export const WATCHDOG_ALARM = 'arp-watchdog';

export const BUILTIN_SOUNDS = ['beep', 'chime', 'alarm', 'ding'];

export const DEFAULT_SETTINGS = {
  mode: 'reload', // 'reload' (A) | 'monitor' (B)
  interval: { type: 'preset', seconds: 30, minSeconds: 20, maxSeconds: 60 },
  detection: { type: 'keywords', keywords: [], caseSensitive: false },
  onFound: {
    stopRefresh: true,
    sound: true,
    notification: true,
    highlight: true,
    focusTab: false,
    autoClick: false,
    clickTarget: '',
  },
  sound: { id: 'beep', volume: 80 },
  overlay: { enabled: false },
};

export function jobKey(tabId) {
  return STORAGE.JOB_PREFIX + tabId;
}
