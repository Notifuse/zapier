import { type Bundle, type PlainInputField, type ZObject, defineCreate } from 'zapier-platform-core'

import {
  CUSTOM_FIELD_SLOTS,
  type CustomFieldSlot,
  customFieldInputFields,
} from '../dropdowns/customFields.js'
import { requireWorkspaceId, workspaceField } from '../dropdowns/workspace.js'
import { decimal, isRecord, requireText, text } from '../shapes/common.js'
import { type Contact, fromApi } from '../shapes/contact.js'

/**
 * The contact as it goes out on the wire.
 *
 * Deliberately a bag rather than a mirror of the canonical `Contact`: what a Zap
 * sends is only the fields the user filled in, and every absent key is a field
 * the API leaves exactly as it found it.
 */
export interface ContactPayload {
  email: string
  [key: string]: unknown
}

/** What `contacts.upsert` answers with. */
interface UpsertResponse {
  email?: unknown
  action?: unknown
  contact?: unknown
}

/**
 * The canonical contact, plus which write it turned out to be.
 *
 * The contact half is built by the same shape module the triggers use, so a Zap
 * mapping "First Name" from this action's output and from the New Contact trigger
 * is mapping the same key.
 */
export interface UpsertedContact extends Contact {
  /** `create` or `update` — an upsert cannot be asked which one it will be. */
  action: string | null
}

/** The plain text columns a contact carries, in the order the form shows them. */
const CONTACT_TEXT_FIELDS: { key: string; label: string; helpText?: string }[] = [
  {
    key: 'external_id',
    label: 'External ID',
    helpText: 'Your own identifier for this person — a CRM or billing system id.',
  },
  { key: 'first_name', label: 'First Name' },
  { key: 'last_name', label: 'Last Name' },
  { key: 'full_name', label: 'Full Name' },
  { key: 'phone', label: 'Phone' },
  {
    key: 'timezone',
    label: 'Timezone',
    helpText: 'An IANA timezone name, such as `Europe/Paris`. Used to schedule sends.',
  },
  {
    key: 'language',
    label: 'Language',
    helpText: 'A language code, such as `en` or `fr`.',
  },
  { key: 'job_title', label: 'Job Title' },
  { key: 'address_line_1', label: 'Address Line 1' },
  { key: 'address_line_2', label: 'Address Line 2' },
  { key: 'postcode', label: 'Postcode' },
  { key: 'state', label: 'State' },
  { key: 'country', label: 'Country' },
]

/**
 * The contact half of a form, shared by both actions that write a contact.
 *
 * `lists.subscribe` takes a whole contact as well as the lists, so the two
 * actions ask for the same thing and must ask for it identically — a field
 * spelled one way here and another way there would write two different contacts
 * from the same source record.
 */
export const contactInputFields: PlainInputField[] = [
  {
    key: 'email',
    label: 'Email',
    type: 'string',
    required: true,
    helpText: 'The address that identifies the contact. Everything else is matched to it.',
  },
  ...CONTACT_TEXT_FIELDS.map(
    (field): PlainInputField => ({
      key: field.key,
      label: field.label,
      type: 'string',
      required: false,
      ...(field.helpText === undefined ? {} : { helpText: field.helpText }),
    }),
  ),
]

/** Renders a value the API will accept as an instant, or says which field cannot. */
const asInstant = (raw: unknown, key: string): string => {
  const parsed = new Date(text(raw) ?? '')
  if (Number.isNaN(parsed.getTime())) {
    // The API rejects a malformed timestamp by refusing the whole request, so a
    // silent drop here would be the difference between "one field is empty" and
    // "the run failed" — and naming the field is the difference between a fixable
    // message and a stack trace.
    throw new Error(`${key} is not a date: ${JSON.stringify(raw)}`)
  }
  return parsed.toISOString()
}

/**
 * Reads one custom slot, coerced to what its column holds.
 *
 * `undefined` means "the user left it blank", which is not the same as "set it to
 * null": an upsert merges field by field, so an omitted key preserves whatever is
 * stored and an explicit null would erase it. A Zap whose source record happens
 * to have an empty cell must not wipe the contact.
 */
