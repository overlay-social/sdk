/**
 * `bakeAuthor`: the rules that turn what is known about a key into the
 * `AuthorView` the overlay serves for it. The overlay runs exactly this
 * function for every author in `/v2`, so a client that builds authors itself
 * (from `/v1` identity resolution, its own accounts, a cache) and a client that
 * only displays what the overlay sent show the same name, handle and picture.
 *
 * The inputs are records the caller already has; nothing is fetched here.
 *
 *   name:    identity > tx > account > external > paymail > key
 *            `external` counts only when there is no identity record and the
 *            transaction carries no name. A paymail whose local part is a raw
 *            hex key is a key, not a name, and is skipped. When nothing names
 *            the author the name is the shortened key, and `nameSource` is
 *            `'key'`.
 *   avatar:  identity > account > external, the first reference that maps to
 *            a URL (see `avatarRefToUrl`).
 *   handle:  the identity record's handle (on-chain claims), without the @.
 *   custodial relay keys: the key belongs to an app, so identity, account and
 *            handle are ignored; the name comes from the transaction or the key.
 */
import type { AuthorView } from '../read/peck-view/types.js'
import { avatarRefToUrl, generatedAvatarUrl, type AvatarOrigin } from './avatar.js'
import { resolveConfig, type IdentityConfig } from './config.js'
import { normalizeHandle } from './format.js'
import { PUBKEY_RE, keyKind, keyToAddress, shortKey } from './keys.js'

/**
 * A resolved identity: one entry of the `/v1` identity resolution
 * (`resolveIdentities`), keyed there by the key that was asked about.
 */
export interface IdentityRecord {
  pubkey: string
  address?: string | null
  handle: string | null
  displayName: string | null
  avatarRef: string | null
  bio?: string | null
  profileOutpoint?: string | null
}

/** An account row kept by the app itself (off chain). */
export interface AccountRecord {
  address: string | null
  publicKey: string | null
  identityKey: string | null
  displayName: string | null
  paymail: string | null
  avatarUrl: string | null
  bio: string | null
}

/** An off-chain platform profile (for example twetch), keyed by address. */
export interface ExternalRecord {
  address: string
  source: string
  displayName: string | null
  avatarRef: string | null
  externalId: string | null
}

export interface AuthorSources {
  /** The key the post is indexed under (`pecks.author`). */
  key: string
  /** The `display_name` written in the transaction itself, if any. */
  nameInTx?: string | null
  identity?: IdentityRecord | null
  account?: AccountRecord | null
  external?: ExternalRecord | null
}

const HEX_LOCAL_RE = /^[0-9a-f]{12,66}$/i

const clean = (s: string | null | undefined): string | null => {
  if (typeof s !== 'string') return null
  const t = s.trim()
  return t ? t : null
}

export function bakeAuthor(src: AuthorSources, config?: IdentityConfig): AuthorView {
  const cfg = resolveConfig(config)
  const key = src.key
  const kind = keyKind(key)
  const address = keyToAddress(key, cfg.network)
  const relay = cfg.custodialRelays[key] ?? null

  const identity = relay ? null : src.identity ?? null
  const account = relay ? null : src.account ?? null
  const nameInTx = clean(src.nameInTx)
  // Only rows the chain never named borrow a name from an off-chain profile.
  const external = !identity && !nameInTx ? src.external ?? null : null

  // ── name ──
  let displayName: string | null = null
  let nameSource: AuthorView['nameSource'] = 'key'
  const paymail = clean(account?.paymail)
  const paymailLocal = paymail && paymail.includes('@') ? clean(paymail.split('@')[0]) : null
  const nameCandidates: Array<[string | null, AuthorView['nameSource']]> = [
    [clean(identity?.displayName), 'identity'],
    [nameInTx, 'tx'],
    [clean(account?.displayName), 'account'],
    [clean(external?.displayName), 'external'],
    [paymailLocal && !HEX_LOCAL_RE.test(paymailLocal) ? paymailLocal : null, 'paymail'],
  ]
  for (const [name, source] of nameCandidates) {
    if (name) {
      displayName = name
      nameSource = source
      break
    }
  }
  if (!displayName) {
    displayName = shortKey(key) || 'unknown'
    nameSource = 'key'
  }

  // ── avatar ──
  let avatarUrl: string | null = null
  let avatarRef: string | null = null
  let avatarSource: AvatarOrigin | null = null
  const avatarCandidates: Array<[string | null | undefined, AvatarOrigin]> = [
    [identity?.avatarRef, 'identity'],
    [account?.avatarUrl, 'account'],
    [external?.avatarRef, 'external'],
  ]
  for (const [ref, origin] of avatarCandidates) {
    const url = avatarRefToUrl(ref, origin, cfg)
    if (url) {
      avatarUrl = url
      avatarRef = String(ref).trim()
      avatarSource = origin
      break
    }
  }

  // ── identity key: the resolved identity, then the account, then the key itself ──
  let identityKey: string | null = null
  if (!relay) {
    const resolved = identity?.pubkey?.toLowerCase()
    const onAccount = account?.identityKey?.toLowerCase()
    if (resolved && PUBKEY_RE.test(resolved)) identityKey = resolved
    else if (onAccount && PUBKEY_RE.test(onAccount)) identityKey = onAccount
    else if (kind === 'pubkey') identityKey = key.toLowerCase()
  }

  const usedExternal = nameSource === 'external' || avatarSource === 'external'
  return {
    key,
    address,
    identityKey,
    handle: relay ? null : normalizeHandle(identity?.handle),
    displayName,
    nameSource,
    avatarUrl,
    avatarRef,
    avatarSource,
    generatedAvatarUrl: generatedAvatarUrl(key, address, cfg),
    paymail,
    custodialRelay: relay,
    external: usedExternal && external ? { source: external.source, externalId: clean(external.externalId) } : null,
  }
}
