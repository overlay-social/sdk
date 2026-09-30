import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PeckOSDefault, {
  PeckOS,
  PeckOSSession,
  PECKOS_TRUSTED_ORIGINS,
  WALLET_METHODS,
  createPeckOS,
  type PeckOSInfo,
  type PeckOSWalletError,
} from '../src/peckos/index.js'
import { FakeWindow } from './helpers/fake-window.js'

const OS = 'https://os.peck.to'
const INFO: PeckOSInfo = {
  os: 'Peck OS',
  protocol: 1,
  app: 'social',
  connected: true,
  identityKey: '02abc',
  name: 'alice',
  network: 'main',
  accent: '#f80',
}

function clientFor(win: FakeWindow) {
  return createPeckOS({ getWindow: () => win })
}

/** Answer the app's latest `hello` the way Peck OS does. */
function answerHello(win: FakeWindow, info: PeckOSInfo = INFO, origin = OS) {
  const { id } = win.last.message
  win.fromParent(origin, { type: 'peckos', isReply: true, id, result: info })
}

/** Detect inside a framed window and answer the hello. */
async function detectSession(win = new FakeWindow()) {
  const os = clientFor(win)
  const p = os.detect()
  answerHello(win)
  const session = await p
  if (session === null) throw new Error('expected a session')
  win.posted.length = 0
  return { win, session }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('detect', () => {
  it('resolves null without posting when the page is not framed', async () => {
    const win = new FakeWindow({ framed: false })
    expect(await clientFor(win).detect()).toBeNull()
    expect(win.posted).toHaveLength(0)
    expect(win.listeners.size).toBe(0)
  })

  it('resolves null when there is no window (server-side rendering)', async () => {
    expect(await createPeckOS({ getWindow: () => undefined }).detect()).toBeNull()
  })

  it('is safe to import and call where no window exists', async () => {
    expect(typeof window).toBe('undefined')
    expect(await PeckOS.detect()).toBeNull()
    expect(PeckOSDefault).toBe(PeckOS)
  })

  it('sends a peckos hello to the exact trusted origin', async () => {
    const win = new FakeWindow()
    const p = clientFor(win).detect()
    expect(win.posted).toHaveLength(1)
    const { message, targetOrigin } = win.last
    expect(targetOrigin).toBe(OS)
    expect(message).toEqual({ type: 'peckos', id: expect.any(String), call: 'hello', args: {} })
    // 12 random bytes, base64: 16 characters
    expect(String(message.id)).toMatch(/^[A-Za-z0-9+/]{16}$/)
    answerHello(win)
    const session = await p
    expect(session).toBeInstanceOf(PeckOSSession)
    expect(session?.origin).toBe(OS)
    expect(session?.connected).toBe(true)
    expect(session?.identityKey).toBe('02abc')
    expect(session?.name).toBe('alice')
  })

  it('reports a not-yet-connected session', async () => {
    const win = new FakeWindow()
    const p = clientFor(win).detect()
    answerHello(win, { os: 'Peck OS', protocol: 1, connected: false })
    const session = await p
    expect(session?.connected).toBe(false)
    expect(session?.identityKey).toBeUndefined()
    expect(session?.name).toBeUndefined()
  })

  it('removes its listener once it has an answer', async () => {
    const win = new FakeWindow()
    const p = clientFor(win).detect()
    expect(win.listeners.size).toBe(1)
    answerHello(win)
    await p
    expect(win.listeners.size).toBe(0)
  })

  it('resolves null after the timeout (1200 ms by default) when nobody answers', async () => {
    const win = new FakeWindow()
    const p = clientFor(win).detect()
    await vi.advanceTimersByTimeAsync(1199)
    expect(win.listeners.size).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await p).toBeNull()
    expect(win.listeners.size).toBe(0)
  })

  it('honours a custom timeout', async () => {
    const win = new FakeWindow()
    const p = clientFor(win).detect({ timeout: 50 })
    await vi.advanceTimersByTimeAsync(50)
    expect(await p).toBeNull()
  })

  it('returns the same promise on later calls and ignores their options', async () => {
    const win = new FakeWindow()
    const os = clientFor(win)
    const first = os.detect()
    const second = os.detect({ trusted: ['http://localhost:9'], timeout: 1 })
    expect(second).toBe(first)
    expect(win.posted).toHaveLength(1)
    answerHello(win)
    await first
  })

  it('caches a negative result for the lifetime of the page', async () => {
    const win = new FakeWindow()
    const os = clientFor(win)
    const first = os.detect({ timeout: 10 })
    await vi.advanceTimersByTimeAsync(10)
    expect(await first).toBeNull()
    expect(await os.detect()).toBeNull()
    expect(win.posted).toHaveLength(1)
  })

  it('does not throw when the browser refuses the target origin', async () => {
    const win = new FakeWindow()
    win.throwFor.add(OS)
    expect(await clientFor(win).detect()).toBeNull()
    expect(win.listeners.size).toBe(0)
  })
})

