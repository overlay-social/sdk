/**
 * The reading side of spec 09: check one revision from its own bytes, and
 * compute a document's canonical history from a set of revisions.
 *
 * Both functions are pure and offline. They trust nothing an overlay says:
 * the signature is checked over the canonical preimage (spec 00 §7) of the
 * script itself, and the `sha256` field is recomputed from the B data push.
 */
import { BigNumber, BSM, Hash, LockingScript, OP, PublicKey, Signature, Transaction, Utils } from '@bsv/sdk'
import { PROTO_AIP, PROTO_B, PROTO_MAP } from './bitcom.js'
import {
  DOCUMENT_ENCODING,
  DOCUMENT_FORBIDDEN_KEYS,
  DOCUMENT_ID_RE,
  DOCUMENT_KIND,
  DOCUMENT_REV_RE,
  DOCUMENT_STATUS_RE,
} from './document.js'

const TXID_RE = /^[0-9a-f]{64}$/
const SHA_RE = /^[0-9a-f]{64}$/
const PUBKEY_RE = /^0[23][0-9a-f]{64}$/
const PUBKEY_ANY_RE = /^0[23][0-9a-fA-F]{64}$/

/** The MAP fields of a revision record, as written. */
export interface DocumentRevisionFields {
  app: string
  type: string
  kind: string
  doc: string
  /** The `rev` text parsed as a number. */
  rev: number
  prev?: string
  title?: string
  status: string
  sha256: string
  source?: string
  note?: string
  /** B media type, e.g. `text/markdown`. */
  mediaType: string
  /** B encoding; always `utf-8` on a valid revision. */
  encoding: string
  /** B filename, when given. */
  filename?: string
}

/** What `verifyDocumentRevision()` found. */
export interface DocumentRevisionCheck {
  /** `valid` and `shaOk`: an authentic, intact revision. */
  ok: boolean
  /**
   * A valid revision in the sense of spec 09 §3: the record satisfies §2 and
   * its AIP signature verifies over the whole record. A revision with a
   * `sha256` mismatch is still valid (the author signed it as it is); check
   * `shaOk` for that.
   */
  valid: boolean
  /** The AIP signature verifies over the canonical preimage and is the last data push. */
  sigOk: boolean
  /** MAP `sha256` equals the SHA-256 of the B data push. */
  shaOk: boolean
  /** The AIP algorithm, `BRC77` or `BITCOIN_ECDSA`, or null when there is no AIP section. */
  algorithm: string | null
  /**
   * The signing key, 66 lowercase hex: the BRC77 signer push, or for
   * `BITCOIN_ECDSA` the key recovered from the signature. Null unless
   * `sigOk`. Map it to an author identity through key-bindings (spec 06 §1).
   */
  signer: string | null
  /** The parsed fields, or null when the record could not be read as a revision. */
  fields: DocumentRevisionFields | null
  /** The B data push: the exact document bytes. */
  content: Uint8Array | null
  /** SHA-256 of `content`, lowercase hex. */
  contentSha256: string | null
  /** The transaction id, when a transaction was given. */
  txid?: string
  /** The output that carries the revision, when a transaction was given. */
  outputIndex?: number
  /** Every rule the record breaks, in plain words. Empty on an ok revision. */
  errors: string[]
}

/** A transaction, a locking script, or the hex or bytes of either. */
export type DocumentRevisionSource = Transaction | LockingScript | string | readonly number[] | Uint8Array

// ── script parsing ──────────────────────────────────────────────

interface StrictPushes {
  pushes: number[][]
  errors: string[]
}

/**
 * Every element after OP_FALSE OP_RETURN as a data push. Unlike the lenient
 * reader used for display, nothing is skipped: an OP_0 is an empty push that
 * keeps its place (spec 00 §1), and any other opcode, a non-minimal push or a
 * truncated push is an error. OP_1..OP_16 are opcodes, not data, so a `rev`
 * written as OP_2 is caught here.
 */
