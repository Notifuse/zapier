import nock from 'nock'
import { createAppTester } from 'zapier-platform-core'
import { afterEach, describe, expect, it } from 'vitest'

import { CLOUD_API_URL } from '../../src/constants.js'
import { listDropdown, listField, listIdsField, listLists } from '../../src/dropdowns/list.js'
import App from '../../src/index.js'

const appTester = createAppTester(App)
const authData = { apiKey: 'jwt-token' }

const lists = {
  lists: [
    { id: 'newsletter', name: 'Monthly Newsletter', is_double_optin: true },
    { id: 'product', name: 'Product Updates', is_double_optin: false },
  ],
}

afterEach(() => {
  nock.cleanAll()
})

describe('list dropdown', () => {
  it('is registered under the key both list fields point at', () => {
    const [singleKey] = listField.dynamic.split('.')
    const [multiKey] = listIdsField.dynamic.split('.')

    expect(singleKey).toBe(listDropdown.key)
    expect(multiKey).toBe(listDropdown.key)
    expect(App.triggers[listDropdown.key]).toBe(listDropdown)
  })

  it('is hidden, so it never appears as a trigger a user can choose', () => {
    expect(listDropdown.display.hidden).toBe(true)
  })

  it('scopes the read to the chosen workspace', async () => {
    const scope = nock(CLOUD_API_URL)
      .get('/api/lists.list')
      .query({ workspace_id: 'acme' })
      .reply(200, lists)

    const choices = await appTester(listLists, { authData, inputData: { workspace_id: 'acme' } })

    expect(choices).toEqual([
      { id: 'newsletter', name: 'Monthly Newsletter' },
      { id: 'product', name: 'Product Updates' },
    ])
    expect(scope.isDone()).toBe(true)
  })

  it('unwraps the object the endpoint answers with', async () => {
    // lists.list nests its array under `lists`, unlike workspaces.list which
    // returns a bare one. Reading it as an array would silently produce nothing.
    nock(CLOUD_API_URL).get('/api/lists.list').query(true).reply(200, lists)

    const choices = await appTester(listLists, { authData, inputData: { workspace_id: 'acme' } })

    expect(choices).toHaveLength(lists.lists.length)
  })

  it('answers nothing rather than throwing when the envelope changes', async () => {
    nock(CLOUD_API_URL).get('/api/lists.list').query(true).reply(200, { data: [] })

    await expect(
      appTester(listLists, { authData, inputData: { workspace_id: 'acme' } }),
    ).resolves.toEqual([])
  })

  it('asks for a workspace before it asks the API for anything', async () => {
    // No interceptor is registered: a request here would fail the test rather
    // than reach the network.
    await expect(appTester(listLists, { authData, inputData: {} })).rejects.toThrow(/workspace/i)
  })

  it('offers several lists on the subscribe action and one everywhere else', () => {
    // lists.subscribe takes an array and reports one membership per entry, so the
    // action can accept several; a trigger watches exactly one.
    expect(listIdsField.list).toBe(true)
    expect(listField).not.toHaveProperty('list')
  })
})
