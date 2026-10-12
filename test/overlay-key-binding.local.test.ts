// keyBinding() against the overlay's REAL admission code, not a port. Skipped
// unless PECK_OVERLAY_SRC points at a peck-overlay-schema checkout's `src`
// directory (with its node_modules installed); that code is not public, so CI
// runs the port in test/helpers/overlay-key-binding.ts instead.
//
//   PECK_OVERLAY_SRC=../peck-overlay-schema/src npx vitest run test/overlay-key-binding.local.test.ts
//
// It loads KeyBindingTopicManager (what `tm_key-binding` admits), the
// KeyBindingLookupService (with a stand-in for knex that records the
// `signing_keys` insert) and the reference issuer `buildBinding`, and checks:
// the SDK's binding is admitted next to a post, the row is the post's signing
// address -> the identity, the reference issuer writes the same bytes, and a
// forged subjectsig is refused.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PrivateKey, ProtoWallet, PublicKey, Utils } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { keyBinding, keyBindingPreimage, post, signPayload, toLockingScript, verifyAip } from '../src/schema/index.js'
import { firstWriteTx } from './helpers/key-binding-tx.js'

const src = process.env.PECK_OVERLAY_SRC ? resolve(process.env.PECK_OVERLAY_SRC) : ''

describe.skipIf(!src)('the real overlay admission code', () => {
  const load = (rel: string) => import(/* @vite-ignore */ resolve(src, rel))
  const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/schema/v1-key-binding.json'), 'utf8')) as {
    bindings: Array<{ walletKey: number; serial: string; scriptHex: string }>
  }

  /** The LookupService with a knex stand-in: returns the row it would insert into signing_keys. */
  async function lookupRow(atomicBEEF: number[], outputIndex: number) {
    const { KeyBindingLookupService } = await load('KeyBindingLookupService.ts')
    const inserted: Array<{ table: string; row: Record<string, unknown> }> = []
    const knex = (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        inserted.push({ table, row })
        return { onConflict: () => ({ merge: async () => undefined }) }
      },
    })
    const svc = new KeyBindingLookupService({ knex })
    await svc.outputAdmittedByTopic({ mode: 'whole-tx', atomicBEEF, outputIndex, topic: 'tm_key-binding' })
    return inserted
  }

  it('admits the SDK binding beside a post and writes signing_address -> identity', async () => {
    const { KeyBindingTopicManager } = await load('KeyBindingTopicManager.ts')
    const wallet = new ProtoWallet(new PrivateKey(20261006))
    const postScript = await signPayload(post({ app: 'peck.to', text: 'first post' }), { wallet })
    const binding = await keyBinding({}, { wallet })
    const tx = firstWriteTx([postScript, toLockingScript(binding)])

    const admitted = await new KeyBindingTopicManager().identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(admitted).toEqual({ outputsToAdmit: [1], coinsToRetain: [] })

    const inserted = await lookupRow(tx.toAtomicBEEF(), 1)
    const signer = verifyAip(postScript)!.signer
    expect(inserted).toHaveLength(1)
    expect(inserted[0]!.table).toBe('signing_keys')
    expect(inserted[0]!.row).toMatchObject({
      signing_pubkey: signer.toLowerCase(),
      signing_address: PublicKey.fromString(signer).toAddress(),
      identity_subject: (await wallet.getPublicKey({ identityKey: true })).publicKey,
      binding_outpoint: `${tx.id('hex')}.1`,
      spent: false,
    })
  })

  it('the reference issuer buildBinding() writes the same bytes as the SDK and v1', async () => {
    const { buildBinding } = await load('keybinding/binding.ts')
    for (const c of fixture.bindings) {
      const wallet = new ProtoWallet(new PrivateKey(c.walletKey))
      const certifier = (await wallet.getPublicKey({ identityKey: true })).publicKey
      const subject = (await wallet.getPublicKey({ protocolID: [1, 'identity'], keyID: '1', counterparty: 'self' })).publicKey
      const ref = await buildBinding({
        subject,
        certifier,
        serial: c.serial,
        revocation: `${'0'.repeat(64)}.0`,
        signCertifier: async (data: number[]) =>
          Utils.toHex((await wallet.createSignature({ data, protocolID: [1, 'keybinding'], keyID: c.serial })).signature),
        signSubject: async (data: number[]) =>
          Utils.toHex((await wallet.createSignature({ data, protocolID: [1, 'identity'], keyID: '1', counterparty: 'self' })).signature),
      })
      const sdk = await keyBinding({ serial: c.serial }, { wallet })
      expect(ref.script).toBe(toLockingScript(sdk).toHex())
      expect(ref.script).toBe(c.scriptHex)
    }
  })

  it('refuses a binding whose subjectsig is by another key', async () => {
    const { KeyBindingTopicManager, isValidBinding } = await load('KeyBindingTopicManager.ts')
    const wallet = new ProtoWallet(new PrivateKey(20261006))
    const other = new ProtoWallet(new PrivateKey(31337))
    const binding = await keyBinding({}, { wallet })
    const forged = { ...binding.fields }
    forged.subjectsig = Utils.toHex(
      (await other.createSignature({ data: keyBindingPreimage(forged), protocolID: [1, 'identity'], keyID: '1', counterparty: 'self' })).signature,
    )
    expect(await isValidBinding(binding.fields)).toBe(true)
    expect(await isValidBinding(forged)).toBe(false)

    const { bindingToScript } = await load('keybinding/binding.ts')
    const tx = firstWriteTx([toLockingScript({ pushes: [] }), toLockingScript(binding)])
    tx.outputs[0]!.lockingScript = (await import('@bsv/sdk')).LockingScript.fromHex(bindingToScript(forged))
    const admitted = await new KeyBindingTopicManager().identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(admitted.outputsToAdmit).toEqual([1])
    expect(await lookupRow(tx.toAtomicBEEF(), 0)).toEqual([])
  })
})
