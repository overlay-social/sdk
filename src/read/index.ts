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
// The contract's `SourceHandle` (camelCase, on `AuthorView`) and the /v1 row's
// `SourceHandle` (snake_case, on `PeckRow`) share a name. The package has
// always exported the /v1 one under it, so it keeps the name; the contract's
// is exported as `PeckViewSourceHandle`.
export type { SourceHandle } from './v1.js'
export type { SourceHandle as PeckViewSourceHandle } from './peck-view/types.js'
