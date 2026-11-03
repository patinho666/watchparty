// Toolbar badge, Windows notifications and the ringtone.
import { E, bg } from './core.js';
import { isUnread } from './views.js';

// ── Badge and notifications ────────────────────────────────────
export let badgeKey = '';
export function updateBadge() {
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

export const notify = (id, title, message, buttons = [], sticky = false) => bg({ type: 'notify', id, title, message, buttons, sticky });
export const clearNotify = (id) => bg({ type: 'clear-notify', id });

export let ring = null;
export function startRing() {
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

export function stopRing() {
  if (!ring) return;
  clearInterval(ring.timer);
  ring.ctx.close().catch(() => {});
  ring = null;
}
