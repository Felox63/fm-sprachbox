import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
  FM_NOTIFICATION_BRIDGE,
  type NotificationBridgeOptions,
} from '../../src/main/notifications.js'
import { type PortablePaths } from '../../src/main/portable-paths.js'
import path from 'node:path'
import fs from 'node:fs'
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

describe('handleWebNotification', () => {
  function makeOptions (overrides?: Partial<NotificationBridgeOptions>): NotificationBridgeOptions {
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
      onNotificationClicked: vi.fn(),
      ...overrides,
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows a privacy toast for a bridged notification', () => {
    const options = makeOptions()
    handleWebNotification(
      { accountId: 'legacy-telegram', serviceId: 'telegram', displayName: 'Privat' },
      { title: 'Max Mustermann', body: 'Hallo!', tag: 'abc', icon: '' },
      options,
    )
    expect(Notification).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Telegram – Privat · Max Mustermann',
      body: 'Neue Nachricht',
      tag: 'fm-sprachbox-legacy-telegram',
    }))
  })

  it('suppresses notifications when disabled', () => {
    const options = makeOptions({
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
    const options = makeOptions({
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

  it('ignores notifications for the currently visible account', () => {
    const options = makeOptions({ getActiveAccountId: () => 'legacy-telegram' })
    handleWebNotification(
      { accountId: 'legacy-telegram', serviceId: 'telegram', displayName: 'Privat' },
      { title: 'Max', body: 'Hallo', tag: '', icon: '' },
      options,
    )
    expect(Notification).not.toHaveBeenCalled()
  })
})

export { FM_NOTIFICATION_BRIDGE }
