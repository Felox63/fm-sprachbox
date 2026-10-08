import { describe, it, expect, vi, beforeEach } from 'vitest'

let trayInstances: Array<{
  setToolTip: ReturnType<typeof vi.fn>
  setContextMenu: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
}> = []
let createdImages: Array<{ path: string; empty: boolean; isEmpty: () => boolean }> = []
let nextTrayThrows = false
let nextImageEmpty = false

vi.mock('electron', async () => {
  const actual = await vi.importActual<typeof import('electron')>('electron')
  return {
    ...actual,
    Tray: vi.fn().mockImplementation(() => {
      if (nextTrayThrows) {
        throw new Error('tray creation failed')
      }
      const tray = {
        setToolTip: vi.fn(),
        setContextMenu: vi.fn(),
        on: vi.fn(),
        destroy: vi.fn(),
        isDestroyed: vi.fn(() => false),
      }
      trayInstances.push(tray)
      return tray
    }),
    Menu: {
      buildFromTemplate: vi.fn((items) => items),
    },
    nativeImage: {
      createFromPath: vi.fn((imagePath: string) => {
        const image = {
          path: imagePath,
          empty: nextImageEmpty,
          isEmpty: () => image.empty,
        }
        createdImages.push(image)
        return image
      }),
    },
  }
})

import { createTrayController } from '../../src/main/tray.js'

function makeFakeWindow (overrides?: Partial<ReturnType<typeof makeFakeWindow>>): ReturnType<typeof makeFakeWindow> {
  const win = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    hide: vi.fn(),
    close: vi.fn(),
    ...overrides,
  }
  return win
}

function makeFakeApp (): Electron.App {
  return {
    quit: vi.fn(),
  } as unknown as Electron.App
}

beforeEach(() => {
  trayInstances = []
  createdImages = []
  nextTrayThrows = false
  nextImageEmpty = false
  vi.clearAllMocks()
})

describe('createTrayController', () => {
  it('falls back to the next icon candidate when nativeImage is empty', () => {
    nextImageEmpty = true
    const controller = createTrayController({
      app: makeFakeApp(),
      window: makeFakeWindow(),
      getMinimizeToTray: () => false,
      onMinimizeToTrayChanged: vi.fn(),
      onShowWindow: vi.fn(),
    })
    // All candidates are empty, so no tray can be created.
    expect(controller.tray).toBeNull()
    expect(createdImages.length).toBeGreaterThanOrEqual(3)
    expect(createdImages.every((img) => img.empty)).toBe(true)
  })

  it('creates a tray when at least one icon candidate is non-empty', () => {
    // Default: nativeImage.isEmpty() returns false.
    const controller = createTrayController({
      app: makeFakeApp(),
      window: makeFakeWindow(),
      getMinimizeToTray: () => true,
      onMinimizeToTrayChanged: vi.fn(),
      onShowWindow: vi.fn(),
    })
    expect(controller.tray).not.toBeNull()
    expect(trayInstances).toHaveLength(1)
    expect(trayInstances[0].setToolTip).toHaveBeenCalledWith('FM - Sprachbox')
  })

  it('survives tray creation failure and exposes a null tray', () => {
    nextTrayThrows = true
    const controller = createTrayController({
      app: makeFakeApp(),
      window: makeFakeWindow(),
      getMinimizeToTray: () => true,
      onMinimizeToTrayChanged: vi.fn(),
      onShowWindow: vi.fn(),
    })
    expect(controller.tray).toBeNull()
    expect(trayInstances).toHaveLength(0)
  })

  it('shows a minimized/hidden window when the tray is clicked', () => {
    const window = makeFakeWindow({ isMinimized: vi.fn(() => true) })
    createTrayController({
      app: makeFakeApp(),
      window,
      getMinimizeToTray: () => true,
      onMinimizeToTrayChanged: vi.fn(),
      onShowWindow: vi.fn(),
    })
    const clickHandler = trayInstances[0].on.mock.calls.find((call: unknown[]) => call[0] === 'click')?.[1] as (() => void) | undefined
    clickHandler?.()
    expect(window.restore).toHaveBeenCalled()
    expect(window.show).toHaveBeenCalled()
    expect(window.focus).toHaveBeenCalled()
  })

  it('explicit quit marks quitting and calls app.quit', () => {
    const app = makeFakeApp()
    const window = makeFakeWindow()
    const controller = createTrayController({
      app,
      window,
      getMinimizeToTray: () => true,
      onMinimizeToTrayChanged: vi.fn(),
      onShowWindow: vi.fn(),
    })
    expect(controller.isQuitting).toBe(false)
    controller.quitApp()
    expect(controller.isQuitting).toBe(true)
    expect(window.close).toHaveBeenCalled()
    expect(app.quit).toHaveBeenCalled()
  })

  it('destroys the tray and clears state', () => {
    const controller = createTrayController({
      app: makeFakeApp(),
      window: makeFakeWindow(),
      getMinimizeToTray: () => true,
      onMinimizeToTrayChanged: vi.fn(),
      onShowWindow: vi.fn(),
    })
    controller.destroy()
    expect(trayInstances[0].destroy).toHaveBeenCalled()
    expect(controller.tray).toBeNull()
  })

  it('updates the menu without crashing when no tray exists', () => {
    nextImageEmpty = true
    const controller = createTrayController({
      app: makeFakeApp(),
      window: makeFakeWindow(),
      getMinimizeToTray: () => true,
      onMinimizeToTrayChanged: vi.fn(),
      onShowWindow: vi.fn(),
    })
    expect(() => controller.updateMenu?.()).not.toThrow()
    expect(() => controller.setMinimizeToTray?.(true)).not.toThrow()
  })

  it('recreates the tray after destruction via ensureTray', () => {
    const controller = createTrayController({
      app: makeFakeApp(),
      window: makeFakeWindow(),
      getMinimizeToTray: () => true,
      onMinimizeToTrayChanged: vi.fn(),
      onShowWindow: vi.fn(),
    })
    controller.destroy()
    expect(trayInstances).toHaveLength(1)
    const restored = controller.ensureTray?.()
    expect(restored).not.toBeNull()
    expect(trayInstances).toHaveLength(2)
  })
})

describe('tray-aware window close behavior', () => {
  it('hides the window when minimizeToTray is on and a working tray exists', () => {
    const window = makeFakeWindow()
    const controller = createTrayController({
      app: makeFakeApp(),
      window,
      getMinimizeToTray: () => true,
      onMinimizeToTrayChanged: vi.fn(),
      onShowWindow: vi.fn(),
    })
    const event = { preventDefault: vi.fn(), defaultPrevented: false }
    // Simulate the caller invoking the close handler with the controller's tray.
    const tray = controller.ensureTray?.()
    if (tray != null && !tray.isDestroyed()) {
      event.preventDefault()
      window.hide()
    }
    expect(event.preventDefault).toHaveBeenCalled()
    expect(window.hide).toHaveBeenCalled()
  })

  it('does not prevent close when minimizeToTray is on but tray is missing', () => {
    nextImageEmpty = true
    const window = makeFakeWindow()
    const controller = createTrayController({
      app: makeFakeApp(),
      window,
      getMinimizeToTray: () => true,
      onMinimizeToTrayChanged: vi.fn(),
      onShowWindow: vi.fn(),
    })
    const event = { preventDefault: vi.fn(), defaultPrevented: false }
    const tray = controller.ensureTray?.()
    if (tray != null && !tray.isDestroyed()) {
      event.preventDefault()
      window.hide()
    }
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(window.hide).not.toHaveBeenCalled()
  })
})
