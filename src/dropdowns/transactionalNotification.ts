import { type Bundle, type PlainInputField, type ZObject, defineTrigger } from 'zapier-platform-core'

import { isRecord } from '../shapes/common.js'

import { type DropdownChoice, requireWorkspaceId, toChoice } from './workspace.js'

/**
 * How many notifications the picker asks for per page.
 *
 * `transactional.list` has no default limit and no cap of its own — `FromURLParams`
 * runs the value through `strconv.Atoi` and the repository interpolates it straight
 * into `LIMIT`, so omitting it returns every notification in the workspace, on every
 * render of the form. This is not `MAX_PAGE_SIZE` from `triggers/common.ts`: that
 * 100 is the ceiling `contacts.list` enforces, which this endpoint does not share.
 */
const PAGE_SIZE = 200

/**
 * Whether a notification is worth offering as something to send by email.
 *
 * `channels` is an object keyed by channel name, not an array. The send action
 * always asks for `email`, and Notifuse intersects that with the channels the
 * notification actually configures — so one without an email channel fails at run
 * time with `no valid channels to send notification`, and hiding it turns that
 * into an option the user never sees.
 *
 * It deliberately fails *open*. Only a `channels` we can actually read and that
 * provably lacks `email` is grounds for dropping a record; a missing or
 * unrecognisable one keeps it. The shape comes from another repository and no
 * compiler here sees it change — and the two failures are not comparable. Keeping
 * a notification that cannot be sent costs one bad option and a legible error at
 * run time. Dropping every notification empties a *required* field, and the
 * headline action becomes impossible to configure with nothing reported anywhere.
 */
const sendsEmail = (record: unknown): boolean => {
  if (!isRecord(record) || !isRecord(record.channels)) {
    return true
  }
  return 'email' in record.channels
}

/** Lists the workspace's transactional notifications that can be sent as email. */
export const listNotifications = async (
  z: ZObject,
  bundle: Bundle,
): Promise<DropdownChoice[]> => {
  const workspaceId = requireWorkspaceId(bundle.inputData)

  // Zapier re-performs a dropdown as the user scrolls it, counting from zero.
  // Without an offset every page answers with the first one, so a long list
  // repeats its opening entries instead of continuing.
  const page = typeof bundle.meta?.page === 'number' && bundle.meta.page > 0 ? bundle.meta.page : 0

  const response = await z.request<unknown>({
    url: '/api/transactional.list',
    method: 'GET',
    params: { workspace_id: workspaceId, limit: PAGE_SIZE, offset: page * PAGE_SIZE },
  })

  // The endpoint wraps its array in an object, and answers `null` rather than an
  // empty array when the workspace has none — its repository never initialises
  // the slice it marshals. Reading it defensively covers both without a special
  // case for either.
  const payload: unknown = response.data
  const records =
    isRecord(payload) && Array.isArray(payload.notifications) ? payload.notifications : []

  return records
    .filter(sendsEmail)
    .map(toChoice)
    .filter((choice): choice is DropdownChoice => choice !== null)
}

/** The notification picker, as a hidden trigger. */
export const notificationDropdown = defineTrigger({
  key: 'notificationOptions',
  noun: 'Notification',
  display: {
    label: 'Transactional Notification',
    description: 'Lists the transactional notifications in the chosen workspace.',
    hidden: true,
  },
  operation: {
    type: 'polling',
    perform: listNotifications,
  },
})

/** The notification an action sends. */
export const notificationField = {
  key: 'notification_id',
  label: 'Notification',
  type: 'string',
  required: true,
  dynamic: 'notificationOptions.id.name',
  helpText:
    'Which transactional notification to send. Its template decides what the email looks like; this step supplies who receives it and the data it renders with.',
} satisfies PlainInputField

export default notificationDropdown
