import { type PlainInputField, type ZObject, defineTrigger } from 'zapier-platform-core'

import { isRecord, text } from '../shapes/common.js'

/**
 * One entry of a dynamic dropdown: the value a Zap stores, and the label a human
 * reads while choosing it.
 *
 * Every dropdown in this directory answers with this and nothing else. Zapier
 * calls a dropdown's `perform` on every render of the form it belongs to, so what
 * it returns is paid for repeatedly and shown in a list — a whole API record
 * would be neither cheaper nor more readable.
 *
 * It lives here because every other dropdown is scoped to a workspace and
 * therefore already depends on this module.
 */
export interface DropdownChoice {
  id: string
  name: string
}

/**
 * Turns an API record into a choice, or drops it.
 *
 * A record without an id cannot be stored in a Zap, and one whose label is blank
 * renders as an empty row the user cannot tell apart from its neighbours — so
 * the id stands in as the label rather than showing nothing.
 */
export const toChoice = (record: unknown): DropdownChoice | null => {
  if (!isRecord(record)) {
    return null
  }

  const id = text(record.id)
  if (id === null || id === '') {
    return null
  }

  const name = text(record.name)
  return { id, name: name === null || name === '' ? id : name }
}

/**
 * Reads the workspace the operation is running against.
 *
 * `workspace_id` is a required input field on every operation, but a dropdown is
 * rendered while the form is still being filled in — so the moment before the
 * workspace is chosen is a normal state, not a failure, and the dropdowns that
 * depend on it say so rather than reporting an API error they never made.
 */
export const requireWorkspaceId = (inputData: Record<string, unknown> | undefined): string => {
  const workspaceId = text(inputData?.workspace_id)
  if (workspaceId === null || workspaceId === '') {
    throw new Error('Choose a workspace first — the rest of this form is scoped to it.')
  }
  return workspaceId
}

/** Lists the workspaces the connected API key can reach. */
export const listWorkspaces = async (z: ZObject): Promise<DropdownChoice[]> => {
  const response = await z.request<unknown[]>({
    url: '/api/workspaces.list',
    method: 'GET',
  })

  const records = Array.isArray(response.data) ? response.data : []
  return records.map(toChoice).filter((choice): choice is DropdownChoice => choice !== null)
}

/**
 * The workspace picker, as a hidden trigger.
 *
 * `workspaces.list` is the one endpoint no permission gates, which is what makes
 * it safe to hang every other field off: a key scoped to contacts and lists — the
 * scope the onboarding documentation recommends — still fills this dropdown.
 */
export const workspaceDropdown = defineTrigger({
  key: 'workspaceOptions',
  noun: 'Workspace',
  display: {
    label: 'Workspace',
    description: 'Lists the workspaces this API key can reach.',
    hidden: true,
  },
  operation: {
    type: 'polling',
    perform: listWorkspaces,
  },
})

/**
 * The workspace field every trigger and action carries.
 *
 * It is an input field rather than part of the connection because custom auth has
 * no computed fields: a workspace typed into the auth form would be unvalidated
 * and unfixable without reconnecting. An API key belongs to exactly one
 * workspace, so this dropdown resolves to a single entry and selects it — the
 * user sees a field they never have to think about, which is the point.
 *
 * `altersDynamicFields` is what makes the custom-field section rebuild when the
 * workspace changes: the labels those fields are named after are workspace
 * settings, so a stale form would offer the previous workspace's field names.
 */
export const workspaceField = {
  key: 'workspace_id',
  label: 'Workspace',
  type: 'string',
  required: true,
  dynamic: 'workspaceOptions.id.name',
  altersDynamicFields: true,
  helpText: 'The workspace this API key belongs to. One connection reaches one workspace.',
} satisfies PlainInputField

export default workspaceDropdown
