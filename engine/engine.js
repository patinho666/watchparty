// WatchParty engine: an invisible page that runs for as long as the browser
// is open. It holds the Firebase connection, friends, calls, chat and sync.
// The side panel and the fullscreen companion are just screens onto it.
import * as FB from '../vendor/firebase.js';
import CONFIG from '../config.js';
import { createConnection } from './call.js';
import { createSync } from './sync.js';
import { createLinks } from './links.js';

const M = globalThis.WPMedia;
let VERSION = '';
// The engine can't call chrome.runtime.getManifest(), so read the file instead.
fetch('../manifest.json').then((r) => r.json()).then((m) => { VERSION = m.version; changed(); }).catch(() => {});
const EMAIL_DOMAIN = 'users.watchparty.example';
const RING_MS = 45000;
const AWAY_MS = 25000;
const HIDDEN_WARN_MS = 3000;   // nothing on screen for this long: warn
const HIDDEN_END_MS = 20000;   // …and for this long: end the call (privacy)
const DEFAULT_SETTINGS = {
  follow: true, duck: true, toasts: true, closePanelInFullscreen: true, ringtone: true, notifyMessages: true
};

const E = {
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

const links = createLinks();
const audioEl = document.getElementById('remote-audio');
const serverNow = () => Date.now() + E.serverOffset;
const ref = (p) => FB.ref(E.db, p);
const pairRef = (pairId) => (p) => FB.ref(E.db, `pairs/${pairId}/${p}`);
const bg = (msg) => chrome.runtime.sendMessage({ to: 'bg', ...msg }).catch(() => {});
const safePost = (port, msg) => { try { port.postMessage(msg); } catch {} };
const rid = () => crypto.randomUUID().slice(0, 8);
const noop = () => {};

const myName = () => (E.me && E.me.name) || 'Me';
// Online = at least one of their WatchParty sessions is connected right now.
const isOnline = (st) => !!(st && st.conns && Object.keys(st.conns).length);
const connKey = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
function friendName(uid) {
  const st = E.status[uid], f = E.friends[uid];
  return (f && f.username) || (st && st.username) || 'Your friend';
}
const partnerOf = (pairId) => pairId.split('_').find((u) => u !== E.me.uid);
const panels = () => [...E.views.entries()].filter(([, v]) => v.kind === 'panel');
const companions = () => [...E.views.entries()].filter(([, v]) => v.kind === 'companion');

// ── Broadcasting state to the screens ──────────────────────────
let stateTimer = null;
function changed() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    const st = publicState();
    for (const port of E.views.keys()) safePost(port, { type: 'state', state: st });
    updateBadge();
    pushSession();
  }, 60);
}

function broadcastViews(msg) { for (const port of E.views.keys()) safePost(port, msg); }

function isUnread(pairId) {
  const last = E.pairLast[pairId];
  return !!(last && !last.system && last.by !== E.me.uid && (last.at || 0) > (E.pairSeen[pairId] || 0));
}

function publicState() {
  const me = E.me;
  const c = E.call;
  const v = E.view;
  const friends = me ? Object.entries(E.friends).map(([uid, f]) => {
    const st = E.status[uid] || {};
    const w = isOnline(st) && st.watching ? st.watching : null;
    return {
      uid, username: f.username, name: friendName(uid), pairId: f.pairId,
      online: isOnline(st), lastSeen: st.lastSeen || 0,
      watching: w ? { title: w.title || '', service: w.service || '' } : null,
      unread: isUnread(f.pairId), inCall: !!(c && c.pairId === f.pairId)
    };
  }).sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name)) : [];

  let call = null;
  if (c) {
    call = {
      pairId: c.pairId, partnerUid: c.partnerUid, partnerName: friendName(c.partnerUid),
      status: c.status, role: c.role, conn: c.conn ? c.conn.state : 'waiting',
      micOn: c.micOn, camOn: c.camOn, hasCam: c.hasCam,
      partnerMic: c.partnerMember ? c.partnerMember.mic !== false : true,
      partnerCam: c.partnerMember ? c.partnerMember.cam !== false : false,
      partnerAway: !!c.awaySince, hasRemote: !!c.remoteStream
    };
  }

  const snap = E.local.snap;
  return {
    version: VERSION, phase: E.phase, authError: E.authError, panelOpen: panels().length > 0,
    me: me && { uid: me.uid, username: me.username, name: me.name },
    settings: E.settings, friends,
    requestsIn: Object.entries(E.requestsIn).map(([uid, r]) => ({ uid, username: r.fromUsername, name: r.fromName, at: r.at })),
    requestsOut: Object.entries(E.requestsOut).map(([uid, r]) => ({ uid, username: r.toUsername, at: r.at })),
    incoming: E.incoming && { ...E.incoming, name: friendName(E.incoming.uid) },
    call,
    lastCallEnd: E.lastCallEnd && Date.now() - E.lastCallEnd.at < 6000 ? E.lastCallEnd.text : '',
    mediaError: E.media.error,
    selected: E.selected,
    view: v && {
      uid: v.uid, pairId: v.pairId,
      watchlist: Object.entries(v.watchlist).map(([key, it]) => ({ key, ...it })),
      history: Object.entries(v.history).map(([key, it]) => ({ key, ...it })),
      partnerTyping: !!(v.typing[v.uid] && serverNow() - v.typing[v.uid] < 4000),
      partnerSeen: v.seen[v.uid] || 0
    },
    tabs: (() => {
      let pages = 0, videos = 0;
      for (const t of E.contents.values()) {
        pages++;
        if (t.snap && t.snap.hasVideo) videos++;
      }
      return { pages, videos };
    })(),
    watch: {
      local: snap && snap.mediaId ? { title: snap.title, position: snap.position, paused: snap.paused, mediaId: snap.mediaId, service: snap.service, url: snap.url } : null,
      sync: E.sync ? E.sync.info() : null
    }
  };
}

