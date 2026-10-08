import { Notification, type WebContents } from 'electron'
import { getAccountLabel, type AccountDefinition, type AccountRuntimeState } from '../shared/accounts.js'
import { type AppPreferences } from './service-config.js'

export const FM_NOTIFICATION_BRIDGE = 'fm-notification-bridge'

export interface NotificationAccountInfo {
  accountId: string
  serviceId: string
  displayName: string
}

export interface NotificationBridgeOptions {
  getPreferences: () => AppPreferences | undefined
  getEnabledAccounts: () => AccountDefinition[]
  getActiveAccountId: () => string | null
  onNotificationClicked: (accountId: string) => void
}

interface WebNotificationPayload {
  title: string
  body: string
  tag: string
  icon: string
}

const BRIDGE_INSTALLED = new WeakSet<WebContents>()

/**
 * Listen for bridged web notifications from a messenger WebContents.
 *
 * The preload script (src/preload/messenger-preload.ts) overrides the standard
 * window.Notification constructor inside the isolated web view and forwards
 * every service-created notification to the main process via the
 * FM_NOTIFICATION_BRIDGE IPC channel. This handler then shows exactly one native
 * toast per account.
 */
export function installNotificationBridgeForWebContents (
  webContents: WebContents,
  accountInfo: NotificationAccountInfo,
  options: NotificationBridgeOptions,
): void {
  if (BRIDGE_INSTALLED.has(webContents)) return
  BRIDGE_INSTALLED.add(webContents)

  webContents.on('ipc-message', (_event, channel, payload: unknown) => {
    if (channel !== FM_NOTIFICATION_BRIDGE) return
    const data = payload as WebNotificationPayload | undefined
    if (data == null) return
    handleWebNotification(accountInfo, data, options)
  })
}

/**
 * Handle a bridged web notification from a messenger WebContentsView.
 *
 * Design decisions:
 * - No broad DOM scraping. The only data we read are the title/body the service
 *   itself passed to the Notification constructor.
 * - No invented unread counts. WhatsApp Web and Telegram Web K do not expose a
 *   reliable, cross-origin unread counter via the Notifications API. We show a
 *   simple "Neue Nachricht" indicator when content hiding is enabled.
 * - Account identity is always taken from the main-process account record, never
 *   from the notification payload.
 * - Disabled/removed accounts are ignored, and the currently visible account does
 *   not trigger toasts.
 * - Native web notifications are suppressed because the preload never calls the
 *   real Notification constructor with visible options.
 */
export function handleWebNotification (
  accountInfo: NotificationAccountInfo,
  payload: WebNotificationPayload,
  options: NotificationBridgeOptions,
): void {
  const preferences = options.getPreferences() ?? {
    minimizeToTray: false,
    notificationsEnabled: true,
    notificationHideContent: true,
  }
  if (!preferences.notificationsEnabled) return

  const enabledAccounts = options.getEnabledAccounts()
  const account = enabledAccounts.find((a) => a.accountId === accountInfo.accountId)
  if (account == null || !account.enabled) {
    // Account was removed or disabled since the bridge was installed.
    return
  }

  // Do not show a native toast if the account is currently visible.
  if (options.getActiveAccountId() === accountInfo.accountId) return

  const runtimeState: AccountRuntimeState = {
    accountId: account.accountId,
    serviceId: account.serviceId,
    serviceLabel: account.serviceId === 'whatsapp' ? 'WhatsApp' : 'Telegram',
    displayName: account.displayName,
    enabled: account.enabled,
    icon: '',
  }
  const accountName = getAccountLabel(runtimeState)

  // WhatsApp Web typically sends the chat name as title and message snippet as
  // body. Telegram Web K sends the sender/chat as title and text as body.
  // We intentionally do not parse counts: the services do not provide a reliable
  // cross-origin unread count in the Notification constructor.
  const title = payload.title.length > 0 ? `${accountName} · ${payload.title}` : accountName
  const body = preferences.notificationHideContent
    ? 'Neue Nachricht'
    : payload.body.slice(0, 240)

  const notification = new Notification({
    title,
    body,
    // tag deduplicates toasts for the same account; we ignore the service tag
    // because multiple accounts could share the same service tag.
    tag: `fm-sprachbox-${accountInfo.accountId}`,
    silent: false,
  } as Electron.NotificationConstructorOptions)

  notification.on('click', () => {
    options.onNotificationClicked(accountInfo.accountId)
  })

  notification.show()
}
