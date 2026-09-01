import { type Bundle, type PlainInputField, type ZObject, defineCreate } from 'zapier-platform-core'

import { customFieldInputFields } from '../dropdowns/customFields.js'
import { notificationField } from '../dropdowns/transactionalNotification.js'
import { requireWorkspaceId, workspaceField } from '../dropdowns/workspace.js'
import { isRecord, requireText, text } from '../shapes/common.js'

import { type ContactPayload, buildContactPayload, contactInputFields } from './upsertContact.js'

/** What the API accepts under `email_options`. */
interface EmailOptions {
  subject?: string
  subject_preview?: string
  from_name?: string
  reply_to?: string
  cc?: string[]
  bcc?: string[]
}

/** The body `transactional.send` takes. */
interface SendPayload {
  workspace_id: string
  notification: {
    id: string
    contact: ContactPayload
    /** Always `['email']` — see `CHANNELS`. */
    channels: string[]
    external_id?: string
    data?: Record<string, unknown>
    metadata?: Record<string, unknown>
    email_options?: EmailOptions
  }
}

/** What the action reports. */
export interface SentMessage {
  id: string
  message_id: string
  notification_id: string
  email: string
  /** The idempotency key this send was made under, or null when none was given. */
  message_external_id: string | null
}

/**
 * The channels a send asks for.
 *
 * Hard-coded rather than offered as a field. `email` is the only channel Notifuse
 * defines, and the endpoint refuses an empty array outright — even though the
 * service behind it would otherwise fall back to every channel the notification
 * configures. When a second channel exists, a picker can be added without
 * disturbing a stored Zap, because the value it would default to is this one.
 */
const CHANNELS = ['email']

/** The API's own cap on the two overridable subject lines. */
const SUBJECT_MAX = 255

/**
 * Reads a blank-tolerant address list.
 *
 * A `list: true` field normally arrives as an array, but a single mapped value
 * can arrive as a bare string, and a mapping whose source cell was empty arrives
 * as `''` — which Notifuse rejects as an invalid address, failing the entire send
 * rather than sending without a CC. Dropping blanks here is what keeps a Zap fed
 * by sparse records working.
 */
const readAddresses = (raw: unknown): string[] => {
  const entries = Array.isArray(raw) ? raw : [raw]
  const addresses: string[] = []

  for (const entry of entries) {
    const address = text(entry)
    // Duplicates are dropped for the reason `readListIds` drops them: two mapped
    // columns holding one address — a "manager" and a "billing" field that happen
    // to agree — would otherwise put it on the message twice.
    if (address !== null && address.trim() !== '' && !addresses.includes(address.trim())) {
      addresses.push(address.trim())
    }
  }

  return addresses
}

/** Reads one override, or nothing when it was left blank. */
const readOverride = (raw: unknown, key: string): string | undefined => {
  const value = text(raw)
  if (value === null || value.trim() === '') {
    return undefined
  }

  if (key === 'subject' || key === 'subject_preview') {
    // Measured in UTF-8 bytes because that is what the API measures: its check is
    // Go's `len(string)`, which counts bytes rather than characters. A subject of
    // accented text or emoji is well under 255 by JavaScript's count and over it
    // by the server's, and the gap is a 400 that loses the whole send.
    const bytes = new TextEncoder().encode(value).length
    if (bytes > SUBJECT_MAX) {
      throw new Error(
        `${key} must be ${SUBJECT_MAX} bytes or fewer, and this one is ${bytes}. Accented characters and emoji each count for more than one.`,
      )
    }
  }

  return value
}

/**
 * Reads a key/value field, or nothing when the user added no rows.
 *
 * A value that is present but not key/value — a JSON string, a line-item array —
 * throws rather than being dropped. Dropping it would send the email with every
 * `{{ variable }}` rendered blank and report success, which is the silent failure
 * this codebase is built to avoid; `readOverride` and `readSlotValue` both name
 * the field in the same situation.
 */
