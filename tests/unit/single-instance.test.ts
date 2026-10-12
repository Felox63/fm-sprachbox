import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { App, BaseWindow } from 'electron'
import { acquireSingleInstance } from '../../src/main/single-instance.js'

function makeFakeApp (): App {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {}
  return {
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (handlers[event] == null) handlers[event] = []
      handlers[event].push(handler)
    }),
    emit: (event: string, ...args: unknown[]) => {
      for (const handler of handlers[event] ?? []) {
        handler(...args)
      }
    },
  } as unknown as App
}

function makeFakeWindow (overrides?: Partial<ReturnType<typeof makeFakeWindow>>): BaseWindow {
  return {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    ...overrides,
  } as unknown as BaseWindow
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('acquireSingleInstance', () => {
  it('returns false and quits when single instance lock is not acquired', () => {
    const app = makeFakeApp()
    app.requestSingleInstanceLock = vi.fn(() => false)
    const getWindow = vi.fn(() => null)
    expect(acquireSingleInstance(app, getWindow)).toBe(false)
    expect(app.quit).toHaveBeenCalled()
  })

  it('registers a second-instance handler that restores a minimized window', () => {
    const app = makeFakeApp()
    const window = makeFakeWindow({ isMinimized: vi.fn(() => true), isVisible: vi.fn(() => true) })
    const getWindow = vi.fn(() => window)
    expect(acquireSingleInstance(app, getWindow)).toBe(true)
    app.emit('second-instance')
    expect(window.isMinimized).toHaveBeenCalled()
    expect(window.restore).toHaveBeenCalled()
    expect(window.focus).toHaveBeenCalled()
  })

  it('registers a second-instance handler that shows a hidden window', () => {
    const app = makeFakeApp()
    const window = makeFakeWindow({ isVisible: vi.fn(() => false), isMinimized: vi.fn(() => false) })
    const getWindow = vi.fn(() => window)
    expect(acquireSingleInstance(app, getWindow)).toBe(true)
    app.emit('second-instance')
    expect(window.isVisible).toHaveBeenCalled()
    expect(window.show).toHaveBeenCalled()
    expect(window.focus).toHaveBeenCalled()
  })

  it('registers a second-instance handler that handles a hidden and minimized window', () => {
    const app = makeFakeApp()
    const window = makeFakeWindow({ isMinimized: vi.fn(() => true), isVisible: vi.fn(() => false) })
    const getWindow = vi.fn(() => window)
    expect(acquireSingleInstance(app, getWindow)).toBe(true)
    app.emit('second-instance')
    expect(window.restore).toHaveBeenCalled()
    expect(window.show).toHaveBeenCalled()
    expect(window.focus).toHaveBeenCalled()
  })

  it('does nothing when the window is destroyed on second-instance', () => {
    const app = makeFakeApp()
    const window = makeFakeWindow({ isDestroyed: vi.fn(() => true) })
    const getWindow = vi.fn(() => window)
    expect(acquireSingleInstance(app, getWindow)).toBe(true)
    app.emit('second-instance')
    expect(window.restore).not.toHaveBeenCalled()
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
  })

  it('does nothing when no window exists on second-instance', () => {
    const app = makeFakeApp()
    const getWindow = vi.fn(() => null)
    expect(acquireSingleInstance(app, getWindow)).toBe(true)
    app.emit('second-instance')
    expect(app.quit).not.toHaveBeenCalled()
  })
})
