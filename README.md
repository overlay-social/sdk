# @overlay-social/sdk

[![npm version](https://img.shields.io/npm/v/@overlay-social/sdk.svg)](https://www.npmjs.com/package/@overlay-social/sdk)
[![CI](https://github.com/overlay-social/sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/overlay-social/sdk/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Open%20BSV-blue.svg)](LICENSE)

TypeScript SDK for **overlay.peck.to** — the canonical BSV / BRC-100 social
overlay behind peck.to, peck.bio, peck.press and friends.

The package root is a **pure read lens**: the hydrated `/v2` read model plus
the `/v1` facade for identity resolution, profiles, feed, and overlay state. It does **not** write, mint, pay, or federate — those
capabilities do not exist on the live service, and this SDK only exposes what
actually runs. The package is being organised into independent subpath modules
so further capabilities can be added without changing the read client; see
[Modules](#modules).

```bash
npm install @overlay-social/sdk
```

Requires native `fetch` (Node 18+, modern browsers, edge runtimes). On older
Node, pass your own `fetch` via the constructor.

## Quick start

```ts
import { createReadClient } from '@overlay-social/sdk/read'

const overlay = createReadClient() // -> https://overlay.peck.to/v2

const page = await overlay.feed({ limit: 20, type: 'post' })
for (const post of page.items) {
  console.log(post.author.displayName, post.text, post.counts.likes)
}
const more = page.next ? await overlay.feed({ limit: 20, type: 'post', cursor: page.next }) : null
```

## The /v2 read model (recommended)

`createReadClient()` reads the overlay's `/v2` endpoints, which serve the
**peck-view/v1** contract: posts arrive already hydrated with their author
(name, handle, picture), counts, media, one level of referenced post and a
stub of the parent. A screen needs one call, and every client shows the same
author for the same key. The views are viewer-independent; the one
per-viewer read is `viewerState()`.

| Method | Endpoint | Returns |
| --- | --- | --- |
| `feed(query?)` | `GET /v2/feed` | `FeedPage` (`items`, `next` cursor or `null`) |
| `post(txid)` | `GET /v2/post/:txid` | `ThreadView` (post, parent, every descendant reply) |
| `profile(keyOrHandle)` | `GET /v2/profile/:key` | `ProfileView` (address, public key, `@handle` or `handle`) |
| `posts(txids)` | `POST /v2/posts` | `PostBatch` (`posts` in request order, `missing`); chunked at 100 |
| `viewerState({ viewer, txids?, authors? })` | `POST /v2/viewer/state` | `ViewerState` (liked/reposted, following/blocked/muted); chunked at 200 |
| `search(q \| { q, ... })` | `GET /v2/search` | `FeedPage` of best matches (`next` is always `null`) |
| `reactions(txid, { kind?, limit?, cursor? })` | `GET /v2/post/:txid/reactions` | `ReactionPage`: who liked (or, with `kind: 'repost'`, reposted) a post, newest first |
| `apps({ type? })` | `GET /v2/apps` | `AppList`: posts per app, most first |
| `stats()` | `GET /v2/stats` | `SiteStats`: site totals (`posts`, `accounts`), row estimates |
| `channels({ limit? })` | `GET /v2/channels` | `ChannelList`: channels by recent posts (`posting`) and chat rooms by latest message (`rooms`) |
| `identities({ limit? })` | `GET /v2/identities` | `IdentityList`: who is on peck, newest first, each an `AuthorView`, plus the `total` |
| `lenses({ issuer?, scope?, limit? })` | `GET /v2/lenses` | `LensList`: published moderation lenses, newest first, the issuer an `AuthorView` |

**Paging.** `next` is a structured cursor. Pass it back unchanged as
`cursor`, with the same filters, to get the following page; its keys depend on
the `rank`, so treat it as opaque.

**Locations.** A post with a location has `geo` (`lat`, `lng`, `category`).
`feed()` filters on it:

```ts
// Everything with a location.
await overlay.feed({ hasGeo: true })
// A rectangle: latitude first, then longitude. `minLng` greater than `maxLng`
// means the box crosses the antimeridian.
await overlay.feed({ bbox: { minLat: 59.8, minLng: 10.6, maxLat: 60.0, maxLng: 10.9 } })
// A circle, in kilometres along the great circle.
await overlay.feed({ near: { lat: 59.9139, lng: 10.7522, radiusKm: 5 }, type: 'post' })
```

`bbox` and `near` imply `hasGeo`, and combine with every other filter, every
`rank` and `cursor`.

**Reactions.** `reactions(txid)` pages through the likes of a post; the pages
add up to `post.counts.likes`. A like from a key the overlay cannot resolve has
`author: null` and the raw value in `actorKey`.

```ts
let page = await overlay.reactions(txid, { limit: 50 })
const likers = [...page.items]
while (page.next) {
  page = await overlay.reactions(txid, { limit: 50, cursor: page.next })
  likers.push(...page.items)
}
```

**Sidebars and pickers.** `channels()`, `identities()` and `lenses()` are
viewer-independent and cacheable. A channel name goes
back into `feed({ channel })`, a lens id into `feed({ lens: [lensId] })`:

```ts
const { posting, rooms } = await overlay.channels({ limit: 10 })
const { items: people, total } = await overlay.identities({ limit: 5 })
const { items: lenses } = await overlay.lenses()
await overlay.feed({ channel: posting[0]?.channel, lens: lenses.map((l) => l.lensId) })
```

**Errors.** Every failure throws a `ReadError` with a stable `code` and the
HTTP `status` (0 when there was no response):

| `code` | When |
| --- | --- |
| `bad_request`, `not_found`, `timeout`, `internal` | The overlay answered with an `ErrorResponse` (or a bare status) |
| `network` | No response: DNS, connection, CORS |
| `timeout` | Also raised when the client's own `timeoutMs` fires (status 0) |
| `invalid_response` | A 2xx body that is not the expected view |

Aborting through `signal` rejects with the signal's reason unchanged, as
`fetch` does.

```ts
import { createReadClient, isReadError } from '@overlay-social/sdk/read'

const overlay = createReadClient({ timeoutMs: 8000 })
try {
  const thread = await overlay.post(txid, { signal })
} catch (e) {
  if (isReadError(e) && e.code === 'not_found') showMissing()
  else throw e
}
```

**Types.** All view types (`PostView`, `AuthorView`, `ThreadView`,
`ProfileView`, `FeedPage`, `ViewerState`, …) are exported. They are generated
from a vendored copy of the contract's JSON Schema
(`src/read/peck-view/peck-view.schema.json`); `npm run sync:peck-view -- <path>`
refreshes both, and `npm run check:peck-view` fails when the committed types
are stale.

## The /v1 client

`createOverlayClient()` is unchanged. It reads the `/v1` facade and remains
the way to reach endpoints `/v2` does not cover yet: identity bundles,
friends, notifications, follows, blocks and topic state.

```ts
import { createOverlayClient } from '@overlay-social/sdk'

const overlay = createOverlayClient() // -> https://overlay.peck.to

const feed = await overlay.getFeed({ limit: 20, type: 'post' })
```

### Enriching a /v1 feed

Feed authors are **P2PKH base58 addresses**. Resolve a whole page in one
round-trip, then overwrite name/avatar/handle **defensively** — enrichment must
never break the feed:

```ts
const { data } = await overlay.getFeed({ limit: 50, type: 'post' })
const addresses = [...new Set(data.map((p) => p.author).filter(Boolean) as string[])]
const ids = await overlay.resolveIdentities({ addresses }) // {} on any error

const rows = data.map((p) => {
  const id = p.author ? ids[p.author] : undefined
  return {
    ...p,
    displayName: id?.displayName ?? p.display_name ?? p.author,
    handle: id?.handle ?? null,
    avatarRef: id?.avatarRef ?? null,
  }
})
```

`resolveIdentities` returns `{}` on any failure and omits keys that have no
canonical ProfileToken, so a UI that reads `ids[author]?.displayName ?? fallback`
never throws.

### /v1 API

| Method | Endpoint | Returns |
| --- | --- | --- |
| `resolveIdentities({pubkeys?, addresses?})` | `POST /v1/identities/resolve` | `Record<inputKey, ResolvedIdentity>` (`{}` on error/empty) |
| `getIdentity(pubkey)` | `GET /identity/:pubkey` | `IdentityBundle \| null` |
| `resolveHandle(handle)` | `GET /resolve/:handle` | `HandleResolution \| null` |
| `getProfile({subject\|owner\|outpoint})` | `GET /v1/bio/profile` | `ProfileRow \| null` |
| `listIdentities({limit?, offset?})` | `GET /v1/identities` | `DiscoveredIdentity[]` (`[]` on error) |
| `getFriends(subject)` | `GET /v1/friends/:subject` | `FriendsResponse` (mutual/pendingIn/pendingOut + legacy) |
| `getNotifications(address, params?)` | `GET /v1/notifications/:address` | `NotificationItem[]` (`[]` on error) |
| `getFollows(address)` | `GET /v1/follows/:address` | `FollowsResponse` |
| `getBlocks(address, kind?)` | `GET /v1/blocks/:address` | `BlockEntry[]` (outgoing only, by design) |
| `getFeed(params)` | `GET /v1/feed` (incl. `near`/`bbox` geo; `bbox` is `[west, south, east, north]`) | `FeedResponse` (throws on upstream failure) |
| `getPost(txid)` | `GET /v1/post/:txid` | `PeckRow \| null` |
| `getThread(txid)` | `GET /v1/thread/:txid` | `{post, replies}` |
| `getState()` | `GET /state` | `OverlayState` (topics + on-chain anchors) |
| `getTopicRoot(topic)` | `GET /v1/topic/:topic/root` (fallback `/state`) | `TopicState \| null` |
| `getAnchor(topic)` | client-side over `/state` | `TopicAnchor \| null` |
| `verifyRoot(topic)` | client-side over `/state` | `{anchored, matchesLive, liveRoot, anchoredRoot, txid}` |

### Avatar field divergence in /v1 (read this)

The live overlay is not internally consistent and the SDK does **not** hide it:

- `resolveIdentities` and `getProfile().state` give **`avatarRef`** — the raw
  on-chain reference, e.g. `uhrp://<sha256>`.
- `getIdentity().profile` gives **`avatarUrl`** — an already-resolved `https://`
  URL.

Both are typed verbatim so you choose how to render.

## Data reality (honest)

- `getFeed` runs against ~2.5M indexed pecks today — most rows already carry a
  `display_name`.
- The identity layer is live but small: light self-attested profiles/handles
  (BRC-3) plus legacy ProfileTokens, with **key-binding collapse** — a bound
  posting key or address resolves to its identity root's canonical profile.
  Accounts without any attestation resolve empty; enrichment is additive and
  grows with adoption.
- `getFriends` reads the mutual-consent friendship layer (two one-way BRC-3
  attestations = an active pair). Legacy BAP-era friend rows are exposed
  display-only and never count toward mutual.
- Every topic's Merkle state-root is **anchored on-chain** (1Sat ordinal with a
  logical prev-chain); `verifyRoot(topic)` tells you whether the served state
  matches the anchored root right now.

## Configuration

```ts
const overlay = createOverlayClient({
  baseUrl: 'https://overlay.peck.to', // default
  timeoutMs: 8000,                    // hard per-request ceiling
  fetch: myFetch,                     // optional injected fetch
})
```

## Not included (on purpose)

No writing / minting / wallet / payment-channel / paywall / federation in the
read clients (the package root and `/read`). Reads go through `/v2/*` and the
`/v1/*` + `/identity` + `/resolve` + `/state` facade, **never**
the BRC-24 `peck-schema` lookup (that `lookup()` is a deliberate no-op), and
**never** WhatsOnChain.

## Modules

The package root keeps exporting the read client, exactly as before. Each
capability lives on its own subpath, so importing the read client never pulls
in wallet or crypto code (`sideEffects` is `false`, and every subpath is a
separate ESM entry point with its own type declarations).

| Subpath | Purpose | Status |
| --- | --- | --- |
| `@overlay-social/sdk/read` | Typed read clients for the overlay: `/v2` read model (recommended) and the `/v1` facade (same surface as the package root) | available |
| `@overlay-social/sdk/schema` | Builders for B / MAP / AIP transaction outputs, signed through a BRC-100 wallet | available |
| `@overlay-social/sdk/wallet` | Connect to a BRC-100 wallet through the available substrates, with one normalised error shape | available |
| `@overlay-social/sdk/submit` | Send a signed transaction from the browser to the overlay, with a typed error for every failure | available |
| `@overlay-social/sdk/identity` | The rules for showing an author: display name, handle, short key and avatar URL, the same ones the overlay applies | available |
| `@overlay-social/sdk/sanitize` | One HTML sanitising profile for chain content: markdown to safe HTML for browsers and server rendering | available |
| `@overlay-social/sdk/dm` | End-to-end encrypted direct messages: BRC-42 envelopes and a message-box client, compatible with peck.to | available |
| `@overlay-social/sdk/peckos` | Bridge client for apps that run inside Peck OS | available |

A subpath is only added to the `exports` map when its module ships.

```ts
import { createReadClient, createOverlayClient } from '@overlay-social/sdk/read' // same as the root import
```

## Bitcoin Schema builders (`/schema`)

One builder per social action, producing the OP_RETURN output every peck
client writes: a B section for the content, MAP for the metadata, and an AIP
signature. The layouts match what the peck.to web client writes today byte for
byte (the tests replay mainnet transactions).

```ts
import { post, reply, like, signPayload } from '@overlay-social/sdk/schema'

const lockingScript = await signPayload(post({ app: 'peck.to', text: 'gm', tags: ['bsv'] }), { wallet })
await wallet.createAction({
  description: 'Post',
  outputs: [{ lockingScript: lockingScript.toHex(), satoshis: 0, outputDescription: 'Post' }],
})
```

| Builder | Writes |
| --- | --- |
| `post({ app, text?, media?, channel?, tags?, geo?, mentions? })` | B (text or media) + `MAP SET type post` (+ `ADD tags`) |
| `pin({ app, geo, title, description?, category?, tags?, mentions? })` | a post with a location, laid out as peck.world writes it (see [Locations](#locations-and-pins)) |
| `reply({ ..., parentTxid })` | as `post`, pointing at the parent (`context tx`, `tx`, `reply`) |
| `quote({ ..., targetTxid })` | own content + `type repost`, `tx <target>` |
| `repost({ app, targetTxid })` | `MAP SET type repost tx <target>` |
| `like` / `unlike({ app, targetTxid })` | `MAP SET type like\|unlike tx <target>` |
| `follow` / `unfollow({ app, address, handle? })` | `MAP SET type follow\|unfollow [handle] address` |
| `tag({ app, targetTxid, tags, category?, lang?, tone? })` | `MAP SET type tag context tx tx <target> tags a,b` |
| `message({ app, text, channel? \| recipient? })` | B `text/plain` + `MAP SET type message` |
| `payment({ app, targetTxid, recipient, amount })` | `MAP SET type payment tx <post> paymail <recipient> value <sats>` (see [Tips](#tips-and-identity-profiles)) |
| `profile({ app, displayName, avatar?, bio?, certRef? })` | `MAP SET type profile display_name …` |

Builders are pure and synchronous and return a `SchemaPayload`. They reject
empty values and values that would read as a section separator. `signPayload()`
appends the AIP section and returns an `@bsv/sdk` `LockingScript`.

### Locations and pins

A pin is a post with a location. Any app can attach one to a post, reply or
quote with `geo`, and every reader that looks at coordinates shows it.

```ts
post({ app: 'peck.to', text: 'Coffee here', geo: { lat: 59.9139, lng: 10.7522 } })
post({ app: 'example.app', text: 'Summit', geo: { lat: 61.6363, lng: 8.3125, alt: 2469.5, geohash: true } })
pin({ app: 'peck.world', title: 'Cafe', category: 'business', geo: { lat: 59.9139, lng: 10.7522 } })
```

A location is written as MAP `SET` pairs, in this order:
`lat <n> lng <n> [alt <n>] [geohash <base32>]`. These are the keys the indexer
reads. Numbers are plain decimals: no exponent, no trailing zeros, `lat` and
`lng` rounded to at most `precision` decimals (default 6, about 0.1 m; 0 to
15), `alt` to 2. The same location always produces the same bytes, and a value
that is written short stays as `String(n)` prints it (`59.9`, not
`59.899999999999999`). A location on chain is permanent and public; pass a
lower `precision` to publish a coarser one.

Values are checked before anything is written: `lat` within ±90, `lng` within
±180, every number finite, and not exactly 0,0 (which the indexer ignores, so
it would never show). `geohash: true` (or a length from 1 to 12) computes a
geohash from the coordinates as written; a string is checked against them and
written lowercased. `encodeGeohash()`, `decodeGeohash()` and `normalizeGeo()`
are exported for readers and forms.

`pin()` adds what peck.world writes for a pin: the B section is the markdown
`# <title>` (and a description under it) named `pin.md`, and MAP carries
`category` (one of `PIN_CATEGORIES`, default `general`) and `title` after the
location. The type stays `post`: there is no separate pin type.

**Signing.** The SDK never holds a private key. `signPayload()` asks the
wallet (any BRC-100 `WalletInterface`, e.g. the one `PeckOS.detect()` returns)
for the signing key and for a signature over the digest. By default the key is
derived with protocol `[1, 'identity']`, key ID `'1'` and counterparty
`'self'`, the key peck.to clients sign with. The signature is checked against
the key before it is used.

**AIP, BRC77 over the full preimage.** The signed bytes are the data of every
push after OP_FALSE OP_RETURN, up to and including the signing key: the B and
MAP sections, each separator as the byte `0x7c`, then the AIP prefix, `BRC77`
and the key. Length prefixes and the signature push are not included. The
digest is one SHA-256, and the script carries the DER signature in base64.
`verifyAip(script)` checks it. Details are in `src/schema/aip.ts`.

### Tips and identity profiles

A tip is one transaction with two outputs: the social record, and the money.
The record is `payment()`, signed with `signPayload()` like any other. The
money is a standard BRC-29 payment to the author's BRC-100 identity key (the
`identityKey` the overlay returns for each author), built by `brc29Output()`.
It is not a plain payment to the address a post was signed with: BRC-100
wallets do not track those coins. Neither call sets a fee rate; the wallet
chooses it.

```ts
import { brc29Output, payment, signPayload } from '@overlay-social/sdk/schema'

const record = await signPayload(payment({ app: 'peck.to', targetTxid, recipient: identityKey, amount: 500 }), { wallet })
const pay = await brc29Output(wallet, { recipientIdentityKey: identityKey, satoshis: 500 })
await wallet.createAction({
  description: 'Tip',
  outputs: [
    { lockingScript: record.toHex(), satoshis: 0, outputDescription: 'Tip record' },
    { lockingScript: pay.lockingScript, satoshis: pay.satoshis, outputDescription: pay.outputDescription, customInstructions: pay.customInstructions },
  ],
  options: { randomizeOutputs: false },
})
// then hand the transaction and pay.remittance to the recipient (PeerPay / MessageBox)
```

`identityProfile()` writes a peck-identity-v1 profile: a MAP `type profile`
record that the identity key signs itself (BRC-3, protocol `[1, 'profile']`,
a random serial as key ID, counterparty `anyone`), with no AIP section. The
overlay reads the newest one per identity, so each record replaces the whole
profile. It is async because the wallet signs inside the record. The older
`profile()` builder is a different record; use this one for a profile the
overlay resolves.

```ts
import { identityProfile, toLockingScript, verifyIdentityProfile } from '@overlay-social/sdk/schema'
import { OVERLAY_TOPICS, submitToOverlay } from '@overlay-social/sdk/submit'

const p = await identityProfile({ displayName: 'Ada', avatar: 'https://example.com/ada.png', bio: 'First programmer.' }, { wallet })
const action = await wallet.createAction({
  description: 'Set profile',
  outputs: [{ lockingScript: toLockingScript(p).toHex(), satoshis: 0, outputDescription: 'identity-profile' }],
})
await submitToOverlay(action, { topics: [OVERLAY_TOPICS.identityProfile] }) // see Sending to the overlay
verifyIdentityProfile(toLockingScript(p)) // { identity, fields, valid: true }
```

## Sanitising chain content (`/sanitize`)

Post text is written by anyone and can never be deleted from the chain, so it
must be cleaned every time it is shown. One profile does that, for the browser
and for server-side rendering:

```ts
import { renderMarkdown, sanitizeHtml } from '@overlay-social/sdk/sanitize'

el.innerHTML = renderMarkdown(post.text) // markdown (GFM) to safe HTML
el.innerHTML = sanitizeHtml(untrustedHtml) // already have HTML
renderMarkdown(post.text, { mentions: (handle) => `/u/${handle}` }) // link @handles
```

Both are built on DOMPurify (and marked for the markdown) and are safe to put
in `innerHTML`. They return strings, and never run or load anything while
cleaning.

**What survives.** Text, headings, lists, quotes, code (with its `language-*`
class), tables, links, images, audio and video. **What does not:** scripts,
SVG and MathML, forms and controls (a task list's disabled checkboxes stay),
`iframe`, `object`, `embed`, `style`, `link`, `meta`, `base`, `template`,
event handlers, inline `style`, `data-*`, `srcdoc`, `action` and `formaction`.
`id` and `name` are prefixed with `user-content-`, and only `language-*` class
tokens are kept, so content cannot borrow an app's own CSS classes or clobber
its globals.

**Links.** Only `http`, `https` and `mailto` URLs and relative URLs are kept:
`javascript:`, `vbscript:`, `tel:`, `ftp:` and the rest are dropped. Every link
gets `rel="noopener noreferrer nofollow ugc"`. `target` never comes from the
content: an absolute `http(s)` link gets `target="_blank"` (pass
`externalLinkTarget: null` for none), everything else has none.

**Media.** Images, audio and video may load from any `http(s)` host. They get
`loading="lazy"` and `referrerpolicy="no-referrer"`, and `autoplay` is removed.
`data:` URLs are kept on media elements only (`img`, `video`, `audio`,
`source`, `track`), where they are inert, and never on links. Frames and
embeds are removed; an app that wants rich cards builds its own and runs
`sanitizeEmbedHtml()` over the result, a second pass that additionally allows
`data-txid`, `data-oembed-url`, `data-og-url`, `data-ord-txid` and
`data-ord-origin`, `peck-embed*` classes and the YouTube no-cookie player
iframe (any other iframe is removed).

**Fail closed.** With no DOM available the functions return the text escaped,
never the markup. `isSanitizerAvailable()` tells you which case you are in.

**Server-side rendering.** DOMPurify needs a DOM. In Node the entry point
creates a [jsdom](https://github.com/jsdom/jsdom) window on first use, so
install `jsdom` (an optional peer dependency, 26 or later) next to the SDK.
Or bring your own window (linkedom, happy-dom, an existing jsdom):

```ts
import { createSanitizer } from '@overlay-social/sdk/sanitize'

const { renderMarkdown } = createSanitizer(window) // any DOM window
```

Bundlers and browsers resolve the `browser` export condition to a build that
uses the page's own DOM and never touches jsdom. For a page without a build
step, `@overlay-social/sdk/sanitize/browser` is one self-contained ES module
(`dist/sanitize.browser.js`, DOMPurify and marked included, about 71 KB, 25 KB
gzipped).

The tests run a corpus of XSS payloads (the classic vectors, mutation-XSS
patterns, markdown-specific forms) through every entry point.
`npm run check:sanitize-browser` runs the same corpus through the single-file
build in a real headless Chrome and checks that nothing executes.

## Wallet (`/wallet`)

`connect()` finds the user's BRC-100 wallet and returns one `WalletInterface`,
whichever way the page reaches it:

| `via` | Door | Detected by |
| --- | --- | --- |
| `peckos` | The page runs in a Peck OS window | `PeckOS.detect()` (a `hello` to the parent frame) |
| `cwi` | A wallet injected into the page (`window.CWI`) | a property check |
| `local` | A desktop wallet serving BRC-100 over HTTP (default `http://localhost:3321`) | `getVersion` with a 1.5 s timeout |
| `passkey` | An opener the app supplies (`options.passkey`) | used when nothing else answered |

```ts
import { connect, WalletRequestError } from '@overlay-social/sdk/wallet'

const wallet = await connect({ originator: 'example.com' })
console.log(wallet.via) // 'peckos' | 'cwi' | 'local' | 'passkey'

try {
  await wallet.createAction({ description: 'Post', outputs })
} catch (e) {
  if (e instanceof WalletRequestError && e.reason === 'insufficient_funds') showTopUp()
  else if (e instanceof WalletRequestError && e.reason === 'cancelled') return
  else throw e
}
```

Detection is prompt-free: nothing asks the wallet for keys or permission until
the app makes its first request. The passkey opener is also called on the first
request, not by `connect()`, so make that request from a click. Some browsers
ask before a page talks to a local-network address; call `connect()` from a
user gesture, or pass `local: false` to skip that door.

**One error shape.** Every error a wallet method throws becomes a
`WalletRequestError` with a `reason`:

- `cancelled`: the user declined or closed a prompt.
- `unavailable`: no wallet is installed, reachable, unlocked or signed in.
- `insufficient_funds`
- `timeout`
- `unknown`

The wallet's message and numeric BRC-100 `code` are kept, the original error is
the `cause`, and a local wallet's HTTP `status` and error fields are attached.
`classifyWalletError()` and `normalizeWalletError()` work on any value. They
read error codes and message text in English and Norwegian, never call
arguments.

## Sending to the overlay (`/submit`)

The wallet signs, pays and broadcasts (`createAction`). `submitToOverlay()` then
hands the same transaction to the overlay, so it is admitted and indexed now
instead of whenever a chain scan reaches it. It goes from the browser straight
to `POST https://overlay.peck.to/submit`: no server, queue or database in
between, and nothing it sends needs a login.

```ts
import { connect } from '@overlay-social/sdk/wallet'
import { post, signPayload } from '@overlay-social/sdk/schema'
import { OVERLAY_TOPICS, OverlaySubmitError, submitToOverlay } from '@overlay-social/sdk/submit'

const wallet = await connect({ originator: 'example.com' })
const record = await signPayload(post({ app: 'example.com', text: 'gm' }), { wallet })
const action = await wallet.createAction({
  description: 'Post',
  outputs: [{ lockingScript: record.toHex(), satoshis: 0, outputDescription: 'Post' }],
})

try {
  const { txid, admittedTopics } = await submitToOverlay(action) // default topic: tm_social-content
  goTo(`/tx/${txid}`)
} catch (e) {
  if (!(e instanceof OverlaySubmitError)) throw e
  if (e.code === 'network' || e.code === 'timeout' || e.code === 'server') offerRetry()
  else showError(e.message)
}
```

It takes what `createAction` returns, the transaction as BEEF (bytes or hex),
or an `@bsv/sdk` `Transaction` whose inputs carry their source transactions. A
raw transaction without its ancestors is refused before anything is sent: the
overlay needs the merkle proofs. If the wallet kept the transaction to itself
(it returned no `tx`), the call throws `no_transaction`; the overlay picks the
transaction up from the chain later.

**Which topic.** The topics say which overlay service indexes the record:

| Record | Topic | Constant |
| --- | --- | --- |
| `post`, `reply`, `quote`, `repost`, `like`, `unlike`, `follow`, `unfollow`, `message`, `payment` (a tip) | `tm_social-content` (the default) | `OVERLAY_TOPICS.content` |
| `identityProfile()` | `tm_identity-profile` | `OVERLAY_TOPICS.identityProfile` |
| an identity handle claim | `tm_identity-handle` | `OVERLAY_TOPICS.identityHandle` |
| a key binding | `tm_key-binding` | `OVERLAY_TOPICS.keyBinding` |
| a friend request or withdrawal | `tm_social-friend` | `OVERLAY_TOPICS.friend` |

`peck-schema` is the old name of the same topic manager as
`tm_social-content` (`OVERLAY_TOPICS.contentLegacy`). One transaction can go to
several topics at once: `topics: [OVERLAY_TOPICS.keyBinding, OVERLAY_TOPICS.identityProfile]`.

**The result** is the overlay's own admittance result:
`{ txid, topics, steak, admitted, admittedTopics }`, where `steak` maps each
topic to the output indexes it admitted. The overlay answers as soon as it has
decided, and indexes right after, so a read of the same record immediately
afterwards can still be empty. Show the new record optimistically.

**Errors.** Every failure is an `OverlaySubmitError` with a `code` and, when
there was an answer, the HTTP `status`:

| `code` | Meaning |
| --- | --- |
| `invalid_input` | Nothing was sent: not BEEF, unusable topics or URL |
| `no_transaction` | Nothing was sent: the wallet result carried no transaction |
| `network` | No answer: offline, DNS, CORS, refused (the `cause` is kept) |
| `timeout` | No answer within `timeoutMs` (default 30000) |
| `unsupported_topic` | The overlay does not run a topic you named |
| `spv_failed` | The overlay could not verify the transaction (merkle proofs, source transactions, scripts). A bad merkle path can be transient right after a block |
| `rejected` | The overlay refused the request (HTTP 4xx) |
| `server` | The overlay or the proxy failed (HTTP 5xx) |
| `invalid_response` | A 2xx answer that is not an admittance result |
| `not_admitted` | The overlay took the transaction but no topic admitted any output (`error.steak` has the result) |

`not_admitted` also covers a transaction the overlay has already admitted: it
answers a repeat submission with an empty result. Pass
`requireAdmission: false` to get that result back instead of an error. Aborting
through `signal` rejects with the signal's own reason, like `fetch`.

Options: `topics`, `overlayUrl` (default `https://overlay.peck.to`), `fetch`,
`timeoutMs`, `signal`, `requireAdmission`.

## Showing an author (`/identity`)

The overlay resolves every author once, into an `AuthorView`, with one
function, so all clients show the same name, handle and picture for a key. This
module has the same rules for clients that display authors, or build them
themselves, without asking the overlay:

```ts
import { avatarSrc, formatHandle, profileRef, shortKey } from '@overlay-social/sdk/identity'

const name = author.displayName            // never empty
const handle = formatHandle(author.handle) // '@ada', or null
const picture = avatarSrc(author)          // the author's own picture, else the generated bird
const link = `/u/${profileRef(author)}`    // handle, else identity key, else key
```

| Function | Rule |
| --- | --- |
| `bakeAuthor(sources, config?)` | The whole `AuthorView` from the records you have (below) |
| `avatarRefToUrl(ref, origin, config?)` | `avatarRef` to an `<img src>` URL, or `null` |
| `generatedAvatarUrl(key, address, config?)` | The generated bird, seeded on the P2PKH address |
| `avatarSrc(author)` | `avatarUrl`, else `generatedAvatarUrl` |
| `formatHandle(handle)` / `normalizeHandle(handle)` | `@ada` / `ada`, from a handle with or without the @ |
| `shortKey(key)` | `1BSMAM…U4gG`: first 6 + `…` + last 4 of anything longer than 12 |
| `keyKind(key)`, `keyToAddress(key)`, `normalizeKey(key)` | Address, public key or neither; the P2PKH address of a public key |
| `profileRef(author)` | What identifies the author in a link or a profile read: handle, then identity key, then key |
| `monogram(name)`, `isExternal(author)`, `isCustodial(author)` | A placeholder letter (the first letter or digit, as peck.to picks it: `$Mikey` gives `M`, no letter gives `·`); provenance flags |

**Name.** The first non-empty of: the author's own on-chain profile
(`identity`), the `display_name` written in the transaction (`tx`), an app
account row (`account`), an off-chain platform profile (`external`, only when
there is no identity and the transaction has no name), the local part of the
account's paymail (`paymail`, unless it is a raw hex key), and finally the
shortened key (`key`). `nameSource` records which one won. Show an `external`
name with a marker saying where it is from.

**Picture.** `avatarRef` maps to a URL like this:

| Reference | URL |
| --- | --- |
| `uhrp://<sha256>` | `<uhrpBase>/uhrp/<sha256>` |
| `b://<txid>` | `<mediaBase>/b/<txid>` (`/xavatar/<txid>`, a downscaling proxy, for an external profile) |
| `ord://<txid>[_<vout>]` | `<mediaBase>/ord/<txid>[_<vout>]` |
| `https://…`, `http://…` | unchanged (peck.to's own generated `/avatar/` URLs count as no picture) |
| `data:image/…` | unchanged, up to 64 KiB |
| anything else | `null`: show `generatedAvatarUrl` (or a monogram) |

The first of identity, account and external whose reference maps to a URL wins
(`avatarSource`). These URLs are for `<img src>`: an SVG loaded that way cannot
run script, but do not use one as a link target or in an `<object>`. The hosts
are `mediaBase` (default `https://peck.to`) and `uhrpBase` (default
`https://peck.bio`); pass the ones your overlay was configured with.

**Custodial keys.** A shared key such as treechat.io's belongs to an app, not to
a person: `bakeAuthor` ignores identity, account and handle for it, and
`custodialRelay` names the app.

`bakeAuthor` needs `@bsv/sdk` to derive the address of a public key, so it is
the one part of this module that is not tiny; the display helpers above pull in
nothing else.

## Direct messages (`/dm`)

End-to-end encrypted direct messages that interoperate with peck.to in both
directions: what this module sends, peck.to reads, and the other way round.

```ts
import { connect } from '@overlay-social/sdk/wallet'
import { createDmClient } from '@overlay-social/sdk/dm'

const wallet = await connect({ originator: 'example.com' })
const dm = createDmClient({ wallet }) // message box: https://msg.peck.to

await dm.send(recipientIdentityKey, 'hello')

for (const m of await dm.list()) show(m.sender, m.text, m.sentAt)
await dm.ack(idsTheUserHasSeen) // deletes them from the box for all devices
```

**Envelopes.** A message is an envelope,
`{"v":1,"from":<key>,"to":<key>,"ciphertext":<base64>,"sentAt":<ms>}`, whose
ciphertext the user's wallet produces with `encrypt` under protocol
`[2, 'peck dm']`, key ID `'1'`, counterparty = the recipient (BRC-2
encryption, BRC-42 key). The recipient decrypts with counterparty = the
sender, and the sender can read its own messages back. The SDK only calls the
wallet; it never sees a key. `buildEnvelope`, `openEnvelope`, `parseEnvelope`,
`encryptText` and `decryptText` work without the client.

**Transport.** The message box stores messages per recipient and box until
they are acknowledged. Requests are mutually authenticated (BRC-103/104,
`AuthFetch` from `@bsv/sdk`). DMs go to the box `dm_inbox`. If a user
advertises another message box host on the overlay (`ls_messagebox`), messages
to them go there, and the user's own list and acknowledge calls cover it too;
pass `lookup: false` to use one host only.

**A permanent copy on-chain.** peck.to writes each DM twice: to the message
box, and on-chain as a Bitcoin Schema message whose B content is the same
envelope. The transaction id becomes the message id, so the two copies are one
message:

```ts
import { envelopeMessage } from '@overlay-social/sdk/dm'
import { signPayload } from '@overlay-social/sdk/schema'

const envelope = await dm.envelope(to, text)
const lockingScript = await signPayload(envelopeMessage(envelope), { wallet })
const { txid } = await wallet.createAction({
  description: 'Encrypted DM',
  outputs: [{ lockingScript: lockingScript.toHex(), satoshis: 0, outputDescription: 'DM' }],
})
await dm.sendEnvelope(envelope, { messageId: txid })
```

`dm.openEnvelope(envelope)` decrypts such a copy later, whether the user sent
or received it.

**Live delivery.** Pass a socket factory to receive messages as they arrive and
to send typing and receipt signals:

```ts
import { AuthSocketClient } from '@bsv/authsocket-client'

const dm = createDmClient({ wallet, socket: AuthSocketClient })
const stop = await dm.listen('dm_inbox', (m) => show(m.sender, m.text))
await dm.sendTyping(peer)                      // box dm_typing
await dm.sendReceipt(peer, 'seen', [messageId]) // box dm_receipt
stop()
```

`@bsv/authsocket-client` is an optional peer dependency: install it when you
want live delivery. Without it, `listen()` rejects with code `no_socket`,
`sendLive()` uses HTTP, and signals are skipped. The client joins its rooms
again after the socket reconnects. `parseSignal()` reads the text of a
typing or receipt envelope.

**Errors.** Every failure is a `DmError` with a `code`: `invalid_argument`,
`invalid_envelope`, `network`, `http`, `server`, `invalid_response`,
`no_socket` or `live_unavailable`. `status` is the HTTP status and
`serverCode` the message box's own code (for example `ERR_DELIVERY_BLOCKED`).

`list()` leaves out rows that are not envelopes or do not decrypt;
`listRows()` returns everything, so an app can acknowledge rows it cannot
read. Payments attached to messages are not accepted into the wallet: DMs carry
none, and nothing in this module moves money.

## Peck OS bridge (`/peckos`)

Apps that run inside a Peck OS window can reach the user's BRC-100 wallet through the
desktop, with no login screen of their own. `detect()` resolves to `null` everywhere else
(including during server-side rendering), so the same code runs in and out of Peck OS.

```ts
import { PeckOS } from '@overlay-social/sdk/peckos'

const os = await PeckOS.detect() // null when not inside Peck OS
if (os !== null) {
  if (!os.connected) await os.connect() // Peck apps are connected already
  const { publicKey } = await os.wallet.getPublicKey({ identityKey: true })
  os.notify('Posted', 'Your post is on chain')
  os.open('https://peck.bio/') // opens in the Peck OS window for that app
}
```

Protocol: BRC-100 cross-document invocations (`{ type: 'CWI' }`) for
wallet calls plus `{ type: 'peckos' }` messages for the desktop. Messages go to an exact
target origin, and a reply is only accepted from the parent window and that origin. Only
`https://os.peck.to` is trusted; for local development a loopback origin can be added from
the app's own storage with `localStorage.setItem('peckos:trust', 'http://127.0.0.1:5173')`
(non-loopback values are ignored).

For pages without a build step, `@overlay-social/sdk/peckos/browser` is the same module as a
single dependency-free ES module (`dist/peckos.browser.js`): copy it next to the page or serve
it from a static host and `import { PeckOS } from './peckos.browser.js'`.

## Development

```bash
npm ci
npm run verify   # lint, typecheck, tests, build, exports check
```

`npm run check:exports` builds nothing itself: it loads the built `dist/` files
and fails if any file declared in the `exports` map is missing or empty.

## License

Open BSV License v5 — usable only on the Bitcoin SV blockchain, by design.
