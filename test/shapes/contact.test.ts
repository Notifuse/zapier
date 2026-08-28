import { describe, expect, it } from 'vitest'

import { sampleEnvelope } from '../../src/samples/index.js'
import { fromApi, fromWebhook } from '../../src/shapes/contact.js'

// The canonical contact field set, written out rather than derived, because this
// list *is* the contract: it is the same set the backend's integration test
// (tests/integration/webhook_api_parity_test.go, canonicalContactFields) holds the
// webhook payload and contacts.list to, plus the `id` Zapier records carry.
//
// Deriving it from the implementation would pin nothing — a field dropped from the
// shape would silently disappear from the expectation too.
const CANONICAL_CONTACT_KEYS = [
  'id',
  'email',
  'external_id',
  'timezone',
  'language',
  'first_name',
  'last_name',
  'full_name',
  'phone',
  'address_line_1',
  'address_line_2',
  'country',
  'postcode',
  'state',
  'job_title',
  'custom_string_1',
  'custom_string_2',
  'custom_string_3',
  'custom_string_4',
  'custom_string_5',
  'custom_number_1',
  'custom_number_2',
  'custom_number_3',
  'custom_number_4',
  'custom_number_5',
  'custom_datetime_1',
  'custom_datetime_2',
  'custom_datetime_3',
  'custom_datetime_4',
  'custom_datetime_5',
  'custom_json_1',
  'custom_json_2',
  'custom_json_3',
  'custom_json_4',
  'custom_json_5',
  'created_at',
  'updated_at',
].sort()

// A contacts.list record as Go marshals it: unset optional fields are omitted
// rather than sent as null, the db_* bookkeeping columns are absent entirely, and
// the memberships ride along under contact_lists.
const apiContact = {
  email: 'bob.sample@example.com',
  external_id: 'crm-4815',
  timezone: 'Europe/Paris',
  language: 'en',
  first_name: 'Bob',
  last_name: 'Sample',
  full_name: 'Bob Sample',
  phone: '+33123456789',
  country: 'FR',
  job_title: 'Head of Coffee',
  custom_string_1: 'gold',
  custom_number_1: 149.5,
  custom_datetime_1: '2024-01-15T09:30:00Z',
  custom_json_1: { plan: 'pro', seats: 3 },
  created_at: '2024-01-15T09:30:00Z',
  updated_at: '2024-01-15T09:30:00Z',
  contact_lists: [
    {
      email: 'bob.sample@example.com',
      list_id: 'zapsamplelist',
      list_name: 'Product Updates',
      status: 'active',
      created_at: '2024-01-15T09:30:00Z',
      updated_at: '2024-01-15T09:30:00Z',
      deleted_at: null,
    },
  ],
  contact_segments: null,
}

