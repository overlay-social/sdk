// submitToOverlay against a mock overlay served over real HTTP (test/helpers/mock-overlay.ts):
// real fetch, a real wallet-style Atomic BEEF built with @bsv/sdk, and an engine-shaped
// `/submit`. The unit tests in submit.test.ts use a mocked fetch; this proves the bytes and
// headers survive a real round trip and that the overlay's own answers map to the typed errors.
import { Transaction } from '@bsv/sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { follow, like, payment, post, toLockingScript } from '../src/schema/index.js'
import { OVERLAY_TOPICS, OverlaySubmitError, submitToOverlay } from '../src/submit/index.js'
import { startMockOverlay, walletLikeTransaction, type MockOverlay } from './helpers/mock-overlay.js'

let overlay: MockOverlay
beforeAll(async () => {
  overlay = await startMockOverlay()
})
afterAll(async () => {
  await overlay.close()
})

const T1 = 'a'.repeat(64)

describe('submitToOverlay against a mock overlay', () => {
  it('admits a post: the overlay receives the exact Atomic BEEF and the topic header', async () => {
    const tx = await walletLikeTransaction(post({ app: 'peck.to', text: 'hello overlay' }), 1)
    const atomic = tx.toAtomicBEEF()
    const before = overlay.received.length

    const r = await submitToOverlay(atomic, { overlayUrl: overlay.url })

    expect(r.txid).toBe(tx.id('hex'))
    expect(r.admitted).toBe(true)
    expect(r.admittedTopics).toEqual([OVERLAY_TOPICS.content])
    expect(r.steak).toEqual({ 'tm_social-content': { outputsToAdmit: [0], coinsToRetain: [] } })

    const got = overlay.received[before]!
    expect(got.method).toBe('POST')
    expect(got.url).toBe('/submit')
    expect(got.headers['content-type']).toBe('application/octet-stream')
    expect(got.headers['x-topics']).toBe('["tm_social-content"]')
    expect([...got.body]).toEqual(atomic)
    // The overlay can rebuild the same transaction from what it received.
    expect(Transaction.fromBEEF([...got.body]).id('hex')).toBe(tx.id('hex'))
  })

  it('takes a Transaction object and a createAction-style result', async () => {
    const tx = await walletLikeTransaction(like({ app: 'peck.to', targetTxid: T1 }), 2)
    const viaObject = await submitToOverlay(tx, { overlayUrl: overlay.url })
    expect(viaObject.txid).toBe(tx.id('hex'))
    expect(viaObject.admitted).toBe(true)

    const tx2 = await walletLikeTransaction(follow({ app: 'peck.to', address: '1' + 'B'.repeat(30) }), 3)
    const viaResult = await submitToOverlay({ txid: tx2.id('hex'), tx: tx2.toAtomicBEEF() }, { overlayUrl: overlay.url })
    expect(viaResult.admitted).toBe(true)
  })

  it('admits a tip record (type payment) on the content topic', async () => {
    const tx = await walletLikeTransaction(payment({ app: 'peck.to', targetTxid: T1, recipient: '02' + 'c'.repeat(64), amount: 500 }), 4)
    const r = await submitToOverlay(tx, { overlayUrl: overlay.url, topics: [OVERLAY_TOPICS.contentLegacy] })
    expect(r.admittedTopics).toEqual(['peck-schema'])
  })

  it('a repeat submission is not_admitted unless requireAdmission is false', async () => {
    const tx = await walletLikeTransaction(post({ app: 'peck.to', text: 'twice' }), 5)
    await submitToOverlay(tx, { overlayUrl: overlay.url })
    const again = await submitToOverlay(tx, { overlayUrl: overlay.url }).catch((e: unknown) => e)
    expect(again).toBeInstanceOf(OverlaySubmitError)
    expect((again as OverlaySubmitError).code).toBe('not_admitted')
    const lenient = await submitToOverlay(tx, { overlayUrl: overlay.url, requireAdmission: false })
    expect(lenient.admitted).toBe(false)
  })

  it('maps the overlay\'s own 400s to typed errors', async () => {
    const tx = await walletLikeTransaction(post({ app: 'peck.to', text: 'errors' }), 6)

    const topic = await submitToOverlay(tx, { overlayUrl: overlay.url, topics: ['tm_bogus'] }).catch((e: unknown) => e)
    expect([(topic as OverlaySubmitError).code, (topic as OverlaySubmitError).status]).toEqual(['unsupported_topic', 400])

    // Not BEEF to the overlay: a raw transaction's bytes dressed with a BEEF marker.
    const garbage = [0x01, 0x00, 0xbe, 0xef, 9, 9, 9, 9]
    const parse = await submitToOverlay(garbage, { overlayUrl: overlay.url }).catch((e: unknown) => e)
    expect([(parse as OverlaySubmitError).code, (parse as OverlaySubmitError).status]).toEqual(['rejected', 400])

    overlay.failNext(502, 'Bad gateway')
    const proxy = await submitToOverlay(tx, { overlayUrl: overlay.url }).catch((e: unknown) => e)
    expect([(proxy as OverlaySubmitError).code, (proxy as OverlaySubmitError).status]).toEqual(['server', 502])
  })

  it('a record no topic manager admits comes back as not_admitted', async () => {
    // A MAP record of a type the social topic does not index.
    const { payload } = await import('../src/schema/index.js')
    const tx = await walletLikeTransaction(payload(['1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5', 'SET', 'app', 'peck.to', 'type', 'not-a-social-type']), 7)
    const e = await submitToOverlay(tx, { overlayUrl: overlay.url }).catch((x: unknown) => x)
    expect((e as OverlaySubmitError).code).toBe('not_admitted')
    expect((e as OverlaySubmitError).steak).toEqual({ 'tm_social-content': { outputsToAdmit: [], coinsToRetain: [] } })
  })

  it('network: nothing listens at the URL', async () => {
    const tx = await walletLikeTransaction(post({ app: 'peck.to', text: 'offline' }), 8)
    const e = await submitToOverlay(tx, { overlayUrl: 'http://127.0.0.1:1' }).catch((x: unknown) => x)
    expect((e as OverlaySubmitError).code).toBe('network')
  })

  it('the helper builds a script the overlay can parse (sanity check on the fixture)', async () => {
    expect(toLockingScript(post({ app: 'peck.to', text: 'x' })).toHex().startsWith('006a')).toBe(true)
  })
})
