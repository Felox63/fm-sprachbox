import { contextBridge, ipcRenderer } from 'electron'

const FM_NOTIFICATION_BRIDGE = 'fm-notification-bridge'
const FM_SAFE_LINK_BRIDGE = 'fm-safe-link-bridge'
const FM_FOCUS_DIAGNOSTIC_EVENT = 'fm-focus-diagnostic-event'
const FM_FOCUS_DIAGNOSTIC_CONTROL = 'fm-focus-diagnostic-control'

const MAX_LINK_URL_LENGTH = 4096
const MAX_LINK_TITLE_LENGTH = 240

// Hard limits applied before the payload ever enters the IPC transport.
const MAX_TITLE_LENGTH = 120
const MAX_BODY_LENGTH = 240
const MAX_TAG_LENGTH = 128
const MAX_ICON_LENGTH = 4096

interface FmNotificationPayload {
  title: string
  body: string
  tag: string
  icon: string
}

interface FmNotifyBridge {
  send: (title: string, options?: { body?: string; tag?: string; icon?: string }) => void
}

function makePayload (title: string, options?: { body?: string; tag?: string; icon?: string }): FmNotificationPayload {
  return {
    title: String(title ?? '').slice(0, MAX_TITLE_LENGTH),
    body: options?.body != null ? String(options.body).slice(0, MAX_BODY_LENGTH) : '',
    tag: options?.tag != null ? String(options.tag).slice(0, MAX_TAG_LENGTH) : '',
    icon: options?.icon != null ? String(options.icon).slice(0, MAX_ICON_LENGTH) : '',
  }
}

function sendNotification (title: string, options?: { body?: string; tag?: string; icon?: string }): void {
  const payload = makePayload(title, options)
  // ipcRenderer.send routes to the main process and works in a context-isolated
  // WebContentsView preload. sendToHost is only for <webview> guests and would not
  // reach the main process here.
  ipcRenderer.send(FM_NOTIFICATION_BRIDGE, payload)
}

// Expose the single, narrow bridge entry point to the main world. No Node APIs,
// no generic IPC access, and no private data are exposed.
contextBridge.exposeInMainWorld('fmNotifyBridge', {
  send: sendNotification,
})

/**
 * Install the fail-closed Notification stub in the main world.
 *
 * Document main-world calls to new Notification(title, options) are intercepted.
 * Which paths live WhatsApp/Telegram builds use is not established by this
 * bridge or its synthetic fixtures. With contextIsolation=true and
 * sandbox=true the isolated preload cannot simply overwrite main-world
 * window.Notification; instead we use contextBridge.executeInMainWorld to inject
 * a tiny stub that forwards the call to the exposed bridge function. The stub
 * never calls the original Notification constructor, so no native web toast is
 * shown by the renderer. The main process then shows exactly one native toast
 * per account after verifying the sender identity and account-specific origin.
 *
 * contextBridge.executeInMainWorld is marked experimental in Electron 44; see
 * https://www.electronjs.org/docs/latest/api/context-bridge.
 */
