import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import {
  type ServiceId,
  ALL_SERVICE_IDS,
  isKnownServiceId,
  DEFAULT_ENABLED_SERVICE_IDS,
} from '../shared/services.js'
import {
  type AccountDefinition,
  LEGACY_ACCOUNT_IDS,
  isValidAccountId,
  sanitizeDisplayName,
  MAX_ACCOUNTS,
  getLegacyServiceId,
  ACCOUNT_ID_MAX_LENGTH,
} from '../shared/accounts.js'
import { type PortablePaths } from './portable-paths.js'

export interface ServiceConfigV2 {
  version: 2
  accounts: AccountDefinition[]
  /** Last selected account id (optional; home when null/missing). */
  selectedAccountId: string | null
  /** Global app preferences. Missing fields use defaults. */
  preferences?: AppPreferences
}

export interface AppPreferences {
  /** Hide the app to tray instead of quitting when the user closes the window. */
  minimizeToTray: boolean
  /** Show native notification toasts for unread messages. */
  notificationsEnabled: boolean
  /** Do not include message snippets in notification bodies (privacy default). */
  notificationHideContent: boolean
}

export interface SaveResult {
  ok: boolean
  config: ServiceConfigV2
  /** True only when the file was newly created from defaults. */
  createdDefaults: boolean
  /** True when the on-disk config is a future/unknown version and must not be overwritten. */
  isReadOnly: boolean
}

export const SERVICE_CONFIG_VERSION = 2
export const MAX_CONFIG_FILE_BYTES = 64 * 1024

export const DEFAULT_PREFERENCES: AppPreferences = {
  minimizeToTray: false,
  notificationsEnabled: true,
  notificationHideContent: true,
}

export function getDefaultServiceConfig (): ServiceConfigV2 {
  const accounts: AccountDefinition[] = ALL_SERVICE_IDS.map((serviceId) => ({
    accountId: LEGACY_ACCOUNT_IDS[serviceId],
    serviceId,
    displayName: '',
    enabled: DEFAULT_ENABLED_SERVICE_IDS.includes(serviceId),
  }))
  return {
    version: SERVICE_CONFIG_VERSION,
    accounts,
    selectedAccountId: null,
    preferences: { ...DEFAULT_PREFERENCES },
  }
}

function normalizePreferences (raw: unknown): AppPreferences {
  if (typeof raw !== 'object' || raw == null || Array.isArray(raw)) {
    return { ...DEFAULT_PREFERENCES }
  }
  const obj = raw as Record<string, unknown>
  return {
    minimizeToTray: typeof obj.minimizeToTray === 'boolean' ? obj.minimizeToTray : DEFAULT_PREFERENCES.minimizeToTray,
    notificationsEnabled: typeof obj.notificationsEnabled === 'boolean' ? obj.notificationsEnabled : DEFAULT_PREFERENCES.notificationsEnabled,
    notificationHideContent: typeof obj.notificationHideContent === 'boolean' ? obj.notificationHideContent : DEFAULT_PREFERENCES.notificationHideContent,
  }
}

function readJsonFile (filePath: string): { value: unknown | null; error: boolean } {
  try {
    const stats = fs.statSync(filePath)
    if (!stats.isFile()) return { value: null, error: true }
    if (stats.size > MAX_CONFIG_FILE_BYTES) return { value: null, error: true }
    const content = fs.readFileSync(filePath, 'utf8')
    return { value: JSON.parse(content) as unknown, error: false }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { value: null, error: false }
    return { value: null, error: true }
  }
}

function writeJsonFile (filePath: string, value: unknown): boolean {
  try {
    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true })
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(tmpPath, filePath)
    return true
  } catch {
    return false
  }
}

function hasUniqueAccountIds (accounts: readonly AccountDefinition[]): boolean {
  const seen = new Set<string>()
  for (const a of accounts) {
    if (seen.has(a.accountId)) return false
    seen.add(a.accountId)
  }
  return true
}

function hasValidLegacyBinding (account: AccountDefinition): boolean {
  const legacyServiceId = getLegacyServiceId(account.accountId)
  if (legacyServiceId == null) return true
  return legacyServiceId === account.serviceId
}

