// Content script (classic script — cannot use ES modules, so message-type
// strings are duplicated from common/messages.js, the source of truth).
//
// Responsibilities: CS_READY handshake, live-DOM keyword/change scanning,
// background fetch-check (mode B), highlight/clear, auto-click, and the
// floating countdown overlay.

(() => {
  if (window.__arpInjected) return; // idempotent across re-injection
  window.__arpInjected = true;

  const HIGHLIGHT_CLASS = 'arp-kw-highlight';
  const OVERLAY_ID = 'arp-timer-overlay';
  const CLICKABLE_SELECTOR =
    'a, button, [role="button"], input[type="submit"], input[type="button"]';

  // -------------------------------------------------------------------------
  // Text utilities
  // -------------------------------------------------------------------------

  const nfc = (s) => (s || '').normalize('NFC');

  function collapse(s) {
    return nfc(s).replace(/\s+/g, ' ').trim();
  }

  // FNV-1a 32-bit — cheap deterministic content hash for change detection.
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16);
  }

  function preparedKeywords(detection) {
    const caseSensitive = Boolean(detection.caseSensitive);
    return (detection.keywords || [])
      .map((k) => nfc(k).trim())
      .filter(Boolean)
      .map((k) => (caseSensitive ? k : k.toLowerCase()));
  }

  // Scan a haystack string; returns the ORIGINAL keyword strings that matched.
  function matchKeywords(haystack, detection) {
    const caseSensitive = Boolean(detection.caseSensitive);
    const hay = caseSensitive ? nfc(haystack) : nfc(haystack).toLowerCase();
    const matched = [];
    const original = (detection.keywords || []).map((k) => nfc(k).trim()).filter(Boolean);
    const prepared = preparedKeywords(detection);
    prepared.forEach((kw, i) => {
      if (kw && hay.includes(kw)) matched.push(original[i]);
    });
    return matched;
  }

  function liveText() {
    if (!document.body) return '';
    // Detach our own overlay while reading — its ticking countdown text would
    // otherwise poison change-detection hashes (and keyword scans) with
    // ever-changing content of our own making. Synchronous detach+reattach
    // never reaches the renderer, so there is no flicker.
    const ov = document.getElementById(OVERLAY_ID);
    const parent = ov ? ov.parentNode : null;
    const next = ov ? ov.nextSibling : null;
    if (ov) ov.remove();
    const text = document.body.innerText;
    if (ov && parent) parent.insertBefore(ov, next);
    return text;
  }

  // -------------------------------------------------------------------------
  // Highlighting
  // -------------------------------------------------------------------------

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT']);

  function walkTextNodes(cb) {
    if (!document.body) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.closest(`.${HIGHLIGHT_CLASS}, #${OVERLAY_ID}`)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(cb); // collect first — mutating during the walk breaks it
  }

  function clearHighlights() {
    document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((span) => {
      const parent = span.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(span.textContent), span);
      parent.normalize();
    });
  }

  // Finds match ranges of prepared keywords in a text node. Skips nodes where
  // normalization/lowercasing changes string length (rare Unicode edge) to
  // avoid index drift between the searched string and the raw node.
  function nodeMatches(node, detection) {
    const caseSensitive = Boolean(detection.caseSensitive);
    let text = node.nodeValue || '';
    // Keywords are NFC-normalized; match against NFC page text when the
    // mapping is index-safe (same length).
    const nfcText = nfc(text);
    if (nfcText.length === text.length) text = nfcText;
    const hay = caseSensitive ? text : text.toLowerCase();
    if (hay.length !== text.length) return [];
    const ranges = [];
    for (const kw of preparedKeywords(detection)) {
      let idx = hay.indexOf(kw);
      while (idx !== -1) {
        ranges.push([idx, idx + kw.length]);
        idx = hay.indexOf(kw, idx + kw.length);
      }
    }
    // merge overlapping ranges, left to right
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push(r);
    }
    return merged;
  }

  function highlightKeywords(detection, scroll) {
    clearHighlights();
    const created = []; // document order — created[0] is the FIRST match
    walkTextNodes((node) => {
      const ranges = nodeMatches(node, detection);
      if (!ranges.length) return;
      // wrap right-to-left so earlier offsets stay valid, but record the
      // node's spans in left-to-right order
      const nodeSpans = [];
      for (let i = ranges.length - 1; i >= 0; i--) {
        const [start, end] = ranges[i];
        const target = node.splitText(start);
        target.splitText(end - start);
        const span = document.createElement('span');
        span.className = HIGHLIGHT_CLASS;
        span.textContent = target.nodeValue;
        target.parentNode.replaceChild(span, target);
        nodeSpans.unshift(span);
      }
      created.push(...nodeSpans);
    });
    if (scroll && created.length) {
      created[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return created;
  }

  // -------------------------------------------------------------------------
  // Auto click
  // -------------------------------------------------------------------------

  function findFirstKeywordElement(detection) {
    let found = null;
    walkTextNodes((node) => {
      if (found) return;
      if (nodeMatches(node, detection).length) found = node.parentElement;
    });
    return found;
  }

  // Click an element identified by CSS selector or by visible text.
  // Priority: valid CSS selector > clickable element containing the text.
  function clickExplicitTarget(rawTarget) {
    const target = nfc(rawTarget || '').trim();
    if (!target) return false;
    try {
      const el = document.querySelector(target);
      if (el) {
        el.click();
        return true;
      }
    } catch {
      /* not a valid selector — fall through to text matching */
    }
    const needle = target.toLowerCase();
    for (const el of document.querySelectorAll(CLICKABLE_SELECTOR)) {
      const text = nfc(el.innerText || el.value || '').toLowerCase();
      if (text.includes(needle)) {
        el.click();
        return true;
      }
    }
    return false;
  }

  // Priority: explicit target (selector/text) > closest clickable ancestor of
  // the first matched keyword.
  function autoClick(clickTarget, detection) {
    const target = nfc(clickTarget || '').trim();

    if (target) return clickExplicitTarget(target);

    // No explicit target: click the clickable ancestor of the matched keyword.
    if (detection.type !== 'keywords') return false;
    const el = findFirstKeywordElement(detection);
    const clickable = el && el.closest(CLICKABLE_SELECTOR);
    if (clickable) {
      clickable.click();
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Scans
  // -------------------------------------------------------------------------

  function runLiveScan(req) {
    const { detection } = req;
    const text = liveText();
    const contentHash = fnv1a(collapse(text));
    let found = false;
    let matchedKeywords = [];

    if (detection.type === 'keywords') {
      matchedKeywords = matchKeywords(text, detection);
      found = matchedKeywords.length > 0;
    }
    // Change detection is evaluated by the service worker (it owns the
    // baseline); we just report the hash. `found` from the SW's perspective
    // may differ — clicking for change mode is driven by displayOnly passes.

    // Click BEFORE highlighting: the highlight spans would otherwise hide the
    // keyword's text node from the clickable-ancestor search.
    let clicked = null;
    const shouldClick =
      req.doClick && (found || (req.displayOnly && detection.type !== 'keywords'));
    if (shouldClick) clicked = autoClick(req.clickTarget, detection);

    if (found && req.doHighlight) highlightKeywords(detection, req.doScroll);

    return { ok: true, found, matchedKeywords, contentHash, clicked };
  }

  // Click-refresh (monitor mode for JS-rendered sites): click the page's own
  // refresh button, give its AJAX a moment to settle, then scan the live DOM.
  async function runClickRefresh(req) {
    clearHighlights(); // stale highlights would confuse the fresh scan
    if (!clickExplicitTarget(req.refreshTarget)) {
      return { ok: false, error: 'refresh target not found' };
    }
    await new Promise((r) => setTimeout(r, Math.max(0, req.settleMs ?? 1200)));
    return runLiveScan(req);
  }

  async function runFetchCheck(req) {
    const { detection } = req;
    let text;
    try {
      const res = await fetch(req.url, {
        credentials: 'include',
        cache: 'no-store',
        redirect: 'follow',
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      doc.querySelectorAll('script, style, noscript, template').forEach((el) => el.remove());
      text = doc.body ? doc.body.textContent : '';
    } catch (err) {
      return { ok: false, error: String(err) };
    }

    const collapsed = collapse(text);
    const contentHash = fnv1a(collapsed);
    let found = false;
    let matchedKeywords = [];
    if (detection.type === 'keywords') {
      // Match on collapsed text: raw textContent keeps source-HTML newlines
      // and indentation, which would break multi-word keywords that innerText
      // (mode A) matches fine.
      matchedKeywords = matchKeywords(collapsed, detection);
      found = matchedKeywords.length > 0;
    }
    return { ok: true, found, matchedKeywords, contentHash };
  }

  // -------------------------------------------------------------------------
  // Floating countdown overlay
  // -------------------------------------------------------------------------

  const overlay = {
    el: null,
    labelEl: null,
    nextFireAt: null,
    status: null,
    tick: null,
    hiddenByUser: false,
  };

  const posKey = () => `overlayPos:${location.origin}`;

  function overlayStatusText() {
    if (overlay.status === 'found') return 'พบแล้ว!';
    if (overlay.status === 'error') return 'ผิดพลาด';
    if (overlay.nextFireAt == null) return 'หยุดอยู่';
    const remain = Math.max(0, overlay.nextFireAt - Date.now());
    const total = Math.round(remain / 1000);
    const mm = String(Math.floor(total / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    const verb = overlay.mode === 'monitor' ? 'ตรวจสอบใน' : 'รีเฟรชใน';
    return `${verb} ${mm}:${ss}`;
  }

  function buildOverlay() {
    const el = document.createElement('div');
    el.id = OVERLAY_ID;
    Object.assign(el.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      left: 'auto',
      top: 'auto',
      zIndex: '2147483647',
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
      padding: '8px 12px',
      background: 'rgba(17, 24, 39, 0.92)',
      color: '#fff',
      font: '13px/1.4 system-ui, sans-serif',
      borderRadius: '8px',
      boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
      cursor: 'move',
      userSelect: 'none',
    });

    const icon = document.createElement('span');
    icon.textContent = '🔄';
    const label = document.createElement('span');
    const close = document.createElement('span');
    close.textContent = '×';
    Object.assign(close.style, {
      cursor: 'pointer',
      fontSize: '16px',
      lineHeight: '1',
      opacity: '0.7',
      padding: '0 2px',
    });
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      overlay.hiddenByUser = true;
      removeOverlay();
    });

    el.append(icon, label, close);

    // Drag; persist position per origin.
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.target === close) return;
      const rect = el.getBoundingClientRect();
      drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const left = Math.max(0, Math.min(window.innerWidth - 40, e.clientX - drag.dx));
      const top = Math.max(0, Math.min(window.innerHeight - 24, e.clientY - drag.dy));
      Object.assign(el.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' });
    });
    el.addEventListener('pointerup', (e) => {
      if (!drag) return;
      drag = null;
      el.releasePointerCapture(e.pointerId);
      const rect = el.getBoundingClientRect();
      try {
        chrome.storage.local.set({ [posKey()]: { left: rect.left, top: rect.top } });
      } catch {
        /* extension context gone */
      }
    });

    overlay.el = el;
    overlay.labelEl = label;
    return el;
  }

  async function showOverlay() {
    if (overlay.hiddenByUser || !document.body) return;
    if (!overlay.el || !overlay.el.isConnected) {
      const el = overlay.el && !overlay.el.isConnected ? overlay.el : buildOverlay();
      document.body.appendChild(el);
      try {
        const stored = await chrome.storage.local.get(posKey());
        const pos = stored[posKey()];
        if (pos) {
          Object.assign(el.style, {
            left: `${Math.max(0, Math.min(window.innerWidth - 40, pos.left))}px`,
            top: `${Math.max(0, Math.min(window.innerHeight - 24, pos.top))}px`,
            right: 'auto',
            bottom: 'auto',
          });
        }
      } catch {
        /* storage unavailable */
      }
    }
    if (!overlay.tick) {
      overlay.tick = setInterval(() => {
        if (overlay.labelEl) overlay.labelEl.textContent = overlayStatusText();
        // Many sites rewrite <body> while booting (SPAs) which silently drops
        // the overlay — re-attach whenever it goes missing.
        if (overlay.el && !overlay.el.isConnected && !overlay.hiddenByUser && document.body) {
          document.body.appendChild(overlay.el);
        }
      }, 500);
    }
    overlay.labelEl.textContent = overlayStatusText();
  }

  function removeOverlay() {
    if (overlay.tick) {
      clearInterval(overlay.tick);
      overlay.tick = null;
    }
    if (overlay.el?.isConnected) overlay.el.remove();
  }

  function applyOverlay({ enabled, nextFireAt, status, mode }) {
    overlay.nextFireAt = nextFireAt ?? null;
    overlay.status = status ?? null;
    overlay.mode = mode ?? overlay.mode ?? null;
    if (enabled && status === 'running') showOverlay();
    else if (enabled && (status === 'found' || status === 'error')) showOverlay();
    else removeOverlay();
  }

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case 'CS_SCAN':
        sendResponse(runLiveScan(msg));
        return undefined;

      case 'CS_FETCH_CHECK':
        runFetchCheck(msg).then(sendResponse);
        return true;

      case 'CS_CLICK_REFRESH':
        runClickRefresh(msg).then(sendResponse);
        return true;

      case 'CS_CLEAR_HIGHLIGHTS':
        clearHighlights();
        sendResponse({ ok: true });
        return undefined;

      case 'CS_TIMER_UPDATE':
        applyOverlay(msg);
        sendResponse({ ok: true });
        return undefined;

      default:
        return undefined;
    }
  });

  // -------------------------------------------------------------------------
  // Handshake: tell the SW this page is ready (it may have a pending scan for
  // this tab). Wait for full load so innerText reflects the final content.
  // -------------------------------------------------------------------------

  let readySent = false;
  function sendReady() {
    if (readySent) return;
    readySent = true;
    try {
      chrome.runtime
        .sendMessage({ type: 'CS_READY', href: location.href })
        .then((res) => {
          if (res?.overlay) applyOverlay(res.overlay);
        })
        .catch(() => {});
    } catch {
      /* extension reloaded */
    }
  }

  if (document.readyState === 'complete') {
    sendReady();
  } else {
    window.addEventListener('load', sendReady, { once: true });
    setTimeout(sendReady, 3000); // safety net for pages that never fire load
  }
})();
