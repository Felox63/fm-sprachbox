import { type ServiceId, getServiceDefinition } from './services.js'

export interface AccountDefinition {
  /** Stable, main-process-generated account id. Never derived from name. */
  accountId: string
  serviceId: ServiceId
  displayName: string
  enabled: boolean
}

export interface AccountRuntimeState {
  accountId: string
  serviceId: ServiceId
  serviceLabel: string
  displayName: string
  enabled: boolean
  /** Relative icon asset path, resolved at runtime by the shell. */
  icon: string
}

export const MAX_ACCOUNTS = 20
export const MAX_DISPLAY_NAME_LENGTH = 60
export const ACCOUNT_ID_MAX_LENGTH = 64

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Reserved legacy account ids that map to the original per-service profiles. */
export const LEGACY_ACCOUNT_IDS: Record<ServiceId, string> = {
  whatsapp: 'legacy-whatsapp',
  telegram: 'legacy-telegram',
}

/** Stable service icon asset names. Kept inside the project; no external CDN. */
export const SERVICE_ICON_ASSETS: Record<ServiceId, string> = {
  whatsapp: 'assets/service-icons/whatsapp.svg',
  telegram: 'assets/service-icons/telegram.svg',
}

export type { ServiceId } from './services.js'
export { isKnownServiceId } from './services.js'

export function isLegacyAccountId (accountId: string): accountId is string {
  return Object.values(LEGACY_ACCOUNT_IDS).includes(accountId)
}

export function getLegacyServiceId (accountId: string): ServiceId | null {
  for (const [serviceId, legacyId] of Object.entries(LEGACY_ACCOUNT_IDS)) {
    if (legacyId === accountId) return serviceId as ServiceId
  }
  return null
}

export function isValidAccountId (value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > 64) return false
  // Accept either a main-process UUID or a reserved legacy id.
  return UUID_RE.test(value) || isLegacyAccountId(value)
}

export function sanitizeDisplayName (value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  const limited = trimmed.slice(0, MAX_DISPLAY_NAME_LENGTH)
  // Remove control characters and line breaks; keep normal printable unicode.
  return limited.replace(/[\x00-\x1f\x7f\x80-\x9f]/g, '')
}

export function toAccountRuntimeState (account: AccountDefinition): AccountRuntimeState {
  const service = getServiceDefinition(account.serviceId)
  return {
    accountId: account.accountId,
    serviceId: account.serviceId,
    serviceLabel: service.label,
    displayName: account.displayName,
    enabled: account.enabled,
    icon: SERVICE_ICON_ASSETS[account.serviceId],
  }
}

export function toAccountRuntimeStates (accounts: readonly AccountDefinition[]): AccountRuntimeState[] {
  return accounts.map(toAccountRuntimeState)
}

export function getAccountLabel (state: AccountRuntimeState): string {
  if (state.displayName.length === 0) return state.serviceLabel
  return `${state.serviceLabel} – ${state.displayName}`
}

/** Format a unique account name suggestion for a service (e.g. "Telegram 2"). */
export function suggestAccountName (accounts: readonly AccountDefinition[], serviceId: ServiceId): string {
  const service = getServiceDefinition(serviceId)
  const sameServiceCount = accounts.filter((a) => a.serviceId === serviceId).length
  if (sameServiceCount === 0) return ''
  return `${service.label} ${sameServiceCount + 1}`
}
