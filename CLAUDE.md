# bping — Basecamp Pings Native App

Electron-based macOS app for managing Basecamp 4 "pings" (direct messages).
The left pane is a custom-built list of conversations; the right pane is a live
`<webview>` of the real Basecamp ping page (so the chat itself is 100% native
Basecamp — boosts, attachments, read receipts, live updates).

## Where things live

| | Path |
|---|---|
| Source | `~/Documents/bping-native/` (= `/Users/john~/Documents/bping-native/`) |
| Main process | `main.js` |
| Renderer | `renderer/index.html` (single file, inline CSS+JS) |
| Preload (IPC bridge) | `preload.js` |
| Entitlements (hardened runtime) | `entitlements.plist` |
| App icon | `icon.icns` (ping-pong paddles logo) |
| Build script | `build-dmg.sh` (bumps version, packages, signs, optionally notarizes, builds DMG, deploys) |
| Package config | `package.json` (version auto-bumped each build) |
| Build output | `dist/bping-darwin-arm64/bping.app`, `dist/bping-v<version>.dmg` |
| Deployed bundles | `~/Documents/bping-apps/bping.app`, `~/Documents/bping-apps/bping-v<version>.dmg` |
| Deployed bundles (Desktop) | `~/Desktop/bping.app`, `~/Desktop/bping-v<version>.dmg` |

## Build & deploy

```bash
cd ~/Documents/bping-native

# Default: bump patch version, package, sign, build DMG, deploy. ~30 s.
# Signed but NOT notarized — recipients see "developer cannot be verified"
# on first launch and must right-click → Open.
./build-dmg.sh

# Release build: same as above + notary submission + staple. ~3-5 min.
# DMG opens with no Gatekeeper warning.
BPING_NOTARIZE=1 ./build-dmg.sh

# Rebuild current version without bumping (e.g. retry a failed step).
BPING_SKIP_BUMP=1 ./build-dmg.sh
```

`build-dmg.sh` runs `electron-packager` itself, so `npm run package` is no longer
a separate step. Older `bping-v*.dmg` files are removed from `dist/`,
`~/Documents/bping-apps/`, and `~/Desktop/` on each successful build.

**Auto-install + relaunch:** every build also quits any running bping, copies the
new `.app` into `/Applications/bping.app` (replacing the prior one), and
relaunches it. Skip with `BPING_SKIP_INSTALL=1 ./build-dmg.sh` if you want to
test from a DMG copy without disturbing the currently-running instance. User
data (OAuth tokens, settings, marked-replied state) lives in `~/Library/Application Support/bping/`
and `localStorage` — replacing the `.app` doesn't touch any of it.

After a notarized `build-dmg.sh` succeeds, `spctl --assess` returns
`accepted source=Notarized Developer ID`. Recipients double-click the DMG, drag
to Applications, no Gatekeeper warning, no right-click-to-open.

## Signing / notarization

- **Identity:** `Developer ID Application: Vid Tadel (XLS3XF57J8)` (in login Keychain)
- **Team ID:** `XLS3XF57J8`
- **notarytool keychain profile:** `bping-notary` (stored via `xcrun notarytool store-credentials`)
- Overridable via env: `BPING_SIGN_ID="..."` and `BPING_NOTARY_PROFILE="..."` for `build-dmg.sh`
- **Notarization is opt-in:** `BPING_NOTARIZE=1 ./build-dmg.sh`. Without it the build is
  signed-but-not-notarized (faster iteration; recipient warning on first launch).
- If the cert isn't present, `build-dmg.sh` falls back to ad-hoc signing automatically.
- **Signing approach:** walk every file in the bundle with `find`; if `file` reports
  it's Mach-O, codesign it with hardened runtime + timestamp + entitlements. Then
  sign helper `.app` bundles, then frameworks, then the main bundle. This is what
  catches `chrome_crashpad_handler` (in `Electron Framework.framework/.../Helpers/`)
  and `ShipIt` (in `Squirrel.framework/.../Resources/`) — both required by notarization.
- **App is zipped before notary upload** (`ditto -c -k --keepParent`), but the staple
  goes on the unzipped `.app`. Notary verdict is checked for `"status: Accepted"`.

## OAuth2 setup (baked-in)

