import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BaseWindow, Tray, App } from 'electron'
import type { TrayController } from '../../src/main/tray.js'
import type { RuntimeState } from '../../src/main/app.js'
import {
  registerTrayWindowCloseHandler,
  registerAppTrayQuitHandlers,
} from '../../src/main/tray-lifecycle.js'

interface FakeEvent {
  preventDefault: ReturnType<typeof vi.fn>
  defaultPrevented: boolean
}

function makeFakeWindow (overrides?: Partial<ReturnType<typeof makeFakeWindow>>): ReturnType<typeof makeFakeWindow> & BaseWindow {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  const win = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    hide: vi.fn(),
    close: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (listeners[event] == null) listeners[event] = []
      listeners[event].push(handler)
    }),
    once: vi.fn(),
    emit: (event: string, ...args: unknown[]) => {
      for (const handler of listeners[event] ?? []) {
        handler(...args)
      }
    },
    ...overrides,
  }
  return win as unknown as ReturnType<typeof makeFakeWindow> & BaseWindow
}

function makeFakeEvent (): FakeEvent {
  const event: FakeEvent = {
    preventDefault: vi.fn(() => { event.defaultPrevented = true }),
    defaultPrevented: false,
  }
  return event
}

function makeFakeTray (destroyed = false): Tray {
  return {
    isDestroyed: vi.fn(() => destroyed),
  } as unknown as Tray
}

function makeFakeTrayController (overrides?: Partial<TrayController>): TrayController {
  return {
    tray: null,
    isQuitting: false,
    showWindow: vi.fn(),
    quitApp: vi.fn(),
    destroy: vi.fn(),
    setMinimizeToTray: vi.fn(),
    updateMenu: vi.fn(),
    ensureTray: vi.fn(() => makeFakeTray(false)),
    ...overrides,
  } as unknown as TrayController
}

function makeFakeApp (): App {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  return {
    quit: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (listeners[event] == null) listeners[event] = []
      listeners[event].push(handler)
    }),
    emit: (event: string, ...args: unknown[]) => {
      for (const handler of listeners[event] ?? []) {
        handler({}, ...args)
      }
    },
  } as unknown as App
}

function makeRuntimeState (): RuntimeState {
  return {
    mainWindow: null,
    shellView: null,
    messengers: new Map(),
    activeAccountId: null,
    showingHome: false,
    serviceConfig: {
      version: 2,
      accounts: [],
      selectedAccountId: null,
      preferences: undefined,
    },
    lastConfigSaveError: 'none',
    trayController: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('registerTrayWindowCloseHandler', () => {
  it('hides to tray when minimizeToTray is on and a working tray exists', () => {
    const window = makeFakeWindow()
    const trayController = makeFakeTrayController()
    registerTrayWindowCloseHandler(window, trayController, () => true)
    const event = makeFakeEvent()
    window.emit('close', event)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(window.hide).toHaveBeenCalled()
  })

  it('closes normally when minimizeToTray is disabled (Option AUS)', () => {
    const window = makeFakeWindow()
    const trayController = makeFakeTrayController()
    registerTrayWindowCloseHandler(window, trayController, () => false)
    const event = makeFakeEvent()
    window.emit('close', event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(window.hide).not.toHaveBeenCalled()
  })

  it('closes normally when an explicit quit is in progress', () => {
    const window = makeFakeWindow()
    const trayController = makeFakeTrayController({ isQuitting: true })
    registerTrayWindowCloseHandler(window, trayController, () => true)
    const event = makeFakeEvent()
    window.emit('close', event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(window.hide).not.toHaveBeenCalled()
  })

  it('closes normally when no tray controller exists', () => {
    const window = makeFakeWindow()
    registerTrayWindowCloseHandler(window, null, () => true)
    const event = makeFakeEvent()
    window.emit('close', event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(window.hide).not.toHaveBeenCalled()
  })

  it('closes normally when tray creation fails (no usable icon / constructor error)', () => {
    const window = makeFakeWindow()
    const trayController = makeFakeTrayController({ ensureTray: vi.fn(() => null) })
    registerTrayWindowCloseHandler(window, trayController, () => true)
    const event = makeFakeEvent()
    window.emit('close', event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(window.hide).not.toHaveBeenCalled()
  })

  it('closes normally when the tray is destroyed and recreation also fails', () => {
    const window = makeFakeWindow()
    const trayController = makeFakeTrayController({ ensureTray: vi.fn(() => makeFakeTray(true)) })
    registerTrayWindowCloseHandler(window, trayController, () => true)
    const event = makeFakeEvent()
    window.emit('close', event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(window.hide).not.toHaveBeenCalled()
  })

  it('recovers when tray was destroyed but can be recreated', () => {
    const window = makeFakeWindow()
    const trayController = makeFakeTrayController({ ensureTray: vi.fn(() => makeFakeTray(false)) })
    registerTrayWindowCloseHandler(window, trayController, () => true)
    const event = makeFakeEvent()
    window.emit('close', event)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(window.hide).toHaveBeenCalled()
  })
})

describe('registerAppTrayQuitHandlers', () => {
  it('marks the tray controller as quitting on before-quit', () => {
    const app = makeFakeApp()
    const trayController = makeFakeTrayController()
    const state = makeRuntimeState()
    registerAppTrayQuitHandlers(app, () => trayController, state)
    app.emit('before-quit')
    expect(trayController.isQuitting).toBe(true)
  })

  it('does nothing harmful when before-quit fires without a tray controller', () => {
    const app = makeFakeApp()
    const state = makeRuntimeState()
    expect(() => registerAppTrayQuitHandlers(app, () => null, state)).not.toThrow()
    expect(() => app.emit('before-quit')).not.toThrow()
  })

  it('destroys the tray, clears state and quits on window-all-closed', () => {
    const app = makeFakeApp()
    const trayController = makeFakeTrayController()
    const state = makeRuntimeState()
    state.trayController = trayController
    const onTrayDestroyed = vi.fn()
    registerAppTrayQuitHandlers(app, () => trayController, state, { onTrayDestroyed })
    app.emit('window-all-closed')
    expect(trayController.destroy).toHaveBeenCalled()
    expect(onTrayDestroyed).toHaveBeenCalled()
    expect(state.trayController).toBeNull()
    expect(app.quit).toHaveBeenCalled()
  })

  it('cleans up safely when window-all-closed fires without a tray controller', () => {
    const app = makeFakeApp()
    const state = makeRuntimeState()
    registerAppTrayQuitHandlers(app, () => null, state)
    app.emit('window-all-closed')
    expect(app.quit).toHaveBeenCalled()
    expect(state.trayController).toBeNull()
  })
})
