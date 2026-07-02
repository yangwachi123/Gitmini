// Service worker: owns all policy. Job state lives in chrome.storage.session
// (never in SW memory alone) so the worker can die at any time; timer fires
// from the offscreen document wake it back up.

import {
  MSG,
  STORAGE,
  NOTIFICATION_PREFIX,
  WATCHDOG_ALARM,
  DEFAULT_SETTINGS,
  jobKey,
} from '../common/messages.js';

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function getJob(tabId) {
  const key = jobKey(tabId);
  const data = await chrome.storage.session.get(key);
  return data[key] ?? null;
}

async function setJob(job) {
  await chrome.storage.session.set({ [jobKey(job.tabId)]: job });
}

async function removeJob(tabId) {
  await chrome.storage.session.remove(jobKey(tabId));
}

async function getAllJobs() {
  const all = await chrome.storage.session.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(STORAGE.JOB_PREFIX))
    .map(([, v]) => v);
}

async function getAudioState() {
  const data = await chrome.storage.session.get(STORAGE.AUDIO_STATE);
  return data[STORAGE.AUDIO_STATE] ?? { playing: false, soundId: null, ownerTabId: null };
}

// ---------------------------------------------------------------------------
// Offscreen document lifecycle
// ---------------------------------------------------------------------------

let creatingOffscreen = null; // guard against concurrent creation

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return false; // already existed
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: 'offscreen/offscreen.html',
        reasons: ['AUDIO_PLAYBACK', 'BLOBS'],
        justification: 'เล่นเสียงแจ้งเตือนแบบวนซ้ำและจับเวลารีเฟรชหน้าเว็บ',
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
  return true; // freshly created
}

async function closeOffscreenIfIdle() {
  const jobs = await getAllJobs();
  const audio = await getAudioState();
  if (jobs.length === 0 && !audio.playing && (await hasOffscreen())) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

function toOffscreen(msg) {
  return chrome.runtime.sendMessage({ ...msg, target: 'offscreen' }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Timer arming
// ---------------------------------------------------------------------------

function computeDelayMs(settings) {
  const iv = settings.interval;
  let seconds;
  if (iv.type === 'random') {
    const min = Math.max(2, Number(iv.minSeconds) || 2);
    const max = Math.max(min, Number(iv.maxSeconds) || min);
    seconds = min + Math.random() * (max - min);
  } else {
    seconds = Math.max(2, Number(iv.seconds) || 30);
  }
  return Math.round(seconds * 1000);
}

async function armJob(job) {
  await ensureOffscreen();
  await toOffscreen({ type: MSG.OS_ARM, tabId: job.tabId, fireAt: job.nextFireAt });
}

async function ensureWatchdog() {
  const existing = await chrome.alarms.get(WATCHDOG_ALARM);
  if (!existing) {
    await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
  }
}

// ---------------------------------------------------------------------------
// Content-script messaging (with one inject-and-retry for stale tabs)
// ---------------------------------------------------------------------------

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    // Content script may be missing (tab opened before install, or a hard
    // error page). Inject once and retry.
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/highlight.css'] });
      return await chrome.tabs.sendMessage(tabId, message);
    } catch {
      throw err;
    }
  }
}

async function sendTimerUpdate(job) {
  const payload = {
    type: MSG.CS_TIMER_UPDATE,
    enabled: Boolean(job.settings.overlay?.enabled),
    nextFireAt: job.status === 'running' ? job.nextFireAt : null,
    status: job.status,
  };
  await sendToTab(job.tabId, payload).catch(() => {});
}

function buildScanRequest(job, { displayOnly = false } = {}) {
  const { detection, onFound } = job.settings;
  return {
    type: MSG.CS_SCAN,
    detection,
    // Highlight only makes sense for keyword detection.
    doHighlight: detection.type === 'keywords' && Boolean(onFound.highlight),
    doScroll: true,
    // Click only on a *new* found event (a display pass is always one) —
    // never repeatedly while the keyword just stays on the page.
    doClick: Boolean(onFound.autoClick) && (displayOnly || !job.lastCheckFound),
    clickTarget: onFound.clickTarget || '',
    displayOnly,
  };
}

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------

function isRefreshableUrl(url) {
  return /^https?:\/\//i.test(url || '');
}

