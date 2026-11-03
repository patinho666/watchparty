// Runs in Netflix's own page context, where its player API lives.
// Setting video.currentTime directly makes Netflix crash (error M7375),
// so seeks go through the official player object instead.
(() => {
  if (window.__wpNetflixBridge) return;
  window.__wpNetflixBridge = true;

  function player() {
    try {
      const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const ids = vp.getAllPlayerSessionIds();
      const id = ids.find((i) => i.startsWith('watch')) || ids[0];
      return id ? vp.getVideoPlayerBySessionId(id) : null;
    } catch { return null; }
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.__wpNetflix !== 'cmd') return;
    const p = player();
    const v = document.querySelector('video');
    try {
      if (d.op === 'seek') {
        if (p) p.seek(Math.round(d.time * 1000));
        else if (v) v.currentTime = d.time;
      } else if (d.op === 'play') {
        if (p) p.play(); else v && v.play();
      } else if (d.op === 'pause') {
        if (p) p.pause(); else v && v.pause();
      } else if (d.op === 'volume') {
        if (p && typeof p.setVolume === 'function') p.setVolume(d.value);
        else if (v) v.volume = d.value;
      }
    } catch (err) {
      console.warn('[WatchParty] Netflix player command failed:', d.op, err);
    }
  });
})();
