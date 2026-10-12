export interface ServiceDefinition {
  id: string
  label: string
  url: string
  description: string
  /** Short label shown under the account name in the account list. */
  shortDescription: string
  /** Legacy emoji icon, kept for any future fallback only. */
  icon: string
  /** Whether the service is enabled by default for new installations. */
  defaultEnabled: boolean
  /**
   * Optional list of additional origins the service may legitimately navigate to
   * (e.g. Slack login on slack.com while the app lives on app.slack.com). When
   * omitted, only the origin of `url` is allowed. No wildcards; exact origins only.
   */
  allowedOrigins?: readonly string[]
  /**
   * Optional host patterns that are allowed for this service in addition to the
   * exact origins above. Patterns are HTTPS-only, require the default port, and
   * reject embedded credentials. Supported syntax:
   * - `*.example.com` matches exactly one subdomain label (e.g. `team.example.com`).
   * - Exact hostnames match literally.
   */
  allowedHostPatterns?: readonly string[]
}

export interface ServiceRuntimeState {
  id: string
  label: string
  url: string
  description: string
  shortDescription: string
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
    shortDescription: 'WhatsApp Web',
    icon: '💬',
    defaultEnabled: true,
  },
  {
    id: 'telegram',
    label: 'Telegram',
    url: 'https://web.telegram.org/k/',
    description: 'Telegram Web K – schneller Cloud-Messenger.',
    shortDescription: 'Telegram Web K',
    icon: '✈️',
    defaultEnabled: true,
  },
  {
    id: 'slack',
    label: 'Slack',
    url: 'https://app.slack.com',
    description: 'Slack – Workspaces und Direktnachrichten im Browser.',
    shortDescription: 'Slack',
    icon: '💼',
    defaultEnabled: false,
    allowedOrigins: ['https://app.slack.com', 'https://slack.com'],
    allowedHostPatterns: ['*.slack.com'],
  },
  {
    id: 'discord',
    label: 'Discord',
    url: 'https://discord.com/login',
    description: 'Discord Web – Sprach- und Textchat.',
    shortDescription: 'Discord',
    icon: '🎮',
    defaultEnabled: false,
  },
  {
    id: 'whatsapp-business',
    label: 'WhatsApp Business',
    url: 'https://web.whatsapp.com',
    description: 'WhatsApp Business – identische Web-Oberfläche wie WhatsApp Web, eigene isolierte Sitzung.',
    shortDescription: 'WhatsApp Business',
    icon: '🏢',
    defaultEnabled: false,
  },
] as const

export type ServiceId = typeof SUPPORTED_SERVICES[number]['id']

export const DEFAULT_ENABLED_SERVICE_IDS: readonly ServiceId[] = SUPPORTED_SERVICES
  .filter((s) => s.defaultEnabled)
  .map((s) => s.id as ServiceId)

export const ALL_SERVICE_IDS: readonly ServiceId[] = SUPPORTED_SERVICES.map((s) => s.id as ServiceId)

/** Service ids that existed in v1 config (legacy per-service accounts). */
export const V1_SERVICE_IDS: readonly ServiceId[] = ALL_SERVICE_IDS.filter((id) =>
  ['whatsapp', 'telegram'].includes(id),
)

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

/**
 * Return the canonical list of allowed origins for a service. This is always the
 * service URL's own origin plus any explicitly declared additional origins.
 */
export function getAllowedServiceOrigins (service: ServiceDefinition): readonly string[] {
  const ownOrigin = new URL(service.url).origin
  const extra = service.allowedOrigins ?? []
  if (extra.includes(ownOrigin)) return extra
  return [ownOrigin, ...extra]
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
    shortDescription: service.shortDescription,
    icon: service.icon,
    enabled,
  }
}

export function toRuntimeState (
  enabledIds: readonly ServiceId[],
): readonly ServiceRuntimeState[] {
  return SUPPORTED_SERVICES.map((service) => toServiceRuntimeState(service, enabledIds.includes(service.id as ServiceId)))
}