async function startJob(tabId, settings) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, error: 'ไม่พบแท็บนี้แล้ว' };
  }
  if (!isRefreshableUrl(tab.url)) {
    return { ok: false, error: 'ไม่สามารถใช้งานกับหน้านี้ได้ (รองรับเฉพาะ http/https)' };
  }

  const merged = { ...structuredClone(DEFAULT_SETTINGS), ...settings };
  const delay = computeDelayMs(merged);
  const job = {
    tabId,
    windowId: tab.windowId,
    url: tab.url,
    settings: merged,
    status: 'running',
    startedAt: Date.now(),
    nextFireAt: Date.now() + delay,
    cycleCount: 0,
    lastResult: null,
    lastCheckFound: false,
    baselineHash: null,
    consecutiveFailures: 0,
    pendingScan: false,
    pendingHighlight: false,
    error: null,
  };
  await setJob(job);
  await armJob(job);
  await ensureWatchdog();

  // Initial scan: establishes the change-detection baseline, and alerts
  // immediately if a keyword is already present on the page.
  if (merged.detection.type !== 'none') {
    try {
      if (merged.mode === 'monitor') {
        const res = await sendToTab(tabId, {
          type: MSG.CS_FETCH_CHECK,
          url: job.url,
          detection: merged.detection,
        });
        await processCheckResult(job, res);
      } else {
        const res = await sendToTab(tabId, buildScanRequest(job));
        await processCheckResult(job, res);
      }
    } catch {
      if (merged.mode === 'monitor') {
        // Monitor mode cannot work at all without the content script.
        await stopJob(tabId, { silent: true });
        return {
          ok: false,
          error: 'ไม่สามารถเข้าถึงเนื้อหาหน้านี้ได้ ลองรีโหลดหน้าก่อน หรือใช้โหมดรีโหลดหน้าเว็บแทน',
        };
      }
      // Reload mode: fine — the first reload will inject the content script.
    }
  }

  const current = (await getJob(tabId)) ?? job;
  await sendTimerUpdate(current);
  return { ok: true, job: current };
}

async function stopJob(tabId, { silent = false } = {}) {
  const job = await getJob(tabId);
  await removeJob(tabId);
  await toOffscreen({ type: MSG.OS_DISARM, tabId });

  const audio = await getAudioState();
  if (audio.playing && audio.ownerTabId === tabId) {
    await toOffscreen({ type: MSG.OS_STOP });
  }
  chrome.notifications.clear(NOTIFICATION_PREFIX + tabId);

  if (!silent && job) {
    await sendToTab(tabId, { type: MSG.CS_CLEAR_HIGHLIGHTS }).catch(() => {});
    await sendToTab(tabId, {
      type: MSG.CS_TIMER_UPDATE,
      enabled: false,
      nextFireAt: null,
      status: 'stopped',
    }).catch(() => {});
  }

  const jobs = await getAllJobs();
  if (jobs.length === 0) {
    await toOffscreen({ type: MSG.OS_DISARM_ALL });
    await chrome.alarms.clear(WATCHDOG_ALARM);
    await closeOffscreenIfIdle();
  }
  return { ok: true };
}

async function errorStop(job, message) {
  job.status = 'error';
  job.error = message;
  await setJob(job);
  await toOffscreen({ type: MSG.OS_DISARM, tabId: job.tabId });
  await sendTimerUpdate(job);
}

// ---------------------------------------------------------------------------
// Scan/check result processing + on-found pipeline
// ---------------------------------------------------------------------------

// Evaluates a scan (live DOM) or fetch-check result against the job's
// detection config. Returns after running the on-found pipeline if needed.
async function processCheckResult(job, res, { displayOnly = false } = {}) {
  if (!res || res.ok === false) return;

  if (displayOnly) {
    // Display pass: alerts already fired for this event — just record
    // whether the auto-click happened.
    if (job.lastResult && res.clicked != null) {
      job.lastResult.clicked = res.clicked;
      await setJob(job);
    }
    return;
  }

  const { detection } = job.settings;
  let found = false;
  let matchedKeywords = [];
  const wasFound = job.lastCheckFound === true;

  if (detection.type === 'keywords') {
    found = Boolean(res.found);
    matchedKeywords = res.matchedKeywords || [];
    job.lastCheckFound = found;
    if (found && wasFound) {
      // Still found from the previous cycle — not a new event; don't re-alert.
      await setJob(job);
      return;
    }
  } else if (detection.type === 'change') {
    if (job.baselineHash == null) {
      job.baselineHash = res.contentHash ?? null;
      await setJob(job);
      return; // first observation only establishes the baseline
    }
    if (res.contentHash != null && res.contentHash !== job.baselineHash) {
      found = true;
      job.baselineHash = res.contentHash; // each further change is a new event
    }
  }

  if (found) {
    await onFound(job, matchedKeywords, res);
  } else {
    await setJob(job);
  }
}

