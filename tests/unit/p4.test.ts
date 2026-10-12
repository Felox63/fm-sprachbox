import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import vm from 'node:vm'
import fs from 'node:fs'

vi.mock('electron', async () => {
  return {
    Notification: vi.fn().mockImplementation(() => ({
      show: vi.fn(),
      on: vi.fn(),
    })),
  }
})

import { Notification } from 'electron'
import { isSafeExternalUrl } from '../../src/main/navigation-policy.js'
import {
  getDefaultServiceConfig,
  setAppPreferences,
  saveServiceConfig,
  loadServiceConfig,
} from '../../src/main/service-config.js'
import {
  handleWebNotification,
  installNotificationBridgeForWebContents,
  FM_NOTIFICATION_BRIDGE,
  MAX_TITLE_LENGTH,
  MAX_BODY_LENGTH,
  type NotificationBridgeOptions,
} from '../../src/main/notifications.js'
import { type PortablePaths } from '../../src/main/portable-paths.js'
import path from 'node:path'
import os from 'node:os'

function makePaths (root: string): PortablePaths {
  const data = path.join(root, 'data')
  return {
    appRoot: root,
    data,
    logs: path.join(data, 'logs'),
    profiles: path.join(data, 'profiles'),
    temp: path.join(data, 'tmp'),
    cache: path.join(data, 'cache'),
    sessionData: path.join(data, 'session-data'),
    configFile: path.join(data, 'services.json'),
  }
}

describe('isSafeExternalUrl', () => {
  it('allows plain http and https URLs', () => {
    expect(isSafeExternalUrl('https://example.com/')).toBe(true)
    expect(isSafeExternalUrl('http://example.com/page')).toBe(true)
    expect(isSafeExternalUrl('https://example.com:8443/path?x=1')).toBe(true)
  })

  it('blocks non-http protocols', () => {
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('data:text/html,foo')).toBe(false)
    expect(isSafeExternalUrl('mailto:md@merkeldesign.biz')).toBe(false)
    expect(isSafeExternalUrl('custom-app://open')).toBe(false)
  })

  it('blocks URLs with embedded credentials', () => {
    expect(isSafeExternalUrl('https://user:pass@example.com/')).toBe(false)
    expect(isSafeExternalUrl('https://user@example.com/')).toBe(false)
  })

  it('blocks invalid or empty hostnames', () => {
    expect(isSafeExternalUrl('https://')).toBe(false)
    expect(isSafeExternalUrl('not a url')).toBe(false)
  })
})

