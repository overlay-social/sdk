/**
 * Small display rules for an `AuthorView`, so every client writes a name, a
 * handle and a picture the same way.
 */
import type { AuthorView } from '../read/peck-view/types.js'

/** A handle without the leading `@` (as claimed on chain), or `null` when there is none. */
export function normalizeHandle(handle: string | null | undefined): string | null {
  const h = typeof handle === 'string' ? handle.trim().replace(/^@/, '') : ''
  return h || null
}

/** `@ada`: a handle as it is shown. `null` when there is no handle. Accepts it with or without the @. */
export function formatHandle(handle: string | null | undefined): string | null {
  const h = normalizeHandle(handle)
  return h ? `@${h}` : null
}

/**
 * The picture to show: the author's own when there is one, otherwise the
 * generated bird. Clients that do not draw the bird can use {@link monogram}
 * when `avatarUrl` is null instead.
 */
export function avatarSrc(author: Pick<AuthorView, 'avatarUrl' | 'generatedAvatarUrl'>): string {
  return author.avatarUrl ?? author.generatedAvatarUrl
}

/** What identifies the author in a profile link or a profile read: handle, then identity key, then key. */
export function profileRef(author: Pick<AuthorView, 'handle' | 'identityKey' | 'key'>): string {
  return author.handle ?? author.identityKey ?? author.key
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u

/**
 * The character for a placeholder picture, by the rule peck.to applies: the
 * first letter or digit of the name, in any script, upper-cased. Leading
 * sigils, quotes, punctuation and emoji are skipped, so `$Mikey
 * “priceiswrong”` gives `M`. When the name has no letter or digit the result
 * is a middle dot (`·`), not `?`: a missing picture is not an error.
 */
export function monogram(displayName: string | null | undefined): string {
  for (const ch of String(displayName ?? '')) {
    if (LETTER_OR_DIGIT.test(ch)) return ch.toUpperCase()
  }
  return '·'
}

/**
 * True when the name or the picture came from an off-chain platform profile
 * rather than from the chain: show it with a marker saying where it is from.
 */
export function isExternal(author: Pick<AuthorView, 'external'>): boolean {
  return author.external !== null && author.external !== undefined
}

/** True when the key is a shared custodial key: it names an app (`custodialRelay`), not a person. */
export function isCustodial(author: Pick<AuthorView, 'custodialRelay'>): boolean {
  return author.custodialRelay !== null && author.custodialRelay !== undefined
}