function isValidServiceConfigV2 (parsed: unknown): parsed is ServiceConfigV2 {
  if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) return false
  const obj = parsed as Record<string, unknown>
  if (obj.version !== 2) return false
  if (!Array.isArray(obj.accounts)) return false
  if (obj.accounts.length > MAX_ACCOUNTS) return false
  if (obj.selectedAccountId != null && typeof obj.selectedAccountId !== 'string') return false
  const preferences = normalizePreferences(obj.preferences)
  const accounts: AccountDefinition[] = []
  for (const item of obj.accounts) {
    if (typeof item !== 'object' || item == null || Array.isArray(item)) return false
    const acct = item as Record<string, unknown>
    if (!isValidAccountId(acct.accountId)) return false
    if (!isKnownServiceId(acct.serviceId)) return false
    if (typeof acct.displayName !== 'string') return false
    if (typeof acct.enabled !== 'boolean') return false
    if (acct.displayName !== sanitizeDisplayName(acct.displayName)) return false
    accounts.push({
      accountId: acct.accountId,
      serviceId: acct.serviceId as ServiceId,
      displayName: acct.displayName,
      enabled: acct.enabled,
    })
  }
  if (!hasUniqueAccountIds(accounts)) return false
  for (const a of accounts) {
    if (!hasValidLegacyBinding(a)) return false
  }
  if (obj.selectedAccountId != null) {
    if (!isValidAccountId(obj.selectedAccountId)) return false
    if (!accounts.some((a) => a.accountId === obj.selectedAccountId)) return false
  }
  ;(parsed as unknown as ServiceConfigV2).preferences = preferences
  return true
}

function migrateV1ToV2 (parsed: Record<string, unknown>): ServiceConfigV2 {
  const enabledIds = normalizeEnabledIds(parsed.enabled)
  const accounts: AccountDefinition[] = ALL_SERVICE_IDS.map((serviceId) => ({
    accountId: LEGACY_ACCOUNT_IDS[serviceId],
    serviceId,
    displayName: '',
    enabled: enabledIds.includes(serviceId),
  }))
  return {
    version: SERVICE_CONFIG_VERSION,
    accounts,
    selectedAccountId: null,
    preferences: { ...DEFAULT_PREFERENCES },
  }
}

function normalizeEnabledIds (raw: unknown): ServiceId[] {
  if (!Array.isArray(raw)) return [...DEFAULT_ENABLED_SERVICE_IDS]
  const normalized: ServiceId[] = []
  for (const item of raw) {
    if (isKnownServiceId(item)) {
      normalized.push(item)
    }
  }
  return normalized
}

function backupOriginalConfig (paths: PortablePaths): boolean {
  try {
    const original = fs.readFileSync(paths.configFile)
    const backupPath = `${paths.configFile}.v1-backup-${Date.now()}`
    fs.writeFileSync(backupPath, original, { flag: 'wx' })
    return true
  } catch {
    return false
  }
}

function readConfig (paths: PortablePaths): { config: ServiceConfigV2; createdDefaults: boolean; isFutureVersion: boolean; isLegacyMigration: boolean } {
  const { value: parsed, error: readError } = readJsonFile(paths.configFile)
  if (readError || parsed == null) {
    return { config: getDefaultServiceConfig(), createdDefaults: true, isFutureVersion: false, isLegacyMigration: false }
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed == null) {
    return { config: getDefaultServiceConfig(), createdDefaults: true, isFutureVersion: false, isLegacyMigration: false }
  }
  const obj = parsed as Record<string, unknown>
  const version = typeof obj.version === 'number' ? Math.floor(obj.version) : 0
  if (version === 2) {
    if (isValidServiceConfigV2(parsed)) {
      return { config: parsed as ServiceConfigV2, createdDefaults: false, isFutureVersion: false, isLegacyMigration: false }
    }
    // A version 2 file that fails validation is treated as corrupt and reset.
    return { config: getDefaultServiceConfig(), createdDefaults: true, isFutureVersion: false, isLegacyMigration: false }
  }
  if (version < 2) {
    return { config: migrateV1ToV2(obj), createdDefaults: false, isFutureVersion: false, isLegacyMigration: true }
  }
  // Unknown future version: do not silently overwrite; fall back to defaults in
  // memory but do not claim they came from disk. Preserve the original file.
  return { config: getDefaultServiceConfig(), createdDefaults: false, isFutureVersion: true, isLegacyMigration: false }
}

/**
 * Load the persisted service configuration. If the file is missing, corrupt or an
 * unsupported future version, default config is returned. A failed write of the
 * default config is reported via the SaveResult so the caller can surface a UI
 * warning, but the app still starts with the in-memory defaults.
 *
 * For legacy v1 configs the original file is backed up once before the migrated
 * v2 file is written. If writing fails, the migrated config remains in memory.
 */
