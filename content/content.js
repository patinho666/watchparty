// WatchParty content script: finds the streaming site's video player,
// reports what the user does, applies commands from the side panel,
// and draws reactions, the countdown and the call window over the video.
(() => {
  if (window.__wpLoaded) return;
  window.__wpLoaded = true;

  const M = globalThis.WPMedia;
  const SERVICE = M.serviceFromUrl(location.href);

  let video = null;
  let boundAt = 0;
  let readySent = false;
  let lastUrl = location.href;
  let suppressUntil = 0;
  let lastSeekAt = 0;
  let settlingUntil = 0;
  let bufferTimer = null;
  let bufferingReported = false;
  let duck = { on: false, saved: 1 };
  let knownPaused = null;   // play/pause state last reported to (or set by) the room
  let pausedWhileHidden = false;
  let settings = { toasts: true };
  const titleCache = {};

  const now = () => Date.now();
  const suppressed = () => now() < suppressUntil;
  const suppress = (ms) => { suppressUntil = Math.max(suppressUntil, now() + ms); };
  const settle = (ms) => { settlingUntil = Math.max(settlingUntil, now() + ms); };

  // ── Connection to the engine ─────────────────────────────────
  let port = null;
  let dead = false;
  let session = { active: false, partnerName: '', panelOpen: false };

  function connect() {
    if (dead) return;
    try {
      chrome.runtime.sendMessage({ to: 'bg', type: 'ensure-engine' }).catch(() => {});
      port = chrome.runtime.connect({ name: 'wp-content' });
    } catch { dead = true; showRefreshNote(); return; } // extension reloaded: this page needs a refresh
    port.onMessage.addListener(onCommand);
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
      session = { active: false, partnerName: '', panelOpen: false };
      renderCompanion();
      setTimeout(() => {
        try { void chrome.runtime.id; if (!chrome.runtime.id) throw 0; } catch { dead = true; showRefreshNote(); return; }
        connect();
      }, 2000);
    });
    send({ type: 'hello', ...snapshot() });
  }

  // After the extension is updated or reloaded, an already-open page loses its
  // connection for good. Say so instead of failing silently.
  function showRefreshNote() {
    if (document.getElementById('watchparty-refresh')) return;
    const n = document.createElement('div');
    n.id = 'watchparty-refresh';
    n.textContent = 'WatchParty was updated. Refresh this page to reconnect.';
    Object.assign(n.style, {
      position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)', zIndex: 2147483647,
      background: '#2A1F3D', color: '#F3EDE4', padding: '10px 18px', borderRadius: '999px',
      font: '15px system-ui, sans-serif', boxShadow: '0 8px 24px rgba(0,0,0,.4)', cursor: 'pointer'
    });
    n.onclick = () => location.reload();
    (document.fullscreenElement || document.body || document.documentElement).appendChild(n);
  }

  function send(msg) {
    if (!port) return;
    try { port.postMessage({ wp: true, ...msg }); } catch {}
  }

  // ── DOM search that also looks inside shadow roots ───────────
  function deepAll(root, selector, out = []) {
    root.querySelectorAll(selector).forEach((e) => out.push(e));
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deepAll(el.shadowRoot, selector, out);
    return out;
  }

  // ── Finding the right <video> ─────────────────────────────────
  function collectVideos() {
    const list = Array.from(document.querySelectorAll('video'));
    return list.length ? list : deepAll(document, 'video'); // Disney+ can hide it in shadow DOM
  }

  function pickVideo() {
    let best = null, bestScore = 0;
    for (const v of collectVideos()) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area < 40000) continue; // previews, thumbnails
      if (SERVICE !== 'disney' && isFinite(v.duration) && v.duration > 0 && v.duration < 240) continue; // trailers
      let score = area;
      if (!v.paused) score *= 3;
      if (v.readyState >= 1) score *= 1.5;
      if (score > bestScore) { best = v; bestScore = score; }
    }
    return best;
  }

  // Timers in background tabs run rarely (especially in battery or
  // efficiency mode), but the video's own progress events keep firing,
  // so they also carry the regular status reports.
  let lastStatusAt = 0;
  function onTimeUpdate() {
    if (now() - lastStatusAt < 1000) return;
    sendStatus();
  }

  function sendStatus() {
    lastStatusAt = now();
    send({ type: 'status', ...snapshot() });
  }

  const handlers = {
    play: onPlay, pause: onPause, seeked: onSeeked,
    waiting: onWaiting, playing: onPlaying, canplay: onPlaying, timeupdate: onTimeUpdate
  };

  function bind(v) {
    if (video) unbind(video);
    video = v;
    boundAt = now();
    readySent = false;
    knownPaused = null;
    primeIdCache = null;
    primeDur = 0;
    suppress(2500); // ignore the site's own autoplay right after loading
    for (const [ev, fn] of Object.entries(handlers)) v.addEventListener(ev, fn);
  }

  function unbind(v) {
    for (const [ev, fn] of Object.entries(handlers)) v.removeEventListener(ev, fn);
  }

  // ── Disney+: the real movie position ─────────────────────────
  // Disney's <video> clock doesn't match the movie timeline (it restarts
  // after seeks), so the position comes from Disney's own progress bar.
  const disney = { slider: null, lastFind: 0, lastVal: null, offset: 0, ready: false, dur: 0, logged: false };

  function findDisneySlider() {
    if (disney.slider && disney.slider.isConnected) return disney.slider;
    if (now() - disney.lastFind < 1500) return null;
    disney.lastFind = now();
    const candidates = deepAll(document, '[role="slider"], progress-bar, input[type="range"]');
    disney.slider = candidates
      .map((s) => ({ s, v: readSliderEl(s) }))
      .filter((c) => c.v && c.v.dur > 60)
      .sort((a, b) => b.v.dur - a.v.dur)
      .map((c) => c.s)[0] || null;
    if (disney.slider && !disney.logged) {
      disney.logged = true;
      const s = disney.slider;
      console.info('[WatchParty] Disney+ progress bar found:', s.tagName, {
        now: s.getAttribute('aria-valuenow') ?? s.value, max: s.getAttribute('aria-valuemax') ?? s.max,
        text: s.getAttribute('aria-valuetext')
      });
    }
    return disney.slider;
  }

  function parseClock(str) {
    const m = String(str || '').match(/(\d+):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    return m[3] != null ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2]);
  }

  function readSliderEl(s) {
    let v = parseFloat(s.getAttribute('aria-valuenow') ?? s.value);
    let max = parseFloat(s.getAttribute('aria-valuemax') ?? s.max);
    if (!isFinite(v) || !isFinite(max) || max <= 0) return null;
    if (max === 100) {
      // Percentage slider: take the time from its text if it has one.
      const t = parseClock(s.getAttribute('aria-valuetext'));
      if (t == null || !video || !isFinite(video.duration)) return null;
      return { pos: t, dur: video.duration };
    }
    const scale = max > 100000 ? 1000 : 1; // milliseconds → seconds
    return { pos: v / scale, dur: max / scale };
  }

  let lastWake = 0;
  setInterval(() => {
    if (SERVICE !== 'disney' || !video) return;
    const s = findDisneySlider();
    const r = s && readSliderEl(s);
    if (!r) {
      // Progress bar not found yet (hidden controls, covered window): use the
      // video's own clock for now; it's correct until the first jump, and the
      // bar replaces it as soon as it shows up.
      if (!disney.ready && now() - boundAt > 6000) {
        disney.ready = true;
        disney.offset = 0;
        console.info('[WatchParty] Disney+ progress bar not found yet; using the video clock for now');
      }
      if (!disney.ready && now() - lastWake > 2500) {
        lastWake = now();
        const rect = video.getBoundingClientRect();
        pointer(video, 'mousemove', rect.left + rect.width / 2, rect.top + rect.height / 2, 0);
      }
      return;
    }
    disney.dur = r.dur;
    if (r.pos !== disney.lastVal) {
      disney.lastVal = r.pos;
      disney.offset = r.pos - video.currentTime;
      disney.ready = true;
    }
  }, 200);

  function position() {
    if (!video) return 0;
    if (SERVICE === 'disney' && disney.ready) return video.currentTime + disney.offset;
    return video.currentTime;
  }

  function duration() {
    if (SERVICE === 'disney' && disney.dur) return disney.dur;
    return video && isFinite(video.duration) ? video.duration : 0;
  }

  // ── What's playing ───────────────────────────────────────────
  function readTitle() {
    let t = '';
    try {
      if (SERVICE === 'netflix') {
        const el = document.querySelector('[data-uia="video-title"]');
        if (el) {
          const parts = Array.from(el.querySelectorAll('h4, span')).map((e) => e.textContent.trim()).filter(Boolean);
          t = parts.length ? parts.join(' – ') : el.textContent.trim();
        }
      } else if (SERVICE === 'prime') {
        const a = document.querySelector('.atvwebplayersdk-title-text');
        const b = document.querySelector('.atvwebplayersdk-subtitle-text');
        t = [a && a.textContent, b && b.textContent].filter(Boolean).join(' – ');
      }
    } catch {}
    if (!t) {
      t = document.title.replace(/\s*[|\-–]\s*(Netflix|Disney\+|Prime Video|Amazon\.[\w.]+.*)\s*$/i, '').trim();
      if (/^(netflix|disney\+|prime video|amazon\.[\w.]+)$/i.test(t)) t = '';
    }
    return t.slice(0, 140);
  }

  function title(mediaId) {
    const t = readTitle();
    if (t && mediaId) titleCache[mediaId] = t;
    return (mediaId && titleCache[mediaId]) || t;
  }

  // Prime Video: each country has its own catalogue and its own codes for the
  // same episode, so the address can't be compared across countries. The
  // series name plus season and episode can.
  let primeIdCache = null;
  let primeCandidate = null;
  function primeId() {
    if (SERVICE !== 'prime' || !video) return null;
    if (primeIdCache) return primeIdCache;
    const a = document.querySelector('.atvwebplayersdk-title-text');
    const b = document.querySelector('.atvwebplayersdk-subtitle-text');
    const series = a && a.textContent.trim();
    if (!series) return null;
    const slug = series.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const m = b && b.textContent.match(/(\d+)\D{1,15}?(\d+)/);
    primeIdCache = `prime:t:${slug}${m ? `:s${m[1]}e${m[2]}` : ''}`;
    return primeIdCache;
  }

  // Things about a Prime episode that don't depend on the site's language:
  // season, episode and total running time (as the player shows it).
  let primeDur = 0;
  function primeInfo() {
    if (SERVICE !== 'prime' || !video) return null;
    const b = document.querySelector('.atvwebplayersdk-subtitle-text');
    const m = b && b.textContent.match(/(\d+)\D{1,15}?(\d+)/);
    const t = document.querySelector('.atvwebplayersdk-timeindicator-text');
    if (t) {
      const parts = t.textContent.split('/');
      const total = parts[1] ? parseClock(parts[1]) : null;
      if (total) primeDur = total;
    }
    if (!primeDur && isFinite(video.duration) && video.duration > 60) primeDur = Math.round(video.duration);
    return { s: m ? +m[1] : null, e: m ? +m[2] : null, dur: primeDur };
  }

  function snapshot() {
    const v = video;
    const mediaId = (SERVICE === 'prime' && primeId()) || M.mediaIdFromUrl(location.href);
    return {
      hasVideo: !!v,
      position: position(),
      duration: duration(),
      paused: v ? v.paused : true,
      buffering: bufferingReported,
      settling: now() < settlingUntil || (SERVICE === 'disney' && !!v && !disney.ready),
      mediaId,
      url: location.href,
      service: SERVICE,
      title: title(mediaId),
      prime: primeInfo()
    };
  }

  // ── User actions → panel ─────────────────────────────────────
  function onPlay() {
    if (suppressed()) return;
    knownPaused = false;
    send({ type: 'local', action: 'play', ...snapshot() });
  }

  function onPause() {
    endNudge();
    if (suppressed() || (video && video.ended)) return;
    // Nobody can click pause on a hidden page: this is the site or the browser
    // pausing on its own (for example when another window covers this one).
    // Don't pass it on to the friend; try to keep playing instead.
    if (document.hidden) {
      pausedWhileHidden = true;
      setTimeout(() => { if (video && video.paused && document.hidden) doPlay(); }, 300);
      return;
    }
    knownPaused = true;
    send({ type: 'local', action: 'pause', ...snapshot() });
  }

  // Back on this page after the site paused itself: catch up with the room.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !pausedWhileHidden) return;
    pausedWhileHidden = false;
    send({ type: 'resume-request', ...snapshot() });
  });

  // A play/pause that happened while events were being ignored (for
  // example the site's autoplay right after a new video loads) is
  // reported once things settle, so the room doesn't stay out of date.
  function catchUpState() {
    if (!video || !readySent || suppressed() || bufferingReported || video.ended || document.hidden) return;
    if (knownPaused === null) { knownPaused = video.paused; return; }
    if (video.paused === knownPaused) return;
    knownPaused = video.paused;
    send({ type: 'local', action: video.paused ? 'pause' : 'play', ...snapshot() });
  }

  function onSeeked() {
    lastSeekAt = now();
    if (suppressed()) return;
    if (SERVICE === 'disney') {
      // Wait for Disney's progress bar to catch up before reporting where we landed.
      settle(1500);
      disney.lastVal = null;
      setTimeout(() => send({ type: 'local', action: 'seek', ...snapshot(), settling: false }), 1200);
    } else {
      send({ type: 'local', action: 'seek', ...snapshot() });
    }
  }

  function onWaiting() {
    // A hidden page stops drawing its video, which can look like buffering. It isn't.
    if (document.hidden || suppressed() || now() - lastSeekAt < 1500 || bufferTimer) return;
    bufferTimer = setTimeout(() => {
      bufferTimer = null;
      if (video && video.readyState < 3 && !video.paused && !document.hidden) {
        bufferingReported = true;
        send({ type: 'buffering', on: true, ...snapshot() });
      }
    }, 2000);
  }

  function onPlaying() {
    if (bufferTimer) { clearTimeout(bufferTimer); bufferTimer = null; }
    if (bufferingReported) {
      bufferingReported = false;
      send({ type: 'buffering', on: false, ...snapshot() });
    }
  }

  // ── Player control (per service) ─────────────────────────────
  function netflix(op, extra) { window.postMessage({ __wpNetflix: 'cmd', op, ...extra }, '*'); }

  function inBuffered(t) {
    const b = video.buffered;
    for (let i = 0; i < b.length; i++) if (t >= b.start(i) + 0.2 && t <= b.end(i) - 0.5) return true;
    return false;
  }

  function pointer(el, type, x, y, buttons) {
    const o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, o) : new MouseEvent(type, o));
  }

  function disneySeek(t) {
    settle(2500);
    disney.lastVal = null;
    const vt = t - disney.offset;
    // Small jumps inside what's already loaded can use the video clock directly.
    if (disney.ready && inBuffered(vt)) { video.currentTime = vt; return; }
    // Bigger jumps: click Disney's own progress bar. The panel fine-tunes afterwards.
    const s = findDisneySlider();
    if (!s || !disney.dur) { console.warn('[WatchParty] Disney+ progress bar not found; seek skipped'); return; }
    suppress(4000);
    settle(4000);
    pointer(video, 'mousemove', 10, 10, 0); // wake up the player controls
    setTimeout(() => {
      const r = s.getBoundingClientRect();
      if (!r.width) { console.warn('[WatchParty] Disney+ progress bar is hidden; seek skipped'); return; }
      const frac = Math.min(Math.max(t / disney.dur, 0), 1);
      const x = r.left + r.width * frac, y = r.top + r.height / 2;
      pointer(s, 'pointerdown', x, y, 1);
      pointer(s, 'mousedown', x, y, 1);
      pointer(s, 'pointerup', x, y, 0);
      pointer(s, 'mouseup', x, y, 0);
      pointer(s, 'click', x, y, 0);
    }, 350);
  }

  function doSeek(t) {
    lastSeekAt = now();
    if (SERVICE === 'netflix') netflix('seek', { time: t });
    else if (SERVICE === 'disney') disneySeek(t);
    else if (video) video.currentTime = t;
  }

  function doPlay() {
    if (SERVICE === 'netflix') netflix('play');
    else if (video) video.play().catch(() => {});
  }

  function doPause() {
    if (SERVICE === 'netflix') netflix('pause');
    else if (video) video.pause();
  }

  function setVolume(v) {
    if (!video) return;
    if (SERVICE === 'netflix') netflix('volume', { value: v });
    video.volume = Math.max(0, Math.min(1, v));
  }

  // Small differences are fixed by playing a little faster (or slower) until
  // caught up, which avoids the short stall a jump causes. Pitch is kept.
  let nudgeTimer = null;
  function endNudge() {
    clearTimeout(nudgeTimer);
    nudgeTimer = null;
    if (video && video.playbackRate !== 1) video.playbackRate = 1;
  }
  function nudge(delta) {
    if (!video || video.paused) return;
    const rate = delta > 0 ? 1.08 : 0.92;
    const ms = Math.min(40000, (Math.abs(delta) / 0.08) * 1000);
    try { video.preservesPitch = true; } catch {}
    video.playbackRate = rate;
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(endNudge, ms);
  }

  function apply(m) {
    if (!video) return;
    endNudge();
    suppress(1500);
    let target = m.position + (m.state === 'playing' ? (now() - m.sentAt) / 1000 : 0);
    const dur = duration();
    if (dur) target = Math.min(target, dur - 0.5);
    target = Math.max(0, target);
    if (Math.abs(position() - target) > (m.tolerance ?? 0.5)) doSeek(target);
    if (m.state === 'playing' && video.paused) doPlay();
    else if (m.state === 'paused' && !video.paused) doPause();
    knownPaused = m.state === 'paused';
  }

  function setDuck(on) {
    if (!video) return;
    if (on && !duck.on) {
      duck = { on: true, saved: video.volume };
      setVolume(duck.saved * 0.25);
    } else if (!on && duck.on) {
      duck.on = false;
      setVolume(duck.saved);
    }
  }

  // ── Overlay (reactions, countdown, toasts, banner, companion) ─
  // Lives in its own shadow root so it works inside any site's fullscreen
  // container and the site's styles can't touch it.
  const OVERLAY_CSS = `
    :host { all: initial; }
    #ov { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #F3EDE4; }
    [hidden] { display: none !important; }
    .float { position: absolute; bottom: 18%; display: flex; flex-direction: column; align-items: center;
      animation: rise 3.1s ease-out forwards; }
    .float .e { font-size: 52px; line-height: 1; filter: drop-shadow(0 3px 6px rgba(0,0,0,.45)); }
    .float .n { margin-top: 4px; font-size: 12px; padding: 2px 8px; border-radius: 999px; background: rgba(42,31,61,.75); }
    @keyframes rise { 0% { transform: translateY(0) scale(.6); opacity: 0; }
      12% { transform: translateY(-20px) scale(1.1); opacity: 1; }
      100% { transform: translateY(-46vh) scale(1); opacity: 0; } }
    .toasts { position: absolute; top: 24px; left: 24px; display: flex; flex-direction: column; gap: 8px; max-width: 340px; }
    .toast { background: rgba(42,31,61,.92); border-left: 3px solid #E8728C; border-radius: 10px; padding: 10px 14px;
      font-size: 15px; line-height: 1.35; box-shadow: 0 8px 24px rgba(0,0,0,.35); transition: opacity .4s, transform .4s; }
    .toast strong { display: block; font-size: 12px; color: #F6D57A; margin-bottom: 2px; }
    .toast.out { opacity: 0; transform: translateX(-12px); }
    .banner { position: absolute; top: 24px; left: 50%; transform: translateX(-50%);
      background: rgba(42,31,61,.92); padding: 10px 18px; border-radius: 999px; font-size: 15px; }
    .count { position: absolute; inset: 0; display: grid; place-items: center; font-size: 160px; font-weight: 700;
      color: #F6D57A; text-shadow: 0 6px 30px rgba(0,0,0,.6); background: rgba(20,14,30,.35); }
    .count.go { color: #E8728C; }
    .cbox { position: absolute; pointer-events: auto; border-radius: 16px; box-shadow: 0 12px 36px rgba(0,0,0,.45); }
    .cbox iframe { display: block; width: 100%; height: 100%; border: 0; border-radius: 16px;
      background: transparent; color-scheme: normal; }
    .grip { position: absolute; width: 18px; height: 18px; z-index: 2; }
    .grip::after { content: ""; position: absolute; inset: 4px; border-radius: 3px; background: rgba(246,213,122,.85); opacity: 0; transition: opacity .15s; }
    .cbox:hover .grip::after, .grip:hover::after { opacity: 1; }
    .grip.nw { left: -7px; top: -7px; cursor: nwse-resize; }
    .grip.ne { right: -7px; top: -7px; cursor: nesw-resize; }
    .grip.sw { left: -7px; bottom: -7px; cursor: nesw-resize; }
    .grip.se { right: -7px; bottom: -7px; cursor: nwse-resize; }
    .cap { position: absolute; inset: 0; pointer-events: auto; }
    @media (prefers-reduced-motion: reduce) { .float { animation-duration: 2s; } .toast { transition: none; } }
  `;

  let host = null, ov = null;

  function ensureOverlay() {
    if (!host) {
      host = document.createElement('div');
      host.id = 'watchparty-overlay';
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${OVERLAY_CSS}</style>
        <div id="ov">
          <div class="toasts"></div>
          <div class="banner" hidden></div>
          <div class="count" hidden></div>
        </div>`;
      ov = root.getElementById('ov');
    }
    placeOverlay();
    return ov;
  }

  // The overlay lives in the browser's top layer (the same layer fullscreen
  // uses), so it stays visible over the video in fullscreen. It's brought back
  // to the front whenever fullscreen starts. Older browsers: it moves inside
  // the fullscreen element instead.
  const TOP_LAYER = typeof HTMLElement !== 'undefined' && 'popover' in HTMLElement.prototype;
  let lastFs = null;

  function placeOverlay() {
    if (!host) return;
    const fs = document.fullscreenElement;
    if (TOP_LAYER) {
      if (!host.hasAttribute('popover')) {
        host.setAttribute('popover', 'manual');
        host.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;' +
          'margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;z-index:2147483647;';
      }
      if (host.parentNode !== document.documentElement) document.documentElement.appendChild(host);
      const open = host.matches(':popover-open');
      if (open && fs !== lastFs) { try { host.hidePopover(); } catch {} }
      if (!host.matches(':popover-open')) { try { host.showPopover(); } catch {} }
      lastFs = fs;
      return;
    }
    let parent = document.body || document.documentElement;
    if (fs && fs.tagName !== 'VIDEO') parent = fs.shadowRoot || fs;
    if (host.parentNode !== parent) parent.appendChild(host);
  }

  // The companion: the call window on top of the video, shown whenever the
  // side panel isn't open (and always in fullscreen). It can be dragged by
  // its top bar and resized from any corner; size and place are remembered.
  let cbox = null, frame = null, cap = null;
  let geom = { x: null, y: null, w: 320, h: 520 };
  let frameState = { base: 300, chatOpen: false, minimized: false };
  chrome.storage.local.get('companionGeom').then((r) => { if (r.companionGeom) geom = { ...geom, ...r.companionGeom }; layout(); }).catch(() => {});

  // Browser-window fullscreen (F11, or the sidebar's Fullscreen button) also
  // counts: the sidebar can be hidden then even if it didn't close (Edge).
  const windowFullscreen = () => {
    try { if (matchMedia('(display-mode: fullscreen)').matches) return true; } catch {}
    return Math.abs(window.innerWidth - screen.width) < 3 && Math.abs(window.innerHeight - screen.height) < 3;
  };
  const wanted = () => !!(session.active && video && (document.fullscreenElement || windowFullscreen() || !session.panelOpen));

  function renderCompanion() {
    const want = wanted();
    if (want === !!cbox) { layout(); return; }
    if (!want) { cbox.remove(); cbox = frame = null; return; }
    const o = ensureOverlay();
    cbox = document.createElement('div');
    cbox.className = 'cbox';
    frame = document.createElement('iframe');
    frame.allow = 'autoplay; picture-in-picture';
    frame.src = chrome.runtime.getURL('panel/companion.html');
    cbox.appendChild(frame);
    for (const corner of ['nw', 'ne', 'sw', 'se']) {
      const g = document.createElement('div');
      g.className = `grip ${corner}`;
      g.title = 'Drag to resize';
      g.addEventListener('pointerdown', (e) => { e.preventDefault(); startGesture(corner, e.screenX, e.screenY); });
      cbox.appendChild(g);
    }
    o.appendChild(cbox);
    layout();
  }

  function heightNow() {
    const base = Math.max(44, frameState.base || 0); // never smaller than the top bar
    if (frameState.minimized || !frameState.chatOpen) return base;
    return Math.max(geom.h, base + 160);
  }

  // Keep the window inside the visible area.
  function layout() {
    if (!cbox) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    geom.w = Math.max(240, Math.min(geom.w, Math.min(900, vw - 20)));
    const h = Math.min(heightNow(), vh - 20);
    if (geom.x == null) { geom.x = vw - geom.w - 16; geom.y = 16; }
    geom.x = Math.max(0, Math.min(geom.x, vw - geom.w));
    geom.y = Math.max(0, Math.min(geom.y, vh - h));
    Object.assign(cbox.style, { left: `${geom.x}px`, top: `${geom.y}px`, width: `${geom.w}px`, height: `${h}px` });
  }
  window.addEventListener('resize', () => { renderCompanion(); layout(); });

  // Dragging (from the window's top bar) and resizing (from a corner).
  // A transparent layer catches the mouse while the gesture lasts, even
  // when it passes over the call window or the video.
  function startGesture(kind, sx, sy) {
    if (!cbox || cap) return;
    const start = { ...geom, h: heightNow(), sx, sy };
    cap = document.createElement('div');
    cap.className = 'cap';
    cap.style.cursor = kind === 'move' ? 'grabbing' : getComputedStyle(cbox.querySelector(`.grip.${kind}`) || cbox).cursor;
    ensureOverlay().appendChild(cap);
    const move = (e) => {
      const dx = e.screenX - start.sx, dy = e.screenY - start.sy;
      if (kind === 'move') { geom.x = start.x + dx; geom.y = start.y + dy; }
      else {
        const left = kind.includes('w'), top = kind.includes('n');
        const w = Math.max(240, start.w + (left ? -dx : dx));
        if (left) geom.x = start.x + (start.w - w);
        geom.w = w;
        if (frameState.chatOpen && !frameState.minimized) {
          const h = Math.max(frameState.base + 160, start.h + (top ? -dy : dy));
          if (top) geom.y = start.y + (start.h - h);
          geom.h = h;
        }
      }
      layout();
    };
    const end = () => {
      cap.removeEventListener('pointermove', move);
      cap.remove();
      cap = null;
      chrome.storage.local.set({ companionGeom: geom }).catch(() => {});
    };
    cap.addEventListener('pointermove', move);
    cap.addEventListener('pointerup', end, { once: true });
    cap.addEventListener('pointercancel', end, { once: true });
  }

  window.addEventListener('message', (e) => {
    if (!frame || e.source !== frame.contentWindow || !e.data || !e.data.__wpCompanion) return;
    const d = e.data;
    if (d.__wpCompanion === 'size') {
      if (!(d.base > 0)) return;
      frameState = { base: d.base, chatOpen: !!d.chatOpen, minimized: !!d.minimized };
      layout();
    } else if (d.__wpCompanion === 'drag') {
      startGesture('move', d.sx, d.sy);
    } else if (d.__wpCompanion === 'exit-fullscreen') {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    }
  });

  document.addEventListener('fullscreenchange', () => {
    placeOverlay();
    const on = !!document.fullscreenElement;
    send({ type: 'fullscreen', on });
    renderCompanion();
    // Try to bring the side panel back. The browser may refuse without a
    // click; the call window stays on the video either way.
    if (!on && session.active && !session.panelOpen) {
      try { chrome.runtime.sendMessage({ to: 'bg', type: 'open-panel' }).catch(() => {}); } catch {}
    }
  });

  function floatReaction(emoji, name) {
    const o = ensureOverlay();
    const f = document.createElement('div');
    f.className = 'float';
    f.style.left = `${8 + Math.random() * 74}%`;
    const e = document.createElement('span');
    e.className = 'e';
    e.textContent = emoji;
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = name || '';
    f.append(e, n);
    o.appendChild(f);
    setTimeout(() => f.remove(), 3200);
  }

  function toast(m) {
    if (!settings.toasts) return;
    const list = ensureOverlay().querySelector('.toasts');
    const t = document.createElement('div');
    t.className = 'toast';
    const n = document.createElement('strong');
    n.textContent = m.name;
    const body = document.createElement('span');
    body.textContent = m.text;
    t.append(n, body);
    list.appendChild(t);
    while (list.children.length > 3) list.firstChild.remove();
    setTimeout(() => t.classList.add('out'), 5500);
    setTimeout(() => t.remove(), 6000);
  }

  function banner(text) {
    if (!text && !host) return;
    const b = ensureOverlay().querySelector('.banner');
    b.textContent = text || '';
    b.hidden = !text;
  }

  let countTimer = null;
  function countdown(m) {
    knownPaused = false;
    if (video) {
      suppress(m.delay + 4000);
      doPause();
      doSeek(m.position);
    }
    const start = now() + m.delay;
    const c = ensureOverlay().querySelector('.count');
    c.hidden = false;
    clearInterval(countTimer);
    const draw = () => {
      const left = start - now();
      const n = Math.ceil(left / 1000);
      c.textContent = left <= 0 ? 'Go' : (n > 3 ? 'Get comfy…' : String(n));
      c.classList.toggle('go', left <= 0);
    };
    draw();
    countTimer = setInterval(draw, 100);
    setTimeout(() => {
      doPlay();
      draw();
      setTimeout(() => { clearInterval(countTimer); c.hidden = true; }, 800);
    }, Math.max(0, m.delay));
  }

  // ── Commands from the engine ─────────────────────────────────
  function onCommand(m) {
    if (!m || !m.cmd) return;
    switch (m.cmd) {
      case 'apply': apply(m); break;
      case 'countdown': countdown(m); break;
      case 'reaction': floatReaction(m.emoji, m.name); break;
      case 'toast': toast(m); break;
      case 'banner': banner(m.text); break;
      case 'duck': setDuck(!!m.on); break;
      case 'nudge': nudge(m.delta); break;
      case 'settings': Object.assign(settings, m.settings || {}); break;
      case 'session': session = m; renderCompanion(); break;
    }
  }

  // ── Main loop ────────────────────────────────────────────────
  setInterval(() => {
    if (video && !video.isConnected) { unbind(video); video = null; }
    const v = pickVideo();
    if (v && v !== video) { bind(v); disney.ready = false; disney.lastVal = null; }
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      readySent = false;
      knownPaused = null;
      primeIdCache = null;
      primeDur = 0;
      boundAt = now();
      suppress(2500);
      disney.ready = false;
      disney.lastVal = null;
    }
    // Prime can play the next episode in the same player. Count it as a new
    // episode only when the new one is read the same way 3 times in a row,
    // and never because the episode text disappeared with the player controls.
    if (SERVICE === 'prime' && primeIdCache && readySent) {
      const prev = primeIdCache;
      primeIdCache = null;
      const next = primeId();
      primeIdCache = prev;
      const prevHasEp = /:s\d+e\d+$/.test(prev);
      const nextHasEp = next && /:s\d+e\d+$/.test(next);
      if (next && next !== prev && (nextHasEp || !prevHasEp)) {
        primeCandidate = primeCandidate && primeCandidate.id === next ? { id: next, n: primeCandidate.n + 1 } : { id: next, n: 1 };
        if (primeCandidate.n >= 3) { primeIdCache = null; primeDur = 0; primeCandidate = null; readySent = false; boundAt = now(); }
      } else primeCandidate = null;
    }
    const waitDisney = SERVICE === 'disney' && !disney.ready && now() - boundAt < 8000;
    const waitPrime = SERVICE === 'prime' && !primeId() && now() - boundAt < 6000;
    if (video && !readySent && !waitDisney && !waitPrime && video.readyState >= 1 && now() - boundAt > 1200) {
      readySent = true;
      knownPaused = video.paused;
      send({ type: 'ready', ...snapshot() });
    }
    catchUpState();
    sendStatus();
    renderCompanion();
    placeOverlay();
  }, 1000);

  connect();
})();
