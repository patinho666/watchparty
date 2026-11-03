# WatchParty

A private Chrome/Edge extension for watching Netflix, Disney+ and Prime Video together:
friends, calls with voice and video, synced playback, chat, reactions, a 3·2·1 countdown,
and a watchlist and history for each pair of friends. Everything runs on free tiers.

## How it's built

- **Engine** (`engine/`): an invisible page that starts with the browser and holds everything
  that must keep running: your sign-in, friends, incoming calls, the call itself and playback
  sync. Closing the side panel or going fullscreen doesn't affect it.
- **Side panel** (`panel/panel.*`): the app. Friends, calls, chat, watchlist, history, settings.
- **Call window** (`panel/companion.*`): appears on the video whenever the side panel isn't
  open, in windowed mode and in fullscreen. Drag it by its top bar, resize it from any corner;
  it remembers where you left it.
- **Content script** (`content/`): runs on the streaming sites and controls the player.

## Updates

WatchParty checks your GitHub repository for a newer version every few hours. When one is
there, the sidebar shows **Update**.

**One-time setup on each PC:** in the WatchParty folder, double-click **install.bat**. It allows
the Update button to run the updater, in Chrome and Edge, for the current Windows user (no
administrator rights). If Windows shows "Windows protected your PC", click **More info** →
**Run anyway**. Run it again if you move the folder.

**Updating:** click **Update** in the sidebar. WatchParty downloads the new version, replaces
its files (your `config.js` is kept) and restarts itself; then refresh any streaming tabs.
Without install.bat, double-clicking **update.bat** does the same, and WatchParty restarts by
itself within a minute.

**Publishing a new version (Pedro):**
1. Raise `"version"` in `manifest.json` (for example 3.0.0 → 3.0.1).
2. On https://github.com/patinho666/watchparty choose **Add file → Upload files**, drag in
   the contents of the WatchParty folder **without `config.js`** (your Firebase settings stay
   private), and click **Commit changes**. The repository must be public.
3. Within a few hours (or right away with Settings → Updates → **Check now**) everyone sees
   **Update**.

The repository and branch the updater uses are in `update-source.json`.

## 1. Firebase setup (once)

If you set up Firebase for version 1, use the same project and redo steps 2 and 4.

1. Go to https://console.firebase.google.com and create a project (Analytics not needed).
2. **Build → Authentication → Sign-in method → Email/Password → Enable** (the first switch only).
   You only ever type a username: behind the scenes Firebase needs an e-mail-style login, which
   WatchParty creates from the username. No e-mails are sent. Anyone who knows a username can
   sign in as that person. You can turn off Anonymous sign-in from version 1.
3. **Build → Realtime Database → Create database** (locked mode), if you don't have one yet.
4. In the Realtime Database **Rules** tab, replace everything with the contents of
   `database.rules.json` and click **Publish**.
5. **Project settings → Your apps → Web app**: copy `config.example.js` to `config.js` and
   put the `firebaseConfig` values into it.
   Check that `databaseURL` is filled in.

## 2. Install on each PC

1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder. When updating, replace everything here
   except your `config.js`, then click the reload icon on the extension card.
3. Pin the extension, and refresh any open Netflix, Disney+ or Prime tabs.

## 3. First use

1. Click the WatchParty icon and type a username (letters, numbers and `_`). A new username
   is created the first time it's used; on another PC, just type the same username.
2. Allow camera and microphone once: **Settings → Allow camera and microphone**.
3. Add your friend by their username. They get a notification and accept it in the app.

## 4. Using it

- **Call:** pick a friend and select **Call** (they need to be online). They get a Windows
  notification with Answer and Decline, plus a ringtone if the browser allows it.
- **Watch:** during a call you're always on the same title. When one of you opens something,
  the other's browser goes there too (opening a tab if needed). Play, pause and seeks stay in
  sync, and **3·2·1 play** starts you at the same moment.
- **Nobody plays alone:** the video only plays while both of you have it open. If one of you
  hasn't opened it yet, or leaves it, the other's video is held paused with a message saying
  who you're waiting for. Once you're both there again, a 3·2·1 countdown starts you together.
- **Fullscreen from the sidebar:** **⛶ Fullscreen** switches the browser window to fullscreen
  (like F11). The video fills the screen and the call window appears. **⇱** in the call
  window brings everything back to normal and reopens the sidebar.
