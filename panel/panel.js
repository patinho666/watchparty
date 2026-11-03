// WatchParty side panel: the app screen. Everything it shows comes from the
// engine; everything it does is a request to the engine.
import { connectEngine } from '../shared/client.js';
import { createVideoView } from '../shared/video-view.js';

const M = globalThis.WPMedia;
const $ = (id) => document.getElementById(id);
const REACTIONS = ['❤️', '😂', '😮', '😢', '😱', '👏', '🔥', '🍿'];
const CHAT_EMOJI = ['❤️', '😘', '😂', '🥹', '😮', '😢', '😱', '🙈', '👀', '🔥', '🍿', '😴', '👍', '🥰', '💀', '✨'];

let S = null;               // latest engine state
let screen = 'main';        // 'main' | 'settings'
let activeTab = 'chat';
let msgPair = null;
let linked = false;
let lastLists = { wl: '', hist: '' };

const engine = connectEngine('panel', {
  onState: (s) => { S = s; render(); },
  onMessage: (m) => {
    if (video.handle(m)) return;
    if (m.type === 'messages') { msgPair = m.pairId; $('messages').replaceChildren(); m.list.forEach((x) => addMessage(x)); }
    else if (m.type === 'message' && m.pairId === msgPair) { addMessage(m.msg); markSeen(); }
    else if (m.type === 'close-panel') window.close();
    else if (m.type === 'reaction') popReaction(m.emoji);
  },
  onDisconnect: () => { linked = false; show('loading'); }
});

const video = createVideoView((msg) => engine.post(msg), {
  remote: $('remote-video'), local: $('local-video'), onChange: () => render()
});

// ── Helpers ────────────────────────────────────────────────────
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function show(id) {
  for (const s of ['loading', 'setup', 'auth', 'main', 'settings']) $(s).classList.toggle('hidden', s !== id);
}

const initial = (name) => (name || '?').trim().slice(0, 1).toUpperCase();

function ago(ts) {
  if (!ts) return 'Offline';
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 2) return 'Last seen just now';
  if (min < 60) return `Last seen ${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `Last seen ${h} h ago`;
  return `Last seen ${new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' })}`;
}

function fmtClock(ts) {
  return ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}

function fmtDay(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (d.toDateString() === new Date().toDateString()) return `Today ${fmtClock(ts)}`;
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = old; }, 2200);
}

let noticeTimer = null;
function notice(text) {
  const n = $('notice');
  n.textContent = text;
  n.classList.toggle('hidden', !text);
  clearTimeout(noticeTimer);
  if (text) noticeTimer = setTimeout(() => n.classList.add('hidden'), 6000);
}

async function act(type, data, btn) {
  if (btn) btn.disabled = true;
  try { return await engine.request(type, data); }
  catch (e) { notice(e.message); throw e; }
  finally { if (btn) btn.disabled = false; }
}
const quiet = (p) => p.catch(() => {});

function friend(uid) { return S && S.friends.find((f) => f.uid === uid); }

function statusLine(f) {
  if (!f) return '';
  if (f.inCall) return 'In a call with you';
  if (f.watching && f.watching.title) return `Watching ${f.watching.title}`;
  if (f.watching) return `On ${M.SERVICE_NAMES[f.watching.service] || 'a streaming site'}`;
  return f.online ? 'Online' : ago(f.lastSeen);
}

// ── Rendering ──────────────────────────────────────────────────
function render() {
  if (!S) return;
  if (S.phase === 'loading') return show('loading');
  if (S.phase === 'setup') return show('setup');
  if (S.phase === 'signed-out') { show('auth'); return; }
  updateLink();
  if (screen === 'settings') { renderSettings(); return show('settings'); }
  show('main');

  $('me-avatar').textContent = initial(S.me.name);
  $('me-name').textContent = S.me.name;
  if (S.lastCallEnd) notice(S.lastCallEnd);

  renderIncoming();
  const inFriend = !!(S.call || S.selected);
  $('home').classList.toggle('hidden', inFriend);
  $('friend').classList.toggle('hidden', !inFriend);
  if (inFriend) renderFriend(); else renderHome();
}

function renderIncoming() {
  const inc = S.incoming;
  $('incoming').classList.toggle('hidden', !inc);
  if (!inc) return;
  $('incoming-avatar').textContent = initial(inc.name);
  $('incoming-text').textContent = inc.kind === 'ring' ? `${inc.name} is calling` : `Your call with ${inc.name} is still on`;
  $('incoming-yes').textContent = inc.kind === 'ring' ? 'Answer' : 'Rejoin';
  $('incoming-no').textContent = inc.kind === 'ring' ? 'Decline' : 'Hang up';
}

