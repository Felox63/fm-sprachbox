import { WebContentsView, session, type Session, type WebContents } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAccountProfilePath } from './service-config.js'
import { type PortablePaths } from './portable-paths.js'
import { getServiceDefinition, type ServiceDefinition, getAllowedServiceOrigins } from '../shared/services.js'
import { type AccountDefinition } from '../shared/accounts.js'
import { isAllowedServiceNavigation } from './navigation-policy.js'
import { attachSafeLinkContextMenu, isTrustedSourceUrl } from './safe-links.js'
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
  isAccountActive?: () => boolean
}


function isServiceOrigin (service: ServiceDefinition, origin: string): boolean {
  if (!isTrustedSourceUrl(origin)) return false
  return getAllowedServiceOrigins(service).includes(new URL(origin).origin)
}

/**
 * Decide whether a permission request/check may be granted.
 *
 * Fail-closed rules:
 * - webContents must be the exact remote view we created for this service.
 * - The request must come from the service's own main-frame origin
 *   (requestingOrigin / top-level URL). Subframes or foreign origins are denied.
 * - Audio-only media is permitted for registered, enabled accounts. The OS and
 *   native getUserMedia lifecycle retain control; no capture interception.
 * - Camera, mixed audio/video and all other permissions remain denied.
 */
function makePermissionDecision (
  service: ServiceDefinition,
  ownWebContents: WebContents,
  webContents: WebContents | null,
  permission: string,
  requestingOrigin: string,
  isMainFrame: boolean | undefined,
  isAccountActive: () => boolean,
  audioOnly: boolean,
): boolean {
  try {
    if (permission !== 'media' || !audioOnly || isMainFrame !== true) return false
    if (webContents == null || webContents !== ownWebContents || webContents.isDestroyed()) return false
    if (!isAccountActive()) return false
    const frame = webContents.mainFrame
    if (frame == null || frame.detached || frame.parent != null) return false
    const urls = [requestingOrigin, webContents.getURL(), frame.url].map(value => new URL(value))
    if (urls.some(url => url.protocol !== 'https:' || url.username !== '' || url.password !== '' ||
      !isAllowedServiceNavigation(service, url.href))) return false
    return urls.every(url => url.origin === urls[0].origin)
  } catch {
    // Detached frames and disposed WebContents getters fail closed.
    return false
  }
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
    additionalArguments: service.id === 'telegram' ? ['--fm-telegram-links'] : [],
  }

  const view = new WebContentsView({ webPreferences })
  const ownWebContents = view.webContents
  const isAccountActive = options?.isAccountActive ?? (() => false)

  // Set permission handlers before any loadURL call so unknown requests are
  // denied by default (fail-closed). The handlers compare the requesting
  // origin/frame against the service's own origin and the exact WebContents
  // created above.
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = (details as Electron.MediaAccessPermissionRequest).mediaTypes
    const allow = makePermissionDecision(
      service,
      ownWebContents,
      webContents,
      permission,
      details.requestingUrl,
      details.isMainFrame,
      isAccountActive,
      Array.isArray(mediaTypes) && mediaTypes.length === 1 && mediaTypes[0] === 'audio',
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
      details.isMainFrame,
      isAccountActive,
      details.mediaType === 'audio',
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

  /**
   * Block off-origin top-level navigation and redirects unconditionally.
   * will-navigate / will-redirect can be triggered programmatically (remote JS,
   * meta refresh, OAuth redirects). Opening the system browser for these is not
   * safe; we only allow the service origin or about:blank.
   */
  const blockOffOriginNavigation = (_event: Electron.Event, url: string): void => {
    if (!isAllowedServiceNavigation(service, url)) {
      _event.preventDefault()
      console.warn(`[${service.id}] Blocked off-origin navigation`)
    }
  }

  ownWebContents.on('will-navigate', blockOffOriginNavigation)
  ownWebContents.on('will-redirect', blockOffOriginNavigation)

  /**
   * Block off-origin subframe navigation/redirects unconditionally. Subframes
   * never represent a user choosing to open an external link, and WhatsApp uses
   * frames such as webtp.whatsapp.net and flows.whatsapp.net internally.
   * Opening the system browser here is a routing bug.
   */
  ownWebContents.on('will-frame-navigate', (event) => {
    if (!isAllowedServiceNavigation(service, event.url)) {
      event.preventDefault()
      console.warn(`[${service.id}] Blocked off-origin frame navigation`)
    }
  })

  /**
   * setWindowOpenHandler is triggered for any new-window request including
   * target="_blank", window.open(), and form targets. Electron does not
   * guarantee a user gesture here, so we fail-closed: external browser opening is
   * denied by default. The handler only logs and denies; shell.openExternal is
   * never called. If a future UX design adds an explicit "open in browser" user
   * action, it must route through a trusted IPC from the shell, not through
   * this handler.
   */
  ownWebContents.setWindowOpenHandler((details) => {
    if (isAllowedServiceNavigation(service, details.url)) {
      console.warn(`[${service.id}] Blocked service popup`)
    } else {
      console.warn(`[${service.id}] Blocked popup (no trusted user action)`)
    }
    return { action: 'deny' }
  })

  /**
   * Trusted user action path for opening external links. Only a context-menu
   * invocation on the exact WebContents we created, followed by an explicit
   * "Im Browser öffnen" selection in a main-process menu, may open the system
   * browser. Service-origin links stay in-app; unsafe schemes/credentials are
   * rejected; overlapping opens are deduplicated.
   *
   * Telegram suppresses the main-process context-menu event by drawing its own
   * DOM context menu, so for Telegram we also enable a narrow click-bridge:
   * real (isTrusted) left-clicks on safe external http(s) links are forwarded
   * from the isolated preload to the main process, which validates identity/origin
   * again and shows a native confirmation dialog before opening the browser.
   */
  attachSafeLinkContextMenu(ownWebContents, {
    isServiceUrl: (url) => isAllowedServiceNavigation(service, url),
    isServiceOrigin: (origin) => isServiceOrigin(service, origin),
    enableClickBridge: service.id === 'telegram',
    isAccountActive: options?.isAccountActive ?? (() => false),
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
