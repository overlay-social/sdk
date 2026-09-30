# Changelog

All notable changes to `@overlay-social/sdk`. The project follows semver;
pre-1.0, minor versions may evolve shapes alongside the live overlay contract.

## Unreleased

### Added
- Subpath export `@overlay-social/sdk/read`: the existing read client on its
  own entry point. The package root re-exports it unchanged, so existing
  imports keep working.
- Tooling: `vitest` test runner, `eslint` (typescript-eslint) lint,
  `npm run verify`, an exports-map check (`npm run check:exports`), and a CI
  workflow running lint, typecheck, tests and build on Node 20 and 22.
- README section describing the planned modules.
- `@overlay-social/sdk/peckos`: typed client for apps that run inside Peck OS
  (`PeckOS.detect()`, wallet access through the desktop, and the `open`,
  `notify`, `setTitle` and `setBadge` calls). Same wire protocol as the
  plain-script client it replaces, with unit tests for the message protocol.
- `@overlay-social/sdk/peckos/browser`: the same module as one self-contained
  ES module (`dist/peckos.browser.js`) for pages without a build step.
- `@overlay-social/sdk/identity`: the rules for showing an author, the same
  ones the overlay applies when it builds an `AuthorView`: `bakeAuthor()`
  (name precedence identity > tx > account > external > paymail > key, picture
  precedence identity > account > external, identity key, custodial relay
  keys), `avatarRefToUrl()` (`uhrp://`, `b://`, `ord://`, `http(s)`,
  `data:image/`), `generatedAvatarUrl()`, `shortKey()`, `formatHandle()`,
  `avatarSrc()`, `profileRef()` and key helpers. Tests replay every author in
  the peck-view/v1 contract examples.
- `createReadClient()` in `@overlay-social/sdk/read` (and the package root):
  a typed client for the overlay's `/v2` read model (peck-view/v1 contract):
  `feed`, `post`, `profile`, `posts` (chunked at 100), `viewerState` (chunked
  at 200) and `search`. Structured `next` cursor, injectable `fetch`,
  per-call `AbortSignal`, and a typed `ReadError` for every failure.
- The peck-view/v1 view types (`PostView`, `AuthorView`, `ThreadView`,
  `ProfileView`, `FeedPage`, `PostBatch`, `ViewerState`, …), generated from a
  vendored copy of the contract schema, with `npm run sync:peck-view` to
  refresh it and `npm run check:peck-view` (in CI) to catch stale types.
- `@overlay-social/sdk/schema`: Bitcoin Schema builders (`post`, `reply`,
  `quote`, `repost`, `like`, `unlike`, `follow`, `unfollow`, `tag`,
  `message`, `profile`) and AIP signing through a BRC-100 wallet
  (`signPayload`, BRC77 over the full preimage) with `verifyAip`. The layouts
  reproduce mainnet transactions written by the peck.to web client byte for
  byte (golden-vector tests).
- `schema`: locations. `geo: { lat, lng, alt?, geohash?, precision? }` on
  `post`, `reply` and `quote` writes MAP `lat`, `lng`, `alt` and `geohash`
  (the keys the indexer reads) as plain decimals: no exponent, at most
  `precision` decimals (default 6), never 0,0. `pin()` is a post with a
  location laid out as peck.world writes it. `encodeGeohash`, `decodeGeohash`
  and `normalizeGeo` are exported. Golden tests replay two geotagged peck.to
  posts and a peck.world pin from mainnet.
- Dependency: `@bsv/sdk` `^2.8.7`. The `schema` module uses it at runtime;
  `wallet` imports only its types.
- `@overlay-social/sdk/wallet`: `connect()` reaches the user's BRC-100 wallet
  through Peck OS, an injected `window.CWI`, a local HTTP wallet
  (`localhost:3321`) or an app-supplied passkey opener, in that order, without
  prompting during detection. It returns a `WalletInterface` with `via`. One
  error normalizer (`WalletRequestError`, `classifyWalletError`,
  `normalizeWalletError`) maps every failure to `cancelled`, `unavailable`,
  `insufficient_funds`, `timeout` or `unknown`.
