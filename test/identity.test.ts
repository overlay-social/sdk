import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CUSTODIAL_RELAYS,
  MAX_DATA_URI,
  avatarRefToUrl,
  avatarSrc,
  bakeAuthor,
  formatHandle,
  generatedAvatarUrl,
  isCustodial,
  isExternal,
  keyKind,
  keyToAddress,
  monogram,
  normalizeHandle,
  normalizeKey,
  profileRef,
  resolveConfig,
  shortKey,
  type AccountRecord,
  type AuthorSources,
  type AuthorView,
  type ExternalRecord,
  type IdentityConfig,
  type IdentityRecord,
} from '../src/identity/index.js'
import { PECK_VIEW_FIXTURES } from './helpers/peck-view-validator.js'

const HASH = 'ab'.repeat(32)
const HASH2 = 'CD'.repeat(32)
const PUBKEY = '027eaf2356970f90253bbd7b1b44df5cacd07a753e817b52034c939dce92829ad0'
const PUBKEY_ADDRESS = '1Zf91MnjiTV6gjBzobtNJ3RjQrP9QiLn4'
const ADDRESS = '1FC9jmEWP67k2A1rYG9A1pLB4L5EibuhA1'
const RELAY = '14aqJ2hMtENYJVCJaekcrqi12fiZJzoWGK'

// The hosts the contract examples were written with.
const CFG: IdentityConfig = { mediaBase: 'https://peck.to', uhrpBase: 'https://peck.bio' }

describe('config', () => {
  it('fills in defaults and trims trailing slashes', () => {
    expect(resolveConfig()).toMatchObject({ mediaBase: 'https://peck.to', uhrpBase: 'https://peck.bio', network: 'main' })
    expect(resolveConfig({ mediaBase: 'https://m.example//', uhrpBase: 'https://u.example/', network: 'test' })).toMatchObject({
      mediaBase: 'https://m.example',
      uhrpBase: 'https://u.example',
      network: 'test',
    })
    expect(resolveConfig({ mediaBase: '' }).mediaBase).toBe('https://peck.to')
  })
})

describe('keys', () => {
  it('classifies keys', () => {
    expect(keyKind(PUBKEY)).toBe('pubkey')
    expect(keyKind(PUBKEY.toUpperCase())).toBe('pubkey')
    expect(keyKind(ADDRESS)).toBe('address')
    expect(keyKind('hello')).toBe('other')
    expect(keyKind('')).toBe('other')
    expect(keyKind(`04${'a'.repeat(64)}`)).toBe('other')
    expect(keyKind(5 as unknown as string)).toBe('other')
  })

  it('lowercases public keys only', () => {
    expect(normalizeKey(PUBKEY.toUpperCase())).toBe(PUBKEY)
    expect(normalizeKey(ADDRESS)).toBe(ADDRESS)
  })

  it('derives the address of a public key', () => {
    expect(keyToAddress(PUBKEY)).toBe(PUBKEY_ADDRESS)
    expect(keyToAddress(PUBKEY.toUpperCase())).toBe(PUBKEY_ADDRESS)
    expect(keyToAddress(PUBKEY, 'test')).toMatch(/^[mn]/)
    expect(keyToAddress(ADDRESS)).toBe(ADDRESS)
    expect(keyToAddress('hello')).toBeNull()
  })

  it('gives null for 66 hex characters that are not a point', () => {
    expect(keyToAddress(`02${'0'.repeat(64)}`)).toBeNull()
  })

  it('shortens long keys to first 6 + … + last 4', () => {
    expect(shortKey(PUBKEY)).toBe('027eaf…9ad0')
    expect(shortKey(ADDRESS)).toBe('1FC9jm…uhA1')
    expect(shortKey('1BSMAMzzzzzzzzzzzzzzzzzzzzzzzzU4gG')).toBe('1BSMAM…U4gG')
    expect(shortKey('abcdefghijkl')).toBe('abcdefghijkl') // 12 characters: as is
    expect(shortKey('abcdefghijklm')).toBe('abcdef…jklm')
    expect(shortKey('')).toBe('')
  })
})