export const readSlotValue = (slot: CustomFieldSlot, raw: unknown): unknown => {
  if (raw === null || raw === undefined) {
    return undefined
  }
  if (typeof raw === 'string' && raw.trim() === '') {
    return undefined
  }

  switch (slot.kind) {
    case 'number': {
      const parsed = decimal(raw)
      if (parsed === null) {
        throw new Error(`${slot.key} is not a number: ${JSON.stringify(raw)}`)
      }
      return parsed
    }
    case 'datetime':
      return asInstant(raw, slot.key)
    case 'json': {
      const asText = text(raw)
      if (asText === null) {
        return raw
      }
      try {
        return JSON.parse(asText)
      } catch {
        // The column takes any JSON value, and a JSON string is one — so text that
        // does not parse is stored as text rather than failing a run over
        // punctuation. The field's help text says so.
        return asText
      }
    }
    default:
      return text(raw)
  }
}

/**
 * Builds the contact body from what the user filled in.
 *
 * Only filled fields travel. Zapier hands a blank field through as an empty
 * string, and sending that would blank the stored value — so a Zap fed by a
 * source with sparse records would erase a contact's details a field at a time.
 */
export const buildContactPayload = (inputData: Record<string, unknown>): ContactPayload => {
  const payload: ContactPayload = {
    email: requireText(inputData.email, 'An email address is required to identify the contact.'),
  }

  for (const field of CONTACT_TEXT_FIELDS) {
    const value = text(inputData[field.key])
    if (value !== null && value.trim() !== '') {
      payload[field.key] = value
    }
  }

  for (const slot of CUSTOM_FIELD_SLOTS) {
    const value = readSlotValue(slot, inputData[slot.key])
    if (value !== undefined) {
      payload[slot.key] = value
    }
  }

  return payload
}

/**
 * Writes the contact and reports the row that is now stored.
 *
 * Named rather than inline so a test can drive it directly: the platform types
 * an operation's `perform` as a union with a request object, which a test cannot
 * call without narrowing it back to a function.
 */
export const performUpsert = async (z: ZObject, bundle: Bundle): Promise<UpsertedContact> => {
  const workspaceId = requireWorkspaceId(bundle.inputData)
  const contact = buildContactPayload(bundle.inputData)

  const response = await z.request<UpsertResponse>({
    url: '/api/contacts.upsert',
    method: 'POST',
    body: { workspace_id: workspaceId, contact },
  })

  const data: UpsertResponse = isRecord(response.data) ? response.data : {}

  // The stored row is what a later step should map — the resolved external id,
  // the merged custom fields, the timestamps the database assigned. When the
  // read-back after the write did not come through, the address is still known
  // and the shape still emits every key, so the output keeps its schema instead
  // of the run failing over an upsert that already committed.
  const stored: Record<string, unknown> = isRecord(data.contact)
    ? data.contact
    : { email: contact.email }

  return { ...fromApi(stored), action: text(data.action) }
}

const upsertContact = defineCreate({
  key: 'upsert_contact',
  noun: 'Contact',
  display: {
    label: 'Create or Update Contact',
    description:
      'Creates a contact, or updates the existing one when the email address is already known. The email address is the identity: there is no separate create and update, and re-running the same step changes nothing the second time. Fields left blank are left as they are stored rather than emptied, so a step can fill in one detail without disturbing the rest. Custom fields appear on this form once they are labelled in the workspace settings. List memberships are not touched here — use *Subscribe Contact to List* for those.',
  },
  operation: {
    inputFields: [workspaceField, ...contactInputFields, customFieldInputFields],

    // A blank field means "leave this as it is stored", which is a decision this
    // action makes deliberately in `buildContactPayload`. Letting the platform
    // strip empties first would make the behaviour depend on a default that is
    // outside this file.
    cleanInputData: false,

    perform: performUpsert,

    sample: {
      id: 'contact:bob.sample@example.com',
      email: 'bob.sample@example.com',
      action: 'create',
      external_id: 'crm-4815',
      timezone: 'Europe/Paris',
      language: 'en',
      first_name: 'Bob',
      last_name: 'Sample',
      full_name: 'Bob Sample',
      phone: '+33123456789',
      address_line_1: '12 Rue de Rivoli',
      address_line_2: 'Floor 3',
      country: 'FR',
      postcode: '75004',
      state: 'Île-de-France',
      job_title: 'Operations Lead',
      created_at: '2026-08-01T09:30:00.000Z',
      updated_at: '2026-08-25T14:12:00.000Z',
    },
  },
})

export default upsertContact
