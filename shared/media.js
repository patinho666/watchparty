// Shared helpers for the content scripts and the side panel.
(function (g) {
  const STREAM_PATTERNS = [
    'https://*.netflix.com/*',
    'https://*.disneyplus.com/*',
    'https://*.primevideo.com/*',
    'https://www.amazon.com/gp/video/*',
    'https://www.amazon.com.br/gp/video/*',
    'https://www.amazon.co.uk/gp/video/*'
  ];

  function serviceFromUrl(url) {
    try {
      const h = new URL(url).hostname;
      if (h.endsWith('netflix.com')) return 'netflix';
      if (h.endsWith('disneyplus.com')) return 'disney';
      if (h.endsWith('primevideo.com') || /(^|\.)amazon\./.test(h)) return 'prime';
    } catch {}
    return null;
  }

  // A stable id for "the thing being watched", taken from the URL.
  function mediaIdFromUrl(url) {
    try {
      const u = new URL(url);
      const s = serviceFromUrl(url);
      let m;
      if (s === 'netflix') m = u.pathname.match(/\/watch\/(\d+)/);
      else if (s === 'disney') m = u.pathname.match(/\/(?:video|play)\/([\w-]+)/);
      else if (s === 'prime') m = u.pathname.match(/\/detail\/([\w.-]+)/);
      return m ? `${s}:${m[1]}` : null;
    } catch { return null; }
  }

  // Firebase keys can't contain . # $ [ ] / :
  const keyFromMediaId = (id) => String(id).replace(/[.#$\[\]\/:]/g, '_');

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const ss = String(s).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  const SERVICE_NAMES = { netflix: 'Netflix', disney: 'Disney+', prime: 'Prime Video' };

  g.WPMedia = { STREAM_PATTERNS, serviceFromUrl, mediaIdFromUrl, keyFromMediaId, fmtTime, SERVICE_NAMES };
})(globalThis);
