// Shared state and helpers for the engine modules.
import * as FB from '../vendor/firebase.js';
import { createLinks } from './links.js';
import { updateBadge } from './notify.js';
import { pushSession } from './tabs.js';
import { publicState } from './views.js';

export const M = globalThis.WPMedia;
export let VERSION = '';
// The engine can't call chrome.runtime.getManifest(), so read the file instead.
fetch('../manifest.json').then((r) => r.json()).then((m) => { VERSION = m.version; changed(); }).catch(() => {});
export const EMAIL_DOMAIN = 'users.watchparty.example';
export const RING_MS = 45000;
export const AWAY_MS = 25000;
export const HIDDEN_WARN_MS = 3000;   // nothing on screen for this long: warn
export const HIDDEN_END_MS = 20000;   // …and for this long: end the call (privacy)
export const DEFAULT_SETTINGS = {
  follow: true, duck: true, toasts: true, closePanelInFullscreen: true, ringtone: true, notifyMessages: true
};

export const E = {
  phase: 'loading', authError: '', serverOffset: 0, startedAt: Date.now(),
  db: null, auth: null, me: null, settings: { ...DEFAULT_SETTINGS }, 
  friends: {}, status: {}, requestsIn: {}, requestsOut: {},
  pairCalls: {}, pairLast: {}, pairSeen: {},
  selected: null, view: null,
  call: null, incoming: null, lastCallEnd: null, declined: new Set(),
  media: { stream: null, error: '' },
  local: { snap: null, at: 0, watchTabId: null, streamTabId: null, publishedAt: 0, published: '' },
  views: new Map(),     // port → { kind, visible, chatOpen }
  contents: new Map(),  // tabId → { port, fullscreen }
  unsubs: [], friendUnsubs: {}, sync: null
};

export const links = createLinks();
export const audioEl = document.getElementById('remote-audio');
export const serverNow = () => Date.now() + E.serverOffset;
export const ref = (p) => FB.ref(E.db, p);
export const pairRef = (pairId) => (p) => FB.ref(E.db, `pairs/${pairId}/${p}`);
export const bg = (msg) => chrome.runtime.sendMessage({ to: 'bg', ...msg }).catch(() => {});
export const safePost = (port, msg) => { try { port.postMessage(msg); } catch {} };
export const rid = () => crypto.randomUUID().slice(0, 8);
export const noop = () => {};

// config.js holds your Firebase settings and is kept out of the published
// package. Loaded on demand, so a missing file shows the setup screen
// instead of stopping the engine.
let configPromise = null;
export function loadConfig() {
  configPromise = configPromise || import('../config.js').then((m) => m.default || {}).catch(() => ({}));
  return configPromise;
}

// Recent events, shown (and copyable) in Settings → Diagnostics.
export const logBook = [];
export function log(text) {
  const t = new Date();
  logBook.push(`${t.toLocaleTimeString([], { hour12: false })} ${text}`);
  if (logBook.length > 60) logBook.shift();
}

export const myName = () => (E.me && E.me.name) || 'Me';
// Online = at least one of their WatchParty sessions is connected right now.
export const isOnline = (st) => !!(st && st.conns && Object.keys(st.conns).length);
export const connKey = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
export function friendName(uid) {
  const st = E.status[uid], f = E.friends[uid];
  return (f && f.username) || (st && st.username) || 'Your friend';
}
export const partnerOf = (pairId) => pairId.split('_').find((u) => u !== E.me.uid);
export const panels = () => [...E.views.entries()].filter(([, v]) => v.kind === 'panel');
export const companions = () => [...E.views.entries()].filter(([, v]) => v.kind === 'companion');

// ── Broadcasting state to the screens ──────────────────────────
export let stateTimer = null;
export function changed() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    const st = publicState();
    for (const port of E.views.keys()) safePost(port, { type: 'state', state: st });
    updateBadge();
    pushSession();
  }, 60);
}

export function broadcastViews(msg) { for (const port of E.views.keys()) safePost(port, msg); }
