import nock from 'nock'
import { createAppTester } from 'zapier-platform-core'
import { afterEach, describe, expect, it } from 'vitest'

import App from '../../src/index.js'
import { CLOUD_API_URL } from '../../src/authentication.js'
import { sampleEnvelope } from '../../src/samples/index.js'
import type { ListMembership } from '../../src/shapes/index.js'
import { hookOperation } from './support.js'

const appTester = createAppTester(App)
const operation = hookOperation<ListMembership>('contact_unsubscribed')

const authData = { apiKey: 'jwt-token' }
const inputData = { workspace_id: 'acme', list_id: 'zapsamplelist' }

const apiContact = {
  email: 'bob.sample@example.com',
  contact_lists: [
    {
      list_id: 'zapsamplelist',
      list_name: 'Product Updates',
      status: 'unsubscribed',
      created_at: '2024-01-15T09:30:00Z',
      updated_at: '2024-02-01T08:00:00Z',
    },
  ],
}

afterEach(() => {
  nock.cleanAll()
})

describe('Contact Unsubscribed From List trigger', () => {
  it('returns the unsubscription as a one-item array', async () => {
    const envelope = sampleEnvelope('list.unsubscribed')

    const results = await appTester(operation.perform, {
      authData,
      inputData,
      cleanedRequest: envelope,
    })

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      id: envelope.id,
      email: 'bob.sample@example.com',
      list_id: 'zapsamplelist',
      status: 'unsubscribed',
      previous_status: 'active',
      event_type: 'list.unsubscribed',
    })
  })

  it('subscribes to list.unsubscribed for the chosen list only', async () => {
    let body: Record<string, unknown> = {}
    nock(CLOUD_API_URL)
      .get('/api/webhookSubscriptions.list')
      .query(true)
      .reply(200, { subscriptions: [] })
      .post('/api/webhookSubscriptions.create', (posted: Record<string, unknown>) => {
        body = posted
        return true
      })
      .reply(201, { subscription: { id: 'sub_new' } })

    await appTester(operation.performSubscribe, {
      authData,
      inputData,
      targetUrl: 'https://hooks.zapier.com/hooks/standard/1234/abcdef/',
    })

    expect(body).toMatchObject({
      event_types: ['list.unsubscribed'],
      list_ids: ['zapsamplelist'],
      name: 'Zapier — Contact Unsubscribed From List',
    })
  })

  it('drops a delivery for a list this Zap is not watching', async () => {
    const envelope = { ...sampleEnvelope('list.unsubscribed') }
    envelope.data = { ...envelope.data, list_id: 'otherlist' }

    const results = await appTester(operation.perform, {
      authData,
      inputData,
      cleanedRequest: envelope,
    })

    expect(results).toEqual([])
  })

  it('lists unsubscribed members of the chosen list with zero subscription state', async () => {
    // Asking the read endpoint for the status this trigger is about is what makes
    // the editor's sample records resemble the ones the hook will deliver.
    const scope = nock(CLOUD_API_URL)
      .get('/api/contacts.list')
      .query({
        workspace_id: 'acme',
        list_id: 'zapsamplelist',
        contact_list_status: 'unsubscribed',
        with_contact_lists: 'true',
        limit: '10',
      })
      .reply(200, { contacts: [apiContact] })

    const results = await appTester(operation.performList, { authData, inputData })

    expect(scope.isDone()).toBe(true)
    expect(results[0]).toMatchObject({
      email: 'bob.sample@example.com',
      list_id: 'zapsamplelist',
      status: 'unsubscribed',
    })
  })

  it('returns the same keys from a delivery and from a listing', async () => {
    nock(CLOUD_API_URL).get('/api/contacts.list').query(true).reply(200, { contacts: [apiContact] })

    const [listed] = await appTester(operation.performList, { authData, inputData })
    const [delivered] = await appTester(operation.perform, {
      authData,
      inputData,
      cleanedRequest: sampleEnvelope('list.unsubscribed'),
    })

    expect(Object.keys(listed).sort()).toEqual(Object.keys(delivered).sort())
  })

  it('offers a sample whose every key the delivered record also has', async () => {
    const [delivered] = await appTester(operation.perform, {
      authData,
      inputData,
      cleanedRequest: sampleEnvelope('list.unsubscribed'),
    })
    const sample = operation.sample ?? {}

    expect(Object.keys(sample).length).toBeGreaterThan(0)
    for (const key of Object.keys(sample)) {
      expect(delivered).toHaveProperty(key)
    }
    expect(sample).toMatchObject({ status: 'unsubscribed', previous_status: 'active' })
  })
})