- `@overlay-social/sdk/sanitize`: `renderMarkdown()` (GFM markdown to safe
  HTML), `sanitizeHtml()` and `sanitizeEmbedHtml()`, one DOMPurify profile for
  chain content: `http`, `https` and `mailto` links only, `rel="noopener
  noreferrer nofollow ugc"`, no `style`, event handlers, frames or SVG, ids
  prefixed against DOM clobbering, images and media lazy and without a
  referrer. It ports the hardened profile of the peck.to web client. Works in
  the browser (page DOM), on a server (jsdom, an optional peer dependency) or
  with any window through `createSanitizer(window)`; fails closed to escaped
  text without a DOM. `sanitize/browser` is a self-contained single-file
  build. Tests run an XSS corpus of over a hundred payloads; `npm run
  check:sanitize-browser` runs it in a real headless Chrome.
- Dependencies: `dompurify` and `marked`; `jsdom` as an optional peer
  dependency.
- Contract tests: every contract example validates against the schema and
  round-trips through the client; a live smoke test runs when
  `PECK_VIEW_LIVE` is set.

### Changed
- Build is configured in `tsup.config.ts` with one entry per subpath.
- The `/v1` client moved to `src/read/v1.ts`; its exports are unchanged.

### Fixed
- `/v1` `getFeed({ bbox })` sent the box longitude first, but `/v1/feed` reads
  it latitude first, so the box selected the wrong area (usually none). The
  parameter is still `[west, south, east, north]`; it is now sent as
  `south,west,north,east`. Callers that worked around this by passing latitude
  first should switch to the documented order.

## 0.3.0 — 2026-07-29

### Added
- `PeckRow.source_handle?: SourceHandle` — a source-scoped alias for
  `author`, present on `app: 'zanaadu'` rows that own an on-chain
  "user number" (`{ namespace: 'zanaadu', value: '@14', number: 14,
  kind: 'user_number', membership_proof: 'none' }`, plus `numbers` when a
  key owns more than one). Additive: comes alongside `author`, never
  replaces it, and is omitted (not `null`) when the author has no number.
  `membership_proof: 'none'` is explicit that the value is read from
  Zanaadu's registry, not verified against their Merkle tree. See
  `peck-overlay-schema/ZANAADU_POSTANCHOR_FORMAT.md` §13.

## 0.2.0 — 2026-06-12

### Added
- `getFriends(subject)` — mutual-consent friendship graph
  (`GET /v1/friends/:subject`): `mutual` / `pendingIn` / `pendingOut`
  (two one-way BRC-3 attestations = an active pair), plus legacy BAP-era rows
  (display-only). Safe-empty on error.
- `getNotifications(address, {limit, offset, mentions})` — likes, replies,
  follows, mentions and friend requests targeting a posting address
  (`GET /v1/notifications/:address`). `[]` on error.
- `getFollows(address)` — follower/following counts + rows
  (`GET /v1/follows/:address`).
- `getBlocks(address, kind?)` — outgoing block/mute list
  (`GET /v1/blocks/:address`; the overlay deliberately does not expose
  who-blocked-me).
- Geo feed queries: `getFeed({ near: {lat, lng}, radiusKm })` (haversine) and
  `getFeed({ bbox: [w, s, e, n] })`.
- Types: `FriendEntry`, `FriendsResponse`, `NotificationItem`,
  `FollowsResponse`, `BlockEntry`; `FeedParams.near/radiusKm/bbox`.

### Changed
- `getTopicRoot(topic)` now uses the real per-topic route
  (`GET /v1/topic/:topic/root`, 30s server cache) and falls back to a
  client-side find over `/state` for older overlays. Note: the per-topic route
  does not carry the anchor — use `getAnchor()`/`verifyRoot()` for that.
- `resolveIdentities` documentation: the live overlay now collapses BOUND
  posting keys/addresses (key-binding layer) into their identity root and
  prefers light self-attested profiles/handles over legacy ProfileTokens.
  Same response shape.

### Notes
- All new graph/notification methods follow the SDK's existing philosophy:
  best-effort reads that return safe empties instead of throwing, so social
  UI never bricks on enrichment.

## 0.1.1 — 2026-06-03

- `listIdentities()` — people discovery (`GET /v1/identities`).
- `getAnchor(topic)` / `verifyRoot(topic)` — on-chain state-root anchors.

## 0.1.0 — 2026-06-02

- Initial release: `resolveIdentities`, `getIdentity`, `resolveHandle`,
  `getProfile`, `getFeed`, `getPost`, `getThread`, `getState`,
  `getTopicRoot`.
