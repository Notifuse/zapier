import type { Bundle, HttpResponse, ZObject } from 'zapier-platform-core'
import { errors } from 'zapier-platform-core'
import { describe, expect, it } from 'vitest'

import { CLOUD_API_URL } from '../src/authentication.js'
import { afterResponse, beforeRequest, normalizeBaseUrl, resolveRequestUrl } from '../src/middleware.js'

// The middleware reads nothing off z but the error classes, so the real ones are
// enough: asserting on the class Zapier actually dispatches on beats asserting on
// a stub that only looks like it.
const z = { errors } as unknown as ZObject

const bundleWith = (authData: Record<string, string>): Bundle =>
  ({ authData }) as unknown as Bundle

const responseWith = (status: number, data: unknown, content = ''): HttpResponse =>
  ({ status, data, content, request: { url: 'https://v3.notifuse.com/api/contacts.list' } }) as unknown as HttpResponse

// The middleware signatures allow a promise, so the callers await. Both of ours
// are synchronous; awaiting keeps the tests honest about the contract rather than
// about this implementation.
const send = async (url: string, authData: Record<string, string>, headers: Record<string, string> = {}) =>
  beforeRequest({ url, headers }, z, bundleWith(authData))

const receive = async (response: HttpResponse) => afterResponse(response, z, bundleWith({}))

describe('normalizeBaseUrl', () => {
  it('falls back to the cloud API when the field is left empty', () => {
    expect(normalizeBaseUrl(undefined)).toBe(CLOUD_API_URL)
    expect(normalizeBaseUrl('')).toBe(CLOUD_API_URL)
    expect(normalizeBaseUrl('   ')).toBe(CLOUD_API_URL)
  })

  it('adds the scheme a self-hoster left off', () => {
    expect(normalizeBaseUrl('emails.example.com')).toBe('https://emails.example.com')
  })

  it('strips trailing slashes', () => {
    expect(normalizeBaseUrl('https://emails.example.com/')).toBe('https://emails.example.com')
    expect(normalizeBaseUrl('https://emails.example.com///')).toBe('https://emails.example.com')
  })

  it('strips a pasted /api suffix instead of doubling it', () => {
    // The docs say "scheme and domain only", so the people who read them are not
    // the ones this handles. A pasted "https://emails.example.com/api" would
    // otherwise request /api/api/workspaces.list and 404 on every call.
    expect(normalizeBaseUrl('https://emails.example.com/api')).toBe('https://emails.example.com')
    expect(normalizeBaseUrl('https://emails.example.com/api/')).toBe('https://emails.example.com')
    expect(normalizeBaseUrl('https://emails.example.com/notifuse/api')).toBe(
      'https://emails.example.com/notifuse',
    )
  })

  it('strips the /console the address bar shows', () => {
    // The field asks for the address the console is opened at, and Notifuse serves
    // the console under /console — so the honest answer to the question is the one
    // value that has to be trimmed. Left on, every call asks for /console/api/… ,
    // which the SPA fallback answers with index.html and a 200 rather than a 404.
    expect(normalizeBaseUrl('https://emails.example.com/console')).toBe('https://emails.example.com')
    expect(normalizeBaseUrl('https://emails.example.com/console/')).toBe('https://emails.example.com')
    expect(normalizeBaseUrl('emails.example.com/console')).toBe('https://emails.example.com')
    expect(normalizeBaseUrl('https://emails.example.com/notifuse/console')).toBe(
      'https://emails.example.com/notifuse',
    )
  })

  it('trims surrounding whitespace from a paste', () => {
    expect(normalizeBaseUrl('  https://emails.example.com  ')).toBe('https://emails.example.com')
  })
})

describe('resolveRequestUrl', () => {
  const base = 'https://emails.example.com'

  it('joins a relative path onto the configured instance', () => {
    expect(resolveRequestUrl('/api/workspaces.list', base)).toBe(
      'https://emails.example.com/api/workspaces.list',
    )
  })

  it('collapses a doubled slash left by a trailing-slash base', () => {
    expect(resolveRequestUrl('https://emails.example.com//api/contacts.list', base)).toBe(
      'https://emails.example.com/api/contacts.list',
    )
  })

  it('adds the scheme to an absolute URL that lost it in templating', () => {
    expect(resolveRequestUrl('emails.example.com/api/lists.list', base)).toBe(
      'https://emails.example.com/api/lists.list',
    )
  })

  it('leaves a path that only looks relative attached to the base', () => {
    expect(resolveRequestUrl('api/lists.list', base)).toBe('https://emails.example.com/api/lists.list')
  })

  it('keeps the query string intact', () => {
    expect(resolveRequestUrl('/api/contacts.list?workspace_id=acme&limit=3', base)).toBe(
      'https://emails.example.com/api/contacts.list?workspace_id=acme&limit=3',
    )
  })
})

