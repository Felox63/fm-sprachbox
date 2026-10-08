export interface ServiceDefinition {
  id: string
  label: string
  url: string
  description: string
  /** Legacy emoji icon, kept for any future fallback only. */
  icon: string
  /** Whether the service is enabled by default for new installations. */
  defaultEnabled: boolean
}

export interface ServiceRuntimeState {
  id: string
  label: string
  url: string
  description: string
  /** Relative icon asset path. */
  icon: string
  enabled: boolean
}

export const SUPPORTED_SERVICES: readonly ServiceDefinition[] = [
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    url: 'https://web.whatsapp.com',
    description: 'WhatsApp Web – Nachrichten und Sprachnachrichten im Browser.',
    icon: '💬',
    defaultEnabled: true,
  },
  {
    id: 'telegram',
    label: 'Telegram',
    url: 'https://web.telegram.org/k/',
    description: 'Telegram Web K – schneller Cloud-Messenger.',
    icon: '✈️',
    defaultEnabled: true,
  },
] as const

export type ServiceId = typeof SUPPORTED_SERVICES[number]['id']

export const DEFAULT_ENABLED_SERVICE_IDS: readonly ServiceId[] = SUPPORTED_SERVICES
  .filter((s) => s.defaultEnabled)
  .map((s) => s.id as ServiceId)

export const ALL_SERVICE_IDS: readonly ServiceId[] = SUPPORTED_SERVICES.map((s) => s.id as ServiceId)

export function isKnownServiceId (value: unknown): value is ServiceId {
  if (typeof value !== 'string') return false
  return ALL_SERVICE_IDS.includes(value as ServiceId)
}

export function getServiceDefinition (serviceId: ServiceId): ServiceDefinition {
  const service = SUPPORTED_SERVICES.find((s) => s.id === serviceId)
  if (!service) {
    throw new Error(`Unsupported service: ${serviceId}`)
  }
  return service
}

export function toServiceRuntimeState (
  service: ServiceDefinition,
  enabled: boolean,
): ServiceRuntimeState {
  return {
    id: service.id,
    label: service.label,
    url: service.url,
    description: service.description,
    icon: service.icon,
    enabled,
  }
}

export function toRuntimeState (
  enabledIds: readonly ServiceId[],
): readonly ServiceRuntimeState[] {
  return SUPPORTED_SERVICES.map((service) => toServiceRuntimeState(service, enabledIds.includes(service.id as ServiceId)))
}
