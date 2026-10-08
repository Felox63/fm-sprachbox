import { app } from 'electron'
import type { ServiceId } from '../shared/services.js'

export interface UserAgentSource {
  /**
   * Electron product version (process.versions.chrome from the main process).
   * The renderer process cannot provide this value because it is sandboxed.
   */
  chrome: string
  /**
   * Full Electron version string, e.g. "44.5.0".
   */
  electron: string
}

/**
 * Return the Chromium major version from a Chrome version string such as
 * "126.0.6478.XXX". This must match the real runtime value; never hard-code a
 * browser version.
 */
export function getChromeMajor (chromeVersion: string): number | null {
  const match = /^\d+/.exec(chromeVersion)
  if (!match) return null
  const major = Number.parseInt(match[0], 10)
  if (!Number.isFinite(major) || major < 1) return null
  return major
}

/**
 * Build a User-Agent string for a remote messenger service.
 *
 * WhatsApp Web gates on a Chromium major version of at least 100. Electron's
 * default UA advertises the bundled Chromium version, but WhatsApp's server-side
 * detection has historically rejected UAs that contain the Electron token even
 * when the Chromium component is recent enough. This helper derives a clean UA
 * from the actual bundled Chromium version, removing the Electron token and any
 * misleading platform fragments, while keeping the real Chrome major version.
 *
 * The UA is set on the service-specific Session BEFORE the first loadURL(), so
 * the service never sees the default Electron UA.
 *
 * This is a narrow, service-specific workaround. It does NOT weaken
 * nodeIntegration, contextIsolation, sandbox or webSecurity.
 */
export function buildServiceUserAgent (
  service: { id: ServiceId; url: string },
  source?: UserAgentSource,
): string | null {
  if (source == null) return null

  const chromeMajor = getChromeMajor(source.chrome)
  if (chromeMajor == null) return null

  // WhatsApp's gate is known to require a Chromium major version >= 100.
  if (service.id === 'whatsapp') {
    // A stable, widely accepted Windows Chrome UA shape. The platform string is
    // intentionally generic because WhatsApp's gate only checks the Chrome major
    // version in the UA, not the OS. We never invent a Chrome version.
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${source.chrome} Safari/537.36`
  }

  // For Telegram and other services we keep Electron's default UA. Telegram Web
  // does not currently gate on the absence of the Electron token.
  return null
}

/**
 * Collect the real runtime version values from the main process. This should be
 * called once and passed to createMessengerView for services that need a
 * custom UA.
 */
export function getUserAgentSource (): UserAgentSource {
  return {
    chrome: process.versions.chrome ?? '0.0.0.0',
    electron: process.versions.electron ?? app.getVersion(),
  }
}