async function onFound(job, matchedKeywords, res) {
  const { onFound: actions, sound, mode, detection } = job.settings;

  job.lastResult = {
    found: true,
    matchedKeywords,
    clicked: res?.clicked ?? null,
    at: Date.now(),
  };

  if (actions.stopRefresh) {
    job.status = 'found';
    await toOffscreen({ type: MSG.OS_DISARM, tabId: job.tabId });
  }

  // Mode B found something in the *fetched* copy — reload once so highlight
  // and auto-click can run against the live page. (Highlight only exists for
  // keyword detection; change-mode clicking needs an explicit clickTarget.)
  const wantsDisplayPass =
    (detection.type === 'keywords' && (actions.highlight || actions.autoClick)) ||
    (detection.type === 'change' && actions.autoClick && actions.clickTarget);
  if (mode === 'monitor' && wantsDisplayPass) {
    job.pendingHighlight = true;
  }
  await setJob(job);

  if (actions.sound) {
    await ensureOffscreen();
    await toOffscreen({
      type: MSG.OS_PLAY,
      source: sound.id === 'custom' ? { kind: 'custom' } : { kind: 'builtin', id: sound.id },
      volume: sound.volume,
      loop: true,
      ownerTabId: job.tabId,
    });
  }

  if (actions.notification) {
    const message =
      detection.type === 'change'
        ? 'ตรวจพบความเปลี่ยนแปลงของหน้าเว็บ'
        : `พบคำ: ${matchedKeywords.join(', ')}`;
    chrome.notifications.create(NOTIFICATION_PREFIX + job.tabId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('assets/icons/icon128.png'),
      title: 'Auto Refresh Plus TH — พบแล้ว!',
      message,
      priority: 2,
      requireInteraction: true,
      buttons: [{ title: 'หยุดเสียง' }],
    });
  }

  if (actions.focusTab) {
    try {
      const tab = await chrome.tabs.update(job.tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch {
      /* tab may be gone */
    }
  }

  if (job.pendingHighlight) {
    try {
      await chrome.tabs.reload(job.tabId);
    } catch {
      job.pendingHighlight = false;
      await setJob(job);
    }
  }

  // Mode A + change detection + auto-click: the discovering scan can't click
  // (the content script doesn't know the baseline) — run a display pass now.
  if (
    mode === 'reload' &&
    detection.type === 'change' &&
    actions.autoClick &&
    actions.clickTarget
  ) {
    try {
      const res2 = await sendToTab(job.tabId, buildScanRequest(job, { displayOnly: true }));
      if (job.lastResult && res2?.clicked != null) {
        job.lastResult.clicked = res2.clicked;
        await setJob(job);
      }
    } catch {
      /* tab gone */
    }
  }

  await sendTimerUpdate(job);
}

// ---------------------------------------------------------------------------
// Timer fire handling
// ---------------------------------------------------------------------------

async function handleFired(tabId) {
  const job = await getJob(tabId);
  if (!job || job.status !== 'running') {
    await toOffscreen({ type: MSG.OS_DISARM, tabId });
    return;
  }

  job.cycleCount += 1;

  if (job.settings.mode === 'reload') {
    job.pendingScan = job.settings.detection.type !== 'none';
    job.nextFireAt = Date.now() + computeDelayMs(job.settings);
    await setJob(job);
    await armJob(job);
    try {
      await chrome.tabs.reload(tabId);
    } catch {
      await errorStop(job, 'ไม่สามารถรีโหลดแท็บนี้ได้');
    }
    return;
  }

  // Monitor mode: background fetch via the content script.
  let res = null;
  try {
    res = await sendToTab(tabId, {
      type: MSG.CS_FETCH_CHECK,
      url: job.url,
      detection: job.settings.detection,
    });
  } catch {
    res = { ok: false };
  }

  if (!res || res.ok === false) {
    job.consecutiveFailures += 1;
    if (job.consecutiveFailures >= 3) {
      await errorStop(
        job,
        'ตรวจสอบหน้าเว็บไม่สำเร็จ 3 ครั้งติดต่อกัน (อาจถูก CSP บล็อก) ลองใช้โหมดรีโหลดหน้าเว็บแทน'
      );
      return;
    }
  } else {
    job.consecutiveFailures = 0;
    await processCheckResult(job, res);
  }

  const updated = await getJob(tabId);
  if (updated && updated.status === 'running') {
    updated.nextFireAt = Date.now() + computeDelayMs(updated.settings);
    await setJob(updated);
    await armJob(updated);
    await sendTimerUpdate(updated);
  }
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return undefined; // not for us

  switch (msg?.type) {
    case MSG.START_JOB:
      startJob(msg.tabId, msg.settings).then(sendResponse);
      return true;

    case MSG.STOP_JOB:
      stopJob(msg.tabId).then(sendResponse);
      return true;

    case MSG.PLAY_SOUND:
      (async () => {
        await ensureOffscreen();
        await toOffscreen({
          type: MSG.OS_PLAY,
          source:
            msg.sound.id === 'custom' ? { kind: 'custom' } : { kind: 'builtin', id: msg.sound.id },
          volume: msg.sound.volume,
          loop: false,
          ownerTabId: null,
        });
        sendResponse({ ok: true });
      })();
      return true;

    case MSG.STOP_SOUND:
      toOffscreen({ type: MSG.OS_STOP }).then(() => sendResponse({ ok: true }));
      return true;

    case MSG.OS_FIRED:
      handleFired(msg.tabId).then(() => sendResponse({ ok: true }));
      return true;

    case MSG.OS_AUDIO_STATE:
      chrome.storage.session
        .set({
          [STORAGE.AUDIO_STATE]: {
            playing: msg.playing,
            soundId: msg.soundId,
            ownerTabId: msg.ownerTabId,
          },
        })
        .then(() => sendResponse({ ok: true }));
      return true;

    case MSG.CS_READY:
      handleContentReady(sender.tab?.id).then(sendResponse);
      return true;

    default:
      return undefined;
  }
});