function renderHome() {
  // Incoming friend requests
  const rin = $('requests-in');
  rin.replaceChildren();
  for (const r of S.requestsIn) {
    const li = el('li', 'item request');
    li.append(el('div', 'title', `${r.username} wants to be friends`));
    const btns = el('div', 'btns');
    const yes = el('button', 'small primary', 'Accept');
    yes.onclick = () => quiet(act('friend-accept', { uid: r.uid }, yes));
    const no = el('button', 'small', 'Decline');
    no.onclick = () => quiet(act('friend-decline', { uid: r.uid }, no));
    btns.append(yes, no);
    li.appendChild(btns);
    rin.appendChild(li);
  }

  // Friends
  const ul = $('friends');
  ul.replaceChildren();
  if (!S.friends.length) {
    ul.appendChild(el('li', 'empty', 'No friends yet. Add someone by their username to watch together.'));
  }
  for (const f of S.friends) {
    const li = el('li', 'friend-row');
    const av = el('span', `avatar them${f.online ? ' online' : ''}`, initial(f.name));
    const who = el('button', 'who link');
    who.append(el('strong', null, f.name), el('span', 'muted', statusLine(f)));
    who.onclick = () => engine.post({ type: 'select', uid: f.uid });
    if (f.unread) av.appendChild(el('span', 'unread-dot'));
    const call = el('button', 'icon call-icon', '📞');
    call.title = f.online ? `Call ${f.name}` : `${f.name} is offline`;
    call.disabled = !f.online || !!S.call;
    call.onclick = () => quiet(act('call', { uid: f.uid }, call));
    li.append(av, who, call);
    ul.appendChild(li);
  }

  // Sent requests
  const rout = $('requests-out');
  rout.replaceChildren();
  for (const r of S.requestsOut) {
    const li = el('li', 'item pending');
    li.append(el('div', 'sub', `Request sent to ${r.username}`));
    const cancel = el('button', 'small', 'Cancel');
    cancel.onclick = () => quiet(act('friend-cancel', { uid: r.uid }, cancel));
    li.appendChild(cancel);
    rout.appendChild(li);
  }
}

function renderFriend() {
  const c = S.call;
  const uid = c ? c.partnerUid : S.selected;
  const f = friend(uid);
  const name = c ? c.partnerName : (f ? f.name : '');

  $('back-btn').classList.toggle('hidden', !!c);
  $('friend-avatar').textContent = initial(name);
  $('friend-avatar').classList.toggle('online', !!(f && f.online));
  $('friend-name').textContent = name;
  $('friend-status').textContent = f ? statusLine(f) : '';
  $('call-btn').classList.toggle('hidden', !!c);
  $('call-btn').disabled = !(f && f.online);
  $('call-btn').title = f && f.online ? `Call ${name}` : `${name} is offline`;
  $('unfriend-btn').classList.toggle('hidden', !!c);

  // Call card
  $('call-card').classList.toggle('hidden', !c);
  $('perm').classList.toggle('hidden', S.mediaError !== 'permission');
  if (c) {
    const ringing = c.status === 'ringing';
    $('ringing').classList.toggle('hidden', !ringing);
    $('live').classList.toggle('hidden', ringing);
    $('ringing-text').textContent = `Calling ${name}…`;
    if (!ringing) renderLive(c, name);
  }

  // Watching card (only during a call)
  const active = c && c.status === 'active';
  $('watch-card').classList.toggle('hidden', !active);
  if (active) renderWatch();

  renderTyping();
  renderSeen();
  renderLists();
}

function renderLive(c, name) {
  $('remote-initial').textContent = initial(name);
  $('remote-placeholder').classList.toggle('hidden', !!(c.partnerCam && c.hasRemote));
  $('local-video').classList.toggle('hidden', !c.camOn);
  const notes = [];
  if (!c.partnerMic) notes.push('muted');
  if (!c.partnerCam) notes.push('camera off');
  $('remote-label').textContent = notes.length ? `${name}: ${notes.join(', ')}` : '';
  $('mic-btn').textContent = c.micOn ? '🎙️' : '🔇';
  $('mic-btn').title = c.micOn ? 'Mute microphone' : 'Unmute microphone';
  $('cam-btn').classList.toggle('off', !c.camOn);
  $('cam-btn').disabled = !c.hasCam;
  $('cam-btn').title = !c.hasCam ? 'No camera found' : c.camOn ? 'Turn camera off' : 'Turn camera on';
  let st = 'Connecting…';
  if (c.partnerAway || c.conn === 'reconnecting') st = 'Reconnecting…';
  else if (c.conn === 'connected') st = 'Connected · use headphones';
  $('call-status').textContent = st;
}

