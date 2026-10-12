import { ipcMain, type WebContents, type BaseWindow, type WebContentsView, type IpcMainEvent } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Opt-in, data-sparse focus/view diagnostic logger.
 *
 * Disabled by default. When enabled it records only coarse categories of focus
 * and input events (window focus/blur, active view, overlay state, DOM focus
 * target category, keyboard event type, editable focus, zoom factor) from the
 * main process and from a narrow preload bridge. No message contents, no typed
 * characters, no URLs, no account names/ids, no cookies, no full DOM attributes
 * are ever captured. The log is written to a local file capped at 2 MB; there is
 * no network upload.
 */

const EVENT_CHANNEL = 'fm-focus-diagnostic-event'
const CONTROL_CHANNEL = 'fm-focus-diagnostic-control'
const STATE_CHANNEL = 'fm-focus-diagnostic-state'

const MAX_LOG_BYTES = 2 * 1024 * 1024
const MAX_LINE_BYTES = 4096
const MAX_EVENTS_PER_VIEW_PER_SECOND = 100
const ROTATED_FILE_COUNT = 1
const MAX_STRING_VALUE_LENGTH = 64

/** Coarse DOM target categories; never element text, ids or names. */
const TARGET_CATEGORIES = ['editable', 'button', 'other'] as const
type TargetCategory = typeof TARGET_CATEGORIES[number]

/** Keyboard event kinds; no key values/codes. */
const KEYBOARD_EVENT_TYPES = ['keydown', 'keyup'] as const
type KeyboardEventType = typeof KEYBOARD_EVENT_TYPES[number]

/** Event types that may arrive from the private preload bridge. */
const PRELOAD_EVENT_TYPES = ['dom-focusin', 'dom-focusout', 'dom-click', 'dom-keydown', 'dom-keyup'] as const
type PreloadEventType = typeof PRELOAD_EVENT_TYPES[number]

/** All event types the main process may log locally. */
type LocalEventType = 'win-focus' | 'win-blur' | 'view-active' | 'view-visible' | 'view-hidden' | 'overlay-on' | 'overlay-off' | 'bounds' | 'wc-focus' | 'wc-blur' | 'zoom'

export type DiagnosticEntryType = PreloadEventType | LocalEventType

interface DiagnosticEntry {
  /** Relative milliseconds since diagnostic start. Monotonic. */
  t: number
  /** Event category. */
  type: DiagnosticEntryType
  /** Anonymous, volatile view label (e.g. 'view-1', 'shell'). */
  view?: string
  /** Coarse detail; never contains text, keys, URLs or ids. */
  detail?: Record<string, unknown>
}

export interface FocusDiagnosticState {
  enabled: boolean
  filePath: string | null
  startedAt: number | null
}

export interface FocusDiagnosticOptions {
  logsDir: string
  /** Return the currently active account id, or null for home. */
  getActiveAccountId: () => string | null
  /** Return the shell WebContentsView for identity checks. */
  getShellView: () => WebContentsView | null
  /** Check whether a WebContents is a known messenger view. */
  isMessengerWebContents: (wc: WebContents) => boolean
  /** Check whether a URL belongs to an allowed service origin. */
  isServiceUrl: (url: string, wc: WebContents) => boolean
  /** Notify the shell renderer about state changes. */
  notifyState: (state: FocusDiagnosticState) => void
}

class FocusDiagnosticLogger {
  private readonly options: FocusDiagnosticOptions
  private state: FocusDiagnosticState = { enabled: false, filePath: null, startedAt: null }
  private startTimeHr = 0n
  private currentFilePath: string | null = null
  private currentSize = 0
  private viewSequence = new Map<number, number>()
  private webContentsToAccount = new Map<number, string>()
  private lastRateWindow = new Map<number, number>()
  private rateBuckets = new Map<number, number>()
  private windowFocusBound = false
  private readonly boundWindowFocus: () => void
  private readonly boundWindowBlur: () => void
  private mainWindow: BaseWindow | null = null
  private shellView: WebContentsView | null = null
  private shellFocusHandler: (() => void) | null = null
  private shellBlurHandler: (() => void) | null = null
  private readonly messengerListeners = new Set<WebContents>()
  private readonly messengerFocusHandlers = new Map<WebContents, () => void>()
  private readonly messengerBlurHandlers = new Map<WebContents, () => void>()
  private readonly messengerZoomHandlers = new Map<WebContents, () => void>()
  private readonly reloadHandlers = new Map<WebContents, () => void>()
  private readonly visibility = new Map<string, boolean>()
  private overlayActive = false
  private lastBounds: Electron.Rectangle | null = null
  private observationTimer: ReturnType<typeof setInterval> | null = null

