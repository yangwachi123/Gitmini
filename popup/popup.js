// Popup UI logic (Thai). The popup reads job state directly from
// chrome.storage.session (trusted context) and sends commands to the SW.

import { MSG, STORAGE, DEFAULT_SETTINGS, jobKey } from '../common/messages.js';

const $ = (id) => document.getElementById(id);

const el = {
  statusPill: $('status-pill'),
  restricted: $('restricted-msg'),
  liveSection: $('live-section'),
  countdown: $('countdown'),
  cycleCount: $('cycle-count'),
  lastFoundRow: $('last-found-row'),
  lastFound: $('last-found'),
  errorRow: $('error-row'),
  errorText: $('error-text'),
  intervalSelect: $('interval-select'),
  customBox: $('custom-interval'),
  customSeconds: $('custom-seconds'),
  randomBox: $('random-interval'),
  randomMin: $('random-min'),
  randomMax: $('random-max'),
  keywords: $('keywords'),
  keywordsBox: $('keywords-box'),
  caseSensitive: $('case-sensitive'),
  ofStop: $('of-stop'),
  ofSound: $('of-sound'),
  ofNotification: $('of-notification'),
  ofHighlight: $('of-highlight'),
  ofFocus: $('of-focus'),
  ofAutoclick: $('of-autoclick'),
  clickTargetBox: $('clicktarget-box'),
  clickTarget: $('click-target'),
  soundSelect: $('sound-select'),
  testSound: $('test-sound'),
  stopSound: $('stop-sound'),
  volume: $('volume'),
  volumeValue: $('volume-value'),
  soundFile: $('sound-file'),
  customSoundName: $('custom-sound-name'),
  overlayEnabled: $('overlay-enabled'),
  formError: $('form-error'),
  saveDefaults: $('save-defaults'),
  startStop: $('start-stop'),
};

let tabId = null;
let job = null;
let ticker = null;

// ---------------------------------------------------------------------------
// Target tab resolution: ?tabId= override lets tests (and power users) drive
// the popup from a regular tab, where the active-tab query would self-target.
// ---------------------------------------------------------------------------

