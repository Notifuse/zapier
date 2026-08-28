import type { AfterResponseMiddleware, BeforeRequestMiddleware, HttpResponse } from 'zapier-platform-core'

import { CLOUD_API_URL } from './constants.js'

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * Turns whatever the user typed into the API URL field into a base URL that can
 * be concatenated with `/api/…`.
 *
 * Every peer integration with a self-hosted mode ships this, and for a reason
 * worth taking seriously: the issue trackers of self-hostable Zapier apps are
 * mostly trailing slashes and missing schemes, not logic bugs. The field is free
 * text typed once and reused on every request, so a stray character is a
 * connection that never works and an error message that does not say why.
 *
 * - Empty means Notifuse Cloud. The field is optional and most users are on it.
 * - A missing scheme becomes `https://` — never `http://`, which Zapier refuses
 *   anyway (see `beforeRequest`).
 * - Trailing slashes go, so `${base}/api/x` cannot produce `//api/x`.
 * - A trailing `/api` goes too. The docs say scheme and domain only; the people
 *   who paste the API endpoint itself are the ones who need this, and without it
 *   every call would ask for `/api/api/…`.
 */
export const normalizeBaseUrl = (raw: string | undefined): string => {
  const trimmed = (raw ?? '').trim()
  if (trimmed === '') {
    return CLOUD_API_URL
  }

  const withScheme = SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`
  return withScheme.replace(/\/+$/, '').replace(/\/api$/i, '')
}

/**
 * Resolves the URL of an outgoing request against the configured instance.
 *
 * Operations ask for `/api/contacts.list` and get the user's host prefixed here,
 * so no operation has to know how the base URL was spelled. An already-absolute
 * URL — one built by curly-brace templating, say — is normalised rather than
 * rebuilt, because templating is exactly where a doubled slash or a dropped
 * scheme appears.
 */
export const resolveRequestUrl = (rawUrl: string, base: string): string => {
  const url = rawUrl.trim()

  if (SCHEME.test(url)) {
    return collapseDoubledSlashes(url)
  }

  if (url.startsWith('/')) {
    return collapseDoubledSlashes(`${base}${url}`)
  }

  // No scheme and no leading slash: either a host that lost its scheme in
  // templating ("emails.example.com/api/…") or a path relative to the instance
  // ("api/…"). A dot or "localhost" in the first segment is what tells them apart.
  const [firstSegment = ''] = url.split('/')
  const looksLikeHost = firstSegment.includes('.') || firstSegment.startsWith('localhost')

  return collapseDoubledSlashes(looksLikeHost ? `https://${url}` : `${base}/${url}`)
}

/** Collapses `//` inside the path, leaving the `://` of the scheme alone. */
const collapseDoubledSlashes = (url: string): string => {
  const separator = url.indexOf('://')
  if (separator === -1) {
    return url.replace(/\/{2,}/g, '/')
  }

  const scheme = url.slice(0, separator + 3)
  const rest = url.slice(separator + 3)
  return `${scheme}${rest.replace(/\/{2,}/g, '/')}`
}

/**
 * Points every request at the configured instance and signs it.
 *
 * The API key is a JWT sent as a bearer token, and `workspace_id` is deliberately
 * *not* handled here: it is required by nearly every endpoint, cannot be derived
 * from the key, and custom auth has no computed fields — so it travels as a
 * per-operation input field instead.
 */
export const beforeRequest: BeforeRequestMiddleware = (request, z, bundle) => {
  const base = normalizeBaseUrl(bundle.authData?.apiUrl)
  const url = resolveRequestUrl(request.url, base)

  if (/^http:\/\//i.test(url)) {
    // Zapier requires HTTPS for public integrations and trusts only public
    // certificate authorities, so this cannot be made to work by retrying. Naming
    // the address is the difference between a fixable message and a mystery, and
    // the base URL is named in preference to the full one because the base is
    // what the user can edit.
    const offending = /^http:\/\//i.test(base) ? base : url
    throw new z.errors.Error(
      `Notifuse must be reachable over HTTPS, and ${offending} is not. Zapier connects only to endpoints served over HTTPS with a certificate from a public certificate authority. Update the API URL on this connection.`,
      'InsecureApiUrl',
      400,
    )
  }

  request.url = url

  const apiKey = bundle.authData?.apiKey
  if (apiKey) {
    request.headers = { ...request.headers, Authorization: `Bearer ${apiKey}` }
  }

  return request
}

/** Reads the `{"error": "…"}` body the API answers failures with. */
const failureDetail = (response: HttpResponse): string => {
  const data: unknown = response.data
  if (typeof data === 'object' && data !== null && 'error' in data) {
    const message = (data as { error: unknown }).error
    if (typeof message === 'string' && message.trim() !== '') {
      return message.trim()
    }
  }

  const content = (response.content ?? '').trim()
  return content === '' ? 'no response body' : content.slice(0, 300)
}

/**
 * Turns an API failure into the error Zapier knows what to do with.
 *
 * The distinction that matters to a user is "reconnect this account" versus
 * "this key cannot do that" versus "your instance is unhappy", and only the first
 * has a Zapier-level meaning: `ExpiredAuthError` prompts a reconnection instead
 * of quietly turning the Zap off.
 */
export const afterResponse: AfterResponseMiddleware = (response, z) => {
  // A request that opted out of throwing wants to read the failure itself —
  // performSubscribe tolerating a subscription that already exists, for instance.
  const optedOut = response.skipThrowForStatus || response.request?.skipThrowForStatus
  if (optedOut || response.status < 400) {
    return response
  }

  const detail = failureDetail(response)

  if (response.status === 401) {
    throw new z.errors.ExpiredAuthError(
      `Notifuse rejected the API key (${detail}). Reconnect this account with a valid key.`,
    )
  }

  if (response.status === 403) {
    throw new z.errors.Error(
      `The API key lacks the required permission: ${detail}. Add it to the key in Settings → Team, then re-run this step.`,
      'MissingPermission',
      403,
    )
  }

  throw new z.errors.Error(`Notifuse answered ${response.status}: ${detail}`, 'ApiError', response.status)
}
