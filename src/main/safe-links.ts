import { shell, Menu, dialog, WebContents, ContextMenuParams, WebFrameMain, BrowserWindow } from 'electron'

/**
 * Maximum URL length we will accept for an external open. This is far above any
 * legitimate link but below the range where payloads become a concern.
 */
const MAX_EXTERNAL_URL_LENGTH = 4096

/**
 * IPC channel used by the preload safe-link click bridge. The payload is bounded
 * and typed; the main process validates everything before showing a dialog.
 */
const FM_SAFE_LINK_BRIDGE = 'fm-safe-link-bridge'

/**
 * Fail-closed validation for a source URL that we will trust as an origin
 * indicator. Used for pageURL, frame.url and getURL() before we compare origins.
 *
 * Rules:
 * - Input must be a non-empty string and must not exceed MAX_EXTERNAL_URL_LENGTH.
 * - Only http: and https: protocols.
 * - No embedded credentials (userinfo).
 * - Non-empty hostname.
 */
function isTrustedSourceUrl (url: unknown): url is string {
  if (typeof url !== 'string') return false
  if (url.length === 0 || url.length > MAX_EXTERNAL_URL_LENGTH) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  if (parsed.username.length > 0 || parsed.password.length > 0) return false
  if (parsed.hostname.length === 0) return false
  return true
}

/**
 * Fail-closed validation for URLs that may be opened in the system browser.
 *
 * Rules:
 * - Input must be a string and must not exceed MAX_EXTERNAL_URL_LENGTH.
 * - Only http: and https: protocols.
 * - No embedded credentials (userinfo).
 * - Non-empty hostname.
 * - No file:/javascript:/data:/mailto:/custom schemes.
 */
export function isSafeExternalUrl (url: unknown): boolean {
  return isTrustedSourceUrl(url)
}

/**
 * Open a validated external URL in the system browser.
 *
 * - Never logs the raw URL (may contain tokens/queries).
 * - Catches shell.openExternal rejection and logs a fixed warning only.
 * - Returns a boolean indicating whether the open was attempted.
 */
export async function openTrustedExternalLink (url: string): Promise<boolean> {
  if (!isSafeExternalUrl(url)) return false
  try {
    await shell.openExternal(url)
    return true
  } catch {
    console.warn('Failed to open external link')
    return false
  }
}

/**
 * Known auto-loaded WhatsApp subframe origins. These are off-origin for the
 * messenger service but are loaded programmatically by WhatsApp Web; they must
 * never produce a context menu or external browser open.
 */
const AUTOLOADED_WHATSAPP_ORIGINS: readonly string[] = [
  'https://webtp.whatsapp.net',
  'https://flows.whatsapp.net',
]

function isAutoloadedWhatsAppUrl (url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return AUTOLOADED_WHATSAPP_ORIGINS.some((origin) => parsed.origin === origin)
}

/**
 * Track which URLs are already being opened per WebContents so overlapping
 * events (e.g. a context-menu click that also triggers a navigation) cannot
 * open the same target more than once.
 */
const PENDING_EXTERNAL_OPENS = new WeakMap<WebContents, Set<string>>()

function getPendingSet (wc: WebContents): Set<string> {
  let set = PENDING_EXTERNAL_OPENS.get(wc)
  if (set == null) {
    set = new Set()
    PENDING_EXTERNAL_OPENS.set(wc, set)
  }
  return set
}

function markPending (wc: WebContents, url: string): boolean {
  const set = getPendingSet(wc)
  if (set.has(url)) return false
  set.add(url)
  return true
}

function clearPending (wc: WebContents, url: string): void {
  getPendingSet(wc).delete(url)
}

function isDestroyed (wc: WebContents): boolean {
  // Electron's isDestroyed() exists on WebContents but TypeScript may narrow
  // it differently depending on the imported type shape. Access it safely.
  return typeof (wc as { isDestroyed?: () => boolean }).isDestroyed === 'function'
    && (wc as { isDestroyed: () => boolean }).isDestroyed()
}

interface SafeLinkPayload {
  url: string
  title?: string
}

