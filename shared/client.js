// Connection from a screen (side panel or companion) to the engine.
export function connectEngine(kind, { onState, onMessage, onDisconnect }) {
  let port = null;
  let seq = 0;
  const waiting = new Map();

  function open() {
    chrome.runtime.sendMessage({ to: 'bg', type: 'ensure-engine' }).catch(() => {});
    port = chrome.runtime.connect({ name: 'wp-view' });
    port.onMessage.addListener((m) => {
      if (m.type === 'state') onState(m.state);
      else if (m.type === 'result') {
        const w = waiting.get(m.id);
        if (w) { waiting.delete(m.id); m.ok ? w.resolve(m.data) : w.reject(new Error(m.error)); }
      } else onMessage && onMessage(m);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
      for (const w of waiting.values()) w.reject(new Error('Lost connection to WatchParty. Try again.'));
      waiting.clear();
      onDisconnect && onDisconnect();
      setTimeout(open, 1000);
    });
    post({ type: 'hello', kind });
  }

  function post(msg) { if (port) try { port.postMessage(msg); } catch {} }

  function request(type, data = {}) {
    return new Promise((resolve, reject) => {
      if (!port) { reject(new Error('Still connecting to WatchParty. Try again in a moment.')); return; }
      const id = ++seq;
      waiting.set(id, { resolve, reject });
      post({ type, id, ...data });
    });
  }

  open();
  return { post, request, reconnectHello: () => post({ type: 'hello', kind }) };
}