  constructor (options: FocusDiagnosticOptions) {
    this.options = options
    this.boundWindowFocus = () => { this.write({ type: 'win-focus', detail: { isFocused: this.mainWindow?.isFocused() ?? false } }) }
    this.boundWindowBlur = () => { this.write({ type: 'win-blur', detail: { isFocused: this.mainWindow?.isFocused() ?? false } }) }
    this.registerIpc()
  }

  getState (): FocusDiagnosticState {
    return { ...this.state }
  }

  bindWindow (window: BaseWindow): void {
    if (this.mainWindow === window) return
    this.unbindWindow()
    this.mainWindow = window
    if (this.state.enabled) {
      bindBaseWindowFocus(window, true, { focus: this.boundWindowFocus, blur: this.boundWindowBlur })
      this.windowFocusBound = true
    }
  }

  unbindWindow (): void {
    bindBaseWindowFocus(this.mainWindow, false, { focus: this.boundWindowFocus, blur: this.boundWindowBlur })
    this.windowFocusBound = false
    this.mainWindow = null
  }

  bindShellView (shellView: WebContentsView | null): void {
    if (this.shellView === shellView) return
    this.unbindShellView()
    this.shellView = shellView
    if (shellView == null) return
    this.shellFocusHandler = () => { this.write({ type: 'wc-focus', view: 'shell', detail: { isFocused: shellView.webContents.isFocused() } }) }
    this.shellBlurHandler = () => { this.write({ type: 'wc-blur', view: 'shell', detail: { isFocused: shellView.webContents.isFocused() } }) }
    if (this.state.enabled) {
      bindWebContentsFocus(shellView.webContents, true, { focus: this.shellFocusHandler, blur: this.shellBlurHandler })
    }
  }

  unbindShellView (): void {
    bindWebContentsFocus(this.shellView?.webContents ?? null, false, { focus: this.shellFocusHandler, blur: this.shellBlurHandler })
    this.shellView = null
    this.shellFocusHandler = null
    this.shellBlurHandler = null
  }

  bindMessengerWebContents (wc: WebContents, accountId: string): void {
    if (this.messengerListeners.has(wc)) return
    this.webContentsToAccount.set(wc.id, accountId)
    const onFocus = () => { this.write({ type: 'wc-focus', view: this.viewLabel(wc), detail: { isFocused: wc.isFocused() } }) }
    const onBlur = () => { this.write({ type: 'wc-blur', view: this.viewLabel(wc), detail: { isFocused: wc.isFocused() } }) }
    const onZoom = () => { this.write({ type: 'zoom', view: this.viewLabel(wc), detail: { zoomFactor: safeZoomFactor(wc) } }) }
    this.messengerFocusHandlers.set(wc, onFocus)
    this.messengerBlurHandlers.set(wc, onBlur)
    this.messengerZoomHandlers.set(wc, onZoom)
    if (this.state.enabled) {
      bindWebContentsFocus(wc, true, { focus: onFocus, blur: onBlur })
      bindWebContentsZoom(wc, true, onZoom)
      this.sendControl(wc, 'start')
    }
    this.messengerListeners.add(wc)
    const ready = (): void => { this.sendControl(wc, this.state.enabled ? 'start' : 'stop') }
    wc.on('dom-ready', ready)
    this.reloadHandlers.set(wc, ready)
  }