function strictPushes(bin: readonly number[]): StrictPushes | null {
  let i = 0
  if (bin[i] === OP.OP_FALSE) i++
  if (bin[i] !== OP.OP_RETURN) return null
  i++
  const pushes: number[][] = []
  const errors: string[] = []
  while (i < bin.length) {
    const op = bin[i++]!
    let len: number
    if (op === OP.OP_0) {
      pushes.push([])
      continue
    } else if (op >= 1 && op < OP.OP_PUSHDATA1) {
      len = op
    } else if (op === OP.OP_PUSHDATA1) {
      len = bin[i] ?? 0
      i += 1
      if (len < OP.OP_PUSHDATA1) errors.push(`push ${pushes.length} uses OP_PUSHDATA1 for ${len} bytes (not minimal)`)
    } else if (op === OP.OP_PUSHDATA2) {
      len = (bin[i] ?? 0) | ((bin[i + 1] ?? 0) << 8)
      i += 2
      if (len <= 0xff) errors.push(`push ${pushes.length} uses OP_PUSHDATA2 for ${len} bytes (not minimal)`)
    } else if (op === OP.OP_PUSHDATA4) {
      len = ((bin[i] ?? 0) | ((bin[i + 1] ?? 0) << 8) | ((bin[i + 2] ?? 0) << 16)) + (bin[i + 3] ?? 0) * 0x1000000
      i += 4
      if (len <= 0xffff) errors.push(`push ${pushes.length} uses OP_PUSHDATA4 for ${len} bytes (not minimal)`)
    } else {
      errors.push(`opcode 0x${op.toString(16).padStart(2, '0')} after push ${pushes.length - 1} is not a data push`)
      continue
    }
    if (i + len > bin.length) {
      errors.push(`push ${pushes.length} is truncated`)
      break
    }
    pushes.push(bin.slice(i, i + len) as number[])
    i += len
  }
  return { pushes, errors }
}

const utf8 = (b: readonly number[] | undefined): string => (b ? Utils.toUTF8([...b]) : '')
const isPipe = (b: readonly number[]): boolean => b.length === 1 && b[0] === 0x7c

/** A loose test, used only to count revision records in a transaction: some MAP SET section with `kind doc`. */
function looksLikeRevision(pushes: readonly (readonly number[])[]): boolean {
  for (let i = 0; i + 1 < pushes.length; i++) {
    if (utf8(pushes[i]) !== PROTO_MAP || utf8(pushes[i + 1]) !== 'SET') continue
    for (let k = i + 2; k + 1 < pushes.length && !isPipe(pushes[k]!); k += 2) {
      if (utf8(pushes[k]) === 'kind' && utf8(pushes[k + 1]).trim().toLowerCase() === DOCUMENT_KIND) return true
    }
  }
  return false
}

function scriptBytes(s: LockingScript | string | readonly number[] | Uint8Array): number[] {
  if (typeof s === 'string') return Utils.toArray(s, 'hex')
  if (s instanceof Uint8Array || Array.isArray(s)) return Array.from(s as ArrayLike<number>)
  return (s as LockingScript).toBinary()
}

function isOpReturn(bin: readonly number[]): boolean {
  return bin[0] === OP.OP_RETURN || (bin[0] === OP.OP_FALSE && bin[1] === OP.OP_RETURN)
}

// ── signatures ──────────────────────────────────────────────────

function verifyBrc77(preimage: number[], signer: string, sigText: string): string | null {
  if (!PUBKEY_RE.test(signer)) return null
  try {
    const der = Utils.toArray(sigText, 'base64')
    return PublicKey.fromString(signer).verify(preimage, Signature.fromDER(der)) ? signer : null
  } catch {
    return null
  }
}

function p2pkhAddress(key: PublicKey, compressed: boolean): string {
  return Utils.toBase58Check(Hash.hash160(key.encode(compressed) as number[]), [0x00])
}