describe('AppPreferences persistence', () => {
  const root = path.join(os.tmpdir(), `sprachbox-preferences-${Date.now()}`)
  const paths = makePaths(root)

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(paths.data, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('defaults minimizeToTray to false and notificationHideContent to true', () => {
    const config = getDefaultServiceConfig()
    expect(config.preferences).toEqual({
      minimizeToTray: false,
      notificationsEnabled: true,
      notificationHideContent: true,
    })
  })

  it('patches preferences without touching accounts', () => {
    const config = getDefaultServiceConfig()
    const updated = setAppPreferences(config, { minimizeToTray: true, notificationHideContent: false })
    expect(updated.preferences.minimizeToTray).toBe(true)
    expect(updated.preferences.notificationHideContent).toBe(false)
    expect(updated.preferences.notificationsEnabled).toBe(true)
    expect(updated.accounts).toEqual(config.accounts)
  })

  it('saves and reloads preferences', () => {
    const config = setAppPreferences(getDefaultServiceConfig(), { minimizeToTray: true })
    const saveResult = saveServiceConfig(paths, config)
    expect(saveResult.ok).toBe(true)
    const loaded = loadServiceConfig(paths)
    expect(loaded.config.preferences?.minimizeToTray).toBe(true)
    expect(loaded.config.preferences?.notificationsEnabled).toBe(true)
    expect(loaded.config.preferences?.notificationHideContent).toBe(true)
  })

  it('normalizes invalid preference values on load', () => {
    fs.writeFileSync(paths.configFile, JSON.stringify({
      version: 2,
      accounts: getDefaultServiceConfig().accounts,
      selectedAccountId: null,
      preferences: {
        minimizeToTray: 'not-a-boolean',
        notificationsEnabled: 123,
        notificationHideContent: null,
      },
    }), 'utf8')
    const loaded = loadServiceConfig(paths)
    expect(loaded.config.preferences).toEqual({
      minimizeToTray: false,
      notificationsEnabled: true,
      notificationHideContent: true,
    })
  })

  it('adds default preferences to legacy v1 migrations', () => {
    fs.writeFileSync(paths.configFile, JSON.stringify({ version: 1, enabled: ['whatsapp'] }), 'utf8')
    const loaded = loadServiceConfig(paths)
    expect(loaded.config.preferences).toEqual({
      minimizeToTray: false,
      notificationsEnabled: true,
      notificationHideContent: true,
    })
  })
})

function makeBridgeOptions (overrides?: Partial<NotificationBridgeOptions>): NotificationBridgeOptions {
  return {
    getPreferences: () => ({
      minimizeToTray: false,
      notificationsEnabled: true,
      notificationHideContent: true,
    }),
    getEnabledAccounts: () => [{
      accountId: 'legacy-telegram',
      serviceId: 'telegram' as const,
      displayName: 'Privat',
      enabled: true,
    }],
    getActiveAccountId: () => null,
    isAccountWindowVisible: () => false,
    onNotificationClicked: vi.fn(),
    onNotificationIndicator: vi.fn(),
    ...overrides,
  }
}

describe('handleWebNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sets a new-message indicator for the notified account', () => {
    const options = makeBridgeOptions()
    handleWebNotification(
      { accountId: 'legacy-telegram', serviceId: 'telegram', displayName: 'Privat' },
      { title: 'Max Mustermann', body: 'Hallo!', tag: 'abc', icon: '' },
      options,
    )
    expect(options.onNotificationIndicator).toHaveBeenCalledWith('legacy-telegram')
  })

  it('does not set an indicator for disabled accounts', () => {
    const options = makeBridgeOptions({
      getEnabledAccounts: () => [{
        accountId: 'legacy-telegram',
        serviceId: 'telegram' as const,
        displayName: 'Privat',
        enabled: false,
      }],
    })
    handleWebNotification(
      { accountId: 'legacy-telegram', serviceId: 'telegram', displayName: 'Privat' },
      { title: 'Max', body: 'Hallo', tag: '', icon: '' },
      options,
    )
    expect(options.onNotificationIndicator).not.toHaveBeenCalled()
  })

  it('sets an indicator even when notifications (toasts) are disabled', () => {
    const options = makeBridgeOptions({
      getPreferences: () => ({
        minimizeToTray: false,
        notificationsEnabled: false,
        notificationHideContent: true,
      }),
    })
    handleWebNotification(
      { accountId: 'legacy-telegram', serviceId: 'telegram', displayName: 'Privat' },
      { title: 'Max', body: 'Hallo', tag: '', icon: '' },
      options,
    )
    expect(options.onNotificationIndicator).toHaveBeenCalledWith('legacy-telegram')
    expect(Notification).not.toHaveBeenCalled()
  })

  it('does not set an indicator for the currently visible account even when toasts are disabled', () => {
    const options = makeBridgeOptions({
      getPreferences: () => ({
        minimizeToTray: false,
        notificationsEnabled: false,
        notificationHideContent: true,
      }),
      getActiveAccountId: () => 'legacy-telegram',
      isAccountWindowVisible: (id) => id === 'legacy-telegram',
    })
    handleWebNotification(
      { accountId: 'legacy-telegram', serviceId: 'telegram', displayName: 'Privat' },
      { title: 'Max', body: 'Hallo', tag: '', icon: '' },
      options,
    )
    expect(options.onNotificationIndicator).not.toHaveBeenCalled()
    expect(Notification).not.toHaveBeenCalled()
  })

  it('shows a privacy toast with only the trusted account identity in the title', () => {
    const options = makeBridgeOptions()
    handleWebNotification(
      { accountId: 'legacy-telegram', serviceId: 'telegram', displayName: 'Privat' },
      { title: 'Max Mustermann', body: 'Hallo!', tag: 'abc', icon: '' },
      options,
    )
    expect(Notification).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Telegram – Privat',
      body: 'Neue Nachricht',
      tag: 'fm-sprachbox-legacy-telegram',
    }))
  })

  it('shows the trusted account identity as title even when content hiding is disabled', () => {
    const options = makeBridgeOptions({
      getPreferences: () => ({
        minimizeToTray: false,
        notificationsEnabled: true,
        notificationHideContent: false,
      }),
    })
    handleWebNotification(
      { accountId: 'legacy-telegram', serviceId: 'telegram', displayName: 'Privat' },
      { title: 'Max Mustermann', body: 'Hallo!', tag: 'abc', icon: '' },
      options,
    )
    expect(Notification).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Telegram – Privat',
      body: 'Hallo!',
    }))
  })

  it('suppresses notifications when disabled', () => {
    const options = makeBridgeOptions({
      getPreferences: () => ({
        minimizeToTray: false,
        notificationsEnabled: false,
        notificationHideContent: true,
      }),
    })
    handleWebNotification(
      { accountId: 'legacy-telegram', serviceId: 'telegram', displayName: 'Privat' },
      { title: 'Max', body: 'Hallo', tag: '', icon: '' },
      options,
    )
    expect(Notification).not.toHaveBeenCalled()
  })

  it('ignores notifications for removed/disabled accounts', () => {
    const options = makeBridgeOptions({
      getEnabledAccounts: () => [{
        accountId: 'legacy-telegram',
        serviceId: 'telegram' as const,
        displayName: 'Privat',
        enabled: false,
      }],
    })
    handleWebNotification(
      { accountId: 'legacy-telegram', serviceId: 'telegram', displayName: 'Privat' },
      { title: 'Max', body: 'Hallo', tag: '', icon: '' },
      options,
    )
    expect(Notification).not.toHaveBeenCalled()
  })

  it('ignores notifications for the currently visible focused account', () => {
    const options = makeBridgeOptions({
      getActiveAccountId: () => 'legacy-telegram',
      isAccountWindowVisible: (id) => id === 'legacy-telegram',
    })
    handleWebNotification(
      { accountId: 'legacy-telegram', serviceId: 'telegram', displayName: 'Privat' },
      { title: 'Max', body: 'Hallo', tag: '', icon: '' },
      options,
    )
    expect(Notification).not.toHaveBeenCalled()
  })

  it('shows notification for active account when window is hidden/minimized/unfocused or overlay is shown', () => {
    const options = makeBridgeOptions({
      getActiveAccountId: () => 'legacy-telegram',
      isAccountWindowVisible: () => false,
    })
    handleWebNotification(
      { accountId: 'legacy-telegram', serviceId: 'telegram', displayName: 'Privat' },
      { title: 'Max', body: 'Hallo', tag: '', icon: '' },
      options,
    )
    expect(Notification).toHaveBeenCalled()
  })

  it('sanitizes oversized notification payload fields', () => {
    const options = makeBridgeOptions()
    handleWebNotification(
      { accountId: 'legacy-telegram', serviceId: 'telegram', displayName: 'Privat' },
      { title: 'x'.repeat(500), body: 'y'.repeat(500), tag: 'z'.repeat(300), icon: 'i'.repeat(5000) },
      options,
    )
    const args = vi.mocked(Notification).mock.calls[0][0] as { title: string; body: string; tag: string; icon: string }
    expect(args.title.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH)
    expect(args.title).toBe('Telegram – Privat')
    expect(args.body.length).toBeLessThanOrEqual(MAX_BODY_LENGTH)
    expect(args.tag.length).toBeLessThanOrEqual(128)
    // icon is forwarded but not included in the native Notification options;
    // it is only validated for length during bridge transit.
    expect(args.icon).toBeUndefined()
  })

  it('ignores click when the account was disabled or removed after the toast was shown', () => {
    const onClicked = vi.fn()
    const options = makeBridgeOptions({
      getEnabledAccounts: () => [{
        accountId: 'legacy-telegram',
        serviceId: 'telegram' as const,
        displayName: 'Privat',
        enabled: true,
      }],
      onNotificationClicked: onClicked,
    })
    handleWebNotification(
      { accountId: 'legacy-telegram', serviceId: 'telegram', displayName: 'Privat' },
      { title: 'Max', body: 'Hallo', tag: '', icon: '' },
      options,
    )
    const instance = vi.mocked(Notification).mock.results[0].value as { on: ReturnType<typeof vi.fn> }
    const clickHandler = instance.on.mock.calls.find(([event]) => event === 'click')?.[1] as () => void
    expect(clickHandler).toBeDefined()

    // Simulate disabling the account after the toast was created.
    options.getEnabledAccounts = () => [{
      accountId: 'legacy-telegram',
      serviceId: 'telegram' as const,
      displayName: 'Privat',
      enabled: false,
    }]
    clickHandler()
    expect(onClicked).not.toHaveBeenCalled()
  })
})

