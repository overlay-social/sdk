/**
 * Bitcom primitives: protocol prefixes, the payload type the builders return,
 * and the OP_FALSE OP_RETURN script encoding.
 */
import { LockingScript, OP, Utils } from '@bsv/sdk'

// Protocol prefixes, copied from the indexer and overlay parsers (never
// retyped: one wrong character and every reader drops the output silently).
/** B protocol: the content section (data, media type, encoding, filename). */
export const PROTO_B = '19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut'
/** MAP protocol: key/value metadata (`SET`) and lists (`ADD`). */
export const PROTO_MAP = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5'
/** AIP: the author identity signature section. */
export const PROTO_AIP = '15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva'
/** Section separator. Always a one-byte data push (`01 7c`), never the bare byte 0x7c (that is OP_SWAP). */
export const PIPE = '|'

/** One data push: a string (UTF-8 encoded) or raw bytes. */
export type Push = string | readonly number[] | Uint8Array

export class SchemaError extends Error {
  override readonly name = 'SchemaError'
}

/**
 * The data pushes of an OP_RETURN output, in order, without the leading
 * OP_FALSE OP_RETURN. Separators are the one-byte push `[0x7c]`. Builders
 * return a payload; `signPayload()` appends the AIP section and produces the
 * locking script.
 */
export interface SchemaPayload {
  readonly pushes: readonly (readonly number[])[]
}

const PIPE_BYTES: readonly number[] = [0x7c]

export function toBytes(push: Push): number[] {
  if (typeof push === 'string') return push === PIPE ? [...PIPE_BYTES] : Utils.toArray(push, 'utf8')
  return Array.from(push)
}

/** Build a payload from pushes. Empty pushes are rejected: readers skip OP_0 and misalign every field after it. */
export function payload(pushes: readonly Push[]): SchemaPayload {
  const out = pushes.map((p, i) => {
    const bytes = toBytes(p)
    if (bytes.length === 0) throw new SchemaError(`push ${i} is empty`)
    return bytes
  })
  return { pushes: out }
}

/**
 * The OP_FALSE OP_RETURN locking script for a payload, without an AIP
 * signature. Prefer `signPayload()`; an unsigned output has no author.
 */
export function toLockingScript(p: SchemaPayload): LockingScript {
  const s = new LockingScript()
  s.writeOpCode(OP.OP_FALSE)
  s.writeOpCode(OP.OP_RETURN)
  // writeBin picks the minimal push: a length byte below 76, then
  // OP_PUSHDATA1/2/4. A one-byte push stays `01 xx` (never OP_1..OP_16).
  for (const bytes of p.pushes) s.writeBin([...bytes])
  return s
}

/**
 * The data pushes of an OP_FALSE OP_RETURN (or bare OP_RETURN) script, in
 * order. Opcodes that push no data are skipped, as the indexers do. Returns
 * null when the script is not an OP_RETURN output.
 */
export function opReturnPushes(script: LockingScript | string | readonly number[]): number[][] | null {
  const bin = typeof script === 'string'
    ? Utils.toArray(script, 'hex')
    : Array.isArray(script) ? [...script] : (script as LockingScript).toBinary()
  let i = 0
  if (bin[i] === OP.OP_FALSE) i++
  if (bin[i] !== OP.OP_RETURN) return null
  i++
  const out: number[][] = []
  while (i < bin.length) {
    const op = bin[i++] as number
    let len: number
    if (op >= 1 && op < OP.OP_PUSHDATA1) {
      len = op
    } else if (op === OP.OP_PUSHDATA1) {
      len = bin[i] ?? 0
      i += 1
    } else if (op === OP.OP_PUSHDATA2) {
      len = (bin[i] ?? 0) | ((bin[i + 1] ?? 0) << 8)
      i += 2
    } else if (op === OP.OP_PUSHDATA4) {
      len = ((bin[i] ?? 0) | ((bin[i + 1] ?? 0) << 8) | ((bin[i + 2] ?? 0) << 16)) + (bin[i + 3] ?? 0) * 0x1000000
      i += 4
    } else {
      continue
    }
    if (i + len > bin.length) break
    out.push(bin.slice(i, i + len))
    i += len
  }
  return out
}
