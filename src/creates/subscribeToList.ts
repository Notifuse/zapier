import { type Bundle, type ZObject, defineCreate } from 'zapier-platform-core'

import { customFieldInputFields } from '../dropdowns/customFields.js'
import { listIdsField } from '../dropdowns/list.js'
import { requireWorkspaceId, workspaceField } from '../dropdowns/workspace.js'
import { instant, isRecord, text } from '../shapes/common.js'

import { buildContactPayload, contactInputFields } from './upsertContact.js'

/** One membership as the subscribe call left it. */
export interface ListMembershipResult {
  list_id: string
  list_name: string | null
  /** `active`, `pending`, `unsubscribed`, `bounced` or `complained` — decided server-side. */
  status: string | null
  created_at: string | null
  updated_at: string | null
}

/**
 * What the action reports.
 *
 * The flattened `list_id`, `list_name` and `status` mirror the first membership.
 * They are redundant with `memberships` and they earn it: nearly every Zap
 * subscribes to one list and then filters on the outcome, and a filter step reads
 * a top-level field far more reliably than an entry inside a line-item array.
 */
export interface SubscriptionResult {
  id: string
  email: string
  /** The lists the step asked for, in the order it asked. */
  list_ids: string[]
  list_id: string | null
  list_name: string | null
  status: string | null
  /** One entry per list Notifuse acted on — empty when the address was skipped. */
  memberships: ListMembershipResult[]
}

/**
 * Reads the chosen lists.
 *
 * A multi-select normally arrives as an array, but a single mapped value can
 * arrive as a bare string, and a duplicate would make Notifuse report the same
 * list twice.
 */
export const readListIds = (raw: unknown): string[] => {
  const entries = Array.isArray(raw) ? raw : [raw]
  const listIds: string[] = []

  for (const entry of entries) {
    const listId = text(entry)
    if (listId !== null && listId.trim() !== '' && !listIds.includes(listId.trim())) {
      listIds.push(listId.trim())
    }
  }

  if (listIds.length === 0) {
    throw new Error('Choose at least one list to subscribe the contact to.')
  }
  return listIds
}

/** Projects one entry of the response's `contact_lists` onto the reported membership. */
const toMembership = (record: unknown): ListMembershipResult | null => {
  if (!isRecord(record)) {
    return null
  }

  const listId = text(record.list_id)
  if (listId === null || listId === '') {
    return null
  }

  return {
    list_id: listId,
    list_name: text(record.list_name),
    status: text(record.status),
    created_at: instant(record.created_at),
    updated_at: instant(record.updated_at),
  }
}

/**
 * Builds the action's output from the response.
 *
 * An empty `contact_lists` is a real answer rather than a failure: a
 * disposable-domain address is dropped silently and the call still succeeds. The
 * output keeps every key so the schema does not change with the outcome, and the
 * empty `memberships` is what tells a Zap author that nothing happened.
 */
export const buildSubscriptionResult = (
  email: string,
  listIds: string[],
  payload: unknown,
): SubscriptionResult => {
  const body = isRecord(payload) ? payload : {}
  const entries = Array.isArray(body.contact_lists) ? body.contact_lists : []

  const memberships = entries
    .map(toMembership)
    .filter((membership): membership is ListMembershipResult => membership !== null)

  const [first] = memberships

  return {
    id: `subscribe:${email}:${listIds.join(',')}`,
    email,
    list_ids: listIds,
    list_id: first?.list_id ?? null,
    list_name: first?.list_name ?? null,
    status: first?.status ?? null,
    memberships,
  }
}

/**
 * Upserts the contact and subscribes it, in the one call the API offers.
 *
 * Named rather than inline so a test can drive it directly: the platform types an
 * operation's `perform` as a union with a request object, which a test cannot
 * call without narrowing it back to a function.
 */
export const performSubscribe = async (
  z: ZObject,
  bundle: Bundle,
): Promise<SubscriptionResult> => {
  const workspaceId = requireWorkspaceId(bundle.inputData)
  const listIds = readListIds(bundle.inputData.list_ids)
  const contact = buildContactPayload(bundle.inputData)

  const response = await z.request<unknown>({
    url: '/api/lists.subscribe',
    method: 'POST',
    body: { workspace_id: workspaceId, contact, list_ids: listIds },
  })

  return buildSubscriptionResult(contact.email, listIds, response.data)
}

const subscribeToList = defineCreate({
  key: 'subscribe_to_list',
  noun: 'List Subscription',
  display: {
    label: 'Subscribe Contact to List',
    description:
      'Adds a contact to one or more lists, creating or updating the contact in the same call. The resulting status is decided by Notifuse and reported for each list, because the request cannot predict it. A contact who is new to the workspace lands **active** even on a double opt-in list — the API call is authenticated, so no confirmation email is sent — while a contact who previously unsubscribed is forced back to **pending** and has to confirm again. That asymmetry is a compliance rule this step cannot override. Two more cases succeed without subscribing anyone, and they do not look the same in the output: an address that has bounced or complained comes back reported with its terminal status, while a disposable-domain address comes back with no memberships at all and a blank status — so a Filter step keyed on **status** sees the first and not the second. A membership that is already active is left untouched, so re-running the step is safe.',
  },
  operation: {
    inputFields: [workspaceField, listIdsField, ...contactInputFields, customFieldInputFields],

    // The contact half of this form decides for itself what a blank field means —
    // see `buildContactPayload`. Cleaning it twice, once here and once there,
    // would make the behaviour depend on a platform default rather than on code.
    cleanInputData: false,

    perform: performSubscribe,

    sample: {
      id: 'subscribe:bob.sample@example.com:newsletter',
      email: 'bob.sample@example.com',
      list_ids: ['newsletter'],
      list_id: 'newsletter',
      list_name: 'Monthly Newsletter',
      status: 'pending',
      memberships: [
        {
          list_id: 'newsletter',
          list_name: 'Monthly Newsletter',
          status: 'pending',
          created_at: '2026-08-01T09:30:00.000Z',
          updated_at: '2026-08-25T14:12:00.000Z',
        },
      ],
    },
  },
})

export default subscribeToList
