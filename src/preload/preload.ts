import { contextBridge, ipcRenderer } from 'electron'

interface AccountDefinition {
  accountId: string
  serviceId: string
  displayName: string
  enabled: boolean
}

interface AppPreferences {
  minimizeToTray: boolean
  notificationsEnabled: boolean
  notificationHideContent: boolean
}

interface ConfigChangePayload {
  accounts: AccountDefinition[]
  preferences: AppPreferences
  saveError?: 'none' | 'load-write-failed' | 'toggle-write-failed' | 'save-write-failed' | 'future-version-readonly'
}

interface RemoteViewLoadState {
  url: string
  loading: boolean
  failed: boolean
  errorCode?: 'network' | 'crash' | 'abort' | 'unknown'
  errorReason?: string
}

interface ShellStatePayload {
  activeAccountId: string | null
  loadState: RemoteViewLoadState | null
}

export interface ElectronAPI {
  selectAccount: (accountId: string) => void
  goHome: () => void
  setAccountEnabled: (accountId: string, enabled: boolean) => void
  addAccount: (serviceId: string, displayName?: string) => void
  renameAccount: (accountId: string, displayName: string) => void
  removeAccount: (accountId: string) => Promise<boolean>
  setPreferences: (patch: Partial<AppPreferences>) => void
  onAccounts: (callback: (payload: ConfigChangePayload) => void) => void
  onShellState: (callback: (payload: ShellStatePayload) => void) => void
}

const api: ElectronAPI = {
  selectAccount: (accountId) => ipcRenderer.send('select-account', accountId),
  goHome: () => ipcRenderer.send('go-home'),
  setAccountEnabled: (accountId, enabled) => ipcRenderer.send('set-account-enabled', accountId, enabled),
  addAccount: (serviceId, displayName) => ipcRenderer.send('add-account', serviceId, displayName),
  renameAccount: (accountId, displayName) => ipcRenderer.send('rename-account', accountId, displayName),
  removeAccount: (accountId) => ipcRenderer.invoke('remove-account', accountId),
  setPreferences: (patch) => ipcRenderer.send('set-preferences', patch),
  onAccounts: (callback) => {
    ipcRenderer.on('accounts', (_event, payload) => callback(payload))
  },
  onShellState: (callback) => {
    ipcRenderer.on('shell-state', (_event, payload) => callback(payload))
  },
}

contextBridge.exposeInMainWorld('electronAPI', api)