function installMainWorldNotification (): void {
  const w = (globalThis as unknown as { window: { Notification: unknown; fmNotifyBridge?: FmNotifyBridge } }).window
  const bridge = w.fmNotifyBridge
  if (bridge == null || typeof bridge.send !== 'function') {
    // Installation failure fallback, NOT proof of native suppression: the
    // original remains untouched if the narrow bridge is unavailable.
    return
  }
  // Narrow bridge after the guard above.
  const send = bridge.send

  // EventTarget is the main-world DOM implementation, not the native
  // Notification constructor. No reference to that constructor is retained.
  class FmNotification extends EventTarget {
    static permission: string = 'granted'
    static requestPermission = (): Promise<string> => Promise.resolve('granted')
    #closed = false
    onclick: ((event: Event) => unknown) | null = null
    onclose: ((event: Event) => unknown) | null = null
    onerror: ((event: Event) => unknown) | null = null
    onshow: ((event: Event) => unknown) | null = null
    readonly title: string
    readonly body: string
    readonly tag: string
    readonly icon: string

    constructor (title: string, options?: { body?: string; tag?: string; icon?: string }) {
      super()
      this.title = String(title ?? '')
      this.body = String(options?.body ?? '')
      this.tag = String(options?.tag ?? '')
      this.icon = String(options?.icon ?? '')
      // Do not invoke the real Notification constructor; the main process shows
      // the native toast. We only keep a lightweight stub so callers can call
      // .close() without throwing.
      send(title, {
        body: options?.body,
        tag: options?.tag,
        icon: options?.icon,
      })
    }

    override dispatchEvent (event: Event): boolean {
      const accepted = super.dispatchEvent(event)
      const handler = event.type === 'click' ? this.onclick
        : event.type === 'close' ? this.onclose
          : event.type === 'error' ? this.onerror
            : event.type === 'show' ? this.onshow : null
      if (typeof handler === 'function') handler.call(this, event)
      return accepted
    }

    close (): void {
      // Local lifecycle only: no renderer instance/native-toast ID mapping.
      if (this.#closed) return
      this.#closed = true
      this.dispatchEvent(new Event('close'))
    }
  }

  w.Notification = FmNotification
  Object.defineProperty(FmNotification, 'name', { value: 'FmNotification' })
}

contextBridge.executeInMainWorld({ func: installMainWorldNotification })

// ---------------------------------------------------------------------------
// Safe link click bridge
//
// Telegram suppresses the native context-menu event in the main process by
// calling preventDefault() on the DOM contextmenu event, so the Electron
// context-menu handler never fires. We therefore install a private isolated-world
// click listener that only forwards *real* (isTrusted) link clicks on safe
// http(s) URLs. The main process still performs all validation, shows a
// native confirmation dialog, and only then calls shell.openExternal. No
// automatic navigation or window.open path is ever allowed to open a browser.
// ---------------------------------------------------------------------------

interface FmSafeLinkPayload {
  url: string
  title: string
}

function makeSafeLinkPayload (url: string, title: string): FmSafeLinkPayload {
  return {
    url: String(url ?? '').slice(0, MAX_LINK_URL_LENGTH),
    title: String(title ?? '').slice(0, MAX_LINK_TITLE_LENGTH),
  }
}

function isSafeHttpLink (url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (parsed.username.length > 0 || parsed.password.length > 0) return false
  if (parsed.hostname.length === 0) return false
  return true
}

// The DOM is shared across isolated worlds, but JS globals/prototypes are not.
// Keep both the trusted-event check and ipcRenderer in this private world.
// Main supplies this flag only to Telegram views; no page-callable link API.
if (typeof process !== 'undefined' && process.isMainFrame && process.argv.includes('--fm-telegram-links')) {
  const w = globalThis as unknown as {
    location: { origin: string }
    HTMLAnchorElement: new (...args: never[]) => { href: string; hasAttribute: (name: string) => boolean }
    addEventListener: (type: string, listener: (event: {
      isTrusted: boolean; button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean
      composedPath: () => unknown[]; preventDefault: () => void; stopImmediatePropagation: () => void
    }) => void, options: { capture: boolean }) => void
  }
  w.addEventListener('click', (event) => {
    if (!event.isTrusted || event.button !== 0) return
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    if (w.location.origin !== 'https://web.telegram.org') return
    const anchor = event.composedPath().find((node) =>
      node instanceof w.HTMLAnchorElement && node.hasAttribute('href')) as InstanceType<typeof w.HTMLAnchorElement> | undefined
    if (anchor == null) return
    const href = anchor.href
    if (href.length > MAX_LINK_URL_LENGTH || !isSafeHttpLink(href)) return
    if (new URL(href).origin === w.location.origin) return
    // Capture before Telegram's own handler; external navigation is replaced
    // by the native explicit confirmation, including target=_blank links.
    event.preventDefault()
    event.stopImmediatePropagation()
    ipcRenderer.send(FM_SAFE_LINK_BRIDGE, makeSafeLinkPayload(href, ''))
  }, { capture: true })
}

// ---------------------------------------------------------------------------
// Focus diagnostic bridge (disabled by default).
//
// The main process sends start/stop commands. While running we record only
// coarse, anonymous categories of focus and input events. No message contents,
// no typed characters, no URLs, no DOM attributes are captured. Events are sent
// over the same narrow ipcRenderer channel and validated in the main process.
// ---------------------------------------------------------------------------

interface DiagnosticControlMessage {
  command: 'start' | 'stop'
}

function isEditableElement (target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  const editable = target.getAttribute('contenteditable') === 'true'
  return editable || tag === 'input' || tag === 'textarea' || target.isContentEditable
}

function targetCategory (target: EventTarget | null): 'editable' | 'button' | 'other' {
  if (!(target instanceof HTMLElement)) return 'other'
  const tag = target.tagName.toLowerCase()
  if (isEditableElement(target)) return 'editable'
  if (tag === 'button' || tag === 'a') return 'button'
  return 'other'
}

function installDiagnosticBridge (): void {
  let running = false
  let startTime = 0
  let rateWindow = 0
  let eventCount = 0

  const send = (type: 'dom-focusin' | 'dom-focusout' | 'dom-click' | 'dom-keydown' | 'dom-keyup', event: Event): void => {
    if (!running) return
    const window = Math.floor(performance.now() / 1000)
    if (window !== rateWindow) { rateWindow = window; eventCount = 0 }
    if (++eventCount > 100) return
    const target = event.target
    const detail: Record<string, unknown> = {
      target: targetCategory(target),
      editableFocused: isEditableElement(document.activeElement),
    }
    if (type === 'dom-keydown' || type === 'dom-keyup') {
      detail.eventType = type === 'dom-keydown' ? 'keydown' : 'keyup'
    }
    ipcRenderer.send(FM_FOCUS_DIAGNOSTIC_EVENT, {
      t: performance.now() - startTime,
      type,
      detail,
    })
  }

  const onFocusIn = (event: Event): void => { send('dom-focusin', event) }
  const onFocusOut = (event: Event): void => { send('dom-focusout', event) }
  const onClick = (event: Event): void => {
    // Only log real user clicks.
    if (!(event instanceof MouseEvent) || !event.isTrusted) return
    send('dom-click', event)
  }
  const onKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || !event.isTrusted) return
    send('dom-keydown', event)
  }
  const onKeyUp = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || !event.isTrusted) return
    send('dom-keyup', event)
  }

  const applyRunningState = (enabled: boolean): void => {
    if (enabled === running) return
    running = enabled
    if (running) {
      startTime = performance.now()
      document.addEventListener('focusin', onFocusIn, true)
      document.addEventListener('focusout', onFocusOut, true)
      document.addEventListener('click', onClick, true)
      document.addEventListener('keydown', onKeyDown, true)
      document.addEventListener('keyup', onKeyUp, true)
    } else {
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('focusout', onFocusOut, true)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('keyup', onKeyUp, true)
    }
  }

  ipcRenderer.on(FM_FOCUS_DIAGNOSTIC_CONTROL, (_event, message: unknown) => {
    const command = (message as DiagnosticControlMessage | undefined)?.command
    if (command === 'start') applyRunningState(true)
    else if (command === 'stop') applyRunningState(false)
  })
}

installDiagnosticBridge()

export {}
