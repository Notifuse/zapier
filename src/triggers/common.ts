import { type Bundle, type ZObject, defineInputFields } from 'zapier-platform-core'

import { listField } from '../dropdowns/list.js'
import { segmentField } from '../dropdowns/segment.js'
import { workspaceField } from '../dropdowns/workspace.js'
import { type ApiRecord, type WebhookEnvelope, isRecord, text } from '../shapes/common.js'
import { contact, listMembership, segmentMembership } from '../shapes/index.js'
import type { Contact, ListMembership, SegmentMembership } from '../shapes/index.js'

/**
 * What the six REST Hook triggers share: the fields they ask the Zap author for,
 * the reading of an inbound delivery, and the read endpoints their `performList`
 * pulls editor samples from.
 *
 * `performList` is the part worth being careful about. Zapier calls it *instead
 * of* subscribing, so nothing about a subscription is available to it — no
 * `bundle.subscribeData`, no `bundle.targetUrl`, and no guarantee that this
 * workspace has ever received a delivery. It is editor-only, never fires a Zap,
 * and must have no side effects.
 */

/**
 * The pickers are shared with the actions rather than restated here: a second
 * definition of `list_id` would be free to drift from the first, and the field a
 * Zap author fills in has to name the same dropdown either way.
 */
export const workspaceFields = defineInputFields([workspaceField])
export const listFields = defineInputFields([workspaceField, listField])
export const segmentFields = defineInputFields([workspaceField, segmentField])

/**
 * Reads one of the Zap's input fields, refusing to run on an empty one.
 *
 * Every field these triggers declare is required, so an empty one means the Zap
 * was saved from a form that never loaded. Continuing would query the whole
 * workspace, or subscribe to every list in it.
 */
export const requireInput = (bundle: Bundle, key: string, label: string): string => {
  const value = text(bundle.inputData?.[key])
  if (value === null || value === '') {
    throw new Error(
      `This step needs a ${label}. Open the Zap, choose one, and test the trigger again.`,
    )
  }
  return value
}

/**
 * Reads the inbound delivery as the envelope the shape modules expect.
 *
 * This is the one place outside `src/shapes/` allowed to touch
 * `bundle.cleanedRequest`, and it deliberately reads only the envelope — never a
 * field inside `data`. What each event type carries in there is the shape
 * modules' business, and they report a payload they cannot read far better than a
 * guess here would.
 */
export const envelopeFrom = (bundle: Bundle): WebhookEnvelope => {
  const body: unknown = bundle.cleanedRequest
  if (!isRecord(body)) {
    throw new Error(
      'This trigger received a webhook body it could not read as JSON. Nothing but Notifuse should be posting to this URL.',
    )
  }

  return {
    id: text(body.id) ?? '',
    type: text(body.type) ?? '',
    workspace_id: text(body.workspace_id) ?? '',
    timestamp: text(body.timestamp) ?? '',
    data: isRecord(body.data) ? body.data : {},
  }
}

/** How many sample records to pull when the editor does not ask for a number. */
const DEFAULT_SAMPLE_SIZE = 10

/** The largest page `contacts.list` accepts; a bigger one is rejected outright. */
const MAX_PAGE_SIZE = 100

const limitFrom = (bundle: Bundle): number => {
  // -1 means "no limit", which no Notifuse endpoint offers; the editor only ever
  // displays a handful of samples anyway.
  const requested = bundle.meta?.limit
  if (typeof requested === 'number' && requested > 0) {
    return Math.min(requested, MAX_PAGE_SIZE)
  }
  return DEFAULT_SAMPLE_SIZE
}

/**
 * Reads the array a Notifuse listing nests under one key.
 *
 * A response that is not shaped like a listing yields no records rather than an
 * error: `performList` feeds the Zap editor, where "we could not find any data"
 * is a better answer than a stack trace, and a genuine failure has already been
 * turned into an error by the response middleware.
 */
const recordsFrom = (data: unknown, key: string): ApiRecord[] => {
  const listing: unknown = isRecord(data) ? data[key] : undefined
  if (!Array.isArray(listing)) {
    return []
  }
  return listing.filter(isRecord)
}

