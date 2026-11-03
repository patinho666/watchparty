// Friend requests, the friend shown in the panel, and chat housekeeping.
import * as FB from '../vendor/firebase.js';
import { E, broadcastViews, changed, log, myName, noop, pairRef, ref, serverNow } from './core.js';
import { clearNotify } from './notify.js';
import { normUser } from './accounts.js';
import { hangUp } from './calls.js';

// ── Friends ────────────────────────────────────────────────────
export async function sendFriendRequest(username) {
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

export async function acceptFriend(uid) {
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

export async function declineFriend(uid) {
  await FB.update(FB.ref(E.db), { [`friendRequests/${E.me.uid}/${uid}`]: null, [`sentRequests/${uid}/${E.me.uid}`]: null });
  clearNotify(`req:${uid}`);
}

export async function cancelRequest(uid) {
  await FB.update(FB.ref(E.db), { [`friendRequests/${uid}/${E.me.uid}`]: null, [`sentRequests/${E.me.uid}/${uid}`]: null });
}

// Chat older than 90 days is deleted, so the database doesn't grow forever.
const CHAT_KEEP_MS = 90 * 24 * 3600 * 1000;
const cleaned = new Set();
export function cleanOldMessages(pairId) {
  if (cleaned.has(pairId)) return;
  cleaned.add(pairId);
  FB.get(FB.query(pairRef(pairId)('messages'), FB.orderByChild('at'), FB.endAt(serverNow() - CHAT_KEEP_MS)))
    .then((snap) => {
      const doomed = {};
      snap.forEach((c) => { doomed[c.key] = null; });
      const n = Object.keys(doomed).length;
      if (n) { FB.update(pairRef(pairId)('messages'), doomed).catch(noop); log(`deleted ${n} chat messages older than 90 days`); }
    }).catch(noop);
}

export async function unfriend(uid) {
  if (E.call && E.call.partnerUid === uid) await hangUp();
  await FB.update(FB.ref(E.db), { [`friends/${E.me.uid}/${uid}`]: null, [`friends/${uid}/${E.me.uid}`]: null });
}

// ── The friend shown in the panel ──────────────────────────────
export function closeView() {
  if (!E.view) return;
  E.view.unsubs.forEach((u) => u());
  E.view = null;
}

export function selectFriend(uid) {
  if (E.call) uid = E.call.partnerUid; // during a call, the call partner is always shown
  if (uid && !E.friends[uid]) uid = null;
  if (E.selected === uid && (E.view || !uid)) { changed(); return; }
  closeView();
  E.selected = uid;
  if (!uid) { changed(); return; }
  const pairId = E.friends[uid].pairId;
  const P = pairRef(pairId);
  cleanOldMessages(pairId);
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

export function markSeen() {
  const v = E.view;
  if (!v) return;
  const last = E.pairLast[v.pairId];
  if (!last || !last.at || (E.pairSeen[v.pairId] || 0) >= last.at) return;
  FB.set(pairRef(v.pairId)(`seen/${E.me.uid}`), last.at).catch(noop);
  clearNotify(`msg:${v.pairId}`);
}
