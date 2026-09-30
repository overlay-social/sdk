/**
 * Key helpers. A "key" is what an author is indexed under: a base58 P2PKH
 * address for most authors, or a compressed public key (66 hex characters) for
 * agent and BRC-100-native authors.
 */
import { PublicKey } from '@bsv/sdk'

export const PUBKEY_RE = /^0[23][0-9a-f]{64}$/
export const ADDRESS_RE = /^1[a-km-zA-HJ-NP-Z1-9]{25,34}$/

export type KeyKind = 'pubkey' | 'address' | 'other'

/** Public keys are matched case-insensitively; addresses are case-sensitive base58. */
export function keyKind(key: string): KeyKind {
  if (typeof key !== 'string') return 'other'
  if (PUBKEY_RE.test(key.toLowerCase())) return 'pubkey'
  if (ADDRESS_RE.test(key)) return 'address'
  return 'other'
}

/** The lookup form of a key: lowercase for public keys, unchanged otherwise. */
export function normalizeKey(key: string): string {
  return keyKind(key) === 'pubkey' ? key.toLowerCase() : key
}

const cache = new Map<string, string | null>()

/**
 * The P2PKH address of a key: the key itself when it is an address, derived
 * when it is a public key, `null` otherwise (including a 66-hex string that is
 * not a point on the curve).
 */
export function keyToAddress(key: string, network: 'main' | 'test' = 'main'): string | null {
  const kind = keyKind(key)
  if (kind === 'address') return key
  if (kind !== 'pubkey') return null
  const pk = key.toLowerCase()
  const memo = `${network}:${pk}`
  const hit = cache.get(memo)
  if (hit !== undefined) return hit
  let address: string | null
  try {
    address = PublicKey.fromString(pk).toAddress(network === 'main' ? 'mainnet' : 'testnet') as string
  } catch {
    address = null
  }
  if (cache.size > 10_000) cache.clear()
  cache.set(memo, address)
  return address
}

/**
 * `1BSMAM…U4gG`: the first 6 and last 4 characters of anything longer than 12.
 * Never render a raw 66-hex key.
 */
export function shortKey(key: string): string {
  return typeof key === 'string' && key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : String(key ?? '')
}
