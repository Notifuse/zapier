import type { InputFields, PlainInputField } from 'zapier-platform-core'
import nock from 'nock'
import { createAppTester } from 'zapier-platform-core'
import { afterEach, describe, expect, it } from 'vitest'

import { CLOUD_API_URL } from '../../src/constants.js'
import upsertContact, {
  buildContactPayload,
  contactInputFields,
  performUpsert,
} from '../../src/creates/upsertContact.js'
import App from '../../src/index.js'

const appTester = createAppTester(App)
const authData = { apiKey: 'jwt-token' }

/** A contacts.upsert response: the operation, with the row it left behind. */
const upsertResponse = {
  email: 'bob.sample@example.com',
  action: 'update',
  contact: {
    email: 'bob.sample@example.com',
    external_id: 'crm-4815',
    first_name: 'Bob',
    timezone: 'Europe/Paris',
    custom_string_1: 'gold',
    created_at: '2026-08-01T09:30:00Z',
    updated_at: '2026-08-25T14:12:00.123456Z',
  },
}

/** Captures the JSON body the action posts, so a test can assert on it. */
const captureUpsert = (): { body: Record<string, unknown> } => {
  const captured: { body: Record<string, unknown> } = { body: {} }

  nock(CLOUD_API_URL)
    .post('/api/contacts.upsert', (body: Record<string, unknown>) => {
      captured.body = body
      return true
    })
    .reply(200, upsertResponse)

  return captured
}

const plainFields = (fields: InputFields | undefined): PlainInputField[] =>
  (fields ?? []).filter((field): field is PlainInputField => typeof field !== 'function')

afterEach(() => {
  nock.cleanAll()
})

