// Golden vectors: OP_RETURN outputs of mainnet transactions written by the
// peck.to web client. The canonical builders must reproduce each one byte for
// byte. The wallet is a fake that returns the on-chain signing key and
// signature, and it checks that it is asked to sign sha256(full preimage)
// with the default derivation (so the signature is the one on chain).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Hash, Utils, type CreateSignatureArgs, type GetPublicKeyArgs } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  PROTO_AIP,
  like,
  opReturnPushes,
  post,
  reply,
  signPayload,
  verifyAip,
  type AipWallet,
  type SchemaPayload,
} from '../src/schema/index.js'

interface Vector {
  txid: string
  vout: number
  note: string
  builder: 'post' | 'reply' | 'like'
  input: Record<string, unknown>
  scriptHex: string
}

const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'fixtures/schema/golden-vectors.json'), 'utf8'),
) as { vectors: Vector[]; legacy: Array<{ txid: string; scriptHex: string }> }

const builders = {
  post: (i: Record<string, unknown>) => post(i as unknown as Parameters<typeof post>[0]),
  reply: (i: Record<string, unknown>) => reply(i as unknown as Parameters<typeof reply>[0]),
  like: (i: Record<string, unknown>) => like(i as unknown as Parameters<typeof like>[0]),
} satisfies Record<Vector['builder'], (i: Record<string, unknown>) => SchemaPayload>

/** The signing key and base64 signature at the end of an on-chain AIP section. */
function onChainAip(scriptHex: string): { key: string; der: number[]; preimage: number[] } {
  const pushes = opReturnPushes(scriptHex)!
  const at = pushes.findIndex((p) => Utils.toUTF8(p) === PROTO_AIP)
  return {
    key: Utils.toUTF8(pushes[at + 2]!),
    der: Utils.toArray(Utils.toUTF8(pushes[at + 3]!), 'base64'),
    preimage: pushes.slice(0, at + 3).flat(),
  }
}

function replayWallet(scriptHex: string): AipWallet {
  const { key, der, preimage } = onChainAip(scriptHex)
  return {
    async getPublicKey(args: GetPublicKeyArgs) {
      expect(args).toMatchObject({ protocolID: [1, 'identity'], keyID: '1', counterparty: 'self' })
      return { publicKey: key }
    },
    async createSignature(args: CreateSignatureArgs) {
      expect(args).toMatchObject({ protocolID: [1, 'identity'], keyID: '1', counterparty: 'self' })
      // The wallet must be asked for exactly the digest that was signed on chain.
      expect(args.hashToDirectlySign).toEqual(Hash.sha256(preimage))
      return { signature: der }
    },
  }
}

describe('golden vectors from the peck.to web client', () => {
  expect(fixture.vectors.length).toBeGreaterThan(0)

  for (const v of fixture.vectors) {
    it(`${v.builder}: ${v.note} (${v.txid.slice(0, 12)}…)`, async () => {
      const script = await signPayload(builders[v.builder](v.input), { wallet: replayWallet(v.scriptHex) })
      expect(script.toHex()).toBe(v.scriptHex)
    })

    it(`${v.txid.slice(0, 12)}… verifies under the full-preimage definition`, () => {
      expect(verifyAip(v.scriptHex)).toMatchObject({ algorithm: 'BRC77', valid: true })
    })
  }

  it('reports an older BITCOIN_ECDSA signature as not verified here', () => {
    for (const v of fixture.legacy) {
      expect(verifyAip(v.scriptHex)).toMatchObject({ algorithm: 'BITCOIN_ECDSA', valid: false })
    }
  })
})
