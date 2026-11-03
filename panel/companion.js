// The call window on top of the video, shown whenever the side panel isn't open.
import { connectEngine } from '../shared/client.js';
import { createVideoView } from '../shared/video-view.js';

const $ = (id) => document.getElementById(id);
const REACTIONS = ['❤️', '😂', '😮', '😢', '😱', '👏', '🔥', '🍿'];
let state = null;
let chatOpen = false;
let minimized = false;
let linked = false;
let unread = false;
let pairId = null;
let previewTimer = null;
let miniText = null;

const engine = connectEngine('companion', {
  onState: (s) => { state = s; render(); },
  onMessage: (m) => {
    if (video.handle(m)) return;
    if (m.type === 'messages') { pairId = m.pairId; $('messages').replaceChildren(); m.list.forEach((x) => addMessage(x, false)); }
    else if (m.type === 'message' && m.pairId === pairId) addMessage(m.msg, true);
  },
  onDisconnect: () => { linked = false; }
});

const video = createVideoView((msg) => engine.post(msg), { remote: $('remote'), local: $('local'), onChange: render });

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function addMessage(m, live) {
  const box = $('messages');
  const mine = state && state.me && m.by === state.me.uid;
  box.appendChild(el('div', m.system ? 'msg system' : `msg ${mine ? 'mine' : 'theirs'}`, m.text));
  while (box.children.length > 60) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
  if (live && !m.system && !mine && !chatOpen) showPreview(m);
}

// New message while the chat is closed: show it inside this window.
function showPreview(m) {
  unread = true;
  const name = (state && state.call && state.call.partnerName) || m.name || '';
  const p = $('preview');
  p.replaceChildren(el('strong', null, `${name}: `), document.createTextNode(m.text));
  p.classList.remove('hidden');
  miniText = `${name}: ${m.text}`;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => { p.classList.add('hidden'); miniText = null; render(); }, 7000);
  render();
}

// Tell the page how tall the window's fixed part is, so it can size the frame.
function reportSize() {
  let base;
  if (minimized) base = $('bar').offsetHeight + $('mini').offsetHeight;
  else base = ['bar', 'stage', 'controls', 'reactions'].reduce((h, id) => h + $(id).offsetHeight, 0);
  if (!base || $('card').classList.contains('hidden')) return; // not laid out yet: keep the current size
  parent.postMessage({ __wpCompanion: 'size', base: Math.ceil(base), chatOpen, minimized }, '*');
}

function render() {
  const c = state && state.call;
  const active = !!(c && c.status === 'active');
  $('card').classList.toggle('hidden', !active);
  if (!active) { if (linked) { video.stop(); linked = false; } return; }
  if (!linked) { linked = true; video.start(); }

  const name = c.partnerName;
  $('who').textContent = `In call with ${name}`;
  $('body').classList.toggle('hidden', minimized);
  $('minimize').textContent = minimized ? '▢' : '–';
  $('minimize').title = minimized ? 'Show video and chat' : 'Make smaller';
  $('mini').classList.toggle('hidden', !minimized);
  $('mini-text').textContent = miniText || (c.micOn ? 'Mic on' : 'Mic muted');
  $('mini-unread').classList.toggle('hidden', !unread);

  $('initial').textContent = (name || '?').slice(0, 1).toUpperCase();
  $('placeholder').classList.toggle('hidden', !!(c.partnerCam && c.hasRemote));
  $('local').classList.toggle('hidden', !c.camOn);
  const notes = [];
  if (!c.partnerMic) notes.push('muted');
  if (c.conn === 'reconnecting' || c.partnerAway) notes.push('reconnecting…');
  else if (c.conn !== 'connected') notes.push('connecting…');
  $('label').textContent = notes.length ? `${name}: ${notes.join(', ')}` : '';

  for (const id of ['mic', 'mini-mic']) {
    $(id).textContent = c.micOn ? '🎙️' : '🔇';
    $(id).title = c.micOn ? 'Mute microphone' : 'Unmute microphone';
  }
  $('cam').classList.toggle('off', !c.camOn);
  $('cam').disabled = !c.hasCam;
  $('cam').title = c.camOn ? 'Turn camera off' : 'Turn camera on';
  $('chat').classList.toggle('hidden', !chatOpen);
  $('unread').classList.toggle('hidden', !unread);
  const w = state.watch || {};
  $('countdown').disabled = !!(w.sync && w.sync.countdown) || !w.local;
  $('resync').disabled = !w.local;
  const ask = w.sync && w.sync.askSame;
  $('ask').classList.toggle('hidden', !ask);
  if (ask) $('ask-text').textContent = `“${ask.mine}” / “${ask.theirs}”`;
  requestAnimationFrame(reportSize);
}

