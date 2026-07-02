// E2E smoke test: loads the unpacked extension into the pre-installed
// Chromium (new headless supports extensions) and drives it against
// tests/server.py.
//
// Run:  python3 tests/server.py 8907 &   (or let this script spawn it)
//       PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tests/e2e/smoke.test.mjs
//
// Playwright is resolved from the global npm install — the extension itself
// has no dependencies.

import { createRequire } from 'node:module';
import { execSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  try {
    return req('playwright');
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim();
    return createRequire(path.join(globalRoot, 'x.js'))('playwright');
  }
}

const { chromium } = loadPlaywright();

const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.TEST_PORT || 8907);
const BASE = `http://127.0.0.1:${PORT}`;
const KW = 'โปรโมชั่นพิเศษ';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 30000, interval = 300, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label} (last=${JSON.stringify(last)})`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

async function serverJson(pathname) {
  const res = await fetch(`${BASE}${pathname}`);
  return res.json();
}

const resetName = (name) => fetch(`${BASE}/reset/${name}`, { method: 'POST' });

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let context;
let sw; // extension service worker handle
let extId;
let serverProc;
let profileDir;

async function setup() {
  // Spawn the test server unless one is already running.
  try {
    await fetch(`${BASE}/counter/_probe`);
  } catch {
    serverProc = spawn('python3', ['tests/server.py', String(PORT)], {
      cwd: EXT_DIR,
      stdio: 'ignore',
    });
    await waitFor(
      () => fetch(`${BASE}/counter/_probe`).then(() => true).catch(() => false),
      { timeout: 10000, label: 'test server' }
    );
  }

  profileDir = mkdtempSync(path.join(tmpdir(), 'arp-e2e-'));
  context = await chromium.launchPersistentContext(profileDir, {
    // channel 'chromium' is required: plain headless uses headless-shell,
    // which cannot load extensions.
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extId = new URL(sw.url()).host;

  // Extension API bindings appear slightly after the worker starts.
  await waitFor(() => sw.evaluate(() => typeof chrome?.storage !== 'undefined'), {
    timeout: 10000,
    label: 'chrome APIs in SW',
  });
}

async function teardown() {
  await context?.close().catch(() => {});
  serverProc?.kill();
  if (profileDir) rmSync(profileDir, { recursive: true, force: true });
}

// --- extension helpers ------------------------------------------------------

async function tabIdFor(urlPrefix) {
  return waitFor(
    () =>
      sw.evaluate(
        (prefix) => chrome.tabs.query({}).then((ts) => ts.find((t) => t.url?.startsWith(prefix))?.id),
        urlPrefix
      ),
    { label: `tab for ${urlPrefix}` }
  );
}

async function openTarget(pathname) {
  const page = await context.newPage();
  await page.goto(`${BASE}${pathname}`, { waitUntil: 'load' });
  const tabId = await tabIdFor(`${BASE}${pathname}`);
  return { page, tabId };
}

async function openPopup(tabId) {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/popup.html?tabId=${tabId}`, {
    waitUntil: 'load',
  });
  return popup;
}

async function readJob(tabId) {
  return sw.evaluate(
    (key) => chrome.storage.session.get(key).then((d) => d[key] ?? null),
    `job:${tabId}`
  );
}

async function readAudioState() {
  return sw.evaluate(() =>
    chrome.storage.session.get('audioState').then((d) => d.audioState ?? null)
  );
}

async function sendFromExtension(msg) {
  // Any extension page can message the SW; use a throwaway popup page.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'load' });
  const res = await page.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  await page.close();
  return res;
}

