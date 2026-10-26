/**
 * Documents (overlay.social spec 09): revision records, heading slugs and
 * quotes or replies that point at one section of one revision.
 *
 * A revision is one ordinary content record (spec 00) whose B section is the
 * complete document and whose MAP `SET` section names it:
 *
 *   B    <document bytes> text/markdown utf-8 [<filename>]
 *   |
 *   MAP  SET app <app> type post kind doc doc <id> rev <n> [prev <txid>]
 *            [title <title>] status <STATUS> sha256 <hex> [source <url>] [note <line>]
 *   |
 *   AIP  BRC77 <signing key> <signature>
 *
 * `documentRevision()` returns the unsigned payload in exactly that order;
 * `signPayload()` adds the AIP section, signing the whole record (the B
 * section, the MAP section and the AIP header, spec 00 §7), never the B body
 * alone. Put the signed script in its own transaction: spec 09 allows one
 * revision per transaction. `verifyDocumentRevision()` and `verifyChain()`
 * (in document-verify.ts) are the reading side.
 */
import { Hash, Utils } from '@bsv/sdk'
import { PIPE, PROTO_B, PROTO_MAP, SchemaError, payload, type Push, type SchemaPayload } from './bitcom.js'
import { quote, reply, type ContentInput } from './builders.js'

/** The MAP `kind` of a document revision. */
export const DOCUMENT_KIND = 'doc'
/** The B media type `documentRevision()` writes. */
export const DOCUMENT_MEDIA_TYPE = 'text/markdown'
/** The B encoding spec 09 requires. */
export const DOCUMENT_ENCODING = 'utf-8'
/** The status values spec 09 §6 defines. Readers show any other uppercase word as given. */
export const DOCUMENT_STATUSES = ['DRAFT', 'PUBLISHED', 'IMPLEMENTED', 'PARTIAL', 'ROADMAP', 'WITHDRAWN'] as const
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number]

/**
 * MAP keys a revision record must not carry (spec 09 §2): a reader following
 * spec 00 §4 would file the revision as a reply, quote or channel post, and a
 * MAP `content` would replace the B text in the read model.
 */
export const DOCUMENT_FORBIDDEN_KEYS = [
  'content', 'context', 'subcontext', 'tx', 'txid', 'ref_txid', 'contextValue',
  'reply', 'reply_tx', 'replyTx', 'tx_id_reply', 'in_reply_to', 'inReplyTo',
  'thread_root_tx', 'channel',
] as const

/** Document id: 1–200 of `a-z 0-9 . _ ~ / -`, no leading or trailing `/`, no `//` (spec 09 §2). */
export const DOCUMENT_ID_RE = /^(?!\/)(?!.*\/\/)(?!.*\/$)[a-z0-9._~/-]{1,200}$/
/** `rev`: a positive decimal integer without leading zeros. */
export const DOCUMENT_REV_RE = /^[1-9][0-9]*$/
/** `status`: a single uppercase word (spec 09 §6). */
export const DOCUMENT_STATUS_RE = /^[A-Z]+$/
const TXID_ANY_RE = /^[0-9a-fA-F]{64}$/

export interface DocumentRevisionInput {
  /** The MAP `app` value: the publishing app, free text. */
  app: string
  /** Document id, e.g. `overlay.social/specs/08`. */
  doc: string
  /** Revision number: 1 for the first revision. */
  rev: number
  /** Txid of the preceding revision. Required when `rev` > 1, and must be absent when `rev` is 1. */
  prev?: string
  /** One line. RECOMMENDED by spec 09. */
  title?: string
  /** A single uppercase word, normally one of {@link DOCUMENT_STATUSES}. */
  status: DocumentStatus | (string & {})
  /**
   * The complete document. A string is encoded as UTF-8; bytes are written
   * as given and must be valid UTF-8. `sha256` is computed from exactly the
   * bytes written: nothing is normalized, trimmed or re-encoded.
   */
  content: string | Uint8Array | readonly number[]
  /** B filename, e.g. `08-state-anchoring.md`. Spec 09 says one SHOULD be given. */
  filename?: string
  /** An `https` URL of the same text at a pinned commit. */
  source?: string
  /** One-line change summary. */
  note?: string
}

// ── validation ──────────────────────────────────────────────────

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

// No value may be the separator "|", and none should be the two characters
// "7c", which the reference overlay's parser also reads as a separator (spec 00 §1).
function value(name: string, v: string): string {
  if (v === PIPE) throw new SchemaError(`${name} cannot be "|"`)
  if (v === '7c') throw new SchemaError(`${name} cannot be "7c": the reference overlay reads that push as a separator`)
  return v
}