function isValidSafeLinkPayload (payload: unknown): payload is SafeLinkPayload {
  if (payload == null || typeof payload !== 'object') return false
  const obj = payload as Record<string, unknown>
  if (typeof obj.url !== 'string') return false
  if (obj.url.length === 0 || obj.url.length > MAX_EXTERNAL_URL_LENGTH) return false
  if (obj.title != null && typeof obj.title !== 'string') return false
  if (obj.title != null && obj.title.length > 240) return false
  return true
}

/**
 * Show a native confirmation dialog and, only if the user explicitly confirms,
 * open the validated URL in the system browser.
 *
 * The dialog never displays the raw full URL (may contain tokens/queries);
 * it only shows the hostname so the user knows which site they are about to
 * visit. Returns true if the browser was opened.
 */
async function confirmAndOpenExternalLink (
  browserWindow: BrowserWindow | null,
  url: string,
  isAuthorized: () => boolean,
): Promise<boolean> {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return false
  }

  const result = await dialog.showMessageBox(browserWindow ?? undefined as unknown as BrowserWindow, {
    type: 'question',
    buttons: ['Im Browser öffnen', 'Abbrechen'],
    defaultId: 1,
    cancelId: 1,
    title: 'Externen Link öffnen',
    message: `Diesen Link bei ${hostname} im Browser öffnen?`,
    detail: 'Nur bestätigen, wenn du den Link bewusst angeklickt hast.',
  })

  if (result.response !== 0 || !isAuthorized()) return false
  return await openTrustedExternalLink(url)
}

/**
 * Verify that the context menu was invoked from the main frame of the exact
 * WebContents we created, while that WebContents is still alive and on the
 * service origin. Fail-closed on any missing or stale frame information.
 *
 * All frame/WebContents property access is wrapped defensively: a disposed or
 * stale frame must never throw through to the caller.
 */
function isTrustedMainFrameContext (
  ownWebContents: WebContents,
  service: { isServiceOrigin: (origin: string) => boolean },
  frame: WebFrameMain | null,
  pageURL: string,
): boolean {
  try {
    // Guard liveness before any frame/WebContents property access.
    if (isDestroyed(ownWebContents)) return false

    if (frame == null) return false

    // The live frame must be the exact main frame of the exact WebContents we
    // created and must have no parent.
    if (frame.detached || frame.parent != null) return false
    if (frame !== ownWebContents.mainFrame) return false

    // The live frame URL must be a valid http(s) source URL without credentials
    // and must be on the service origin. Do not trust the event's frameURL/pageURL
    // as the only source of truth.
    const liveFrameUrl = (frame as { url?: string }).url
    if (!isTrustedSourceUrl(liveFrameUrl)) return false
    if (!service.isServiceOrigin(liveFrameUrl)) return false

    // Validate both the claimed page URL and the live top-level URL.
    if (!isTrustedSourceUrl(pageURL)) return false
    if (!service.isServiceOrigin(pageURL)) return false

    const topLevelUrl = ownWebContents.getURL()
    if (!isTrustedSourceUrl(topLevelUrl)) return false
    if (!service.isServiceOrigin(topLevelUrl)) return false

    return true
  } catch {
    // Any stale/disposed frame property or unexpected access must fail closed.
    return false
  }
}

/**
 * Attach a trusted context-menu action to a messenger WebContents.
 *
 * This and the private Telegram click path below may call shell.openExternal.
 * It is triggered by an explicit user gesture (right-click / long-press) on a
 * link, and only after the user selects "Im Browser öffnen" from a menu owned by
 * the main process. Automatic navigations, frames, redirects and window.open are
 * still blocked by the existing fail-closed guards.
 *
 * Safety checks:
 * - The WebContents must be the exact view we created (identity check).
 * - The context-menu event must originate from the current main frame on the
 *   service origin; subframes and stale/destroyed views are rejected.
 * - linkURL must be a safe http/https URL without credentials and within the
 *   length limit.
 * - The link must not belong to the service's own origin (those stay in-app).
 * - Known WhatsApp auto-frame origins never produce a menu.
 * - Only one external open per URL at a time, and the WebContents is re-checked
 *   at the moment the user clicks the menu item.
 */
