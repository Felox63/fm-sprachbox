import { Notification, type WebContents, type WebFrameMain } from 'electron'
import { getAccountLabel, type AccountDefinition, type AccountRuntimeState, toAccountRuntimeState } from '../shared/accounts.js'
import { getServiceDefinition, type ServiceId } from '../shared/services.js'
import { type AppPreferences } from './service-config.js'

export const FM_NOTIFICATION_BRIDGE = 'fm-notification-bridge'
export const MAX_TITLE_LENGTH = 120
export const MAX_BODY_LENGTH = 240
export const MAX_TAG_LENGTH = 128
export const MAX_ICON_LENGTH = 4096

export interface NotificationAccountInfo {
  accountId: string
  serviceId: ServiceId
  displayName: string
}

export interface NotificationBridgeOptions {
  getPreferences: () => AppPreferences | undefined
  getEnabledAccounts: () => AccountDefinition[]
  getActiveAccountId: () => string | null
  /** Returns true only when the account is the active one and its window is visible/focused and not behind an overlay. */
  isAccountWindowVisible: (accountId: string) => boolean
  onNotificationClicked: (accountId: string) => void
  /** Called whenever a bridged notification creates a new-message indicator for an account. */
  onNotificationIndicator: (accountId: string) => void
}

interface WebNotificationPayload {
  title: string
  body: string
  tag: string
  icon: string
}

const BRIDGE_INSTALLED = new WeakSet<WebContents>()

function getUrlOrigin (url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * Verify that the supplied origin belongs to the account's configured service.
 * Fail-closed: the service definition URL is the single source of truth.
 */
function isAccountServiceOrigin (serviceId: ServiceId, origin: string): boolean {
  try {
    const serviceOrigin = getUrlOrigin(getServiceDefinition(serviceId).url)
    return serviceOrigin != null && serviceOrigin === origin
  } catch {
    return false
  }
}

/**
 * Validate and sanitize a bridged notification payload.
 * Fail-closed: non-string fields are rejected. Strings are bounded before any
 * downstream use and are never logged.
 */
function validatePayload (raw: unknown): WebNotificationPayload | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.title !== 'string') return null
  if (typeof obj.body !== 'string') return null
  if (typeof obj.tag !== 'string') return null
  if (typeof obj.icon !== 'string') return null
  return {
    title: obj.title.slice(0, MAX_TITLE_LENGTH),
    body: obj.body.slice(0, MAX_BODY_LENGTH),
    tag: obj.tag.slice(0, MAX_TAG_LENGTH),
    icon: obj.icon.slice(0, MAX_ICON_LENGTH),
  }
}

/**
 * Verify that the IPC message came from the exact WebContents' main frame and
 * an origin that belongs to the account's own service. Disposed/stale frames must
 * not throw and must fail closed. We check the frame origin, the frame URL
 * origin and the WebContents current URL origin independently so a spoofed
 * origin cannot bypass the check.
 */
function isTrustedBridgeSender (
  webContents: WebContents,
  sender: WebContents,
  senderFrame: WebFrameMain | null | undefined,
  accountInfo: NotificationAccountInfo,
): boolean {
  try {
    if (sender !== webContents || webContents.isDestroyed()) return false
    if (senderFrame == null || senderFrame.isDestroyed()) return false
    if (senderFrame.parent != null) return false
    if (senderFrame !== webContents.mainFrame) return false

    const frameOrigin = senderFrame.origin
    if (frameOrigin == null || typeof frameOrigin !== 'string') return false
    if (!isAccountServiceOrigin(accountInfo.serviceId, frameOrigin)) return false

    const frameUrlOrigin = getUrlOrigin(senderFrame.url)
    if (frameUrlOrigin !== frameOrigin) return false

    const wcUrlOrigin = getUrlOrigin(webContents.getURL())
    if (wcUrlOrigin !== frameOrigin) return false

    return true
  } catch {
    return false
  }
}

/**
 * Listen for bridged web notifications from a messenger WebContents.
 *
 * The preload script (src/preload/messenger-preload.ts) installs a fail-closed
 * stub in the main world via contextBridge.executeInMainWorld. That stub forwards
 * every service-created notification to the main process via the
 * FM_NOTIFICATION_BRIDGE IPC channel. This handler then shows exactly one native
 * toast per account after verifying the sender.
 */
export function installNotificationBridgeForWebContents (
  webContents: WebContents,
  accountInfo: NotificationAccountInfo,
  options: NotificationBridgeOptions,
): void {
  if (BRIDGE_INSTALLED.has(webContents)) return
  BRIDGE_INSTALLED.add(webContents)

  webContents.on('ipc-message', (event, channel, payload: unknown) => {
    if (channel !== FM_NOTIFICATION_BRIDGE) return
    if (!isTrustedBridgeSender(webContents, event.sender, event.senderFrame, accountInfo)) return
    const data = validatePayload(payload)
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
 * - Disabled/removed accounts are ignored, and the currently visible account
 *   does not trigger toasts.
 * - Native web notifications are suppressed because the preload stub never
 *   calls the real Notification constructor with visible options.
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

  const enabledAccounts = options.getEnabledAccounts()
  const account = enabledAccounts.find((a) => a.accountId === accountInfo.accountId)
  if (account == null || !account.enabled) {
    // Account was removed or disabled since the bridge was installed.
    return
  }

  // Suppress toasts and badges only when the account is enabled AND its window
  // is actually visible and focused. A hidden tray window, a minimized window,
  // or a window showing a loading/error overlay must not suppress notifications.
  if (options.isAccountWindowVisible(accountInfo.accountId)) return

  const runtimeState: AccountRuntimeState = toAccountRuntimeState(account)

  // Show a native toast only when notifications are enabled. Even when toasts
  // are disabled, we still raise a new-message indicator (badge) for every
  // enabled, activatable account that receives a verified bridge signal. The
  // indicator carries no sender/content data and is cleared when the user
  // consciously opens the account.
  if (preferences.notificationsEnabled) {
    showNotification(accountInfo, runtimeState, preferences.notificationHideContent, payload, options)
  }

  options.onNotificationIndicator(accountInfo.accountId)
}

function showNotification (
  accountInfo: NotificationAccountInfo,
  runtimeState: AccountRuntimeState,
  hideContent: boolean,
  payload: WebNotificationPayload,
  options: NotificationBridgeOptions,
): void {
  // The title is always the trusted account identity taken from the main-process
  // config. It never contains sender, chat or payload.title data, even when
  // content hiding is disabled.
  const accountName = getAccountLabel(runtimeState)
  const title = accountName.slice(0, MAX_TITLE_LENGTH)
  const body = hideContent
    ? 'Neue Nachricht'
    : payload.body.slice(0, MAX_BODY_LENGTH)

  const notification = new Notification({
    title,
    body,
    // tag deduplicates toasts for the same account; we ignore the service tag
    // because multiple accounts could share the same service tag.
    tag: `fm-sprachbox-${accountInfo.accountId}`,
    silent: false,
  } as Electron.NotificationConstructorOptions)

  notification.on('click', () => {
    // Re-check the account still exists and is enabled at click time. If it was
    // removed or disabled after the toast was shown, ignore the click.
    // We call onNotificationClicked because it raises the window and selects the
    // account, which implicitly clears any in-memory badge in the runtime.
    const currentAccounts = options.getEnabledAccounts()
    if (!currentAccounts.some((a) => a.accountId === accountInfo.accountId && a.enabled)) return
    options.onNotificationClicked(accountInfo.accountId)
  })

  notification.show()
}
