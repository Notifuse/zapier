import nock from 'nock'
import { createAppTester } from 'zapier-platform-core'
import { afterEach, describe, expect, it } from 'vitest'

import App from '../../src/index.js'
import { CLOUD_API_URL } from '../../src/authentication.js'
import { sampleEnvelope } from '../../src/samples/index.js'
import type { Contact } from '../../src/shapes/index.js'
import { hookOperation } from './support.js'

const appTester = createAppTester(App)
const operation = hookOperation<Contact>('new_contact')

const authData = { apiKey: 'jwt-token' }

// A contacts.list record as Go marshals it: unset optional fields are absent
// rather than null, and the memberships ride along under contact_lists.
const apiContact = {
  email: 'bob.sample@example.com',
  external_id: 'crm-4815',
  first_name: 'Bob',
  last_name: 'Sample',
  full_name: 'Bob Sample',
  country: 'FR',
  created_at: '2024-01-15T09:30:00Z',
  updated_at: '2024-01-15T09:30:00Z',
  contact_lists: [{ list_id: 'zapsamplelist', list_name: 'Product Updates', status: 'active' }],
}

afterEach(() => {
  nock.cleanAll()
})

describe('New Contact trigger', () => {
  it('returns the delivered contact as a one-item array', async () => {
    const envelope = sampleEnvelope('contact.created')

    const results = await appTester(operation.perform, {
      authData,
      inputData: { workspace_id: 'acme' },
      cleanedRequest: envelope,
    })

    expect(Array.isArray(results)).toBe(true)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      id: envelope.id,
      email: 'bob.sample@example.com',
      first_name: 'Bob',
      job_title: 'Head of Coffee',
    })
  })

  it('emits the canonical contact and no raw payload field', async () => {
    // db_created_at and db_updated_at reach the webhook because the payload is
    // to_jsonb() over the row, and no read endpoint can reproduce them. A field
    // that exists on one path only is what silently blanks a user's mapping.
    const [record] = await appTester(operation.perform, {
      authData,
      inputData: { workspace_id: 'acme' },
      cleanedRequest: sampleEnvelope('contact.created'),
    })

    expect(record).not.toHaveProperty('db_created_at')
    expect(record).not.toHaveProperty('db_updated_at')
    expect(record).not.toHaveProperty('contact')
    expect(record).not.toHaveProperty('type')
  })

  it('says so when the delivery carries no contact', async () => {
    await expect(
      appTester(operation.perform, {
        authData,
        inputData: { workspace_id: 'acme' },
        cleanedRequest: { id: 'delivery-1', type: 'contact.created', data: {} },
      }),
    ).rejects.toThrow(/contact/)
  })

  it('lists recent contacts with zero subscription state', async () => {
    // performList runs in the Zap editor *instead of* subscribing, so there is no
    // subscribeData, no targetUrl, and no guarantee any delivery has ever happened.
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
    expect(results[0]).toMatchObject({
      id: 'contact:bob.sample@example.com',
      email: 'bob.sample@example.com',
      first_name: 'Bob',
    })
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
      cleanedRequest: sampleEnvelope('contact.created'),
    })

    expect(Object.keys(listed).sort()).toEqual(Object.keys(delivered).sort())
  })

  it('honours the number of samples the editor asked for', async () => {
    const scope = nock(CLOUD_API_URL)
      .get('/api/contacts.list')
      .query({ workspace_id: 'acme', limit: '3' })
      .reply(200, { contacts: [] })

    const results = await appTester(operation.performList, {
      authData,
      inputData: { workspace_id: 'acme' },
      meta: { limit: 3 },
    })

    expect(scope.isDone()).toBe(true)
    expect(results).toEqual([])
  })

  it('returns an array when the workspace has no contacts yet', async () => {
    nock(CLOUD_API_URL).get('/api/contacts.list').query(true).reply(200, { contacts: [] })

    const results = await appTester(operation.performList, {
      authData,
      inputData: { workspace_id: 'acme' },
    })

    expect(results).toEqual([])
  })

  it('offers a sample whose every key the delivered record also has', async () => {
    // Direction matters: a key in the sample that the live payload lacks is
    // exactly what breaks a user's field mappings.
    const [delivered] = await appTester(operation.perform, {
      authData,
      inputData: { workspace_id: 'acme' },
      cleanedRequest: sampleEnvelope('contact.created'),
    })
    const sample = operation.sample ?? {}

    expect(Object.keys(sample).length).toBeGreaterThan(0)
    for (const key of Object.keys(sample)) {
      expect(delivered).toHaveProperty(key)
    }
  })

  it('keeps the workspace-specific custom slots out of the sample', async () => {
    // custom_string_1 means something different in every workspace, so a sample
    // advertising one teaches a mapping that is wrong for most users.
    const sample = operation.sample ?? {}

    expect(Object.keys(sample).filter((key) => key.startsWith('custom_'))).toEqual([])
    expect(sample).toMatchObject({ email: 'bob.sample@example.com', first_name: 'Bob' })
  })

  it('dates the sample in ISO 8601 with an offset', () => {
    const sample = operation.sample ?? {}

    expect(sample.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/)
  })
})