describe('detect: what it refuses to trust', () => {
  async function assertIgnored(mutate: (id: unknown) => { source?: unknown; origin: string; data: unknown }) {
    const win = new FakeWindow()
    const p = clientFor(win).detect()
    const id = win.last.message.id
    win.dispatch(mutate(id))
    // still waiting: the bad reply did not resolve or clean up anything
    expect(win.listeners.size).toBe(1)
    await vi.advanceTimersByTimeAsync(1200)
    expect(await p).toBeNull()
  }

  const reply = (id: unknown, extra: Record<string, unknown> = {}) => ({
    type: 'peckos',
    isReply: true,
    id,
    result: INFO,
    ...extra,
  })

  it('a reply from another origin', () =>
    assertIgnored((id) => ({ origin: 'https://evil.example', data: reply(id) })))

  it('a reply from a look-alike origin', () =>
    assertIgnored((id) => ({ origin: 'https://os.peck.to.evil.example', data: reply(id) })))

  it('a reply from the right origin but a different window', () =>
    assertIgnored((id) => ({ source: { postMessage() {} }, origin: OS, data: reply(id) })))

  it('a reply with no source', () =>
    assertIgnored((id) => ({ source: null, origin: OS, data: reply(id) })))

  it('a reply with the wrong id', () =>
    assertIgnored(() => ({ origin: OS, data: reply('not-the-id') })))

  it('a message that is not a reply (the request echoed back)', () =>
    assertIgnored((id) => ({ origin: OS, data: { type: 'peckos', id, call: 'hello', args: {} } })))

  it('a reply of the wrong family', () =>
    assertIgnored((id) => ({
      origin: OS,
      data: { type: 'CWI', isInvocation: false, id, status: 'success', result: INFO },
    })))

  it('data that is not an object', async () => {
    await assertIgnored(() => ({ origin: OS, data: 'hello' }))
    await assertIgnored(() => ({ origin: OS, data: null }))
  })

  it('an error reply means no session, not a crash', async () => {
    const win = new FakeWindow()
    const p = clientFor(win).detect()
    win.fromParent(OS, { type: 'peckos', isReply: true, id: win.last.message.id, error: 'nope' })
    expect(await p).toBeNull()
  })
})