describe('contact shape', () => {
  it('produces the same keys from a webhook payload and from an API record', () => {
    const fromHook = fromWebhook(sampleEnvelope('contact.created'))
    const fromRead = fromApi(apiContact)

    expect(Object.keys(fromHook).sort()).toEqual(CANONICAL_CONTACT_KEYS)
    expect(Object.keys(fromRead).sort()).toEqual(Object.keys(fromHook).sort())
  })

  it('keeps the key set identical when the API omits every optional field', () => {
    // The two sources disagree about how to spell "unset": the webhook sends the
    // column as null, the API leaves the key out. A Zap mapping a field that
    // exists on one path and not the other resolves to blank forever, so both
    // collapse to a present, null key.
    const sparse = fromApi({ email: 'nobody@example.com' })

    expect(Object.keys(sparse).sort()).toEqual(CANONICAL_CONTACT_KEYS)
    expect(sparse.first_name).toBeNull()
    expect(sparse.custom_string_5).toBeNull()
    expect(sparse.custom_json_3).toBeNull()
    expect(sparse.created_at).toBeNull()
  })

  it('reads the contact out of the webhook envelope, not the envelope itself', () => {
    const record = fromWebhook(sampleEnvelope('contact.created'))

    expect(record.email).toBe('bob.sample@example.com')
    expect(record.first_name).toBe('Bob')
    expect(record.job_title).toBe('Head of Coffee')
    expect(record.custom_string_1).toBe('gold')
    expect(record.custom_number_1).toBe(149.5)
    expect(record.custom_json_1).toEqual({ plan: 'pro', seats: 3 })
    expect(record.postcode).toBe('75011')
  })

  // Every key a Zap author can map has to carry a value here, because this record is
  // the static `sample` both contact triggers publish — and that sample is what the
  // field picker shows while a Zap is being built, before any real delivery has
  // arrived. A null there is a key with no preview: the mapping still works at
  // runtime, but the author has nothing to recognise the field by.
  //
  // The custom slots are excluded on purpose: their labels are per-workspace, so the
  // triggers strip them from the contact samples entirely.
  it('leaves no mappable contact field without a preview value', () => {
    const record = fromWebhook(sampleEnvelope('contact.created')) as unknown as Record<string, unknown>

    const withoutPreview = Object.entries(record)
      .filter(([key]) => !key.startsWith('custom_'))
      .filter(([, value]) => value === null || value === undefined)
      .map(([key]) => key)

    expect(withoutPreview).toEqual([])
  })

  it('carries the delivery id from the hook and a stable derived id from a read', () => {
    // Hook triggers are not deduplicated, so `id` is for legibility and support,
    // never a dedup key. The read path has no delivery to name, so it derives one
    // that is stable across polls instead of inventing a fresh value each time.
    expect(fromWebhook(sampleEnvelope('contact.created')).id).toBe(
      sampleEnvelope('contact.created').id,
    )

    expect(fromApi(apiContact).id).toBe('contact:bob.sample@example.com')
    expect(fromApi(apiContact).id).toBe(fromApi(apiContact).id)
  })

  it('drops the fields only one source has', () => {
    const fromHook = fromWebhook(sampleEnvelope('contact.updated'))
    const fromRead = fromApi(apiContact)

    // db_created_at / db_updated_at reach the webhook because the payload is
    // to_jsonb() over the row; the API never marshals them.
    expect(fromHook).not.toHaveProperty('db_created_at')
    expect(fromHook).not.toHaveProperty('db_updated_at')

    // contact_lists, contact_segments and email_hmac travel the other way.
    expect(fromRead).not.toHaveProperty('contact_lists')
    expect(fromRead).not.toHaveProperty('contact_segments')
    expect(fromRead).not.toHaveProperty('email_hmac')
  })

  it('renders every timestamp as the same instant in ISO 8601 UTC', () => {
    // PostgreSQL renders a timestamptz in the session time zone, so the same
    // instant arrives as an offset through the webhook and as "Z" through the
    // API. Zapier date fields want ISO 8601 with an offset; users want one
    // spelling.
    const offset = fromApi({
      email: 'bob.sample@example.com',
      created_at: '2024-01-15T10:30:00+01:00',
      updated_at: '2024-01-15T09:30:00.123456Z',
      custom_datetime_1: '2024-01-15T09:30:00+00:00',
    })

    expect(offset.created_at).toBe('2024-01-15T09:30:00.000Z')
    expect(offset.updated_at).toBe('2024-01-15T09:30:00.123Z')
    expect(offset.custom_datetime_1).toBe('2024-01-15T09:30:00.000Z')
  })

  it('passes an unparseable timestamp through rather than dropping it', () => {
    const record = fromApi({ email: 'bob.sample@example.com', created_at: 'not a date' })

    expect(record.created_at).toBe('not a date')
  })

  it('says so when there is no record to read at all', () => {
    // contacts.upsert leaves its read-back contact unset when the write committed
    // and the read after it did not, and a create chaining off that response would
    // otherwise fail on `undefined` several frames from the cause.
    expect(() => fromApi(undefined)).toThrow(/returned none/)
  })

  it('rejects an envelope that carries no contact', () => {
    expect(() =>
      fromWebhook({
        id: 'delivery-1',
        type: 'contact.created',
        workspace_id: 'ws',
        timestamp: '2024-01-15T09:30:00Z',
        data: {},
      }),
    ).toThrow(/contact/)
  })
})
