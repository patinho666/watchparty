// The screens (side panel and call window): state they get, commands they send.
import * as FB from '../vendor/firebase.js';
import { E, M, VERSION, bg, changed, friendName, isOnline, links, log, logBook, myName, noop, pairRef, panels, ref, safePost, serverNow } from './core.js';
import { enter, signOutUser } from './accounts.js';
import { acceptFriend, cancelRequest, declineFriend, markSeen, selectFriend, sendFriendRequest, unfriend } from './friends.js';
import { answer, checkVisibility, decline, hangUp, setCam, setMic, startCall } from './calls.js';
import { pushSession, pushSettings } from './tabs.js';
import { checkForUpdate } from './update.js';

// What Settings → Diagnostics shows: what the engine sees right now.
function diagnostics() {
  const L = E.local, s = L.snap;
  const tabs = [...E.contents.entries()].map(([id, t]) => {
    const x = t.snap || {};
    return `tab ${id}${id === L.watchTabId ? ' (watching)' : ''}: ${x.service || '?'} · video=${!!x.hasVideo} · ${x.mediaId || 'no id'} · ${x.paused ? 'paused' : 'playing'} at ${M.fmtTime(x.position || 0)}${x.inAd ? ' · AD' : ''}${x.settling ? ' · settling' : ''} · last report ${t.at ? Math.round((Date.now() - t.at) / 1000) + 's ago' : 'never'}`;
  });
  return {
    version: VERSION, user: E.me ? `${E.me.username} (${E.me.uid})` : 'signed out',
    connected: E.connected ? 'yes' : 'no',
    screens: [...E.views.values()].map((v) => `${v.kind}${v.visible ? '' : ' (hidden)'}`).join(', ') || 'none',
    tabs: tabs.length ? tabs : ['no streaming tab connected'],
    local: s ? `${s.title || '?'} · ${s.mediaId || 'no id'}${s.prime ? ` · S${s.prime.s}E${s.prime.e} ${s.prime.dur}s` : ''}` : 'nothing',
    call: E.call ? `${E.call.status} with ${friendName(E.call.partnerUid)} · connection ${E.call.conn ? E.call.conn.state : '-'}` : 'no call',
    sync: E.sync ? E.sync.debug() : 'not running (only during a call)',
    log: logBook.slice(-25)
  };
}

export function isUnread(pairId) {
  const last = E.pairLast[pairId];
  return !!(last && !last.system && last.by !== E.me.uid && (last.at || 0) > (E.pairSeen[pairId] || 0));
}

export function publicState() {
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
      unread: isUnread(f.pairId), inCall: !!(c && c.pairId === f.pairId), version: st.version || ''
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
    version: VERSION, phase: E.phase, authError: E.authError,
    update: E.update || null, pendingReload: E.pendingReload || null, panelOpen: panels().length > 0,
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
    diagnostics: E.diagOpen ? diagnostics() : null,
    watch: {
      local: snap && snap.mediaId ? { title: snap.title, position: snap.position, paused: snap.paused, mediaId: snap.mediaId, service: snap.service, url: snap.url } : null,
      sync: E.sync ? E.sync.info() : null
    }
  };
}


// ── Screens (side panel and fullscreen companion) ──────────────
export function onViewPort(port) {
  // "unknown" until the screen says whether it's the side panel or the call
  // window; counting it as the panel meanwhile made the call window flicker.
  const v = { kind: 'unknown', visible: true, chatOpen: false, windowId: port.sender && port.sender.tab ? port.sender.tab.windowId : null };
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

export async function onViewMessage(port, v, m) {
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

export async function command(port, v, m) {
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
    case 'remind':
      if (!E.sync) throw new Error('Start a call first.');
      return E.sync.remind();
    case 'check-update':
      return checkForUpdate(true);
    case 'diagnostics':
      E.diagOpen = !!m.on;
      changed();
      return;
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