export function attachSafeLinkContextMenu (
  ownWebContents: WebContents,
  options: {
    isServiceUrl: (url: string) => boolean
    isServiceOrigin?: (origin: string) => boolean
    label?: string
    /**
     * Optional owner window used to parent the confirmation dialog when the
     * context-menu path is unavailable (e.g. Telegram prevents it). If omitted,
     * the dialog opens without a parent window.
     */
    parentWindow?: BrowserWindow | null
    /**
     * When true, the fallback click-bridge dialog path is also registered.
     * Telegram suppresses the native context-menu event, so the click bridge is
     * required there. WhatsApp keeps the native context-menu path enabled by
     * default and only enables the bridge if explicitly requested.
     */
    enableClickBridge?: boolean
    isAccountActive?: () => boolean
  },
): void {
  const isServiceOrigin = options.isServiceOrigin ?? options.isServiceUrl
  const serviceCheck = { isServiceOrigin }

  ownWebContents.on('context-menu', (event, params: ContextMenuParams) => {
    const url = params.linkURL
    if (!isSafeExternalUrl(url)) return
    if (isAutoloadedWhatsAppUrl(url)) return
    if (options.isServiceUrl(url)) return
    if (!isTrustedMainFrameContext(ownWebContents, serviceCheck, params.frame, params.pageURL)) return

    event.preventDefault()

    const menu = Menu.buildFromTemplate([
      {
        label: options.label ?? 'Im Browser öffnen',
        click: async () => {
          // Re-check identity, liveness and origin at the moment of the click.
          if (isDestroyed(ownWebContents)) return
          if (!isTrustedMainFrameContext(ownWebContents, serviceCheck, params.frame, params.pageURL)) return
          if (!isSafeExternalUrl(url)) return
          if (options.isServiceUrl(url)) return
          if (isAutoloadedWhatsAppUrl(url)) return
          if (!markPending(ownWebContents, url)) return
          try {
            await openTrustedExternalLink(url)
          } finally {
            // Keep the guard long enough to suppress immediate duplicates, then
            // release it. Using setTimeout(..., 0) lets the current event loop
            // finish before clearing.
            setTimeout(() => { clearPending(ownWebContents, url) }, 0)
          }
        },
      },
      { type: 'separator' },
      { label: 'Abbrechen', click: () => { /* no-op */ } },
    ])

    menu.popup({ window: undefined })
  })

  // Fallback path for services such as Telegram that suppress the native
  // context-menu event by calling preventDefault() on the DOM contextmenu event.
  // The bridge only forwards real (isTrusted) left-clicks on safe http(s) links
  // from the main frame, and the main process still validates everything and
  // shows a native confirmation dialog before opening the browser.
  if (options.enableClickBridge === true) {
    let dialogPending = false
    let navigationGeneration = 0
    ownWebContents.on('did-start-navigation', (event) => {
      if (event.isMainFrame) navigationGeneration++
    })
    ownWebContents.on('ipc-message', (event, channel, ...args) => {
      if (channel !== FM_SAFE_LINK_BRIDGE) return
      if (dialogPending) return
      const payload = args[0]
      if (!isValidSafeLinkPayload(payload)) return
      const url = payload.url
      if (!isSafeExternalUrl(url)) return
      if (isAutoloadedWhatsAppUrl(url)) return
      if (options.isServiceUrl(url)) return
      let frame: WebFrameMain | null
      const generation = navigationGeneration
      let pageURL: string
      try {
        if (isDestroyed(ownWebContents)) return
        if (event.sender !== ownWebContents) return
        frame = event.senderFrame
        pageURL = ownWebContents.getURL()
      } catch { return }
      const isAuthorized = (): boolean => {
        try {
          return !isDestroyed(ownWebContents)
            && options.parentWindow?.isDestroyed() !== true
            && generation === navigationGeneration
            && event.sender === ownWebContents
            && options.isAccountActive?.() === true
            && ownWebContents.getURL() === pageURL
            && isTrustedMainFrameContext(ownWebContents, serviceCheck, frame, pageURL)
        } catch { return false }
      }
      if (!isAuthorized()) return
      if (!markPending(ownWebContents, url)) return
      dialogPending = true
      void (async () => {
        try {
          const browserWindow = options.parentWindow ?? BrowserWindow.fromWebContents(ownWebContents)
          await confirmAndOpenExternalLink(browserWindow, url, isAuthorized)
        } catch {
          console.warn('Failed to confirm external link')
        }
      })()
        .finally(() => {
          setTimeout(() => {
            clearPending(ownWebContents, url)
            dialogPending = false
          }, 0)
        })
    })
  }
}

export { isTrustedSourceUrl }