- 37signals integration registered at `launchpad.37signals.com/integrations`
- Client ID + Secret are **hardcoded in `main.js`** (`OAUTH` const), **ROT19-obfuscated**
  via a tiny `rot19()` decoder that applies `+7 mod 26` to lowercase letters (the inverse
  of the +19 encoding shift). This hides the literal strings from `grep`/`strings` of the
  bundle — it is NOT encryption; anyone reading `main.js` can reverse it. Trusted-distribution
  trade-off the user accepted. To rotate, regenerate at launchpad.37signals.com/integrations
  and replace the two encoded constants.
- Redirect URI: `http://localhost:8089/oauth/callback` (must match what's registered)
- Auth flow: **opens system browser** via `shell.openExternal` (so passkeys + existing
  Basecamp session work). Embedded HTTP server on `127.0.0.1:8089` receives the
  callback. The auth flow used to use an in-app `BrowserWindow`, but passkeys don't
  work in embedded Chromium — that's why it was switched.
- A `state:get` IPC reports `{configured, authed, accountId, appHref, redirectUri}` —
  the renderer's state machine drives the gate (`setupScreen` / `connectScreen` /
  `pickerScreen` / main app).
- Tokens stored at `<userData>/tokens.json`; account info at `<userData>/config.json`.
  `userData` resolves to `~/Library/Application Support/bping/`.

## Architecture / data flow

```
┌────────────────── main.js (Electron main process) ─────────────────┐
│                                                                    │
│  OAuth2 (Launchpad)  ←→  bearerFetch  ←→  Basecamp API (3.basecampapi.com)
│        ↓                                                           │
│  buildPings(light?) → readings + (per-convo) latest-line correction│
│                                                                    │
│  Notification (new pings)   webRequest watcher (post-send refresh) │
│  Window focus/blur → push 'focus-changed' IPC                      │
│  IPC: state:get, creds:save, auth:start/cancel, pings:list,        │
│       account:set, accounts:list, signout, notify:show,            │
│       app:focused, open-external                                   │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ contextBridge (preload.js)
                               ▼
┌────────────────── renderer/index.html ──────────────────────────────┐
│ Left pane: pings list (rowEl per convo, ↻ poll every 30s focused,   │
│   10s light when blurred, instant on send)                          │
│ Right pane: <webview partition="persist:basecamp"> → real Basecamp  │
│   ping. XFO + CSP frame-ancestors stripped in main via              │
│   session.webRequest.onHeadersReceived.                             │
└─────────────────────────────────────────────────────────────────────┘
```

## Renderer state vars (live in the script scope)

| Var | What it tracks |
|---|---|
| `current` | the open conversation `{bucket, chat, name, avatar, appUrl, ...}` |
| `peopleData` | last rendered list from `bp.getPings` |
| `peopleSig` | JSON sig of peopleData to skip no-op re-renders (avoids flicker) |
| `peopleTimer` | the polling setInterval handle |
| `readLocally` | Set of chat ids optimistically marked read (auto-clears once server agrees) |
| `focusComposer` | flag — after opening a ping, focus Basecamp's trix/contenteditable |
| `knownUnread` | Map chat→lastDate from previous poll, for new-ping detection |
| `firstLoad` | auto-open most recent ping on first successful load (reset on account switch) |
| `away` | true when window unfocused → use `light: true` poll + 10s interval |
| `markedReplied` | Map chat→lastDate-at-mark-time. Persisted in `localStorage` (`bping:markedReplied`). Auto-expires when lastDate advances. |
| `POLL_FOCUSED=30000`, `POLL_AWAY=10000` | poll cadences |

## How conversations are styled

```
(new)      → background #F0F0F0, name suffix " (new)"
(replied)  → background #FFFFFF, name suffix " (replied)"          ← naturally replied (I sent latest)
(manual)   → background #FFFFFF, NO suffix                         ← right-click "Mark as replied"
active     → background #eef6f1 (green-ish) — overrides the above
unread     → name is bold; orthogonal to (new)/(replied)
```

`lastMine` in `buildPings` decides "naturally replied" — full-mode polls fetch each
conversation's latest line and set `c.lastMine = newest.creator.id === me.id`.
Light-mode (background) polls **skip** the latest-line fetch — so `lastMine`,
the `"You: …"` excerpt prefix, and the corrected `lastDate` are missing. The
renderer's `loadPeople` **carries those over from the previous render** when
`lastDate` hasn't advanced (the merge step) — without this merge, focusing
away from the app makes rows flip back to (new). Critical and easy to break.

