import { BaseWindow, WebContentsView, ipcMain, screen, dialog, shell, type IpcMainEvent, type WebFrameMain } from 'electron'
import path from 'node:path'
import { createMessengerView, destroyMessengerView, type MessengerView } from './messenger-view.js'
import {
  isKnownServiceId,
  type ServiceId,
} from '../shared/services.js'
import {
  type AccountDefinition,
  isValidAccountId,
  sanitizeDisplayName,
  MAX_ACCOUNTS,
} from '../shared/accounts.js'
import { isAllowedShellNavigation, isSafeExternalUrl, getShellIndexUrl } from './navigation-policy.js'
import { type PortablePaths } from './portable-paths.js'
import {
  saveServiceConfig,
  addAccount,
  renameAccount,
  setAccountEnabled,
  setSelectedAccountId,
  setAppPreferences,
  type ServiceConfigV2,
  type SaveResult,
  type AppPreferences,
} from './service-config.js'
import { type UserAgentSource } from './user-agent.js'
import { type NotificationBridgeOptions } from './notifications.js'

const SIDEBAR_WIDTH = 220
const MIN_CONTENT_WIDTH = 480
const MIN_CONTENT_HEIGHT = 360

export interface AppWindow {
  window: BaseWindow
  shellView: WebContentsView
}

export interface WindowDependencies {
  app: Electron.App
  rendererRoot: string
  portablePaths: PortablePaths
  preloadPath: string
}

export interface RemoteViewLoadState {
  url: string
  loading: boolean
  failed: boolean
  /** Canonical error code for the UI, never a raw URL or description. */
  errorCode?: 'network' | 'crash' | 'abort' | 'unknown'
  /** Human-readable but data-sparse reason; may be empty. */
  errorReason?: string
}

export type LoadErrorCode = NonNullable<RemoteViewLoadState['errorCode']>

export interface MessengerRuntimeState {
  messenger: MessengerView
  loadState: RemoteViewLoadState
  /** Has the view ever attempted to load its service URL? */
  initialLoadDone: boolean
  /** Is a loadURL() call currently unresolved? Prevents duplicate concurrent loads. */
  pendingLoad: boolean
  /** Incremented on every loadURL() call. Old load promises are ignored. */
  loadGeneration: number
}

export interface ConfigChangePayload {
  accounts: AccountDefinition[]
  preferences: AppPreferences
  saveError?: 'none' | 'load-write-failed' | 'toggle-write-failed' | 'save-write-failed' | 'future-version-readonly'
}

export interface ShellStatePayload {
  activeAccountId: string | null
  loadState: RemoteViewLoadState | null
}

/**
 * Attach navigation/redirect/popup guards to a WebContents that hosts remote
 * (messenger) content. Called immediately after the WebContents is constructed
 * and before any loadURL/loadFile call, so there is no race with early events.
 */
export function attachRemoteGuards (wc: Electron.WebContents): void {
  wc.setWindowOpenHandler((details) => {
    if (isSafeExternalUrl(details.url)) {
      void shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  wc.on('will-navigate', (event, url) => {
    if (!isServiceUrl(url)) {
      event.preventDefault()
      if (isSafeExternalUrl(url)) {
        void shell.openExternal(url)
      } else {
        console.warn('Blocked navigation')
      }
    }
  })

  wc.on('will-redirect', (event, url) => {
    if (!isServiceUrl(url)) {
      event.preventDefault()
      if (isSafeExternalUrl(url)) {
        void shell.openExternal(url)
      } else {
        console.warn('Blocked redirect')
      }
    }
  })
}

/**
 * Attach navigation/redirect/popup guards to the shell WebContents. The shell may
 * only stay on our own index.html; every other destination is denied.
 */
export function attachShellGuards (wc: Electron.WebContents, rendererRoot: string): void {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))

  wc.on('will-frame-navigate', (event) => {
    if (!isAllowedShellNavigation(rendererRoot, event.url)) {
      event.preventDefault()
      console.warn('Blocked shell frame navigation')
    }
  })

  wc.on('will-redirect', (event, url) => {
    if (!isAllowedShellNavigation(rendererRoot, url)) {
      event.preventDefault()
      console.warn('Blocked shell redirect')
    }
  })
}

/**
 * Fail-closed check: is the IPC sender the shell WebContents and the frame its
 * main frame, with a URL that belongs to our own renderer index.html?
 */
export function isShellMainFrame (
  shellView: Electron.WebContentsView | null,
  sender: Electron.WebContents,
  frame: WebFrameMain | undefined | null,
  rendererRoot: string,
): boolean {
  if (shellView === null || sender !== shellView.webContents) return false
  if (frame == null) return false
  if (frame.parent != null || frame !== sender.mainFrame) return false

  const shellIndexUrl = getShellIndexUrl(rendererRoot)
  return frame.url === shellIndexUrl || frame.url.startsWith(`${shellIndexUrl}#`)
}

export function isServiceUrl (url: string): boolean {
  if (url === 'about:blank') return true
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
    return isKnownServiceIdServiceUrl(url)
  } catch {
    return false
  }
}