function act(type, data) {
  engine.request(type, data).catch((e) => { $('label').textContent = e.message; });
}

function setChat(open) {
  chatOpen = open;
  unread = false;
  $('preview').classList.add('hidden');
  miniText = null;
  engine.post({ type: 'chat-visible', on: chatOpen });
  render();
  if (chatOpen) setTimeout(() => { $('chat-input').focus(); $('messages').scrollTop = 1e9; }, 0);
}

// ── Wiring ─────────────────────────────────────────────────────
for (const id of ['mic', 'mini-mic']) $(id).onclick = () => act('mic');
$('cam').onclick = () => act('cam');
for (const id of ['hangup', 'mini-hangup']) $(id).onclick = () => act('hangup');
$('countdown').onclick = () => act('countdown');
$('resync').onclick = () => act('resync');
$('ask-btn').onclick = () => act('confirm-same');
$('chat-toggle').onclick = () => setChat(!chatOpen);
$('preview').onclick = () => setChat(true);
// "–" switches between the small bar and the full window; it never closes anything.
$('minimize').onclick = () => {
  minimized = !minimized;
  if (!minimized && unread) setChat(true); else render();
};
$('expand').onclick = () => { minimized = false; if (unread) setChat(true); else render(); };

// Drag the window by its top bar (the page does the actual moving).
$('bar').addEventListener('pointerdown', (e) => {
  if (e.target.closest('button') || e.button !== 0) return;
  e.preventDefault();
  parent.postMessage({ __wpCompanion: 'drag', sx: e.screenX, sy: e.screenY }, '*');
});

const sendChat = () => {
  const t = $('chat-input').value.trim();
  if (!t) return;
  $('chat-input').value = '';
  act('chat', { text: t });
};
$('send').onclick = sendChat;
$('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendChat(); } });
let lastTyping = 0;
$('chat-input').addEventListener('input', () => {
  if (Date.now() - lastTyping > 1500) { lastTyping = Date.now(); engine.post({ type: 'typing' }); }
});

for (const e of REACTIONS) {
  const b = el('button', null, e);
  b.title = `Send ${e}`;
  b.onclick = () => act('reaction', { emoji: e });
  $('reactions').appendChild(b);
}

// Opening the side panel needs this click. If the browser refuses (Edge can),
// say how to open it instead of doing nothing.
let windowId = null, tabId = null;
if (chrome.windows && chrome.windows.getCurrent) chrome.windows.getCurrent().then((w) => { windowId = w.id; }).catch(() => {});
if (chrome.tabs && chrome.tabs.getCurrent) chrome.tabs.getCurrent().then((t) => { if (t) tabId = t.id; }).catch(() => {});

function showHint(text) {
  const p = $('preview');
  p.replaceChildren(document.createTextNode(text));
  p.classList.remove('hidden');
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => p.classList.add('hidden'), 9000);
}

$('open-app').onclick = () => {
  parent.postMessage({ __wpCompanion: 'exit-fullscreen' }, '*');
  chrome.runtime.sendMessage({ to: 'bg', type: 'restore-window' }).catch(() => {});
  const viaBg = () => chrome.runtime.sendMessage({ to: 'bg', type: 'open-panel' }).catch(() => false);
  if (chrome.sidePanel && chrome.sidePanel.open) {
    const opts = tabId != null ? { tabId } : windowId != null ? { windowId } : null;
    if (opts) chrome.sidePanel.open(opts).catch(viaBg); else viaBg();
  } else viaBg();
  setTimeout(() => {
    if (state && !state.panelOpen) showHint('This browser didn\'t let WatchParty open its sidebar from here. Click the WatchParty icon in the toolbar to open it.');
  }, 1800);
};

// The engine ends the call if neither this window nor the side panel can be seen.
const reportVisibility = () => engine.post({ type: 'visibility', visible: document.visibilityState === 'visible' });
document.addEventListener('visibilitychange', reportVisibility);
setTimeout(reportVisibility, 300);

new ResizeObserver(() => reportSize()).observe(document.body);
