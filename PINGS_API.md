# Basecamp Pings via the API — the missing manual

Basecamp's "Pings" (one-on-one and small-group direct messages) are not documented in the public [bc3-api](https://github.com/basecamp/bc3-api) repo. Search the docs for "ping" and you'll find nothing. But they're fully reachable from any normal OAuth2 token issued by 37signals Launchpad — they're just *unlabeled*. Internally Basecamp calls them **circles**, and a ping conversation is just a `Chat` recording living in a private per-pair "circle" bucket.

This file documents everything I learned reverse-engineering the API while building [bping](./README.md). All of it is verified working against production accounts as of mid-2026. If you find that something has changed, file an issue.

## TL;DR

| What you want to do | Endpoint |
| --- | --- |
| List my ping conversations + unread state | `GET /my/readings.json` (filter `section == "pings"`) |
| Read a ping conversation | `GET /buckets/<bucket>/chats/<chat>/lines.json` |
| Send a plain-text line | `POST /buckets/<bucket>/chats/<chat>/lines.json` body `{"content":"hi"}` |
| Send a rich-text (HTML) line | same, body `{"content":"<div>...</div>","content_type":"text/html"}` |
| Attach an image / file | `POST /buckets/<bucket>/chats/<chat>/uploads.json?name=<filename>` with raw binary |
| Find someone's person ID + check if pingable | `GET /circles/people.json` |
| Start a brand-new ping with someone | (Hard, OAuth-only doesn't work — see below) |
| Bookmark / unbookmark a recording | Per-recording `bookmark_url` field |

Skip to the section you need.

## Authentication

Use 37signals Launchpad OAuth2 just like any other documented endpoint. Register an integration at <https://launchpad.37signals.com/integrations> — for this guide I assume you already have a Bearer access token in `$TOKEN` and your account ID in `$ACCT`.

```bash
TOKEN="your-bearer-token"
ACCT="3671212"   # your Basecamp account id
```

Every call below also needs `User-Agent: <something descriptive>` — the API returns HTTP 400 with the message *"Provide a User-Agent header…"* if you forget it.

## Listing your ping conversations

There is no `GET /my/pings.json` (it 404s). Pings come through the same notifications endpoint as everything else:

```bash
curl -s -H "Authorization: Bearer $TOKEN" -H "User-Agent: My App" \
  "https://3.basecampapi.com/$ACCT/my/readings.json"
```

The response has two arrays — `unreads` (capped at ~100, not paginated) and `reads` (paginated, 50 per page via `?page=N`). Filter to entries where `section == "pings"`:

```jsonc
{
  "unreads": [
    {
      "section": "pings",
      "unread_count": 3,
      "unread_at": "2026-06-04T09:45:05Z",
      "updated_at": "2026-06-04T09:45:05Z",
      "creator": { "id": 12345, "name": "Aris", "avatar_url": "..." },
      "participants": [
        { "id": 67890, "name": "Vid", "avatar_url": "..." },
        { "id": 12345, "name": "Aris", "avatar_url": "..." }
      ],
      "content_excerpt": "Hi John, I am having a bizarre experience…",
      "app_url": "https://app.basecamp.com/3671212/circles/4198864",
      "subscription_url": "https://3.basecampapi.com/3671212/buckets/4198864/recordings/582416224/subscription.json"
    }
  ],
  "reads": [...]
}
```

Key fields:

- **`unread_count`** — number of new lines since you last read.
- **`participants`** — everyone in the ping *except you*. Useful for displaying the conversation's name.
- **`creator`** — who sent the most recent line. Combine with `updated_at` to label "Aris, 2m ago".
- **`content_excerpt`** — preview of the last message (already HTML-stripped).
- **`app_url`** — points at the chat in the Basecamp web app: `https://app.basecamp.com/<acct>/circles/<circle_id>`.
- **`subscription_url`** — buried inside this URL are the bucket + chat IDs we need for everything else.

### Extracting the bucket and chat IDs

The `subscription_url` looks like:

```
https://3.basecampapi.com/3671212/buckets/4198864/recordings/582416224/subscription.json
```

Regex it out:

```js
const m = item.subscription_url.match(/buckets\/(\d+)\/recordings\/(\d+)/);
const bucket = m[1];   // 4198864  — the "circle" bucket id
const chat   = m[2];   // 582416224 — the Chat recording id
```

The `chat` value is both the recording id of the Chat and the path component you use when sending/reading lines. **This is the non-obvious part**: even though the URL says `recordings/<id>`, that `<id>` IS the chat id; the next endpoint you call uses it as `chats/<chat>`.

### "Recency" of a conversation

`/my/readings.json` shows the timestamp of the last *received* line. If you sent the most recent line yourself, it's not reflected — your sent message doesn't bubble the conversation up in this view. To get a true "last activity" timestamp, refresh from `/lines.json` after listing:

```js
const lines = await api(`/buckets/${bucket}/chats/${chat}/lines.json`);
const newest = lines[0];                 // newest-first
if (newest && newest.created_at > item.updated_at) {
  // your own sent line is more recent than what readings.json reported
  item.updated_at = newest.created_at;
}
```

## Reading a conversation

```bash
curl -s -H "Authorization: Bearer $TOKEN" -H "User-Agent: My App" \
  "https://3.basecampapi.com/$ACCT/buckets/$BUCKET/chats/$CHAT/lines.json"
```

Returns an array of lines, **newest first**. Each line has:

```jsonc
{
  "id": 9957528386,
  "type": "Chat::Lines::Plain",      // or RichText, or Upload
  "content": "<p>alfred would know</p>",
  "created_at": "2026-06-03T09:45:05Z",
  "creator": { "id": 10252082, "name": "John Buckman", "avatar_url": "..." },
  "app_url": "https://app.basecamp.com/3671212/circles/4198864@9957528386",
  "bookmark_url": "https://3.basecampapi.com/3671212/my/bookmarks/<signed>.json",
  "boosts_count": 0,
  "boosts_url": "https://3.basecampapi.com/3671212/buckets/4198864/recordings/9957528386/boosts.json",
  "attachments": []
}
```

**Pagination** is `?page=N`. The default page size is around 15–25 lines and may change page-to-page; assume cursor semantics, dedupe by `id` if you walk multiple pages.

## Sending a line

### Plain text

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" -H "User-Agent: My App" \
  -H "Content-Type: application/json" \
  --data '{"content":"hello from a script"}' \
  "https://3.basecampapi.com/$ACCT/buckets/$BUCKET/chats/$CHAT/lines.json"
```

**Important gotcha:** the default `content_type` is plain text, which means the field is HTML-escaped on render. **Don't wrap plain text in `<div>` or `<p>`** — the recipient sees literal `&lt;div&gt;…&lt;/div&gt;`.

### Rich text (HTML)

Add `content_type: "text/html"` to the body:

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" -H "User-Agent: My App" \
  -H "Content-Type: application/json" \
  --data '{"content":"<div>hello with <strong>style</strong></div>","content_type":"text/html"}' \
  "https://3.basecampapi.com/$ACCT/buckets/$BUCKET/chats/$CHAT/lines.json"
```

**Allowed HTML tags** (anything else gets stripped or 422'd):

```
div, h1, br, strong, em, strike, a[href], pre, ol, ul, li, blockquote
```

That's it. No `<p>` (use `<div>`), no `<img>`, no `<span>`, no inline styles.

### Attachments

You can't put attachments in the `content` field of a line — chat lines explicitly reject `<bc-attachment>` tags with HTTP 422. Attachments are sent as a **separate `Chat::Lines::Upload` line** via the `uploads.json` endpoint:

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" -H "User-Agent: My App" \
  -H "Content-Type: image/png" \
  -H "Content-Length: $(stat -f%z image.png)" \
  --data-binary @image.png \
  "https://3.basecampapi.com/$ACCT/buckets/$BUCKET/chats/$CHAT/uploads.json?name=image.png"
```

The response is a new Chat::Lines::Upload line with `attachments[]` populated:

```jsonc
{
  "type": "Chat::Lines::Upload",
  "content": null,
  "attachments": [{
    "filename": "image.png",
    "content_type": "image/png",
    "byte_size": 37628,
    "url": "https://preview.app.basecamp.com/3671212/blobs/<uuid>/previews/full",
    "download_url": "https://3.basecampapi.com/3671212/blobs/<uuid>/download/image.png"
  }]
}
```

To attach a file with an accompanying message, post two lines: one regular `content` line, then the `uploads.json` line. The Basecamp web UI renders them together.

## Downloading attachments

Attachment URLs are **authenticated**. You need the bearer token to fetch from `*.basecampapi.com`, and the server returns a 302 to a signed S3 URL on `storage.basecamp.com`. There are two non-obvious rules:

1. **Drop the bearer token on the redirect hop.** If you send `Authorization: Bearer …` to `storage.basecamp.com`, S3 returns 400 `objectNameNotDecodedYet`. Only send the bearer to `*.basecampapi.com`.
2. **Follow the redirect with the raw Location string.** Don't run it through `new URL().toString()` or any URL constructor — those re-encode the query string, which breaks the AWS signature.

Working pattern in JavaScript:

```js
async function fetchAttachment(downloadUrl) {
  let current = downloadUrl;
  for (let hops = 0; hops < 4; hops++) {
    const isApi = /^https:\/\/[a-z0-9-]+\.basecampapi\.com\//i.test(current);
    const headers = { 'User-Agent': 'My App' };
    if (isApi) headers.Authorization = 'Bearer ' + token;
    const r = await fetch(current, { method: 'GET', headers, redirect: 'manual' });
    if (r.status >= 300 && r.status < 400) {
      current = r.headers.get('location');   // raw string — do NOT parse
      continue;
    }
    return r;
  }
  throw new Error('too many redirects');
}
```

In bash:

```bash
# Step 1: hit the API host with the bearer, capture the Location.
LOC=$(curl -s -o /dev/null -w "%{redirect_url}" \
  -H "Authorization: Bearer $TOKEN" -H "User-Agent: My App" \
  "https://3.basecampapi.com/$ACCT/blobs/$UUID/download/image.png")
# Step 2: hit the S3 URL WITHOUT the bearer.
curl -s -o image.png -H "User-Agent: My App" "$LOC"
```

## Bookmarks — per-recording, not aggregated

The endpoint `GET /my/bookmarks.json` exists but **always returns `null`** under OAuth, even when the user has bookmarks made through the web UI. The aggregation is web-only (it's behind session cookies on the app host).

Every line/recording returned by `lines.json` has a `bookmark_url` field that IS reachable:

```
https://3.basecampapi.com/3671212/my/bookmarks/<signed-token>.json
```

- `GET` returns `{"bookmarked": true|false}` — the calling user's bookmark state for this specific recording.
- `DELETE` clears the bookmark (returns 204 No Content).
- `POST` and `PUT` return 404 — **you cannot create a bookmark via the OAuth API**. Users have to bookmark via the Basecamp UI itself.

**There is no `bookmarked_at` timestamp anywhere.** The entire bookmark response is `{"bookmarked": true}` — no information about *when* the bookmark was made. Any "bookmarks made in the last N minutes" feature is impossible on this API.

To enumerate the bookmarks across a chat:

```js
const lines = await api(`/buckets/${bucket}/chats/${chat}/lines.json`);
const bookmarked = [];
// Parallel-probe, but cap concurrency to stay under the 50req/10s rate limit.
const CONCURRENCY = 8;
let i = 0;
async function worker() {
  while (i < lines.length) {
    const line = lines[i++];
    if (!line.bookmark_url) continue;
    const r = await fetch(line.bookmark_url, {
      headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'My App' }
    });
    const j = await r.json();
    if (j.bookmarked) bookmarked.push(line);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
```

## Creating a brand-new ping (starting a circle)

This is the messiest part of the whole API. You can't simply "send a line to person X" — first you need a circle bucket and chat to exist between you and person X. If you've pinged them before, `/my/readings.json` already lists it. If not, you have to create it.

### The OAuth-only path (limited)

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" -H "User-Agent: My App" \
  -H "Content-Type: application/json" \
  --data "{\"users\":[$PERSON_ID]}" \
  "https://3.basecampapi.com/$ACCT/circles.json"
```

Returns **HTTP 204 No Content** with an empty body and no `Location` header. The circle is created (or already existed — the call is idempotent), but **you have no way to retrieve its id**. There's no `GET /circles.json` either (it returns null), and circle buckets do *not* show up in `/projects.json` (they're filtered out) or `/projects/<circleid>.json` (returns null).

So the OAuth-only path is good for ensuring a circle exists, but useless for actually sending a message because you can't find the bucket / chat ids.

### The app-host path (returns the id)

If you have session cookies for `3.basecamp.com` (e.g. you're running inside the same browser the user is logged into Basecamp with), you can hit the hidden `ping-shortcut` form endpoint:

```
POST https://3.basecamp.com/<acct>/my/sidebar/circles
Cookie: <session cookies>
Body (form-encoded):
  authenticity_token=<csrf>
  circle[users]=<person_id>   # comma-separated for group pings
  commit=Ping 'em
```

This returns a **302 redirect to `/my/sidebar/circles/<CIRCLE_ID>`** where `CIRCLE_ID` IS the bucket id. Follow the redirect and you've got your bucket.

To then find the chat (recording) id, GET the circle page HTML and regex `chats/(\d+)` out of it:

```js
const circlePage = await fetch(`https://3.basecamp.com/${acct}/my/sidebar/circles/${circleId}`, { credentials: 'include' });
const html = await circlePage.text();
const m = html.match(/chats\/(\d+)/);
const chatId = m && m[1];
```

Now you can POST the first line via the normal OAuth API:

```
POST /buckets/<CIRCLE_ID>/chats/<CHAT_ID>/lines.json
```

### Finding a person's id

To know what `person_id` to put in the create-circle body, you can hit either `/people.json` (paginated, ~50 per page, only people in your projects) or — much more complete — `/circles/people.json`:

```bash
curl -s -H "Authorization: Bearer $TOKEN" -H "User-Agent: My App" \
  "https://3.basecampapi.com/$ACCT/circles/people.json"
```

This returns the full roster of pingable people on the account (in a large account it can be 10,000+ entries). Each has `id`, `name`, `can_ping`, `attachable_sgid`.

## Other things to know

### Per-account vs identity IDs

37signals Launchpad has a global "identity" id for each user (e.g. `11154954`) used in the `/authorization.json` and `basecamp me` outputs. But each Basecamp **account** keeps its own per-account "person" id (e.g. `10252082`) — that's what shows up as `creator.id` on chat lines and `participants[].id` on pings.

To check if a message is yours, compare against `/my/profile.json` (which returns the per-account id), **not** against `basecamp me` (which returns the identity id):

```bash
curl -s -H "Authorization: Bearer $TOKEN" -H "User-Agent: My App" \
  "https://3.basecampapi.com/$ACCT/my/profile.json"
```

### Allowed HTML in a chat line, again, for clarity

In ascending order of how often I forget them:

- `<a href="…">` — links work, `target` and `rel` are stripped.
- `<blockquote>` — renders indented; nest carefully.
- `<div>` — the all-purpose block. Use this instead of `<p>`.
- `<h1>` — only `<h1>`, no `<h2>`–`<h6>`.
- `<br>` — line break inside a `<div>`.
- `<strong>`, `<em>`, `<strike>` — inline emphasis.
- `<pre>` — preformatted code; preserved whitespace.
- `<ol>`, `<ul>`, `<li>` — lists.

**Stripped or rejected:** `<p>`, `<span>`, `<img>`, `<bc-attachment>`, `<table>`, `<iframe>`, any inline `style` attribute, any class names, any custom elements.

### Rate limits

37signals' published limit is **50 requests per 10 seconds per token**. With multiple parallel calls (e.g. enumerating bookmarks across a chat), cap concurrency to ~8 and you'll stay well under. The API returns 429 with a `Retry-After` header if you hit the limit; back off accordingly.

### Embedding Basecamp in a web page

Basecamp sends `X-Frame-Options: SAMEORIGIN` and CSP `frame-ancestors 'self'`. You **cannot** embed `app.basecamp.com` or `3.basecamp.com` in a plain `<iframe>` — it renders blank.

In an Electron `<webview>` you CAN embed it, but you need to strip those headers via the network layer:

```js
session.fromPartition('persist:basecamp').webRequest.onHeadersReceived((details, cb) => {
  const h = details.responseHeaders || {};
  for (const k of Object.keys(h)) {
    const lk = k.toLowerCase();
    if (lk === 'x-frame-options') delete h[k];
    else if (lk === 'content-security-policy')
      h[k] = (Array.isArray(h[k]) ? h[k] : [h[k]]).map(v => v.replace(/frame-ancestors[^;]*;?/gi, ''));
  }
  cb({ responseHeaders: h });
});
```

### Dead-end endpoints (so you don't waste time)

These all return 404 or null and are confirmed not to work over OAuth:

- `GET /my/pings.json`
- `GET /circles/<id>.json`
- `GET /circles/<id>/lines.json`
- `GET /my/bookmarks.json` (returns `null`, never populates)
- `POST /attachments.json?name=…` with binary → DOES return an `attachable_sgid`, but orphan Attachments (not bound to a recording) won't render via `<bc-attachment>` paste in Basecamp docs/comments. So this endpoint exists but isn't useful for re-embedding attachments from one place to another.

### Why "circles" and not "pings"?

The internal name is `Circle` (the model class), reflecting the small-group-chat origin. The user-facing name became "Pings" later. You'll see both in URLs: `/circles/<id>` on the app host, `/buckets/<circle_id>/chats/<chat_id>/...` on the API host.

## A complete example: send a ping from the command line

Putting it all together — send the message "Hi from a script" to the most recent ping conversation:

```bash
#!/bin/bash
set -e
TOKEN="your-bearer-token"
ACCT="3671212"

# 1. Find the most recent ping conversation.
PING=$(curl -s -H "Authorization: Bearer $TOKEN" -H "User-Agent: My App" \
  "https://3.basecampapi.com/$ACCT/my/readings.json" \
  | python3 -c '
import sys, json, re
d = json.load(sys.stdin)
for item in d.get("unreads", []) + d.get("reads", []):
    if item.get("section") == "pings":
        m = re.search(r"buckets/(\d+)/recordings/(\d+)", item["subscription_url"])
        if m:
            print(m.group(1), m.group(2))
            break
')
BUCKET=$(echo $PING | awk '{print $1}')
CHAT=$(echo $PING | awk '{print $2}')

# 2. Send a plain-text line.
curl -X POST \
  -H "Authorization: Bearer $TOKEN" -H "User-Agent: My App" \
  -H "Content-Type: application/json" \
  --data '{"content":"Hi from a script"}' \
  "https://3.basecampapi.com/$ACCT/buckets/$BUCKET/chats/$CHAT/lines.json"
```

That's all of it. If you're building something on top of pings — a Slack-style bridge, a notifier, a backup tool — that's the same shape of code we use inside [bping](./README.md).

## License + disclaimers

This is reverse-engineered from observation. Endpoints that work today may stop working tomorrow if 37signals tightens things up. Don't build paying customer features on top of undocumented endpoints without a fallback. Don't spam — these endpoints share the same rate limits as everything else.

bping itself is GPL-3.0 (see [`LICENSE`](./LICENSE)) and is not affiliated with or endorsed by 37signals.
