// The streaming tabs: what they report, and what we send them.
import * as FB from '../vendor/firebase.js';
import { E, M, broadcastViews, changed, friendName, noop, panels, ref, safePost } from './core.js';

// ── Streaming tabs ─────────────────────────────────────────────
export function sendWatch(msg) {
  const info = E.contents.get(E.local.watchTabId);
  if (info) safePost(info.port, msg);
}

export let lastSession = '';
export function pushSession(force) {
  const c = E.call;
  const session = {
    cmd: 'session', active: !!(c && c.status === 'active'),
    partnerName: c ? friendName(c.partnerUid) : '', panelOpen: panels().length > 0
  };
  const key = JSON.stringify(session);
  if (key === lastSession && !force) return;
  lastSession = key;
  for (const info of E.contents.values()) safePost(info.port, session);
}

export function pushSettings() {
  for (const info of E.contents.values()) safePost(info.port, { cmd: 'settings', settings: E.settings });
}

export function setLocal(st) {
  E.local.snap = st;
  E.local.at = Date.now();
  publishWatching(false);
  changed();
}

// Lets friends see what you're watching (and powers the sync status).
export function publishWatching(force) {
  if (!E.me) return;
  const st = E.local.snap;
  if (st && st.settling) return;
  const w = st && st.mediaId && st.hasVideo ? {
    mediaId: st.mediaId, title: st.title || '', url: st.url, service: st.service,
    position: st.position, paused: st.paused, at: FB.serverTimestamp()
  } : null;
  // No video open: still say which streaming site I'm on ("Disney+ home page").
  const page = !w && st && st.service ? { service: st.service, title: st.title || '' } : null;
  const key = w ? `${w.mediaId}|${w.paused}|${w.title}` : page ? `page|${page.service}|${page.title}` : '';
  if (!force && key === E.local.published && Date.now() - E.local.publishedAt < 5000) return;
  if (!force && !key && !E.local.published) return;
  E.local.published = key;
  E.local.publishedAt = Date.now();
  FB.update(ref(`status/${E.me.uid}`), { watching: w, page }).catch(noop);
}

export function onContentPort(port) {
  const tabId = port.sender && port.sender.tab && port.sender.tab.id;
  if (tabId == null) return;
  const info = { port, fullscreen: false };
  E.contents.set(tabId, info);
  port.onMessage.addListener((m) => onContentMessage(tabId, info, m));
  port.onDisconnect.addListener(() => {
    if (E.contents.get(tabId) !== info) return;
    E.contents.delete(tabId);
    if (E.local.watchTabId === tabId) {
      E.local.watchTabId = null;
      E.local.snap = null;
      publishWatching(true);
      if (E.sync) E.sync.onLocalGone();
    }
    if (E.local.streamTabId === tabId) E.local.streamTabId = null;
    changed();
  });
  safePost(port, { cmd: 'settings', settings: E.settings });
  pushSession(true);
}

// Which Prime Video site this browser uses (amazon.com in the US,
// primevideo.com in Ireland, …), so links from another country can be
// turned into a search on our own site.
export let primeOrigin = (() => { try { return localStorage.getItem('wpPrimeOrigin'); } catch { return null; } })();
export function notePrimeOrigin(url) {
  try {
    const u = new URL(url);
    if (M.serviceFromUrl(url) !== 'prime' || u.origin === primeOrigin) return;
    primeOrigin = u.origin;
    localStorage.setItem('wpPrimeOrigin', primeOrigin);
  } catch {}
}

export function onContentMessage(tabId, info, m) {
  if (!m || !E.me) return;
  if (m.url) notePrimeOrigin(m.url);
  const L = E.local;
  switch (m.type) {
    case 'hello':
      L.streamTabId = tabId;
      break;
    case 'status': {
      info.snap = m;
      info.at = Date.now();
      // A tab with a video takes over from a watch tab that has none (or went quiet).
      const cur = E.contents.get(L.watchTabId);
      const curHasVideo = !!(cur && cur.snap && cur.snap.hasVideo); // background tabs report rarely: no time limit
      if (m.hasVideo && tabId !== L.watchTabId && !curHasVideo) L.watchTabId = tabId;
      if (L.watchTabId == null && m.hasVideo) L.watchTabId = tabId;
      if (L.streamTabId == null) L.streamTabId = tabId;
      if (tabId !== L.watchTabId) { changed(); return; }
      setLocal(m);
      if (E.sync) E.sync.onStatus(m);
      break;
    }
    case 'ready':
      L.watchTabId = tabId;
      L.streamTabId = tabId;
      setLocal(m);
      if (E.sync) E.sync.onReady(m);
      break;
    case 'local':
      L.watchTabId = tabId;
      setLocal({ ...(L.snap || {}), ...m });
      if (E.sync) E.sync.onLocal(m);
      break;
    case 'buffering':
      if (tabId === L.watchTabId && E.sync) E.sync.onBuffering(m);
      break;
    case 'resume-request':
      if (tabId === L.watchTabId) { setLocal(m); if (E.sync) E.sync.reapply(); }
      break;
    case 'fullscreen':
      info.fullscreen = !!m.on;
      if (m.on && E.settings.closePanelInFullscreen) broadcastViews({ type: 'close-panel' });
      break;
  }
}