function isKnownServiceIdServiceUrl (url: string): boolean {
  try {
    const parsed = new URL(url)
    const knownOrigins = ['https://web.whatsapp.com', 'https://web.telegram.org']
    return knownOrigins.includes(parsed.origin)
  } catch {
    return false
  }
}

function validateServiceId (value: unknown): ServiceId | null {
  if (typeof value !== 'string') return null
  if (!isKnownServiceId(value)) return null
  return value
}

function validateAccountId (value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (!isValidAccountId(value)) return null
  return value
}

function validateBoolean (value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function sanitizeErrorDescription (code: number): LoadErrorCode {
  // ERR_ABORTED (-3) is usually a user- or renderer-initiated cancellation and
  // does not mean the main frame failed to load.
  if (code === -3) return 'abort'
  // Common network-level Electron error codes that indicate a real load failure.
  if (code <= -100 && code >= -599) return 'network'
  return 'unknown'
}

export interface IpcDependencies {
  shellViewRef: { current: Electron.WebContentsView | null }
  rendererRoot: string
  activeAccountRef: { current: string | null }
  messengers: Map<string, MessengerRuntimeState>
  portablePaths: PortablePaths
  serviceConfigRef: { current: ServiceConfigV2 }
  sendAccountList: () => void
  showAccount: (accountId: string) => void
  showHome: () => void
  setAccountEnabled: (accountId: string, enabled: boolean) => void
  addAccount: (serviceId: ServiceId, displayName?: string) => boolean
  renameAccount: (accountId: string, displayName: string) => boolean
  persistConfigPreference: <K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) => void
}