describe('detect: which origins it messages', () => {
  it('trusts only os.peck.to by default', () => {
    expect(PECKOS_TRUSTED_ORIGINS).toEqual([OS])
  })

  it('asks only the framing origin when the browser reveals it', async () => {
    const win = new FakeWindow({ ancestorOrigins: [OS] })
    const p = clientFor(win).detect({ trusted: ['http://127.0.0.1:5173'] })
    expect(win.posted.map((m) => m.targetOrigin)).toEqual([OS])
    answerHello(win)
    expect((await p)?.origin).toBe(OS)
  })

  it('sends nothing when the framing origin is not a trusted one', async () => {
    const win = new FakeWindow({ ancestorOrigins: ['https://evil.example'] })
    expect(await clientFor(win).detect()).toBeNull()
    expect(win.posted).toHaveLength(0)
  })

  it('tries every trusted origin when the framing origin is unknown', async () => {
    const win = new FakeWindow()
    const p = clientFor(win).detect({ trusted: ['http://localhost:3000', OS] })
    expect(win.posted.map((m) => m.targetOrigin)).toEqual([OS, 'http://localhost:3000'])
    // the reply is matched to the origin it came from
    const local = win.posted.find((m) => m.targetOrigin === 'http://localhost:3000')
    win.fromParent('http://localhost:3000', { type: 'peckos', isReply: true, id: local?.message.id, result: INFO })
    const session = await p
    expect(session?.origin).toBe('http://localhost:3000')
  })

  it('a reply to one origin does not count when it arrives from another', async () => {
    const win = new FakeWindow()
    const p = clientFor(win).detect({ trusted: ['http://localhost:3000'] })
    const forLocal = win.posted.find((m) => m.targetOrigin === 'http://localhost:3000')
    win.fromParent(OS, { type: 'peckos', isReply: true, id: forLocal?.message.id, result: INFO })
    await vi.advanceTimersByTimeAsync(1200)
    expect(await p).toBeNull()
  })

  describe('development override (peckos:trust)', () => {
    const origins = async (storage: Record<string, string>) => {
      const win = new FakeWindow({ storage })
      const p = clientFor(win).detect({ timeout: 1 })
      await vi.advanceTimersByTimeAsync(1)
      await p
      return win.posted.map((m) => m.targetOrigin)
    }

    it('adds loopback origins', async () => {
      expect(await origins({ 'peckos:trust': 'http://127.0.0.1:5173' })).toEqual([OS, 'http://127.0.0.1:5173'])
      expect(await origins({ 'peckos:trust': 'http://localhost' })).toEqual([OS, 'http://localhost'])
      expect(await origins({ 'peckos:trust': 'https://[::1]:8443' })).toEqual([OS, 'https://[::1]:8443'])
    })

    it('accepts a comma-separated list and trims spaces', async () => {
      expect(await origins({ 'peckos:trust': ' http://localhost:1 , http://127.0.0.1:2 ' })).toEqual([
        OS,
        'http://localhost:1',
        'http://127.0.0.1:2',
      ])
    })

    it('never adds a real site, however it is spelled', async () => {
      const planted = [
        'https://evil.example',
        'https://evil.example/',
        'http://localhost.evil.example',
        'http://127.0.0.1.evil.example',
        'http://localhost@evil.example',
        'http://evil.example#localhost',
        'http://localhost:99999999',
        'http://localhost/',
        'ftp://localhost',
        'localhost',
        'http://10.0.0.1',
        'http://0.0.0.0',
        '*',
      ]
      for (const value of planted) {
        expect(await origins({ 'peckos:trust': value }), value).toEqual([OS])
      }
      // one valid entry among bad ones: only the valid one survives
      expect(await origins({ 'peckos:trust': 'https://evil.example,http://localhost:8080' })).toEqual([
        OS,
        'http://localhost:8080',
      ])
    })

    it('ignores storage that throws', async () => {
      const win = new FakeWindow()
      win.localStorage = {
        getItem() {
          throw new DOMException('blocked', 'SecurityError')
        },
      }
      const p = clientFor(win).detect({ timeout: 1 })
      await vi.advanceTimersByTimeAsync(1)
      await p
      expect(win.posted.map((m) => m.targetOrigin)).toEqual([OS])
    })
  })
})

