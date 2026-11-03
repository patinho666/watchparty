// WatchParty engine: an invisible page that runs for as long as the browser
// is open. It holds the Firebase connection, friends, calls, chat and sync.
// The side panel and the call window are just screens onto it.
// The work is split across the modules imported below.
import * as FB from '../vendor/firebase.js';
import { AWAY_MS, E, changed, friendName, noop, pairRef, partnerOf } from './core.js';
import { notify } from './notify.js';
import { init } from './accounts.js';
import { acceptFriend, declineFriend, selectFriend } from './friends.js';
import { answer, checkVisibility, computeIncoming, decline, endLocalCall, hangUp, startCall } from './calls.js';
import { onContentPort } from './tabs.js';
import { onViewPort } from './views.js';
import { startUpdates } from './update.js';

// ── Notification buttons (relayed by the background worker) ────
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.to !== 'engine' || msg.type !== 'notification' || !E.me) return;
  const [kind, arg] = msg.id.split(':');
  const b = msg.button;
  const run = (p) => Promise.resolve(p).catch((e) => notify('error', 'WatchParty', e.message));
  if (kind === 'call' && E.incoming && E.incoming.pairId === arg) {
    if (b === 0) run(answer(arg));
    else if (b === 1) run(decline(arg));
  } else if (kind === 'req') {
    if (b === 0) run(acceptFriend(arg));
    else if (b === 1) run(declineFriend(arg));
  } else if (kind === 'missed' && b === 0) {
    const uid = partnerOf(arg);
    if (E.friends[uid]) run(startCall(uid));
  } else if (kind === 'msg') {
    selectFriend(partnerOf(arg));
  } else if (kind === 'hidden' && b === 1) {
    run(hangUp());
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'wp-content') onContentPort(port);
  else if (port.name === 'wp-view') onViewPort(port);
});


// Housekeeping: ring time-outs, partner gone too long, typing indicator.
setInterval(() => {
  if (!E.me) return;
  computeIncoming();
  checkVisibility();
  const c = E.call;
  if (c && c.status === 'active' && c.awaySince && Date.now() - c.awaySince > AWAY_MS) {
    FB.remove(pairRef(c.pairId)('call')).catch(noop);
    endLocalCall(`${friendName(c.partnerUid)} disconnected`);
  }
  if (E.view || E.sync) changed();
}, 1000);

init();
startUpdates();
