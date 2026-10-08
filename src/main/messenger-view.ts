import { WebContentsView, session, shell, type Session, type WebContents } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAccountProfilePath } from './service-config.js'
import { type PortablePaths } from './portable-paths.js'
import { getServiceDefinition, type ServiceDefinition } from '../shared/services.js'
import { type AccountDefinition } from '../shared/accounts.js'
import { isAllowedServiceNavigation, isSafeExternalUrl } from './navigation-policy.js'
import { buildServiceUserAgent, type UserAgentSource } from './user-agent.js'
import { installNotificationBridgeForWebContents, type NotificationBridgeOptions } from './notifications.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MESSENGER_PRELOAD_PATH = path.join(__dirname, '..', 'preload', 'messenger-preload.cjs')

export interface MessengerView {
  accountId: string
  service: ServiceDefinition
  view: WebContentsView
  session: Session
  /** The WebContents that belongs to this remote view. Used for identity checks. */
  webContents: WebContents
}

export interface CreateMessengerViewOptions {
  userAgentSource?: UserAgentSource
  notificationBridge?: NotificationBridgeOptions
}

/**
 * Permissions that a messenger service may legitimately request for normal
 * operation. All other permissions are denied by default (fail-closed).
 *
 * Currently no permission is granted automatically. A future, explicit
 * user-consent flow (bound to origin, frame and the exact WebContents) may
 * allow service-typical permissions such as `media` (voice messages) or
 * `clipboard-sanitized-write` (pasting into chats). Until then every request,
 * including `display-capture`, is denied.
 */
const ALLOWED_PERMISSIONS: readonly string[] = []

function isAllowedPermission (permission: string): boolean {
  return ALLOWED_PERMISSIONS.includes(permission)
}

function isServiceOrigin (service: ServiceDefinition, origin: string): boolean {
  if (origin == null) return false
  try {
    return new URL(origin).origin === new URL(service.url).origin
  } catch {
    return false
  }
}

/**
 * Decide whether a permission request/check may be granted.
 *
 * Fail-closed rules:
 * - webContents must be the exact remote view we created for this service.
 * - The request must come from the service's own main-frame origin
 *   (requestingOrigin / top-level URL). Subframes or foreign origins are denied.
 * - No permission is granted automatically. A future explicit user-consent flow
 *   may allow a short allowlist of service-typical permissions.
 */
function makePermissionDecision (
  service: ServiceDefinition,
  ownWebContents: WebContents,
  webContents: WebContents | null,
  permission: string,
  requestingOrigin: string,
  isCheck: boolean,
  isMainFrame?: boolean,
): boolean {
  if (!isAllowedPermission(permission)) return false
  if (webContents == null || webContents !== ownWebContents) return false
  // Only the top-level main frame of the exact remote view we created may ask
  // for a permission. Missing frame information is treated as "not main frame"
  // and denied.
  if (isMainFrame !== true) return false
  if (!isServiceOrigin(service, requestingOrigin)) return false
  return true
}

export function createMessengerView (
  account: AccountDefinition,
  paths: PortablePaths,
  options?: CreateMessengerViewOptions,
): MessengerView {
  const { accountId, serviceId } = account
  const service = getServiceDefinition(serviceId)

  const profileDir = getAccountProfilePath(accountId, paths)
  // session.fromPath stores all cookies/storage/cache under the given absolute
  // directory, making the profile fully portable. Available since Electron 30+.
  const ses = session.fromPath(profileDir, { cache: true })

  const webPreferences = {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    enableWebSQL: false,
    session: ses,
    preload: MESSENGER_PRELOAD_PATH,
  }

  const view = new WebContentsView({ webPreferences })
  const ownWebContents = view.webContents

  // Set permission handlers before any loadURL call so unknown requests are
  // denied by default (fail-closed). The handlers compare the requesting
  // origin/frame against the service's own origin and the exact WebContents
  // created above.
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    let requestingOrigin = ''
    try {
      requestingOrigin = new URL(details.requestingUrl).origin
    } catch {
      // If we cannot parse the request origin, deny.
      callback(false)
      return
    }
    const allow = makePermissionDecision(
      service,
      ownWebContents,
      webContents,
      permission,
      requestingOrigin,
      false,
      details.isMainFrame,
    )
    callback(allow)
  })
  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    return makePermissionDecision(
      service,
      ownWebContents,
      webContents,
      permission,
      requestingOrigin,
      true,
      details.isMainFrame,
    )
  })

  const userAgent = buildServiceUserAgent(service, options?.userAgentSource)
  if (userAgent != null) {
    // Set the UA both on the isolated session and on the WebContents itself.
    // WhatsApp's server-side gate inspects the effective UA of the request;
    // keeping session and WebContents consistent avoids any race where the view
    // loads with the default Electron UA before the session override takes effect.
    ses.setUserAgent(userAgent)
    ownWebContents.setUserAgent(userAgent)
  }

  const guard = (_event: Electron.Event, url: string): void => {
    if (!isAllowedServiceNavigation(service, url)) {
      _event.preventDefault()
      if (isSafeExternalUrl(url)) {
        void shell.openExternal(url)
      } else {
        console.warn(`[${service.id}] Blocked off-origin navigation`)
      }
    }
  }

  ownWebContents.on('will-navigate', guard)
  ownWebContents.on('will-redirect', guard)
  ownWebContents.on('will-frame-navigate', (event) => {
    if (!isAllowedServiceNavigation(service, event.url)) {
      event.preventDefault()
      if (isSafeExternalUrl(event.url)) {
        void shell.openExternal(event.url)
      } else {
        console.warn(`[${service.id}] Blocked off-origin frame navigation`)
      }
    }
  })
  ownWebContents.setWindowOpenHandler((details) => {
    if (isSafeExternalUrl(details.url)) {
      void shell.openExternal(details.url)
    } else if (isAllowedServiceNavigation(service, details.url)) {
      // Service URLs should navigate inside the existing view, not open a popup.
      console.warn(`[${service.id}] Blocked service popup`)
    } else {
      console.warn(`[${service.id}] Blocked unsafe popup`)
    }
    return { action: 'deny' }
  })

  const accountInfo = { accountId, serviceId: service.id, displayName: account.displayName }
  if (options?.notificationBridge != null) {
    installNotificationBridgeForWebContents(ownWebContents, accountInfo, options.notificationBridge)
  }

  return { accountId, service, view, session: ses, webContents: ownWebContents }
}

export function destroyMessengerView (messenger: MessengerView): void {
  try {
    messenger.view.webContents.close()
  } catch (err) {
    console.warn('Error closing messenger view:', err)
  }
}
