import { describe, expect, it } from 'vitest'

import { sampleEnvelope } from '../../src/samples/index.js'
import { fromApi, fromWebhook } from '../../src/shapes/listMembership.js'

// Written out rather than derived: this list is the contract between the hook
// payload and the performList record, and a derived expectation would follow the
// implementation wherever it drifted.
const CANONICAL_LIST_MEMBERSHIP_KEYS = [
  'id',
  'event_type',
  'email',
  'list_id',
  'list_name',
  'status',
  'previous_status',
  'occurred_at',
].sort()

// What contacts.list?list_id=…&with_contact_lists=true returns: the memberships
// are nested under the contact that owns them and do not repeat the address, so
// the address has to come from the contact record.
const apiContact = {
  email: 'bob.sample@example.com',
  first_name: 'Bob',
  contact_lists: [
    {
      list_id: 'otherlist',
      list_name: 'Weekly Roundup',
      status: 'unsubscribed',
      created_at: '2023-11-02T08:00:00Z',
      updated_at: '2023-12-02T08:00:00Z',
      deleted_at: null,
    },
    {
      list_id: 'zapsamplelist',
      list_name: 'Product Updates',
      status: 'active',
      created_at: '2024-01-15T09:30:00Z',
      updated_at: '2024-01-15T09:30:00Z',
      deleted_at: null,
    },
  ],
}

describe('list membership shape', () => {
  it('produces the same keys from a webhook payload and from an API record', () => {
    const fromHook = fromWebhook(sampleEnvelope('list.subscribed'))
    const fromRead = fromApi(apiContact, 'zapsamplelist')

    expect(Object.keys(fromHook).sort()).toEqual(CANONICAL_LIST_MEMBERSHIP_KEYS)
    expect(Object.keys(fromRead).sort()).toEqual(Object.keys(fromHook).sort())
  })

  it('produces one key set across every subscription event type', () => {
    // "New List Subscriber" subscribes to three event types, because
    // list.subscribed fires only on a first INSERT with status active: a
    // returning contact emits confirmed or resubscribed instead. All four have to
    // shape identically or one of the three silently blanks a user's mapping.
    const keys = (['list.subscribed', 'list.confirmed', 'list.resubscribed', 'list.unsubscribed'] as const).map(
      (eventType) => Object.keys(fromWebhook(sampleEnvelope(eventType))).sort(),
    )

    for (const keySet of keys) {
      expect(keySet).toEqual(CANONICAL_LIST_MEMBERSHIP_KEYS)
    }
  })

  it('reads the membership out of the webhook payload', () => {
    const record = fromWebhook(sampleEnvelope('list.resubscribed'))

    expect(record.email).toBe('bob.sample@example.com')
    expect(record.list_id).toBe('zapsamplelist')
    expect(record.list_name).toBe('Product Updates')
    expect(record.status).toBe('active')
    expect(record.previous_status).toBe('unsubscribed')
    expect(record.event_type).toBe('list.resubscribed')
    expect(record.occurred_at).toBe('2024-01-15T09:30:00.000Z')
  })

  it('nulls the fields a read endpoint cannot reproduce', () => {
    // previous_status is reproducible by no read endpoint, and a poll cannot know
    // which transition a membership arrived through. The keys stay present and
    // null so the schema matches the hook's.
    const record = fromApi(apiContact, 'zapsamplelist')

    expect(record.previous_status).toBeNull()
    expect(record.event_type).toBeNull()
  })

  it('takes the address from the contact and the rest from the membership', () => {
    const record = fromApi(apiContact, 'zapsamplelist')

    expect(record.email).toBe('bob.sample@example.com')
    expect(record.list_id).toBe('zapsamplelist')
    expect(record.list_name).toBe('Product Updates')
    expect(record.status).toBe('active')
    expect(record.occurred_at).toBe('2024-01-15T09:30:00.000Z')
  })

  it('keeps the requested list even when the contact carries no membership for it', () => {
    const record = fromApi({ email: 'bob.sample@example.com' }, 'zapsamplelist')

    expect(Object.keys(record).sort()).toEqual(CANONICAL_LIST_MEMBERSHIP_KEYS)
    expect(record.list_id).toBe('zapsamplelist')
    expect(record.list_name).toBeNull()
    expect(record.status).toBeNull()
    expect(record.occurred_at).toBeNull()
  })

  it('carries the delivery id from the hook and a stable derived id from a read', () => {
    expect(fromWebhook(sampleEnvelope('list.subscribed')).id).toBe(
      sampleEnvelope('list.subscribed').id,
    )
    expect(fromApi(apiContact, 'zapsamplelist').id).toBe('list:zapsamplelist:bob.sample@example.com')
  })

  it('says so when there is no record to read at all', () => {
    expect(() => fromApi(undefined, 'zapsamplelist')).toThrow(/returned none/)
  })

  it('rejects an envelope that carries no address', () => {
    expect(() =>
      fromWebhook({
        id: 'delivery-1',
        type: 'list.subscribed',
        workspace_id: 'ws',
        timestamp: '2024-01-15T09:30:00Z',
        data: { list_id: 'zapsamplelist' },
      }),
    ).toThrow(/email/)
  })
})
