// Background service worker. Keeps the engine (an invisible offscreen page)
// running, and does the things the engine can't: notifications, the toolbar
// badge, opening tabs and opening the side panel.
const ENGINE_URL = 'engine/engine.html';
let lastWindowId = null;

async function ensureEngine() {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts.length) return;
    await chrome.offscreen.createDocument({
      url: ENGINE_URL,
      reasons: ['WEB_RTC', 'USER_MEDIA'],
      justification: 'Keeps the WatchParty connection, call and playback sync running.'
    });
  } catch (e) {
    if (!String(e).includes('Only a single offscreen')) console.warn('[WatchParty] engine start failed', e);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  ensureEngine();
});
chrome.runtime.onStartup.addListener(ensureEngine);
ensureEngine();

chrome.windows.onFocusChanged.addListener((id) => { if (id !== chrome.windows.WINDOW_ID_NONE) lastWindowId = id; });

// Opening the side panel needs a recent click. Browsers differ in what they
// accept (Edge is stricter), so try the tab, then the window.
async function openPanel(windowId, tabId) {
  if (!chrome.sidePanel || !chrome.sidePanel.open) return false;
  const tries = [];
  if (tabId != null) tries.push({ tabId });
  const id = windowId ?? lastWindowId;
  if (id != null) tries.push({ windowId: id });
  for (const opts of tries) {
    try { await chrome.sidePanel.open(opts); return true; } catch {}
  }
  try {
    const w = await chrome.windows.getLastFocused();
    await chrome.sidePanel.open({ windowId: w.id });
    return true;
  } catch { return false; }
}

const toEngine = (msg) => chrome.runtime.sendMessage({ to: 'engine', ...msg }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.to !== 'bg') return;
  switch (msg.type) {
    case 'ensure-engine':
      ensureEngine().then(() => sendResponse(true));
      return true;
    case 'notify':
      chrome.notifications.create(msg.id, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: msg.title,
        message: msg.message || '',
        buttons: (msg.buttons || []).map((t) => ({ title: t })),
        requireInteraction: !!msg.sticky,
        silent: !!msg.silent,
        priority: 2
      }, () => void chrome.runtime.lastError);
      break;
    case 'clear-notify':
      chrome.notifications.clear(msg.id, () => void chrome.runtime.lastError);
      break;
    case 'badge':
      chrome.action.setBadgeText({ text: msg.text || '' }).catch(() => {});
      if (msg.color) chrome.action.setBadgeBackgroundColor({ color: msg.color }).catch(() => {});
      break;
    case 'navigate':
      if (msg.tabId != null) {
        chrome.tabs.update(msg.tabId, { url: msg.url, active: true }).catch(() => chrome.tabs.create({ url: msg.url }));
      } else chrome.tabs.create({ url: msg.url });
      break;
    case 'focus-tab':
      chrome.tabs.update(msg.tabId, { active: true }).catch(() => {});
      break;
    case 'restore-window': {
      // Undo the "fullscreen from the sidebar" window mode.
      const id = sender.tab ? sender.tab.windowId : lastWindowId;
      if (id == null) break;
      chrome.storage.local.get('prevWindowState').then(({ prevWindowState: prev }) => {
        chrome.windows.get(id).then((w) => {
          if (w.state !== 'fullscreen') return;
          const state = prev && prev.id === id && prev.state !== 'fullscreen' ? prev.state : 'maximized';
          chrome.windows.update(id, { state }).catch(() => {});
        }).catch(() => {});
      });
      break;
    }
    case 'window-states': {
      // Used by the privacy rule: is the call window's browser window minimized?
      Promise.all((msg.ids || []).map((id) => chrome.windows.get(id).then((w) => [id, w.state]).catch(() => [id, 'gone'])))
        .then((pairs) => sendResponse(Object.fromEntries(pairs)));
      return true;
    }
    case 'reload-extension':
      chrome.runtime.reload();
      break;
    case 'open-url':
      chrome.tabs.create({ url: msg.url });
      break;
    case 'open-panel':
      openPanel(sender.tab ? sender.tab.windowId : null, sender.tab ? sender.tab.id : null).then(sendResponse);
      return true;
  }
});

chrome.notifications.onButtonClicked.addListener((id, button) => {
  // Answering or opening should bring up the app right away.
  if ((id.startsWith('call:') && button === 0) || (id === 'hidden' && button === 0)) openPanel();
  toEngine({ type: 'notification', id, button });
  chrome.notifications.clear(id);
});

chrome.notifications.onClicked.addListener((id) => {
  openPanel();
  toEngine({ type: 'notification', id, button: -1 });
  chrome.notifications.clear(id);
});
