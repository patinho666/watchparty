// Screen side of the engine's local video link (see engine/links.js).
export function createVideoView(post, { remote, local, onChange }) {
  let pc = null;
  let ids = null;
  let chain = Promise.resolve();

  function start() { post({ type: 'link-request' }); }

  function stop() {
    if (pc) { try { pc.close(); } catch {} pc = null; }
    post({ type: 'link-stop' });
    remote.srcObject = null;
    if (local) local.srcObject = null;
  }

  function handle(msg) {
    if (msg.type === 'link-offer') {
      chain = chain.then(() => accept(msg)).catch((e) => console.warn('[WatchParty] video link', e));
      return true;
    }
    if (msg.type === 'link-ice') {
      chain = chain.then(() => pc && pc.addIceCandidate(msg.candidate)).catch(() => {});
      return true;
    }
    return false;
  }

  async function accept(msg) {
    if (pc) { try { pc.close(); } catch {} }
    pc = new RTCPeerConnection({ iceServers: [] });
    ids = msg.ids;
    pc.ontrack = ({ track, streams }) => {
      const s = streams[0] || new MediaStream([track]);
      const el = s.id === ids.local ? local : remote;
      if (!el) return;
      el.srcObject = s;
      el.play().catch(() => {});
      track.onmute = track.onunmute = () => onChange && onChange();
      onChange && onChange();
    };
    pc.onicecandidate = ({ candidate }) => { if (candidate) post({ type: 'link-ice', candidate: candidate.toJSON() }); };
    await pc.setRemoteDescription(msg.description);
    await pc.setLocalDescription();
    post({ type: 'link-answer', description: pc.localDescription.toJSON() });
  }

  return { start, stop, handle };
}
