// Peer-to-peer voice/video call between the two of you.
// Firebase carries only the small signaling messages; audio and video
// go directly PC-to-PC (or via TURN if a direct path is impossible).
import CONFIG from '../config.js';

export function createCall(ctx) {
  const { FB, r, uid, mySlot, partnerSlot, getPartnerUid, els, onChange, onSpeaking, onError } = ctx;
  const polite = mySlot === 'b'; // "perfect negotiation": b yields on offer collisions

  let localStream = null;
  let inCall = false;
  let session = null;          // my call session id
  let pc = null;
  let partnerSession = null;   // session the current pc talks to
  let creatingFor = null;
  let pcToken = 0;
  let partnerNode = null;
  let makingOffer = false;
  let ignoreOffer = false;
  let pending = {};
  let chain = Promise.resolve();
  let discTimer = null;
  let audioCtx = null;
  let meterTimer = null;
  let connState = 'new';
  let micOn = true, camOn = true, hasCam = false;

  // ── Signaling inbox ──────────────────────────────────────────
  FB.onChildAdded(r(`signal/${mySlot}`), (snap) => {
    const m = snap.val();
    FB.remove(snap.ref).catch(() => {});
    if (!m || !session || m.to !== session) return; // stale message
    if (pc && m.session === partnerSession) queue(m);
    else (pending[m.session] ||= []).push(m);
  });

  FB.onValue(r('call'), (snap) => {
    const all = snap.val() || {};
    partnerNode = all[getPartnerUid()] || null;
    reconcile();
    onChange(state());
  });

  function sendSignal(msg) {
    const clean = JSON.parse(JSON.stringify({ ...msg, from: uid, session, to: partnerSession }));
    FB.push(r(`signal/${partnerSlot}`), clean).catch(() => {});
  }

  function queue(m) {
    chain = chain.then(() => processSignal(m)).catch((e) => console.warn('[WatchParty] signal error', e));
  }

  async function processSignal({ description, candidate }) {
    if (!pc) return;
    if (description) {
      const collision = description.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
      ignoreOffer = !polite && collision;
      if (ignoreOffer) return;
      await pc.setRemoteDescription(description);
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        sendSignal({ description: pc.localDescription.toJSON() });
      }
    } else if (candidate) {
      try { await pc.addIceCandidate(candidate); }
      catch (e) { if (!ignoreOffer) console.warn('[WatchParty] ICE candidate rejected', e); }
    }
  }

  // ── Connection lifecycle ─────────────────────────────────────
  function reconcile() {
    const ps = inCall && partnerNode && partnerNode.inCall ? partnerNode.session : null;
    if (!ps) { if (pc || creatingFor) teardown(); return; }
    if (ps === (pc ? partnerSession : creatingFor)) return;
    teardown();
    creatingFor = ps;
    createPC(ps);
  }

  async function createPC(ps) {
    const token = ++pcToken;
    const iceServers = await getIceServers();
    if (token !== pcToken || !inCall) return;
    const p = new RTCPeerConnection({ iceServers });
    pc = p;
    partnerSession = ps;
    creatingFor = null;
    connState = 'connecting';

    localStream.getTracks().forEach((t) => p.addTrack(t, localStream));

    p.ontrack = ({ track, streams }) => {
      const stream = streams[0] || new MediaStream([track]);
      if (els.remote.srcObject !== stream) {
        els.remote.srcObject = stream;
        els.remote.play().catch(() => {});
      }
      if (track.kind === 'audio') startMeter(stream);
      onChange(state());
    };
    p.onicecandidate = ({ candidate }) => { if (candidate) sendSignal({ candidate: candidate.toJSON() }); };
    p.onnegotiationneeded = async () => {
      try {
        makingOffer = true;
        await p.setLocalDescription();
        sendSignal({ description: p.localDescription.toJSON() });
      } catch (e) { console.warn('[WatchParty] negotiation failed', e); }
      finally { makingOffer = false; }
    };
    p.onconnectionstatechange = () => {
      connState = p.connectionState;
      clearTimeout(discTimer);
      if (connState === 'failed') p.restartIce();
      else if (connState === 'disconnected') {
        discTimer = setTimeout(() => { if (pc === p && p.connectionState === 'disconnected') p.restartIce(); }, 4000);
      }
      onChange(state());
    };

    const early = pending[ps] || [];
    pending = {};
    early.forEach(queue);
    onChange(state());
  }

  function teardown() {
    pcToken++;
    creatingFor = null;
    clearTimeout(discTimer);
    if (pc) { try { pc.close(); } catch {} }
    pc = null;
    partnerSession = null;
    connState = 'new';
    els.remote.srcObject = null;
    stopMeter();
  }

  async function getIceServers() {
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

  // ── Partner voice level (for lowering the show's volume) ─────
  function startMeter(stream) {
    stopMeter();
    if (!audioCtx || !stream.getAudioTracks().length) return;
    const src = audioCtx.createMediaStreamSource(stream);
    const an = audioCtx.createAnalyser();
    an.fftSize = 512;
    src.connect(an); // not connected to speakers: the <video> element plays the audio
    const buf = new Uint8Array(an.fftSize);
    let speaking = false, lastLoud = 0;
    meterTimer = setInterval(() => {
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
      const rms = Math.sqrt(sum / buf.length);
      const t = Date.now();
      if (rms > 0.035) lastLoud = t;
      const s = t - lastLoud < 900;
      if (s !== speaking) { speaking = s; onSpeaking(s); }
    }, 100);
  }

  function stopMeter() {
    clearInterval(meterTimer);
    meterTimer = null;
    onSpeaking(false);
  }

  // ── Public controls ──────────────────────────────────────────
  async function getMedia() {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio, video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } }
      });
    } catch (e) {
      if (['NotFoundError', 'OverconstrainedError', 'NotReadableError'].includes(e.name)) {
        return navigator.mediaDevices.getUserMedia({ audio }); // no usable camera: voice only
      }
      throw e;
    }
  }

  async function join() {
    if (inCall) return;
    audioCtx = audioCtx || new AudioContext();
    audioCtx.resume().catch(() => {});
    try {
      localStream = await getMedia();
    } catch (e) {
      if (e.name === 'NotAllowedError' || e.name === 'SecurityError') {
        chrome.tabs.create({ url: chrome.runtime.getURL('panel/permission.html') });
        onError('Allow camera and microphone in the tab that just opened, then select Join call again.');
      } else {
        onError(`Couldn't start the camera or microphone (${e.name}).`);
      }
      return;
    }
    hasCam = localStream.getVideoTracks().length > 0;
    micOn = true;
    camOn = hasCam;
    els.local.srcObject = localStream;
    session = crypto.randomUUID().slice(0, 8);
    inCall = true;
    const node = r(`call/${uid}`);
    FB.onDisconnect(node).remove();
    await FB.set(node, { inCall: true, session, mic: micOn, cam: camOn });
    reconcile();
    onChange(state());
  }

  function leave() {
    if (!inCall) return;
    inCall = false;
    teardown();
    localStream?.getTracks().forEach((t) => t.stop());
    localStream = null;
    els.local.srcObject = null;
    session = null;
    FB.remove(r(`call/${uid}`)).catch(() => {});
    onChange(state());
  }

  function toggleMic() {
    if (!localStream) return;
    micOn = !micOn;
    localStream.getAudioTracks().forEach((t) => { t.enabled = micOn; });
    FB.update(r(`call/${uid}`), { mic: micOn }).catch(() => {});
    onChange(state());
  }

  function toggleCam() {
    if (!localStream || !hasCam) return;
    camOn = !camOn;
    localStream.getVideoTracks().forEach((t) => { t.enabled = camOn; });
    FB.update(r(`call/${uid}`), { cam: camOn }).catch(() => {});
    onChange(state());
  }

  async function popOut() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (els.remote.srcObject) await els.remote.requestPictureInPicture();
    } catch (e) { onError(`Couldn't pop out the video (${e.name}).`); }
  }

  function state() {
    return {
      inCall, micOn, camOn, hasCam, connState,
      partnerInCall: !!(partnerNode && partnerNode.inCall),
      partnerMic: partnerNode ? partnerNode.mic !== false : false,
      partnerCam: partnerNode ? partnerNode.cam !== false : false,
      hasRemote: !!els.remote.srcObject
    };
  }

  return { join, leave, toggleMic, toggleCam, popOut, state };
}