describe('installNotificationBridgeForWebContents', () => {
  function makeFakeWebContents (
    origin: string,
    overrides?: { getURL?: () => string; frameUrl?: string },
  ): {
    webContents: Electron.WebContents
    emitIpcMessage: (payload: unknown, senderFrame?: { origin: string; url: string; parent: unknown; isDestroyed: () => boolean }) => void
  } {
    const listeners: Record<string, ((event: Record<string, unknown>, channel: string, payload: unknown) => void)[]> = {}
    const mainFrame = {
      origin,
      url: overrides?.frameUrl ?? `${origin}/`,
      parent: null,
      isDestroyed: () => false,
    }
    const wc = {
      on: (event: string, cb: (event: Record<string, unknown>, channel: string, payload: unknown) => void) => {
        if (listeners[event] == null) listeners[event] = []
        listeners[event].push(cb)
      },
      mainFrame,
      isDestroyed: () => false,
      getURL: overrides?.getURL ?? (() => mainFrame.url),
    } as unknown as Electron.WebContents
    return {
      webContents: wc,
      emitIpcMessage: (payload, senderFrame = mainFrame) => {
        const event = { sender: wc, senderFrame }
        for (const cb of listeners['ipc-message'] ?? []) {
          cb(event, FM_NOTIFICATION_BRIDGE, payload)
        }
      },
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows native toast when the real bridge path receives a valid main-frame message', () => {
    const { webContents, emitIpcMessage } = makeFakeWebContents('https://web.whatsapp.com')
    const options = makeBridgeOptions({
      getEnabledAccounts: () => [{
        accountId: 'legacy-whatsapp',
        serviceId: 'whatsapp' as const,
        displayName: 'Arbeit',
        enabled: true,
      }],
    })
    installNotificationBridgeForWebContents(
      webContents,
      { accountId: 'legacy-whatsapp', serviceId: 'whatsapp', displayName: 'Arbeit' },
      options,
    )
    emitIpcMessage({ title: 'Arbeitsgruppe', body: 'Neu', tag: 't1', icon: '' })
    expect(Notification).toHaveBeenCalledWith(expect.objectContaining({
      title: 'WhatsApp – Arbeit',
      body: 'Neue Nachricht',
    }))
    expect(options.onNotificationIndicator).toHaveBeenCalledWith('legacy-whatsapp')
  })

  it('sets a new-message indicator via the real bridge path', () => {
    const { webContents, emitIpcMessage } = makeFakeWebContents('https://web.whatsapp.com')
    const options = makeBridgeOptions({
      getEnabledAccounts: () => [{
        accountId: 'legacy-whatsapp',
        serviceId: 'whatsapp' as const,
        displayName: 'Arbeit',
        enabled: true,
      }],
    })
    installNotificationBridgeForWebContents(
      webContents,
      { accountId: 'legacy-whatsapp', serviceId: 'whatsapp', displayName: 'Arbeit' },
      options,
    )
    emitIpcMessage({ title: 'Arbeitsgruppe', body: 'Neu', tag: 't1', icon: '' })
    expect(options.onNotificationIndicator).toHaveBeenCalledWith('legacy-whatsapp')
  })

  it('rejects messages from a non-allowed origin', () => {
    const { webContents, emitIpcMessage } = makeFakeWebContents('https://evil.example.com')
    const options = makeBridgeOptions()
    installNotificationBridgeForWebContents(
      webContents,
      { accountId: 'legacy-whatsapp', serviceId: 'whatsapp', displayName: 'Arbeit' },
      options,
    )
    emitIpcMessage({ title: 'X', body: 'Y', tag: '', icon: '' })
    expect(Notification).not.toHaveBeenCalled()
    expect(options.onNotificationIndicator).not.toHaveBeenCalled()
  })

  it('rejects messages from a subframe', () => {
    const { webContents, emitIpcMessage } = makeFakeWebContents('https://web.whatsapp.com')
    installNotificationBridgeForWebContents(
      webContents,
      { accountId: 'legacy-whatsapp', serviceId: 'whatsapp', displayName: 'Arbeit' },
      makeBridgeOptions(),
    )
    const subframe = { origin: 'https://web.whatsapp.com', url: 'https://web.whatsapp.com/', parent: webContents.mainFrame, isDestroyed: () => false }
    emitIpcMessage({ title: 'X', body: 'Y', tag: '', icon: '' }, subframe)
    expect(Notification).not.toHaveBeenCalled()
  })

  it('rejects messages from a destroyed frame', () => {
    const { webContents, emitIpcMessage } = makeFakeWebContents('https://web.whatsapp.com')
    installNotificationBridgeForWebContents(
      webContents,
      { accountId: 'legacy-whatsapp', serviceId: 'whatsapp', displayName: 'Arbeit' },
      makeBridgeOptions(),
    )
    const destroyedFrame = { origin: 'https://web.whatsapp.com', url: 'https://web.whatsapp.com/', parent: null, isDestroyed: () => true }
    emitIpcMessage({ title: 'X', body: 'Y', tag: '', icon: '' }, destroyedFrame)
    expect(Notification).not.toHaveBeenCalled()
  })

  it('rejects messages when the frame origin does not belong to the account service', () => {
    const { webContents, emitIpcMessage } = makeFakeWebContents('https://web.whatsapp.com')
    installNotificationBridgeForWebContents(
      webContents,
      { accountId: 'legacy-telegram', serviceId: 'telegram', displayName: 'Privat' },
      makeBridgeOptions({
        getEnabledAccounts: () => [{
          accountId: 'legacy-telegram',
          serviceId: 'telegram' as const,
          displayName: 'Privat',
          enabled: true,
        }],
      }),
    )
    emitIpcMessage({ title: 'X', body: 'Y', tag: '', icon: '' })
    expect(Notification).not.toHaveBeenCalled()
  })

  it('rejects messages when the WebContents URL origin differs from the frame origin', () => {
    const { webContents, emitIpcMessage } = makeFakeWebContents('https://web.whatsapp.com', { getURL: () => 'https://web.telegram.org/' })
    installNotificationBridgeForWebContents(
      webContents,
      { accountId: 'legacy-whatsapp', serviceId: 'whatsapp', displayName: 'Arbeit' },
      makeBridgeOptions({
        getEnabledAccounts: () => [{
          accountId: 'legacy-whatsapp',
          serviceId: 'whatsapp' as const,
          displayName: 'Arbeit',
          enabled: true,
        }],
      }),
    )
    emitIpcMessage({ title: 'X', body: 'Y', tag: '', icon: '' })
    expect(Notification).not.toHaveBeenCalled()
  })

  it('rejects messages when the frame URL origin differs from the frame origin', () => {
    const { webContents, emitIpcMessage } = makeFakeWebContents('https://web.whatsapp.com', { frameUrl: 'https://web.telegram.org/frames/' })
    installNotificationBridgeForWebContents(
      webContents,
      { accountId: 'legacy-whatsapp', serviceId: 'whatsapp', displayName: 'Arbeit' },
      makeBridgeOptions({
        getEnabledAccounts: () => [{
          accountId: 'legacy-whatsapp',
          serviceId: 'whatsapp' as const,
          displayName: 'Arbeit',
          enabled: true,
        }],
      }),
    )
    emitIpcMessage({ title: 'X', body: 'Y', tag: '', icon: '' })
    expect(Notification).not.toHaveBeenCalled()
  })

  it('rejects malformed payloads', () => {
    const { webContents, emitIpcMessage } = makeFakeWebContents('https://web.whatsapp.com')
    installNotificationBridgeForWebContents(
      webContents,
      { accountId: 'legacy-whatsapp', serviceId: 'whatsapp', displayName: 'Arbeit' },
      makeBridgeOptions(),
    )
    emitIpcMessage({ body: 'only body' })
    emitIpcMessage(null)
    emitIpcMessage('string')
    expect(Notification).not.toHaveBeenCalled()
  })
})

