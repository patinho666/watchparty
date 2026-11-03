// Playback sync for the friend you're in a call with.
//
// Rules during a call:
// - Whoever acted last is the leader; the other player follows.
// - Both of you are always on the same title: when one opens something,
//   the other's browser goes there too (opening a tab if needed).
// - Nobody plays alone: the video only plays while both of you have the
//   same video open. Otherwise it's held paused, and once you're both
//   there again a 3·2·1 countdown starts you together.
const DRIFT_LIMIT = 1.5;   // seconds apart before correcting
const NUDGE_LIMIT = 0.8;   // above this: play slightly faster/slower to catch up
const JUMP_LIMIT = 3;      // above this: jump straight to the right spot
const HEARTBEAT_MS = 5000;

// ctx: { FB, pref, me, partnerUid, myName(), partnerName(), partnerStatus(), serverNow(),
//        local() → { snap, at, watchTabId, streamTabId }, sendWatch(msg), navigate(url, tabId),
//        settings(), onChange(), onReaction(emoji, name) }
export function createSync(ctx) {
  const { FB, pref, me, partnerUid } = ctx;
  const M = globalThis.WPMedia;
  const S = {
    playback: null, here: {}, myHereKey: '', lastApplyAt: 0, lastNav: { url: null, at: 0 },
    lastSeekMsgAt: 0, handledCountdown: null, handledOpen: null, bufferingPaused: false,
    recheckUntil: 0, countdownEndsAt: 0, followedHereAt: 0, autoStartSeq: null, banner: null,
    confirmed: null, mismatchSince: 0, primeFallback: null, nudgeUntil: 0,
    startedAt: ctx.serverNow()
  };
  const unsubs = [];
  const timers = [];

  function expected(pb) {
    if (!pb) return 0;
    const elapsed = pb.state === 'playing' ? Math.max(0, ctx.serverNow() - (pb.at || 0)) / 1000 : 0;
    return (Number(pb.position) || 0) + elapsed;
  }

  // The watch tab may be in the background and report only now and then, so
  // "has the video open" means "the page is connected and last said so", and
  // the position is estimated from the last report when it's not recent.
  const rawLoc = () => ctx.local().snap;
  const fresh = () => Date.now() - ctx.local().at < 5000;
  const hasLocalVideo = () => { const l = rawLoc(); return !!(l && l.hasVideo && l.mediaId && ctx.local().watchTabId != null); };
  const loc = () => {
    const l = rawLoc();
    if (!l) return l;
    const age = (Date.now() - ctx.local().at) / 1000;
    if (l.paused || age < 1.5) return l;
    const pos = l.position + age;
    return { ...l, position: l.duration ? Math.min(pos, l.duration) : pos };
  };

  function systemMsg(text) {
    FB.push(pref('messages'), { system: true, text, by: me, at: FB.serverTimestamp() }).catch(() => {});
  }

  function writePlayback(f, explicit) {
    const l = loc() || {};
    const pb = {
      state: f.state,
      position: Number(f.position) || 0,
      at: f.at ?? FB.serverTimestamp(),
      by: me,
      seq: explicit ? Date.now() : (S.playback && S.playback.seq) || 0,
      reason: f.reason || '',
      want: f.want || null,  // 'playing': someone wants to play once you're both there
      mediaId: f.mediaId ?? l.mediaId ?? null,
      url: f.url ?? l.url ?? null,
      title: f.title ?? l.title ?? null,
      service: f.service ?? l.service ?? null
    };
    S.playback = { ...pb, at: typeof pb.at === 'number' ? pb.at : ctx.serverNow() };
    return FB.set(pref('playback'), pb).catch((e) => console.warn('[WatchParty] playback write failed', e));
  }

  function applyToLocal(pb, tolerance) {
    if (ctx.local().watchTabId == null) return;
    S.lastApplyAt = Date.now();
    ctx.sendWatch({ cmd: 'apply', state: pb.state, position: expected(pb), sentAt: Date.now(), tolerance });
  }

  function holdLocal() {
    const l = loc();
    if (!l || !hasLocalVideo()) return;
    if (!l.paused) ctx.sendWatch({ cmd: 'apply', state: 'paused', position: l.position, sentAt: Date.now(), tolerance: 99 });
  }

  // A Prime Video address from another country opens a page without the
  // episodes here, so it becomes a search for the series on our own Prime site.
  function primeSearch(origin, title) {
    const series = String(title || '').split(' – ')[0].trim();
    if (!series) return `${origin}/`;
    const q = encodeURIComponent(series);
    return origin.includes('primevideo.com') ? `${origin}/search/ref=atv_nb_sr?phrase=${q}` : `${origin}/gp/video/search/ref=atv_nb_sr?phrase=${q}`;
  }

  function regional(url, title) {
    if (M.serviceFromUrl(url) !== 'prime') return url;
    const mine = ctx.primeOrigin && ctx.primeOrigin();
    let origin;
    try { origin = new URL(url).origin; } catch { return url; }
    if (mine && mine !== origin) return primeSearch(mine, title);
    if (!mine) {
      // We don't know this browser's Prime site yet. Try the friend's link (right
      // when you're in the same country); if no video shows up, fall back to a
      // search on the other Prime site (see checkPrimeFallback).
      S.primeFallback = { at: Date.now(), origin, title };
    }
    return url;
  }

  // The friend's Prime link opened a page without a video (another country's
  // catalogue): search for the series on the other Prime site instead.
  function checkPrimeFallback() {
    const f = S.primeFallback;
    if (!f) return;
    if (hasLocalVideo()) { S.primeFallback = null; return; }
    if (Date.now() - f.at < 12000) return;
    S.primeFallback = null;
    const known = ctx.primeOrigin && ctx.primeOrigin();
    const target = known && known !== f.origin ? known
      : (f.origin.includes('primevideo.com') ? 'https://www.amazon.com' : 'https://www.primevideo.com');
    S.lastNav = { url: null, at: 0 };
    const l = ctx.local();
    ctx.navigate(primeSearch(target, f.title), l.watchTabId ?? l.streamTabId);
  }

  function navigate(url, title) {
    if (!url) return;
    url = regional(url, title);
    if (S.lastNav.url === url && Date.now() - S.lastNav.at < 20000) return;
    S.lastNav = { url, at: Date.now() };
    const l = ctx.local();
    ctx.navigate(url, l.watchTabId ?? l.streamTabId); // no tab yet: the background opens one
  }

  // ── Who has the video open ───────────────────────────────────
  function publishHere() {
    const l = loc();
    // Having the video open doesn't depend on knowing the exact position yet.
    const v = hasLocalVideo() ? { mediaId: l.mediaId, url: l.url, title: l.title || '', prime: l.prime || null } : null;
    const key = v ? `${v.mediaId}|${v.prime ? `${v.prime.s}-${v.prime.e}-${v.prime.dur ? 1 : 0}` : ''}` : '';
    if (key === S.myHereKey) return;
    S.myHereKey = key;
    S.here[me] = v ? { ...v, at: ctx.serverNow() } : null;
    if (v) FB.set(pref(`here/${me}`), { ...v, at: FB.serverTimestamp() }).catch(() => {});
    else FB.remove(pref(`here/${me}`)).catch(() => {});
    enforce();
  }

  // Is this the same video? Tried in order, each step only when the one
  // before didn't settle it:
  //   1. the same id (same address, or on Prime the same series name + episode);
  //   2. Prime in different languages: same season, episode and running time;
  //   3. you both confirmed it ("Yes, sync us").
  const DUR_TOLERANCE = 20; // seconds; regions can differ slightly
  function sameEntries(a, b) {
    if (!a || !b) return false;
    const c = S.confirmed;
    const confirmed = !!(c && ((c.a === a.mediaId && c.b === b.mediaId) || (c.a === b.mediaId && c.b === a.mediaId)));
    const pa = a.prime, pb2 = b.prime;
    const bothDur = !!(pa && pb2 && pa.dur && pb2.dur);
    const durOk = !bothDur || Math.abs(pa.dur - pb2.dur) <= DUR_TOLERANCE;
    // 1. Same id, unless both running times are known and clearly differ
    //    (a different cut of the episode, or an episode we couldn't read).
    if (a.mediaId === b.mediaId && durOk) return true;
    // 2. Different names (languages), same season, episode and running time.
    if (bothDur && durOk && pa.s === pb2.s && pa.e === pb2.e) return true;
    // 3. You both said it's the same.
    return confirmed;
  }
  // Same check for two ids (e.g. the room's video and mine), using what each side reported.
  function same(x, y) {
    if (!x || !y) return false;
    if (x === y) return true;
    const entries = Object.values(S.here).filter(Boolean);
    const ex = entries.find((e) => e.mediaId === x), ey = entries.find((e) => e.mediaId === y);
    return sameEntries(ex, ey);
  }
  const bothHere = () => sameEntries(S.here[me], S.here[partnerUid]);

  // Applies the rules above; runs whenever anything relevant changes.
  function enforce() {
    const pb = S.playback;
    const mine = S.here[me];
    const theirs = S.here[partnerUid];
    const l = loc();

    // Same title: go where the leader (or the partner) is.
    if (theirs && (!mine || !sameEntries(mine, theirs))) {
      const target = pb && pb.mediaId && !same(pb.mediaId, mine && mine.mediaId) && same(pb.mediaId, theirs.mediaId) ? pb : theirs;
      const theirNewer = (theirs.at || 0) > S.followedHereAt;
      let leaderIsThem = !mine || !pb || pb.by !== me || same(pb.mediaId, theirs.mediaId);
      // Both on different titles and neither is the room's: one fixed side gives way.
      if (mine && pb && !same(pb.mediaId, mine.mediaId) && !same(pb.mediaId, theirs.mediaId)) leaderIsThem = me > partnerUid;
      if (theirNewer && leaderIsThem && target.url) {
        S.followedHereAt = theirs.at || ctx.serverNow();
        navigate(target.url, target.title);
      }
    }

    // Already together: closing the video later doesn't reopen it until the
    // friend opens something new.
    if (bothHere()) S.followedHereAt = Math.max(S.followedHereAt, theirs.at || 0);

    if (!bothHere()) {
      // Nobody plays alone.
      if (mine) {
        holdLocal();
        if (pb && pb.state === 'playing' && same(pb.mediaId, mine.mediaId)) {
          writePlayback({ state: 'paused', position: l ? l.position : expected(pb), reason: 'hold', want: 'playing' }, true);
        }
      }
    } else if (pb && pb.state === 'paused' && pb.want === 'playing' && !countdownRunning() && S.autoStartSeq !== pb.seq) {
      // Both here and someone wanted to play: start together. One side starts it.
      S.autoStartSeq = pb.seq;
      if (me < partnerUid) startCountdown().catch(() => {});
    }
    updateBanner();
    ctx.onChange();
  }

  // Both have a video open, the automatic checks say "different", for a while:
  // ask the two of you (step 3).
  function askSame() {
    const a = S.here[me], b = S.here[partnerUid];
    if (!a || !b || sameEntries(a, b)) { S.mismatchSince = 0; return null; }
    if (!S.mismatchSince) S.mismatchSince = Date.now();
    if (Date.now() - S.mismatchSince < 10000) return null;
    return { mine: a.title || 'your video', theirs: b.title || 'their video' };
  }

  async function confirmSame() {
    const a = S.here[me], b = S.here[partnerUid];
    if (!a || !b) throw new Error(`${ctx.partnerName()} doesn't have a video open.`);
    await FB.set(pref('same'), { a: a.mediaId, b: b.mediaId, by: me, at: FB.serverTimestamp() });
    systemMsg(`${ctx.myName()} confirmed you're watching the same thing`);
  }

  function updateBanner() {
    const pb = S.playback;
    const name = ctx.partnerName();
    let text = null;
    if (S.here[me] && !bothHere()) {
      const theirs = S.here[partnerUid];
      text = theirs ? `Paused until ${name} catches up…` : `Paused until ${name} opens the video`;
    } else if (pb && pb.by !== me && pb.reason === 'buffer' && pb.state === 'paused') {
      text = `Waiting for ${name} to catch up…`;
    }
    if (text !== S.banner) { S.banner = text; ctx.sendWatch({ cmd: 'banner', text }); }
  }

  const countdownRunning = () => S.countdownEndsAt > Date.now();

  // ── Room listeners ───────────────────────────────────────────
  function onPlayback(pb) {
    const prev = S.playback;
    S.playback = pb;
    if (!pb) { enforce(); return; }
    if (pb.by !== me) {
      const l = loc();
      if (pb.mediaId && (!l || !same(l.mediaId, pb.mediaId))) {
        const recent = ctx.serverNow() - (pb.at || 0) < 15000 || pb.reason === 'resync' || pb.reason === 'open';
        if (recent) navigate(pb.url, pb.title);
      } else if (l && hasLocalVideo()) {
        if (pb.state === 'playing' && !bothHere()) holdLocal();
        else {
          const explicitChange = !prev || prev.seq !== pb.seq;
          // A real action (play, pause, jump) is applied exactly; a routine
          // position update only fixes big differences (small ones are caught
          // up smoothly in onStatus).
          applyToLocal(pb, explicitChange ? 0.5 : JUMP_LIMIT);
          if (explicitChange) S.recheckUntil = Date.now() + 6000;
        }
      }
    }
    enforce();
  }

  function onHere(v) {
    S.here = v || {};
    if (!S.here[me] && S.myHereKey) S.here[me] = { mediaId: S.myHereKey }; // our write may still be in flight
    enforce();
  }

  function onReaction(v) {
    if (!v || ctx.serverNow() - (v.at || 0) > 8000) return;
    const name = v.by === me ? ctx.myName() : (v.name || ctx.partnerName());
    ctx.sendWatch({ cmd: 'reaction', emoji: v.emoji, name });
    ctx.onReaction && ctx.onReaction(v.emoji, name);
  }

  function onCountdown(c) {
    if (!c || c.id === S.handledCountdown) return;
    const delay = c.startAt - ctx.serverNow();
    if (delay < 300) return;
    S.handledCountdown = c.id;
    S.countdownEndsAt = Date.now() + delay;
    ctx.sendWatch({ cmd: 'countdown', delay, position: c.position });
    ctx.onChange();
    timers.push(setTimeout(() => { S.countdownEndsAt = 0; ctx.onChange(); }, delay + 800));
    if (c.by === me) {
      timers.push(setTimeout(() => {
        if (!bothHere()) return; // someone left during the countdown
        writePlayback({ state: 'playing', position: c.position, at: c.startAt, reason: 'countdown-go' }, true);
      }, delay));
    }
  }

  function onOpen(o) {
    if (!o || o.id === S.handledOpen) return;
    S.handledOpen = o.id;
    if (o.by === me || ctx.serverNow() - (o.at || 0) > 20000) return;
    navigate(o.url, o.title);
  }

  // ── Events from the watch tab ────────────────────────────────
  function onStatus(st) {
    publishHere();
    const pb = S.playback;
    if (!bothHere()) { if (!st.paused) holdLocal(); return; }
    const cooldown = Date.now() < S.recheckUntil ? 1500 : 4000;
    if (pb && pb.by !== me && pb.mediaId && same(pb.mediaId, st.mediaId) && !st.buffering && !st.settling &&
        Date.now() - S.lastApplyAt > cooldown && !countdownRunning()) {
      const delta = expected(pb) - st.position;   // > 0: I'm behind
      const off = Math.abs(delta);
      const wrongState = (pb.state === 'paused') !== st.paused;
      if (wrongState || off > JUMP_LIMIT) applyToLocal(pb, 1.0);
      else if (off > NUDGE_LIMIT && pb.state === 'playing' && Date.now() > S.nudgeUntil) {
        // Small difference: catch up smoothly instead of jumping.
        ctx.sendWatch({ cmd: 'nudge', delta });
        S.nudgeUntil = Date.now() + Math.min(40000, (off / 0.08) * 1000) + 2000;
      }
    }
  }

  function onReady(st) {
    publishHere();
    if (!st.mediaId) return;
    const pb = S.playback;
    if (pb && same(pb.mediaId, st.mediaId)) {
      // Freshly loaded player: snap to the room, and keep checking for a few
      // seconds, since a player that's still starting up can ignore the first seek.
      if (bothHere() || pb.state === 'paused') applyToLocal(pb, pb.by === me ? 1.5 : 0.5);
      else holdLocal();
      S.recheckUntil = Date.now() + 10000;
      enforce();
      return;
    }
    if (Date.now() - S.lastNav.at < 15000 && pb && pb.mediaId && !same(pb.mediaId, st.mediaId) &&
        (M.mediaIdFromUrl(S.lastNav.url) === pb.mediaId || pb.service === 'prime')) return;
    // I opened something new: everyone goes here, paused until both have it open.
    const playing = !st.paused;
    if (playing) holdLocal();
    writePlayback({ state: 'paused', position: st.position, reason: 'media', want: playing ? 'playing' : null }, true);
    systemMsg(`${ctx.myName()} opened ${st.title || 'something new'}`);
    enforce();
  }

  function onLocal(ev) {
    if (!ev.mediaId) return;
    const state = ev.action === 'pause' ? 'paused' : ev.action === 'play' ? 'playing' : (ev.paused ? 'paused' : 'playing');
    if (state === 'playing' && !bothHere()) {
      // Can't play alone: keep it paused and remember the wish to play.
      holdLocal();
      writePlayback({ state: 'paused', position: ev.position, reason: 'hold', want: 'playing' }, true);
      enforce();
      return;
    }
    writePlayback({ state, position: ev.position, reason: ev.action }, true);
    const at = M.fmtTime(ev.position);
    if (ev.action === 'play') systemMsg(`${ctx.myName()} pressed play at ${at}`);
    else if (ev.action === 'pause') { systemMsg(`${ctx.myName()} paused at ${at}`); writeHistory(); }
    else if (Date.now() - S.lastSeekMsgAt > 2500) { S.lastSeekMsgAt = Date.now(); systemMsg(`${ctx.myName()} jumped to ${at}`); }
  }

  function onBuffering(ev) {
    const pb = S.playback;
    if (ev.on) {
      if (pb && pb.state === 'playing' && same(pb.mediaId, ev.mediaId)) {
        S.bufferingPaused = true;
        writePlayback({ state: 'paused', position: ev.position, reason: 'buffer' }, true);
      }
    } else if (S.bufferingPaused) {
      S.bufferingPaused = false;
      if (pb && pb.by === me && pb.reason === 'buffer' && bothHere()) {
        writePlayback({ state: 'playing', position: ev.position, reason: 'buffer-end' }, true);
      }
    }
  }

  // The watch tab closed or left the video.
  function onLocalGone() { publishHere(); }

  // The page was paused by the site while hidden: put it back where the room is.
  function reapply() {
    const pb = S.playback, l = rawLoc();
    if (!pb || !l || !same(pb.mediaId, l.mediaId)) return;
    if (pb.state === 'playing' && !bothHere()) return;
    applyToLocal(pb, 1.0);
    S.recheckUntil = Date.now() + 6000;
  }

  // ── Actions ──────────────────────────────────────────────────
  function sendReaction(emoji) {
    FB.push(pref('reactions'), { emoji, by: me, name: ctx.myName(), at: FB.serverTimestamp() }).catch(() => {});
  }

  async function startCountdown() {
    const l = loc();
    if (!l || !l.mediaId) throw new Error('Open a show first.');
    if (!bothHere()) throw new Error(`${ctx.partnerName()} needs to open the video first.`);
    const position = l.position;
    await writePlayback({ state: 'paused', position, reason: 'countdown' }, true);
    await FB.set(pref('countdown'), { id: crypto.randomUUID(), startAt: ctx.serverNow() + 4000, position, by: me });
  }

  async function openForBoth(url, title, position = 0) {
    const mediaId = M.mediaIdFromUrl(url);
    if (mediaId) {
      await writePlayback({ state: 'paused', position, reason: 'open', mediaId, url, title, service: M.serviceFromUrl(url), want: 'playing' }, true);
    }
    await FB.set(pref('open'), { id: crypto.randomUUID(), url, title: title || '', by: me, at: FB.serverTimestamp() });
    S.lastNav = { url: null, at: 0 };
    navigate(url, title);
    systemMsg(`${ctx.myName()} opened ${title || 'a new title'} for both of you`);
  }

  async function resync() {
    const l = loc();
    if (!l || !l.mediaId) throw new Error('Open a show first.');
    const playing = !l.paused && bothHere();
    await writePlayback({ state: playing ? 'playing' : 'paused', position: l.position, reason: 'resync', want: !l.paused && !playing ? 'playing' : null }, true);
    systemMsg(`${ctx.myName()} synced you both to ${M.fmtTime(l.position)}`);
  }

  function followPartner() {
    const t = S.here[partnerUid];
    const p = ctx.partnerStatus();
    const url = (t && t.url) || (p && p.watching && p.watching.url);
    if (!url) return;
    S.lastNav = { url: null, at: 0 };
    navigate(url, (t && t.title) || (p && p.watching && p.watching.title));
  }

  function writeHistory() {
    const l = loc();
    if (!l || !l.mediaId || l.settling) return;
    const key = M.keyFromMediaId(l.mediaId);
    const entry = {
      mediaId: l.mediaId, title: l.title || 'Untitled', url: l.url, service: l.service,
      position: l.position, duration: l.duration || 0, at: FB.serverTimestamp()
    };
    FB.update(pref(`history/${key}`), entry).catch(() => {});
  }

  // What the screens show about sync.
  function info() {
    const l = loc();
    const theirs = S.here[partnerUid];
    const p = ctx.partnerStatus();
    const w = p && p.conns && Object.keys(p.conns).length ? p.watching : null;
    const pb = S.playback;
    const name = ctx.partnerName();
    let text = '', cls = 'idle', follow = null;
    if (!l || !l.mediaId) {
      text = theirs ? `${name} is watching ${theirs.title || 'something'}` : 'Open a show and your friend comes along';
      if (theirs && theirs.url) follow = { title: theirs.title || 'something', url: theirs.url };
    } else if (!theirs) {
      text = `Paused until ${name} opens the video`; cls = 'warn';
    } else if (!bothHere()) {
      text = `Bringing you both to the same title…`; cls = 'warn';
    } else if (pb && pb.by !== me && pb.reason === 'buffer' && pb.state === 'paused') {
      text = `Waiting for ${name} to catch up…`; cls = 'warn';
    } else if (w && same(w.mediaId, l.mediaId)) {
      const theirPos = (w.position || 0) + (!w.paused ? Math.max(0, ctx.serverNow() - (w.at || 0)) / 1000 : 0);
      const d = Math.abs(theirPos - l.position);
      if (d < 2) { text = 'In sync'; cls = 'ok'; } else { text = `About ${Math.round(d)}s apart, syncing…`; cls = 'warn'; }
    } else { text = 'In sync'; cls = 'ok'; }
    return { text, cls, follow, countdown: countdownRunning(), together: bothHere(), askSame: askSame() };
  }

  function start() {
    FB.onDisconnect(pref(`here/${me}`)).remove();
    unsubs.push(FB.onValue(pref('playback'), (s) => onPlayback(s.val())));
    unsubs.push(FB.onValue(pref('here'), (s) => onHere(s.val())));
    unsubs.push(FB.onChildAdded(FB.query(pref('reactions'), FB.orderByChild('at'), FB.startAt(ctx.serverNow() - 3000)), (s) => onReaction(s.val())));
    unsubs.push(FB.onValue(pref('countdown'), (s) => onCountdown(s.val())));
    unsubs.push(FB.onValue(pref('open'), (s) => onOpen(s.val())));
    unsubs.push(FB.onValue(pref('same'), (s) => { S.confirmed = s.val(); enforce(); }));

    FB.get(FB.query(pref('reactions'), FB.orderByChild('at'), FB.endAt(ctx.serverNow() - 60000)))
      .then((s) => s.forEach((c) => { FB.remove(c.ref).catch(() => {}); })).catch(() => {});

    publishHere();

    // Leader heartbeat keeps the follower's estimate accurate.
    timers.push(setInterval(() => {
      const pb = S.playback, l = loc();
      if (!pb || !l || !hasLocalVideo()) { publishHere(); return; }
      if (pb.by === me && pb.state === 'playing' && !l.paused && !l.buffering && !l.settling && same(l.mediaId, pb.mediaId) && bothHere()) {
        writePlayback({ state: 'playing', position: l.position, reason: 'hb' }, false);
      }
    }, HEARTBEAT_MS));

    timers.push(setInterval(() => {
      const l = loc();
      if (l && l.mediaId && !l.paused && hasLocalVideo()) writeHistory();
    }, 15000));

    timers.push(setInterval(checkPrimeFallback, 2000));
  }

  function stop() {
    unsubs.splice(0).forEach((u) => u());
    timers.splice(0).forEach((t) => { clearTimeout(t); clearInterval(t); });
    FB.remove(pref(`here/${me}`)).catch(() => {});
    FB.onDisconnect(pref(`here/${me}`)).cancel().catch(() => {});
    ctx.sendWatch({ cmd: 'banner', text: null });
    ctx.sendWatch({ cmd: 'duck', on: false });
  }

  return {
    start, stop, onStatus, onReady, onLocal, onBuffering, onLocalGone, reapply,
    sendReaction, startCountdown, openForBoth, followPartner, resync, confirmSame, info
  };
}