## Key Basecamp API quirks (non-obvious)

- **Pings are undocumented.** The endpoint is `/my/readings.json` filtered by
  `section: 'pings'`. Each item's `subscription_url` regex yields `bucket` + `chat`:
  `buckets/(\d+)/recordings/(\d+)`.
- **Lines:** `GET/POST /buckets/<bucket>/chats/<chat>/lines.json` — pings are chats
  in a personal-bucket. POST without `content_type=text/html` is plain text; with
  the param, it's rich text (allowed tags: div, h1, br, strong, em, strike, a[href],
  pre, ol, ul, li, blockquote).
- **Sent pings don't update readings.** A ping you send doesn't bump that
  conversation's `updated_at` in `/my/readings.json`. To get true recency we
  fetch each conversation's latest line. (Tested empirically. Light mode skips this.)
- **No public endpoint lists all your ping conversations.** `/circles.json` is
  null. So the conversation set comes from readings — meaning a brand-new ping you
  started with someone you've *never received from* won't appear in the list.
- **bc-attachment in chat lines → 422.** Inline file attachments in chat are
  exposed via a separate `/buckets/X/chats/Y/uploads.json` endpoint (multipart),
  not in line content. Not currently used in this app (chat happens in the
  embedded Basecamp webview anyway).
- **Basecamp blocks iframing.** `X-Frame-Options: SAMEORIGIN` +
  `Content-Security-Policy: frame-ancestors 'self'`. We strip both in main via
  `session.fromPartition(PARTITION).webRequest.onHeadersReceived` so the
  `<webview>` can embed `app.basecamp.com`.
- **OAuth2 Launchpad params:** `response_type=code`, `grant_type=authorization_code`,
  `grant_type=refresh_token`. Refresh token doesn't expire normally; access tokens
  live ~2 weeks.
- **`authorization.json`** lists the user's accounts (`product: 'bc3'` is
  Basecamp 3/4). We filter and let the user pick if >1.
- **The chat webview is a separate login.** OAuth (system browser) doesn't put
  cookies in the `persist:basecamp` Electron partition. First time the user clicks
  a ping, the webview will show Basecamp's sign-in.

## Refresh triggers

| Trigger | What happens |
|---|---|
| 30s focused-poll interval | `loadPeople()` (full mode) |
| 10s background-poll interval | `loadPeople()` (light mode) |
| Focus/blur transition | `setPoll()` + immediate `loadPeople()` |
| Open a conversation | optimistic read locally + the periodic poll picks it up |
| User sends a ping in the webview | `webRequest.onCompleted` catches the POST to `/chats/<n>/lines` → `'message-sent'` IPC → `loadPeople({forceFull: true})` |
| Manual Refresh button | `loadPeople({forceFull: true})` |
| Account switch | resets `firstLoad`, calls `startApp`, full poll |
| `onNotifyClick` (notification clicked) | focus window + `openConvo(chat)` |

## macOS-native niceties

- **Notifications:** `Notification` API in main. Renderer asks main via
  `bp.notify({title, body, chat})` for each fresh incoming ping. Clicking it
  focuses the window and opens that conversation.
- **App auto-selects** the most-recent ping on first load AND auto-selects any
  newly-arrived incoming ping while the app is unfocused (so it's open when you
  come back).
- **External browser for OAuth** so passkeys work (Touch ID, etc.).
- **Links inside the chat go to the system browser** via `will-navigate` +
  `setWindowOpenHandler` on the `<webview>`. Programmatic `webview.src` doesn't
  fire `will-navigate`, so our ping-loading still happens in-pane (verified
  empirically).
- **Sign-out** clears tokens, `accountId`, and the partition's storage so the
  next sign-in is fresh.

## Important file/code conventions

- Single-file renderer (HTML + inline CSS + inline `<script>`). All renderer
  state is module-scope `let`s.
- `bp` is the renderer-facing IPC bridge (`window.bping`). New IPC additions go
  in **all three** of: main `ipcMain.handle('...')`, preload `contextBridge.exposeInMainWorld`,
  and renderer call site.
- `mainWin` is the global ref to the main `BrowserWindow` in main.js — keep it
  in sync if you add more windows.
- `PARTITION = 'persist:basecamp'` — used for the chat webview's session.
- Don't `--deep` codesign — Apple discourages it and notarization can reject.
  Sign each Mach-O explicitly (current `build-dmg.sh` does).

