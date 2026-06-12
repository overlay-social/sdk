# Changelog

All notable changes to `@overlay-social/sdk`. The project follows semver;
pre-1.0, minor versions may evolve shapes alongside the live overlay contract.

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
