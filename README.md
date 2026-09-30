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

**Paging.** `next` is a structured cursor. Pass it back unchanged as
`cursor`, with the same filters, to get the following page; its keys depend on
the `rank`, so treat it as opaque.

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
| `getFeed(params)` | `GET /v1/feed` (incl. `near`/`bbox` geo) | `FeedResponse` (throws on upstream failure) |
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
| `@overlay-social/sdk/identity` | Render-ready helpers for identity fields such as avatar references and display names | planned |
| `@overlay-social/sdk/sanitize` | One HTML sanitising profile for user-generated content | planned |
| `@overlay-social/sdk/dm` | BRC-42 direct-message envelopes and a message-box client | planned |
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