describe('avatarRefToUrl', () => {
  const url = (ref: unknown, origin: 'identity' | 'account' | 'external' = 'identity') =>
    avatarRefToUrl(ref as string, origin, CFG)

  it('maps uhrp:// to the UHRP host, lowercased', () => {
    expect(url(`uhrp://${HASH}`)).toBe(`https://peck.bio/uhrp/${HASH}`)
    expect(url(`UHRP://${HASH2}`)).toBe(`https://peck.bio/uhrp/${HASH2.toLowerCase()}`)
    expect(url(`uhrp://${HASH}`, 'account')).toBe(`https://peck.bio/uhrp/${HASH}`)
    expect(url('uhrp://abc')).toBeNull()
  })

  it('maps b:// to the media host, and to the downscaling proxy for external profiles', () => {
    expect(url(`b://${HASH}`)).toBe(`https://peck.to/b/${HASH}`)
    expect(url(`  b:// ${HASH2} `)).toBe(`https://peck.to/b/${HASH2.toLowerCase()}`)
    expect(url(`b://${HASH}`, 'account')).toBe(`https://peck.to/b/${HASH}`)
    expect(url(`b://${HASH}`, 'external')).toBe(`https://peck.to/xavatar/${HASH}`)
    expect(url('b://short')).toBeNull()
  })

  it('maps ord:// with or without an output index', () => {
    expect(url(`ord://${HASH}`)).toBe(`https://peck.to/ord/${HASH}`)
    expect(url(`ord://${HASH}_3`)).toBe(`https://peck.to/ord/${HASH}_3`)
    expect(url(`ord://${HASH}_`)).toBeNull()
  })

  it('an external profile only yields b:// pictures', () => {
    for (const ref of [`uhrp://${HASH}`, `ord://${HASH}`, 'https://example.com/a.png', 'data:image/png;base64,AAAA']) {
      expect(url(ref, 'external'), ref).toBeNull()
    }
  })

  it('passes http and https URLs through', () => {
    expect(url('https://example.com/a.png')).toBe('https://example.com/a.png')
    expect(url('http://example.com/a.png')).toBe('http://example.com/a.png')
    expect(url('  https://example.com/a.png  ')).toBe('https://example.com/a.png')
    expect(url('https://exa mple.com/a.png')).toBeNull()
    expect(url('https://')).toBeNull()
  })

  it("counts peck.to's own generated avatar URLs as no picture", () => {
    for (const u of [
      'https://peck.to/avatar/thomas',
      'https://www.peck.to/avatar/x?seed=y',
      'https://dev.peck.to/avatar/x',
      'http://localhost:5001/avatar/x',
      'http://127.0.0.1/avatar/x',
    ]) {
      expect(url(u), u).toBeNull()
    }
    expect(url('https://peck.to/b/' + HASH)).toBe('https://peck.to/b/' + HASH)
    expect(url('https://evilpeck.to/avatar/x')).toBe('https://evilpeck.to/avatar/x')
  })

  it('passes data:image/ URIs through, up to 64 KiB', () => {
    const small = 'data:image/svg+xml;base64,PHN2Zy8+'
    expect(url(small)).toBe(small)
    expect(url('data:image/png,abc')).toBe('data:image/png,abc')
    const big = 'data:image/png;base64,' + 'A'.repeat(MAX_DATA_URI)
    expect(url(big)).toBeNull()
    const edge = 'data:image/png;base64,' + 'A'.repeat(MAX_DATA_URI - 'data:image/png;base64,'.length)
    expect(edge).toHaveLength(MAX_DATA_URI)
    expect(url(edge)).toBe(edge)
  })

  it('maps everything else to null', () => {
    for (const ref of [
      HASH, // a bare hash is ambiguous
      `ipfs://${HASH}`, 'javascript:alert(1)', 'data:text/html,<script>', 'data:application/json,{}',
      'file:///etc/passwd', 'ftp://example.com/a.png', '//example.com/a.png', '', '   ', 'null', 'undefined',
    ]) {
      expect(url(ref), ref).toBeNull()
    }
    for (const ref of [null, undefined, 5, {}, []]) expect(url(ref)).toBeNull()
  })

  it('uses the default hosts when none are given', () => {
    expect(avatarRefToUrl(`uhrp://${HASH}`, 'identity')).toBe(`https://peck.bio/uhrp/${HASH}`)
    expect(avatarRefToUrl(`b://${HASH}`, 'identity')).toBe(`https://peck.to/b/${HASH}`)
    expect(avatarRefToUrl(`b://${HASH}`, 'identity', { mediaBase: 'https://media.example/' })).toBe(`https://media.example/b/${HASH}`)
  })
})

