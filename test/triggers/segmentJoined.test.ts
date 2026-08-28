import nock from 'nock'
import { createAppTester } from 'zapier-platform-core'
import { afterEach, describe, expect, it } from 'vitest'

import App from '../../src/index.js'
import { CLOUD_API_URL } from '../../src/authentication.js'
import { sampleEnvelope } from '../../src/samples/index.js'
import type { SegmentMembership } from '../../src/shapes/index.js'
import { hookOperation } from './support.js'

const appTester = createAppTester(App)
const operation = hookOperation<SegmentMembership>('segment_joined')

const authData = { apiKey: 'jwt-token' }
const inputData = { workspace_id: 'acme', segment_id: 'zapsampleseg' }

// segments.contacts?expand=contact answers "who is in this segment" with the
// contact nested beside the moment it entered, most recently joined first.
const apiMember = {
  contact: { email: 'bob.sample@example.com', first_name: 'Bob' },
  matched_at: '2024-01-15T09:30:00Z',
}

afterEach(() => {
  nock.cleanAll()
})

describe('Contact Joined Segment trigger', () => {
  it('returns the delivered membership as a one-item array', async () => {
    const envelope = sampleEnvelope('segment.joined')

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

  it('subscribes to segment.joined for the chosen segment only', async () => {
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
      event_types: ['segment.joined'],
      segment_ids: ['zapsampleseg'],
      name: 'Zapier — Contact Joined Segment',
    })
  })

  it('drops a delivery for a segment this Zap is not watching', async () => {
    const envelope = { ...sampleEnvelope('segment.joined') }
    envelope.data = { ...envelope.data, segment_id: 'othersegment' }

    const results = await appTester(operation.perform, {
      authData,
      inputData,
      cleanedRequest: envelope,
    })

    expect(results).toEqual([])
  })

  it('lists current members with zero subscription state', async () => {
    const scope = nock(CLOUD_API_URL)
      .get('/api/segments.contacts')
      .query({ workspace_id: 'acme', segment_id: 'zapsampleseg', expand: 'contact', limit: '10' })
      .reply(200, { contacts: [apiMember], limit: 10, offset: 0 })
      .get('/api/segments.get')
      .query({ workspace_id: 'acme', id: 'zapsampleseg' })
      .reply(200, { segment: { id: 'zapsampleseg', name: 'Recent Buyers' } })

    const results = await appTester(operation.performList, { authData, inputData })

    expect(scope.isDone()).toBe(true)
    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({
      id: 'segment:zapsampleseg:bob.sample@example.com',
      email: 'bob.sample@example.com',
      segment_id: 'zapsampleseg',
      segment_name: 'Recent Buyers',
      occurred_at: '2024-01-15T09:30:00.000Z',
    })
  })

  it('still lists members when the segment name cannot be read', async () => {
    // The name is decoration on this path — the hook payload carries its own — so
    // losing it must not cost the editor its sample records.
    nock(CLOUD_API_URL)
      .get('/api/segments.contacts')
      .query(true)
      .reply(200, { contacts: [apiMember] })
      .get('/api/segments.get')
      .query(true)
      .reply(403, { error: 'Insufficient permissions: read access to segments required' })

    const results = await appTester(operation.performList, { authData, inputData })

    expect(results).toHaveLength(1)
    expect(results[0].segment_name).toBeNull()
  })

  it('reports a segment that no longer exists', async () => {
    nock(CLOUD_API_URL)
      .get('/api/segments.contacts')
      .query(true)
      .reply(404, { error: 'Segment not found' })

    await expect(appTester(operation.performList, { authData, inputData })).rejects.toThrow(
      /Segment not found/,
    )
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
      cleanedRequest: sampleEnvelope('segment.joined'),
    })

    expect(Object.keys(listed).sort()).toEqual(Object.keys(delivered).sort())
  })

  it('needs a segment before it can list anything', async () => {
    await expect(
      appTester(operation.performList, { authData, inputData: { workspace_id: 'acme' } }),
    ).rejects.toThrow(/Segment/)
  })

  it('offers a sample whose every key the delivered record also has', async () => {
    const [delivered] = await appTester(operation.perform, {
      authData,
      inputData,
      cleanedRequest: sampleEnvelope('segment.joined'),
    })
    const sample = operation.sample ?? {}

    expect(Object.keys(sample).length).toBeGreaterThan(0)
    for (const key of Object.keys(sample)) {
      expect(delivered).toHaveProperty(key)
    }
    expect(sample).toMatchObject({ segment_name: 'Recent Buyers' })
  })
})