// Fill the popup form. `cfg` mirrors the popup controls.
async function configure(popup, cfg) {
  if (cfg.mode) await popup.check(`input[name="mode"][value="${cfg.mode}"]`);
  if (cfg.detection) await popup.check(`input[name="detection"][value="${cfg.detection}"]`);
  if (cfg.keywords != null) await popup.fill('#keywords', cfg.keywords);

  if (cfg.intervalPreset) await popup.selectOption('#interval-select', String(cfg.intervalPreset));
  if (cfg.customSeconds != null) {
    await popup.selectOption('#interval-select', 'custom');
    await popup.fill('#custom-seconds', String(cfg.customSeconds));
  }
  if (cfg.random) {
    await popup.selectOption('#interval-select', 'random');
    await popup.fill('#random-min', String(cfg.random[0]));
    await popup.fill('#random-max', String(cfg.random[1]));
  }

  const checks = {
    '#of-stop': cfg.stopRefresh,
    '#of-sound': cfg.sound,
    '#of-notification': cfg.notification,
    '#of-highlight': cfg.highlight,
    '#of-focus': cfg.focusTab,
    '#of-autoclick': cfg.autoClick,
    '#overlay-enabled': cfg.overlay,
  };
  for (const [sel, val] of Object.entries(checks)) {
    if (val === true) await popup.check(sel);
    else if (val === false) await popup.uncheck(sel);
  }
  if (cfg.clickTarget != null) await popup.fill('#click-target', cfg.clickTarget);
}

async function startJob(popup) {
  await popup.click('#start-stop');
  await waitFor(
    () => popup.evaluate(() => document.getElementById('start-stop').textContent === 'หยุด'),
    { timeout: 10000, label: 'job to start' }
  );
  const err = await popup.evaluate(() => {
    const n = document.getElementById('form-error');
    return n.classList.contains('hidden') ? null : n.textContent;
  });
  assert(!err, `start error shown: ${err}`);
}

async function stopJob(tabId) {
  await sendFromExtension({ type: 'STOP_JOB', tabId });
  await sendFromExtension({ type: 'STOP_SOUND' });
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const scenarios = {};

// (a) Mode A reloads on the configured cadence.
scenarios.a_reload_cadence = async () => {
  await resetName('a');
  const { page, tabId } = await openTarget('/page/a?after=999');
  const popup = await openPopup(tabId);
  await configure(popup, {
    mode: 'reload',
    detection: 'none',
    customSeconds: 3,
    sound: false,
    notification: false,
    overlay: false,
  });
  await startJob(popup);

  await waitFor(async () => (await serverJson('/counter/a')).count >= 4, {
    timeout: 20000,
    label: 'at least 3 reloads',
  });
  await stopJob(tabId);
  await popup.close();
  await page.close();
};

// (b) Keyword found -> stops refreshing, notification + looping audio +
//     highlight on the page.
scenarios.b_keyword_found_alerts = async () => {
  await resetName('b');
  const { page, tabId } = await openTarget('/page/b?after=3');
  const popup = await openPopup(tabId);
  await configure(popup, {
    mode: 'reload',
    detection: 'keywords',
    keywords: KW,
    customSeconds: 3,
    stopRefresh: true,
    sound: true,
    notification: true,
    highlight: true,
    autoClick: false,
    overlay: false,
  });
  await startJob(popup);

  const job = await waitFor(
    async () => {
      const j = await readJob(tabId);
      return j?.status === 'found' ? j : null;
    },
    { timeout: 30000, label: 'job status found' }
  );
  assert(job.lastResult?.matchedKeywords?.includes(KW), 'matched keyword recorded');

  const audio = await waitFor(
    async () => {
      const a = await readAudioState();
      return a?.playing ? a : null;
    },
    { timeout: 10000, label: 'audio playing' }
  );
  assert(audio.soundId === 'beep', `soundId is beep (got ${audio.soundId})`);

  const notifications = await sw.evaluate(() => chrome.notifications.getAll());
  assert(notifications[`arp-found:${tabId}`], 'desktop notification created');

  await waitFor(
    () => page.locator('.arp-kw-highlight').count().then((n) => n > 0),
    { timeout: 10000, label: 'highlight span on page' }
  );

  // Refresh must have stopped.
  const before = (await serverJson('/counter/b')).count;
  await sleep(7000);
  const after = (await serverJson('/counter/b')).count;
  assert(after === before, `counter frozen after found (${before} -> ${after})`);

  await stopJob(tabId);
  await popup.close();
  await page.close();
};

// (c) Mode B detects the keyword without reloading the page, then reloads
//     exactly once for the highlight display pass.
scenarios.c_monitor_no_reload = async () => {
  await resetName('c');
  const { page, tabId } = await openTarget('/page/c?after=3');

  let navigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations += 1;
  });

  const popup = await openPopup(tabId);
  await configure(popup, {
    mode: 'monitor',
    detection: 'keywords',
    keywords: KW,
    customSeconds: 3,
    stopRefresh: true,
    sound: false,
    notification: false,
    highlight: true,
    overlay: false,
  });
  await startJob(popup);
  assert(navigations === 0, 'no navigation right after start');

  await waitFor(
    async () => (await readJob(tabId))?.status === 'found',
    { timeout: 30000, label: 'monitor found' }
  );

  // Exactly one display-pass reload, then the highlight is on the live page.
  await waitFor(() => navigations >= 1, { timeout: 10000, label: 'display-pass reload' });
  await waitFor(
    () => page.locator('.arp-kw-highlight').count().then((n) => n > 0),
    { timeout: 10000, label: 'highlight after display pass' }
  );
  assert(navigations === 1, `exactly one reload (got ${navigations})`);

  await stopJob(tabId);
  await popup.close();
  await page.close();
};

