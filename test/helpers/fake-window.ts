import type { PeckOSMessageEvent, PeckOSWindow } from '../../src/peckos/index.js'

type Listener = (event: PeckOSMessageEvent) => void

export interface Posted {
  message: Record<string, unknown>
  targetOrigin: string
}

/** A stand-in for the framed app's `window`, with a scriptable parent (Peck OS). */
export class FakeWindow implements PeckOSWindow {
  parent: PeckOSWindow
  location: { ancestorOrigins?: ArrayLike<string> } = {}
  localStorage: { getItem(key: string): string | null } | undefined
  readonly listeners = new Set<Listener>()
  /** Messages the app posted to its parent. */
  readonly posted: Posted[] = []
  /** Make the parent's postMessage throw for these target origins (as for an invalid origin). */
  throwFor = new Set<string>()
  /** The parent window object; compared by identity, like `event.source`. */
  readonly parentWindow: PeckOSWindow

  constructor(opts: { framed?: boolean; ancestorOrigins?: string[]; storage?: Record<string, string> } = {}) {
    const { framed = true, ancestorOrigins, storage } = opts
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    const parentWindow: PeckOSWindow = {
      get parent(): PeckOSWindow {
        return parentWindow
      },
      postMessage(message: unknown, targetOrigin: string): void {
        if (self.throwFor.has(targetOrigin)) throw new SyntaxError(`invalid target origin ${targetOrigin}`)
        self.posted.push({ message: message as Record<string, unknown>, targetOrigin })
      },
      addEventListener() {},
      removeEventListener() {},
    }
    this.parentWindow = parentWindow
    this.parent = framed ? parentWindow : this
    if (ancestorOrigins !== undefined) this.location = { ancestorOrigins }
    if (storage !== undefined) this.localStorage = { getItem: (k) => storage[k] ?? null }
  }

  postMessage(): void {}

  addEventListener(_type: 'message', listener: Listener): void {
    this.listeners.add(listener)
  }

  removeEventListener(_type: 'message', listener: Listener): void {
    this.listeners.delete(listener)
  }

  /** Deliver a message event to the app. */
  dispatch(event: { source?: unknown; origin: string; data: unknown }): void {
    const e: PeckOSMessageEvent = {
      source: 'source' in event ? event.source : this.parentWindow,
      origin: event.origin,
      data: event.data,
    }
    for (const l of [...this.listeners]) l(e)
  }

  /** Deliver a message from the real parent window. */
  fromParent(origin: string, data: unknown): void {
    this.dispatch({ origin, data })
  }

  /** The most recent message the app posted. */
  get last(): Posted {
    const p = this.posted[this.posted.length - 1]
    if (p === undefined) throw new Error('nothing was posted')
    return p
  }
}
