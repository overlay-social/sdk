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
- `/v2` client: `reactions(txid, { kind?, limit?, cursor? })` lists who liked
  or reposted a post (`ReactionPage`), `stats()` returns the site totals
  (`SiteStats`, estimates) and `apps()` the posts per app (`AppList`).
- `/v2` client: `messages(query)` reads chat history (`MessagePage`): a
  channel (`channel`), the global chat (`scope: 'global'`), an inbox
  (`recipient`) or an outbox (`author` alone), newest first with an exact
  `next` cursor, or oldest first with `order: 'asc'` to ask what arrived
  since. A query that names nothing is rejected before a request is made.
  `authors(query)` lists "Across Bitcoin" (`AuthorList`): the authors other
  apps' posts came from, ranked by post count, optionally for one `app`, or
  with `by: 'name'` the people behind a shared custodial key. New exports:
  `MessagesQuery`, `AuthorsQuery`, `messagesSearchParams`,
  `authorsSearchParams`; the view types `MessagePage`, `MessageView`,
  `AuthorList` and `AuthorListItem`.
- `/v2` client: `notifications(query)` reads `GET /v2/notifications`
  (`NotificationPage`): what other people did that concerns one person
  (`viewer`: an address or a public key), newest first, with an exact `next`
  cursor and an optional `kinds` filter: `reply`, `mention`, `like`, `repost`,
  `tip`, `follow`, `friend_request`, `friend_accepted`. A query without a
  viewer is rejected before a request is made. New exports:
  `NotificationsQuery`, `NotificationKind`, `notificationsSearchParams`; the
  view types `NotificationPage`, `NotificationView` and `NotificationPost`.
  The vendored contract also carries the overlay's clarified
  `PostView.channel` and `PostCounts.tipSats` descriptions.
- `/v2` client: location filters on `feed()`. `hasGeo` keeps posts with a
  location, `bbox: { minLat, minLng, maxLat, maxLng }` a rectangle (latitude
  first; `minLng` greater than `maxLng` crosses the antimeridian) and
  `near: { lat, lng, radiusKm }` a circle. They combine with every other
  filter, every rank and paging. New exports: `GeoBox`, `GeoNear`,
  `ReactionKind`, `ReactionsQuery`, `AppsQuery`, `reactionsSearchParams`,
  `appsSearchParams`.

- `@overlay-social/sdk/dm`: end-to-end encrypted direct messages,
  compatible with peck.to in both directions. Envelopes
  (`{v, from, to, ciphertext, sentAt, ...extra}`, BRC-2 encryption by the
  wallet under `[2, 'peck dm']`, key ID `'1'`): `buildEnvelope`,
  `openEnvelope`, `parseEnvelope`, `encryptText`, `decryptText`,
  `envelopePeer`, and `envelopeMessage` for the on-chain copy (the Bitcoin
  Schema layout peck.to writes). `createDmClient()` speaks the message box
  API (`/sendMessage`, `/listMessages`, `/acknowledgeMessage`) over
  BRC-103/104 `AuthFetch`: `send`, `sendEnvelope` (message id = txid),
  `sendRaw`, `list`, `listRows`, `openRow`, `ack`, overlay discovery of
  advertised hosts (`ls_messagebox`), and live delivery through an injected
  `AuthSocketClient` (`listen`, `sendLive`, `sendTyping`, `sendReceipt`,
  `parseSignal`). Reads both the current single-layer format and the older
  one wrapped in the message box's own encryption layer. Tests replay
  envelopes, requests and rows recorded from peck.to's deployed DM client.
- `@bsv/authsocket-client` as an optional peer dependency (live DM delivery)
  and a dev dependency (type check of the socket factory).
- `/v2` client: `channels({ limit })` (`GET /v2/channels`, `ChannelList`:
  channels by recent posts and chat rooms by latest message),
  `identities({ limit })` (`GET /v2/identities`, `IdentityList`) and
  `lenses({ issuer, scope, limit })` (`GET /v2/lenses`, `LensList`). New
  exports: `ChannelsQuery`, `IdentitiesQuery`, `LensesQuery`,
  `channelsSearchParams`, `identitiesSearchParams`, `lensesSearchParams`.
- `schema`: tips and identity profiles.
  - `payment({ app, targetTxid, recipient, amount })`: the social record of
    a tip, `MAP SET app type payment tx paymail value`, laid out as the
    peck.to v1 client writes it. `brc29Output(wallet, { recipientIdentityKey,
    satoshis })` builds the matching standard BRC-29 payment output to the
    author's identity key (not v1's plain payment to the post's signing
    address), with the remittance the recipient's wallet needs. Neither sets a
    fee rate: the user's wallet chooses it.
  - `identityProfile({ displayName?, avatar?, bio? }, { wallet })`: a
    peck-identity-v1 profile, a port of v1's `setIdentityProfile`. The
    identity key signs the record itself (BRC-3, protocol `[1, 'profile']`,
    random serial as key ID); the overlay admits it into `tm_identity-profile`.
    `verifyIdentityProfile(script)` checks one. This is not the older
    `profile()` builder (an AIP-signed `type profile` record).
  - Tests replay `fixtures/schema/v1-parity.json`, which holds the scripts
    v1's own code produces (`scripts/gen-v1-parity-fixtures.mjs` regenerates
    it); the builders match them byte for byte, signatures included.
