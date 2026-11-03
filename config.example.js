// ─────────────────────────────────────────────────────────────
//  WatchParty configuration — fill this in once (see README.md).
//  Both PCs use the same file.
// ─────────────────────────────────────────────────────────────
export default {
  // Firebase console → Project settings → Your apps → Web app → "firebaseConfig".
  // databaseURL is required (Realtime Database page shows it).
  firebase: {
    apiKey: "PASTE_YOUR_API_KEY",
    authDomain: "your-project.firebaseapp.com",
    databaseURL: "https://your-project-default-rtdb.firebaseio.com",
    projectId: "your-project",
    appId: "PASTE_YOUR_APP_ID"
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