describe('generatedAvatarUrl', () => {
  it('is seeded on the address', () => {
    expect(generatedAvatarUrl(PUBKEY, PUBKEY_ADDRESS, CFG)).toBe(`https://peck.to/avatar/${PUBKEY}?seed=${PUBKEY_ADDRESS}`)
    expect(generatedAvatarUrl(ADDRESS, ADDRESS, CFG)).toBe(`https://peck.to/avatar/${ADDRESS}?seed=${ADDRESS}`)
  })

  it('falls back to the key as the seed, and encodes both', () => {
    expect(generatedAvatarUrl('a b&c', null, CFG)).toBe('https://peck.to/avatar/a%20b%26c?seed=a%20b%26c')
    expect(generatedAvatarUrl('k', undefined, { mediaBase: 'https://m.example/' })).toBe('https://m.example/avatar/k?seed=k')
  })
})

describe('bakeAuthor: name', () => {
  const identity: IdentityRecord = { pubkey: PUBKEY, handle: '@ada', displayName: 'Ada', avatarRef: `uhrp://${HASH}`, profileOutpoint: null }
  const account: AccountRecord = {
    address: ADDRESS, publicKey: null, identityKey: null, displayName: 'Account Ada',
    paymail: 'ada.lovelace@paymail.example', avatarUrl: `b://${HASH}`, bio: null,
  }
  const external: ExternalRecord = { address: ADDRESS, source: 'twetch', displayName: 'Twetch Ada', avatarRef: `b://${HASH2}`, externalId: '42' }
  const all: AuthorSources = { key: ADDRESS, nameInTx: 'Tx Ada', identity, account, external }
  const bake = (s: AuthorSources) => bakeAuthor(s, CFG)

  it('takes identity, then tx, then account, then external, then paymail, then the key', () => {
    let s: AuthorSources = { ...all }
    expect([bake(s).displayName, bake(s).nameSource]).toEqual(['Ada', 'identity'])
    s = { ...s, identity: { ...identity, displayName: null } }
    expect([bake(s).displayName, bake(s).nameSource]).toEqual(['Tx Ada', 'tx'])
    s = { ...s, nameInTx: '  ' }
    expect([bake(s).displayName, bake(s).nameSource]).toEqual(['Account Ada', 'account'])
    s = { ...s, account: { ...account, displayName: null } }
    // external is ignored while an identity record exists, even one without a name
    expect([bake(s).displayName, bake(s).nameSource]).toEqual(['ada.lovelace', 'paymail'])
    s = { ...s, identity: null }
    expect([bake(s).displayName, bake(s).nameSource]).toEqual(['Twetch Ada', 'external'])
    s = { ...s, external: { ...external, displayName: null } }
    expect([bake(s).displayName, bake(s).nameSource]).toEqual(['ada.lovelace', 'paymail'])
    s = { ...s, account: null }
    expect([bake(s).displayName, bake(s).nameSource]).toEqual(['1FC9jm…uhA1', 'key'])
  })

  it('uses an external name only when the chain named nobody', () => {
    const s = { key: ADDRESS, external }
    expect(bake(s)).toMatchObject({ displayName: 'Twetch Ada', nameSource: 'external', external: { source: 'twetch', externalId: '42' } })
    expect(bake({ ...s, nameInTx: 'Tx' })).toMatchObject({ displayName: 'Tx', nameSource: 'tx', external: null })
    expect(bake({ ...s, identity })).toMatchObject({ displayName: 'Ada', external: null })
  })

  it('does not take a raw hex key as a paymail name', () => {
    const a = { ...account, displayName: null, paymail: `${PUBKEY}@paymail.example` }
    expect(bake({ key: ADDRESS, account: a })).toMatchObject({ nameSource: 'key', paymail: `${PUBKEY}@paymail.example` })
    expect(bake({ key: ADDRESS, account: { ...a, paymail: 'nobody' } })).toMatchObject({ nameSource: 'key' })
  })

  it('trims names and skips blank ones', () => {
    expect(bake({ key: ADDRESS, nameInTx: '  Padded  ' }).displayName).toBe('Padded')
    expect(bake({ key: ADDRESS, nameInTx: '   ', identity: { ...identity, displayName: '\n' } }).nameSource).toBe('key')
  })

  it('never returns an empty name', () => {
    expect(bake({ key: '' }).displayName).toBe('unknown')
    expect(bake({ key: 'short' }).displayName).toBe('short')
  })
})

