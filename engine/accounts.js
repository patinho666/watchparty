// Firebase start-up, username sign-in, and what the signed-in user listens to.
import * as FB from '../vendor/firebase.js';
import { DEFAULT_SETTINGS, E, EMAIL_DOMAIN, VERSION, changed, companions, connKey, friendName, loadConfig, log, myName, noop, pairRef, panels, ref, serverNow } from './core.js';
import { clearNotify, notify, stopRing } from './notify.js';
import { closeView, selectFriend } from './friends.js';
import { endLocalCall, handleCallNode, hangUp, rejoinMember } from './calls.js';
import { publishWatching, pushSettings, sendWatch } from './tabs.js';

// ── Firebase start-up and accounts ─────────────────────────────
export async function init() {
  const CONFIG = await loadConfig();
  E.firebaseConfig = CONFIG.firebase || {};
  const cfg = E.firebaseConfig;
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

export const normUser = (u) => String(u || '').trim().toLowerCase().replace(/^@/, '');

export function authMessage(e) {
  const code = e && e.code;
  if (code === 'auth/email-already-in-use') return 'That username is taken. Try signing in with it again.';
  if (code === 'auth/operation-not-allowed') return 'Turn on Email/Password sign-in in your Firebase project (see README).';
  if (code === 'auth/network-request-failed') return 'No connection. Check your internet and try again.';
  if (code === 'auth/too-many-requests') return 'Too many attempts. Wait a minute and try again.';
  return (e && e.message) || 'Something went wrong.';
}

// Username-only sign-in. Firebase needs a login with a secret, so the
// secret is derived from the username: knowing a username is enough to use it.
export async function secretFor(username) {
  const data = new TextEncoder().encode(`watchparty:${(E.firebaseConfig && E.firebaseConfig.projectId) || ''}:${username}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function enter({ username }) {
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

export async function signOutUser() {
  if (E.call) await hangUp();
  if (E.me) {
    await FB.update(ref(`status/${E.me.uid}`), {
      [`conns/${connKey}`]: null, watching: null, lastSeen: FB.serverTimestamp()
    }).catch(noop);
  }
  await FB.signOut(E.auth);
}

export async function onSignedIn(u) {
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

export function onSignedOut() {
  cleanupSession();
  E.phase = E.phase === 'setup' ? 'setup' : 'signed-out';
  changed();
}

export function cleanupSession() {
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
export function subscribeUser() {
  const uid = E.me.uid;
  E.unsubs.push(FB.onValue(ref(`users/${uid}`), (s) => {
    const v = s.val() || {};
    E.settings = { ...DEFAULT_SETTINGS, ...(v.settings || {}) };
    pushSettings();
    changed();
  }, noop));

  E.unsubs.push(FB.onValue(ref('.info/connected'), (s) => {
    E.connected = !!s.val();
    log(E.connected ? 'connected to Firebase' : 'lost connection to Firebase');
    changed();
    if (!s.val() || !E.me) return;
    // Each running session registers itself; it's removed by the server the
    // moment this session disconnects, without touching the other sessions.
    const st = ref(`status/${uid}`);
    FB.onDisconnect(st).update({ [`conns/${connKey}`]: null, watching: null, lastSeen: FB.serverTimestamp() });
    FB.update(st, { [`conns/${connKey}`]: true, online: null, name: myName(), username: E.me.username, version: VERSION || null }).catch(noop);
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

export function syncFriendSubs() {
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

export function onLastMessage(pairId, uid, last) {
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
