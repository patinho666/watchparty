// ─────────────────────────────────────────────────────────────
//  WatchParty configuration — fill this in once (see README.md).
//  Both PCs use the same file.
// ─────────────────────────────────────────────────────────────
export default {
  // Firebase console → Project settings → Your apps → Web app → "firebaseConfig".
  // databaseURL is required (Realtime Database page shows it).
  firebase: {
    apiKey: "AIzaSyAmJarm5IoR7AlwQcWiBehLrzRTMlhCmFk",
    authDomain: "watchpartyhtx.firebaseapp.com",
    databaseURL: "https://watchpartyhtx-default-rtdb.firebaseio.com",
    projectId: "watchpartyhtx",
    appId: "1:171572183206:web:885da02180c0630c70f467"
  },

  // Optional: extra STUN/TURN servers, e.g. [{ urls: "turn:...", username: "...", credential: "..." }].
  // Google's free STUN servers are always included.
  iceServers: [],

  // Optional: Cloudflare Realtime TURN (free up to 1,000 GB/month).
  // Only needed if the video call fails to connect on some network.
  cloudflareTurn: {
    keyId: "",
    apiToken: ""
  }
};