async function resolveTab() {
  const param = new URLSearchParams(location.search).get('tabId');
  if (param) {
    try {
      return await chrome.tabs.get(Number(param));
    } catch {
      return null;
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

// ---------------------------------------------------------------------------
// Settings <-> form
// ---------------------------------------------------------------------------

const PRESETS = new Set(['5', '10', '15', '30', '60', '300', '900']);

function settingsFromForm() {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const detectionType = document.querySelector('input[name="detection"]:checked').value;

  const ivChoice = el.intervalSelect.value;
  let interval;
  if (ivChoice === 'custom') {
    interval = { type: 'custom', seconds: Number(el.customSeconds.value) };
  } else if (ivChoice === 'random') {
    interval = {
      type: 'random',
      seconds: 30,
      minSeconds: Number(el.randomMin.value),
      maxSeconds: Number(el.randomMax.value),
    };
  } else {
    interval = { type: 'preset', seconds: Number(ivChoice) };
  }

  const keywords = el.keywords.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i);

  return {
    mode,
    interval,
    detection: {
      type: detectionType,
      keywords,
      caseSensitive: el.caseSensitive.checked,
    },
    onFound: {
      stopRefresh: el.ofStop.checked,
      sound: el.ofSound.checked,
      notification: el.ofNotification.checked,
      highlight: el.ofHighlight.checked,
      focusTab: el.ofFocus.checked,
      autoClick: el.ofAutoclick.checked,
      clickTarget: el.clickTarget.value.trim(),
    },
    sound: { id: el.soundSelect.value, volume: Number(el.volume.value) },
    overlay: { enabled: el.overlayEnabled.checked },
  };
}

function fillForm(s) {
  document.querySelector(`input[name="mode"][value="${s.mode}"]`).checked = true;
  document.querySelector(`input[name="detection"][value="${s.detection.type}"]`).checked = true;

  const iv = s.interval;
  if (iv.type === 'random') {
    el.intervalSelect.value = 'random';
    el.randomMin.value = iv.minSeconds;
    el.randomMax.value = iv.maxSeconds;
  } else if (iv.type === 'custom' || !PRESETS.has(String(iv.seconds))) {
    el.intervalSelect.value = 'custom';
    el.customSeconds.value = iv.seconds;
  } else {
    el.intervalSelect.value = String(iv.seconds);
  }

  el.keywords.value = (s.detection.keywords || []).join('\n');
  el.caseSensitive.checked = Boolean(s.detection.caseSensitive);
  el.ofStop.checked = Boolean(s.onFound.stopRefresh);
  el.ofSound.checked = Boolean(s.onFound.sound);
  el.ofNotification.checked = Boolean(s.onFound.notification);
  el.ofHighlight.checked = Boolean(s.onFound.highlight);
  el.ofFocus.checked = Boolean(s.onFound.focusTab);
  el.ofAutoclick.checked = Boolean(s.onFound.autoClick);
  el.clickTarget.value = s.onFound.clickTarget || '';
  el.soundSelect.value = s.sound.id;
  el.volume.value = s.sound.volume;
  el.overlayEnabled.checked = Boolean(s.overlay?.enabled);
  syncConditionalRows();
}

function syncConditionalRows() {
  el.customBox.classList.toggle('hidden', el.intervalSelect.value !== 'custom');
  el.randomBox.classList.toggle('hidden', el.intervalSelect.value !== 'random');
  const detection = document.querySelector('input[name="detection"]:checked').value;
  el.keywordsBox.classList.toggle('hidden', detection !== 'keywords');
  el.clickTargetBox.classList.toggle('hidden', !el.ofAutoclick.checked);
  el.volumeValue.textContent = `${el.volume.value}%`;
}

function validate(s) {
  if (s.interval.type === 'custom' && (!Number.isFinite(s.interval.seconds) || s.interval.seconds < 2)) {
    return 'ช่วงเวลาต้องเป็นตัวเลขตั้งแต่ 2 วินาทีขึ้นไป';
  }
  if (s.interval.type === 'random') {
    const { minSeconds, maxSeconds } = s.interval;
    if (!Number.isFinite(minSeconds) || minSeconds < 2) return 'ค่าต่ำสุดต้องตั้งแต่ 2 วินาทีขึ้นไป';
    if (!Number.isFinite(maxSeconds) || maxSeconds <= minSeconds) {
      return 'ค่าสูงสุดต้องมากกว่าค่าต่ำสุด';
    }
  }
  if (s.detection.type === 'keywords' && s.detection.keywords.length === 0) {
    return 'กรุณาใส่คำที่ต้องการตรวจจับอย่างน้อย 1 คำ (หรือเลือก "ไม่ต้องตรวจจับ")';
  }
  if (s.detection.type === 'change' && s.onFound.autoClick && !s.onFound.clickTarget) {
    return 'โหมดตรวจจับความเปลี่ยนแปลง + คลิกอัตโนมัติ ต้องระบุข้อความปุ่มหรือ CSS selector';
  }
  if (s.sound.id === 'custom' && s.onFound.sound && !customSoundAvailable) {
    return 'ยังไม่ได้อัปโหลดไฟล์เสียง — อัปโหลดก่อน หรือเลือกเสียงในตัว';
  }
  return null;
}

function showError(msg) {
  el.formError.textContent = msg ?? '';
  el.formError.classList.toggle('hidden', !msg);
}

// ---------------------------------------------------------------------------
// Live status rendering
// ---------------------------------------------------------------------------

const PILL = {
  running: ['pill-running', 'กำลังทำงาน'],
  found: ['pill-found', 'พบแล้ว'],
  error: ['pill-error', 'ผิดพลาด'],
  stopped: ['pill-stopped', 'หยุดอยู่'],
};

function renderStatus() {
  const status = job?.status ?? 'stopped';
  const [cls, text] = PILL[status] ?? PILL.stopped;
  el.statusPill.className = `pill ${cls}`;
  el.statusPill.textContent = text;

  el.liveSection.classList.toggle('hidden', !job);
  el.startStop.textContent = job ? 'หยุด' : 'เริ่ม';
  el.startStop.classList.toggle('stop', Boolean(job));

  if (!job) return;

  if (job.status === 'running' && job.nextFireAt) {
    const remain = Math.max(0, job.nextFireAt - Date.now());
    const total = Math.round(remain / 1000);
    const mm = String(Math.floor(total / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    el.countdown.textContent = `${mm}:${ss}`;
  } else {
    el.countdown.textContent = '--:--';
  }

  el.cycleCount.textContent = `${job.cycleCount} ครั้ง`;

  const lr = job.lastResult;
  el.lastFoundRow.classList.toggle('hidden', !lr);
  if (lr) {
    const at = new Date(lr.at).toLocaleTimeString('th-TH', {
      hour: '2-digit',
      minute: '2-digit',
    });
    const what = lr.matchedKeywords?.length
      ? `"${lr.matchedKeywords.join(', ')}"`
      : 'ความเปลี่ยนแปลง';
    const clicked = lr.clicked === true ? ' (คลิกแล้ว)' : '';
    el.lastFound.textContent = `${what} เมื่อ ${at}${clicked}`;
  }

  el.errorRow.classList.toggle('hidden', job.status !== 'error');
  if (job.status === 'error') el.errorText.textContent = job.error ?? 'เกิดข้อผิดพลาด';
}

async function refreshJob() {
  if (tabId == null) return;
  const data = await chrome.storage.session.get(jobKey(tabId));
  job = data[jobKey(tabId)] ?? null;
  renderStatus();
}

async function refreshAudioState() {
  const data = await chrome.storage.session.get(STORAGE.AUDIO_STATE);
  el.stopSound.disabled = !data[STORAGE.AUDIO_STATE]?.playing;
}

// ---------------------------------------------------------------------------
// Custom sound upload
// ---------------------------------------------------------------------------

const MAX_SOUND_BYTES = 8 * 1024 * 1024;
let customSoundAvailable = false;

async function refreshCustomSoundName() {
  const data = await chrome.storage.local.get(STORAGE.CUSTOM_SOUND);
  const custom = data[STORAGE.CUSTOM_SOUND];
  customSoundAvailable = Boolean(custom?.dataUrl);
  el.customSoundName.textContent = custom?.name ? `ไฟล์: ${custom.name}` : 'ยังไม่มีไฟล์';
}

async function handleSoundUpload(file) {
  if (!file) return;
  if (file.size > MAX_SOUND_BYTES) {
    showError('ไฟล์เสียงใหญ่เกิน 8 MB');
    return;
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  await chrome.storage.local.set({
    [STORAGE.CUSTOM_SOUND]: { name: file.name, mime: file.type, dataUrl },
  });
  el.soundSelect.value = 'custom';
  showError(null);
  await refreshCustomSoundName();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

async function init() {
  const tab = await resolveTab();
  const refreshable = tab && /^https?:\/\//i.test(tab.url || '');

  if (!refreshable) {
    el.restricted.classList.remove('hidden');
    document
      .querySelectorAll('input, select, textarea, button')
      .forEach((n) => (n.disabled = true));
    return;
  }
  tabId = tab.id;

  const { [STORAGE.DEFAULTS]: defaults } = await chrome.storage.local.get(STORAGE.DEFAULTS);
  await refreshJob();
  await refreshCustomSoundName();
  await refreshAudioState();

  // A running job's settings win over saved defaults.
  fillForm(job?.settings ?? defaults ?? DEFAULT_SETTINGS);
  renderStatus();

  ticker = setInterval(async () => {
    await refreshJob();
    await refreshAudioState();
  }, 250);

  // form events
  el.intervalSelect.addEventListener('change', syncConditionalRows);
  el.volume.addEventListener('input', syncConditionalRows);
  el.ofAutoclick.addEventListener('change', syncConditionalRows);
  document
    .querySelectorAll('input[name="detection"]')
    .forEach((n) => n.addEventListener('change', syncConditionalRows));

  el.soundFile.addEventListener('change', (e) => handleSoundUpload(e.target.files[0]));

  el.testSound.addEventListener('click', async () => {
    const s = settingsFromForm();
    if (s.sound.id === 'custom' && !customSoundAvailable) {
      showError('ยังไม่ได้อัปโหลดไฟล์เสียง');
      return;
    }
    showError(null);
    await chrome.runtime.sendMessage({ type: MSG.PLAY_SOUND, sound: s.sound });
  });

  el.stopSound.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: MSG.STOP_SOUND });
  });

  el.saveDefaults.addEventListener('click', async () => {
    const s = settingsFromForm();
    const problem = validate(s);
    if (problem) {
      showError(problem);
      return;
    }
    await chrome.storage.local.set({ [STORAGE.DEFAULTS]: s });
    showError(null);
    el.saveDefaults.textContent = 'บันทึกแล้ว ✓';
    setTimeout(() => (el.saveDefaults.textContent = 'บันทึกเป็นค่าเริ่มต้น'), 1200);
  });

  el.startStop.addEventListener('click', async () => {
    if (job) {
      await chrome.runtime.sendMessage({ type: MSG.STOP_JOB, tabId });
      await refreshJob();
      return;
    }
    const s = settingsFromForm();
    const problem = validate(s);
    if (problem) {
      showError(problem);
      return;
    }
    showError(null);
    el.startStop.disabled = true;
    const res = await chrome.runtime.sendMessage({ type: MSG.START_JOB, tabId, settings: s });
    el.startStop.disabled = false;
    if (!res?.ok) {
      showError(res?.error ?? 'เริ่มไม่สำเร็จ');
      return;
    }
    await refreshJob();
  });
}

window.addEventListener('unload', () => ticker && clearInterval(ticker));
init();