function renderWatch() {
  const w = S.watch || {};
  const l = w.local;
  const tabs = S.tabs || { pages: 0, videos: 0 };
  let none = 'Open a show on Netflix, Disney+ or Prime Video';
  let hint = '';
  if (!l && tabs.pages === 0) hint = 'Already have one open? Refresh that tab so WatchParty can see it.';
  else if (!l && tabs.videos === 0) { none = 'Looking for the video…'; hint = 'WatchParty sees the streaming page but no video playing yet. If one is playing, refresh the tab.'; }
  $('now-playing').textContent = l
    ? `${l.title || 'Untitled'} · ${M.fmtTime(l.position)}${l.paused ? ' (paused)' : ''}`
    : none;
  const sync = w.sync || {};
  $('sync-status').textContent = hint || sync.text || '';
  $('sync-status').className = `sync ${sync.cls || 'idle'}`;
  const ask = sync.askSame;
  $('same-ask').classList.toggle('hidden', !ask);
  if (ask) $('same-text').textContent = `You: “${ask.mine}” · ${S.call.partnerName}: “${ask.theirs}”`;
  const fp = sync.follow;
  $('follow-prompt').classList.toggle('hidden', !fp);
  if (fp) $('follow-text').textContent = `${S.call.partnerName} is watching ${fp.title}`;
  const btn = $('countdown-btn');
  $('resync-btn').disabled = !l;
  $('fullscreen-btn').disabled = !l;
  if (!sync.countdown) { btn.disabled = !l; btn.textContent = '3·2·1 play'; }
  else { btn.disabled = true; btn.textContent = 'Get comfy…'; }
}

function updateLink() {
  const want = !!(S && S.phase === 'ready' && S.call && S.call.status === 'active') && screen === 'main';
  if (want && !linked) { linked = true; video.start(); }
  else if (!want && linked) { linked = false; video.stop(); }
}

