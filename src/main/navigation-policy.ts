import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { type ServiceDefinition } from '../shared/services.js'

/**
 * Validate a URL before opening it in the system default browser.
 *
 * Fail-closed rules:
 * - Only http: and https: protocols are allowed.
 * - No credentials embedded in the URL (userinfo / password).
 * - No file/javascript/data/custom schemes.
 * - No empty or opaque hostnames.
 *
 * This helper is intentionally strict: it does NOT accept arbitrary command-line
 * arguments, local paths, or mailto links. Callers must not forward unchecked
 * URLs from renderer or remote content.
 */
export function isSafeExternalUrl (url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  if (parsed.username.length > 0 || parsed.password.length > 0) return false
  if (parsed.hostname.length === 0) return false
  return true
}

export function isAllowedServiceNavigation (service: ServiceDefinition, url: string): boolean {
  if (url === 'about:blank') return true
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
    const serviceOrigin = new URL(service.url).origin
    return parsed.origin === serviceOrigin
  } catch {
    return false
  }
}

/**
 * Build the canonical file:// URL of the shell's index.html.
 * Exported so callers can reuse the exact same canonicalisation for IPC/frame
 * checks.
 */
export function getShellIndexUrl (rendererRoot: string): string {
  return pathToFileURL(path.join(rendererRoot, 'index.html')).href
}

export function isAllowedShellNavigation (rendererRoot: string, url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  if (parsed.protocol !== 'file:') return false

  // Package 1: the shell is a single-page React app. Only top-level navigation
  // to the exact index.html is allowed. Any fragment/hash is permitted because
  // the SPA uses it internally, but query strings are rejected.
  if (parsed.search.length > 0) return false

  const allowedIndex = getShellIndexUrl(rendererRoot)

  // Compare the full URL strings after stripping the fragment, because the
  // fragment is the only permitted variable part of an allowed shell URL.
  const targetWithoutHash = parsed.href.replace(/#[^#]*$/, '')
  const allowedWithoutHash = allowedIndex.replace(/#[^#]*$/, '')
  return targetWithoutHash === allowedWithoutHash
}

export function isSamePathAsShellIndex (rendererRoot: string, url: string): boolean {
  return isAllowedShellNavigation(rendererRoot, url)
}

/**
 * Package 1: block all programmatic external URL opens.
 * Real link handling will be added later with explicit user confirmation.
 */
export function isAllowedExternalUrl (_url: string): boolean {
  return false
}