describe('create or update contact', () => {
  it('is registered under its own key, and is one a user can choose', () => {
    expect(App.creates[upsertContact.key]).toBe(upsertContact)
    expect(upsertContact.display.hidden).not.toBe(true)
  })

  it('states the behaviours a user would otherwise discover by accident', () => {
    const description = upsertContact.display.description ?? ''

    // An upsert is keyed on the address, blank fields are left alone, and this
    // action does not touch list memberships — none of that is visible from the
    // form.
    expect(description).toMatch(/email address/i)
    expect(description).toMatch(/blank/i)
    expect(description).toMatch(/Subscribe Contact to List/)
    expect(description.length).toBeLessThanOrEqual(1000)
  })

  it('requires a workspace and an address, and nothing else', () => {
    const fields = plainFields(upsertContact.operation.inputFields)

    expect(fields[0]?.key).toBe('workspace_id')
    expect(fields.map((field) => field.key)).toContain('email')
    expect(fields.filter((field) => field.required === true).map((field) => field.key)).toEqual([
      'workspace_id',
      'email',
    ])
  })

  it('renders the custom fields from the workspace labels, at form time', () => {
    // The twenty slots are legible only under the names the workspace gave them,
    // and those are knowable only while the form is being rendered.
    const functions = (upsertContact.operation.inputFields ?? []).filter(
      (field) => typeof field === 'function',
    )

    expect(functions).toHaveLength(1)
  })

  it('posts the contact and reports the stored row', async () => {
    const captured = captureUpsert()

    const result = await appTester(performUpsert, {
      authData,
      inputData: {
        workspace_id: 'acme',
        email: 'bob.sample@example.com',
        first_name: 'Bob',
      },
    })

    expect(captured.body).toEqual({
      workspace_id: 'acme',
      contact: { email: 'bob.sample@example.com', first_name: 'Bob' },
    })

    // The stored row, not the request: the resolved external id and the merged
    // custom field are what a later step has to be able to map.
    expect(result).toMatchObject({
      id: 'contact:bob.sample@example.com',
      email: 'bob.sample@example.com',
      action: 'update',
      external_id: 'crm-4815',
      custom_string_1: 'gold',
    })
  })

  it('renders every timestamp as one instant, whatever precision the API sent', async () => {
    captureUpsert()

    const result = await appTester(performUpsert, {
      authData,
      inputData: { workspace_id: 'acme', email: 'bob.sample@example.com' },
    })

    expect(result.created_at).toBe('2026-08-01T09:30:00.000Z')
    expect(result.updated_at).toBe('2026-08-25T14:12:00.123Z')
  })

  it('keeps its schema when the read-back after the write did not come through', async () => {
    // The write has already committed. Failing here would invite a retry of a
    // successful upsert, and a shorter output would change the shape a Zap maps.
    nock(CLOUD_API_URL)
      .post('/api/contacts.upsert')
      .reply(200, { email: 'bob.sample@example.com', action: 'create' })

    const result = await appTester(performUpsert, {
      authData,
      inputData: { workspace_id: 'acme', email: 'bob.sample@example.com' },
    })

    expect(result.email).toBe('bob.sample@example.com')
    expect(result.action).toBe('create')
    expect(result.first_name).toBeNull()
    expect(Object.keys(result)).toContain('custom_json_5')
  })

  it('sends no key for a field the user left blank', async () => {
    // Zapier hands a blank field through as an empty string, and sending that
    // would erase what is stored — a Zap fed by sparse records would take a
    // contact apart one field at a time.
    const captured = captureUpsert()

    await appTester(performUpsert, {
      authData,
      inputData: {
        workspace_id: 'acme',
        email: 'bob.sample@example.com',
        first_name: '',
        last_name: '   ',
        custom_string_1: '',
      },
    })

    expect(captured.body.contact).toEqual({ email: 'bob.sample@example.com' })
  })

  it('coerces each kind of custom slot to what its column holds', () => {
    const payload = buildContactPayload({
      email: 'bob.sample@example.com',
      custom_string_1: 'gold',
      custom_number_2: '42.5',
      custom_datetime_3: '2026-08-25T14:12:00-05:00',
      custom_json_4: '{"tier":"gold"}',
    })

    expect(payload).toEqual({
      email: 'bob.sample@example.com',
      custom_string_1: 'gold',
      custom_number_2: 42.5,
      custom_datetime_3: '2026-08-25T19:12:00.000Z',
      custom_json_4: { tier: 'gold' },
    })
  })

  it('stores unparseable JSON as text rather than failing the run', () => {
    // The column takes any JSON value and a JSON string is one, so punctuation in
    // a mapped field is not worth halting a Zap over. The field's help says so.
    const payload = buildContactPayload({
      email: 'bob.sample@example.com',
      custom_json_1: 'not json {',
    })

    expect(payload.custom_json_1).toBe('not json {')
  })

  // The half of that promise this repository cannot keep on its own.
  //
  // A payload-builder assertion proves what the app INTENDS to send, and the field
  // help ("A value that is not valid JSON is stored as plain text") is a claim about
  // what Notifuse ACCEPTS. Those were two different things: contacts.upsert used to
  // refuse any custom_json value that was not an object or an array, so a Zap mapping
  // a plain-text column into a JSON slot — exactly what the help invites — failed
  // every run with HTTP 400, while the identical mapping through Subscribe Contact to
  // List succeeded. This pins the bytes that go on the wire, and the backend pins the
  // other side in TestFromJSON ("a scalar custom_json lands identically through upsert
  // and subscribe", internal/domain/contact_test.go).
  it('puts a bare JSON scalar on the wire for a slot that does not parse', async () => {
    const captured = captureUpsert()

    await appTester(performUpsert, {
      authData,
      inputData: {
        workspace_id: 'acme',
        email: 'bob.sample@example.com',
        custom_json_1: 'gold',
        custom_json_2: '42',
        custom_json_3: 'not json {',
      },
    })

    expect(captured.body.contact).toEqual({
      email: 'bob.sample@example.com',
      custom_json_1: 'gold',
      // '42' parses as JSON, so it travels as the number the column stores.
      custom_json_2: 42,
      custom_json_3: 'not json {',
    })
  })

  // The action promises that "fields left blank are left as they are stored rather
  // than emptied", and the API keeps that promise by key: an absent key preserves
  // the column, an explicit null empties it. So a null on the wire is not a smaller
  // version of sending nothing — it is the opposite of it, and it destroys data a
  // Zap only meant to leave alone.
  it('sends no key for a JSON slot whose value renders as null', async () => {
    // 'null' is valid JSON, so a source cell holding it — or a formatter step that
    // spells an empty value that way — parses to null and would erase the slot.
    const captured = captureUpsert()

    await appTester(performUpsert, {
      authData,
      inputData: {
        workspace_id: 'acme',
        email: 'bob.sample@example.com',
        custom_json_1: 'null',
      },
    })

    expect(Object.keys(captured.body.contact as Record<string, unknown>)).not.toContain(
      'custom_json_1',
    )
    expect(captured.body.contact).toEqual({ email: 'bob.sample@example.com' })
  })

  it('sends no key for a value no text column can hold', () => {
    // Mapping a line-item array or a whole object into a text slot is a mistake a
    // Zap author makes in the editor, where the field accepts anything. Reading it
    // as nothing is right; sending that nothing as null is not.
    const payload = buildContactPayload({
      email: 'bob.sample@example.com',
      custom_string_1: { tier: 'gold' },
      custom_string_2: ['gold', 'silver'],
    })

    expect(payload).toEqual({ email: 'bob.sample@example.com' })
  })

  it('names the field when a value cannot be what its column needs', () => {
    // The API refuses the whole request over one malformed timestamp, so the
    // message has to say which field — otherwise the user sees a parse error from
    // a language they are not writing in.
    expect(() =>
      buildContactPayload({ email: 'bob.sample@example.com', custom_datetime_1: 'last tuesday' }),
    ).toThrow(/custom_datetime_1/)

    expect(() =>
      buildContactPayload({ email: 'bob.sample@example.com', custom_number_1: 'a lot' }),
    ).toThrow(/custom_number_1/)
  })

  it('refuses to write a contact with no address to identify it', () => {
    expect(() => buildContactPayload({})).toThrow(/email/i)
  })

  it('describes the contact once, for both actions to ask with', () => {
    // Both actions write a Contact. A field spelled one way here and another way
    // there would write two different contacts from the same source record.
    const keys = contactInputFields.map((field) => field.key)

    expect(keys).toContain('email')
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('keeps its sample within the keys a run actually produces', async () => {
    // A key in the sample that the live payload lacks is what silently blanks a
    // user's field mappings — the direction of this check is the whole point.
    captureUpsert()

    const result = await appTester(performUpsert, {
      authData,
      inputData: { workspace_id: 'acme', email: 'bob.sample@example.com' },
    })

    const live = Object.keys(result)
    for (const key of Object.keys(upsertContact.operation.sample ?? {})) {
      expect(live).toContain(key)
    }
  })
})