// (d) Random interval stays within bounds.
scenarios.d_random_bounds = async () => {
  await resetName('d');
  const { page, tabId } = await openTarget('/page/d?after=999');
  const popup = await openPopup(tabId);
  await configure(popup, {
    mode: 'reload',
    detection: 'none',
    random: [3, 6],
    sound: false,
    notification: false,
    overlay: false,
  });
  await startJob(popup);

  await waitFor(async () => (await serverJson('/counter/d')).count >= 5, {
    timeout: 45000,
    label: '4 reloads for gap sampling',
  });
  await stopJob(tabId);

  const { times } = await serverJson('/counter/d');
  // times[0] is the initial page load (before the job started) — check gaps
  // between reloads only.
  const gaps = [];
  for (let i = 2; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / 1000);
  for (const gap of gaps) {
    assert(gap >= 2.5 && gap <= 9, `gap ${gap.toFixed(2)}s within [2.5, 9]`);
  }
  await popup.close();
  await page.close();
};

// (e) Two tabs run independently; stopping one leaves the other running.
scenarios.e_per_tab_isolation = async () => {
  await resetName('e1');
  await resetName('e2');
  const t1 = await openTarget('/page/e1?after=999');
  const t2 = await openTarget('/page/e2?after=999');

  const p1 = await openPopup(t1.tabId);
  await configure(p1, {
    mode: 'reload',
    detection: 'none',
    customSeconds: 3,
    sound: false,
    notification: false,
    overlay: false,
  });
  await startJob(p1);

  const p2 = await openPopup(t2.tabId);
  await configure(p2, {
    mode: 'monitor',
    detection: 'keywords',
    keywords: 'ไม่มีทางเจอ_xyz_123',
    customSeconds: 3,
    sound: false,
    notification: false,
    overlay: false,
  });
  await startJob(p2);

  await sleep(5000);
  await stopJob(t1.tabId);
  const frozen = (await serverJson('/counter/e1')).count;
  const c2before = (await serverJson('/counter/e2')).count;

  await sleep(7000);
  assert((await serverJson('/counter/e1')).count === frozen, 'stopped tab stays frozen');
  assert((await serverJson('/counter/e2')).count > c2before, 'other tab keeps monitoring');
  assert((await readJob(t2.tabId))?.status === 'running', 'tab2 job still running');

  await stopJob(t2.tabId);
  for (const x of [p1, p2, t1.page, t2.page]) await x.close();
};

// (f) Popup countdown visibly decreases.
scenarios.f_popup_countdown = async () => {
  await resetName('f');
  const { page, tabId } = await openTarget('/page/f?after=999');
  const popup = await openPopup(tabId);
  await configure(popup, {
    mode: 'reload',
    detection: 'none',
    intervalPreset: 30,
    sound: false,
    notification: false,
    overlay: false,
  });
  await startJob(popup);

  const read = () => popup.evaluate(() => document.getElementById('countdown').textContent);
  const first = await waitFor(
    async () => {
      const v = await read();
      return v !== '--:--' ? v : null;
    },
    { timeout: 5000, label: 'countdown text' }
  );
  await sleep(1500);
  const second = await read();
  assert(first !== second && second < first, `countdown decreases (${first} -> ${second})`);

  await stopJob(tabId);
  await popup.close();
  await page.close();
};

