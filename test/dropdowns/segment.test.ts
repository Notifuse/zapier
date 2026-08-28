import nock from 'nock'
import { createAppTester } from 'zapier-platform-core'
import { afterEach, describe, expect, it } from 'vitest'

import { CLOUD_API_URL } from '../../src/constants.js'
import { listSegments, segmentDropdown, segmentField } from '../../src/dropdowns/segment.js'
import App from '../../src/index.js'

const appTester = createAppTester(App)
const authData = { apiKey: 'jwt-token' }

const segments = {
  segments: [
    { id: 'vip', name: 'VIP Customers', users_count: 0 },
    { id: 'churned', name: 'Churned', users_count: 0 },
  ],
}

afterEach(() => {
  nock.cleanAll()
})

describe('segment dropdown', () => {
  it('is registered under the key its field points at', () => {
    const [referencedKey] = segmentField.dynamic.split('.')

    expect(referencedKey).toBe(segmentDropdown.key)
    expect(App.triggers[segmentDropdown.key]).toBe(segmentDropdown)
  })

  it('is hidden, so it never appears as a trigger a user can choose', () => {
    expect(segmentDropdown.display.hidden).toBe(true)
  })

  it('scopes the read to the chosen workspace', async () => {
    const scope = nock(CLOUD_API_URL)
      .get('/api/segments.list')
      .query({ workspace_id: 'acme' })
      .reply(200, segments)

    const choices = await appTester(listSegments, {
      authData,
      inputData: { workspace_id: 'acme' },
    })

    expect(choices).toEqual([
      { id: 'vip', name: 'VIP Customers' },
      { id: 'churned', name: 'Churned' },
    ])
    expect(scope.isDone()).toBe(true)
  })

  it('does not ask for contact counts', async () => {
    // The count is the expensive half of segments.list and a dropdown shows an id
    // and a name, so paying for it on every render of the form buys nothing.
    const scope = nock(CLOUD_API_URL)
      .get('/api/segments.list')
      .query((query) => query.with_count === undefined)
      .reply(200, segments)

    await appTester(listSegments, { authData, inputData: { workspace_id: 'acme' } })

    expect(scope.isDone()).toBe(true)
  })

  it('answers nothing rather than throwing when the envelope changes', async () => {
    nock(CLOUD_API_URL).get('/api/segments.list').query(true).reply(200, { data: [] })

    await expect(
      appTester(listSegments, { authData, inputData: { workspace_id: 'acme' } }),
    ).resolves.toEqual([])
  })

  it('asks for a workspace before it asks the API for anything', async () => {
    await expect(appTester(listSegments, { authData, inputData: {} })).rejects.toThrow(/workspace/i)
  })
})