- **Fullscreen:** use the site's own fullscreen button. The side panel closes and the call
  window appears on the video. **–** shrinks it to a small bar; **💬** opens chat; new
  messages show as a preview inside the window. When you leave fullscreen, WatchParty tries
  to reopen the side panel; if the browser doesn't allow it, the call window stays on the
  video, and **⇱** in its top bar opens the side panel.
- **Out of sync?** **Sync to me** (side panel) or **⟲** (call window) brings your friend to
  exactly where you are, including to the title you're on.
- **Privacy:** a call only stays on while WatchParty can be seen: the side panel, or the call
  window on the video. Switching tabs is fine (the red LIVE badge shows the call is still on);
  if the browser is minimized with nothing of WatchParty visible, you get a warning, and after
  20 seconds the call ends.
- **Waiting for your friend:** if they haven't opened the video yet, you see where they are
  ("Disney+, Home") and a **Remind** button that sends them a message.
- **Ads** (plans with ads): while one of you watches an ad, the other is held paused, and you
  continue together when it ends. Ad detection depends on each service's player; Diagnostics
  shows "AD" when one is detected.
- **Watchlist and history** belong to each pair of friends. History fills in during calls, and
  its **Continue watching** section shows the next series you were in the middle of.
- **Diagnostics** (Settings): what WatchParty sees right now, with a **Copy** button. Send it
  along when something misbehaves.
- **Versions:** if your friend runs a different WatchParty version, the friend view says so.
  Update both to the same version.
- **Chat** older than 90 days is deleted automatically.
- **Use headphones**, or your mic picks up the show's sound.

## Optional: TURN server

If calls never connect on some network, create a TURN key in the Cloudflare dashboard under
**Realtime → TURN** and add the key ID and API token to `config.js` (free up to 1,000 GB a month).

## Troubleshooting

- **"Turn on Email/Password sign-in":** step 2 of the Firebase setup is missing.
- **"…was created with a password in a test version":** in the Firebase console, delete that
  user under Authentication → Users, and delete `usernames/<name>` and `users/<uid>` in the
  Realtime Database. Then type the username again to recreate it.
- **Call says it needs camera permission:** Settings → Allow camera and microphone, allow it in
  the tab that opens, then call again.
- **Nothing syncs or the companion doesn't show:** refresh the streaming tab after installing
  or updating the extension.
- **See what the engine is doing:** `chrome://extensions` → WatchParty → "Inspect views:
  engine/engine.html" opens its console.

## Known limitations

- Prime Video has a separate catalogue per country. Between countries, the friend's browser
  opens a Prime search for the series on their own site, and they pick the episode. The two
  videos are then matched by name; if the names differ (different languages), by season,
  episode and running time; and if that still fails, both of you are asked "Are you watching
  the same thing?". Ads on one side put you out of step; use Sync to me afterwards.
- Netflix seeking uses Netflix's internal player API, which can change without notice.
- Disney+ big jumps are made by clicking its progress bar, then fine-tuned; expect a second
  or two to line up after a big seek.
- Streaming content itself can't be screen-shared (DRM): each of you needs your own access.

## Project layout

```
manifest.json            Extension definition
config.js                Your Firebase (and optional TURN) settings (never published)
config.example.js        Template for config.js
update-source.json       Where updates come from (GitHub repository and branch)
install.bat / .ps1       One-time: lets the Update button run the updater
update.bat               Update by hand
updater.ps1              Downloads and installs the latest version
updater-host.bat         Started by the browser when you click Update
engine/update.js         Checks for new versions; restarts after an update
database.rules.json      Security rules to paste into Firebase
background.js            Starts the engine; notifications, badge, tabs, opening the panel
engine/engine.js         Starts the engine and wires the modules below
engine/core.js           Shared state, helpers, event log
engine/accounts.js       Firebase start-up, username sign-in, presence
engine/friends.js        Friend requests, conversations, chat clean-up
engine/calls.js          Calls, camera/mic, voice meter, privacy rule
engine/tabs.js           Streaming tabs: reports in, commands out
engine/views.js          Side panel and call window: state and commands
engine/notify.js         Badge, notifications, ringtone
engine/call.js           The call connection to your friend
engine/sync.js           Playback sync during a call
engine/links.js          Passes the call video to the panel or companion
panel/panel.*            Side panel (the app)
panel/companion.*        Call card / bar shown on the video
panel/permission.*       One-time camera and microphone permission page
shared/                  Helpers used by several parts
content/content.js       Player control, overlay, companion frame
content/netflix-main.js  Netflix player bridge
vendor/firebase.js       Bundled Firebase SDK (prebuilt; rebuild from build/)
```