- `schema`: friend records. `friend({ peer }, { wallet })` and
  `unfriend({ peer }, { wallet })` write the `tm_social-friend` record the
  peck.to v1 client writes, byte for byte: `MAP SET app type friend|unfriend
  schema_version identity peer serial sig`, signed by the identity key itself
  (BRC-3, protocol `[1, 'friend']`, random serial as key ID). Mutual friendship
  is the two directions together; `unfriend` withdraws the sender's side.
  `verifyFriend(script)` checks a record the way the overlay does, and
  `friendPreimage()` is the signed text. The read is the existing
  `getFriends()`. Tests replay v1's own `Friends.emit` output
  (`fixtures/schema/v1-parity.json`, regenerated by
  `scripts/gen-v1-parity-fixtures.mjs`).
- `@overlay-social/sdk/submit`: `submitToOverlay()` sends a signed transaction
  from the browser to the overlay's `POST /submit` (BEEF body, topics in the
  `x-topics` header) and returns the overlay's admittance result
  (`{ txid, topics, steak, admitted, admittedTopics }`). It takes a
  `createAction` result, BEEF as bytes or hex, or a `Transaction`; the default
  topic is `tm_social-content` and `OVERLAY_TOPICS` names the others
  (`identityProfile`, `identityHandle`, `keyBinding`, `friend`). Every failure
  is an `OverlaySubmitError` with a `code` (`invalid_input`, `no_transaction`,
  `network`, `timeout`, `unsupported_topic`, `spv_failed`, `rejected`,
  `server`, `invalid_response`, `not_admitted`). No server, queue or
  database in between. Tests run against a mocked fetch and against a mock
  overlay over real HTTP.
- `wallet`: `connect({ local })` also takes an ordered list of base URLs
  (`['http://localhost:3321', 'http://localhost:2121']`), probed one after the
  other; the first that answers `getVersion` is used. A string, or no `local`,
  behaves exactly as before.
- `@overlay-social/sdk/sanitize/escape`: `escapeHtml()`, `LINK_REL` and
  `URI_OK` alone, as a self-contained ES module (`dist/escape.browser.js`,
  under 0.5 KB) for pages that only escape text and should not ship the 73 KB
  `sanitize/browser` bundle. The functions are the ones `sanitize` already
  exports; a size test keeps DOMPurify and marked out of it.
- `identity`: `safeAvatarUrl(url)` checks an already resolved picture URL
  before it is rendered: `http(s)` addresses (normalised, as peck.to v2 does)
  and inline `data:image/` pictures up to 64 KiB pass; `javascript:`, other
  `data:` types and everything else give `null`.

### Changed
- `identity`: `monogram()` follows peck.to's rule: the first letter or digit
  of the name (any script), upper-cased without locale rules, so leading
  sigils, quotes and emoji are skipped (`$Mikey` gives `M`). A name without a
  letter or digit gives `·` instead of `?`.
- Build is configured in `tsup.config.ts` with one entry per subpath.
- The `/v1` client moved to `src/read/v1.ts`; its exports are unchanged.
- The vendored peck-view/v1 contract is re-synced. New in the types: `Geo`
  (with `category`) on `PostView.geo`, `ProfileCounts.posts`,
  `ProfileView.certificates` (`IdentityCertificate`), `PostView.source`
  (`PostSource`, `ContentCommitment`, `SourceVote`), `AuthorView.sourceHandle`,
  `AppList`, `ReactionPage`, `Reaction` and `SiteStats`. The contract's
  `SourceHandle` is exported as `PeckViewSourceHandle`, because `SourceHandle`
  stays the `/v1` row's alias type, as before.
- The vendored peck-view/v1 contract is re-synced again. New in the types:
  `ChannelList`, `PostingChannel`, `ChatRoom`, `ChannelName`, `IdentityList`,
  `LensList`, `Lens` and `LensRule`.
- `sync:peck-view` no longer declares a numbered copy of a type (such as
  `AuthorView1`) when the contract describes a field that references a shared
  type; the field keeps the referenced type. The vendored schema is unchanged.

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
  Zanaadu's registry, not verified against their Merkle tree. The number is
  derived from Zanaadu's registry transactions (a registration advances a
  counter; entries can change owner through their marketplace).

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