  unbindMessengerWebContents (wc: WebContents): void {
    if (!this.messengerListeners.has(wc)) return
    const onFocus = this.messengerFocusHandlers.get(wc) ?? null
    const onBlur = this.messengerBlurHandlers.get(wc) ?? null
    const onZoom = this.messengerZoomHandlers.get(wc) ?? null
    bindWebContentsFocus(wc, false, { focus: onFocus, blur: onBlur })
    bindWebContentsZoom(wc, false, onZoom)
    this.messengerFocusHandlers.delete(wc)
    this.messengerBlurHandlers.delete(wc)
    this.messengerZoomHandlers.delete(wc)
    this.messengerListeners.delete(wc)
    const ready = this.reloadHandlers.get(wc)
    if (ready != null) wc.off('dom-ready', ready)
    this.reloadHandlers.delete(wc)
    this.sendControl(wc, 'stop')
    this.webContentsToAccount.delete(wc.id)
  }

  logActiveAccountChange (accountId: string | null): void {
    const label = accountId == null ? 'shell' : this.accountViewLabel(accountId)
    this.write({ type: 'view-active', view: label, detail: { hasActiveAccount: accountId != null } })
  }

  logMessengerVisible (accountId: string | null, visible: boolean): void {
    if (accountId != null) this.visibility.set(accountId, visible)
    const label = accountId == null ? 'shell' : this.accountViewLabel(accountId)
    this.write({ type: visible ? 'view-visible' : 'view-hidden', view: label, detail: { hasActiveAccount: accountId != null } })
  }

  logOverlayChange (active: boolean): void {
    this.overlayActive = active
    this.write({ type: active ? 'overlay-on' : 'overlay-off' })
  }

  logBounds (bounds: Electron.Rectangle): void {
    this.lastBounds = { ...bounds }
    this.write({ type: 'bounds', detail: { width: bounds.width, height: bounds.height } })
  }

  toggle (): FocusDiagnosticState {
    if (this.state.enabled) {
      this.stop()
    } else {
      this.start()
    }
    return { ...this.state }
  }

  start (): FocusDiagnosticState {
    if (this.state.enabled) return { ...this.state }
    this.rotateLogFile()
    this.currentFilePath = this.makeLogFilePath()
    this.startTimeHr = process.hrtime.bigint()
    this.currentSize = 0
    this.viewSequence.clear()
    this.lastRateWindow.clear()
    this.rateBuckets.clear()
    fs.mkdirSync(path.dirname(this.currentFilePath), { recursive: true })
    fs.writeFileSync(this.currentFilePath, '')
    this.rotateLogFile()
    this.state = { enabled: true, filePath: this.currentFilePath, startedAt: Date.now() }

    if (this.mainWindow != null) {
      bindBaseWindowFocus(this.mainWindow, true, { focus: this.boundWindowFocus, blur: this.boundWindowBlur })
      this.windowFocusBound = true
    }
    bindWebContentsFocus(this.shellView?.webContents ?? null, true, { focus: this.shellFocusHandler, blur: this.shellBlurHandler })
    for (const wc of this.messengerListeners) {
      const onFocus = this.messengerFocusHandlers.get(wc) ?? null
      const onBlur = this.messengerBlurHandlers.get(wc) ?? null
      const onZoom = this.messengerZoomHandlers.get(wc) ?? null
      bindWebContentsFocus(wc, true, { focus: onFocus, blur: onBlur })
      bindWebContentsZoom(wc, true, onZoom)
      this.sendControl(wc, 'start')
    }

    this.broadcastControl('start')
    this.options.notifyState({ ...this.state })
    this.logActiveAccountChange(this.options.getActiveAccountId())
    this.logOverlayChange(this.overlayActive)
    if (this.mainWindow != null) {
      this.write({ type: this.mainWindow.isFocused() ? 'win-focus' : 'win-blur', detail: { isFocused: this.mainWindow.isFocused() } })
    }
    if (this.shellView != null) this.observeWebContents(this.shellView.webContents)
    for (const [id, visible] of this.visibility) this.logMessengerVisible(id, visible)
    for (const wc of this.messengerListeners) this.observeWebContents(wc)
    if (this.lastBounds != null) this.logBounds(this.lastBounds)
    this.observationTimer = setInterval(() => {
      for (const wc of this.messengerListeners) this.observeWebContents(wc)
      if (this.shellView != null) this.observeWebContents(this.shellView.webContents)
    }, 200)
    this.observationTimer.unref()
    return { ...this.state }
  }

