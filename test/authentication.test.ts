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

  it('rejects a key that reaches no workspace', async () => {
    // The key authenticates but every operation needs a workspace, so a connection
    // that resolves to none would fail at the first dropdown instead of here.
    nock(CLOUD_API_URL).get('/api/workspaces.list').reply(200, [])

    await expect(appTester(testAuth, { authData: { apiKey: 'jwt-token' } })).rejects.toThrow(
      /workspace/i,
    )
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