/** BITCOIN_ECDSA (spec 00 §7): recover the key and compare it with the signer push. Returns the key as 66 hex. */
function verifyBitcoinEcdsa(preimage: number[], signer: string, sigText: string): string | null {
  try {
    const compact = Utils.toArray(sigText, 'base64')
    if (compact.length !== 65) return null
    const header = compact[0]!
    if (header < 27 || header > 34) return null
    const recovery = (header - 27) & 3
    const compressed = header >= 31
    const digest = new BigNumber(BSM.magicHash(preimage))
    const sig = Signature.fromCompact(compact)
    const key = sig.RecoverPublicKey(recovery, digest)
    const hex = key.toString().toLowerCase()
    if (!BSM.verify(preimage, sig, key)) return null
    if (PUBKEY_ANY_RE.test(signer)) return signer.toLowerCase() === hex ? hex : null
    return signer === p2pkhAddress(key, compressed) ? hex : null
  } catch {
    return null
  }
}

// ── one revision ────────────────────────────────────────────────

function emptyCheck(errors: string[]): DocumentRevisionCheck {
  return {
    ok: false, valid: false, sigOk: false, shaOk: false, algorithm: null, signer: null,
    fields: null, content: null, contentSha256: null, errors,
  }
}

/** Check one revision record in an OP_RETURN script (spec 09 §2, §3, §5). */
function checkScript(bin: readonly number[]): DocumentRevisionCheck {
  const parsed = strictPushes(bin)
  if (!parsed) return emptyCheck(['not an OP_RETURN output'])
  const errors = [...parsed.errors]
  const pushes = parsed.pushes

  // Split into sections at the separator push.
  const sections: number[][][] = [[]]
  for (const p of pushes) {
    if (isPipe(p)) sections.push([])
    else sections[sections.length - 1]!.push(p)
  }
  const prefix = (s: number[][] | undefined) => utf8(s?.[0])

  // ── AIP: the last section, and its signature the last push ──
  const last = sections[sections.length - 1]!
  let algorithm: string | null = null
  let signer: string | null = null
  let sigOk = false
  const aipAt = sections.findIndex((s) => prefix(s) === PROTO_AIP)
  if (aipAt < 0) {
    errors.push('no AIP section: a revision must be signed')
  } else {
    const aip = sections[aipAt]!
    algorithm = utf8(aip[1])
    if (aipAt !== sections.length - 1) {
      errors.push('data follows the AIP section: the signature must be the last data push')
    } else if (last.length !== 4) {
      errors.push(`the AIP section has ${last.length - 1} values after its prefix; expected algorithm, signer, signature`)
    }
    if (aipAt === sections.length - 1 && last.length === 4) {
      // Preimage: every push from the first through the signer push.
      const preimage = pushes.slice(0, pushes.length - 1).flat()
      const signerPush = utf8(aip[2])
      const sigText = utf8(aip[3])
      if (algorithm === 'BRC77') {
        signer = verifyBrc77(preimage, signerPush, sigText)
      } else if (algorithm === 'BITCOIN_ECDSA') {
        signer = verifyBitcoinEcdsa(preimage, signerPush, sigText)
      } else {
        errors.push(`AIP algorithm "${algorithm}" is not BRC77 or BITCOIN_ECDSA`)
      }
      sigOk = signer !== null
      if (!sigOk && (algorithm === 'BRC77' || algorithm === 'BITCOIN_ECDSA')) {
        errors.push('the AIP signature does not verify over the whole record (a signature over the B content alone is not accepted)')
      }
    }
  }
  if (parsed.errors.length > 0) {
    // A malformed script cannot be trusted to mean what its pushes say.
    sigOk = false
    signer = null
  }

  // ── B ──
  const b = sections[0]!
  let content: Uint8Array | null = null
  let contentSha256: string | null = null
  let mediaType = ''
  let encoding = ''
  let filename: string | undefined
  if (prefix(b) !== PROTO_B) {
    errors.push('the first section is not a B section: a revision carries the complete document in B')
  } else {
    if (b.length < 4 || b.length > 5) errors.push(`the B section has ${b.length - 1} values; expected data, media type, encoding and an optional filename`)
    if (b[1]) {
      content = Uint8Array.from(b[1])
      contentSha256 = Utils.toHex(Hash.sha256(b[1]))
    }
    mediaType = utf8(b[2])
    encoding = utf8(b[3])
    filename = b[4] ? utf8(b[4]) : undefined
    if (encoding !== DOCUMENT_ENCODING) errors.push(`B encoding is "${encoding}"; a revision must be utf-8`)
    if (!b[1] || b[1].length === 0) errors.push('the B data push is empty')
  }

  // ── MAP SET, then optional MAP ADD sections, then AIP ──
  const map = sections[1]
  const end = aipAt < 0 ? sections.length : aipAt
  if (!map || prefix(map) !== PROTO_MAP || utf8(map[1]) !== 'SET') {
    errors.push('the second section is not a MAP SET section')
  }
  for (let s = 2; s < end; s++) {
    if (prefix(sections[s]) !== PROTO_MAP || utf8(sections[s]![1]) !== 'ADD') {
      errors.push(`section ${s} is neither MAP ADD nor AIP; a revision is B | MAP SET [| MAP ADD ...] | AIP`)
    }
  }
  const raw = new Map<string, string>()
  if (map && prefix(map) === PROTO_MAP && utf8(map[1]) === 'SET') {
    const kv = map.slice(2)
    if (kv.length % 2 !== 0) errors.push('the MAP SET section has a key without a value')
    for (let k = 0; k + 1 < kv.length; k += 2) {
      const key = utf8(kv[k])
      if (raw.has(key)) errors.push(`MAP key "${key}" appears more than once`)
      else raw.set(key, utf8(kv[k + 1]))
    }
  }
  for (const key of DOCUMENT_FORBIDDEN_KEYS) {
    if (raw.has(key)) errors.push(`MAP "${key}" is not allowed on a revision (spec 09 §2)`)
  }

  const get = (k: string) => raw.get(k)
  const app = get('app')
  const type = get('type')
  const kind = get('kind')
  const doc = get('doc')
  const revText = get('rev')
  const prev = get('prev')
  const title = get('title')
  const status = get('status')
  const sha256 = get('sha256')
  const source = get('source')
  const note = get('note')

  if (!app) errors.push('MAP app is required')
  if (type !== 'post') errors.push(`MAP type must be "post", found ${JSON.stringify(type ?? null)}`)
  if (kind !== DOCUMENT_KIND) errors.push(`MAP kind must be "doc", found ${JSON.stringify(kind ?? null)}`)
  if (doc === undefined || !DOCUMENT_ID_RE.test(doc)) errors.push(`MAP doc is not a valid document id: ${JSON.stringify(doc ?? null)}`)
  let rev = NaN
  if (revText === undefined || !DOCUMENT_REV_RE.test(revText)) {
    errors.push(`MAP rev must be a positive decimal integer without leading zeros, found ${JSON.stringify(revText ?? null)}`)
  } else {
    rev = Number(revText)
    if (!Number.isSafeInteger(rev)) errors.push('MAP rev is larger than this SDK can compare exactly')
  }
  if (Number.isSafeInteger(rev)) {
    if (rev === 1 && prev !== undefined) errors.push('MAP prev must be absent when rev is 1')
    if (rev > 1 && (prev === undefined || !TXID_RE.test(prev))) errors.push('MAP prev must be a 64-character lowercase hex txid when rev > 1')
  }
  if (title !== undefined && /[\r\n]/.test(title)) errors.push('MAP title must be one line')
  if (status === undefined || !DOCUMENT_STATUS_RE.test(status)) errors.push(`MAP status must be a single uppercase word, found ${JSON.stringify(status ?? null)}`)
  if (sha256 === undefined || !SHA_RE.test(sha256)) errors.push('MAP sha256 must be 64 lowercase hex characters')
  if (source !== undefined) {
    let https = false
    try {
      https = new URL(source).protocol === 'https:' && !/\s/.test(source)
    } catch {
      https = false
    }
    if (!https) errors.push('MAP source must be an https URL')
  }
  if (note !== undefined && /[\r\n]/.test(note)) errors.push('MAP note must be one line')

  // A mismatch is not a validity error (spec 09 §3, §5): it is reported
  // below, after `valid` is settled, and the revision keeps its place.
  const shaOk = contentSha256 !== null && sha256 === contentSha256

  const fields: DocumentRevisionFields | null =
    app !== undefined && type !== undefined && kind !== undefined && doc !== undefined && revText !== undefined &&
    status !== undefined && sha256 !== undefined
      ? {
          app, type, kind, doc, rev, status, sha256, mediaType, encoding,
          ...(prev !== undefined ? { prev } : {}),
          ...(title !== undefined ? { title } : {}),
          ...(source !== undefined ? { source } : {}),
          ...(note !== undefined ? { note } : {}),
          ...(filename !== undefined ? { filename } : {}),
        }
      : null

  const structureOk = errors.length === 0
  const valid = structureOk && sigOk
  if (!shaOk && contentSha256 !== null && sha256 !== undefined) {
    errors.push(`integrity: MAP sha256 ${sha256} does not match the B content (${contentSha256})`)
  }
  return {
    ok: valid && shaOk,
    valid,
    sigOk,
    shaOk,
    algorithm,
    signer: sigOk ? signer : null,
    fields,
    content,
    contentSha256,
    errors,
  }
}