/** Recent contacts, newest first — the sample source for both contact triggers. */
export const listRecentContacts = async (z: ZObject, bundle: Bundle): Promise<Contact[]> => {
  const response = await z.request({
    url: '/api/contacts.list',
    method: 'GET',
    params: {
      workspace_id: requireInput(bundle, 'workspace_id', 'Workspace'),
      limit: limitFrom(bundle),
    },
  })

  return recordsFrom(response.data, 'contacts').map((record) => contact.fromApi(record))
}

/**
 * Members of one list in one membership status.
 *
 * Asking for the status the trigger is about — `active` for a subscription,
 * `unsubscribed` for an unsubscription — is what makes the editor's samples
 * resemble the records the hook will actually deliver. `with_contact_lists`
 * returns every membership each contact holds, so the shape picks out the one
 * this trigger watches.
 */
export const listMembersOfList = async (
  z: ZObject,
  bundle: Bundle,
  status: string,
): Promise<ListMembership[]> => {
  const listId = requireInput(bundle, 'list_id', 'List')

  const response = await z.request({
    url: '/api/contacts.list',
    method: 'GET',
    params: {
      workspace_id: requireInput(bundle, 'workspace_id', 'Workspace'),
      list_id: listId,
      contact_list_status: status,
      with_contact_lists: 'true',
      limit: limitFrom(bundle),
    },
  })

  return recordsFrom(response.data, 'contacts').map((record) =>
    listMembership.fromApi(record, listId),
  )
}

/**
 * The segment's name, or null if it cannot be read.
 *
 * The listing answers "who is in this segment" and never repeats the segment
 * itself, so the name has to be fetched. It is decoration on this path — the hook
 * payload carries its own — so a failure here costs the editor a label rather
 * than its sample records. A segment that genuinely does not exist has already
 * failed the listing call with a message that says so.
 */
const segmentNameOf = async (
  z: ZObject,
  workspaceId: string,
  segmentId: string,
): Promise<string | null> => {
  const response = await z.request({
    url: '/api/segments.get',
    method: 'GET',
    params: { workspace_id: workspaceId, id: segmentId },
    skipThrowForStatus: true,
  })

  if (response.status >= 400) {
    return null
  }

  const segment: unknown = isRecord(response.data) ? response.data.segment : undefined
  return isRecord(segment) ? text(segment.name) : null
}

/**
 * Contacts currently in one segment, most recently joined first.
 *
 * Both segment triggers sample from this, including the one that fires on
 * departures: nothing records who has left a segment, and a member of it produces
 * a record with the same keys and a real address to map against, which is all the
 * editor needs.
 */
export const listSegmentMembers = async (
  z: ZObject,
  bundle: Bundle,
): Promise<SegmentMembership[]> => {
  const workspaceId = requireInput(bundle, 'workspace_id', 'Workspace')
  const segmentId = requireInput(bundle, 'segment_id', 'Segment')

  const response = await z.request({
    url: '/api/segments.contacts',
    method: 'GET',
    params: {
      workspace_id: workspaceId,
      segment_id: segmentId,
      // Without this the endpoint answers with bare email addresses, which carry
      // no join time to order by and would force one contact lookup per address.
      expand: 'contact',
      limit: limitFrom(bundle),
    },
  })

  const name = await segmentNameOf(z, workspaceId, segmentId)

  return recordsFrom(response.data, 'contacts').map((member) =>
    segmentMembership.fromApi(member, { id: segmentId, name }),
  )
}

/**
 * Presents a canonical record as a trigger's static sample.
 *
 * The copy is what makes the sample's key set come from the shape module rather
 * than from a second list typed out by hand — which would be free to drift from
 * the first, silently, in the direction that breaks mappings.
 */
export const asSample = (record: object): Record<string, unknown> => ({ ...record })

const CUSTOM_SLOT = /^custom_(string|number|datetime|json)_[1-5]$/

/**
 * Drops the twenty custom-field slots from a sample record.
 *
 * They are returned for every user, but they mean something different in every
 * workspace: a sample advertising `custom_string_1: "gold"` teaches a mapping
 * that is wrong for almost everyone who sees it. Removing keys keeps the sample a
 * subset of what the trigger really returns, which is the direction that matters
 * — a key in the sample that the live payload lacks is what breaks mappings.
 */
export const withoutCustomSlots = (record: Contact): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !CUSTOM_SLOT.test(key)))
