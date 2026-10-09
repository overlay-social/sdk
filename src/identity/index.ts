// The `identity` module: the rules for showing an author.
//
//   import { avatarSrc, formatHandle, bakeAuthor } from '@overlay-social/sdk/identity'
//
//   const name = author.displayName            // never empty
//   const handle = formatHandle(author.handle) // '@ada' or null
//   const src = avatarSrc(author)              // own picture, else the generated bird
//
// The overlay resolves every author once (an `AuthorView`) with the rules
// implemented here, so a client that displays what the overlay sent needs only
// the small helpers, and a client that builds authors itself gets the same
// answer from `bakeAuthor()`.
export {
  DEFAULT_CUSTODIAL_RELAYS,
  DEFAULT_MEDIA_BASE,
  DEFAULT_UHRP_BASE,
  resolveConfig,
  type IdentityConfig,
  type ResolvedIdentityConfig,
} from './config.js'
export { ADDRESS_RE, PUBKEY_RE, keyKind, keyToAddress, normalizeKey, shortKey, type KeyKind } from './keys.js'
export { MAX_DATA_URI, avatarRefToUrl, generatedAvatarUrl, safeAvatarUrl, type AvatarOrigin } from './avatar.js'
export {
  bakeAuthor,
  type AccountRecord,
  type AuthorSources,
  type ExternalRecord,
  type IdentityRecord,
} from './author.js'
export { avatarSrc, formatHandle, isCustodial, isExternal, monogram, normalizeHandle, profileRef } from './format.js'
export type { AuthorView } from '../read/peck-view/types.js'
