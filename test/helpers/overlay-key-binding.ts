// A port of the overlay's key-binding admission, for tests: what the topic
// manager of `tm_key-binding` admits and the row its lookup service writes to
// `signing_keys` (the table author resolution and tip attribution read).
//
// Ported from peck-overlay-schema at 1db3db6 (2026-10-09):
//   src/bio/scriptDecode.ts           parsePushChunks / readMapSection / parseMapFromScript
//   src/keybinding/binding.ts         bindingPreimage / isValidBinding
//   src/KeyBindingTopicManager.ts     identifyAdmissibleOutputs
//   src/KeyBindingLookupService.ts    outputAdmittedByTopic (the inserted row)
//
// Deliberately independent of the SDK's own verifier (`verifyKeyBinding`): it
// parses the script the way the overlay does (its own push walker, `|`
// splitting, last key wins) and checks the identity's signature the way the
// overlay does (an 'anyone' ProtoWallet's verifySignature), so a test that
// passes here is not the SDK agreeing with itself. Keep it in step with the
// overlay; test/overlay-key-binding.local.test.ts runs the real overlay code
// against the same records when a checkout is at hand.
import { ProtoWallet, PublicKey, Signature, Transaction, Utils } from '@bsv/sdk'

const PROTO_MAP = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5'
const PUBKEY_RE = /^0[23][0-9a-fA-F]{64}$/
const PREIMAGE_KEYS = ['app', 'type', 'schema_version', 'subject', 'certifier', 'serial', 'purpose', 'revocation', 'boundAt'] as const

interface Chunk {
  hex: string
  text?: string
}

function pushChunks(scriptHex: string): Chunk[] {
  const out: Chunk[] = []
  let i = 0
  while (i < scriptHex.length) {
    const op = parseInt(scriptHex.substring(i, i + 2), 16)
    i += 2
    if (Number.isNaN(op)) break
    let len = 0
    if (op === 0x00) {
      len = 0
    } else if (op >= 0x01 && op <= 0x4b) {
      len = op
    } else if (op === 0x4c) {
      len = parseInt(scriptHex.substring(i, i + 2), 16)
      i += 2
    } else if (op === 0x4d) {
      len = parseInt(scriptHex.substring(i, i + 4).match(/../g)!.reverse().join(''), 16)
      i += 4
    } else if (op === 0x4e) {
      len = parseInt(scriptHex.substring(i, i + 8).match(/../g)!.reverse().join(''), 16)
      i += 8
    } else {
      continue
    }
    const hex = scriptHex.substring(i, i + len * 2)
    i += len * 2
    const t = Buffer.from(hex, 'hex').toString('utf8')
    out.push({ hex, text: Buffer.from(t, 'utf8').toString('hex') === hex.toLowerCase() ? t : undefined })
  }
  return out
}

/** The MAP SET fields of a script, the overlay's way; null when it has no MAP section. */
export function overlayMapFields(scriptHex: string): Record<string, string> | null {
  const lower = scriptHex.toLowerCase()
  const read = (chunks: Chunk[]): Record<string, string> | null => {
    const sections: Chunk[][] = []
    let cur: Chunk[] = []
    for (const c of chunks) {
      if (c.text === '|' || c.hex === '7c') {
        if (cur.length) sections.push(cur)
        cur = []
      } else cur.push(c)
    }
    if (cur.length) sections.push(cur)
    let fields: Record<string, string> | null = null
    for (const s of sections) {
      if (s[0]?.text === PROTO_MAP && s.length >= 3) {
        fields ??= {}
        if (s[1]?.text === 'SET') {
          for (let j = 2; j < s.length - 1; j += 2) {
            const k = s[j]?.text
            const v = s[j + 1]?.text
            if (k != null && v != null) fields[k] = v
          }
        }
      }
    }
    return fields
  }
  if (lower.startsWith('006a')) {
    const m = read(pushChunks(lower.substring(4)))
    if (m) return m
  }
  return read(pushChunks(lower))
}

/** The overlay's `isValidBinding`. */
export async function overlayIsValidBinding(f: Record<string, string>): Promise<boolean> {
  if (f['type']?.toLowerCase() !== 'keybinding') return false
  if (f['schema_version'] !== '1') return false
  const subject = f['subject'] ?? ''
  const certifier = f['certifier'] ?? ''
  if (!PUBKEY_RE.test(subject) || !PUBKEY_RE.test(certifier)) return false
  if (subject.toLowerCase() === certifier.toLowerCase()) return false
  if (!f['sig'] || !f['subjectsig'] || !f['serial']) return false
  const core: Record<string, string> = {}
  for (const k of PREIMAGE_KEYS) if (f[k] !== undefined) core[k] = f[k]
  const preimage = Utils.toArray(JSON.stringify(core, Object.keys(core).sort()), 'utf8')
  try {
    if (!PublicKey.fromString(subject).verify(preimage, Signature.fromDER(Utils.toArray(f['subjectsig'], 'hex')))) return false
  } catch {
    return false
  }
  try {
    const r = await new ProtoWallet('anyone').verifySignature({
      data: preimage,
      signature: Utils.toArray(f['sig'], 'hex'),
      protocolID: [1, 'keybinding'],
      keyID: f['serial'],
      counterparty: certifier,
    })
    if (!r.valid) return false
  } catch {
    return false
  }
  return true
}

/** The topic manager's `identifyAdmissibleOutputs`: the output indexes `tm_key-binding` admits from a BEEF. */
export async function overlayAdmit(beef: number[]): Promise<number[]> {
  const admitted: number[] = []
  const tx = Transaction.fromBEEF(beef)
  for (let i = 0; i < tx.outputs.length; i++) {
    const scriptHex = tx.outputs[i]!.lockingScript?.toHex() || ''
    if (!scriptHex) continue
    const f = overlayMapFields(scriptHex)
    if (!f || f['type'] !== 'keybinding') continue
    if (await overlayIsValidBinding(f)) admitted.push(i)
  }
  return admitted
}

/** The row the lookup service writes to `signing_keys` for an admitted output. */
export interface SigningKeyRow {
  signing_pubkey: string
  signing_address: string
  identity_subject: string
  binding_outpoint: string
  revocation_outpoint: string | null
  bound_at: number | null
  spent: false
}

/** The lookup service's `outputAdmittedByTopic`: the `signing_keys` row, or null when it writes none. */
export async function overlaySigningKeyRow(atomicBeef: number[], outputIndex: number): Promise<SigningKeyRow | null> {
  const tx = Transaction.fromAtomicBEEF(atomicBeef)
  const out = tx.outputs[outputIndex]
  if (!out) return null
  const f = overlayMapFields(out.lockingScript?.toHex() || '')
  if (!f || f['type'] !== 'keybinding') return null
  if (!(await overlayIsValidBinding(f))) return null
  const signingPubkey = f['subject']!.toLowerCase()
  return {
    signing_pubkey: signingPubkey,
    signing_address: PublicKey.fromString(signingPubkey).toAddress(),
    identity_subject: f['certifier']!.toLowerCase(),
    binding_outpoint: `${tx.id('hex')}.${outputIndex}`,
    revocation_outpoint: f['revocation'] || null,
    bound_at: f['boundAt'] && /^\d+$/.test(f['boundAt']) ? parseInt(f['boundAt'], 10) : null,
    spent: false,
  }
}
