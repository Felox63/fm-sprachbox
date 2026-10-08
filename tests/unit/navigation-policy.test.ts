import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  isAllowedServiceNavigation,
  isAllowedShellNavigation,
  isAllowedExternalUrl,
} from '../../src/main/navigation-policy.js'
import { SUPPORTED_SERVICES } from '../../src/shared/services.js'

const whatsapp = SUPPORTED_SERVICES.find((s) => s.id === 'whatsapp')!
const telegram = SUPPORTED_SERVICES.find((s) => s.id === 'telegram')!

describe('navigation-policy', () => {
  describe('isAllowedServiceNavigation', () => {
    it('allows the service origin and paths', () => {
      expect(isAllowedServiceNavigation(whatsapp, 'https://web.whatsapp.com/')).toBe(true)
      expect(isAllowedServiceNavigation(whatsapp, 'https://web.whatsapp.com/chat')).toBe(true)
    })

    it('allows about:blank', () => {
      expect(isAllowedServiceNavigation(whatsapp, 'about:blank')).toBe(true)
    })

    it('blocks a different service origin', () => {
      expect(isAllowedServiceNavigation(whatsapp, 'https://web.telegram.org/k/')).toBe(false)
      expect(isAllowedServiceNavigation(telegram, 'https://web.whatsapp.com/')).toBe(false)
    })

    it('blocks lookalike hosts', () => {
      expect(isAllowedServiceNavigation(whatsapp, 'https://web.whatsapp.com.evil.com/')).toBe(false)
      expect(isAllowedServiceNavigation(whatsapp, 'https://whatsapp.com/')).toBe(false)
      expect(isAllowedServiceNavigation(whatsapp, 'https://web-whatsapp.com/')).toBe(false)
    })

    it('blocks non-http protocols', () => {
      expect(isAllowedServiceNavigation(whatsapp, 'file:///etc/passwd')).toBe(false)
      expect(isAllowedServiceNavigation(whatsapp, 'javascript:alert(1)')).toBe(false)
      expect(isAllowedServiceNavigation(whatsapp, 'data:text/html,foo')).toBe(false)
    })

    it('blocks invalid URLs', () => {
      expect(isAllowedServiceNavigation(whatsapp, 'not a url')).toBe(false)
    })
  })

  describe('isAllowedShellNavigation', () => {
    const rendererRoot = '/out/renderer'

    it('allows its own index.html', () => {
      expect(isAllowedShellNavigation(rendererRoot, 'file:///out/renderer/index.html')).toBe(true)
    })

    it('blocks other files inside the renderer root', () => {
      expect(isAllowedShellNavigation(rendererRoot, 'file:///out/renderer/assets/index.js')).toBe(false)
      expect(isAllowedShellNavigation(rendererRoot, 'file:///out/renderer/assets/nested/icon.svg')).toBe(false)
      expect(isAllowedShellNavigation(rendererRoot, 'file:///out/renderer/main.js')).toBe(false)
    })

    it('blocks the renderer root directory itself', () => {
      expect(isAllowedShellNavigation(rendererRoot, 'file:///out/renderer')).toBe(false)
      expect(isAllowedShellNavigation(rendererRoot, 'file:///out/renderer/')).toBe(false)
    })

    it('blocks other file paths', () => {
      expect(isAllowedShellNavigation(rendererRoot, 'file:///etc/passwd')).toBe(false)
      expect(isAllowedShellNavigation(rendererRoot, 'file:///out/main/index.js')).toBe(false)
      expect(isAllowedShellNavigation(rendererRoot, 'file:///out/renderer-evil/index.html')).toBe(false)
    })

    it('blocks directory traversal', () => {
      expect(isAllowedShellNavigation(rendererRoot, 'file:///out/renderer/../main/index.js')).toBe(false)
      expect(isAllowedShellNavigation(rendererRoot, 'file:///out/renderer/../../etc/passwd')).toBe(false)
    })

    it('blocks encoded traversal attempts', () => {
      expect(isAllowedShellNavigation(rendererRoot, 'file:///out/renderer/%2e%2e/main.js')).toBe(false)
      expect(isAllowedShellNavigation(rendererRoot, 'file:///out/renderer/%2e.%2f../main.js')).toBe(false)
    })

    it('blocks query strings on shell URLs', () => {
      expect(isAllowedShellNavigation(rendererRoot, 'file:///out/renderer/index.html?foo=bar')).toBe(false)
    })

    it('allows fragments on shell index.html', () => {
      expect(isAllowedShellNavigation(rendererRoot, 'file:///out/renderer/index.html#settings')).toBe(true)
    })

    it('blocks fragments on other files', () => {
      expect(isAllowedShellNavigation(rendererRoot, 'file:///out/renderer/assets/index.js#settings')).toBe(false)
    })

    it('blocks non-file protocols', () => {
      expect(isAllowedShellNavigation(rendererRoot, 'https://example.com')).toBe(false)
      expect(isAllowedShellNavigation(rendererRoot, 'javascript:alert(1)')).toBe(false)
    })

    it('handles spaces and unicode in the index path', () => {
      const root = '/out/日本語 renderer'
      const index = pathToFileURL(path.join(root, 'index.html')).href
      expect(isAllowedShellNavigation(root, index)).toBe(true)

      const asset = pathToFileURL(path.join(root, 'assets', 'icon 日本語.svg')).href
      expect(isAllowedShellNavigation(root, asset)).toBe(false)
    })

    it('handles Windows absolute index path', () => {
      // pathToFileURL on Linux cannot produce file:///C:/... from a Windows
      // string because the drive letter is treated as a relative path segment.
      // We therefore compare the canonical string the helper produces on this
      // platform against the same canonical string as target.
      const root = 'C:\\Program Files\\FM - Sprachbox\\resources\\renderer'
      const index = pathToFileURL(path.join(root, 'index.html')).href
      expect(isAllowedShellNavigation(root, index)).toBe(true)

      const foreignRoot = 'C:\\Windows\\System32'
      const foreign = pathToFileURL(path.join(foreignRoot, 'calc.exe')).href
      expect(isAllowedShellNavigation(root, foreign)).toBe(false)
    })

    it('blocks traversal that resolves to index.html of a sibling directory', () => {
      expect(isAllowedShellNavigation(rendererRoot, 'file:///out/renderer/../renderer-evil/index.html')).toBe(false)
    })
  })

  describe('isAllowedExternalUrl', () => {
    it('blocks every external URL in package 1', () => {
      expect(isAllowedExternalUrl('https://example.com')).toBe(false)
      expect(isAllowedExternalUrl('http://example.com')).toBe(false)
      expect(isAllowedExternalUrl('mailto:md@merkeldesign.biz')).toBe(false)
    })
  })
})