/**
 * Check one document revision from its own bytes (spec 09 §2, §3, §5).
 *
 * Give it the transaction (a `Transaction`, or its raw hex or bytes) or the
 * revision's locking script (a `LockingScript`, or its hex or bytes; a
 * script is recognised by its leading `OP_FALSE OP_RETURN` or `OP_RETURN`).
 * With a transaction, the revision output is found among its outputs, and a
 * transaction with more than one `kind doc` record carries no valid revision.
 *
 * The signature is verified over the canonical preimage of the whole record,
 * under BRC77 or BITCOIN_ECDSA, and must be the last data push; a signature
 * over the B content alone fails. `sha256` is recomputed from the B data push
 * exactly as it appears. A mismatch leaves `valid` true and sets `shaOk` (and
 * so `ok`) false: spec 09 keeps such a revision in the history, marked.
 *
 * Pure and offline: no overlay flag is consulted.
 */
export function verifyDocumentRevision(source: DocumentRevisionSource): DocumentRevisionCheck {
  let tx: Transaction | null = null
  if (source instanceof Transaction) {
    tx = source
  } else if (source instanceof LockingScript) {
    return checkScript(source.toBinary())
  } else {
    let bin: number[]
    try {
      bin = scriptBytes(source)
    } catch {
      return emptyCheck(['input is not hex or bytes'])
    }
    if (isOpReturn(bin)) return checkScript(bin)
    try {
      tx = Transaction.fromBinary(bin)
    } catch {
      return emptyCheck(['input is neither an OP_RETURN script nor a transaction'])
    }
  }
  const txid = tx.id('hex')
  const found: number[] = []
  tx.outputs.forEach((o, i) => {
    const bin = o.lockingScript.toBinary()
    if (!isOpReturn(bin)) return
    const parsed = strictPushes(bin)
    if (parsed && looksLikeRevision(parsed.pushes)) found.push(i)
  })
  if (found.length === 0) return { ...emptyCheck(['the transaction carries no kind doc record']), txid }
  const check = checkScript(tx.outputs[found[0]!]!.lockingScript.toBinary())
  if (found.length > 1) {
    const errors = [`the transaction carries ${found.length} kind doc records (outputs ${found.join(', ')}); spec 09 allows one`, ...check.errors]
    return { ...check, ok: false, valid: false, errors, txid, outputIndex: found[0]! }
  }
  return { ...check, txid, outputIndex: found[0]! }
}