export function registerIpcHandlers (deps: IpcDependencies): void {
  ipcMain.on('select-account', (event: IpcMainEvent, accountId: unknown) => {
    if (!isShellMainFrame(deps.shellViewRef.current, event.sender, event.senderFrame, deps.rendererRoot)) {
      console.warn('Ignoring select-account from untrusted sender')
      return
    }
    const validated = validateAccountId(accountId)
    if (validated == null) {
      console.warn('Ignoring unsupported account selection')
      return
    }
    if (!deps.serviceConfigRef.current.accounts.some((a) => a.accountId === validated && a.enabled)) {
      console.warn('Ignoring selection of disabled account')
      return
    }
    deps.showAccount(validated)
  })

  ipcMain.on('go-home', (event: IpcMainEvent) => {
    if (!isShellMainFrame(deps.shellViewRef.current, event.sender, event.senderFrame, deps.rendererRoot)) {
      console.warn('Ignoring go-home from untrusted sender')
      return
    }
    deps.showHome()
  })

  ipcMain.on('set-account-enabled', (event: IpcMainEvent, accountId: unknown, enabled: unknown) => {
    if (!isShellMainFrame(deps.shellViewRef.current, event.sender, event.senderFrame, deps.rendererRoot)) {
      console.warn('Ignoring set-account-enabled from untrusted sender')
      return
    }
    const validatedId = validateAccountId(accountId)
    const validatedEnabled = validateBoolean(enabled)
    if (validatedId == null || validatedEnabled == null) {
      console.warn('Ignoring invalid account enable toggle')
      return
    }
    deps.setAccountEnabled(validatedId, validatedEnabled)
  })

  ipcMain.on('rename-account', (event: IpcMainEvent, accountId: unknown, displayName: unknown) => {
    if (!isShellMainFrame(deps.shellViewRef.current, event.sender, event.senderFrame, deps.rendererRoot)) {
      console.warn('Ignoring rename-account from untrusted sender')
      return
    }
    const validatedId = validateAccountId(accountId)
    if (validatedId == null) {
      console.warn('Ignoring invalid account rename')
      return
    }
    const name = typeof displayName === 'string' ? sanitizeDisplayName(displayName) : ''
    deps.renameAccount(validatedId, name)
  })

  ipcMain.on('add-account', (event: IpcMainEvent, serviceId: unknown, displayName: unknown) => {
    if (!isShellMainFrame(deps.shellViewRef.current, event.sender, event.senderFrame, deps.rendererRoot)) {
      console.warn('Ignoring add-account from untrusted sender')
      return
    }
    const validatedId = validateServiceId(serviceId)
    if (validatedId == null) {
      console.warn('Ignoring add-account for unknown service')
      return
    }
    const name = typeof displayName === 'string' ? sanitizeDisplayName(displayName) : ''
    deps.addAccount(validatedId, name)
  })

  ipcMain.on('set-preferences', (event: IpcMainEvent, patch: unknown) => {
    if (!isShellMainFrame(deps.shellViewRef.current, event.sender, event.senderFrame, deps.rendererRoot)) {
      console.warn('Ignoring set-preferences from untrusted sender')
      return
    }
    if (typeof patch !== 'object' || patch == null || Array.isArray(patch)) {
      console.warn('Ignoring invalid preferences patch')
      return
    }
    const obj = patch as Record<string, unknown>
    const validated: Partial<AppPreferences> = {}
    if (typeof obj.minimizeToTray === 'boolean') validated.minimizeToTray = obj.minimizeToTray
    if (typeof obj.notificationsEnabled === 'boolean') validated.notificationsEnabled = obj.notificationsEnabled
    if (typeof obj.notificationHideContent === 'boolean') validated.notificationHideContent = obj.notificationHideContent
    if (Object.keys(validated).length === 0) {
      console.warn('Ignoring empty preferences patch')
      return
    }
    for (const [key, value] of Object.entries(validated)) {
      const k = key as keyof AppPreferences
      deps.persistConfigPreference(k, value as AppPreferences[typeof k])
    }
  })

  ipcMain.on('get-portable-paths', (event: IpcMainEvent) => {
    if (!isShellMainFrame(deps.shellViewRef.current, event.sender, event.senderFrame, deps.rendererRoot)) {
      event.returnValue = { error: 'untrusted sender' }
      return
    }
    event.returnValue = deps.portablePaths
  })
}

export function createAppWindow (deps: WindowDependencies): AppWindow {
  const win = new BaseWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'FM - Sprachbox',
    show: false,
  })

  const shellWebPreferences = {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    preload: deps.preloadPath,
  }
  const shellView = new WebContentsView({ webPreferences: shellWebPreferences })
  attachShellGuards(shellView.webContents, deps.rendererRoot)
  win.contentView.addChildView(shellView)

  return { window: win, shellView }
}

function clampBounds (value: number, min = 0): number {
  const floored = Math.floor(value)
  return floored < min ? min : floored
}

/**
 * Layout all content views according to the current window bounds and mode.
 *
 * - Home mode: shell fills the whole content area so the React SPA can render
 *   the service selection without a visible sidebar behind it.
 * - Service mode: shell is a fixed-width sidebar on the left, the active
 *   messenger view occupies the remaining width, and inactive messenger views
 *   are sized consistently but remain hidden.
 * - Error/retry/loading overlay mode (service mode only): the shell temporarily
 *   expands to cover the whole window so the React overlay is visible and
 *   clickable. The active remote view is hidden during the overlay and reshown
 *   when loading succeeds or the user retries.
 */
function layoutViews (
  mainWindow: BaseWindow,
  shellView: Electron.WebContentsView | null,
  messengerViews: Iterable<Electron.WebContentsView>,
  showingHome: boolean,
  overlayActive: boolean,
): void {
  const bounds = mainWindow.getContentBounds()
  const width = clampBounds(bounds.width, MIN_CONTENT_WIDTH)
  const height = clampBounds(bounds.height, MIN_CONTENT_HEIGHT)

  if (shellView) {
    if (showingHome || overlayActive) {
      shellView.setBounds({ x: 0, y: 0, width, height })
    } else {
      const sidebarWidth = Math.min(clampBounds(SIDEBAR_WIDTH), width)
      shellView.setBounds({ x: 0, y: 0, width: sidebarWidth, height })
    }
  }

  const messengerVisible = !showingHome && !overlayActive
  const messengerWidth = messengerVisible ? clampBounds(width - SIDEBAR_WIDTH) : 0
  const messengerX = messengerVisible ? clampBounds(SIDEBAR_WIDTH) : width
  for (const view of messengerViews) {
    view.setBounds({ x: messengerX, y: 0, width: messengerWidth, height })
  }
}

