import {
  type ApiRecord,
  type WebhookEnvelope,
  decimal,
  instant,
  json,
  requireRecord,
  requireText,
  text,
} from './common.js'

type SlotIndex = 1 | 2 | 3 | 4 | 5

/**
 * Custom fields are twenty fixed columns, not a free-form map, so the canonical
 * contact carries all twenty. A workspace labels the ones it uses; the rest come
 * back null on both paths, which keeps the key set the same for every user.
 */
type CustomStringSlots = { [K in `custom_string_${SlotIndex}`]: string | null }
type CustomNumberSlots = { [K in `custom_number_${SlotIndex}`]: number | null }
type CustomDatetimeSlots = { [K in `custom_datetime_${SlotIndex}`]: string | null }
type CustomJsonSlots = { [K in `custom_json_${SlotIndex}`]: unknown }

/**
 * The canonical contact a Zapier trigger emits, whichever path it arrived by.
 *
 * The field set is the one the backend's integration test holds the webhook
 * payload and `contacts.list` to (`tests/integration/webhook_api_parity_test.go`,
 * `canonicalContactFields`), plus the `id` every Zapier record carries. Adding a
 * field here without adding it there leaves the two free to drift again.
 */
export interface Contact
  extends CustomStringSlots,
    CustomNumberSlots,
    CustomDatetimeSlots,
    CustomJsonSlots {
  /**
   * The delivery row id on the hook path, a derived key on the read path.
   *
   * Emitted for legibility and support only. Hook triggers are not deduplicated
   * by Zapier — every POST fires the Zap — so this prevents nothing, and no
   * compound `id_updatedAt` key would either.
   */
  id: string
  email: string
  external_id: string | null
  timezone: string | null
  language: string | null
  first_name: string | null
  last_name: string | null
  full_name: string | null
  phone: string | null
  address_line_1: string | null
  address_line_2: string | null
  country: string | null
  postcode: string | null
  state: string | null
  job_title: string | null
  created_at: string | null
  updated_at: string | null
}

/**
 * Projects a contact record — a raw database row or a marshalled struct — onto
 * the canonical shape. Every field is read by the name both sources use: a field
 * this had to rename would be a field one of the two paths spells differently,
 * which is the drift the parity test exists to catch.
 */
const project = (record: ApiRecord, id: string, email: string): Contact => ({
  id,
  email,
  external_id: text(record.external_id),
  timezone: text(record.timezone),
  language: text(record.language),
  first_name: text(record.first_name),
  last_name: text(record.last_name),
  full_name: text(record.full_name),
  phone: text(record.phone),
  address_line_1: text(record.address_line_1),
  address_line_2: text(record.address_line_2),
  country: text(record.country),
  postcode: text(record.postcode),
  state: text(record.state),
  job_title: text(record.job_title),
  custom_string_1: text(record.custom_string_1),
  custom_string_2: text(record.custom_string_2),
  custom_string_3: text(record.custom_string_3),
  custom_string_4: text(record.custom_string_4),
  custom_string_5: text(record.custom_string_5),
  custom_number_1: decimal(record.custom_number_1),
  custom_number_2: decimal(record.custom_number_2),
  custom_number_3: decimal(record.custom_number_3),
  custom_number_4: decimal(record.custom_number_4),
  custom_number_5: decimal(record.custom_number_5),
  custom_datetime_1: instant(record.custom_datetime_1),
  custom_datetime_2: instant(record.custom_datetime_2),
  custom_datetime_3: instant(record.custom_datetime_3),
  custom_datetime_4: instant(record.custom_datetime_4),
  custom_datetime_5: instant(record.custom_datetime_5),
  custom_json_1: json(record.custom_json_1),
  custom_json_2: json(record.custom_json_2),
  custom_json_3: json(record.custom_json_3),
  custom_json_4: json(record.custom_json_4),
  custom_json_5: json(record.custom_json_5),
  created_at: instant(record.created_at),
  updated_at: instant(record.updated_at),
})

/** Builds the canonical contact from a `contact.created` / `contact.updated` delivery. */
export const fromWebhook = (envelope: WebhookEnvelope): Contact => {
  const record = requireRecord(
    envelope.data.contact,
    'a contact.* payload must nest the contact under `contact`',
  )

  const email = requireText(record.email, 'a contact.* payload must carry an email')
  return project(record, envelope.id, email)
}

/**
 * Builds the canonical contact from an API record — a `contacts.list` entry, the
 * contact nested in an expanded `segments.contacts` member, or the one
 * `contacts.upsert` reads back.
 *
 * The derived id is stable across polls because it is derived from the address,
 * which is the contact's primary key: a fresh value per poll would make every
 * sample record look new.
 */
export const fromApi = (input: ApiRecord | null | undefined): Contact => {
  const record = requireRecord(input, 'no contact record to read; the API returned none')
  const email = requireText(record.email, 'a contact record must carry an email')
  return project(record, `contact:${email}`, email)
}
