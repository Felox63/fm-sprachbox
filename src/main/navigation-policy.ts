import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { type ServiceDefinition, getAllowedServiceOrigins } from '../shared/services.js'

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

function hostnameMatchesPattern (hostname: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1) // includes leading dot, e.g. ".slack.com"
    if (!hostname.endsWith(suffix)) return false
    const prefix = hostname.slice(0, -suffix.length)
    // Require exactly one non-empty DNS label before the suffix. This blocks
    // lookalikes such as evil.com/.slack.com and multi-level subdomains that
    // do not correspond to documented Slack workspace URLs.
    if (prefix.length === 0 || prefix.includes('.')) return false
    return true
  }
  return hostname === pattern
}

export function isAllowedServiceNavigation (service: ServiceDefinition, url: string): boolean {
  if (url === 'about:blank') return true
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
    // Fail-closed: reject URLs that embed credentials. Legitimate services never
    // require userinfo in navigation URLs and it is a common phishing vector.
    if (parsed.username.length > 0 || parsed.password.length > 0) return false

    // Exact configured origins are always allowed.
    if (getAllowedServiceOrigins(service).includes(parsed.origin)) return true

    // Host patterns are restricted to HTTPS on the default port.
    if (service.allowedHostPatterns != null && service.allowedHostPatterns.length > 0) {
      if (parsed.protocol !== 'https:') return false
      if (parsed.port.length > 0) return false
      if (service.allowedHostPatterns.some((pattern) => hostnameMatchesPattern(parsed.hostname, pattern))) return true
    }

    return false
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