describe('bakeAuthor: picture, handle, keys', () => {
  const identity: IdentityRecord = { pubkey: PUBKEY, handle: 'ada', displayName: 'Ada', avatarRef: `uhrp://${HASH}`, profileOutpoint: null }
  const account = { address: ADDRESS, publicKey: null, identityKey: null, displayName: null, paymail: null, avatarUrl: `b://${HASH}`, bio: null }
  const external: ExternalRecord = { address: ADDRESS, source: 'twetch', displayName: null, avatarRef: `b://${HASH2}`, externalId: null }
  const bake = (s: AuthorSources) => bakeAuthor(s, CFG)

  it('takes the first reference that maps to a URL: identity, account, external', () => {
    expect(bake({ key: ADDRESS, identity, account, external })).toMatchObject({
      avatarUrl: `https://peck.bio/uhrp/${HASH}`, avatarRef: `uhrp://${HASH}`, avatarSource: 'identity',
    })
    expect(bake({ key: ADDRESS, identity: { ...identity, avatarRef: 'nonsense' }, account, external })).toMatchObject({
      avatarUrl: `https://peck.to/b/${HASH}`, avatarSource: 'account',
    })
    expect(bake({ key: ADDRESS, account: { ...account, avatarUrl: 'https://peck.to/avatar/x' }, external })).toMatchObject({
      avatarUrl: `https://peck.to/xavatar/${HASH2.toLowerCase()}`, avatarSource: 'external',
      external: { source: 'twetch', externalId: null },
    })
  })

  it('has no picture when nothing maps, and the generated bird is always there', () => {
    const a = bake({ key: ADDRESS })
    expect(a).toMatchObject({ avatarUrl: null, avatarRef: null, avatarSource: null })
    expect(a.generatedAvatarUrl).toBe(`https://peck.to/avatar/${ADDRESS}?seed=${ADDRESS}`)
    expect(avatarSrc(a)).toBe(a.generatedAvatarUrl)
    const b = bake({ key: ADDRESS, identity })
    expect(avatarSrc(b)).toBe(`https://peck.bio/uhrp/${HASH}`)
  })

  it('keeps the reference as published, trimmed', () => {
    expect(bake({ key: ADDRESS, identity: { ...identity, avatarRef: `  uhrp://${HASH}  ` } }).avatarRef).toBe(`uhrp://${HASH}`)
  })

  it('writes the handle without the @', () => {
    expect(bake({ key: ADDRESS, identity: { ...identity, handle: '@ada' } }).handle).toBe('ada')
    expect(bake({ key: ADDRESS, identity: { ...identity, handle: '  ' } }).handle).toBeNull()
    expect(bake({ key: ADDRESS }).handle).toBeNull()
  })

  it('takes the identity key from the identity, then the account, then the key itself', () => {
    const other = '02ed41e68a8f0b36811aa61c6857bb1765fb0993172ff6ea5ee94e01fb0644a3d1'
    expect(bake({ key: ADDRESS, identity: { ...identity, pubkey: other.toUpperCase() }, account: { ...account, identityKey: PUBKEY } }).identityKey).toBe(other)
    expect(bake({ key: ADDRESS, account: { ...account, identityKey: PUBKEY.toUpperCase() } }).identityKey).toBe(PUBKEY)
    expect(bake({ key: ADDRESS, account: { ...account, identityKey: 'garbage' } }).identityKey).toBeNull()
    expect(bake({ key: PUBKEY.toUpperCase() }).identityKey).toBe(PUBKEY)
    expect(bake({ key: ADDRESS }).identityKey).toBeNull()
  })

  it('derives the address of a public key, and seeds the bird on it', () => {
    const a = bake({ key: PUBKEY })
    expect(a.address).toBe(PUBKEY_ADDRESS)
    expect(a.generatedAvatarUrl).toBe(`https://peck.to/avatar/${PUBKEY}?seed=${PUBKEY_ADDRESS}`)
    expect(bake({ key: 'hello' }).address).toBeNull()
  })

  it('treats a custodial relay key as an app: no identity, account or handle', () => {
    const a = bake({ key: RELAY, nameInTx: 'marcus', identity, account: { ...account, displayName: 'Nope', paymail: 'x@y.example' }, external })
    expect(a).toMatchObject({
      key: RELAY, displayName: 'marcus', nameSource: 'tx', handle: null, identityKey: null,
      custodialRelay: 'treechat.io', paymail: null, avatarUrl: null, avatarSource: null, external: null,
    })
    // Only tx, external and key are considered, so with no name in the transaction the external profile counts.
    expect(bake({ key: RELAY, identity, account, external: { ...external, displayName: 'Ext' } })).toMatchObject({
      displayName: 'Ext', nameSource: 'external', handle: null, identityKey: null, avatarSource: 'external',
    })
    expect(bake({ key: RELAY }).nameSource).toBe('key')
    expect(DEFAULT_CUSTODIAL_RELAYS[RELAY]).toBe('treechat.io')
    expect(bakeAuthor({ key: ADDRESS, nameInTx: 'x' }, { ...CFG, custodialRelays: { [ADDRESS]: 'someapp' } }).custodialRelay).toBe('someapp')
  })

  it('reports the external profile only when it was used', () => {
    expect(bake({ key: ADDRESS, nameInTx: 'x', external }).external).toBeNull()
    expect(bake({ key: ADDRESS, external: { ...external, displayName: 'Ext' } }).external).toEqual({ source: 'twetch', externalId: null })
  })

  it('does not change its input', () => {
    const s: AuthorSources = Object.freeze({ key: ADDRESS, identity: Object.freeze({ ...identity }), external: Object.freeze({ ...external }) })
    expect(() => bake(s)).not.toThrow()
  })
})

