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

First launch:
1. Click **Connect to Basecamp** → your default browser opens.
2. Sign into 37signals Launchpad as usual.
3. The browser tab confirms "Sign-in complete" → bping picks up automatically.
4. Pick which Basecamp account you want to use (if you're in more than one).
5. Done — the pings list populates and the right pane logs you into Basecamp via its own webview session.

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

## OAuth setup

The OAuth client ID and secret are baked into `main.js` (ROT19-obfuscated to keep them out of plain `strings`/`grep`). They're for a 37signals Launchpad integration owned by the developer.

To rotate: register a new integration at <https://launchpad.37signals.com/integrations>, set its Redirect URI to `http://localhost:8089/oauth/callback`, and replace the two ROT19-encoded constants at the top of `main.js`.

To use a different integration: pass `--scope full` or use the in-app setup screen (currently hidden behind the baked-in defaults, but the `creds:save` IPC handler is wired and will overwrite `config.clientId` / `config.clientSecret` on disk).

## Architecture, conventions, and gotchas

See [`CLAUDE.md`](./CLAUDE.md) for the full project doc:
- Where the OAuth tokens / config live (`~/Library/Application Support/bping/`)
- How the renderer's state machine drives the gate (setup → connect → picker → main)
- The Basecamp API quirks bping has to work around (pings undocumented, bookmarks per-recording, `<bc-attachment>` doesn't survive paste, X-Frame-Options stripping, etc.)
- The webview `will-navigate` whitelist that keeps OAuth login flows working
- The bulletproof sign-out sequence
- The signing + notarization pipeline

## Stack

- [Electron](https://www.electronjs.org/) for the cross-platform wrapper (currently macOS-only build target).
- 37signals Launchpad OAuth2 (no PKCE — Launchpad requires the client secret).
- Direct Basecamp 4 API calls via `fetch` with bearer tokens — no third-party SDK.
- Pure HTML/CSS/vanilla JS for the renderer. No framework.
- `electron-packager` + `codesign` + `xcrun notarytool` for distribution.

## License

GPL-3.0-or-later. See [`LICENSE`](./LICENSE).

This is a personal tool that interacts with Basecamp's API; it is not affiliated with or endorsed by 37signals.
