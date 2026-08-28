import type { Bundle, ZObject } from 'zapier-platform-core'
import nock from 'nock'
import { createAppTester, errors } from 'zapier-platform-core'
import { afterEach, describe, expect, it } from 'vitest'

import App from '../src/index.js'
import authentication, { CLOUD_API_URL, connectionLabel, testAuth } from '../src/authentication.js'

const appTester = createAppTester(App)

// connectionLabel is called with (z, bundle) and reads only bundle, so the stub
// is the shape of a call, not a fake platform.
const z = { errors } as unknown as ZObject

const labelFor = async (inputData: Record<string, string>): Promise<string> =>
  connectionLabel(z, { inputData, authData: {} } as unknown as Bundle)

const workspaces = [
  { id: 'acme', name: 'Acme Marketing', settings: {}, created_at: '2024-01-15T09:30:00Z' },
]

afterEach(() => {
  nock.cleanAll()
})

describe('authentication', () => {
  it('offers an optional API URL defaulting to the cloud, and a required secret key', () => {
    const fields = authentication.fields
    const apiUrl = fields.find((field) => field.key === 'apiUrl')
    const apiKey = fields.find((field) => field.key === 'apiKey')

    expect(authentication.type).toBe('custom')

    expect(apiUrl?.required).toBe(false)
    expect(apiUrl?.default).toBe(CLOUD_API_URL)
    expect(apiUrl?.helpText).toMatch(/self-host/i)

    expect(apiKey?.required).toBe(true)
    expect(apiKey?.type).toBe('password')
  })

  it('points both fields at the documentation', () => {
    // D002 asks every auth field to link to where the value comes from, and the
    // check is part of `zapier-platform validate`.
    for (const field of authentication.fields) {
      expect(field.helpText).toMatch(/https:\/\/docs\.notifuse\.com\/integrations\/zapier/)
    }
  })

  it('sends a new user to Integrations, the only screen that mints a Zapier key', () => {
    // This help text is the first instruction anyone reads about Notifuse, and
    // Settings → Team mints a key with no permissions chosen — so a reader who
    // followed it built a key that authenticates and fails at the first trigger.
    // Connecting from Settings → Integrations is what scopes the key for them.
    const apiKey = authentication.fields.find((field) => field.key === 'apiKey')

    expect(apiKey?.helpText).toMatch(/Settings → Integrations/)
    expect(apiKey?.helpText).not.toMatch(/Settings → Team/)
  })

  it('does not ask for a workspace, which custom auth cannot compute', () => {
    // Custom auth has no computed fields, so a workspace here would have to be
    // typed by hand and would be wrong on every other operation. It belongs in a
    // per-operation input field backed by a dropdown.
    const keys = authentication.fields.map((field) => field.key)

    expect(keys).not.toContain('workspace_id')
  })

  it('tests the key against workspaces.list, which no permission gates', () => {
    nock(CLOUD_API_URL).get('/api/workspaces.list').reply(200, workspaces)

    return appTester(testAuth, { authData: { apiKey: 'jwt-token' } }).then((result) => {
      expect(result).toMatchObject({ workspace_id: 'acme', workspace_name: 'Acme Marketing' })
    })
  })

  it('sends the key as a bearer token', async () => {
    const scope = nock(CLOUD_API_URL, { reqheaders: { authorization: 'Bearer jwt-token' } })
      .get('/api/workspaces.list')
      .reply(200, workspaces)

    await appTester(testAuth, { authData: { apiKey: 'jwt-token' } })

    expect(scope.isDone()).toBe(true)
  })

  it('reaches a self-hosted instance, trailing slash and all', async () => {
    const scope = nock('https://emails.example.com').get('/api/workspaces.list').reply(200, workspaces)

    await appTester(testAuth, {
      authData: { apiKey: 'jwt-token', apiUrl: 'https://emails.example.com/' },
    })

    expect(scope.isDone()).toBe(true)
  })

  it('reaches a self-hosted instance from the address the console is opened at', async () => {
    // The field asks for "the address you open the Notifuse console at" and
    // Notifuse serves the console under /console, so that is what the address bar
    // shows and what gets pasted. Every call would otherwise ask for
    // /console/api/… , which the SPA fallback answers with index.html and a 200.
    const scope = nock('https://emails.example.com').get('/api/workspaces.list').reply(200, workspaces)

    await appTester(testAuth, {
      authData: { apiKey: 'jwt-token', apiUrl: 'https://emails.example.com/console/' },
    })

    expect(scope.isDone()).toBe(true)
  })

  it('blames the address, not the key, when the answer is not a workspace list', async () => {
    // An HTML body leaves response.data undefined — the platform swallows the
    // parse error and nothing under 400 is touched by afterResponse — so reading
    // "not an array" as "this key reaches no workspace" sends the user to create a
    // second key, then a third, while the field that is wrong goes untouched.
    nock('https://emails.example.com')
      .get('/api/workspaces.list')
      .reply(200, '<!doctype html><html><body>Notifuse</body></html>', {
        'content-type': 'text/html',
      })

    const message = await appTester(testAuth, {
      authData: { apiKey: 'jwt-token', apiUrl: 'https://emails.example.com' },
    }).then(
      () => '',
      (error: Error) => error.message,
    )

    expect(message).toMatch(/https:\/\/emails\.example\.com\/api\/workspaces\.list/)
    expect(message).toMatch(/API URL/i)
    // Never the no-workspace instruction: the key is fine, the address is not.
    expect(message).not.toMatch(/Settings/)
  })

  it('rejects a key that reaches no workspace', async () => {
    // The key authenticates but every operation needs a workspace, so a connection
    // that resolves to none would fail at the first dropdown instead of here.
    nock(CLOUD_API_URL).get('/api/workspaces.list').reply(200, [])

    await expect(appTester(testAuth, { authData: { apiKey: 'jwt-token' } })).rejects.toThrow(
      /workspace/i,
    )
  })

  it('names Integrations when telling the user where to make the key again', async () => {
    // The recovery is to create the key inside the workspace Zapier should use,
    // and the screen that does that is Settings → Integrations. Naming Team here
    // sent the user back to the screen that cannot scope a key for them.
    nock(CLOUD_API_URL).get('/api/workspaces.list').reply(200, [])

    const message = await appTester(testAuth, { authData: { apiKey: 'jwt-token' } }).then(
      () => '',
      (error: Error) => error.message,
    )

    expect(message).toMatch(/Settings → Integrations/)
    expect(message).not.toMatch(/Settings → Team/)
  })

  it('reports a revoked key as an expired connection', async () => {
    nock(CLOUD_API_URL).get('/api/workspaces.list').reply(401, { error: 'invalid token' })

    await expect(appTester(testAuth, { authData: { apiKey: 'revoked' } })).rejects.toThrow(
      /reconnect|expired|invalid token/i,
    )
  })

  it('labels a connection with the workspace and the host it lives on', async () => {
    // Someone running a Notifuse instance alongside the cloud sees two connections
    // named after the same workspace otherwise.
    await expect(labelFor({ workspace_name: 'Acme Marketing', host: 'emails.example.com' })).resolves.toBe(
      'Acme Marketing (emails.example.com)',
    )
  })

  it('falls back to the host when the workspace has no name', async () => {
    await expect(labelFor({ host: 'v3.notifuse.com' })).resolves.toBe('v3.notifuse.com')
  })

  it('labels the cloud when the connection never named a host', async () => {
    await expect(labelFor({ workspace_name: 'Acme Marketing' })).resolves.toBe(
      'Acme Marketing (v3.notifuse.com)',
    )
  })
})