async function handleContentReady(tabId) {
  if (tabId == null) return { action: 'none' };
  const job = await getJob(tabId);
  if (!job) return { action: 'none' };

  const overlay = {
    enabled: Boolean(job.settings.overlay?.enabled),
    nextFireAt: job.status === 'running' ? job.nextFireAt : null,
    status: job.status,
  };

  if (job.pendingScan || job.pendingHighlight) {
    const displayOnly = job.pendingHighlight;
    job.pendingScan = false;
    job.pendingHighlight = false;
    await setJob(job);
    // Run the scan asynchronously — CS_READY's response only carries overlay
    // state; scan results come back via the CS_SCAN response path.
    (async () => {
      try {
        const fresh = await getJob(tabId);
        if (!fresh) return;
        const res = await sendToTab(tabId, buildScanRequest(fresh, { displayOnly }));
        await processCheckResult(fresh, res, { displayOnly });
      } catch {
        /* tab navigated away mid-scan */
      }
    })();
  }

  return { action: 'ok', overlay };
}

// ---------------------------------------------------------------------------
// Tab lifecycle
// ---------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  stopJob(tabId, { silent: true });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const job = await getJob(tabId);
  if (!job || job.status !== 'running') return;

  let sameOrigin = false;
  try {
    sameOrigin = new URL(changeInfo.url).origin === new URL(job.url).origin;
  } catch {
    sameOrigin = false;
  }

  if (job.settings.mode === 'monitor') {
    if (!sameOrigin) {
      await errorStop(job, 'แท็บถูกเปลี่ยนไปเว็บไซต์อื่น การตรวจสอบถูกหยุด');
    }
  } else {
    // Reload mode follows the user: keep refreshing whatever page is open.
    job.url = changeInfo.url;
    await setJob(job);
  }
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

chrome.notifications.onClicked.addListener(async (id) => {
  if (!id.startsWith(NOTIFICATION_PREFIX)) return;
  const tabId = Number(id.slice(NOTIFICATION_PREFIX.length));
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    /* tab gone */
  }
  chrome.notifications.clear(id);
});

chrome.notifications.onButtonClicked.addListener((id, buttonIndex) => {
  if (!id.startsWith(NOTIFICATION_PREFIX) || buttonIndex !== 0) return;
  toOffscreen({ type: MSG.OS_STOP });
  chrome.notifications.clear(id);
});

// ---------------------------------------------------------------------------
// Watchdog: offscreen may be reclaimed (its AUDIO_PLAYBACK idle rule is
// under-documented). Recreate + re-arm from persisted absolute fire times —
// arming is idempotent, so re-arming healthy jobs is harmless.
// ---------------------------------------------------------------------------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== WATCHDOG_ALARM) return;
  const jobs = (await getAllJobs()).filter((j) => j.status === 'running');
  if (jobs.length === 0) {
    await chrome.alarms.clear(WATCHDOG_ALARM);
    return;
  }
  await ensureOffscreen();
  for (const job of jobs) {
    // Overdue fires (offscreen was dead past nextFireAt) fire immediately.
    await toOffscreen({
      type: MSG.OS_ARM,
      tabId: job.tabId,
      fireAt: Math.max(job.nextFireAt, Date.now()),
    });
  }
});

// ---------------------------------------------------------------------------
// Install: seed defaults + inject content scripts into already-open tabs
// (manifest content_scripts only apply to pages loaded after install).
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(STORAGE.DEFAULTS);
  if (!existing[STORAGE.DEFAULTS]) {
    await chrome.storage.local.set({ [STORAGE.DEFAULTS]: DEFAULT_SETTINGS });
  }

  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/content.js'],
      });
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['content/highlight.css'],
      });
    } catch {
      /* chrome web store pages etc. reject injection — fine */
    }
  }
});