// ── Badge and notifications ────────────────────────────────────
let badgeKey = '';
function updateBadge() {
  let text = '', color = '#E8728C';
  if (E.call && E.call.status === 'active') { text = 'LIVE'; color = '#D93A5B'; }
  else if (E.call) text = '…';
  else if (E.incoming) { text = 'CALL'; color = '#D93A5B'; }
  else if (E.me) {
    const n = Object.values(E.friends).filter((f) => isUnread(f.pairId)).length + Object.keys(E.requestsIn).length;
    text = n ? String(n) : '';
  }
  const key = text + color;
  if (key !== badgeKey) { badgeKey = key; bg({ type: 'badge', text, color }); }
}

const notify = (id, title, message, buttons = [], sticky = false) => bg({ type: 'notify', id, title, message, buttons, sticky });
const clearNotify = (id) => bg({ type: 'clear-notify', id });

let ring = null;
function startRing() {
  if (ring || !E.settings.ringtone) return;
  const ctx = new AudioContext();
  const beep = () => {
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    [0, 0.28].forEach((off, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + off;
      o.frequency.value = i ? 660 : 880;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.25);
    });
  };
  beep();
  ring = { ctx, timer: setInterval(beep, 2600) };
}

function stopRing() {
  if (!ring) return;
  clearInterval(ring.timer);
  ring.ctx.close().catch(() => {});
  ring = null;
}

// ── Firebase start-up and accounts ─────────────────────────────
function init() {
  const cfg = CONFIG.firebase || {};
  if (!cfg.apiKey || cfg.apiKey.startsWith('PASTE') || !cfg.databaseURL) { E.phase = 'setup'; changed(); return; }
  const app = FB.initializeApp(cfg);
  E.auth = FB.getAuth(app);
  E.db = FB.getDatabase(app);
  FB.onValue(ref('.info/serverTimeOffset'), (s) => { E.serverOffset = s.val() || 0; });
  FB.onAuthStateChanged(E.auth, (u) => {
    if (u) onSignedIn(u).catch((e) => { console.error(e); E.phase = 'signed-out'; E.authError = e.message; changed(); });
    else onSignedOut();
  });
}

const normUser = (u) => String(u || '').trim().toLowerCase().replace(/^@/, '');

function authMessage(e) {
  const code = e && e.code;
  if (code === 'auth/email-already-in-use') return 'That username is taken. Try signing in with it again.';
  if (code === 'auth/operation-not-allowed') return 'Turn on Email/Password sign-in in your Firebase project (see README).';
  if (code === 'auth/network-request-failed') return 'No connection. Check your internet and try again.';
  if (code === 'auth/too-many-requests') return 'Too many attempts. Wait a minute and try again.';
  return (e && e.message) || 'Something went wrong.';
}

