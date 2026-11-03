// Camera and microphone, calls, the voice meter, sync start/stop, and the
// privacy rule (a call only stays on while WatchParty can be seen).
import * as FB from '../vendor/firebase.js';
import { createConnection } from './call.js';
import { createSync } from './sync.js';
import { E, HIDDEN_END_MS, HIDDEN_WARN_MS, RING_MS, audioEl, bg, broadcastViews, changed, friendName, links, log, myName, noop, pairRef, partnerOf, rid, serverNow } from './core.js';
import { clearNotify, notify, ring, startRing, stopRing } from './notify.js';
import { selectFriend } from './friends.js';
import { primeOrigin, sendWatch } from './tabs.js';

// ── Camera and microphone ──────────────────────────────────────
export async function acquireMedia() {
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

export function mediaFailed(e) {
  if (e.name === 'NotAllowedError' || e.name === 'SecurityError') {
    E.media.error = 'permission';
    changed();
    throw new Error('WatchParty needs permission for your camera and microphone first.');
  }
  E.media.error = 'device';
  changed();
  throw new Error(`Couldn't start your microphone (${e.name}).`);
}

export function releaseMedia() {
  if (E.media.stream) E.media.stream.getTracks().forEach((t) => t.stop());
  E.media.stream = null;
  links.setTracks({ local: null, remote: null });
}

// ── Calls ──────────────────────────────────────────────────────
export function newCall(pairId, partnerUid, role, status, stream) {
  return {
    pairId, partnerUid, role, status, session: rid(),
    micOn: true, camOn: stream.getVideoTracks().length > 0, hasCam: stream.getVideoTracks().length > 0,
    conn: null, remoteStream: null, partnerMember: null, awaySince: 0, ringTimer: null, meter: null,
    hiddenSince: 0, hiddenWarned: false
  };
}

export function memberEntry(c) { return { session: c.session, mic: c.micOn, cam: c.camOn }; }

export function startConnection(c, stream) {
  const P = pairRef(c.pairId);
  c.conn = createConnection({
    FB, pref: P, me: E.me.uid, partnerUid: c.partnerUid, session: c.session, stream,
    onRemote: (rs) => setRemote(c, rs),
    onState: () => changed(),
    onData: (msg) => { if (E.sync) E.sync.onPeer(msg); }
  });
}

export async function startCall(uid) {
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
  log(`calling ${friendName(uid)}`);
  changed();
}

export async function answer(pairId) {
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

export async function decline(pairId) {
  const node = E.pairCalls[pairId];
  E.declined.add(pairId);
  clearNotify(`call:${pairId}`);
  stopRing();
  if (!node) return;
  if (node.status === 'ringing') await FB.update(pairRef(pairId)('call'), { status: 'declined' }).catch(noop);
  else await FB.remove(pairRef(pairId)('call')).catch(noop); // "rejoin" prompt: end the call for both
}

export async function hangUp() {
  const c = E.call;
  if (!c) return;
  await FB.remove(pairRef(c.pairId)('call')).catch(noop);
  endLocalCall('Call ended');
}

export function endLocalCall(text) {
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

export function rejoinMember() {
  const c = E.call;
  if (!c || !E.me) return;
  const P = pairRef(c.pairId);
  FB.update(P('call/members'), { [E.me.uid]: memberEntry(c) }).catch(noop);
  FB.onDisconnect(P(`call/members/${E.me.uid}`)).remove();
}

export function handleCallNode(pairId, node) {
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

export function computeIncoming() {
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

export function setRemote(c, stream) {
  c.remoteStream = stream;
  audioEl.srcObject = stream;
  if (stream) audioEl.play().catch(noop);
  links.setTracks({ remote: stream ? stream.getVideoTracks()[0] || null : null });
  if (c.meter) { clearInterval(c.meter.timer); c.meter = null; }
  if (stream && stream.getAudioTracks().length) startMeter(c);
  changed();
}

// Partner's voice level, used to lower the show's volume while they talk.
export const VOICE_THRESHOLD = 0.02;  // speech is clearly above this; background noise below
export const VOICE_HOLD_MS = 1200;    // keep the volume down this long after they stop
export function startMeter(c) {
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

export function setMic(on) {
  const c = E.call;
  if (!c || !E.media.stream) return;
  c.micOn = on ?? !c.micOn;
  E.media.stream.getAudioTracks().forEach((t) => { t.enabled = c.micOn; });
  FB.update(pairRef(c.pairId)(`call/members/${E.me.uid}`), { mic: c.micOn }).catch(noop);
  changed();
}

export function setCam(on) {
  const c = E.call;
  if (!c || !E.media.stream || !c.hasCam) return;
  c.camOn = on ?? !c.camOn;
  E.media.stream.getVideoTracks().forEach((t) => { t.enabled = c.camOn; });
  FB.update(pairRef(c.pairId)(`call/members/${E.me.uid}`), { cam: c.camOn }).catch(noop);
  changed();
}

// ── Sync (only during an active call) ──────────────────────────
export function startSync() {
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
    onReaction: (emoji, name) => broadcastViews({ type: 'reaction', emoji, name }),
    peerSend: (msg) => !!(E.call && E.call.conn && E.call.conn.send(msg)),
    peerDirect: () => !!(E.call && E.call.conn && E.call.conn.direct)
  });
  E.sync.start();
}

export function stopSync() {
  if (!E.sync) return;
  E.sync.stop();
  E.sync = null;
}


// Privacy rule: a call only stays on while the side panel or the call window
// can actually be seen. Otherwise: a warning, then the call ends.
// Which browser windows are minimized (asked from the background worker,
// since this page can't see windows). Refreshed every second.
const minimized = new Map();
function refreshWindows() {
  const ids = [...new Set([...E.views.values()].map((v) => v.windowId).filter((id) => id != null))];
  if (!ids.length) return;
  chrome.runtime.sendMessage({ to: 'bg', type: 'window-states', ids }).then((states) => {
    for (const [id, st] of Object.entries(states || {})) minimized.set(Number(id), st === 'minimized');
  }).catch(noop);
}

export function checkVisibility() {
  const c = E.call;
  if (!c) return;
  refreshWindows();
  const views = [...E.views.values()].filter((v) => v.kind !== 'unknown');
  // On screen: the side panel or the call window is visible; or the call
  // window's tab is just in the background of a window that's not minimized
  // (switching tabs keeps the call; the LIVE badge shows it's still on).
  const seen = views.some((v) => v.visible) ||
    views.some((v) => v.kind === 'companion' && v.windowId != null && minimized.get(v.windowId) === false);
  if (seen) {
    if (c.hiddenSince) { c.hiddenSince = 0; c.hiddenWarned = false; clearNotify('hidden'); log('WatchParty visible again'); }
    return;
  }
  if (!c.hiddenSince) { c.hiddenSince = Date.now(); log('nothing of WatchParty on screen'); return; }
  const hiddenFor = Date.now() - c.hiddenSince;
  const name = friendName(c.partnerUid);
  if (hiddenFor > HIDDEN_END_MS) {
    clearNotify('hidden');
    log('call ended: WatchParty not visible for 20 s');
    hangUp().then(() => notify('ended', 'Call ended',
      `WatchParty wasn't open, so your call with ${name} was ended to protect your privacy.`));
  } else if (hiddenFor > HIDDEN_WARN_MS && !c.hiddenWarned) {
    c.hiddenWarned = true;
    notify('hidden', `Your call with ${name} will end in ${Math.round((HIDDEN_END_MS - hiddenFor) / 1000)} seconds`,
      'The browser is minimized and WatchParty can\'t be seen. Open it to keep talking.', ['Open WatchParty', 'Hang up'], true);
  }
}
