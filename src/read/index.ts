// The `read` module: typed clients for the overlay.
//
//  - `createReadClient()` speaks /v2, the hydrated read model (peck-view/v1
//    contract). Recommended for new code: one call per screen, and every client
//    gets the same author, counts and media for a post.
//  - `createOverlayClient()` speaks the /v1 facade, unchanged, for existing
//    callers and for the endpoints /v2 does not cover yet (identity bundles,
//    friends, notifications, follows, blocks, topic state).
export * from './v1.js'
export * from './v2.js'
export type * from './peck-view/types.js'
