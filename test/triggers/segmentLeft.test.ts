import nock from 'nock'
import { createAppTester } from 'zapier-platform-core'
import { afterEach, describe, expect, it } from 'vitest'

import App from '../../src/index.js'
import { CLOUD_API_URL } from '../../src/authentication.js'
import { sampleEnvelope } from '../../src/samples/index.js'
import type { SegmentMembership } from '../../src/shapes/index.js'
import { hookOperation } from './support.js'

const appTester = createAppTester(App)
const operation = hookOperation<SegmentMembership>('segment_left')

const authData = { apiKey: 'jwt-token' }
const inputData = { workspace_id: 'acme', segment_id: 'zapsampleseg' }

const apiMember = {
  contact: { email: 'bob.sample@example.com', first_name: 'Bob' },
  matched_at: '2024-01-15T09:30:00Z',
}

afterEach(() => {
  nock.cleanAll()
})

describe('Contact Left Segment trigger', () => {
  it('returns the departure as a one-item array', async () => {
    const envelope = sampleEnvelope('segment.left')

    const results = await appTester(operation.perform, {
      authData,
      inputData,
      cleanedRequest: envelope,
    })

    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({
      id: envelope.id,
      email: 'bob.sample@example.com',
      segment_id: 'zapsampleseg',
      segment_name: 'Recent Buyers',
      occurred_at: '2024-01-15T09:30:00.000Z',
    })
  })

  it('subscribes to segment.left for the chosen segment only', async () => {
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
      event_types: ['segment.left'],
      segment_ids: ['zapsampleseg'],
      name: 'Zapier — Contact Left Segment',
    })
  })

  it('drops a delivery for a segment this Zap is not watching', async () => {
    const envelope = { ...sampleEnvelope('segment.left') }
    envelope.data = { ...envelope.data, segment_id: 'othersegment' }

    const results = await appTester(operation.perform, {
      authData,
      inputData,
      cleanedRequest: envelope,
    })

    expect(results).toEqual([])
  })

  it('samples the editor from current members, the only listing that exists', async () => {
    // Nothing records who has left a segment, so the editor is shown members of it
    // instead: same shape, same keys, real addresses to map against.
    const scope = nock(CLOUD_API_URL)
      .get('/api/segments.contacts')
      .query({ workspace_id: 'acme', segment_id: 'zapsampleseg', expand: 'contact', limit: '10' })
      .reply(200, { contacts: [apiMember] })
      .get('/api/segments.get')
      .query(true)
      .reply(200, { segment: { id: 'zapsampleseg', name: 'Recent Buyers' } })

    const results = await appTester(operation.performList, { authData, inputData })

    expect(scope.isDone()).toBe(true)
    expect(results[0]).toMatchObject({
      email: 'bob.sample@example.com',
      segment_id: 'zapsampleseg',
      segment_name: 'Recent Buyers',
    })
  })

  it('returns the same keys from a delivery and from a listing', async () => {
    nock(CLOUD_API_URL)
      .get('/api/segments.contacts')
      .query(true)
      .reply(200, { contacts: [apiMember] })
      .get('/api/segments.get')
      .query(true)
      .reply(200, { segment: { id: 'zapsampleseg', name: 'Recent Buyers' } })

    const [listed] = await appTester(operation.performList, { authData, inputData })
    const [delivered] = await appTester(operation.perform, {
      authData,
      inputData,
      cleanedRequest: sampleEnvelope('segment.left'),
    })

    expect(Object.keys(listed).sort()).toEqual(Object.keys(delivered).sort())
  })

  it('offers a sample whose every key the delivered record also has', async () => {
    const [delivered] = await appTester(operation.perform, {
      authData,
      inputData,
      cleanedRequest: sampleEnvelope('segment.left'),
    })
    const sample = operation.sample ?? {}

    expect(Object.keys(sample).length).toBeGreaterThan(0)
    for (const key of Object.keys(sample)) {
      expect(delivered).toHaveProperty(key)
    }
  })
})
