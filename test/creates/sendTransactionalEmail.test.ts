import type { InputFields, PlainInputField } from 'zapier-platform-core'
import nock from 'nock'
import { createAppTester } from 'zapier-platform-core'
import { afterEach, describe, expect, it } from 'vitest'

import { CLOUD_API_URL } from '../../src/constants.js'
import sendTransactionalEmail, {
  buildSendPayload,
  performSend,
} from '../../src/creates/sendTransactionalEmail.js'
import App from '../../src/index.js'

const appTester = createAppTester(App)
const authData = { apiKey: 'jwt-token' }

const sendResponse = { message_id: 'msg_01HZY', success: true }

/** The smallest input the action accepts. */
const minimal = {
  workspace_id: 'acme',
  notification_id: 'order_confirmation',
  email: 'bob.sample@example.com',
}

const captureSend = (): { body: Record<string, unknown> } => {
  const captured: { body: Record<string, unknown> } = { body: {} }

  nock(CLOUD_API_URL)
    .post('/api/transactional.send', (body: Record<string, unknown>) => {
      captured.body = body
      return true
    })
    .reply(200, sendResponse)

  return captured
}

const plainFields = (fields: InputFields | undefined): PlainInputField[] =>
  (fields ?? []).filter((field): field is PlainInputField => typeof field !== 'function')

/** The `notification` object of a captured body, narrowed for assertions. */
const notificationOf = (body: Record<string, unknown>): Record<string, unknown> =>
  body.notification as Record<string, unknown>

afterEach(() => {
  nock.cleanAll()
})

