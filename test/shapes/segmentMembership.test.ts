import { describe, expect, it } from 'vitest'

import { sampleEnvelope } from '../../src/samples/index.js'
import { fromApi, fromWebhook } from '../../src/shapes/segmentMembership.js'

const CANONICAL_SEGMENT_MEMBERSHIP_KEYS = [
  'id',
  'email',
  'segment_id',
  'segment_name',
  'occurred_at',
].sort()

// One element of segments.contacts?expand=contact: the contact is nested, and the
// join time rides beside it because the segment listing has no other timestamp to
// order recent joiners by.
const apiMember = {
  contact: {
    email: 'bob.sample@example.com',
    first_name: 'Bob',
    created_at: '2024-01-15T09:30:00Z',
  },
  matched_at: '2024-01-15T09:30:00Z',
}

const segment = { id: 'zapsampleseg', name: 'Recent Buyers' }

describe('segment membership shape', () => {
  it('produces the same keys from a webhook payload and from an API record', () => {
    const fromHook = fromWebhook(sampleEnvelope('segment.joined'))
    const fromRead = fromApi(apiMember, segment)

    expect(Object.keys(fromHook).sort()).toEqual(CANONICAL_SEGMENT_MEMBERSHIP_KEYS)
    expect(Object.keys(fromRead).sort()).toEqual(Object.keys(fromHook).sort())
  })

  it('produces one key set for joining and for leaving', () => {
    expect(Object.keys(fromWebhook(sampleEnvelope('segment.left'))).sort()).toEqual(
      CANONICAL_SEGMENT_MEMBERSHIP_KEYS,
    )
  })

  it('reads the membership out of the webhook payload', () => {
    const record = fromWebhook(sampleEnvelope('segment.joined'))

    expect(record.email).toBe('bob.sample@example.com')
    expect(record.segment_id).toBe('zapsampleseg')
    expect(record.segment_name).toBe('Recent Buyers')
    expect(record.occurred_at).toBe('2024-01-15T09:30:00.000Z')
  })

  it('takes the segment from the caller, because the listing does not repeat it', () => {
    // segments.contacts answers "who is in this segment" with contacts, so the id
    // and the name come from the trigger input field the Zap author picked.
    const record = fromApi(apiMember, segment)

    expect(record.email).toBe('bob.sample@example.com')
    expect(record.segment_id).toBe('zapsampleseg')
    expect(record.segment_name).toBe('Recent Buyers')
    expect(record.occurred_at).toBe('2024-01-15T09:30:00.000Z')
  })

  it('nulls the segment name when the caller has only an id', () => {
    const record = fromApi(apiMember, { id: 'zapsampleseg' })

    expect(Object.keys(record).sort()).toEqual(CANONICAL_SEGMENT_MEMBERSHIP_KEYS)
    expect(record.segment_name).toBeNull()
  })

  it('carries the delivery id from the hook and a stable derived id from a read', () => {
    expect(fromWebhook(sampleEnvelope('segment.joined')).id).toBe(
      sampleEnvelope('segment.joined').id,
    )
    expect(fromApi(apiMember, segment).id).toBe('segment:zapsampleseg:bob.sample@example.com')
  })

  it('says so when there is no member to read at all', () => {
    expect(() => fromApi(undefined, segment)).toThrow(/returned none/)
  })

  it('rejects a listing entry that is not the expanded member shape', () => {
    // The endpoint nests the contact under `contact`; a bare contact means the
    // caller forgot expand=contact, and silently accepting it would hide that.
    expect(() => fromApi({ email: 'bob.sample@example.com' }, segment)).toThrow(/expand=contact/)
  })
})
