import nock from 'nock'
import { createAppTester } from 'zapier-platform-core'
import { afterEach, describe, expect, it } from 'vitest'

import App from '../../src/index.js'
import { CLOUD_API_URL } from '../../src/authentication.js'
import { sampleEnvelope } from '../../src/samples/index.js'
import type { Contact } from '../../src/shapes/index.js'
import { hookOperation, registeredTrigger } from './support.js'

const appTester = createAppTester(App)
const operation = hookOperation<Contact>('updated_contact')

const authData = { apiKey: 'jwt-token' }

const apiContact = {
  email: 'bob.sample@example.com',
  first_name: 'Bob',
  job_title: 'VP of Coffee',
  created_at: '2024-01-15T09:30:00Z',
  updated_at: '2024-01-16T11:00:00Z',
}

afterEach(() => {
  nock.cleanAll()
})

describe('Updated Contact trigger', () => {
  it('returns the updated contact as a one-item array', async () => {
    const envelope = sampleEnvelope('contact.updated')

    const results = await appTester(operation.perform, {
      authData,
      inputData: { workspace_id: 'acme' },
      cleanedRequest: envelope,
    })

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ id: envelope.id, job_title: 'VP of Coffee' })
  })

  it('subscribes to contact.updated alone', async () => {
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
      inputData: { workspace_id: 'acme' },
      targetUrl: 'https://hooks.zapier.com/hooks/standard/1234/abcdef/',
    })

    expect(body).toMatchObject({
      event_types: ['contact.updated'],
      name: 'Zapier — Updated Contact',
      source: 'zapier',
    })
  })

  it('warns that an update changing nothing does not fire', () => {
    // The database trigger compares an explicit column list, so a write that
    // stores the same values everywhere emits no event at all. A user testing the
    // Zap by re-saving an unchanged contact would otherwise conclude it is broken.
    expect(registeredTrigger('updated_contact').display.description).toMatch(/unchanged/i)
  })

  it('lists recent contacts with zero subscription state', async () => {
    // The same source as New Contact: there is no "recently updated" listing, and
    // performList only has to produce records of the right shape for the editor.
    const scope = nock(CLOUD_API_URL)
      .get('/api/contacts.list')
      .query({ workspace_id: 'acme', limit: '10' })
      .reply(200, { contacts: [apiContact] })

    const results = await appTester(operation.performList, {
      authData,
      inputData: { workspace_id: 'acme' },
    })

    expect(scope.isDone()).toBe(true)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ email: 'bob.sample@example.com', job_title: 'VP of Coffee' })
  })

  it('returns the same keys from a delivery and from a listing', async () => {
    nock(CLOUD_API_URL).get('/api/contacts.list').query(true).reply(200, { contacts: [apiContact] })

    const [listed] = await appTester(operation.performList, {
      authData,
      inputData: { workspace_id: 'acme' },
    })
    const [delivered] = await appTester(operation.perform, {
      authData,
      inputData: { workspace_id: 'acme' },
      cleanedRequest: sampleEnvelope('contact.updated'),
    })

    expect(Object.keys(listed).sort()).toEqual(Object.keys(delivered).sort())
  })

  it('offers a sample whose every key the delivered record also has', async () => {
    const [delivered] = await appTester(operation.perform, {
      authData,
      inputData: { workspace_id: 'acme' },
      cleanedRequest: sampleEnvelope('contact.updated'),
    })
    const sample = operation.sample ?? {}

    expect(Object.keys(sample).length).toBeGreaterThan(0)
    for (const key of Object.keys(sample)) {
      expect(delivered).toHaveProperty(key)
    }
    expect(Object.keys(sample).filter((key) => key.startsWith('custom_'))).toEqual([])
  })
})
