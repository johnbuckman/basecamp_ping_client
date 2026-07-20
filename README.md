# basecamp_ping_client (bping)

A native macOS app for managing Basecamp **Pings** (direct messages / circles) — a sidebar list of all your conversations with unread tracking, plus the real Basecamp chat UI embedded on the right, so you don't lose features like boosts, replies, attachments, and read receipts.

Built because the official Basecamp web app doesn't surface unread pings prominently enough, and tracking which conversations you've already replied to is awkward inside a sprawling browser tab.

## Screenshot

Sidebar of pings sorted unread-first, then by recency. Click a row → the real Basecamp chat for that conversation loads in the right pane via an embedded `<webview>` sharing a persistent Basecamp login.

## Features

- **All your pings in one sortable list** — unread first, then by latest activity. Avatar, last-line excerpt, relative timestamp, unread count badge.
- **Color-coded reply state** — `(new)` rows are highlighted; `(replied)` rows are quieted once you've responded. Right-click → "Mark as replied" if you replied somewhere other than bping (the mark auto-expires when new activity arrives).
- **Native macOS notifications** when a new ping arrives while bping isn't focused. Click the notification → bping focuses and opens that conversation.
- **Auto-select latest ping on launch** and auto-switch when a background ping arrives, so opening bping always shows you the conversation you actually want.
- **Forward bookmarked messages** — bookmark comments in Basecamp's `…` menu (right pane), click **Forward ↪** in our toolbar, pick a recipient from your existing pings, and bping sends a rich-text line quoting each bookmarked comment with a link back to its author. Bookmarks are auto-cleared after a successful forward.
- **Copy bookmarked messages to the clipboard** — same scan, but writes both rich HTML and plain text to the system clipboard with each comment quote-prefixed and authors grouped. Designed for pasting into Basecamp docs, comments, emails, or notes.
- **OAuth via system browser** — auth opens in your default browser so passkeys, password manager, and your existing Basecamp session all work. No embedded login form.
- **Bulletproof sign-out** — clears OAuth tokens AND the embedded webview's cookies / cache / HTTP auth / per-host cookie sweep, so handing the laptop to someone else is safe.

## Install

Grab the latest `bping-v<version>.dmg` from the releases. The DMG is signed with a Developer ID Application certificate and Apple-notarized + stapled — double-click, drag to `/Applications`, launch. No Gatekeeper warning, no right-click → Open.

### First launch — register your own 37signals integration

bping doesn't ship with any OAuth credentials. You register a free 37signals Launchpad integration once (takes ~30 seconds), and bping stores the Client ID + Secret in `~/Library/Application Support/bping/config.json` on your machine.

