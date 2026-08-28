import type { Bundle, PlainInputField, ZObject } from 'zapier-platform-core'

import { isRecord, text } from '../shapes/common.js'

/** The four kinds of custom slot a contact carries, and how each is typed in a form. */
const SLOT_KINDS = [
  {
    kind: 'string',
    type: 'string',
    help: (slot: string) => `Text stored in ${slot}.`,
  },
  {
    kind: 'number',
    type: 'number',
    help: (slot: string) => `Number stored in ${slot}.`,
  },
  {
    kind: 'datetime',
    type: 'datetime',
    help: (slot: string) => `Date and time stored in ${slot}.`,
  },
  {
    kind: 'json',
    // Not the platform's `json` type: that one rejects a bare string or number at
    // the root, and a Notifuse JSON slot holds whatever the workspace put in it.
    // A value that does not parse is sent through as text rather than failing the
    // Zap — see `readSlotValue` in the create.
    type: 'text',
    help: (slot: string) =>
      `JSON stored in ${slot}. A value that is not valid JSON is stored as plain text.`,
  },
] as const

const SLOT_INDEXES = [1, 2, 3, 4, 5] as const

/** One custom slot: what the API calls it, and how a form should render it. */
export interface CustomFieldSlot {
  key: string
  /** What the column holds, which is what decides how a value is coerced for the API. */
  kind: 'string' | 'number' | 'datetime' | 'json'
  /** How the form renders it, which is not always the same thing — see the JSON slots. */
  type: 'string' | 'number' | 'datetime' | 'text'
  helpText: string
}

/**
 * Every custom slot a contact has, in the order a form should show them.
 *
 * Notifuse's custom fields are fixed columns, not a free-form map — five of each
 * kind, named by position. That is why this list is written out rather than
 * discovered: the set is a property of the schema, and a workspace that labels
 * none of them still has all of them.
 */
export const CUSTOM_FIELD_SLOTS: CustomFieldSlot[] = SLOT_KINDS.flatMap((slotKind) =>
  SLOT_INDEXES.map((index) => {
    const key = `custom_${slotKind.kind}_${index}`
    return { key, kind: slotKind.kind, type: slotKind.type, helpText: slotKind.help(key) }
  }),
)

/**
 * Reads the workspace's custom field labels.
 *
 * `workspaces.list` rather than `workspaces.get`, and the difference matters: the
 * latter demands `workspace:read`, which the API key scope the onboarding
 * documentation recommends does not include. A key scoped to contacts and lists
 * would render an empty custom-field section and no explanation.
 */
export const readCustomFieldLabels = async (
  z: ZObject,
  workspaceId: string,
): Promise<Record<string, string>> => {
  const response = await z.request<unknown[]>({
    url: '/api/workspaces.list',
    method: 'GET',
  })

  const workspaces = Array.isArray(response.data) ? response.data : []
  const workspace = workspaces.find(
    (record) => isRecord(record) && text(record.id) === workspaceId,
  )

  if (!isRecord(workspace) || !isRecord(workspace.settings)) {
    return {}
  }

  const labels = workspace.settings.custom_field_labels
  if (!isRecord(labels)) {
    return {}
  }

  // A slot whose label was blanked is kept, with an empty label. Dropping it would
  // hide a column that still holds data, so the form falls back to the raw column
  // name instead — visible and mappable, just not pretty.
  const named: Record<string, string> = {}
  for (const [slot, label] of Object.entries(labels)) {
    const read = text(label)
    named[slot] = read === null ? '' : read.trim()
  }
  return named
}

/**
 * Builds the custom-field half of a contact form from the workspace's labels.
 *
 * A contact has twenty custom slots and a workspace typically uses two or three.
 * Rendering all twenty under their column names would bury the fields that matter
 * in seventeen the user has never heard of, so only the labelled ones appear, and
 * they appear under the names the workspace gave them.
 *
 * When nothing is labelled the section is a single line of prose pointing at where
 * labels are set. An empty section would otherwise read as "this integration
 * cannot write custom fields", which is the wrong conclusion.
 *
 * Before a workspace is chosen this contributes nothing and asks the API nothing.
 * It must not throw there, unlike the dropdowns: this runs on every render of the
 * form, so an error would stop the form from appearing — including the workspace
 * field whose absence caused it, which the user would then have no way to fill in.
 */
export const customFieldInputFields = async (
  z: ZObject,
  bundle: Bundle,
): Promise<PlainInputField[]> => {
  const workspaceId = text(bundle.inputData?.workspace_id)
  if (workspaceId === null || workspaceId === '') {
    return []
  }

  const labels = await readCustomFieldLabels(z, workspaceId)

  const fields: PlainInputField[] = CUSTOM_FIELD_SLOTS.filter(
    (slot) => labels[slot.key] !== undefined,
  ).map((slot) => ({
    key: slot.key,
    // The raw column name stands in where a label was removed after being set:
    // the slot still holds data, and hiding it would silently drop it from the
    // form while leaving the value in the database.
    label: labels[slot.key] || slot.key,
    type: slot.type,
    required: false,
    helpText: slot.helpText,
  }))

  if (fields.length > 0) {
    return fields
  }

  return [
    {
      key: 'custom_fields_note',
      type: 'copy',
      helpText:
        'This workspace has no labelled custom fields. Label them in Notifuse under Settings → Contacts and they will appear here.',
    },
  ]
}

export default customFieldInputFields