describe('wallet', () => {
  it('exposes exactly the BRC-100 methods Peck OS forwards', () => {
    expect([...WALLET_METHODS]).toEqual([
      'createAction', 'signAction', 'abortAction', 'listActions', 'internalizeAction', 'listOutputs',
      'relinquishOutput', 'getPublicKey', 'revealCounterpartyKeyLinkage', 'revealSpecificKeyLinkage',
      'encrypt', 'decrypt', 'createHmac', 'verifyHmac', 'createSignature', 'verifySignature',
      'acquireCertificate', 'listCertificates', 'proveCertificate', 'relinquishCertificate',
      'discoverByIdentityKey', 'discoverByAttributes', 'isAuthenticated', 'waitForAuthentication',
      'getHeight', 'getHeaderForHeight', 'getNetwork', 'getVersion',
    ])
  })

  it('has a function for each method and nothing else', async () => {
    const { session } = await detectSession()
    expect(Object.keys(session.wallet).sort()).toEqual([...WALLET_METHODS].sort())
    for (const m of WALLET_METHODS) expect(typeof session.wallet[m]).toBe('function')
  })

  it('sends a CWI invocation to the session origin', async () => {
    const { win, session } = await detectSession()
    void session.wallet.getPublicKey({ identityKey: true })
    expect(win.last.targetOrigin).toBe(OS)
    expect(win.last.message).toEqual({
      type: 'CWI',
      isInvocation: true,
      id: expect.any(String),
      call: 'getPublicKey',
      args: { identityKey: true },
    })
  })

  it('defaults the arguments to an empty object', async () => {
    const { win, session } = await detectSession()
    void session.wallet.isAuthenticated()
    expect(win.last.message.args).toEqual({})
  })

  it('resolves with the result of a successful invocation', async () => {
    const { win, session } = await detectSession()
    const p = session.wallet.getPublicKey({ identityKey: true })
    win.fromParent(OS, {
      type: 'CWI',
      isInvocation: false,
      id: win.last.message.id,
      status: 'success',
      result: { publicKey: '02abc' },
    })
    expect(await p).toEqual({ publicKey: '02abc' })
    expect(win.listeners.size).toBe(0)
  })

  it('rejects with the description and code of a failed invocation', async () => {
    const { win, session } = await detectSession()
    const p = session.wallet.createAction({})
    win.fromParent(OS, {
      type: 'CWI',
      isInvocation: false,
      id: win.last.message.id,
      status: 'error',
      description: 'The user said no',
      code: 6,
    })
    const err = (await p.catch((e: unknown) => e)) as PeckOSWalletError
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('The user said no')
    expect(err.code).toBe(6)
  })

  it('does not treat its own invocation, or a wrong-family message, as a reply', async () => {
    const { win, session } = await detectSession()
    let settled = false
    void session.wallet.getVersion().finally(() => {
      settled = true
    })
    const id = win.last.message.id
    win.fromParent(OS, { type: 'CWI', isInvocation: true, id, call: 'getVersion', args: {} })
    win.fromParent(OS, { type: 'peckos', isReply: true, id, result: 'x' })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
  })

  it('ignores replies from other origins or windows', async () => {
    const { win, session } = await detectSession()
    let settled = false
    void session.wallet.getVersion().finally(() => {
      settled = true
    })
    const id = win.last.message.id
    const ok = { type: 'CWI', isInvocation: false, id, status: 'success', result: 'x' }
    win.fromParent('https://evil.example', ok)
    win.dispatch({ source: {}, origin: OS, data: ok })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
  })

  it('never times out: a person may be answering', async () => {
    const { win, session } = await detectSession()
    let settled = false
    void session.wallet.createAction({}).finally(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(settled).toBe(false)
    expect(win.listeners.size).toBe(1)
  })

  it('keeps concurrent calls apart by id', async () => {
    const { win, session } = await detectSession()
    const a = session.wallet.getHeight()
    const b = session.wallet.getNetwork()
    const [ida, idb] = win.posted.map((m) => m.message.id)
    expect(ida).not.toBe(idb)
    win.fromParent(OS, { type: 'CWI', isInvocation: false, id: idb, status: 'success', result: { network: 'main' } })
    win.fromParent(OS, { type: 'CWI', isInvocation: false, id: ida, status: 'success', result: { height: 7 } })
    expect(await a).toEqual({ height: 7 })
    expect(await b).toEqual({ network: 'main' })
  })
})

describe('desktop calls', () => {
  const reply = (win: FakeWindow, extra: Record<string, unknown>, origin = OS) =>
    win.fromParent(origin, { type: 'peckos', isReply: true, id: win.last.message.id, ...extra })

  it('connect asks the user and updates the session', async () => {
    const win = new FakeWindow()
    const p0 = clientFor(win).detect()
    answerHello(win, { os: 'Peck OS', protocol: 1, connected: false })
    const session = (await p0) as PeckOSSession
    expect(session.connected).toBe(false)
    win.posted.length = 0

    const p = session.connect()
    expect(win.last.targetOrigin).toBe(OS)
    expect(win.last.message).toEqual({ type: 'peckos', id: expect.any(String), call: 'connect', args: {} })
    reply(win, { result: INFO })
    expect(await p).toEqual(INFO)
    expect(session.connected).toBe(true)
    expect(session.identityKey).toBe('02abc')
  })

  it('connect rejects when the user says no, and stays disconnected', async () => {
    const win = new FakeWindow()
    const p0 = clientFor(win).detect()
    answerHello(win, { connected: false })
    const session = (await p0) as PeckOSSession
    const p = session.connect()
    reply(win, { error: 'The user did not allow it' })
    await expect(p).rejects.toThrow('The user did not allow it')
    expect(session.connected).toBe(false)
  })

  it('connect has no timeout', async () => {
    const { win, session } = await detectSession()
    let settled = false
    void session.connect().catch(() => {}).finally(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(settled).toBe(false)
    expect(win.listeners.size).toBe(1)
  })

  it('open sends the url as a string', async () => {
    const { win, session } = await detectSession()
    const p = session.open('https://peck.bio/')
    expect(win.last.message).toMatchObject({ type: 'peckos', call: 'open', args: { url: 'https://peck.bio/' } })
    reply(win, { result: { opened: true } })
    expect(await p).toEqual({ opened: true })
  })

  it('open coerces its argument to a string', async () => {
    const { win, session } = await detectSession()
    void session.open(new URL('https://peck.bio/x') as unknown as string).catch(() => {})
    expect(win.last.message.args).toEqual({ url: 'https://peck.bio/x' })
  })

  it('notify sends title and body (body defaults to empty)', async () => {
    const { win, session } = await detectSession()
    void session.notify('Posted', 'Your post is on chain')
    expect(win.last.message).toMatchObject({ call: 'notify', args: { title: 'Posted', body: 'Your post is on chain' } })
    void session.notify('Only a title')
    expect(win.last.message).toMatchObject({ call: 'notify', args: { title: 'Only a title', body: '' } })
  })

  it('setTitle and setBadge send their arguments', async () => {
    const { win, session } = await detectSession()
    void session.setTitle('Inbox')
    expect(win.last.message).toMatchObject({ type: 'peckos', call: 'setTitle', args: { title: 'Inbox' } })
    void session.setBadge(3)
    expect(win.last.message).toMatchObject({ type: 'peckos', call: 'setBadge', args: { count: 3 } })
  })

  it.each([
    ['open', (s: PeckOSSession) => s.open('https://peck.bio/')],
    ['notify', (s: PeckOSSession) => s.notify('t')],
    ['setTitle', (s: PeckOSSession) => s.setTitle('t')],
    ['setBadge', (s: PeckOSSession) => s.setBadge(1)],
  ])('%s gives up after 5 seconds', async (_name, call) => {
    const { win, session } = await detectSession()
    const p = call(session)
    const settled = p.then(
      () => 'resolved',
      (e: Error) => e.message,
    )
    await vi.advanceTimersByTimeAsync(4999)
    expect(win.listeners.size).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await settled).toBe('Peck OS did not answer')
    expect(win.listeners.size).toBe(0)
  })

  it('rejects with the error text of an error reply', async () => {
    const { win, session } = await detectSession()
    const p = session.open('javascript:alert(1)')
    reply(win, { error: 'Only http(s) links can be opened' })
    await expect(p).rejects.toThrow('Only http(s) links can be opened')
  })

  it('ignores desktop replies from the wrong origin', async () => {
    const { win, session } = await detectSession()
    const p = session.setBadge(2)
    reply(win, { result: {} }, 'https://evil.example')
    const settled = p.then(
      () => 'resolved',
      (e: Error) => e.message,
    )
    await vi.advanceTimersByTimeAsync(5000)
    expect(await settled).toBe('Peck OS did not answer')
  })
})