// (g) Longevity: survives >60s (offscreen lifetime / watchdog probe).
scenarios.g_longevity = async () => {
  await resetName('g');
  const { page, tabId } = await openTarget('/page/g?after=999');
  const popup = await openPopup(tabId);
  await configure(popup, {
    mode: 'reload',
    detection: 'none',
    customSeconds: 15,
    sound: false,
    notification: false,
    overlay: false,
  });
  await startJob(popup);
  await popup.close();

  await sleep(70000);
  const { count } = await serverJson('/counter/g');
  // initial load + ~4 fires in 70s; allow slack for one watchdog recovery.
  assert(count >= 4, `>=3 reloads over 70s (got ${count - 1})`);
  assert((await readJob(tabId))?.status === 'running', 'job still running after 70s');

  await stopJob(tabId);
  await page.close();
};

// (h) Change-detection mode alerts without any keyword.
scenarios.h_change_detection = async () => {
  await resetName('h');
  const { page, tabId } = await openTarget('/changing/h?after=3');
  const popup = await openPopup(tabId);
  await configure(popup, {
    mode: 'monitor',
    detection: 'change',
    customSeconds: 3,
    stopRefresh: true,
    sound: false,
    notification: true,
    highlight: false,
    autoClick: false,
    overlay: false,
  });
  await startJob(popup);

  const job = await waitFor(
    async () => {
      const j = await readJob(tabId);
      return j?.status === 'found' ? j : null;
    },
    { timeout: 30000, label: 'change detected' }
  );
  assert(job.lastResult?.found === true, 'lastResult recorded');
  const notifications = await sw.evaluate(() => chrome.notifications.getAll());
  assert(notifications[`arp-found:${tabId}`], 'notification for change event');

  await stopJob(tabId);
  await popup.close();
  await page.close();
};

// (i) Auto-click clicks the element containing the found keyword.
scenarios.i_auto_click = async () => {
  await resetName('i');
  const { page, tabId } = await openTarget('/page/i?after=3');
  const popup = await openPopup(tabId);
  await configure(popup, {
    mode: 'reload',
    detection: 'keywords',
    keywords: KW,
    customSeconds: 3,
    stopRefresh: true,
    sound: false,
    notification: false,
    highlight: true,
    autoClick: true,
    clickTarget: '',
    overlay: false,
  });
  await startJob(popup);

  await waitFor(
    async () => (await readJob(tabId))?.status === 'found',
    { timeout: 30000, label: 'keyword found' }
  );
  await waitFor(async () => (await serverJson('/clicks/i')).clicks >= 1, {
    timeout: 10000,
    label: 'server recorded the click',
  });
  const job = await readJob(tabId);
  assert(job.lastResult?.clicked === true, 'clicked recorded in job');

  await stopJob(tabId);
  await popup.close();
  await page.close();
};

// (j) Floating overlay appears on the page and ticks.
scenarios.j_overlay = async () => {
  await resetName('j');
  const { page, tabId } = await openTarget('/page/j?after=999');
  const popup = await openPopup(tabId);
  await configure(popup, {
    mode: 'monitor',
    detection: 'none',
    customSeconds: 5,
    sound: false,
    notification: false,
    overlay: true,
  });
  await startJob(popup);

  await waitFor(
    () => page.locator('#arp-timer-overlay').count().then((n) => n > 0),
    { timeout: 8000, label: 'overlay attached' }
  );
  const text1 = await page.locator('#arp-timer-overlay').innerText();
  assert(text1.includes('รีเฟรชใน'), `overlay shows countdown (got "${text1}")`);
  await sleep(1600);
  const text2 = await page.locator('#arp-timer-overlay').innerText();
  assert(text1 !== text2, `overlay ticks (${text1} vs ${text2})`);

  await stopJob(tabId);
  await popup.close();
  await page.close();
};

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const only = process.argv[2]; // e.g. `node smoke.test.mjs b` runs scenario b_*

async function main() {
  await setup();
  const results = [];
  for (const [name, fn] of Object.entries(scenarios)) {
    if (only && !name.startsWith(only)) continue;
    const t0 = Date.now();
    try {
      await fn();
      results.push([name, 'PASS', Date.now() - t0]);
      console.log(`PASS ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (err) {
      results.push([name, 'FAIL', Date.now() - t0]);
      console.error(`FAIL ${name}: ${err.message}`);
    }
  }
  await teardown();

  const failed = results.filter(([, s]) => s === 'FAIL');
  console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error('harness error:', err);
  await teardown();
  process.exit(2);
});