export interface RuntimeState {
  mainWindow: BaseWindow | null
  shellView: WebContentsView | null
  messengers: Map<string, MessengerRuntimeState>
  activeAccountId: string | null
  showingHome: boolean
  serviceConfig: ServiceConfigV2
  /** Last persistent save result so the UI can surface a config write error. */
  lastConfigSaveError: ConfigChangePayload['saveError']
  trayController: import('./tray.js').TrayController | null
}

export interface RuntimeDependencies {
  app: Electron.App
  state: RuntimeState
  rendererRoot: string
  portablePaths: PortablePaths
  preloadPath: string
  userAgentSource: UserAgentSource
}

export function createRuntime (deps: RuntimeDependencies): {
  createWindow: () => void
  showAccount: (accountId: string) => void
  showHome: () => void
  sendAccountList: () => void
  registerIpc: () => void
  persistConfigPreference: <K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) => void
} {
  const { app, state, rendererRoot, portablePaths, preloadPath, userAgentSource } = deps

  function isOverlayActive (): boolean {
    if (state.showingHome) return false
    if (state.activeAccountId == null) return false
    const entry = state.messengers.get(state.activeAccountId)
    if (!entry) return false
    return entry.loadState.loading || entry.loadState.failed
  }

  function sendAccountList (): void {
    if (!state.shellView) return
    const payload: ConfigChangePayload = {
      accounts: [...state.serviceConfig.accounts],
      preferences: state.serviceConfig.preferences ?? {
        minimizeToTray: false,
        notificationsEnabled: true,
        notificationHideContent: true,
      },
      saveError: state.lastConfigSaveError,
    }
    state.shellView.webContents.send('accounts', payload)
  }

  function sendShellState (): void {
    if (!state.shellView) return
    const entry = state.activeAccountId ? state.messengers.get(state.activeAccountId) : undefined
    const payload: ShellStatePayload = {
      activeAccountId: state.activeAccountId,
      loadState: entry?.loadState ?? null,
    }
    state.shellView.webContents.send('shell-state', payload)
  }

  function updateRemoteLoadState (
    accountId: string,
    patch: Partial<RemoteViewLoadState>,
  ): void {
    const entry = state.messengers.get(accountId)
    if (!entry) return
    entry.loadState = { ...entry.loadState, ...patch }
    if (state.activeAccountId === accountId) {
      sendShellState()
      relayout()
    }
  }

  function attachLoadListeners (accountId: string, entry: MessengerRuntimeState): void {
    const wc = entry.messenger.view.webContents
    wc.on('did-start-loading', () => {
      updateRemoteLoadState(accountId, { loading: true, failed: false })
    })
    wc.on('did-stop-loading', () => {
      updateRemoteLoadState(accountId, { loading: false })
    })
    wc.on('did-fail-load', (_event: Electron.Event, errorCode: number, _errorDescription: string, _validatedURL: string, isMainFrame: boolean) => {
      // Only treat main-frame failures as fatal. Subframe/aborted errors should
      // not hide the messenger view behind an overlay.
      if (!isMainFrame) return
      if (errorCode === -3) return
      // Terminal failure: stop any pending load and bump the generation so that
      // a late resolution/rejection of the previous loadURL promise cannot
      // overwrite the failed state.
      entry.pendingLoad = false
      entry.loadGeneration += 1
      // Do not forward raw Electron descriptions (they may contain URLs) to the
      // renderer. Map to a small, fixed set of safe error codes.
      updateRemoteLoadState(accountId, {
        loading: false,
        failed: true,
        errorCode: sanitizeErrorDescription(errorCode),
      })
    })
    wc.on('render-process-gone', () => {
      // A crashed renderer is a terminal failure. Invalidate the pending load
      // and its promise generation before marking the service failed.
      entry.pendingLoad = false
      entry.loadGeneration += 1
      updateRemoteLoadState(accountId, {
        loading: false,
        failed: true,
        errorCode: 'crash',
      })
    })
  }

  function buildNotificationBridge (): NotificationBridgeOptions {
    return {
      getPreferences: () => state.serviceConfig.preferences,
      getEnabledAccounts: () => [...state.serviceConfig.accounts],
      getActiveAccountId: () => state.activeAccountId,
      onNotificationClicked: (accountId) => {
        const win = state.mainWindow
        if (win != null && !win.isDestroyed()) {
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
        }
        showAccount(accountId)
      },
    }
  }

  function ensureMessenger (accountId: string): MessengerRuntimeState | null {
    let entry = state.messengers.get(accountId)
    if (!entry) {
      const account = state.serviceConfig.accounts.find((a) => a.accountId === accountId)
      if (!account) return null
      const messenger = createMessengerView(account, portablePaths, { userAgentSource, notificationBridge: buildNotificationBridge() })
      registerRemoteView(messenger)
      state.mainWindow?.contentView.addChildView(messenger.view)
      entry = {
        messenger,
        loadState: {
          url: messenger.service.url,
          loading: false,
          failed: false,
        },
        initialLoadDone: false,
        pendingLoad: false,
        loadGeneration: 0,
      }
      attachLoadListeners(accountId, entry)
      state.messengers.set(accountId, entry)
    }
    return entry
  }

  function persistConfig (nextConfig: ServiceConfigV2): void {
    const saveResult: SaveResult = saveServiceConfig(portablePaths, nextConfig)
    if (saveResult.ok) {
      state.serviceConfig = saveResult.config
      state.lastConfigSaveError = 'none'
    } else if (saveResult.isReadOnly) {
      // Future config on disk must never be overwritten. Keep current in-memory
      // config unchanged and surface a clear read-only warning.
      state.lastConfigSaveError = 'future-version-readonly'
    } else {
      // Keep the previous valid persisted config in memory so the UI does not
      // display a stale-vs-memory mismatch. If the user changed an account and
      // the write failed, the old config remains active.
      state.lastConfigSaveError = 'save-write-failed'
    }
    sendAccountList()
  }

  function persistConfigPreference <K extends keyof AppPreferences> (key: K, value: AppPreferences[K]): void {
    const nextConfig = setAppPreferences(state.serviceConfig, { [key]: value })
    persistConfig(nextConfig)
  }

  function updateAccountEnabled (accountId: string, enabled: boolean): void {
    const account = state.serviceConfig.accounts.find((a) => a.accountId === accountId)
    if (!account) return
    const nextConfig = setAccountEnabled(state.serviceConfig, accountId, enabled)
    persistConfig(nextConfig)

    if (!enabled && state.activeAccountId === accountId) {
      // Deactivating the currently active account returns to the home screen.
      // The messenger view is hidden but NOT destroyed; existing login data is
      // preserved in the isolated profile.
      showHome()
    }
  }

  function updateAccountName (accountId: string, displayName: string): boolean {
    const account = state.serviceConfig.accounts.find((a) => a.accountId === accountId)
    if (!account) return false
    const nextConfig = renameAccount(state.serviceConfig, accountId, displayName)
    persistConfig(nextConfig)
    return true
  }

  function addNewAccount (serviceId: ServiceId, displayName?: string): boolean {
    if (state.serviceConfig.accounts.length >= MAX_ACCOUNTS) return false
    const nextConfig = addAccount(state.serviceConfig, serviceId, displayName)
    if (!nextConfig) return false
    persistConfig(nextConfig)
    return true
  }

  function loadMessenger (entry: MessengerRuntimeState, force = false): void {
    const accountId = entry.messenger.accountId
    const wc = entry.messenger.view.webContents
    const targetUrl = entry.messenger.service.url

    // Guard against overlapping loadURL() calls. Electron's loadURL promise is
    // async; during a pending load getURL() may be empty and a second call could
    // start a duplicate navigation. Even forced retries must wait for the
    // previous pending load to settle, otherwise stale promises can overwrite
    // newer state.
    if (entry.pendingLoad) {
      return
    }

    if (entry.initialLoadDone && !force && wc.getURL() !== '') {
      // View already has a current URL. The per-origin navigation guards keep
      // it on the service origin, so re-showing the same account should not
      // reload. Retry is triggered explicitly via force=true, but only when no
      // load is pending.
      return
    }

    entry.pendingLoad = true
    entry.initialLoadDone = true
    entry.loadGeneration += 1
    const generation = entry.loadGeneration
    updateRemoteLoadState(accountId, { loading: true, failed: false })
    wc.loadURL(targetUrl)
      .then(() => {
        if (generation !== entry.loadGeneration) return
        entry.pendingLoad = false
        // Do not overwrite a terminal failure/crash state that happened while
        // the load was still pending.
        if (entry.loadState.failed) return
        updateRemoteLoadState(accountId, { loading: false, failed: false, errorCode: undefined, errorReason: undefined })
      })
      .catch((err: Error) => {
        if (generation !== entry.loadGeneration) return
        entry.pendingLoad = false
        // If a terminal failure (crash/did-fail-load) already set failed=true
        // while the load was pending, keep that state.
        if (entry.loadState.failed) return
        // loadURL rejects on ERR_ABORTED as well. Treat aborts like did-fail-load.
        const code = (err as Error & { errno?: number }).errno
        if (code === -3) {
          updateRemoteLoadState(accountId, { loading: false, failed: false, errorCode: undefined, errorReason: undefined })
          return
        }
        // Error details may contain URLs; map to a safe code.
        updateRemoteLoadState(accountId, {
          loading: false,
          failed: true,
          errorCode: 'network',
        })
      })
  }

  function relayout (): void {
    if (!state.mainWindow || !state.shellView) return
    const overlayActive = isOverlayActive()
    // Hide the active remote view during loading/error overlays so the React
    // overlay is fully visible and clickable. Inactive views stay hidden.
    for (const [id, m] of state.messengers) {
      const visible = id === state.activeAccountId && !overlayActive
      m.messenger.view.setVisible(visible)
    }
    layoutViews(
      state.mainWindow,
      state.shellView,
      Array.from(state.messengers.values()).map((m) => m.messenger.view),
      state.showingHome,
      overlayActive,
    )
  }

  function showAccount (accountId: string): void {
    if (!state.mainWindow || !state.shellView) return
    if (!state.serviceConfig.accounts.some((a) => a.accountId === accountId && a.enabled)) return

    state.showingHome = false
    const entry = ensureMessenger(accountId)
    if (!entry) {
      showHome()
      return
    }

    for (const [id, m] of state.messengers) {
      m.messenger.view.setVisible(id === accountId)
    }
    state.activeAccountId = accountId
    relayout()

    loadMessenger(entry, entry.loadState.failed)

    const nextConfig = setSelectedAccountId(state.serviceConfig, accountId)
    const saveResult = saveServiceConfig(portablePaths, nextConfig)
    if (saveResult.ok) {
      state.serviceConfig = saveResult.config
    } else if (saveResult.isReadOnly) {
      state.lastConfigSaveError = 'future-version-readonly'
    }
    sendShellState()
  }

  function showHome (): void {
    if (!state.mainWindow || !state.shellView) return

    state.showingHome = true
    state.activeAccountId = null
    for (const m of state.messengers.values()) {
      m.messenger.view.setVisible(false)
    }
    relayout()

    const nextConfig = setSelectedAccountId(state.serviceConfig, null)
    const saveResult = saveServiceConfig(portablePaths, nextConfig)
    if (saveResult.ok) {
      state.serviceConfig = saveResult.config
    } else if (saveResult.isReadOnly) {
      state.lastConfigSaveError = 'future-version-readonly'
    }
    sendShellState()
  }

  function createWindow (): void {
    const { window, shellView } = createAppWindow({ app, rendererRoot, portablePaths, preloadPath })
    state.mainWindow = window
    state.shellView = shellView

    window.on('resize', relayout)
    window.on('maximize', relayout)
    window.on('unmaximize', relayout)
    window.on('restore', relayout)
    window.on('enter-full-screen', relayout)
    window.on('leave-full-screen', relayout)
    window.on('resized', relayout)
    window.on('move', relayout)
    window.on('moved', relayout)

    // Handle DPI / display scale changes explicitly. This event is emitted by
    // the screen module, not by BaseWindow, whenever display metrics change.
    const displayMetricsHandler = (): void => { relayout() }
    screen.on('display-metrics-changed', displayMetricsHandler)

    window.on('closed', () => {
      screen.off('display-metrics-changed', displayMetricsHandler)
      window.off('move', relayout)
      window.off('moved', relayout)
      for (const entry of state.messengers.values()) {
        destroyMessengerView(entry.messenger)
      }
      state.messengers.clear()
      if (state.shellView) {
        try {
          state.shellView.webContents.close()
        } catch (err) {
          console.warn('Error closing shell webContents:', err)
        }
        state.shellView = null
      }
      state.mainWindow = null
    })

    // Layout once before the window is shown so shell bounds are valid.
    layoutViews(window, shellView, [], true, false)

    void shellView.webContents.loadFile(path.join(rendererRoot, 'index.html'))
    shellView.webContents.once('did-finish-load', () => {
      window.show()
      sendAccountList()
      // Restore last selection if still enabled; otherwise home.
      const selected = state.serviceConfig.selectedAccountId
      if (selected != null && state.serviceConfig.accounts.some((a) => a.accountId === selected && a.enabled)) {
        showAccount(selected)
      } else {
        showHome()
      }
    })
  }

  function registerIpc (): void {
    ipcMain.handle('remove-account', async (event, accountId: unknown) => {
      if (!isShellMainFrame(state.shellView, event.sender, event.senderFrame, rendererRoot)) return false
      if (!isValidAccountId(accountId) || !state.mainWindow) return false
      const account = state.serviceConfig.accounts.find((a) => a.accountId === accountId)
      if (!account) return false
      const name = account.displayName ? `${account.serviceId} – ${account.displayName}` : account.serviceId
      const response = await dialog.showMessageBox(state.mainWindow, {
        type: 'question', buttons: ['Abbrechen', 'Eintrag entfernen'],
        defaultId: 0, cancelId: 0, noLink: true,
        title: 'Konto entfernen', message: `„${name}“ aus der App entfernen?`,
        detail: 'Nur der Eintrag wird entfernt. Lokale Login-Daten bleiben erhalten. Es werden keine Daten gelöscht.',
      })
      if (response.response !== 1 || !state.mainWindow || !state.serviceConfig.accounts.some((a) => a.accountId === accountId)) return false
      const result = saveServiceConfig(portablePaths, {
        ...state.serviceConfig,
        accounts: state.serviceConfig.accounts.filter((a) => a.accountId !== accountId),
        selectedAccountId: state.serviceConfig.selectedAccountId === accountId ? null : state.serviceConfig.selectedAccountId,
      })
      if (!result.ok) {
        state.lastConfigSaveError = result.isReadOnly ? 'future-version-readonly' : 'save-write-failed'
        sendAccountList()
        return false
      }
      state.serviceConfig = result.config
      state.lastConfigSaveError = 'none'
      if (state.activeAccountId === accountId) showHome()
      const entry = state.messengers.get(accountId)
      if (entry) {
        state.mainWindow.contentView.removeChildView(entry.messenger.view)
        destroyMessengerView(entry.messenger)
        state.messengers.delete(accountId)
      }
      sendAccountList()
      return true
    })
    const shellViewRef: { current: Electron.WebContentsView | null } = {
      get current () { return state.shellView },
      set current (_value) { /* readonly from outside */ },
    }
    const activeAccountRef: { current: string | null } = {
      get current () { return state.activeAccountId },
      set current (_value) { /* readonly from outside */ },
    }
    const serviceConfigRef: { current: ServiceConfigV2 } = {
      get current () { return state.serviceConfig },
      set current (_value) { /* readonly from outside */ },
    }
    registerIpcHandlers({
      shellViewRef,
      rendererRoot,
      activeAccountRef,
      messengers: state.messengers,
      portablePaths,
      serviceConfigRef,
      sendAccountList,
      showAccount,
      showHome,
      setAccountEnabled: updateAccountEnabled,
      addAccount: addNewAccount,
      renameAccount: updateAccountName,
      persistConfigPreference,
    })
  }

  function registerRemoteView (messenger: MessengerView): void {
    attachRemoteGuards(messenger.view.webContents)
  }

  return { createWindow, showAccount, showHome, sendAccountList, registerIpc, persistConfigPreference }
}
