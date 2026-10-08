import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..', '..')
const outDir = path.join(projectRoot, 'out')
const preloadPath = path.join(outDir, 'preload', 'preload.cjs')

/**
 * Build smoke tests only run after `npm run build` has produced `out/`.
 * On a clean checkout `npm run test:unit` therefore skips them; CI runs
 * `npm run build` first and then exercises them.
 */
const describeIfOut = fs.existsSync(outDir) ? describe : describe.skip

/**
 * Build smoke test: execute the produced preload bundle in a minimal Node.js
 * context that fakes the parts of the Electron API it touches. This proves the
 * bundle is syntactically valid CommonJS, calls contextBridge.exposeInMainWorld
 * with the expected API object, and uses only ipcRenderer.send/on.
 */
describeIfOut('build smoke', () => {
  it('produces a CommonJS preload bundle at the expected path', () => {
    expect(fs.existsSync(preloadPath)).toBe(true)
    const content = fs.readFileSync(preloadPath, 'utf8')
    // Must not use ESM import/export syntax at top level.
    expect(content).not.toMatch(/^\s*import\s+/m)
    expect(content).not.toMatch(/^\s*export\s+/m)
    expect(content).toContain('contextBridge.exposeInMainWorld')
    expect(content).toContain("'electronAPI'")
  })

  it('executes the built preload bundle with a fake electron', () => {
    const exposedApis: Array<{ apiName: string; value: unknown }> = []
    const ipcHandlers: Record<string, Array<(...args: unknown[]) => void>> = {}

    const fakeContextBridge = {
      exposeInMainWorld: (apiName: string, value: unknown): void => {
        exposedApis.push({ apiName, value })
      },
    }

    const fakeIpcRenderer = {
      send: (channel: string, ...args: unknown[]): void => {
        const cbs = ipcHandlers[channel] ?? []
        for (const cb of cbs) {
          cb({ senderId: 1 } as unknown as Electron.IpcRendererEvent, ...args)
        }
      },
      on: (channel: string, cb: (...args: unknown[]) => void): void => {
        if (ipcHandlers[channel] == null) ipcHandlers[channel] = []
        ipcHandlers[channel].push(cb)
      },
    }

    // We use Node's module system to load the CJS bundle with the fake deps.
    const moduleCode = fs.readFileSync(preloadPath, 'utf8')
    const factory = new Function('require', 'module', 'exports', moduleCode) as
      (req: unknown, mod: { exports: unknown }, exp: unknown) => void
    const fakeRequire = (id: string): unknown => {
      if (id === 'electron') return { contextBridge: fakeContextBridge, ipcRenderer: fakeIpcRenderer }
      throw new Error(`Unexpected require: ${id}`)
    }
    const fakeModule: { exports: unknown } = { exports: {} }
    factory(fakeRequire, fakeModule, fakeModule.exports)

    expect(exposedApis).toHaveLength(1)
    expect(exposedApis[0].apiName).toBe('electronAPI')

    const api = exposedApis[0].value as {
      selectAccount: (id: string) => void
      onAccounts: (cb: (payload: unknown) => void) => void
      onShellState: (cb: (payload: unknown) => void) => void
    }
    const sent: unknown[][] = []
    ipcHandlers['select-account'] = [(_event, ...args) => sent.push(args)]
    api.selectAccount('legacy-telegram')
    expect(sent).toEqual([['legacy-telegram']])
    const received: unknown[] = []
    api.onAccounts((payload) => received.push(payload))
    api.onShellState((payload) => received.push(payload))
    fakeIpcRenderer.send('accounts', { accounts: [] })
    fakeIpcRenderer.send('shell-state', { activeAccountId: null })
    expect(received).toEqual([{ accounts: [] }, { activeAccountId: null }])
  })

  it('build produces the main entry and renderer output', () => {
    expect(fs.existsSync(path.join(outDir, 'main', 'index.js'))).toBe(true)
    expect(fs.existsSync(path.join(outDir, 'renderer', 'index.html'))).toBe(true)
  })

  it('main bundle references the CJS preload by absolute path', () => {
    const main = fs.readFileSync(path.join(outDir, 'main', 'index.js'), 'utf8')
    expect(main).toContain('preload.cjs')
  })
})