describe('send transactional email', () => {
  it('is registered under its own key, and is one a user can choose', () => {
    expect(App.creates[sendTransactionalEmail.key]).toBe(sendTransactionalEmail)
    expect(sendTransactionalEmail.display.hidden).not.toBe(true)
  })

  it('states the behaviours a user would otherwise discover by accident', () => {
    const description = sendTransactionalEmail.display.description ?? ''

    // The step writes the contact record, testing it sends real mail, and the
    // idempotency key turns a re-run into a no-op it cannot report as one. All
    // three surprise someone who reads only the action's name.
    expect(description).toMatch(/contact/i)
    expect(description).toMatch(/real email|really send|actually send/i)
    expect(description).toMatch(/message external id/i)
    expect(description.length).toBeLessThanOrEqual(1000)
  })

  it('requires a workspace, a notification and an address, and nothing else', () => {
    const fields = plainFields(sendTransactionalEmail.operation.inputFields)

    expect(fields[0]?.key).toBe('workspace_id')
    expect(fields.filter((field) => field.required === true).map((field) => field.key)).toEqual([
      'workspace_id',
      'notification_id',
      'email',
    ])
  })

  it('renders the custom fields from the workspace labels, at form time', () => {
    const functions = (sendTransactionalEmail.operation.inputFields ?? []).filter(
      (field) => typeof field === 'function',
    )

    expect(functions).toHaveLength(1)
  })

  it('sends the workspace at the root and the rest under notification', async () => {
    const captured = captureSend()

    const result = await appTester(performSend, { authData, inputData: minimal })

    expect(captured.body.workspace_id).toBe('acme')
    expect(notificationOf(captured.body)).toEqual({
      id: 'order_confirmation',
      channels: ['email'],
      contact: { email: 'bob.sample@example.com' },
    })
    expect(result).toEqual({
      id: 'msg_01HZY',
      message_id: 'msg_01HZY',
      notification_id: 'order_confirmation',
      email: 'bob.sample@example.com',
      message_external_id: null,
    })
  })

  it('always names the email channel', async () => {
    // The handler rejects an empty channels array even though the service would
    // otherwise fall back to every channel the notification configures, so the
    // body has to carry it whether or not the form mentions channels.
    const captured = captureSend()

    await appTester(performSend, { authData, inputData: minimal })

    expect(notificationOf(captured.body).channels).toEqual(['email'])
    expect(
      plainFields(sendTransactionalEmail.operation.inputFields).map((field) => field.key),
    ).not.toContain('channels')
  })

  it('keeps the two external ids apart', async () => {
    // `external_id` on the contact is the customer's id for the person;
    // `message_external_id` is the idempotency key for this send. They land in
    // different places and neither may leak into the other's slot.
    const captured = captureSend()

    const result = await appTester(performSend, {
      authData,
      inputData: {
        ...minimal,
        external_id: 'crm-4711',
        message_external_id: 'order-9912',
      },
    })

    const notification = notificationOf(captured.body)
    expect(notification.external_id).toBe('order-9912')
    expect(notification.contact).toEqual({
      email: 'bob.sample@example.com',
      external_id: 'crm-4711',
    })
    expect(result.message_external_id).toBe('order-9912')
  })

  it('omits the idempotency key when it was left blank', async () => {
    const captured = captureSend()

    await appTester(performSend, { authData, inputData: { ...minimal, message_external_id: '' } })

    expect(notificationOf(captured.body)).not.toHaveProperty('external_id')
  })

  it('passes template data and metadata through as they were typed', async () => {
    const captured = captureSend()

    await appTester(performSend, {
      authData,
      inputData: {
        ...minimal,
        data: { order_id: '01234', total: '120' },
        metadata: { zap: 'orders' },
      },
    })

    const notification = notificationOf(captured.body)
    // No coercion: "01234" is a reference, not the number 1234, and turning it
    // into one would corrupt exactly the values a template prints verbatim.
    expect(notification.data).toEqual({ order_id: '01234', total: '120' })
    expect(notification.metadata).toEqual({ zap: 'orders' })
  })

  it('omits template data and metadata when they are empty', async () => {
    const captured = captureSend()

    await appTester(performSend, { authData, inputData: { ...minimal, data: {}, metadata: {} } })

    const notification = notificationOf(captured.body)
    expect(notification).not.toHaveProperty('data')
    expect(notification).not.toHaveProperty('metadata')
  })

  it('carries the email overrides that were filled in', async () => {
    const captured = captureSend()

    await appTester(performSend, {
      authData,
      inputData: {
        ...minimal,
        subject: 'Your order',
        subject_preview: 'It is on its way',
        from_name: 'Acme Support',
        reply_to: 'support@acme.com',
        cc: ['manager@acme.com'],
        bcc: 'archive@acme.com',
      },
    })

    expect(notificationOf(captured.body).email_options).toEqual({
      subject: 'Your order',
      subject_preview: 'It is on its way',
      from_name: 'Acme Support',
      reply_to: 'support@acme.com',
      cc: ['manager@acme.com'],
      bcc: ['archive@acme.com'],
    })
  })

  it('drops blank recipients rather than letting the API refuse the send', async () => {
    // Notifuse validates every cc and bcc entry as an address, and "" is not one
    // — so a Zap whose CC column is sometimes empty would fail the whole send
    // rather than send without a CC.
    const captured = captureSend()

    await appTester(performSend, {
      authData,
      inputData: { ...minimal, cc: ['manager@acme.com', '', '  '], bcc: [''], reply_to: '' },
    })

    const options = notificationOf(captured.body).email_options as Record<string, unknown>
    expect(options).toEqual({ cc: ['manager@acme.com'] })
  })

  it('omits the options object entirely when every override is blank', async () => {
    const captured = captureSend()

    await appTester(performSend, {
      authData,
      inputData: { ...minimal, subject: '', cc: '', bcc: [], reply_to: '' },
    })

    expect(notificationOf(captured.body)).not.toHaveProperty('email_options')
  })

  it('refuses a subject longer than the API accepts, before sending', () => {
    expect(() => buildSendPayload({ ...minimal, subject: 'x'.repeat(256) })).toThrow(/subject/i)
  })

  it('measures the subject the way the API measures it', () => {
    // The server's check is Go's len(string), which counts bytes. Counting
    // JavaScript characters instead would pass a subject the API then rejects,
    // losing the whole send to a 400 the Zap author cannot explain.
    const accented = 'é'.repeat(200)
    expect(accented.length).toBeLessThanOrEqual(255)
    expect(() => buildSendPayload({ ...minimal, subject: accented })).toThrow(/bytes/i)

    // And a plain 255-character subject still goes through.
    expect(() => buildSendPayload({ ...minimal, subject: 'x'.repeat(255) })).not.toThrow()
  })

  it('names the field when template data is not key/value', () => {
    // Dropping it would send the email with every variable rendered blank and
    // report success, which is worse than failing the run.
    expect(() => buildSendPayload({ ...minimal, data: '{"order":1}' })).toThrow(/Template Data/)
    expect(() => buildSendPayload({ ...minimal, metadata: ['a'] })).toThrow(/Metadata/)
  })

  it('puts an address on the message once, however many columns supplied it', () => {
    const payload = buildSendPayload({
      ...minimal,
      cc: ['manager@acme.com', 'manager@acme.com', ' manager@acme.com '],
    })

    expect(payload.notification.email_options?.cc).toEqual(['manager@acme.com'])
  })

  it('names the field when a custom slot cannot be read', () => {
    expect(() => buildSendPayload({ ...minimal, custom_number_1: 'not a number' })).toThrow(
      /custom_number_1/,
    )
  })

  it('reports the address the way Notifuse stores it', async () => {
    // Notifuse lowercases an address before storing it, so an output that echoed
    // what was typed would disagree with every trigger's view of the same contact.
    captureSend()

    const result = await appTester(performSend, {
      authData,
      inputData: { ...minimal, email: 'Bob.Sample@Example.COM' },
    })

    expect(result.email).toBe('bob.sample@example.com')
  })

  it('repeats the API\'s own reason when a 200 reports a failure', async () => {
    // afterResponse only inspects the status, so a failure reported inside a 200
    // reaches here intact. Falling through to the missing-id message would blame
    // a proxy for something the API just explained.
    nock(CLOUD_API_URL)
      .post('/api/transactional.send')
      .reply(200, { success: false, error: 'notification is not active' })

    await expect(appTester(performSend, { authData, inputData: minimal })).rejects.toThrow(
      /not active/,
    )
  })

  it('refuses to call a send successful when no message came back', async () => {
    // The id is generated before the message is handed to a provider, so a 200
    // without one cannot have come from this endpoint — it is a proxy or an SPA
    // fallback answering, and that must not look like a delivered email.
    nock(CLOUD_API_URL).post('/api/transactional.send').reply(200, { success: true })

    await expect(appTester(performSend, { authData, inputData: minimal })).rejects.toThrow(
      /message/i,
    )
  })

  it('keeps its sample within the keys a run actually produces', async () => {
    captureSend()

    const result = await appTester(performSend, { authData, inputData: minimal })

    const live = Object.keys(result)
    for (const key of Object.keys(sendTransactionalEmail.operation.sample ?? {})) {
      expect(live).toContain(key)
    }
  })
})