// ── history ─────────────────────────────────────────────────────

/** One revision given to `verifyChain()`. */
export interface ChainEntry {
  /** The revision's txid (64 hex). */
  txid: string
  /** The revision: its transaction or locking script (any form `verifyDocumentRevision` takes), or an earlier check of it. */
  revision: DocumentRevisionSource | DocumentRevisionCheck
  /**
   * Where the transaction is mined: block height and the transaction's
   * position in the block (from its merkle path). Omit while unconfirmed.
   */
  block?: { height: number; index: number }
}

export interface VerifyChainOptions {
  /** The document id, e.g. `overlay.social/specs/08`. */
  doc: string
  /** The author identity (66 hex): the identity root, or the signing key when it is bound to none. */
  author: string
  /**
   * The author identity a signing key belongs to through an active
   * key-binding (spec 06 §1), evaluated as bindings stand now. Return null or
   * undefined for an unbound key. Default: every key is its own identity.
   */
  identityOf?: (signingKey: string) => string | null | undefined
}

/** A revision of the series. */
export interface ChainRevision {
  txid: string
  rev: number
  prev?: string
  status: string
  title?: string
  /** The signing key (66 hex). */
  signer: string
  /** False when MAP sha256 does not match the text: shown, marked, never dropped (spec 09 §5). */
  shaOk: boolean
  /** The block it is mined in, or undefined while unconfirmed. */
  block?: { height: number; index: number }
  check: DocumentRevisionCheck
}