describe('display helpers', () => {
  it('formats handles', () => {
    expect(formatHandle('ada')).toBe('@ada')
    expect(formatHandle('@ada')).toBe('@ada')
    expect(formatHandle('  @ada ')).toBe('@ada')
    expect(formatHandle('@')).toBeNull()
    expect(formatHandle('')).toBeNull()
    expect(formatHandle(null)).toBeNull()
    expect(formatHandle(undefined)).toBeNull()
    expect(normalizeHandle('@@ada')).toBe('@ada') // one leading @, as claimed
  })

  it('names the profile by handle, then identity key, then key', () => {
    expect(profileRef({ handle: 'ada', identityKey: PUBKEY, key: ADDRESS })).toBe('ada')
    expect(profileRef({ handle: null, identityKey: PUBKEY, key: ADDRESS })).toBe(PUBKEY)
    expect(profileRef({ handle: null, identityKey: null, key: ADDRESS })).toBe(ADDRESS)
  })

  it('makes a monogram', () => {
    expect(monogram('ada')).toBe('A')
    expect(monogram('  élan')).toBe('É')
    expect(monogram('1FC9jm…uhA1')).toBe('1')
    expect(monogram('👍🏽 fan')).toBe('👍🏽')
    expect(monogram('')).toBe('?')
    expect(monogram('   ')).toBe('?')
    expect(monogram(null)).toBe('?')
  })

  it('flags external and custodial authors', () => {
    expect(isExternal({ external: { source: 'twetch', externalId: null } })).toBe(true)
    expect(isExternal({ external: null })).toBe(false)
    expect(isCustodial({ custodialRelay: 'treechat.io' })).toBe(true)
    expect(isCustodial({ custodialRelay: null })).toBe(false)
  })
})