## Things that have bitten us before (be alert)

1. **`will-navigate` does NOT fire for programmatic `webview.src` loads** —
   verified by a small Electron test. Means we can `e.preventDefault()` every
   user-clicked link without breaking our own ping-loading.
   **HOWEVER**: `will-navigate` DOES fire for form submissions (POST) and JS
   `window.location` redirects. v1.0.14 and earlier intercepted ALL of these
   — which killed Launchpad's "Sign in with Google" form POST for fresh users
   (re-issuing it as a bare GET via `shell.openExternal` → Launchpad 404)
   AND blocked Launchpad's `window.location = "3.basecamp.com/<acct>"`
   post-login redirect (leaving the webview parked on the "Logging you in…"
   page forever, session cookies in the system browser instead of
   `persist:basecamp`). Fixed in v1.0.15–v1.0.16 by whitelisting `AUTH_HOSTS`
   (launchpad, accounts.google.com, appleid.apple.com, login.microsoftonline.com,
   login.live.com, github.com) AND allowing `auth-host → basecamp.com`
   transitions. Existing users never hit this because their session was
   already in `persist:basecamp` and Basecamp's 302 skipped Launchpad
   entirely.
2. **`spctl --assess` on an unsigned/ad-hoc app says "Unnotarized Developer ID"**
   even though signing succeeded. Real test: `xcrun stapler validate` after
   `build-dmg.sh`.
3. **`notarytool submit <app>` rejects a raw .app** — must be .zip/.pkg/.dmg.
   We `ditto -c -k --keepParent` to zip for upload, then staple the .app.
4. **A failed notarization might still leave `status: Invalid`** — `build-dmg.sh`
   greps the output for `"status: Accepted"` and exits non-zero otherwise.
5. **Filenames in macOS DMG mount points contain spaces.** Always quote.
6. **The "manual mark as replied" expiry must only fire on lastDate ADVANCE**,
   not any change. Light-mode polls regress lastDate (no latest-line correction),
   and a strict-equality check incorrectly expires manual marks. Fixed.
7. **Sign-out wiping the webview needs more than `session.clearStorageData()`**:
   that races with Basecamp's running JS (which rewrites cookies before the
   clear lands) and misses Secure/HttpOnly cookies. Pattern in v1.0.18+:
   renderer navigates `frame.src='about:blank'` BEFORE calling `bp.signOut()`;
   main does `clearStorageData` + `clearCache` + `clearAuthCache` + an
   explicit per-host `cookies.get` → `cookies.remove` sweep across every
   basecamp.com / basecampapi.com / 37signals.com domain + `cookies.flushStore()`.
   Renderer also clears `markedReplied` and `localStorage['bping:markedReplied']`
   so a different user signing in afterwards doesn't inherit the prior user's
   "(replied)" flags.
8. **Forward feature limitations** (`bc-attachment` and `<img>` in clipboard
   HTML): Basecamp's Trix doc/comment editor strips `<img>` tags on paste
   (both external URLs AND `data:` URIs). It also won't expand
   `<bc-attachment sgid="...">` for orphan Attachments (ones not bound to a
   parent recording). So there is NO reliable way to inline-paste images
   from clipboard HTML into Basecamp docs — only filename `<a href>` links
   survive. Current Copy uses `<img src="data:...">` anyway as a hopeful
   fallback (in case a future Basecamp release relaxes the sanitizer), with
   the filename link below as a guaranteed survivor.

## How recipients install

1. Double-click `bping.dmg`.
2. Drag `bping.app` into Applications.
3. Launch from Applications.
4. Click **Connect to Basecamp** → system browser opens → sign in → done.

No setup screen (credentials are baked in). They need their own Basecamp account.

## Test it ran (without GUI)

```bash
open "$HOME/Desktop/bping.app"
sleep 4
pgrep -fl "bping.app/Contents/MacOS"      # should show the process
osascript -e 'quit app "bping"'
```

Or just check Gatekeeper assessment:
```bash
spctl --assess --type execute --verbose "$HOME/Desktop/bping.app"
# → accepted source=Notarized Developer ID
xcrun stapler validate "$HOME/Desktop/bping.dmg"
# → The validate action worked!
```

## When in doubt

This is the only doc — `~/Documents/bping-apps/CLAUDE.md` does *not* exist.