function oneLine(name: string, v: unknown, required: boolean): string | undefined {
  if (v === undefined || v === null) {
    if (required) throw new SchemaError(`${name} is required`)
    return undefined
  }
  if (typeof v !== 'string' || v.length === 0) throw new SchemaError(`${name} must be a non-empty string`)
  if (/[\r\n]/.test(v)) throw new SchemaError(`${name} must be a single line`)
  if (LONE_SURROGATE_RE.test(v)) throw new SchemaError(`${name} is not well-formed Unicode`)
  return value(name, v)
}

/** The exact bytes of a document: UTF-8 for a string, as given for bytes (which must be valid UTF-8). */
export function documentBytes(content: string | Uint8Array | readonly number[]): number[] {
  let bytes: number[]
  if (typeof content === 'string') {
    if (LONE_SURROGATE_RE.test(content)) {
      throw new SchemaError('content is not well-formed Unicode (a lone surrogate would be written as U+FFFD)')
    }
    bytes = Array.from(new TextEncoder().encode(content))
  } else if (content instanceof Uint8Array || Array.isArray(content)) {
    bytes = Array.from(content)
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes))
    } catch {
      throw new SchemaError('content bytes are not valid UTF-8')
    }
  } else {
    throw new SchemaError('content must be a string or bytes')
  }
  if (bytes.length === 0) throw new SchemaError('content is empty')
  if (bytes.length === 1 && bytes[0] === 0x7c) throw new SchemaError('content cannot be "|"')
  return bytes
}

/** Lowercase hex SHA-256 of document bytes, as written in MAP `sha256`. */
export function documentSha256(content: string | Uint8Array | readonly number[]): string {
  return Utils.toHex(Hash.sha256(documentBytes(content)))
}

// ── builder ─────────────────────────────────────────────────────

/**
 * The unsigned payload of one document revision (spec 09 §2). Sign it with
 * `signPayload()`, which appends `| AIP BRC77 <key> <signature>` over the
 * whole record, and publish it as the only revision in its transaction.
 *
 * Every invariant of spec 09 §2 is checked here: the document id grammar,
 * `rev` ≥ 1, `prev` present exactly when `rev` > 1, an uppercase `status`,
 * one-line `title` and `note`, an `https` `source`, and none of the reference
 * or channel keys. `rev` is written as the decimal text (the push `01 32`
 * for 2, never OP_2), and every push goes through `writeBin`, which picks the
 * minimal push opcode.
 */
export function documentRevision(input: DocumentRevisionInput): SchemaPayload {
  if (input === null || typeof input !== 'object') throw new SchemaError('input is required')
  // `content` is the input's B body; the builder never writes a MAP `content`.
  // Any other forbidden key passed in is a caller trying to make the revision
  // a reply, quote or channel post.
  for (const key of DOCUMENT_FORBIDDEN_KEYS) {
    if (key !== 'content' && Object.prototype.hasOwnProperty.call(input, key)) {
      throw new SchemaError(`a document revision cannot carry MAP "${key}" (spec 09 §2)`)
    }
  }
  const app = oneLine('app', input.app, true)!
  if (typeof input.doc !== 'string' || !DOCUMENT_ID_RE.test(input.doc)) {
    throw new SchemaError('doc must be 1-200 characters of a-z 0-9 . _ ~ / -, with no leading or trailing "/" and no "//"')
  }
  const doc = value('doc', input.doc)
  if (!Number.isSafeInteger(input.rev) || input.rev < 1) throw new SchemaError('rev must be a whole number, 1 or more')
  const rev = String(input.rev)
  let prev: string | undefined
  if (input.rev === 1) {
    if (input.prev !== undefined) throw new SchemaError('prev must be absent when rev is 1')
  } else {
    if (typeof input.prev !== 'string' || !TXID_ANY_RE.test(input.prev)) {
      throw new SchemaError('prev is required when rev > 1 and must be a 64-character hex txid')
    }
    prev = input.prev.toLowerCase()
  }
  const title = oneLine('title', input.title, false)
  if (typeof input.status !== 'string' || !DOCUMENT_STATUS_RE.test(input.status)) {
    throw new SchemaError('status must be a single uppercase word, e.g. PUBLISHED')
  }
  const status = input.status
  const filename = oneLine('filename', input.filename, false)
  const source = oneLine('source', input.source, false)
  if (source !== undefined) {
    let url: URL
    try {
      url = new URL(source)
    } catch {
      throw new SchemaError('source must be an https URL')
    }
    if (url.protocol !== 'https:' || /\s/.test(source)) throw new SchemaError('source must be an https URL')
  }
  const note = oneLine('note', input.note, false)
  const bytes = documentBytes(input.content)
  const sha256 = Utils.toHex(Hash.sha256(bytes))

  const pushes: Push[] = [
    PROTO_B, bytes, DOCUMENT_MEDIA_TYPE, DOCUMENT_ENCODING, ...(filename ? [filename] : []),
    PIPE,
    PROTO_MAP, 'SET',
    'app', app,
    'type', 'post',
    'kind', DOCUMENT_KIND,
    'doc', doc,
    'rev', rev,
    ...(prev ? ['prev', prev] : []),
    ...(title ? ['title', title] : []),
    'status', status,
    'sha256', sha256,
    ...(source ? ['source', source] : []),
    ...(note ? ['note', note] : []),
  ]
  return payload(pushes)
}

