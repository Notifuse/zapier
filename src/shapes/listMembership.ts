import {
  type ApiRecord,
  type WebhookEnvelope,
  instant,
  isRecord,
  requireRecord,
  requireText,
  text,
} from './common.js'

/**
 * The canonical list membership a Zapier list trigger emits.
 *
 * The webhook sends `{email, list_id, list_name, status, previous_status}`; the
 * read endpoint behind `performList` is `contacts.list?list_id=…&with_contact_lists=true`,
 * which nests the memberships under the contact that owns them and does not
 * repeat the address inside each one.
 */
export interface ListMembership {
  /**
   * The delivery row id on the hook path, a derived key on the read path. For
   * legibility and support only — hook triggers are not deduplicated.
   */
  id: string
  /**
   * Which transition produced this record: `list.subscribed`, `list.confirmed`,
   * `list.resubscribed` or `list.unsubscribed`.
   *
   * "New List Subscriber" subscribes to the first three because `list.subscribed`
   * fires only on a first INSERT with status active — a returning contact emits
   * `confirmed` or `resubscribed` instead — so the distinction has to be readable
   * in the record rather than implied by three separate triggers.
   *
   * Null on the `performList` path: a poll reports the membership as it stands
   * and cannot know which transition it arrived through.
   */
  event_type: string | null
  email: string
  list_id: string
  list_name: string | null
  status: string | null
  /**
   * The status the membership came from.
   *
   * Null on the `performList` path — no read endpoint reproduces it. The key is
   * still emitted there, because a key present on one path and missing on the
   * other is precisely what blanks a user's field mapping.
   */
  previous_status: string | null
  /**
   * When the change happened, at the best resolution each path has: the delivery
   * timestamp on the hook path, the membership's own `updated_at` on the read
   * path.
   */
  occurred_at: string | null
}

/** Finds the membership a contact record carries for one list. */
const membershipFor = (record: ApiRecord, listId: string): ApiRecord | null => {
  const memberships = record.contact_lists
  if (!Array.isArray(memberships)) {
    return null
  }

  for (const entry of memberships) {
    if (isRecord(entry) && text(entry.list_id) === listId) {
      return entry
    }
  }
  return null
}

/** Builds the canonical membership from a `list.*` delivery. */
export const fromWebhook = (envelope: WebhookEnvelope): ListMembership => {
  const data = envelope.data

  return {
    id: envelope.id,
    event_type: text(envelope.type),
    email: requireText(data.email, 'a list.* payload must carry an email'),
    list_id: requireText(data.list_id, 'a list.* payload must carry a list_id'),
    list_name: text(data.list_name),
    status: text(data.status),
    previous_status: text(data.previous_status),
    occurred_at: instant(envelope.timestamp),
  }
}

/**
 * Builds the canonical membership from a `contacts.list` record and the list the
 * trigger is watching.
 *
 * A contact with no membership for that list still produces a record — the same
 * keys, with the membership's own fields null. It cannot happen through the
 * `list_id` filter, and swallowing it silently is how a schema mismatch would get
 * through.
 */
export const fromApi = (input: ApiRecord | null | undefined, listId: string): ListMembership => {
  const contact = requireRecord(input, 'no contact record to read; the API returned none')
  const email = requireText(contact.email, 'a contact record must carry an email')
  const membership = membershipFor(contact, listId)

  return {
    id: `list:${listId}:${email}`,
    event_type: null,
    email,
    list_id: listId,
    list_name: membership ? text(membership.list_name) : null,
    status: membership ? text(membership.status) : null,
    previous_status: null,
    occurred_at: membership ? instant(membership.updated_at ?? membership.created_at) : null,
  }
}
