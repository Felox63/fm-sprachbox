import { createRoot } from 'react-dom/client'
import App from './App.js'
import { type AccountRuntimeState } from '../shared/accounts.js'

// In a real Electron window this API is injected by the preload script.
// Provide a minimal mock for browser preview / screenshots only.
if (typeof window !== 'undefined' && !window.electronAPI) {
  const mockAccounts: AccountRuntimeState[] = [
    {
      accountId: 'legacy-whatsapp',
      serviceId: 'whatsapp',
      serviceLabel: 'WhatsApp',
      displayName: '',
      enabled: true,
      icon: 'assets/service-icons/whatsapp.svg',
    },
    {
      accountId: 'legacy-telegram',
      serviceId: 'telegram',
      serviceLabel: 'Telegram',
      displayName: '',
      enabled: true,
      icon: 'assets/service-icons/telegram.svg',
    },
  ]

  window.electronAPI = {
    selectAccount: (id: string) => {
      window.dispatchEvent(new CustomEvent('active-account', { detail: id }))
    },
    goHome: () => {
      window.dispatchEvent(new CustomEvent('active-account', { detail: null }))
    },
    setAccountEnabled: (_id: string, _enabled: boolean) => {
      // no-op in browser preview
    },
    addAccount: (_serviceId: string, _displayName?: string) => {
      // no-op in browser preview
    },
    removeAccount: async (_accountId: string) => false,
    renameAccount: (_accountId: string, _displayName: string) => {
      // no-op in browser preview
    },
    setPreferences: (_patch: Partial<{ minimizeToTray: boolean; notificationsEnabled: boolean; notificationHideContent: boolean }>) => {
      // no-op in browser preview
    },
    onAccounts: (cb: (payload: { accounts: AccountRuntimeState[]; saveError?: 'none' | 'load-write-failed' | 'toggle-write-failed' | 'save-write-failed' | 'future-version-readonly'; preferences: { minimizeToTray: boolean; notificationsEnabled: boolean; notificationHideContent: boolean } }) => void) => {
      cb({ accounts: mockAccounts, preferences: { minimizeToTray: false, notificationsEnabled: true, notificationHideContent: true } })
    },
    onShellState: (cb: (payload: { activeAccountId: string | null; loadState: { url: string; loading: boolean; failed: boolean; errorReason?: string; errorCode?: 'network' | 'crash' | 'abort' | 'unknown' } | null }) => void) => {
      window.addEventListener('active-account', (e: Event) => {
        const id = (e as CustomEvent).detail as string | null
        cb({ activeAccountId: id, loadState: null })
      })
    },
  }
}

const container = document.getElementById('root')
if (!container) {
  throw new Error('Root container not found')
}

createRoot(container).render(<App />)