// ── the contract examples ─────────────────────────────────────────

/** Every AuthorView in the vendored peck-view/v1 contract examples. */
function contractAuthors(): Array<{ where: string; author: AuthorView }> {
  const out: Array<{ where: string; author: AuthorView }> = []
  const walk = (x: unknown, where: string): void => {
    if (Array.isArray(x)) x.forEach((v, i) => walk(v, `${where}[${i}]`))
    else if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>
      if ('nameSource' in o && 'generatedAvatarUrl' in o) out.push({ where, author: o as unknown as AuthorView })
      for (const [k, v] of Object.entries(o)) walk(v, `${where}.${k}`)
    }
  }
  for (const f of readdirSync(PECK_VIEW_FIXTURES).filter((n) => n.endsWith('.json')).sort()) {
    walk(JSON.parse(readFileSync(join(PECK_VIEW_FIXTURES, f), 'utf8')), f)
  }
  return out
}

/** The records that produce `a`: what the overlay would have had to know. */
function sourcesFor(a: AuthorView): AuthorSources {
  const s: AuthorSources = { key: a.key }
  if (a.nameSource === 'tx') s.nameInTx = a.displayName
  if (a.handle || a.nameSource === 'identity' || a.avatarSource === 'identity') {
    s.identity = {
      pubkey: a.identityKey ?? a.key,
      handle: a.handle,
      displayName: a.nameSource === 'identity' ? a.displayName : null,
      avatarRef: a.avatarSource === 'identity' ? a.avatarRef : null,
    }
  }
  if (a.nameSource === 'account' || a.avatarSource === 'account' || a.paymail) {
    s.account = {
      address: a.address, publicKey: null, identityKey: null,
      displayName: a.nameSource === 'account' ? a.displayName : null,
      paymail: a.paymail, avatarUrl: a.avatarSource === 'account' ? a.avatarRef : null, bio: null,
    }
  }
  if (a.external) {
    s.external = {
      address: a.address ?? a.key, source: a.external.source, externalId: a.external.externalId,
      displayName: a.nameSource === 'external' ? a.displayName : null,
      avatarRef: a.avatarSource === 'external' ? a.avatarRef : null,
    }
  }
  return s
}

describe('peck-view/v1 contract examples', () => {
  const authors = contractAuthors()

  it('finds authors of every kind', () => {
    expect(authors.length).toBeGreaterThanOrEqual(10)
    const kinds = new Set(authors.map((a) => a.author.nameSource))
    expect([...kinds].sort()).toEqual(['external', 'identity', 'key', 'tx'])
  })

  for (const { where, author } of authors) {
    it(`${where} (${author.nameSource}): every rule reproduces the example`, () => {
      expect(generatedAvatarUrl(author.key, author.address, CFG)).toBe(author.generatedAvatarUrl)
      expect(keyToAddress(author.key)).toBe(author.address)
      if (author.nameSource === 'key') expect(shortKey(author.key)).toBe(author.displayName)
      if (author.avatarRef) expect(avatarRefToUrl(author.avatarRef, author.avatarSource!, CFG)).toBe(author.avatarUrl)
      expect(avatarSrc(author)).toBe(author.avatarUrl ?? author.generatedAvatarUrl)
      expect(isCustodial(author)).toBe(author.custodialRelay !== null)
      expect(isExternal(author)).toBe(author.external !== null)
      // The whole view, from the records that would have produced it.
      expect(bakeAuthor(sourcesFor(author), CFG)).toEqual(author)
    })
  }
})