  stop (): FocusDiagnosticState {
    if (!this.state.enabled) return { ...this.state }
    if (this.observationTimer != null) clearInterval(this.observationTimer)
    this.observationTimer = null
    this.state = { enabled: false, filePath: this.currentFilePath, startedAt: this.startTimeHr === 0n ? null : Date.now() }

    if (this.mainWindow != null && this.windowFocusBound) {
      bindBaseWindowFocus(this.mainWindow, false, { focus: this.boundWindowFocus, blur: this.boundWindowBlur })
      this.windowFocusBound = false
    }
    bindWebContentsFocus(this.shellView?.webContents ?? null, false, { focus: this.shellFocusHandler, blur: this.shellBlurHandler })
    for (const wc of this.messengerListeners) {
      const onFocus = this.messengerFocusHandlers.get(wc) ?? null
      const onBlur = this.messengerBlurHandlers.get(wc) ?? null
      const onZoom = this.messengerZoomHandlers.get(wc) ?? null
      bindWebContentsFocus(wc, false, { focus: onFocus, blur: onBlur })
      bindWebContentsZoom(wc, false, onZoom)
      this.sendControl(wc, 'stop')
    }

    this.broadcastControl('stop')
    this.options.notifyState({ ...this.state })
    return { ...this.state }
  }

  private broadcastControl (command: 'start' | 'stop'): void {
    const shellView = this.options.getShellView()
    const message = { command }
    shellView?.webContents.send(CONTROL_CHANNEL, message)
    for (const wc of this.messengerListeners) {
      this.sendControl(wc, command)
    }
  }

  private sendControl (wc: WebContents, command: 'start' | 'stop'): void {
    try {
      if (wc.isDestroyed()) return
      wc.send(CONTROL_CHANNEL, { command })
    } catch (err) {
      console.warn('[focus-diagnostic] Failed to send control message:', err)
    }
  }

  private registerIpc (): void {
    ipcMain.on(EVENT_CHANNEL, (event, entry: unknown) => {
      const sender = event.sender
      if (sender == null) return
      if (!this.state.enabled) return
      if (!this.checkRateLimit(sender.id)) return
      if (!this.validateSender(event)) return
      const parsed = this.validateEntry(entry)
      if (parsed == null) {
        return
      }
      this.write({ ...parsed, view: this.viewLabel(sender) })
      this.observeWebContents(sender)
    })

    ipcMain.on('toggle-focus-diagnostic', (event) => {
      try {
      const shellView = this.options.getShellView()
      if (shellView == null || event.sender !== shellView.webContents) {
        console.warn('[focus-diagnostic] Ignoring toggle from untrusted sender')
        return
      }
      const frame = event.senderFrame
      if (event.sender.isDestroyed() || frame == null || frame.detached || frame.parent != null || frame !== event.sender.mainFrame) {
        console.warn('[focus-diagnostic] Ignoring toggle from subframe')
        return
      }
      this.toggle()
      } catch { /* Reject detached or disposed shell frames. */ }
    })
  }

  /**
   * Fail-closed sender validation for events from the private preload bridge.
   * Requirements:
   * - Sender WebContents is a known messenger view.
   * - Sender frame is the main frame of that WebContents.
   * - WebContents is still alive.
   * - The main-frame URL belongs to an allowed service origin.
   */
  private validateSender (event: IpcMainEvent): boolean {
    try {
    const sender = event.sender
    if (!this.options.isMessengerWebContents(sender)) {
      return false
    }
    if (sender.isDestroyed()) {
      return false
    }
    const frame = event.senderFrame
    if (frame == null) {
      return false
    }
    if (frame.detached || frame.parent != null || frame !== sender.mainFrame) {
      return false
    }
    const frameUrl = frame.url
    if (frameUrl.length === 0) {
      return false
    }
    const currentUrl = sender.getURL()
    const current = new URL(currentUrl)
    const frameOrigin = new URL(frameUrl)
    if (current.protocol !== 'https:' || frameOrigin.protocol !== 'https:' ||
      current.origin === 'null' || frameOrigin.origin === 'null' ||
      current.username !== '' || current.password !== '' ||
      frameOrigin.username !== '' || frameOrigin.password !== '' ||
      current.origin !== frameOrigin.origin || !this.options.isServiceUrl(frameUrl, sender)) {
      return false
    }
    return true
    } catch {
      return false
    }
  }

