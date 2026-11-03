// Peer-to-peer connection to the friend you're calling.
// Firebase carries only small signaling messages; audio and video go
// directly PC-to-PC (or via TURN when a direct path is impossible).
import CONFIG from '../config.js';

export async function getIceServers() {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }, ...(CONFIG.iceServers || [])];
  const cf = CONFIG.cloudflareTurn || {};
  if (!cf.keyId || !cf.apiToken) return list;
  const base = `https://rtc.live.cloudflare.com/v1/turn/keys/${cf.keyId}/credentials`;
  for (const path of ['generate-ice-servers', 'generate']) {
    try {
      const res = await fetch(`${base}/${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cf.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 })
      });
      if (!res.ok) continue;
      const data = await res.json();
      const ice = Array.isArray(data.iceServers) ? data.iceServers : data.iceServers ? [data.iceServers] : [];
      return [...list, ...ice];
    } catch (e) { console.warn('[WatchParty] Cloudflare TURN unavailable', e); }
  }
  return list;
}

// ctx: { FB, pref(path) → ref inside the pair, me, partnerUid, session, stream, onRemote(stream|null), onState(state) }
export function createConnection(ctx) {
  const { FB, pref, me, partnerUid, session, stream, onRemote, onState } = ctx;
  const polite = me > partnerUid; // "perfect negotiation": one side yields on collisions

  let pc = null;
  let partnerSession = null;
  let creatingFor = null;
  let token = 0;
  let makingOffer = false;
  let ignoreOffer = false;
  let pending = {};
  let chain = Promise.resolve();
  let discTimer = null;
  let closed = false;
  let state = 'waiting';

  const setState = (s) => { if (s !== state) { state = s; onState(s); } };

  const unsubInbox = FB.onChildAdded(pref(`signal/${me}`), (snap) => {
    const m = snap.val();
    FB.remove(snap.ref).catch(() => {});
    if (closed || !m || m.to !== session) return; // stale
    if (pc && m.session === partnerSession) queue(m);
    else (pending[m.session] ||= []).push(m);
  });

  function send(msg) {
    const clean = JSON.parse(JSON.stringify({ ...msg, from: me, session, to: partnerSession }));
    FB.push(pref(`signal/${partnerUid}`), clean).catch(() => {});
  }

  function queue(m) {
    chain = chain.then(() => handle(m)).catch((e) => console.warn('[WatchParty] signal error', e));
  }

  async function handle({ description, candidate }) {
    if (!pc) return;
    if (description) {
      const collision = description.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
      ignoreOffer = !polite && collision;
      if (ignoreOffer) return;
      await pc.setRemoteDescription(description);
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        send({ description: pc.localDescription.toJSON() });
      }
    } else if (candidate) {
      try { await pc.addIceCandidate(candidate); }
      catch (e) { if (!ignoreOffer) console.warn('[WatchParty] ICE candidate rejected', e); }
    }
  }

  // Called whenever the partner's entry in the call changes.
  // A missing entry is ignored (it may be a brief network blip);
  // only a new session means the partner restarted.
  function updatePartner(member) {
    if (closed || !member || !member.session) return;
    const ps = member.session;
    if (ps === (pc ? partnerSession : creatingFor)) return;
    teardown();
    creatingFor = ps;
    create(ps);
  }

  async function create(ps) {
    const my = ++token;
    const iceServers = await getIceServers();
    if (my !== token || closed) return;
    const p = new RTCPeerConnection({ iceServers });
    pc = p;
    partnerSession = ps;
    creatingFor = null;
    setState('connecting');
    stream.getTracks().forEach((t) => p.addTrack(t, stream));

    p.ontrack = ({ track, streams }) => {
      onRemote(streams[0] || new MediaStream([track]));
    };
    p.onicecandidate = ({ candidate }) => { if (candidate) send({ candidate: candidate.toJSON() }); };
    p.onnegotiationneeded = async () => {
      try {
        makingOffer = true;
        await p.setLocalDescription();
        send({ description: p.localDescription.toJSON() });
      } catch (e) { console.warn('[WatchParty] negotiation failed', e); }
      finally { makingOffer = false; }
    };
    p.onconnectionstatechange = () => {
      const s = p.connectionState;
      clearTimeout(discTimer);
      if (s === 'connected') setState('connected');
      else if (s === 'failed') { setState('reconnecting'); p.restartIce(); }
      else if (s === 'disconnected') {
        setState('reconnecting');
        discTimer = setTimeout(() => { if (pc === p && p.connectionState === 'disconnected') p.restartIce(); }, 4000);
      }
    };

    const early = pending[ps] || [];
    pending = {};
    early.forEach(queue);
  }

  function teardown() {
    token++;
    creatingFor = null;
    clearTimeout(discTimer);
    if (pc) { try { pc.close(); } catch {} }
    pc = null;
    partnerSession = null;
    onRemote(null);
  }

  function close() {
    if (closed) return;
    teardown();
    closed = true;
    unsubInbox();
  }

  // How loud the friend's voice is right now (0 to 1), measured by the call
  // connection itself, so it works without any audio processing in the page.
  async function audioLevel() {
    if (!pc) return 0;
    let level = 0;
    try {
      const stats = await pc.getStats();
      stats.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio' && typeof r.audioLevel === 'number') level = Math.max(level, r.audioLevel);
      });
    } catch {}
    return level;
  }

  return { updatePartner, close, audioLevel, get state() { return state; } };
}
