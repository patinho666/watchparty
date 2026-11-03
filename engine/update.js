// Updates: is a newer WatchParty published on GitHub? And were this folder's
// files replaced (by the Update button or by update.bat)? Then restart the
// extension, waiting until any call is over.
import { E, VERSION, bg, changed, log, noop } from './core.js';
import { notify } from './notify.js';

const CHECK_EVERY_MS = 3 * 3600 * 1000;
let source = null;

// "3.0.10" > "3.0.9"
export function newer(a, b) {
  const pa = String(a || '').split('.').map(Number), pb = String(b || '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

export async function checkForUpdate(manual) {
  try {
    if (!source) source = await (await fetch('../update-source.json')).json();
    const url = `https://raw.githubusercontent.com/${source.repo}/${source.branch}/manifest.json?t=${Date.now()}`;
    const latest = (await (await fetch(url, { cache: 'no-store' })).json()).version;
    const was = E.update && E.update.latest;
    E.update = { latest, current: VERSION, available: newer(latest, VERSION), checkedAt: Date.now() };
    if (E.update.available && was !== latest) {
      log(`version ${latest} is available`);
      notify('update', 'WatchParty update available', `Version ${latest} is ready. Open WatchParty and click Update.`);
    }
  } catch (e) {
    E.update = { ...(E.update || {}), error: 'Could not check for updates', checkedAt: Date.now() };
    if (manual) log(`update check failed: ${e.message}`);
  }
  changed();
}

// The files on disk changed version: restart to run the new code.
async function watchDisk() {
  if (!VERSION) return;
  try {
    const onDisk = (await (await fetch('../manifest.json', { cache: 'no-store' })).json()).version;
    if (onDisk && onDisk !== VERSION) {
      if (!E.pendingReload) log(`new files on disk (version ${onDisk}); restarting ${E.call ? 'after the call' : 'now'}`);
      E.pendingReload = onDisk;
      changed();
      if (!E.call) setTimeout(() => bg({ type: 'reload-extension' }), 1500);
    }
  } catch { /* ignore */ }
}

export function startUpdates() {
  setTimeout(() => checkForUpdate(false), 15000);
  setInterval(() => checkForUpdate(false), CHECK_EVERY_MS);
  setInterval(() => watchDisk().catch(noop), 30000);
}
