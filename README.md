# @overlay-social/sdk

[![npm version](https://img.shields.io/npm/v/@overlay-social/sdk.svg)](https://www.npmjs.com/package/@overlay-social/sdk)
[![CI](https://github.com/overlay-social/sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/overlay-social/sdk/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Open%20BSV-blue.svg)](LICENSE)

Minimal, read-only TypeScript client for **overlay.peck.to** — the canonical
BSV / BRC-100 social overlay behind peck.to, peck.bio, peck.press and friends.

It is a **pure read lens**: identity resolution, profiles, feed, and overlay
state. It does **not** write, mint, pay, or federate — those capabilities do
not exist on the live service, and this SDK only exposes what actually runs.

```bash
npm install @overlay-social/sdk
```

Requires native `fetch` (Node 18+, modern browsers, edge runtimes). On older
Node, pass your own `fetch` via the constructor.

## Quick start

```ts
import { createOverlayClient } from '@overlay-social/sdk'

const overlay = createOverlayClient() // -> https://overlay.peck.to

const feed = await overlay.getFeed({ limit: 20, type: 'post' })
```

## Enriching a feed (the canonical pattern)

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

## API

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

### Avatar field divergence (read this)

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

No writing / minting / wallet / payment-channel / paywall / federation. Reads
go through the `/v1/*` + `/identity` + `/resolve` + `/state` facade, **never**
the BRC-24 `peck-schema` lookup (that `lookup()` is a deliberate no-op), and
**never** WhatsOnChain.

## License

Open BSV License v5 — usable only on the Bitcoin SV blockchain, by design.