const readDict = (raw: unknown, key: string): Record<string, unknown> | undefined => {
  if (raw === null || raw === undefined || raw === '') {
    return undefined
  }
  if (!isRecord(raw)) {
    throw new Error(
      `${key} must be a set of key/value rows, and this one is ${JSON.stringify(raw)}. Map each template variable to its own row rather than mapping a whole record.`,
    )
  }

  const entries = Object.entries(raw).filter(([name]) => name.trim() !== '')
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

/**
 * Builds the send body from what the user filled in.
 *
 * Exported so a test can assert the request without a round trip, and because
 * every rule that keeps a send from failing lives here rather than in `perform`.
 */
export const buildSendPayload = (inputData: Record<string, unknown>): SendPayload => {
  const workspaceId = requireWorkspaceId(inputData)
  const notificationId = requireText(
    inputData.notification_id,
    'Choose the transactional notification to send.',
  )

  // `buildContactPayload` reads its own fixed list of contact keys, so the
  // idempotency key sitting beside them in this flat form is invisible to it and
  // cannot be mistaken for the contact's own `external_id`.
  const contact = buildContactPayload(inputData)

  const options: EmailOptions = {}
  for (const key of ['subject', 'subject_preview', 'from_name', 'reply_to'] as const) {
    const value = readOverride(inputData[key], key)
    if (value !== undefined) {
      options[key] = value
    }
  }
  for (const key of ['cc', 'bcc'] as const) {
    const addresses = readAddresses(inputData[key])
    if (addresses.length > 0) {
      options[key] = addresses
    }
  }

  const externalId = text(inputData.message_external_id)
  const data = readDict(inputData.data, 'Template Data')
  const metadata = readDict(inputData.metadata, 'Metadata')

  return {
    workspace_id: workspaceId,
    notification: {
      id: notificationId,
      contact,
      channels: CHANNELS,
      ...(externalId === null || externalId.trim() === '' ? {} : { external_id: externalId.trim() }),
      ...(data === undefined ? {} : { data }),
      ...(metadata === undefined ? {} : { metadata }),
      ...(Object.keys(options).length === 0 ? {} : { email_options: options }),
    },
  }
}

/**
 * Sends the notification and reports the message it produced.
 *
 * Named rather than inline so a test can drive it directly: the platform types an
 * operation's `perform` as a union with a request object, which a test cannot
 * call without narrowing it back to a function.
 */
export const performSend = async (z: ZObject, bundle: Bundle): Promise<SentMessage> => {
  const payload = buildSendPayload(bundle.inputData)

  const response = await z.request<unknown>({
    url: '/api/transactional.send',
    method: 'POST',
    body: payload,
  })

  const body: Record<string, unknown> = isRecord(response.data) ? response.data : {}

  // A 200 that reports its own failure is read before anything else, so the API's
  // own words reach the user rather than being replaced by a guess about what went
  // wrong further down.
  if (body.success === false || (body.message_id === undefined && text(body.error) !== null)) {
    throw new Error(`Notifuse did not send the message: ${text(body.error) ?? 'no reason given'}.`)
  }

  // No fallback id here, unlike the contact actions. Notifuse generates the
  // message id before handing anything to a provider, so a 200 that reports no
  // failure and still carries no id did not come from this endpoint — it is a
  // proxy or a single-page-app fallback answering, and inventing an id would
  // report an email nobody sent.
  const messageId = requireText(
    body.message_id,
    'Notifuse answered without a message id, so the send cannot be confirmed. Check that the API URL points at your Notifuse instance and not at a proxy in front of it.',
  )

  return {
    id: messageId,
    message_id: messageId,
    notification_id: payload.notification.id,
    email: payload.notification.contact.email.toLowerCase(),
    message_external_id: payload.notification.external_id ?? null,
  }
}

/** The template variables, and the identifiers that travel beside them. */
const dataInputFields: PlainInputField[] = [
  {
    key: 'data',
    label: 'Template Data',
    type: 'string',
    dict: true,
    required: false,
    helpText:
      'The variables your template renders with — a key per `{{ variable }}` it uses. Values arrive as text, so a template comparing one as a number (`{% if total > 100 %}`) will not match. The names `contact` and `notification_center_url` are set by Notifuse and cannot be overridden here.',
  },
  {
    key: 'metadata',
    label: 'Metadata',
    type: 'string',
    dict: true,
    required: false,
    helpText:
      'Stored on the message rather than rendered. Useful for tying a Notifuse message back to whatever in your systems caused it.',
  },
  {
    key: 'message_external_id',
    label: 'Message External ID',
    type: 'string',
    required: false,
    helpText:
      'Your own identifier for this message. Sending again with a value already used returns the original message instead of sending a second email, which is what protects a password reset when Zapier retries a step. Leave it blank to send every time. This names the *message* — the person\'s own identifier is the External ID field above.',
  },
]

/** The parts of the email a send may override for this message only. */
const emailOptionInputFields: PlainInputField[] = [
  {
    key: 'subject',
    label: 'Subject',
    type: 'string',
    required: false,
    helpText: `Overrides the template's subject for this message. Liquid variables work here too. ${SUBJECT_MAX} characters at most.`,
  },
  {
    key: 'subject_preview',
    label: 'Preview Text',
    type: 'string',
    required: false,
    helpText: `Overrides the template's preheader — the line an inbox shows after the subject. ${SUBJECT_MAX} characters at most.`,
  },
  {
    key: 'from_name',
    label: 'From Name',
    type: 'string',
    required: false,
    helpText: 'Overrides the sender name. The address itself comes from your email provider.',
  },
  {
    key: 'reply_to',
    label: 'Reply-To',
    type: 'string',
    required: false,
    helpText: 'Where replies should go, if not the sending address.',
  },
  {
    key: 'cc',
    label: 'CC',
    type: 'string',
    list: true,
    required: false,
    helpText:
      'Copied on the message. Needs Contacts read permission on the API key as well — the subject is rendered against the contact, so a copy reveals it. Blank entries are ignored.',
  },
  {
    key: 'bcc',
    label: 'BCC',
    type: 'string',
    list: true,
    required: false,
    helpText: 'Blind-copied on the message. Same permission note as CC. Blank entries are ignored.',
  },
]

const sendTransactionalEmail = defineCreate({
  key: 'send_transactional_email',
  noun: 'Email',
  display: {
    label: 'Send Transactional Email',
    description:
      'Sends one of your transactional notifications to a contact. The template, the sender and the tracking stay in Notifuse — this step chooses which notification to send, who receives it, and the data its template renders with. **It also writes the contact record:** the address is created if it is new, and every contact field you fill in overwrites what is stored, so leave a field blank rather than mapping a source that is sometimes empty. **Testing this step sends a real email**, as does every run, so point it at an address you own while you build the Zap. Fill in **Message External ID** with something stable, such as an order number, to make the send idempotent — Zapier retries a failed step, and without it a retry sends a second email. Re-sending with a value already used returns the original message, and the step cannot tell you which of the two happened.',
  },
  operation: {
    inputFields: [
      workspaceField,
      notificationField,
      ...contactInputFields,
      ...dataInputFields,
      ...emailOptionInputFields,
      customFieldInputFields,
    ],

    // The contact half of this form decides for itself what a blank field means —
    // see `buildContactPayload`. Cleaning it twice, once here and once there,
    // would make the behaviour depend on a platform default rather than on code.
    cleanInputData: false,

    perform: performSend,

    sample: {
      id: 'msg_01HZY8QK2N4P6R8T0V2X4Z6B8D',
      message_id: 'msg_01HZY8QK2N4P6R8T0V2X4Z6B8D',
      notification_id: 'order_confirmation',
      email: 'bob.sample@example.com',
      message_external_id: 'order-9912',
    },
  },
})

export default sendTransactionalEmail