describe('beforeRequest', () => {
  it('resolves a relative URL against the configured instance and signs it', async () => {
    const request = await send('/api/workspaces.list', {
      apiUrl: 'https://emails.example.com/',
      apiKey: 'jwt-token',
    })

    expect(request.url).toBe('https://emails.example.com/api/workspaces.list')
    expect(request.headers?.Authorization).toBe('Bearer jwt-token')
  })

  it('uses the cloud API when no URL was given', async () => {
    const request = await send('/api/workspaces.list', { apiKey: 'jwt-token' })

    expect(request.url).toBe(`${CLOUD_API_URL}/api/workspaces.list`)
  })

  it('leaves the headers it did not set alone', async () => {
    const request = await send('/api/contacts.upsert', { apiKey: 'jwt-token' }, { 'X-Trace': 'abc' })

    expect(request.headers).toEqual({ 'X-Trace': 'abc', Authorization: 'Bearer jwt-token' })
  })

  it('sends no Authorization header when there is no key yet', async () => {
    const request = await send('/api/workspaces.list', {})

    expect(request.headers?.Authorization).toBeUndefined()
  })

  it('refuses plain HTTP and names the URL it refused', async () => {
    // Zapier requires HTTPS for public integrations and accepts only public-CA
    // certificates, so this can never work — failing at the first request with
    // the address in the message is the only useful thing to do with it.
    const insecure = { apiUrl: 'http://emails.example.com', apiKey: 'jwt-token' }

    await expect(send('/api/workspaces.list', insecure)).rejects.toThrow(/http:\/\/emails\.example\.com/)
    await expect(send('/api/workspaces.list', insecure)).rejects.toThrow(/HTTPS/)
  })
})

describe('afterResponse', () => {
  it('passes a successful response through untouched', async () => {
    const response = responseWith(200, { contacts: [] })

    await expect(receive(response)).resolves.toBe(response)
  })

  it('asks Zapier to reconnect the account on 401', async () => {
    await expect(receive(responseWith(401, { error: 'invalid token' }))).rejects.toThrow(
      errors.ExpiredAuthError,
    )
  })

  it('names the missing permission on 403', async () => {
    // The backend answers a denial with the permission it wanted, and that string
    // is the whole fix: the user adds it to the key and re-runs the step.
    const denied = responseWith(403, { error: 'missing permission: contacts:read' })

    await expect(receive(denied)).rejects.toThrow(/contacts:read/)
    await expect(receive(denied)).rejects.toThrow(/permission/i)
  })

  it('sends a denied step to Team, where a key is widened rather than created', async () => {
    // The other two user-facing screen names in this app point at Settings →
    // Integrations, which is where a Zapier key is minted. This one must not
    // follow them: the connection already works, so the fix is to widen the key
    // that exists, and Team is the only screen that does that. Nor may it read as
    // an instruction to make a new key — a second key would arrive scoped exactly
    // like the first and be refused in the same place.
    const denied = responseWith(403, { error: 'missing permission: contacts:read' })

    const message = await Promise.resolve(receive(denied)).then(
      () => '',
      (error: Error) => error.message,
    )

    expect(message).toMatch(/Settings → Team/)
    expect(message).not.toMatch(/creat/i)
  })

  it('surfaces the API error message on other failures', async () => {
    await expect(receive(responseWith(400, { error: 'list_ids is required' }))).rejects.toThrow(
      /list_ids is required/,
    )
    await expect(receive(responseWith(404, { error: 'Segment not found' }))).rejects.toThrow(
      /Segment not found/,
    )
  })

  it('falls back to the raw body when the failure is not JSON', async () => {
    // A reverse proxy in front of a self-hosted instance answers with HTML, and
    // "502" alone tells the user nothing about which hop failed.
    await expect(receive(responseWith(502, undefined, '<html>Bad Gateway</html>'))).rejects.toThrow(/502/)
  })

  it('honours a request that opted out of throwing', async () => {
    // performSubscribe tolerates a duplicate subscription, which it can only do if
    // it gets to read the response itself.
    const response = {
      status: 409,
      data: { error: 'already exists' },
      content: '',
      skipThrowForStatus: true,
      request: { url: 'https://v3.notifuse.com/api/webhookSubscriptions.create' },
    } as unknown as HttpResponse

    await expect(receive(response)).resolves.toBe(response)
  })
})