// ── Chat ───────────────────────────────────────────────────────
function addMessage(m) {
  const box = $('messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const mine = S && S.me && m.by === S.me.uid;
  let node;
  if (m.system) node = el('div', 'msg system', m.text);
  else {
    node = el('div', `msg ${mine ? 'mine' : 'theirs'}`);
    node.append(el('div', 'body', m.text), el('div', 'meta', fmtClock(m.at)));
  }
  node.dataset.at = m.at || Date.now();
  box.appendChild(node);
  if (nearBottom || mine) box.scrollTop = box.scrollHeight;
  renderSeen();
}

function renderSeen() {
  document.querySelectorAll('.seen-mark').forEach((n) => n.remove());
  const mine = document.querySelectorAll('.msg.mine');
  const last = mine[mine.length - 1];
  if (!last || !S || !S.view) return;
  if ((S.view.partnerSeen || 0) >= Number(last.dataset.at)) last.appendChild(el('div', 'seen-mark', 'Seen'));
}

function renderTyping() {
  const name = S.call ? S.call.partnerName : (friend(S.selected) || {}).name;
  $('typing').textContent = S.view && S.view.partnerTyping ? `${name} is typing…` : '';
}

function markSeen() {
  if (document.visibilityState === 'visible' && activeTab === 'chat') engine.post({ type: 'seen' });
}

function sendChat() {
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  $('emoji-picker').classList.add('hidden');
  quiet(act('chat', { text }));
}

function popReaction(emoji) {
  const pop = el('span', 'pop', emoji);
  pop.style.left = `${10 + Math.random() * 70}%`;
  $('reactions').appendChild(pop);
  setTimeout(() => pop.remove(), 1600);
}

// ── Watchlist and history ──────────────────────────────────────
function renderLists() {
  const v = S.view;
  if (!v) return;
  const inCall = !!(S.call && S.call.status === 'active');
  const wlKey = JSON.stringify([v.watchlist, inCall]);
  if (wlKey !== lastLists.wl) { lastLists.wl = wlKey; renderWatchlist(v.watchlist, inCall); }
  const hKey = JSON.stringify([v.history, inCall]);
  if (hKey !== lastLists.hist) { lastLists.hist = hKey; renderHistory(v.history, inCall); }
}

function renderWatchlist(items, inCall) {
  const ul = $('watchlist');
  ul.replaceChildren();
  items.sort((a, b) => (a.watched - b.watched) || ((b.at || 0) - (a.at || 0)));
  if (!items.length) {
    ul.appendChild(el('li', 'empty', 'Nothing here yet. Add what you\'re watching, or paste a link to something you both want to see.'));
    return;
  }
  for (const it of items) {
    const li = el('li', `item${it.watched ? ' done' : ''}`);
    const info = el('div', 'info');
    info.append(el('div', 'title', it.title), el('div', 'sub', `${M.SERVICE_NAMES[it.service] || ''} · added by ${it.addedBy || '?'}`));
    const btns = el('div', 'btns');
    const open = el('button', 'small primary', inCall ? 'Watch together' : 'Open');
    open.onclick = () => quiet(act('open', { url: it.url, title: it.title, position: 0 }, open));
    const done = el('button', 'small icon', it.watched ? '↺' : '✓');
    done.title = it.watched ? 'Move back to the list' : 'Mark as watched';
    done.onclick = () => quiet(act('watchlist-toggle', { key: it.key, watched: !it.watched }));
    const del = el('button', 'small icon', '✕');
    del.title = 'Remove';
    del.onclick = () => quiet(act('watchlist-remove', { key: it.key }));
    btns.append(open, done, del);
    li.append(info, btns);
    ul.appendChild(li);
  }
}

function renderHistory(items, inCall) {
  const ul = $('history');
  ul.replaceChildren();
  items.sort((a, b) => (b.at || 0) - (a.at || 0));
  $('history-clear').classList.toggle('hidden', !items.length);
  if (!items.length) {
    ul.appendChild(el('li', 'empty', 'What you watch together during calls shows up here, with where you stopped.'));
    return;
  }
  for (const it of items) {
    const li = el('li', 'item');
    const info = el('div', 'info');
    const where = it.duration ? `${M.fmtTime(it.position)} of ${M.fmtTime(it.duration)}` : `stopped at ${M.fmtTime(it.position)}`;
    info.append(el('div', 'title', it.title), el('div', 'sub', `${M.SERVICE_NAMES[it.service] || ''} · ${where} · ${fmtDay(it.at)}`));
    if (it.duration) {
      const bar = el('div', 'progress');
      const fill = el('span');
      fill.style.width = `${Math.min(100, (it.position / it.duration) * 100)}%`;
      bar.appendChild(fill);
      info.appendChild(bar);
    }
    const btns = el('div', 'btns');
    const resume = el('button', 'small primary', inCall ? 'Resume together' : 'Open');
    resume.onclick = () => quiet(act('open', { url: it.url, title: it.title, position: Math.max(0, (it.position || 0) - 5) }, resume));
    const del = el('button', 'small icon', '✕');
    del.title = 'Remove from history';
    del.onclick = () => quiet(act('history-remove', { key: it.key }));
    btns.append(resume, del);
    li.append(info, btns);
    ul.appendChild(li);
  }
}

// ── Settings ───────────────────────────────────────────────────
function renderSettings() {
  document.querySelectorAll('[data-setting]').forEach((cb) => { cb.checked = !!S.settings[cb.dataset.setting]; });
  $('account-line').textContent = `Signed in as ${S.me.username} · version ${S.version}`;
}

// ── Wiring ─────────────────────────────────────────────────────
async function doAuth() {
  $('auth-error').textContent = '';
  try {
    $('auth-go').disabled = true;
    await engine.request('enter', { username: $('auth-user').value });
  } catch (e) { $('auth-error').textContent = e.message; }
  finally { $('auth-go').disabled = false; }
}
$('auth-go').onclick = doAuth;
$('auth-user').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAuth(); });

$('settings-btn').onclick = () => { screen = 'settings'; render(); };
$('settings-back').onclick = () => { screen = 'main'; render(); };
document.querySelectorAll('[data-setting]').forEach((cb) => {
  cb.onchange = () => quiet(act('settings', { patch: { [cb.dataset.setting]: cb.checked } }));
});
$('signout-btn').onclick = () => { if (confirm('Sign out of WatchParty on this browser?')) { screen = 'main'; quiet(act('sign-out')); } };