export function loadServiceConfig (paths: PortablePaths): SaveResult {
  const { config, createdDefaults, isFutureVersion, isLegacyMigration } = readConfig(paths)

  if (isFutureVersion) {
    // Future config must never be overwritten by any runtime action. Return the
    // in-memory defaults read-only so the app starts, but report ok:false so the
    // UI can show a warning and block writes.
    return { ok: false, config, createdDefaults: false, isReadOnly: true }
  }

  if (!createdDefaults) {
    // v2 from disk or freshly migrated v1 in memory. For v1, backup original
    // and atomically write migrated v2.
    if (isLegacyMigration) {
      if (!backupOriginalConfig(paths)) {
        return { ok: false, config, createdDefaults: false, isReadOnly: true }
      }
      const written = writeJsonFile(paths.configFile, config)
      return { ok: written, config, createdDefaults: false, isReadOnly: !written }
    }
    return { ok: true, config, createdDefaults: false, isReadOnly: false }
  }

  const written = writeJsonFile(paths.configFile, config)
  return { ok: written, config, createdDefaults: true, isReadOnly: false }
}

/**
 * Save the configuration atomically. On write failure the caller receives ok:false
 * and the previous in-memory config should be kept so the UI does not pretend a
 * change persisted. On success the canonical config is returned.
 */
export function saveServiceConfig (paths: PortablePaths, config: ServiceConfigV2): SaveResult {
  // Recheck the disk before every write: runtime actions must not overwrite a
  // future config or bypass an unsuccessful legacy backup/migration.
  const current = readConfig(paths)
  if (current.isFutureVersion || current.isLegacyMigration) {
    return { ok: false, config, createdDefaults: false, isReadOnly: true }
  }
  if (!isValidServiceConfigV2(config)) {
    return { ok: false, config, createdDefaults: false, isReadOnly: false }
  }
  const toWrite: ServiceConfigV2 = {
    version: SERVICE_CONFIG_VERSION,
    accounts: config.accounts.map((a) => ({
      accountId: a.accountId,
      serviceId: a.serviceId,
      displayName: sanitizeDisplayName(a.displayName),
      enabled: a.enabled,
    })),
    selectedAccountId: config.selectedAccountId,
    preferences: config.preferences != null ? normalizePreferences(config.preferences) : { ...DEFAULT_PREFERENCES },
  }
  const written = writeJsonFile(paths.configFile, toWrite)
  return { ok: written, config: toWrite, createdDefaults: false, isReadOnly: false }
}

export function isAccountEnabled (config: ServiceConfigV2, accountId: string): boolean {
  return config.accounts.some((a) => a.accountId === accountId && a.enabled)
}

export function setAccountEnabled (
  config: ServiceConfigV2,
  accountId: string,
  enabled: boolean,
): ServiceConfigV2 {
  return {
    ...config,
    accounts: config.accounts.map((a) =>
      a.accountId === accountId ? { ...a, enabled } : a,
    ),
  }
}

export function renameAccount (
  config: ServiceConfigV2,
  accountId: string,
  displayName: string,
): ServiceConfigV2 {
  const sanitized = sanitizeDisplayName(displayName)
  return {
    ...config,
    accounts: config.accounts.map((a) =>
      a.accountId === accountId ? { ...a, displayName: sanitized } : a,
    ),
  }
}

export function addAccount (
  config: ServiceConfigV2,
  serviceId: ServiceId,
  displayName?: string,
): ServiceConfigV2 | null {
  if (config.accounts.length >= MAX_ACCOUNTS) return null
  const newAccount: AccountDefinition = {
    accountId: crypto.randomUUID(),
    serviceId,
    displayName: sanitizeDisplayName(displayName ?? ''),
    enabled: true,
  }
  return {
    ...config,
    accounts: [...config.accounts, newAccount],
  }
}

export function setSelectedAccountId (
  config: ServiceConfigV2,
  accountId: string | null,
): ServiceConfigV2 {
  return {
    ...config,
    selectedAccountId: accountId,
  }
}

export function setAppPreferences (
  config: ServiceConfigV2,
  patch: Partial<AppPreferences>,
): ServiceConfigV2 {
  return {
    ...config,
    preferences: normalizePreferences({ ...(config.preferences ?? {}), ...patch }),
  }
}

/**
 * Resolve the isolated profile directory for an account. Validates the id before
 * joining any path so callers cannot turn account ids into path traversal.
 */
export function getAccountProfilePath (accountId: string, paths: PortablePaths): string {
  const preview = accountId.slice(0, ACCOUNT_ID_MAX_LENGTH)
  if (!isValidAccountId(accountId)) {
    throw new Error(`Invalid account id for profile path: ${preview}`)
  }
  const legacyServiceId = getLegacyServiceId(accountId)
  if (legacyServiceId != null) {
    return path.join(paths.profiles, legacyServiceId)
  }
  return path.join(paths.profiles, 'accounts', accountId)
}