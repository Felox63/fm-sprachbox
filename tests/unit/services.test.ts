import { describe, it, expect } from 'vitest'
import {
  ALL_SERVICE_IDS,
  DEFAULT_ENABLED_SERVICE_IDS,
  V1_SERVICE_IDS,
  getServiceDefinition,
  getAllowedServiceOrigins,
  isKnownServiceId,
} from '../../src/shared/services.js'

describe('SUPPORTED_SERVICES', () => {
  it('includes the original whatsapp and telegram services', () => {
    expect(ALL_SERVICE_IDS).toContain('whatsapp')
    expect(ALL_SERVICE_IDS).toContain('telegram')
  })

  it('includes the new slack, discord and whatsapp-business services', () => {
    expect(ALL_SERVICE_IDS).toContain('slack')
    expect(ALL_SERVICE_IDS).toContain('discord')
    expect(ALL_SERVICE_IDS).toContain('whatsapp-business')
  })

  it('only enables whatsapp and telegram by default', () => {
    expect(DEFAULT_ENABLED_SERVICE_IDS).toEqual(['whatsapp', 'telegram'])
  })

  it('only whatsapp and telegram are v1 services with legacy accounts', () => {
    expect(V1_SERVICE_IDS).toEqual(['whatsapp', 'telegram'])
  })

  it('rejects unknown service ids', () => {
    expect(isKnownServiceId('signal')).toBe(false)
    expect(isKnownServiceId('')).toBe(false)
    expect(isKnownServiceId(123)).toBe(false)
  })
})

describe('getServiceDefinition', () => {
  it('returns the correct labels and URLs', () => {
    expect(getServiceDefinition('whatsapp').label).toBe('WhatsApp')
    expect(getServiceDefinition('telegram').label).toBe('Telegram')
    expect(getServiceDefinition('slack').label).toBe('Slack')
    expect(getServiceDefinition('discord').label).toBe('Discord')
    expect(getServiceDefinition('whatsapp-business').label).toBe('WhatsApp Business')
  })

  it('whatsapp and whatsapp-business share the same web UI URL', () => {
    expect(getServiceDefinition('whatsapp').url).toBe('https://web.whatsapp.com')
    expect(getServiceDefinition('whatsapp-business').url).toBe('https://web.whatsapp.com')
  })

  it('new services are not enabled by default', () => {
    expect(getServiceDefinition('slack').defaultEnabled).toBe(false)
    expect(getServiceDefinition('discord').defaultEnabled).toBe(false)
    expect(getServiceDefinition('whatsapp-business').defaultEnabled).toBe(false)
  })
})

describe('getAllowedServiceOrigins', () => {
  it('returns the service URL origin when no extra origins are declared', () => {
    expect(getAllowedServiceOrigins(getServiceDefinition('whatsapp'))).toEqual(['https://web.whatsapp.com'])
    expect(getAllowedServiceOrigins(getServiceDefinition('telegram'))).toEqual(['https://web.telegram.org'])
    expect(getAllowedServiceOrigins(getServiceDefinition('discord'))).toEqual(['https://discord.com'])
    expect(getAllowedServiceOrigins(getServiceDefinition('whatsapp-business'))).toEqual(['https://web.whatsapp.com'])
  })

  it('includes the Slack login origin in addition to the app origin', () => {
    expect(getAllowedServiceOrigins(getServiceDefinition('slack'))).toEqual([
      'https://app.slack.com',
      'https://slack.com',
    ])
  })

  it('includes the Slack workspace host pattern in addition to exact origins', () => {
    expect(getServiceDefinition('slack').allowedHostPatterns).toEqual(['*.slack.com'])
  })
})
