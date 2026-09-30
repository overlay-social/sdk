/**
 * Where pictures live. An `AuthorView` carries absolute URLs, so every client
 * needs the same two host settings the overlay was configured with.
 */

/** The overlay's account of an author's network and its shared custodial keys. */
export interface IdentityConfig {
  /**
   * Host that serves `/b/`, `/ord/`, `/xavatar/` and `/avatar/` (pictures
   * stored on chain, and the generated avatar). Default `https://peck.to`.
   */
  mediaBase?: string
  /** Host that serves `/uhrp/<sha256>`. Default `https://peck.bio`. */
  uhrpBase?: string
  /** Address network for keys given as public keys. Default `'main'`. */
  network?: 'main' | 'test'
  /**
   * Shared custodial keys, mapped to the app that signs with them. The key
   * names the app, not the person, so no identity, account or handle is looked
   * up for them. Default {@link DEFAULT_CUSTODIAL_RELAYS}.
   */
  custodialRelays?: Readonly<Record<string, string>>
}

export const DEFAULT_MEDIA_BASE = 'https://peck.to'
export const DEFAULT_UHRP_BASE = 'https://peck.bio'

/** Known shared custodial keys. */
export const DEFAULT_CUSTODIAL_RELAYS: Readonly<Record<string, string>> = Object.freeze({
  '14aqJ2hMtENYJVCJaekcrqi12fiZJzoWGK': 'treechat.io',
  '14A3GLQM96fymAvCrgMH4v3kY3WhjC184x': 'treechat.io',
})

/** A config with every default filled in and no trailing slash on a host. */
export interface ResolvedIdentityConfig {
  mediaBase: string
  uhrpBase: string
  network: 'main' | 'test'
  custodialRelays: Readonly<Record<string, string>>
}

const trimSlash = (s: string) => s.replace(/\/+$/, '')

export function resolveConfig(cfg: IdentityConfig = {}): ResolvedIdentityConfig {
  return {
    mediaBase: trimSlash(cfg.mediaBase || DEFAULT_MEDIA_BASE),
    uhrpBase: trimSlash(cfg.uhrpBase || DEFAULT_UHRP_BASE),
    network: cfg.network === 'test' ? 'test' : 'main',
    custodialRelays: cfg.custodialRelays ?? DEFAULT_CUSTODIAL_RELAYS,
  }
}
