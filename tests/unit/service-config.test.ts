import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  getDefaultServiceConfig,
  loadServiceConfig,
  saveServiceConfig,
  setAccountEnabled,
  renameAccount,
  addAccount,
  setSelectedAccountId,
  getAccountProfilePath,
  MAX_CONFIG_FILE_BYTES,
  type ServiceConfigV2,
} from '../../src/main/service-config.js'
import { LEGACY_ACCOUNT_IDS } from '../../src/shared/accounts.js'
import { type PortablePaths } from '../../src/main/portable-paths.js'

function makePaths (root: string): PortablePaths {
  const data = path.join(root, 'data')
  return {
    appRoot: root,
    data,
    logs: path.join(data, 'logs'),
    profiles: path.join(data, 'profiles'),
    temp: path.join(data, 'tmp'),
    cache: path.join(data, 'cache'),
    sessionData: path.join(data, 'session-data'),
    configFile: path.join(data, 'services.json'),
  }
}

function tryRemove (dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

describe('service-config v2', () => {
  const root = path.join(os.tmpdir(), `sprachbox-service-config-${Date.now()}`)
  const paths = makePaths(root)

  beforeEach(() => {
    tryRemove(root)
    fs.mkdirSync(paths.data, { recursive: true })
  })

  afterEach(() => {
    tryRemove(root)
  })

  it('returns v2 defaults when no config file exists and writes it', () => {
    const result = loadServiceConfig(paths)
    expect(result.config.version).toBe(2)
    expect(result.config.accounts).toHaveLength(2)
    expect(result.config.accounts.map((a) => a.accountId)).toContain(LEGACY_ACCOUNT_IDS.whatsapp)
    expect(result.config.accounts.map((a) => a.accountId)).toContain(LEGACY_ACCOUNT_IDS.telegram)
    expect(result.createdDefaults).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.isReadOnly).toBe(false)
    expect(fs.existsSync(paths.configFile)).toBe(true)
  })

  it('loads an existing valid v2 config', () => {
    const written: ServiceConfigV2 = {
      version: 2,
      accounts: [
        { accountId: LEGACY_ACCOUNT_IDS.telegram, serviceId: 'telegram', displayName: '', enabled: true },
      ],
      selectedAccountId: null,
    }
    fs.writeFileSync(paths.configFile, JSON.stringify(written), 'utf8')
    const result = loadServiceConfig(paths)
    expect(result.config.accounts).toHaveLength(1)
    expect(result.config.accounts[0].accountId).toBe(LEGACY_ACCOUNT_IDS.telegram)
    expect(result.ok).toBe(true)
    expect(result.createdDefaults).toBe(false)
    expect(result.isReadOnly).toBe(false)
  })

  it('drops invalid accounts without crashing', () => {
    // bad-id!!! is not a valid UUID and not a legacy id.
    fs.writeFileSync(paths.configFile, JSON.stringify({
      version: 2,
      accounts: [
        { accountId: 'legacy-whatsapp', serviceId: 'whatsapp', displayName: '', enabled: true },
        { accountId: 'bad-id!!!', serviceId: 'telegram', displayName: '', enabled: true },
      ],
      selectedAccountId: null,
    }), 'utf8')
    const result = loadServiceConfig(paths)
    expect(result.createdDefaults).toBe(true)
    expect(result.config.accounts).toHaveLength(2)
  })

  it('rejects v2 config with unknown service id', () => {
    fs.writeFileSync(paths.configFile, JSON.stringify({
      version: 2,
      accounts: [
        { accountId: 'legacy-whatsapp', serviceId: 'signal', displayName: '', enabled: true },
      ],
      selectedAccountId: null,
    }), 'utf8')
    const result = loadServiceConfig(paths)
    expect(result.createdDefaults).toBe(true)
  })

  it('rejects v2 config with duplicate account ids', () => {
    fs.writeFileSync(paths.configFile, JSON.stringify({
      version: 2,
      accounts: [
        { accountId: 'legacy-whatsapp', serviceId: 'whatsapp', displayName: '', enabled: true },
        { accountId: 'legacy-whatsapp', serviceId: 'telegram', displayName: '', enabled: true },
      ],
      selectedAccountId: null,
    }), 'utf8')
    const result = loadServiceConfig(paths)
    expect(result.createdDefaults).toBe(true)
  })

  it('rejects v2 config with wrong legacy-to-service binding', () => {
    fs.writeFileSync(paths.configFile, JSON.stringify({
      version: 2,
      accounts: [
        { accountId: 'legacy-whatsapp', serviceId: 'telegram', displayName: '', enabled: true },
      ],
      selectedAccountId: null,
    }), 'utf8')
    const result = loadServiceConfig(paths)
    expect(result.createdDefaults).toBe(true)
  })

  it('rejects v2 config with more than 20 accounts', () => {
    const accounts = Array.from({ length: 21 }, (_, i) => ({
      accountId: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
      serviceId: 'telegram',
      displayName: '',
      enabled: true,
    }))
    fs.writeFileSync(paths.configFile, JSON.stringify({ version: 2, accounts, selectedAccountId: null }), 'utf8')
    const result = loadServiceConfig(paths)
    expect(result.createdDefaults).toBe(true)
  })

  it('rejects v2 config with unsanitized display name', () => {
    fs.writeFileSync(paths.configFile, JSON.stringify({
      version: 2,
      accounts: [
        { accountId: 'legacy-whatsapp', serviceId: 'whatsapp', displayName: 'X\nY', enabled: true },
      ],
      selectedAccountId: null,
    }), 'utf8')
    const result = loadServiceConfig(paths)
    expect(result.createdDefaults).toBe(true)
  })

  it('rejects selectedAccountId not present in accounts', () => {
    fs.writeFileSync(paths.configFile, JSON.stringify({
      version: 2,
      accounts: [
        { accountId: 'legacy-whatsapp', serviceId: 'whatsapp', displayName: '', enabled: true },
      ],
      selectedAccountId: 'legacy-telegram',
    }), 'utf8')
    const result = loadServiceConfig(paths)
    expect(result.createdDefaults).toBe(true)
  })

  it('resets to defaults when config file is corrupt', () => {
    fs.writeFileSync(paths.configFile, 'not-json', 'utf8')
    const result = loadServiceConfig(paths)
    expect(result.config.version).toBe(2)
    expect(result.createdDefaults).toBe(true)
  })

  it('resets to defaults when config is not an object', () => {
    fs.writeFileSync(paths.configFile, JSON.stringify(['whatsapp']), 'utf8')
    const result = loadServiceConfig(paths)
    expect(result.config.version).toBe(2)
    expect(result.createdDefaults).toBe(true)
  })

  it('migrates a v1 config to v2 with stable legacy ids', () => {
    fs.writeFileSync(paths.configFile, JSON.stringify({ version: 1, enabled: ['telegram'] }), 'utf8')
    const result = loadServiceConfig(paths)
    expect(result.config.version).toBe(2)
    const telegram = result.config.accounts.find((a) => a.serviceId === 'telegram')
    const whatsapp = result.config.accounts.find((a) => a.serviceId === 'whatsapp')
    expect(telegram?.enabled).toBe(true)
    expect(whatsapp?.enabled).toBe(false)
    expect(telegram?.accountId).toBe(LEGACY_ACCOUNT_IDS.telegram)
    expect(whatsapp?.accountId).toBe(LEGACY_ACCOUNT_IDS.whatsapp)
  })

  it('migrates a v1 config with empty enabled list exactly', () => {
    fs.writeFileSync(paths.configFile, JSON.stringify({ version: 1, enabled: [] }), 'utf8')
    const result = loadServiceConfig(paths)
    expect(result.config.accounts.every((a) => !a.enabled)).toBe(true)
  })

  it('migrates a legacy config without version', () => {
    fs.writeFileSync(paths.configFile, JSON.stringify({ enabled: ['whatsapp'] }), 'utf8')
    const result = loadServiceConfig(paths)
    expect(result.config.version).toBe(2)
    expect(result.config.accounts.find((a) => a.serviceId === 'whatsapp')?.enabled).toBe(true)
    expect(result.config.accounts.find((a) => a.serviceId === 'telegram')?.enabled).toBe(false)
  })

  it('backs up v1 original before migration', () => {
    const original = JSON.stringify({ version: 1, enabled: ['telegram'] })
    fs.writeFileSync(paths.configFile, original, 'utf8')
    loadServiceConfig(paths)
    const backups = fs.readdirSync(paths.data).filter((name) => name.startsWith('services.json.v1-backup-'))
    expect(backups.length).toBe(1)
    const backupContent = fs.readFileSync(path.join(paths.data, backups[0]), 'utf8')
    expect(backupContent).toBe(original)
  })

  it('idempotent migration: second load keeps migrated v2, no extra backups', () => {
    fs.writeFileSync(paths.configFile, JSON.stringify({ version: 1, enabled: ['telegram'] }), 'utf8')
    loadServiceConfig(paths)
    const firstBackups = fs.readdirSync(paths.data).filter((name) => name.startsWith('services.json.v1-backup-'))
    expect(firstBackups.length).toBe(1)

    const result = loadServiceConfig(paths)
    expect(result.config.version).toBe(2)
    expect(result.createdDefaults).toBe(false)
    const secondBackups = fs.readdirSync(paths.data).filter((name) => name.startsWith('services.json.v1-backup-'))
    expect(secondBackups.length).toBe(1)
  })

  it('does not silently overwrite unknown future config version', () => {
    const original = JSON.stringify({ version: 99, accounts: [], selectedAccountId: null })
    fs.writeFileSync(paths.configFile, original, 'utf8')
    const result = loadServiceConfig(paths)
    expect(result.isReadOnly).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.config.accounts).toHaveLength(2)
    expect(fs.readFileSync(paths.configFile, 'utf8')).toBe(original)
  })

  it('rejects oversized config files', () => {
    const huge = 'x'.repeat(MAX_CONFIG_FILE_BYTES + 1)
    fs.writeFileSync(paths.configFile, huge, 'utf8')
    const result = loadServiceConfig(paths)
    expect(result.createdDefaults).toBe(true)
  })

  it('saves v2 config atomically', () => {
    const config = getDefaultServiceConfig()
    const result = saveServiceConfig(paths, config)
    expect(result.ok).toBe(true)
    const onDisk = JSON.parse(fs.readFileSync(paths.configFile, 'utf8')) as ServiceConfigV2
    expect(onDisk.version).toBe(2)
    expect(onDisk.accounts).toHaveLength(2)
  })

  it('refuses to save invalid v2 config', () => {
    const config = getDefaultServiceConfig()
    // @ts-expect-error intentional invalid binding
    config.accounts[0].serviceId = 'telegram'
    const result = saveServiceConfig(paths, config)
    expect(result.ok).toBe(false)
  })

  it('toggle account enabled updates config without touching id/path', () => {
    const config = getDefaultServiceConfig()
    const updated = setAccountEnabled(config, LEGACY_ACCOUNT_IDS.whatsapp, false)
    expect(updated.accounts.find((a) => a.accountId === LEGACY_ACCOUNT_IDS.whatsapp)?.enabled).toBe(false)
    expect(updated.accounts.find((a) => a.accountId === LEGACY_ACCOUNT_IDS.telegram)?.enabled).toBe(true)
  })

  it('rename changes only displayName', () => {
    const config = getDefaultServiceConfig()
    const updated = renameAccount(config, LEGACY_ACCOUNT_IDS.telegram, 'Privat')
    const telegram = updated.accounts.find((a) => a.accountId === LEGACY_ACCOUNT_IDS.telegram)
    expect(telegram?.displayName).toBe('Privat')
    expect(telegram?.serviceId).toBe('telegram')
    expect(telegram?.enabled).toBe(true)
  })

  it('sanitize displayName on rename', () => {
    const config = getDefaultServiceConfig()
    const updated = renameAccount(config, LEGACY_ACCOUNT_IDS.whatsapp, '  Felix\n<script>  ')
    const name = updated.accounts.find((a) => a.accountId === LEGACY_ACCOUNT_IDS.whatsapp)?.displayName
    expect(name).toBe('Felix<script>')
  })

  it('adds a new account with random id and keeps legacy accounts', () => {
    const config = getDefaultServiceConfig()
    const updated = addAccount(config, 'telegram', 'Zweitaccount')
    expect(updated).not.toBeNull()
    expect(updated!.accounts).toHaveLength(3)
    const added = updated!.accounts.find((a) => a.displayName === 'Zweitaccount')
    expect(added?.serviceId).toBe('telegram')
    expect(added?.accountId).not.toBe(LEGACY_ACCOUNT_IDS.telegram)
    expect(added?.accountId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  })

  it('enforces max account limit', () => {
    let config = getDefaultServiceConfig()
    for (let i = 0; i < 30; i++) {
      const next = addAccount(config, 'telegram')
      if (next == null) break
      config = next
    }
    expect(config.accounts.length).toBeLessThanOrEqual(20)
  })

  it('preserves selectedAccountId through save/load roundtrip', () => {
    const config = setSelectedAccountId(getDefaultServiceConfig(), LEGACY_ACCOUNT_IDS.whatsapp)
    saveServiceConfig(paths, config)
    const loaded = loadServiceConfig(paths)
    expect(loaded.config.selectedAccountId).toBe(LEGACY_ACCOUNT_IDS.whatsapp)
  })

  it('legacy profile path stays at data/profiles/<serviceId>', () => {
    const p = getAccountProfilePath(LEGACY_ACCOUNT_IDS.whatsapp, paths)
    expect(p).toBe(path.join(paths.profiles, 'whatsapp'))
  })

  it('new account profile path goes to data/profiles/accounts/<accountId>', () => {
    const p = getAccountProfilePath('12345678-1234-1234-1234-1234567890ab', paths)
    expect(p).toBe(path.join(paths.profiles, 'accounts', '12345678-1234-1234-1234-1234567890ab'))
  })

  it('getAccountProfilePath throws on invalid account id', () => {
    expect(() => getAccountProfilePath('../../etc/passwd', paths)).toThrow()
    expect(() => getAccountProfilePath('', paths)).toThrow()
    expect(() => getAccountProfilePath('not-a-uuid', paths)).toThrow()
  })

  it('reports load-time default write failure without throwing', () => {
    const blockingFile = path.join(paths.data, 'blocking-file')
    const badPaths: PortablePaths = {
      ...paths,
      configFile: path.join(blockingFile, 'services.json'),
    }
    fs.writeFileSync(blockingFile, 'I am a file', 'utf8')
    const result = loadServiceConfig(badPaths)
    expect(result.config.version).toBe(2)
    expect(result.createdDefaults).toBe(true)
    expect(result.ok).toBe(false)
  })

  it('handles write errors gracefully without throwing', () => {
    const blockingFile = path.join(paths.data, 'blocking-file')
    const badPaths: PortablePaths = {
      ...paths,
      configFile: path.join(blockingFile, 'services.json'),
    }
    fs.writeFileSync(blockingFile, 'I am a file', 'utf8')
    const config = getDefaultServiceConfig()
    const result = saveServiceConfig(badPaths, config)
    expect(result.ok).toBe(false)
  })

  it('handles write errors gracefully without throwing', () => {
    const blockingFile = path.join(paths.data, 'blocking-file')
    const badPaths: PortablePaths = {
      ...paths,
      configFile: path.join(blockingFile, 'services.json'),
    }
    fs.writeFileSync(blockingFile, 'I am a file', 'utf8')
    const config = getDefaultServiceConfig()
    const result = saveServiceConfig(badPaths, config)
    expect(result.ok).toBe(false)
  })

  it('load-time default write failure reports ok:false without throwing', () => {
    const blockingFile = path.join(paths.data, 'blocking-file')
    const badPaths: PortablePaths = {
      ...paths,
      configFile: path.join(blockingFile, 'services.json'),
    }
    fs.writeFileSync(blockingFile, 'I am a file', 'utf8')
    const result = loadServiceConfig(badPaths)
    expect(result.config.version).toBe(2)
    expect(result.createdDefaults).toBe(true)
    expect(result.ok).toBe(false)
  })
})