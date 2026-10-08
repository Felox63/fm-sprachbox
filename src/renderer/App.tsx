import { useState, useEffect, useCallback, useRef } from 'react'
import './app.css'
import type { AccountRuntimeState, AccountDefinition, ServiceId } from '../shared/accounts.js'
import { getAccountLabel, toAccountRuntimeState } from '../shared/accounts.js'

interface ConfigChangePayload {
  accounts: AccountDefinition[]
  preferences: {
    minimizeToTray: boolean
    notificationsEnabled: boolean
    notificationHideContent: boolean
  }
  saveError?: 'none' | 'load-write-failed' | 'toggle-write-failed' | 'save-write-failed' | 'future-version-readonly'
}

interface AppPreferences {
  minimizeToTray: boolean
  notificationsEnabled: boolean
  notificationHideContent: boolean
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

declare global {
  interface Window {
    electronAPI: {
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
  }
}

const SERVICE_ORDER: ServiceId[] = ['whatsapp', 'telegram']

function formatLoadError (state: RemoteViewLoadState): string {
  switch (state.errorCode) {
    case 'network':
      return 'Netzwerkfehler beim Laden des Dienstes.'
    case 'crash':
      return 'Der Dienst-Prozess ist abgestürzt. Erneut versuchen, um neu zu starten.'
    case 'abort':
      return 'Ladevorgang abgebrochen.'
    default:
      return state.errorReason ?? 'Dienst konnte nicht geladen werden.'
  }
}

function formatSaveError (saveError?: ConfigChangePayload['saveError']): string {
  switch (saveError) {
    case 'load-write-failed':
      return 'Die Standard-Einstellungen konnten nicht gespeichert werden. Überprüfe Schreibrechte im App-Ordner.'
    case 'toggle-write-failed':
    case 'save-write-failed':
      return 'Die Auswahl konnte nicht gespeichert werden. Überprüfe Schreibrechte im App-Ordner.'
    case 'future-version-readonly':
      return 'Die gespeicherte Einstellungsdatei stammt von einer neueren App-Version. Änderungen werden nicht gespeichert, um Datenverlust zu vermeiden.'
    default:
      return ''
  }
}

function accountSortKey (a: AccountRuntimeState): number {
  const serviceIndex = SERVICE_ORDER.indexOf(a.serviceId)
  return serviceIndex * 1000 + (a.enabled ? 0 : 500)
}

function App (): React.ReactElement {
  const [accounts, setAccounts] = useState<AccountRuntimeState[]>([])
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null)
  const [loadState, setLoadState] = useState<RemoteViewLoadState | null>(null)
  const [saveError, setSaveError] = useState<ConfigChangePayload['saveError']>('none')
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [preferences, setPreferencesState] = useState<AppPreferences>({
    minimizeToTray: false,
    notificationsEnabled: true,
    notificationHideContent: true,
  })
  const [addServiceId, setAddServiceId] = useState<ServiceId | ''>('whatsapp')
  const [addName, setAddName] = useState('')
  const editInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    window.electronAPI.onAccounts((payload) => {
      const mapped = payload.accounts.map(toAccountRuntimeState)
      setAccounts(mapped.sort((a, b) => accountSortKey(a) - accountSortKey(b)))
      setSaveError(payload.saveError ?? 'none')
      if (payload.preferences != null) {
        setPreferencesState(payload.preferences)
      }
    })
    window.electronAPI.onShellState((payload) => {
      setActiveAccountId(payload.activeAccountId)
      setLoadState(payload.loadState)
    })
  }, [])

  useEffect(() => {
    if (editingAccountId != null && editInputRef.current != null) {
      editInputRef.current.focus()
    }
  }, [editingAccountId])

  const startRename = useCallback((account: AccountRuntimeState) => {
    setEditingAccountId(account.accountId)
    setEditName(account.displayName)
  }, [])

  const commitRename = useCallback((accountId: string) => {
    window.electronAPI.renameAccount(accountId, editName)
    setEditingAccountId(null)
    setEditName('')
  }, [editName])

  const cancelRename = useCallback(() => {
    setEditingAccountId(null)
    setEditName('')
  }, [])

  const togglePreference = useCallback(<K extends keyof AppPreferences>(key: K) => {
    const next = { ...preferences, [key]: !preferences[key] }
    setPreferencesState(next)
    window.electronAPI.setPreferences({ [key]: next[key] })
  }, [preferences])

  const handleAdd = useCallback((event: React.FormEvent) => {
    event.preventDefault()
    if (addServiceId === '') return
    window.electronAPI.addAccount(addServiceId, addName)
    setAddName('')
  }, [addServiceId, addName])

  const enabledAccounts = accounts.filter((a) => a.enabled)
  const activeAccount = accounts.find((a) => a.accountId === activeAccountId)
  const saveErrorText = formatSaveError(saveError)

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-name">FM - Sprachbox</span>
        </div>
        <nav className="service-list">
          <button
            className={`service-item ${activeAccountId == null ? 'active' : ''}`}
            onClick={() => window.electronAPI.goHome()}
            type="button"
            title="Startseite"
            aria-label="Startseite"
          >
            🏠 Startseite
          </button>
          {enabledAccounts.map((account) => (
            <button
              key={account.accountId}
              className={`service-item ${activeAccountId === account.accountId ? 'active' : ''}`}
              onClick={() => window.electronAPI.selectAccount(account.accountId)}
              type="button"
              title={getAccountLabel(account)}
              aria-label={getAccountLabel(account)}
            >
              <img
                src={account.icon}
                alt=""
                className="service-item-icon"
                width={20}
                height={20}
              />
              <span className="service-item-label">{getAccountLabel(account)}</span>
            </button>
          ))}
        </nav>
        <footer className="sidebar-footer">
          v0.3.1-p3
        </footer>
      </aside>
      {activeAccountId == null && (
        <main className="home-view">
          <div className="home-card">
            <h1>Konten verwalten</h1>
            <p className="home-intro">
              Aktiviere oder deaktiviere Messenger-Konten. Deaktivierte Konten werden nicht geladen;
              bereits eingeloggte Sitzungen bleiben auf deinem Datenträger erhalten.
            </p>
            {saveErrorText.length > 0 && (
              <p className="config-save-error" role="alert">{saveErrorText}</p>
            )}
            {accounts.length === 0 && (
              <p className="home-hint">Noch keine Konten vorhanden. Füge ein Konto hinzu, um loszulegen.</p>
            )}
            <ul className="service-toggles">
              {accounts.map((account) => (
                <li key={account.accountId} className="service-toggle-row">
                  <div className="service-toggle-info">
                    <img
                      src={account.icon}
                      alt=""
                      className="service-toggle-icon-img"
                      width={28}
                      height={28}
                    />
                    <div className="service-toggle-text">
                      {editingAccountId === account.accountId ? (
                        <input
                          ref={editInputRef}
                          className="service-name-input"
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onBlur={() => commitRename(account.accountId)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              commitRename(account.accountId)
                            } else if (e.key === 'Escape') {
                              cancelRename()
                            }
                          }}
                          maxLength={60}
                          aria-label="Kontoname bearbeiten"
                        />
                      ) : (
                        <button
                          className="service-name-button"
                          type="button"
                          onClick={() => startRename(account)}
                          title={`${getAccountLabel(account)} umbenennen`}
                          aria-label={`${getAccountLabel(account)} umbenennen`}
                        >
                          <strong>{getAccountLabel(account)}</strong>
                        </button>
                      )}
                      <span className="service-toggle-desc">{account.serviceId === 'whatsapp' ? 'WhatsApp Web' : 'Telegram Web K'}</span>
                    </div>
                  </div>
                  <button type="button" className="secondary-button" title={`${getAccountLabel(account)} umbenennen`} aria-label={`${getAccountLabel(account)} umbenennen`} onClick={() => startRename(account)}>✎</button>
                  <button type="button" className="secondary-button" title={`${getAccountLabel(account)} entfernen`} aria-label={`${getAccountLabel(account)} entfernen`} onClick={() => { void window.electronAPI.removeAccount(account.accountId) }}>🗑</button>
                  <input
                    id={`toggle-${account.accountId}`}
                    type="checkbox"
                    checked={account.enabled}
                    onChange={(e) => window.electronAPI.setAccountEnabled(account.accountId, e.target.checked)}
                    aria-label={`${getAccountLabel(account)} ${account.enabled ? 'deaktivieren' : 'aktivieren'}`}
                  />
                </li>
              ))}
            </ul>
            <form className="add-account-form" onSubmit={handleAdd}>
              <div className="add-account-row">
                <label className="add-account-label" htmlFor="add-service">Dienst:</label>
                <select
                  id="add-service"
                  value={addServiceId}
                  onChange={(e) => setAddServiceId(e.target.value as ServiceId)}
                >
                  <option value="whatsapp">WhatsApp</option>
                  <option value="telegram">Telegram</option>
                </select>
                <input
                  id="add-name"
                  type="text"
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                  placeholder="Optionaler Name"
                  maxLength={60}
                  aria-label="Optionaler Kontoname"
                />
                <button className="primary-button" type="submit">Hinzufügen</button>
              </div>
            </form>
            {enabledAccounts.length === 0 && accounts.length > 0 && (
              <p className="home-hint">Aktiviere mindestens ein Konto, um loszulegen.</p>
            )}
            <section className="preferences-section" aria-labelledby="prefs-heading">
              <h2 id="prefs-heading">Einstellungen</h2>
              <ul className="preference-list">
                <li className="preference-row">
                  <div className="preference-info">
                    <strong className="preference-label">Im Hintergrund weiterlaufen</strong>
                    <span className="preference-desc">Beim Schließen in den Tray minimieren statt beenden</span>
                  </div>
                  <input
                    id="pref-minimize-to-tray"
                    type="checkbox"
                    checked={preferences.minimizeToTray}
                    onChange={() => togglePreference('minimizeToTray')}
                    aria-label="Beim Schließen im Hintergrund weiterlaufen"
                  />
                </li>
                <li className="preference-row">
                  <div className="preference-info">
                    <strong className="preference-label">Benachrichtigungen</strong>
                    <span className="preference-desc">Native Toasts für neue Nachrichten</span>
                  </div>
                  <input
                    id="pref-notifications-enabled"
                    type="checkbox"
                    checked={preferences.notificationsEnabled}
                    onChange={() => togglePreference('notificationsEnabled')}
                    aria-label="Benachrichtigungen aktivieren"
                  />
                </li>
                <li className="preference-row">
                  <div className="preference-info">
                    <strong className="preference-label">Nachrichteninhalte ausblenden</strong>
                    <span className="preference-desc">Vorschau nur als „Neue Nachricht“ anzeigen</span>
                  </div>
                  <input
                    id="pref-notification-hide-content"
                    type="checkbox"
                    checked={preferences.notificationHideContent}
                    onChange={() => togglePreference('notificationHideContent')}
                    aria-label="Nachrichteninhalte in Benachrichtigungen ausblenden"
                  />
                </li>
              </ul>
            </section>
          </div>
        </main>
      )}
      {activeAccountId != null && loadState?.failed && (
        <main className="error-overlay">
          <div className="error-card">
            <h2>⚠️ {activeAccount ? getAccountLabel(activeAccount) : 'Konto'} konnte nicht geladen werden</h2>
            <p className="error-detail">{formatLoadError(loadState)}</p>
            <div className="error-actions">
              <button
                className="primary-button"
                onClick={() => activeAccountId && window.electronAPI.selectAccount(activeAccountId)}
                type="button"
              >
                Erneut versuchen
              </button>
              <button
                className="secondary-button"
                onClick={() => window.electronAPI.goHome()}
                type="button"
              >
                Zurück zur Startseite
              </button>
            </div>
          </div>
        </main>
      )}
      {activeAccountId != null && loadState?.loading && (
        <main className="loading-overlay">
          <div className="loading-card">
            <div className="spinner" />
            <p>{activeAccount ? getAccountLabel(activeAccount) : 'Konto'} wird geladen …</p>
          </div>
        </main>
      )}
    </div>
  )
}

export default App