// ── slugs ───────────────────────────────────────────────────────

const ATX_RE = /^(#{1,6}) (.*)$/

/** The heading text of an ATX heading line (spec 09 §8), or null when the line is not one. */
function atxText(line: string): { level: number; text: string } | null {
  const m = ATX_RE.exec(line)
  if (!m) return null
  return { level: m[1]!.length, text: m[2]!.replace(/[#\s]+$/u, '') }
}

/**
 * The slug of one heading (spec 09 §8, steps 1–3). Pass a heading line
 * (`## 2. Anchor transaction (normative)`), whose `#` marker and trailing `#`
 * and whitespace are removed first, or the bare heading text. Repeats are
 * numbered by `documentHeadings()`, not here.
 *
 *   1. lowercase;
 *   2. remove every character that is not a Unicode letter, a Unicode decimal
 *      digit, a space, `-` or `_`;
 *   3. replace each space with `-`.
 */
export function slug(heading: string): string {
  if (typeof heading !== 'string') throw new SchemaError('heading must be a string')
  const text = atxText(heading)?.text ?? heading
  return text.toLowerCase().replace(/[^\p{L}\p{Nd} _-]/gu, '').replace(/ /g, '-')
}

export interface DocumentHeading {
  /** 1–6. */
  level: number
  /** The heading text, as spec 09 §8 extracts it. */
  text: string
  /** The unique slug a `section` names. */
  slug: string
  /** Zero-based line number in the document. */
  line: number
}

const FENCE_RE = /^(`{3,}|~{3,})/

/**
 * Every ATX heading of a markdown document with its unique slug (spec 09
 * §8): lines that start with one to six `#` and a space, outside fenced code
 * blocks. The first heading with a slug keeps it; the nth repeat gets `-n`.
 *
 * A fence opens on a line that starts with three or more backticks or tildes
 * and closes on a line that starts with at least as many of the same
 * character and has nothing else but whitespace.
 */
export function documentHeadings(markdown: string): DocumentHeading[] {
  const out: DocumentHeading[] = []
  const seen = new Map<string, number>()
  let fence: string | null = null
  const lines = markdown.split(/\r\n|\r|\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const f = FENCE_RE.exec(line)
    if (fence !== null) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length && line.slice(f[1]!.length).trim() === '') fence = null
      continue
    }
    if (f) {
      fence = f[1]!
      continue
    }
    const h = atxText(line)
    if (!h) continue
    const base = slug(h.text)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    out.push({ level: h.level, text: h.text, slug: n === 0 ? base : `${base}-${n}`, line: i })
  }
  return out
}

// ── section quotes and replies ──────────────────────────────────

export interface SectionInput extends ContentInput {
  /** Txid of the revision quoted or replied to. Name a revision, not a document id (spec 09 §8). */
  revisionTxid: string
  /** The heading slug, from `slug()` or `documentHeadings()`. Omit to point at the whole revision. */
  section?: string
}

/**
 * Quote a revision or one section of it (spec 09 §8): `type repost`, own
 * text, `tx <revision txid>`, `section <slug>`.
 */
export function quoteSection(input: SectionInput): SchemaPayload {
  const { revisionTxid, section, ...rest } = input
  return quote({ ...rest, targetTxid: revisionTxid, ...(section !== undefined ? { section } : {}) })
}

/**
 * Reply to a revision or one section of it (spec 09 §8): `type post`,
 * `context tx`, `tx <revision txid>`, `reply <revision txid>`, `section <slug>`.
 */
export function replySection(input: SectionInput): SchemaPayload {
  const { revisionTxid, section, ...rest } = input
  return reply({ ...rest, parentTxid: revisionTxid, ...(section !== undefined ? { section } : {}) })
}