export type OffChainReason = 'losing-genesis' | 'losing-successor' | 'descendant' | 'orphan'

/** A revision of the series outside the canonical history. Spec 09 §4.3: shown, not hidden. */
export interface OffChainRevision extends ChainRevision {
  /**
   * `losing-genesis`: a later revision 1; `losing-successor`: a later
   * successor of a canonical revision; `descendant`: correctly linked, but
   * below an off-chain revision; `orphan`: its `prev` names nothing in the
   * series, or its `rev` is not one more than its predecessor's.
   */
  reason: OffChainReason
}

export type ExcludedReason = 'invalid' | 'other-author' | 'other-doc' | 'txid-mismatch' | 'duplicate'

/** An input that is not part of the series at all. */
export interface ExcludedEntry {
  txid: string
  reason: ExcludedReason
  errors: string[]
  check?: DocumentRevisionCheck
}

export interface ChainResult {
  /** A canonical history exists and every revision on it passes its integrity check. */
  ok: boolean
  /** The canonical history, revision 1 first. */
  history: ChainRevision[]
  /** The current revision, or null when the series has no revision 1. */
  head: ChainRevision | null
  /** The document's current status: the head's. */
  status: string | null
  /** Series revisions outside the canonical history. */
  offChain: OffChainRevision[]
  /** True when `offChain` is not empty: readers SHOULD say so. */
  forked: boolean
  /** True when the history depends on an unconfirmed revision. */
  provisional: boolean
  /** Txids of series revisions whose sha256 does not match their text. */
  integrityFailures: string[]
  /** Inputs that are not in the series: invalid, by another author, for another document. */
  excluded: ExcludedEntry[]
}

function isCheck(r: ChainEntry['revision']): r is DocumentRevisionCheck {
  return typeof r === 'object' && r !== null && !Array.isArray(r) && !(r instanceof Uint8Array) &&
    !(r instanceof Transaction) && !(r instanceof LockingScript) && 'sigOk' in r && 'errors' in r
}

/** Spec 09 §4.2: confirmed first, then lower height, then lower position; unconfirmed by lower txid. */
function earlier(a: ChainRevision, b: ChainRevision): number {
  if (a.block && !b.block) return -1
  if (!a.block && b.block) return 1
  if (a.block && b.block) {
    if (a.block.height !== b.block.height) return a.block.height - b.block.height
    if (a.block.index !== b.block.index) return a.block.index - b.block.index
  }
  return a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0
}