const openPermission = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('panel/permission.html') });
  engine.post({ type: 'media-retry' });
};
$('perm-btn').onclick = openPermission;
$('perm-btn-2').onclick = openPermission;

$('add-btn').onclick = async () => {
  const u = $('add-user').value.trim();
  $('add-msg').textContent = '';
  try {
    await act('friend-request', { username: u }, $('add-btn'));
    $('add-user').value = '';
    $('add-msg').textContent = `Request sent. They'll see it next time they open WatchParty.`;
  } catch (e) { $('add-msg').textContent = e.message; }
};
$('add-user').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('add-btn').click(); });

$('incoming-yes').onclick = () => {
  const inc = S.incoming;
  if (inc) quiet(act('answer', { pairId: inc.pairId }, $('incoming-yes')));
};
$('incoming-no').onclick = () => {
  const inc = S.incoming;
  if (inc) quiet(act('decline', { pairId: inc.pairId }, $('incoming-no')));
};

$('back-btn').onclick = () => engine.post({ type: 'select', uid: null });
$('call-btn').onclick = () => quiet(act('call', { uid: S.selected }, $('call-btn')));
$('cancel-call').onclick = () => quiet(act('hangup'));
$('hangup-btn').onclick = () => quiet(act('hangup'));
$('mic-btn').onclick = () => quiet(act('mic'));
$('cam-btn').onclick = () => quiet(act('cam'));
$('unfriend-btn').onclick = () => {
  const f = friend(S.selected);
  if (f && confirm(`Remove ${f.name} from your friends? Your chat, watchlist and history together come back if you become friends again.`)) {
    quiet(act('unfriend', { uid: f.uid }).then(() => engine.post({ type: 'select', uid: null })));
  }
};

$('same-btn').onclick = () => quiet(act('confirm-same', {}, $('same-btn')));
$('follow-btn').onclick = () => engine.post({ type: 'follow' });
$('countdown-btn').onclick = () => quiet(act('countdown', {}, $('countdown-btn')));
// "Fullscreen" from here: the browser only allows real fullscreen after a
// click inside the video page, so the whole window goes fullscreen instead
// (like F11). The players fill the window, and the call window takes over.
$('fullscreen-btn').onclick = async () => {
  try {
    await act('focus-watch', {}, $('fullscreen-btn'));
    const w = await chrome.windows.getCurrent();
    await chrome.storage.local.set({ prevWindowState: { id: w.id, state: w.state } });
    await chrome.windows.update(w.id, { state: 'fullscreen' });
    window.close();
  } catch (e) { notice(e.message || 'Couldn\'t switch to fullscreen.'); }
};
$('resync-btn').onclick = () => quiet(act('resync', {}, $('resync-btn')).then(() => flash($('resync-btn'), 'Synced')));
for (const e of REACTIONS) {
  const b = el('button', 'react', e);
  b.title = `Send ${e}`;
  b.onclick = () => engine.post({ type: 'reaction', emoji: e });
  $('reactions').appendChild(b);
}

document.querySelectorAll('.tabs button').forEach((b) => {
  b.onclick = () => {
    activeTab = b.dataset.tab;
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${activeTab}`));
    markSeen();
  };
});

$('send-btn').onclick = sendChat;
$('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
let lastTyping = 0;
$('chat-input').addEventListener('input', () => {
  if (Date.now() - lastTyping > 1500) { lastTyping = Date.now(); engine.post({ type: 'typing' }); }
});
for (const e of CHAT_EMOJI) {
  const b = el('button', 'icon', e);
  b.onclick = () => { $('chat-input').value += e; $('chat-input').focus(); };
  $('emoji-picker').appendChild(b);
}
$('emoji-btn').onclick = () => $('emoji-picker').classList.toggle('hidden');

$('wl-add-current').onclick = () => quiet(act('watchlist-add', { current: true }, $('wl-add-current')).then(() => flash($('wl-add-current'), 'Added')));
$('wl-add').onclick = () => quiet(act('watchlist-add', { url: $('wl-url').value.trim(), title: $('wl-title').value }, $('wl-add'))
  .then(() => { $('wl-url').value = ''; $('wl-title').value = ''; }));
$('history-clear').onclick = () => { if (confirm('Clear your watch history with this friend?')) quiet(act('history-clear')); };

document.addEventListener('visibilitychange', () => {
  engine.post({ type: 'visibility', visible: document.visibilityState === 'visible' });
  markSeen();
});
