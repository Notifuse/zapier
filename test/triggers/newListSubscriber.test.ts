import nock from 'nock'
import { createAppTester } from 'zapier-platform-core'
import { afterEach, describe, expect, it } from 'vitest'

import App from '../../src/index.js'
import { CLOUD_API_URL } from '../../src/authentication.js'
import { sampleEnvelope } from '../../src/samples/index.js'
import type { ListMembership } from '../../src/shapes/index.js'
import { hookOperation } from './support.js'

const appTester = createAppTester(App)
const operation = hookOperation<ListMembership>('new_list_subscriber')

const authData = { apiKey: 'jwt-token' }
const inputData = { workspace_id: 'acme', list_id: 'zapsamplelist' }

// contacts.list?list_id=…&with_contact_lists=true nests every membership the
// contact holds under the contact, and does not repeat the address inside them.
const apiContact = {
  email: 'bob.sample@example.com',
  first_name: 'Bob',
  contact_lists: [
    { list_id: 'otherlist', list_name: 'Weekly Roundup', status: 'unsubscribed' },
    {
      list_id: 'zapsamplelist',
      list_name: 'Product Updates',
      status: 'active',
      created_at: '2024-01-15T09:30:00Z',
      updated_at: '2024-01-15T09:30:00Z',
    },
  ],
}

afterEach(() => {
  nock.cleanAll()
})

describe('New List Subscriber trigger', () => {
  it('returns the delivered membership as a one-item array', async () => {
    const envelope = sampleEnvelope('list.subscribed')

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
      list_name: 'Product Updates',
      status: 'active',
      event_type: 'list.subscribed',
    })
  })

  it('fires for a returning contact, not only a brand-new one', async () => {
    // list.subscribed fires only on a first INSERT with status active. A contact
    // who confirms a double opt-in or re-subscribes emits confirmed or
    // resubscribed instead, so a trigger bound to list.subscribed alone would
    // silently miss every returning subscriber.
    for (const eventType of ['list.confirmed', 'list.resubscribed'] as const) {
      const results = await appTester(operation.perform, {
        authData,
        inputData,
        cleanedRequest: sampleEnvelope(eventType),
      })

      expect(results).toHaveLength(1)
      expect(results[0]).toMatchObject({ event_type: eventType, status: 'active' })
    }
  })

  it('subscribes to all three subscription events', async () => {
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

    expect(body.event_types).toEqual(['list.subscribed', 'list.confirmed', 'list.resubscribed'])
    expect(body.list_ids).toEqual(['zapsamplelist'])
  })

  it('exposes which transition happened rather than splitting into three triggers', async () => {
    const [record] = await appTester(operation.perform, {
      authData,
      inputData,
      cleanedRequest: sampleEnvelope('list.resubscribed'),
    })

    expect(record.event_type).toBe('list.resubscribed')
    expect(record.previous_status).toBe('unsubscribed')
  })

  it('drops a delivery for a list this Zap is not watching', async () => {
    // The server-side filter is the first line of defence, but a self-hosted
    // instance old enough to ignore list_ids would fan every list out to every
    // Zap. Returning an empty array runs no action step and consumes no task.
    const envelope = { ...sampleEnvelope('list.subscribed') }
    envelope.data = { ...envelope.data, list_id: 'otherlist' }

    const results = await appTester(operation.perform, {
      authData,
      inputData,
      cleanedRequest: envelope,
    })

    expect(results).toEqual([])
  })

  it('lists active members of the chosen list with zero subscription state', async () => {
    const scope = nock(CLOUD_API_URL)
      .get('/api/contacts.list')
      .query({
        workspace_id: 'acme',
        list_id: 'zapsamplelist',
        contact_list_status: 'active',
        with_contact_lists: 'true',
        limit: '10',
      })
      .reply(200, { contacts: [apiContact] })

    const results = await appTester(operation.performList, { authData, inputData })

    expect(scope.isDone()).toBe(true)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      id: 'list:zapsamplelist:bob.sample@example.com',
      email: 'bob.sample@example.com',
      list_id: 'zapsamplelist',
      list_name: 'Product Updates',
      status: 'active',
    })
  })

  it('returns the same keys from a delivery and from a listing', async () => {
    // previous_status and event_type are reproducible by no read endpoint, so they
    // come back null here — present and null, never missing.
    nock(CLOUD_API_URL).get('/api/contacts.list').query(true).reply(200, { contacts: [apiContact] })

    const [listed] = await appTester(operation.performList, { authData, inputData })
    const [delivered] = await appTester(operation.perform, {
      authData,
      inputData,
      cleanedRequest: sampleEnvelope('list.subscribed'),
    })

    expect(Object.keys(listed).sort()).toEqual(Object.keys(delivered).sort())
    expect(listed.previous_status).toBeNull()
    expect(listed.event_type).toBeNull()
  })

  it('needs a list before it can list anything', async () => {
    await expect(
      appTester(operation.performList, { authData, inputData: { workspace_id: 'acme' } }),
    ).rejects.toThrow(/List/)
  })

  it('offers a sample whose every key the delivered record also has', async () => {
    const [delivered] = await appTester(operation.perform, {
      authData,
      inputData,
      cleanedRequest: sampleEnvelope('list.subscribed'),
    })
    const sample = operation.sample ?? {}

    expect(Object.keys(sample).length).toBeGreaterThan(0)
    for (const key of Object.keys(sample)) {
      expect(delivered).toHaveProperty(key)
    }
    expect(sample).toMatchObject({ list_name: 'Product Updates', status: 'active' })
  })
})