/**
 * The canonical history of one document by one author (spec 09 §4), as a
 * pure function of the revisions given.
 *
 * The series is every valid revision (spec 09 §3) whose `doc` is
 * `options.doc` and whose signing key maps to `options.author`; any other
 * input is listed in `excluded`, whatever its `doc` and `prev` say. The
 * earliest revision 1 is genesis; from each canonical revision the earliest
 * revision with `prev` = its txid and `rev` one higher is the next; the
 * revision with no successor is the head. Everything else in the series is
 * returned in `offChain` with its reason, never dropped.
 *
 * The result is only as complete as the input: gather revisions from the
 * chain as well as from an overlay (spec 09 §11).
 */
export function verifyChain(entries: readonly ChainEntry[], options: VerifyChainOptions): ChainResult {
  const doc = options.doc
  const author = options.author.toLowerCase()
  const identityOf = options.identityOf ?? ((k: string) => k)
  const excluded: ExcludedEntry[] = []
  const series: ChainRevision[] = []
  const seen = new Set<string>()

  for (const entry of entries) {
    const txid = entry.txid.toLowerCase()
    if (seen.has(txid)) {
      excluded.push({ txid, reason: 'duplicate', errors: ['the same txid was given more than once'] })
      continue
    }
    seen.add(txid)
    const check = isCheck(entry.revision) ? entry.revision : verifyDocumentRevision(entry.revision)
    if (check.txid !== undefined && check.txid !== txid) {
      excluded.push({ txid, reason: 'txid-mismatch', errors: [`the transaction's txid is ${check.txid}`], check })
      continue
    }
    if (!check.valid || !check.fields || !check.signer) {
      excluded.push({ txid, reason: 'invalid', errors: check.errors, check })
      continue
    }
    if (check.fields.doc !== doc) {
      excluded.push({ txid, reason: 'other-doc', errors: [`doc is ${check.fields.doc}`], check })
      continue
    }
    const identity = identityOf(check.signer)
    if (typeof identity !== 'string' || identity.toLowerCase() !== author) {
      excluded.push({ txid, reason: 'other-author', errors: [`signed by ${check.signer}, which is not bound to ${author}`], check })
      continue
    }
    series.push({
      txid,
      rev: check.fields.rev,
      ...(check.fields.prev !== undefined ? { prev: check.fields.prev } : {}),
      status: check.fields.status,
      ...(check.fields.title !== undefined ? { title: check.fields.title } : {}),
      signer: check.signer,
      shaOk: check.shaOk,
      ...(entry.block ? { block: { height: entry.block.height, index: entry.block.index } } : {}),
      check,
    })
  }

  const byTxid = new Map(series.map((r) => [r.txid, r]))
  const history: ChainRevision[] = []
  const genesis = series.filter((r) => r.rev === 1).sort(earlier)
  if (genesis.length > 0) {
    let current = genesis[0]!
    history.push(current)
    for (;;) {
      const cur = current
      const next = series.filter((r) => r.prev === cur.txid && r.rev === cur.rev + 1).sort(earlier)
      if (next.length === 0) break
      current = next[0]!
      history.push(current)
    }
  }
  const canonical = new Set(history.map((r) => r.txid))
  const offChain: OffChainRevision[] = []
  for (const r of [...series].sort(earlier)) {
    if (canonical.has(r.txid)) continue
    let reason: OffChainReason
    const pred = r.prev !== undefined ? byTxid.get(r.prev) : undefined
    if (r.rev === 1) reason = 'losing-genesis'
    else if (pred && r.rev === pred.rev + 1) reason = canonical.has(pred.txid) ? 'losing-successor' : 'descendant'
    else reason = 'orphan'
    offChain.push({ ...r, reason })
  }
  const head = history[history.length - 1] ?? null
  return {
    ok: history.length > 0 && history.every((r) => r.shaOk),
    history,
    head,
    status: head?.status ?? null,
    offChain,
    forked: offChain.length > 0,
    provisional: history.some((r) => !r.block),
    integrityFailures: series.filter((r) => !r.shaOk).map((r) => r.txid),
    excluded,
  }
}
