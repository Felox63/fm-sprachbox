import { describe, it, expect } from 'vitest'
import fs from 'node:fs'

/**
 * Build-independent smoke checks: these run on a clean checkout before any
 * build step, validating project metadata, required scripts and source files.
 */
describe('smoke', () => {
  it('package has required npm scripts', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
    expect(pkg.scripts.lint).toBeDefined()
    expect(pkg.scripts.typecheck).toBeDefined()
    expect(pkg.scripts['test:unit']).toBeDefined()
    expect(pkg.scripts.build).toBeDefined()
    expect(pkg.scripts['dist:win']).toBeDefined()
  })

  it('product metadata is set', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
    expect(pkg.name).toBe('fm-sprachbox')
    expect(pkg.build.productName).toBe('FM - Sprachbox')
    expect(pkg.license).toBe('MIT')
    expect(pkg.private).toBe(true)
  })

  it('renderer source files exist', () => {
    expect(fs.existsSync('src/renderer/index.html')).toBe(true)
    expect(fs.existsSync('src/renderer/main.tsx')).toBe(true)
    expect(fs.existsSync('src/renderer/App.tsx')).toBe(true)
  })

  it('main source files exist', () => {
    expect(fs.existsSync('src/main/index.ts')).toBe(true)
    expect(fs.existsSync('src/main/portable-paths.ts')).toBe(true)
    expect(fs.existsSync('src/main/messenger-view.ts')).toBe(true)
    expect(fs.existsSync('src/main/navigation-policy.ts')).toBe(true)
    expect(fs.existsSync('src/preload/preload.ts')).toBe(true)
  })
})