  private observeWebContents (wc: WebContents): void {
    if (!this.state.enabled) return
    try {
      if (wc.isDestroyed()) return
      const view = wc === this.shellView?.webContents ? 'shell' : this.viewLabel(wc)
      this.write({ type: 'wc-focus', view, detail: { isFocused: wc.isFocused() } })
      this.write({ type: 'zoom', view, detail: { zoomFactor: safeZoomFactor(wc) } })
    } catch { /* A view may be destroyed during observation. */ }
  }

  /**
   * Strict per-event schema validation. Only exact enum values and booleans are
   * accepted; arbitrary strings, objects, numbers or long values are rejected.
   */
  private validateEntry (value: unknown): DiagnosticEntry | null {
    if (typeof value !== 'object' || value == null) return null
    const obj = value as Record<string, unknown>
    if (typeof obj.t !== 'number' || !Number.isFinite(obj.t) || obj.t < 0 || obj.t > 0x7fffffff) return null
    if (typeof obj.type !== 'string') return null
    if (!PRELOAD_EVENT_TYPES.includes(obj.type as PreloadEventType)) return null

    // Reject unknown top-level keys early.
    let keyCount = 0
    for (const key in obj) {
      if (++keyCount > 3 || !['t', 'type', 'detail'].includes(key)) return null
    }

    const detail = obj.detail
    if (detail != null) {
      if (typeof detail !== 'object' || Array.isArray(detail)) return null
    }

    const type = obj.type as PreloadEventType
    const validatedDetail = this.validateDetail(type, detail as Record<string, unknown> | undefined)
    if (validatedDetail == null) return null

    return { t: obj.t, type, detail: validatedDetail }
  }

  private validateDetail (
    type: PreloadEventType,
    detail: Record<string, unknown> | undefined,
  ): Record<string, unknown> | null {
    if (detail == null) return null

    const detailKeys: string[] = []
    for (const key in detail) {
      if (detailKeys.length >= 3) return null
      detailKeys.push(key)
    }
    const required = type === 'dom-keydown' || type === 'dom-keyup'
      ? ['target', 'editableFocused', 'eventType']
      : ['target', 'editableFocused']
    const allowed = new Set(required)

    if (detailKeys.some((k) => !allowed.has(k))) return null
    if (!required.every((k) => detailKeys.includes(k))) return null

    const target = detail.target
    if (typeof target !== 'string' || !TARGET_CATEGORIES.includes(target as TargetCategory)) return null

    const editableFocused = detail.editableFocused
    if (typeof editableFocused !== 'boolean') return null

    const result: Record<string, unknown> = { target, editableFocused }

    if (type === 'dom-keydown' || type === 'dom-keyup') {
      const eventType = detail.eventType
      if (typeof eventType !== 'string' || !KEYBOARD_EVENT_TYPES.includes(eventType as KeyboardEventType)) return null
      if (eventType !== type.slice(4)) return null
      result.eventType = eventType
    }

    // Final size sanity check: values are short enums/booleans only.
    if (!Object.values(result).every((v) => this.isShortAllowedValue(v))) return null

    return result
  }

  private isShortAllowedValue (value: unknown): boolean {
    if (typeof value === 'boolean') return true
    if (typeof value === 'string') return value.length <= MAX_STRING_VALUE_LENGTH
    if (typeof value === 'number') return Number.isFinite(value)
    return false
  }

  private checkRateLimit (webContentsId: number): boolean {
    const now = Number(process.hrtime.bigint() / 1_000_000_000n)
    const lastWindow = this.lastRateWindow.get(webContentsId)
    if (lastWindow !== now) {
      this.lastRateWindow.set(webContentsId, now)
      this.rateBuckets.set(webContentsId, 1)
      return true
    }
    const count = (this.rateBuckets.get(webContentsId) ?? 0) + 1
    this.rateBuckets.set(webContentsId, count)
    if (count > MAX_EVENTS_PER_VIEW_PER_SECOND) {
      if (count === MAX_EVENTS_PER_VIEW_PER_SECOND + 1) {
        // Drop the burst without logging identifiers or untrusted payloads.
      }
      return false
    }
    return true
  }

