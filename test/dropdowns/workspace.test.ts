import nock from 'nock'
import { createAppTester } from 'zapier-platform-core'
import { afterEach, describe, expect, it } from 'vitest'

import { CLOUD_API_URL } from '../../src/constants.js'
import {
  listWorkspaces,
  requireWorkspaceId,
  toChoice,
  workspaceDropdown,
  workspaceField,
} from '../../src/dropdowns/workspace.js'
import App from '../../src/index.js'

const appTester = createAppTester(App)
const authData = { apiKey: 'jwt-token' }

afterEach(() => {
  nock.cleanAll()
})

describe('workspace dropdown', () => {
  it('is registered under the key its field points at', () => {
    // A dynamic reference that names a trigger the app does not register resolves
    // to an empty dropdown at runtime and to nothing at all at compile time.
    const [referencedKey] = workspaceField.dynamic.split('.')

    expect(referencedKey).toBe(workspaceDropdown.key)
    expect(App.triggers[workspaceDropdown.key]).toBe(workspaceDropdown)
  })

  it('is hidden, so it never appears as a trigger a user can choose', () => {
    expect(workspaceDropdown.display.hidden).toBe(true)
  })

  it('reads workspaces.list, which no permission gates', async () => {
    const scope = nock(CLOUD_API_URL)
      .get('/api/workspaces.list')
      .reply(200, [
        { id: 'acme', name: 'Acme Marketing' },
        { id: 'globex', name: 'Globex' },
      ])

    const choices = await appTester(listWorkspaces, { authData })

    expect(choices).toEqual([
      { id: 'acme', name: 'Acme Marketing' },
      { id: 'globex', name: 'Globex' },
    ])
    expect(scope.isDone()).toBe(true)
  })

  it('sends no workspace_id, because the endpoint takes none', async () => {
    // Asking for one would be the mistake that makes this dropdown unfillable
    // before the field it fills has a value.
    const scope = nock(CLOUD_API_URL).get('/api/workspaces.list').query({}).reply(200, [])

    await appTester(listWorkspaces, { authData })

    expect(scope.isDone()).toBe(true)
  })

  it('labels a nameless workspace with its id rather than a blank row', () => {
    expect(toChoice({ id: 'acme', name: '' })).toEqual({ id: 'acme', name: 'acme' })
    expect(toChoice({ id: 'acme' })).toEqual({ id: 'acme', name: 'acme' })
  })

  it('drops a record a Zap could not store', () => {
    expect(toChoice({ name: 'Nameless' })).toBeNull()
    expect(toChoice({ id: '' })).toBeNull()
    expect(toChoice('acme')).toBeNull()
  })

  it('survives a response that is not the array it expects', async () => {
    // An instance behind a captive portal or a proxy answers 200 with HTML. A
    // dropdown that throws there hides the real problem behind a stack trace.
    nock(CLOUD_API_URL).get('/api/workspaces.list').reply(200, '<html>hello</html>')

    await expect(appTester(listWorkspaces, { authData })).resolves.toEqual([])
  })

  it('rebuilds the rest of the form when the workspace changes', () => {
    // The custom-field section is named after workspace settings, so a form that
    // did not rebuild would offer the previous workspace's field names.
    expect(workspaceField.altersDynamicFields).toBe(true)
    expect(workspaceField.required).toBe(true)
  })

  it('asks for a workspace before the fields that hang off one', () => {
    expect(() => requireWorkspaceId({})).toThrow(/workspace/i)
    expect(() => requireWorkspaceId({ workspace_id: '' })).toThrow(/workspace/i)
    expect(requireWorkspaceId({ workspace_id: 'acme' })).toBe('acme')
  })
})
