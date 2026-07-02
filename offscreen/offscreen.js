// Offscreen document: hosts the timer Worker and plays alert sounds.
//
// MV3 service workers cannot play audio, and page/content-script timers get
// throttled in background tabs — this document (created with reasons
// AUDIO_PLAYBACK + BLOBS) covers both. It is deliberately dumb: the service
// worker owns all policy; this side only relays timer fires and plays audio.

import { MSG, STORAGE } from '../common/messages.js';

const worker = new Worker('timer_worker.js');

worker.onmessage = (e) => {
  if (e.data?.type === 'fired') {
    // This message also wakes the service worker if it has gone to sleep.
    chrome.runtime.sendMessage({ type: MSG.OS_FIRED, tabId: e.data.tabId }).catch(() => {});
  }
};

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

const audio = new Audio();
let currentSoundId = null;
let currentOwnerTabId = null;
let currentObjectUrl = null;

function reportAudioState() {
  chrome.runtime
    .sendMessage({
      type: MSG.OS_AUDIO_STATE,
      playing: !audio.paused && !audio.ended,
      soundId: currentSoundId,
      ownerTabId: currentOwnerTabId,
    })
    .catch(() => {});
}

audio.addEventListener('play', reportAudioState);
audio.addEventListener('pause', reportAudioState);
audio.addEventListener('ended', reportAudioState);

function releaseObjectUrl() {
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
}

async function resolveSource(source) {
  if (source.kind === 'builtin') {
    return chrome.runtime.getURL(`assets/sounds/${source.id}.wav`);
  }
  // Custom uploaded sound: stored as a data URL in storage.local. Convert to
  // a blob URL so large files don't sit in the media element as base64.
  const { [STORAGE.CUSTOM_SOUND]: custom } = await chrome.storage.local.get(STORAGE.CUSTOM_SOUND);
  if (!custom?.dataUrl) throw new Error('no custom sound uploaded');
  const blob = await (await fetch(custom.dataUrl)).blob();
  releaseObjectUrl();
  currentObjectUrl = URL.createObjectURL(blob);
  return currentObjectUrl;
}

async function play({ source, volume, loop, ownerTabId }) {
  try {
    const src = await resolveSource(source);
    currentSoundId = source.kind === 'builtin' ? source.id : 'custom';
    currentOwnerTabId = ownerTabId ?? null;
    audio.src = src;
    audio.loop = Boolean(loop);
    const vol = Number(volume);
    audio.volume = (Number.isFinite(vol) ? Math.min(100, Math.max(0, vol)) : 80) / 100;
    await audio.play();
  } catch (err) {
    console.warn('offscreen play failed:', err);
    currentSoundId = null;
    currentOwnerTabId = null;
    reportAudioState();
  }
}

function stop() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  releaseObjectUrl();
  currentSoundId = null;
  currentOwnerTabId = null;
  reportAudioState();
}

// ---------------------------------------------------------------------------
// Message handling (only messages addressed to the offscreen document)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return undefined;
  switch (msg.type) {
    case MSG.OS_ARM:
      worker.postMessage({ type: 'arm', tabId: msg.tabId, fireAt: msg.fireAt });
      break;
    case MSG.OS_DISARM:
      worker.postMessage({ type: 'disarm', tabId: msg.tabId });
      break;
    case MSG.OS_DISARM_ALL:
      worker.postMessage({ type: 'disarmAll' });
      break;
    case MSG.OS_PLAY:
      play(msg); // async fire-and-forget; state reported via OS_AUDIO_STATE
      break;
    case MSG.OS_STOP:
      stop();
      break;
    default:
      return undefined;
  }
  sendResponse({ ok: true });
  return undefined;
});
