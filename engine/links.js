// Hands the call's video to whichever screen is showing it (the side panel or
// the fullscreen companion). Each screen gets a local, same-PC WebRTC link;
// nothing goes over the internet. Audio stays in the engine, so switching
// screens never interrupts the call.
export function createLinks() {
  const links = new Map(); // port -> link
  let tracks = { remote: null, local: null };

  function open(port) {
    close(port);
    const pc = new RTCPeerConnection({ iceServers: [] });
    const streams = { remote: new MediaStream(), local: new MediaStream() };
    const tx = {
      remote: pc.addTransceiver('video', { direction: 'sendonly', streams: [streams.remote] }),
      local: pc.addTransceiver('video', { direction: 'sendonly', streams: [streams.local] })
    };
    const link = { pc, tx };
    links.set(port, link);
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) post(port, { type: 'link-ice', candidate: candidate.toJSON() });
    };
    for (const k of ['remote', 'local']) tx[k].sender.replaceTrack(tracks[k]).catch(() => {});
    pc.createOffer()
      .then((o) => pc.setLocalDescription(o))
      .then(() => post(port, {
        type: 'link-offer', description: pc.localDescription.toJSON(),
        ids: { remote: streams.remote.id, local: streams.local.id }
      }))
      .catch((e) => console.warn('[WatchParty] video link failed', e));
  }

  function handle(port, msg) {
    const link = links.get(port);
    if (msg.type === 'link-request') { open(port); return true; }
    if (!link) return msg.type === 'link-answer' || msg.type === 'link-ice' || msg.type === 'link-stop';
    if (msg.type === 'link-answer') { link.pc.setRemoteDescription(msg.description).catch(() => {}); return true; }
    if (msg.type === 'link-ice') { link.pc.addIceCandidate(msg.candidate).catch(() => {}); return true; }
    if (msg.type === 'link-stop') { close(port); return true; }
    return false;
  }

  function close(port) {
    const link = links.get(port);
    if (!link) return;
    try { link.pc.close(); } catch {}
    links.delete(port);
  }

  function setTracks(next) {
    tracks = { ...tracks, ...next };
    for (const link of links.values()) {
      for (const k of ['remote', 'local']) link.tx[k].sender.replaceTrack(tracks[k]).catch(() => {});
    }
  }

  function post(port, msg) { try { port.postMessage(msg); } catch {} }

  return { open, handle, close, setTracks };
}