  private viewLabel (wc: WebContents): string {
    let seq = this.viewSequence.get(wc.id)
    if (seq == null) {
      seq = this.viewSequence.size + 1
      this.viewSequence.set(wc.id, seq)
    }
    return `view-${seq}`
  }

  private accountViewLabel (accountId: string): string {
    for (const [wcId, id] of this.webContentsToAccount) {
      if (id === accountId) {
        return this.viewLabel({ id: wcId } as WebContents)
      }
    }
    return 'unknown'
  }

  private makeLogFilePath (): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    return path.join(this.options.logsDir, `focus-diagnostic-${stamp}.log`)
  }

  private rotateLogFile (): void {
    const baseDir = this.options.logsDir
    if (!fs.existsSync(baseDir)) return
    const files = fs.readdirSync(baseDir)
      .filter((f) => f.startsWith('focus-diagnostic-') && f.endsWith('.log'))
      .map((f) => ({ name: f, stat: fs.statSync(path.join(baseDir, f)) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    for (const file of files.slice(ROTATED_FILE_COUNT)) {
      try {
        fs.unlinkSync(path.join(baseDir, file.name))
      } catch (err) {
        console.warn('[focus-diagnostic] Failed to rotate old log:', err)
      }
    }
  }

  private write (entry: Omit<DiagnosticEntry, 't'>): void {
    if (this.currentFilePath == null || !this.state.enabled) return
    const t = Number((process.hrtime.bigint() - this.startTimeHr) / 1_000_000n)
    const line = JSON.stringify({ ...entry, t }) + '\n'
    const lineBytes = Buffer.byteLength(line, 'utf8')
    if (lineBytes > MAX_LINE_BYTES) return
    if (this.currentSize + lineBytes > MAX_LOG_BYTES) {
      console.warn('[focus-diagnostic] Log size limit reached')
      this.stop()
      return
    }
    try {
      fs.appendFileSync(this.currentFilePath, line)
      this.currentSize += lineBytes
    } catch (err) {
      console.warn('[focus-diagnostic] Failed to write log entry:', err)
    }
  }
}

function safeZoomFactor (wc: WebContents): number {
  try {
    if (wc.isDestroyed()) return 0
    return wc.getZoomFactor()
  } catch {
    return 0
  }
}

function bindBaseWindowFocus (window: BaseWindow | null, bind: boolean, handlers: { focus?: (() => void) | null; blur?: (() => void) | null }): void {
  if (window == null) return
  // Electron's public TypeScript types do not declare the focus/blur events on
  // BaseWindow, but they exist at runtime and are safe to attach.
  if (bind) {
    if (handlers.focus != null) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).on('focus', handlers.focus)
    }
    if (handlers.blur != null) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).on('blur', handlers.blur)
    }
  } else {
    if (handlers.focus != null) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).off('focus', handlers.focus)
    }
    if (handlers.blur != null) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).off('blur', handlers.blur)
    }
  }
}

function bindWebContentsFocus (wc: WebContents | null, bind: boolean, handlers: { focus?: (() => void) | null; blur?: (() => void) | null }): void {
  // Observe actual isFocused() state on DOM events and via the opt-in sampler.
  // Do not rely on undocumented WebContents focus/blur events.
  void wc; void bind; void handlers
}

function bindWebContentsZoom (wc: WebContents | null, bind: boolean, handler: (() => void) | null): void {
  if (wc == null || handler == null) return
  // 'zoom-changed' is emitted when the user changes the zoom factor (e.g.
  // Ctrl+scroll). Public TS declarations omit it, but it exists at runtime.
  if (bind) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (wc as any).on('zoom-changed', handler)
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (wc as any).off('zoom-changed', handler)
  }
}

export { FocusDiagnosticLogger, EVENT_CHANNEL, CONTROL_CHANNEL, STATE_CHANNEL }
export type { DiagnosticEntry }