// Username-only sign-in. Firebase needs a login with a secret, so the
// secret is derived from the username: knowing a username is enough to use it.
async function secretFor(username) {
  const data = new TextEncoder().encode(`watchparty:${CONFIG.firebase.projectId || ''}:${username}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function enter({ username }) {
  username = normUser(username);
  if (!/^[a-z0-9_]{3,20}$/.test(username)) throw new Error('Usernames are 3–20 characters: letters, numbers and _.');
  const email = `${username}@${EMAIL_DOMAIN}`;
  const secret = await secretFor(username);
  const exists = (await FB.get(ref(`usernames/${username}`))).exists();
  if (exists) {
    try { await FB.signInWithEmailAndPassword(E.auth, email, secret); return; }
    catch (e) {
      if (['auth/invalid-credential', 'auth/wrong-password'].includes(e.code)) {
        throw new Error(`${username} was created with a password in a test version. Delete it in Firebase (see README) or pick another username.`);
      }
      throw new Error(authMessage(e));
    }
  }
  try { await FB.createUserWithEmailAndPassword(E.auth, email, secret); }
  catch (e) { throw new Error(authMessage(e)); }
}

async function signOutUser() {
  if (E.call) await hangUp();
  if (E.me) {
    await FB.update(ref(`status/${E.me.uid}`), {
      [`conns/${connKey}`]: null, watching: null, lastSeen: FB.serverTimestamp()
    }).catch(noop);
  }
  await FB.signOut(E.auth);
}

async function onSignedIn(u) {
  cleanupSession();
  E.phase = 'loading';
  E.authError = '';
  changed();
  const uid = u.uid;
  let prof = (await FB.get(ref(`users/${uid}`))).val();
  if (!prof) {
    const username = (u.email || '').split('@')[0];
    prof = { username, name: username, createdAt: FB.serverTimestamp() };
    await FB.set(ref(`users/${uid}`), prof);
  }
  if (!(await FB.get(ref(`usernames/${prof.username}`))).exists()) {
    await FB.set(ref(`usernames/${prof.username}`), uid).catch(noop);
  }
  E.me = { uid, username: prof.username, name: prof.username };
  E.settings = { ...DEFAULT_SETTINGS, ...(prof.settings || {}) };
  E.phase = 'ready';
  subscribeUser();
  pushSettings();
  changed();
}

function onSignedOut() {
  cleanupSession();
  E.phase = E.phase === 'setup' ? 'setup' : 'signed-out';
  changed();
}

function cleanupSession() {
  if (E.call) endLocalCall('');
  E.unsubs.splice(0).forEach((u) => u());
  Object.values(E.friendUnsubs).forEach((list) => list.forEach((u) => u()));
  E.friendUnsubs = {};
  closeView();
  Object.assign(E, {
    me: null, friends: {}, status: {}, requestsIn: {}, requestsOut: {},
    pairCalls: {}, pairLast: {}, pairSeen: {}, selected: null, incoming: null
  });
  stopRing();
}

// ── Subscriptions for the signed-in user ───────────────────────
function subscribeUser() {
  const uid = E.me.uid;
  E.unsubs.push(FB.onValue(ref(`users/${uid}`), (s) => {
    const v = s.val() || {};
    E.settings = { ...DEFAULT_SETTINGS, ...(v.settings || {}) };
    pushSettings();
    changed();
  }, noop));

  E.unsubs.push(FB.onValue(ref('.info/connected'), (s) => {
    if (!s.val() || !E.me) return;
    // Each running session registers itself; it's removed by the server the
    // moment this session disconnects, without touching the other sessions.
    const st = ref(`status/${uid}`);
    FB.onDisconnect(st).update({ [`conns/${connKey}`]: null, watching: null, lastSeen: FB.serverTimestamp() });
    FB.update(st, { [`conns/${connKey}`]: true, online: null, name: myName(), username: E.me.username }).catch(noop);
    E.local.published = '';
    publishWatching(true);
    if (E.call && E.call.status !== 'ended') rejoinMember();
  }));

  E.unsubs.push(FB.onValue(ref(`friends/${uid}`), (s) => {
    E.friends = s.val() || {};
    syncFriendSubs();
    changed();
  }, noop));

  E.unsubs.push(FB.onValue(ref(`friendRequests/${uid}`), (s) => {
    const next = s.val() || {};
    for (const [from, r] of Object.entries(next)) {
      if (!E.requestsIn[from] && (r.at || 0) > serverNow() - 120000) {
        notify(`req:${from}`, 'Friend request', `${r.fromUsername} wants to watch with you.`, ['Accept', 'Decline'], true);
      }
    }
    for (const from of Object.keys(E.requestsIn)) if (!next[from]) clearNotify(`req:${from}`);
    E.requestsIn = next;
    changed();
  }, noop));

  E.unsubs.push(FB.onValue(ref(`sentRequests/${uid}`), (s) => { E.requestsOut = s.val() || {}; changed(); }, noop));
}

function syncFriendSubs() {
  for (const uid of Object.keys(E.friendUnsubs)) {
    if (E.friends[uid]) continue;
    E.friendUnsubs[uid].forEach((u) => u());
    delete E.friendUnsubs[uid];
    delete E.status[uid];
  }
  for (const [uid, f] of Object.entries(E.friends)) {
    if (E.friendUnsubs[uid]) continue;
    const P = pairRef(f.pairId);
    E.friendUnsubs[uid] = [
      FB.onValue(ref(`status/${uid}`), (s) => { E.status[uid] = s.val() || {}; changed(); }, noop),
      FB.onValue(P('call'), (s) => handleCallNode(f.pairId, s.val()), noop),
      FB.onValue(FB.query(P('messages'), FB.limitToLast(1)), (s) => {
        let last = null;
        s.forEach((c) => { last = c.val(); });
        onLastMessage(f.pairId, uid, last);
      }, noop),
      FB.onValue(P(`seen/${E.me.uid}`), (s) => { E.pairSeen[f.pairId] = s.val() || 0; changed(); }, noop)
    ];
  }
  if (E.selected && !E.friends[E.selected]) selectFriend(null);
  if (E.call && !E.friends[E.call.partnerUid]) endLocalCall('Call ended');
}

function onLastMessage(pairId, uid, last) {
  const prev = E.pairLast[pairId];
  E.pairLast[pairId] = last;
  changed();
  if (!last || last.system || last.by === E.me.uid) return;
  if (prev && prev.at === last.at) return;
  if ((last.at || 0) < E.startedAt + E.serverOffset - 2000) return; // old message

  const inCallWith = E.call && E.call.status === 'active' && E.call.pairId === pairId;
  const panelLooking = panels().some(([, v]) => v.visible) && E.view && E.view.pairId === pairId;
  const companionLooking = inCallWith && companions().some(([, v]) => v.chatOpen);
  if (panelLooking || companionLooking) return;
  if (inCallWith && companions().length) return; // the call window shows a preview itself

  if (inCallWith && E.local.watchTabId != null && E.settings.toasts) {
    sendWatch({ cmd: 'toast', name: friendName(uid), text: last.text, force: true });
    return;
  }
  if (E.settings.notifyMessages) notify(`msg:${pairId}`, friendName(uid), last.text);
}

// ── Friends ────────────────────────────────────────────────────
async function sendFriendRequest(username) {
  username = normUser(username);
  if (!username) throw new Error('Enter a username.');
  if (username === E.me.username) throw new Error('That\'s your own username.');
  const uid = (await FB.get(ref(`usernames/${username}`))).val();
  if (!uid) throw new Error(`No one is using the username ${username}.`);
  if (E.friends[uid]) throw new Error(`You and ${username} are already friends.`);
  if (E.requestsIn[uid]) return acceptFriend(uid); // they already asked you
  await FB.update(FB.ref(E.db), {
    [`friendRequests/${uid}/${E.me.uid}`]: { fromUsername: E.me.username, fromName: myName(), at: FB.serverTimestamp() },
    [`sentRequests/${E.me.uid}/${uid}`]: { toUsername: username, at: FB.serverTimestamp() }
  });
}

async function acceptFriend(uid) {
  const req = E.requestsIn[uid];
  if (!req) throw new Error('That request is no longer there.');
  const pairId = [E.me.uid, uid].sort().join('_');
  await FB.update(FB.ref(E.db), {
    [`friends/${E.me.uid}/${uid}`]: { pairId, username: req.fromUsername, name: req.fromName, since: FB.serverTimestamp() },
    [`friends/${uid}/${E.me.uid}`]: { pairId, username: E.me.username, name: myName(), since: FB.serverTimestamp() },
    [`friendRequests/${E.me.uid}/${uid}`]: null,
    [`sentRequests/${uid}/${E.me.uid}`]: null
  });
  clearNotify(`req:${uid}`);
}

async function declineFriend(uid) {
  await FB.update(FB.ref(E.db), { [`friendRequests/${E.me.uid}/${uid}`]: null, [`sentRequests/${uid}/${E.me.uid}`]: null });
  clearNotify(`req:${uid}`);
}

async function cancelRequest(uid) {
  await FB.update(FB.ref(E.db), { [`friendRequests/${uid}/${E.me.uid}`]: null, [`sentRequests/${E.me.uid}/${uid}`]: null });
}

async function unfriend(uid) {
  if (E.call && E.call.partnerUid === uid) await hangUp();
  await FB.update(FB.ref(E.db), { [`friends/${E.me.uid}/${uid}`]: null, [`friends/${uid}/${E.me.uid}`]: null });
}

// ── The friend shown in the panel ──────────────────────────────
function closeView() {
  if (!E.view) return;
  E.view.unsubs.forEach((u) => u());
  E.view = null;
}

function selectFriend(uid) {
  if (E.call) uid = E.call.partnerUid; // during a call, the call partner is always shown
  if (uid && !E.friends[uid]) uid = null;
  if (E.selected === uid && (E.view || !uid)) { changed(); return; }
  closeView();
  E.selected = uid;
  if (!uid) { changed(); return; }
  const pairId = E.friends[uid].pairId;
  const P = pairRef(pairId);
  const v = E.view = { uid, pairId, messages: [], watchlist: {}, history: {}, typing: {}, seen: {}, unsubs: [] };
  broadcastViews({ type: 'messages', pairId, list: [] });
  v.unsubs.push(FB.onChildAdded(FB.query(P('messages'), FB.limitToLast(150)), (s) => {
    const m = { key: s.key, ...s.val() };
    v.messages.push(m);
    if (v.messages.length > 200) v.messages.shift();
    broadcastViews({ type: 'message', pairId, msg: m });
  }, noop));
  v.unsubs.push(FB.onValue(P('watchlist'), (s) => { v.watchlist = s.val() || {}; changed(); }, noop));
  v.unsubs.push(FB.onValue(FB.query(P('history'), FB.orderByChild('at'), FB.limitToLast(60)), (s) => { v.history = s.val() || {}; changed(); }, noop));
  v.unsubs.push(FB.onValue(P('typing'), (s) => { v.typing = s.val() || {}; changed(); }, noop));
  v.unsubs.push(FB.onValue(P('seen'), (s) => { v.seen = s.val() || {}; changed(); }, noop));
  changed();
}

function markSeen() {
  const v = E.view;
  if (!v) return;
  const last = E.pairLast[v.pairId];
  if (!last || !last.at || (E.pairSeen[v.pairId] || 0) >= last.at) return;
  FB.set(pairRef(v.pairId)(`seen/${E.me.uid}`), last.at).catch(noop);
  clearNotify(`msg:${v.pairId}`);
}

// ── Camera and microphone ──────────────────────────────────────
async function acquireMedia() {
  if (E.media.stream) return E.media.stream;
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio, video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } }
    });
  } catch (e) {
    if (['NotFoundError', 'OverconstrainedError', 'NotReadableError'].includes(e.name)) {
      try { stream = await navigator.mediaDevices.getUserMedia({ audio }); }
      catch (e2) { return mediaFailed(e2); }
    } else return mediaFailed(e);
  }
  E.media = { stream, error: '' };
  links.setTracks({ local: stream.getVideoTracks()[0] || null });
  return stream;
}

function mediaFailed(e) {
  if (e.name === 'NotAllowedError' || e.name === 'SecurityError') {
    E.media.error = 'permission';
    changed();
    throw new Error('WatchParty needs permission for your camera and microphone first.');
  }
  E.media.error = 'device';
  changed();
  throw new Error(`Couldn't start your microphone (${e.name}).`);
}

function releaseMedia() {
  if (E.media.stream) E.media.stream.getTracks().forEach((t) => t.stop());
  E.media.stream = null;
  links.setTracks({ local: null, remote: null });
}

// ── Calls ──────────────────────────────────────────────────────
function newCall(pairId, partnerUid, role, status, stream) {
  return {
    pairId, partnerUid, role, status, session: rid(),
    micOn: true, camOn: stream.getVideoTracks().length > 0, hasCam: stream.getVideoTracks().length > 0,
    conn: null, remoteStream: null, partnerMember: null, awaySince: 0, ringTimer: null, meter: null,
    hiddenSince: 0, hiddenWarned: false
  };
}

function memberEntry(c) { return { session: c.session, mic: c.micOn, cam: c.camOn }; }

function startConnection(c, stream) {
  const P = pairRef(c.pairId);
  c.conn = createConnection({
    FB, pref: P, me: E.me.uid, partnerUid: c.partnerUid, session: c.session, stream,
    onRemote: (rs) => setRemote(c, rs),
    onState: () => changed()
  });
}

async function startCall(uid) {
  if (E.call) throw new Error('You\'re already in a call.');
  const f = E.friends[uid];
  if (!f) throw new Error('That person isn\'t on your friends list.');
  const stream = await acquireMedia();
  const c = newCall(f.pairId, uid, 'caller', 'ringing', stream);
  E.call = c;
  const P = pairRef(f.pairId);
  await FB.remove(P(`signal/${E.me.uid}`)).catch(noop);
  await FB.set(P('call'), { status: 'ringing', caller: E.me.uid, at: FB.serverTimestamp(), members: { [E.me.uid]: memberEntry(c) } });
  FB.onDisconnect(P(`call/members/${E.me.uid}`)).remove();
  startConnection(c, stream);
  c.ringTimer = setTimeout(() => {
    if (E.call === c && c.status === 'ringing') FB.update(P('call'), { status: 'missed' }).catch(noop);
  }, RING_MS);
  selectFriend(uid);
  changed();
}

async function answer(pairId) {
  const node = E.pairCalls[pairId];
  if (!node) throw new Error('That call has ended.');
  if (E.call && E.call.pairId !== pairId) await hangUp();
  const partner = partnerOf(pairId);
  const stream = await acquireMedia();
  const c = newCall(pairId, partner, node.caller === E.me.uid ? 'caller' : 'callee', 'active', stream);
  E.call = c;
  const P = pairRef(pairId);
  await FB.remove(P(`signal/${E.me.uid}`)).catch(noop);
  await FB.update(P('call'), { status: 'active', [`members/${E.me.uid}`]: memberEntry(c) });
  FB.onDisconnect(P(`call/members/${E.me.uid}`)).remove();
  startConnection(c, stream);
  const pm = (node.members || {})[partner];
  if (pm) { c.partnerMember = pm; c.conn.updatePartner(pm); }
  clearNotify(`call:${pairId}`);
  stopRing();
  E.incoming = null;
  startSync();
  selectFriend(partner);
  changed();
}

async function decline(pairId) {
  const node = E.pairCalls[pairId];
  E.declined.add(pairId);
  clearNotify(`call:${pairId}`);
  stopRing();
  if (!node) return;
  if (node.status === 'ringing') await FB.update(pairRef(pairId)('call'), { status: 'declined' }).catch(noop);
  else await FB.remove(pairRef(pairId)('call')).catch(noop); // "rejoin" prompt: end the call for both
}

async function hangUp() {
  const c = E.call;
  if (!c) return;
  await FB.remove(pairRef(c.pairId)('call')).catch(noop);
  endLocalCall('Call ended');
}

function endLocalCall(text) {
  const c = E.call;
  if (!c) return;
  clearTimeout(c.ringTimer);
  if (c.meter) clearInterval(c.meter.timer);
  if (c.conn) c.conn.close();
  FB.onDisconnect(pairRef(c.pairId)(`call/members/${E.me.uid}`)).cancel().catch(noop);
  stopSync();
  setRemote(c, null);
  releaseMedia();
  E.call = null;
  E.lastCallEnd = text ? { text, at: Date.now() } : null;
  clearNotify('hidden');
  computeIncoming();
  changed();
  if (text) setTimeout(changed, 6100);
}

function rejoinMember() {
  const c = E.call;
  if (!c || !E.me) return;
  const P = pairRef(c.pairId);
  FB.update(P('call/members'), { [E.me.uid]: memberEntry(c) }).catch(noop);
  FB.onDisconnect(P(`call/members/${E.me.uid}`)).remove();
}

function handleCallNode(pairId, node) {
  E.pairCalls[pairId] = node;
  const c = E.call;
  if (c && c.pairId === pairId) {
    const partner = c.partnerUid;
    const members = (node && node.members) || {};
    if (!node) {
      endLocalCall(c.status === 'ringing' ? 'No answer' : `${friendName(partner)} ended the call`);
    } else if (node.status === 'declined' && c.role === 'caller') {
      FB.remove(pairRef(pairId)('call')).catch(noop);
      endLocalCall(`${friendName(partner)} declined`);
    } else if (node.status === 'missed') {
      FB.remove(pairRef(pairId)('call')).catch(noop);
      endLocalCall('No answer');
    } else if (node.status === 'active') {
      if (c.status !== 'active') { c.status = 'active'; clearTimeout(c.ringTimer); startSync(); }
      const pm = members[partner] || null;
      if (pm) { c.partnerMember = pm; c.awaySince = 0; c.conn && c.conn.updatePartner(pm); }
      else if (!c.awaySince) c.awaySince = Date.now();
      if (!members[E.me.uid]) rejoinMember();
    }
  }
  computeIncoming();
  changed();
}

function computeIncoming() {
  if (!E.me) return;
  let inc = null;
  for (const [pairId, node] of Object.entries(E.pairCalls)) {
    if (!node || (E.call && E.call.pairId === pairId)) continue;
    const partner = partnerOf(pairId);
    const members = node.members || {};
    if (node.status === 'ringing' && node.caller === partner && members[partner] &&
        serverNow() - (node.at || 0) < RING_MS && !E.declined.has(pairId)) {
      inc = { pairId, uid: partner, kind: 'ring' };
      break;
    }
    if (node.status === 'active' && members[partner] && !members[E.me.uid]) inc = { pairId, uid: partner, kind: 'rejoin' };
  }
  const prev = E.incoming;
  if (prev && inc && prev.pairId === inc.pairId && prev.kind === inc.kind) return;

  if (prev) {
    clearNotify(`call:${prev.pairId}`);
    stopRing();
    const answered = E.call && E.call.pairId === prev.pairId;
    if (prev.kind === 'ring' && !answered && !E.declined.has(prev.pairId)) {
      notify(`missed:${prev.pairId}`, 'Missed call', `${friendName(prev.uid)} called you.`, ['Call back']);
    }
  }
  E.incoming = inc;
  if (!inc) {
    for (const pairId of [...E.declined]) if (!E.pairCalls[pairId]) E.declined.delete(pairId);
    return;
  }
  const name = friendName(inc.uid);
  if (inc.kind === 'ring') {
    notify(`call:${inc.pairId}`, `${name} is calling`, 'WatchParty call', ['Answer', 'Decline'], true);
    startRing();
  } else {
    notify(`call:${inc.pairId}`, `Your call with ${name} is still on`, 'Rejoin to keep talking.', ['Rejoin', 'Hang up'], true);
  }
}

function setRemote(c, stream) {
  c.remoteStream = stream;
  audioEl.srcObject = stream;
  if (stream) audioEl.play().catch(noop);
  links.setTracks({ remote: stream ? stream.getVideoTracks()[0] || null : null });
  if (c.meter) { clearInterval(c.meter.timer); c.meter = null; }
  if (stream && stream.getAudioTracks().length) startMeter(c);
  changed();
}

// Partner's voice level, used to lower the show's volume while they talk.
const VOICE_THRESHOLD = 0.02;  // speech is clearly above this; background noise below
const VOICE_HOLD_MS = 1200;    // keep the volume down this long after they stop
function startMeter(c) {
  let speaking = false, lastLoud = 0, busy = false;
  c.meter = {
    timer: setInterval(async () => {
      if (busy || !c.conn) return;
      busy = true;
      const level = await c.conn.audioLevel();
      busy = false;
      const now = Date.now();
      if (level > VOICE_THRESHOLD) lastLoud = now;
      const s = now - lastLoud < VOICE_HOLD_MS;
      if (s !== speaking) {
        speaking = s;
        if (E.settings.duck && E.sync) sendWatch({ cmd: 'duck', on: s });
      }
    }, 150)
  };
}

function setMic(on) {
  const c = E.call;
  if (!c || !E.media.stream) return;
  c.micOn = on ?? !c.micOn;
  E.media.stream.getAudioTracks().forEach((t) => { t.enabled = c.micOn; });
  FB.update(pairRef(c.pairId)(`call/members/${E.me.uid}`), { mic: c.micOn }).catch(noop);
  changed();
}

function setCam(on) {
  const c = E.call;
  if (!c || !E.media.stream || !c.hasCam) return;
  c.camOn = on ?? !c.camOn;
  E.media.stream.getVideoTracks().forEach((t) => { t.enabled = c.camOn; });
  FB.update(pairRef(c.pairId)(`call/members/${E.me.uid}`), { cam: c.camOn }).catch(noop);
  changed();
}

// ── Sync (only during an active call) ──────────────────────────
function startSync() {
  if (E.sync || !E.call) return;
  const c = E.call;
  E.sync = createSync({
    FB, pref: pairRef(c.pairId), me: E.me.uid, partnerUid: c.partnerUid,
    myName, partnerName: () => friendName(c.partnerUid),
    partnerStatus: () => E.status[c.partnerUid] || null,
    serverNow, local: () => E.local, sendWatch,
    navigate: (url, tabId) => bg({ type: 'navigate', url, tabId }),
    primeOrigin: () => primeOrigin,
    settings: () => E.settings, onChange: changed,
    onReaction: (emoji, name) => broadcastViews({ type: 'reaction', emoji, name })
  });
  E.sync.start();
}

function stopSync() {
  if (!E.sync) return;
  E.sync.stop();
  E.sync = null;
}

// ── Streaming tabs ─────────────────────────────────────────────
function sendWatch(msg) {
  const info = E.contents.get(E.local.watchTabId);
  if (info) safePost(info.port, msg);
}

let lastSession = '';
function pushSession(force) {
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

function pushSettings() {
  for (const info of E.contents.values()) safePost(info.port, { cmd: 'settings', settings: E.settings });
}

function setLocal(st) {
  E.local.snap = st;
  E.local.at = Date.now();
  publishWatching(false);
  changed();
}

// Lets friends see what you're watching (and powers the sync status).
function publishWatching(force) {
  if (!E.me) return;
  const st = E.local.snap;
  if (st && st.settling) return;
  const w = st && st.mediaId ? {
    mediaId: st.mediaId, title: st.title || '', url: st.url, service: st.service,
    position: st.position, paused: st.paused, at: FB.serverTimestamp()
  } : null;
  const key = w ? `${w.mediaId}|${w.paused}|${w.title}` : '';
  if (!force && key === E.local.published && Date.now() - E.local.publishedAt < 5000) return;
  if (!force && !w && !E.local.published) return;
  E.local.published = key;
  E.local.publishedAt = Date.now();
  FB.update(ref(`status/${E.me.uid}`), { watching: w }).catch(noop);
}

function onContentPort(port) {
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
let primeOrigin = (() => { try { return localStorage.getItem('wpPrimeOrigin'); } catch { return null; } })();
function notePrimeOrigin(url) {
  try {
    const u = new URL(url);
    if (M.serviceFromUrl(url) !== 'prime' || u.origin === primeOrigin) return;
    primeOrigin = u.origin;
    localStorage.setItem('wpPrimeOrigin', primeOrigin);
  } catch {}
}

function onContentMessage(tabId, info, m) {
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

// ── Screens (side panel and fullscreen companion) ──────────────
function onViewPort(port) {
  const v = { kind: 'panel', visible: true, chatOpen: false };
  E.views.set(port, v);
  port.onMessage.addListener((m) => onViewMessage(port, v, m));
  port.onDisconnect.addListener(() => {
    E.views.delete(port);
    links.close(port);
    changed();
    pushSession();
    checkVisibility();
  });
  safePost(port, { type: 'state', state: publicState() });
  if (E.view) safePost(port, { type: 'messages', pairId: E.view.pairId, list: E.view.messages });
}

async function onViewMessage(port, v, m) {
  if (!m) return;
  if (links.handle(port, m)) return;
  const reply = (ok, error) => { if (m.id) safePost(port, { type: 'result', id: m.id, ok, error }); };
  try {
    await command(port, v, m);
    reply(true, null);
  } catch (e) {
    reply(false, e.message || String(e));
  }
}

async function command(port, v, m) {
  switch (m.type) {
    case 'hello':
      v.kind = m.kind === 'companion' ? 'companion' : 'panel';
      pushSession();
      changed();
      return;
    case 'visibility': v.visible = !!m.visible; if (v.visible) markSeen(); checkVisibility(); return;
    case 'chat-visible': v.chatOpen = !!m.on; if (v.chatOpen) markSeen(); return;
    case 'enter': return enter(m);
    case 'sign-out': return signOutUser();
  }
  if (!E.me) throw new Error('Sign in first.');
  const c = E.call;
  switch (m.type) {
    case 'settings':
      E.settings = { ...E.settings, ...m.patch };
      pushSettings();
      changed();
      return FB.update(ref(`users/${E.me.uid}/settings`), m.patch);
    case 'friend-request': return sendFriendRequest(m.username);
    case 'friend-accept': return acceptFriend(m.uid);
    case 'friend-decline': return declineFriend(m.uid);
    case 'friend-cancel': return cancelRequest(m.uid);
    case 'unfriend': return unfriend(m.uid);
    case 'select': selectFriend(m.uid || null); return;
    case 'call': return startCall(m.uid);
    case 'answer': return answer(m.pairId);
    case 'decline': return decline(m.pairId);
    case 'hangup': return hangUp();
    case 'mic': setMic(m.on); return;
    case 'cam': setCam(m.on); return;
    case 'media-retry': E.media.error = ''; changed(); return;
    case 'chat': {
      const text = String(m.text || '').trim().slice(0, 1000);
      if (!text || !E.view) return;
      await FB.push(pairRef(E.view.pairId)('messages'), { text, by: E.me.uid, name: myName(), at: FB.serverTimestamp() });
      FB.remove(pairRef(E.view.pairId)(`typing/${E.me.uid}`)).catch(noop);
      return;
    }
    case 'typing':
      if (E.view) FB.set(pairRef(E.view.pairId)(`typing/${E.me.uid}`), FB.serverTimestamp()).catch(noop);
      return;
    case 'seen': markSeen(); return;
    case 'reaction': if (E.sync) E.sync.sendReaction(m.emoji); return;
    case 'countdown':
      if (!E.sync) throw new Error('Start a call first.');
      return E.sync.startCountdown();
    case 'follow': if (E.sync) E.sync.followPartner(); return;
    case 'focus-watch':
      if (E.local.watchTabId == null) throw new Error('Open a show first.');
      bg({ type: 'focus-tab', tabId: E.local.watchTabId });
      return;
    case 'confirm-same':
      if (!E.sync) throw new Error('Start a call first.');
      return E.sync.confirmSame();
    case 'resync':
      if (!E.sync) throw new Error('Start a call first.');
      return E.sync.resync();
    case 'open': {
      if (!/^https:\/\//.test(m.url || '')) throw new Error('That link doesn\'t look right.');
      if (E.sync && c && E.view && E.view.pairId === c.pairId) return E.sync.openForBoth(m.url, m.title, m.position || 0);
      bg({ type: 'navigate', url: m.url, tabId: E.local.watchTabId ?? E.local.streamTabId });
      return;
    }
    case 'watchlist-add': {
      if (!E.view) throw new Error('Pick a friend first.');
      let { url, title } = m;
      if (m.current) {
        const s = E.local.snap;
        if (!s || !s.mediaId) throw new Error('Open a show first.');
        url = s.url; title = s.title;
      }
      if (!/^https:\/\//.test(url || '') || !M.serviceFromUrl(url)) throw new Error('Use a Netflix, Disney+ or Prime Video link.');
      return FB.push(pairRef(E.view.pairId)('watchlist'), {
        url, title: String(title || '').trim().slice(0, 140) || 'Untitled', service: M.serviceFromUrl(url),
        addedBy: myName(), at: FB.serverTimestamp(), watched: false
      });
    }
    case 'watchlist-toggle':
      if (E.view) return FB.update(pairRef(E.view.pairId)(`watchlist/${m.key}`), { watched: !!m.watched });
      return;
    case 'watchlist-remove':
      if (E.view) return FB.remove(pairRef(E.view.pairId)(`watchlist/${m.key}`));
      return;
    case 'history-remove':
      if (E.view) return FB.remove(pairRef(E.view.pairId)(`history/${m.key}`));
      return;
    case 'history-clear':
      if (E.view) return FB.remove(pairRef(E.view.pairId)('history'));
      return;
  }
}

// ── Notification buttons (relayed by the background worker) ────
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.to !== 'engine' || msg.type !== 'notification' || !E.me) return;
  const [kind, arg] = msg.id.split(':');
  const b = msg.button;
  const run = (p) => Promise.resolve(p).catch((e) => notify('error', 'WatchParty', e.message));
  if (kind === 'call' && E.incoming && E.incoming.pairId === arg) {
    if (b === 0) run(answer(arg));
    else if (b === 1) run(decline(arg));
  } else if (kind === 'req') {
    if (b === 0) run(acceptFriend(arg));
    else if (b === 1) run(declineFriend(arg));
  } else if (kind === 'missed' && b === 0) {
    const uid = partnerOf(arg);
    if (E.friends[uid]) run(startCall(uid));
  } else if (kind === 'msg') {
    selectFriend(partnerOf(arg));
  } else if (kind === 'hidden' && b === 1) {
    run(hangUp());
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'wp-content') onContentPort(port);
  else if (port.name === 'wp-view') onViewPort(port);
});

// Privacy rule: a call only stays on while the side panel or the call window
// can actually be seen. Otherwise: a warning, then the call ends.
function checkVisibility() {
  const c = E.call;
  if (!c) return;
  const seen = [...E.views.values()].some((v) => v.visible);
  if (seen) {
    if (c.hiddenSince) { c.hiddenSince = 0; c.hiddenWarned = false; clearNotify('hidden'); }
    return;
  }
  if (!c.hiddenSince) { c.hiddenSince = Date.now(); return; }
  const hiddenFor = Date.now() - c.hiddenSince;
  const name = friendName(c.partnerUid);
  if (hiddenFor > HIDDEN_END_MS) {
    clearNotify('hidden');
    hangUp().then(() => notify('ended', 'Call ended',
      `WatchParty wasn't open, so your call with ${name} was ended to protect your privacy.`));
  } else if (hiddenFor > HIDDEN_WARN_MS && !c.hiddenWarned) {
    c.hiddenWarned = true;
    notify('hidden', `Your call with ${name} will end in ${Math.round((HIDDEN_END_MS - hiddenFor) / 1000)} seconds`,
      'Neither WatchParty nor the call window is open. Open it to keep talking.', ['Open WatchParty', 'Hang up'], true);
  }
}

// Housekeeping: ring time-outs, partner gone too long, typing indicator.
setInterval(() => {
  if (!E.me) return;
  computeIncoming();
  checkVisibility();
  const c = E.call;
  if (c && c.status === 'active' && c.awaySince && Date.now() - c.awaySince > AWAY_MS) {
    FB.remove(pairRef(c.pairId)('call')).catch(noop);
    endLocalCall(`${friendName(c.partnerUid)} disconnected`);
  }
  if (E.view || E.sync) changed();
}, 1000);

init();