1. Launch bping. The setup screen prompts for OAuth credentials.
2. Click the **launchpad.37signals.com/integrations** link → your default browser opens.
3. Click **New integration**. Name it whatever (e.g. "bping on my laptop"). For **Redirect URI**, paste the value bping shows in the Redirect URI field (default: `http://localhost:8089/oauth/callback`). Save.
4. Copy the **Client ID** and **Client Secret** from the integration's detail page, paste into bping, click **Save & continue**.
5. Click **Connect to Basecamp** → your default browser opens to authorize.
6. Sign into Launchpad as usual. The browser tab confirms "Sign-in complete" → bping picks up automatically.
7. Pick which Basecamp account you want to use (if you're in more than one).
8. Done — the pings list populates and the right pane logs you into Basecamp via its own webview session.

To edit the OAuth credentials later (rotate a leaked secret, switch to a different integration), click the **⚙** button in the sidebar header. Changing credentials clears the current token and bounces you back to the Connect screen.

## Build from source

```bash
git clone <this repo>
cd basecamp_ping_client
npm install
./build-dmg.sh
```

`build-dmg.sh`:
- Bumps the patch version in `package.json` (skip with `BPING_SKIP_BUMP=1`).
- Packages the `.app` via `electron-packager`.
- Signs every nested Mach-O with the Developer ID Application cert from your keychain (falls back to ad-hoc signing if no cert).
- Notarizes + staples if `BPING_NOTARIZE=1` is set (otherwise signed-but-not-notarized, faster iteration — recipients see "developer cannot be verified" → right-click → Open).
- Builds the DMG, removes the prior `bping-v*.dmg` from `dist/`, `~/Documents/bping-apps/`, and `~/Desktop/`, and copies the new one to all three.
- Auto-quits any running bping, replaces `/Applications/bping.app`, and relaunches.

Skip the auto-install step with `BPING_SKIP_INSTALL=1`.

To run locally without packaging: `npm start`.

## Windows

bping also runs on Windows (same codebase, platform differences are gated on `process.platform`):

- **Run from source:** `npm install`, then `npm start`.
- **Config path:** credentials and tokens live in `%APPDATA%\bping\` (`config.json`, `tokens.json`) instead of `~/Library/Application Support/bping/`. The setup screen shows the exact path for your machine.
- **Close-to-tray:** closing the window hides bping to the system tray so ping polling and notifications keep running (that's the whole point of the app). Reopen from the tray icon; quit via the tray menu's **Quit**.
- **Notifications** arrive as Windows toasts; clicking one restores the window and opens that conversation.
- **Toast attribution:** until an installer registers a Start-menu shortcut carrying bping's AppUserModelID, Windows may attribute toasts to a generic app name. If toasts don't show up at all, check **Focus Assist** and your Windows notification settings.
- **Single instance:** launching bping while it's already running focuses the existing window instead of starting a second copy.
- **Blocked OAuth port:** if Windows has reserved port 8089 (excluded port ranges), sign-in fails with a "port blocked" message — change the Redirect URI port in **⚙** settings *and* in your 37signals integration.
- **Sign-in hangs on "Waiting for sign-in":** register your integration's Redirect URI with `127.0.0.1` instead of `localhost` (an IPv6 loopback edge case).
- **Build a Windows app:** `npm run make-ico` regenerates `icon.ico` from `icon.icns` (already committed; only needed when `icon.icns` changes), then `npm run package:win` → `dist/bping-win32-x64\bping.exe`.
- **SmartScreen caveat:** the exe is unsigned, so first launch shows "Windows protected your PC" — click **More info → Run anyway**.

## OAuth setup

Each user registers their own free 37signals Launchpad integration and enters its Client ID + Secret on bping's setup screen. The credentials are saved to `~/Library/Application Support/bping/config.json` on that user's machine — **never committed to source control, never shared**. See the "First launch" section above.

To rotate or switch integrations: click the **⚙** button in the sidebar. The form pre-fills the current Client ID (the secret field shows "(leave blank to keep current)" — fill it only if you're replacing the secret). Saving with changed credentials clears the local OAuth token and forces a fresh sign-in.

## Architecture, conventions, and gotchas

See [`CLAUDE.md`](./CLAUDE.md) for the full project doc:
- Where the OAuth tokens / config live (`~/Library/Application Support/bping/`)
- How the renderer's state machine drives the gate (setup → connect → picker → main)
- The Basecamp API quirks bping has to work around (pings undocumented, bookmarks per-recording, `<bc-attachment>` doesn't survive paste, X-Frame-Options stripping, etc.)
- The webview `will-navigate` whitelist that keeps OAuth login flows working
- The bulletproof sign-out sequence
- The signing + notarization pipeline

## Stack

- [Electron](https://www.electronjs.org/) for the cross-platform wrapper (macOS and Windows build targets).
- 37signals Launchpad OAuth2 (no PKCE — Launchpad requires the client secret).
- Direct Basecamp 4 API calls via `fetch` with bearer tokens — no third-party SDK.
- Pure HTML/CSS/vanilla JS for the renderer. No framework.
- `electron-packager` + `codesign` + `xcrun notarytool` for distribution.

## License

GPL-3.0-or-later. See [`LICENSE`](./LICENSE).

This is a personal tool that interacts with Basecamp's API; it is not affiliated with or endorsed by 37signals.
