import { describe, it, expect } from 'vitest'
import { getChromeMajor, buildServiceUserAgent, type UserAgentSource } from '../../src/main/user-agent.js'
import { getServiceDefinition } from '../../src/shared/services.js'

describe('user-agent', () => {
  it('extracts the Chromium major version', () => {
    expect(getChromeMajor('126.0.6478.63')).toBe(126)
    expect(getChromeMajor('100.0.0.0')).toBe(100)
    expect(getChromeMajor('not-a-version')).toBeNull()
  })

  it('returns null when no source is provided', () => {
    const service = getServiceDefinition('whatsapp')
    expect(buildServiceUserAgent(service)).toBeNull()
  })

  it('builds a WhatsApp-specific UA without Electron token', () => {
    const source: UserAgentSource = { chrome: '126.0.6478.63', electron: '44.5.0' }
    const service = getServiceDefinition('whatsapp')
    const ua = buildServiceUserAgent(service, source)
    expect(ua).toContain('Chrome/126.0.6478.63')
    expect(ua).not.toContain('Electron')
    expect(ua).toContain('Mozilla/5.0')
  })

  it('keeps default UA for Telegram', () => {
    const source: UserAgentSource = { chrome: '126.0.6478.63', electron: '44.5.0' }
    const service = getServiceDefinition('telegram')
    const ua = buildServiceUserAgent(service, source)
    expect(ua).toBeNull()
  })

  it('does not invent a Chrome version', () => {
    const source: UserAgentSource = { chrome: '0.0.0.0', electron: '44.5.0' }
    const service = getServiceDefinition('whatsapp')
    const ua = buildServiceUserAgent(service, source)
    expect(ua).toBeNull()
  })
})