describe('messenger preload main-world bridge', () => {
  function runBuiltPreload (skipMainWorldInstall = false): {
    sent: unknown[][]
    nativeCalls: number
    mainWorld: { Notification?: unknown; fmNotifyBridge?: unknown }
    isolatedWorld: { Notification?: unknown }
    originalNotification: () => void
  } {
    const sent: unknown[][] = []
    const nativeCalls = { count: 0 }
    const originalNotification = function (): void { nativeCalls.count++ }
    const mainWorld: { Notification?: unknown; fmNotifyBridge?: unknown } = { Notification: originalNotification }
    const isolatedWorld: { Notification?: unknown } = { Notification: originalNotification }
    const bridge = {
      exposeInMainWorld (key: string, api: unknown): void { mainWorld[key] = api },
      executeInMainWorld (script: { func: () => void }): void {
        if (skipMainWorldInstall) return
        // Simulate executing the function in a fresh main-world context, like
        // Electron's contextBridge.executeInMainWorld does.
        const ctx = { window: mainWorld, EventTarget, Event }
        vm.runInNewContext(`(${script.func.toString()})()`, ctx)
      },
    }
    const context = vm.createContext({
      globalThis: isolatedWorld,
      window: isolatedWorld,
      exports: {},
      require: (id: string) => {
        if (id === 'electron') {
          return {
            contextBridge: bridge,
            ipcRenderer: { send: (...args: unknown[]) => sent.push(args), on: vi.fn() },
          }
        }
        throw new Error(`Unknown require: ${id}`)
      },
    })
    const preloadPath = path.resolve('out/preload/messenger-preload.cjs')
    vm.runInContext(fs.readFileSync(preloadPath, 'utf8'), context)
    return { sent, nativeCalls, mainWorld, isolatedWorld, originalNotification }
  }

  it('routes main-world new Notification through the IPC bridge', () => {
    const { sent, nativeCalls, mainWorld, originalNotification } = runBuiltPreload()
    expect(mainWorld.Notification).not.toBe(originalNotification)
    const Ctor = mainWorld.Notification as new (title: string, options?: { body?: string }) => void
    new Ctor('Private sender', { body: 'Private message' })
    expect(sent.length).toBe(1)
    expect(sent[0]).toEqual([FM_NOTIFICATION_BRIDGE, {
      title: 'Private sender',
      body: 'Private message',
      tag: '',
      icon: '',
    }])
    expect(nativeCalls.count).toBe(0)
  })

  it('fails closed when the main-world installation is not performed', () => {
    const { sent, nativeCalls, mainWorld, originalNotification } = runBuiltPreload(true)
    expect(mainWorld.Notification).toBe(originalNotification)
    const Ctor = mainWorld.Notification as new (title: string, options?: { body?: string }) => void
    new Ctor('Private sender', { body: 'Private message' })
    expect(sent.length).toBe(0)
    expect(nativeCalls.count).toBe(1)
  })
})

export { FM_NOTIFICATION_BRIDGE }
