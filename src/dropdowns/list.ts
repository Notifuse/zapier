import { type Bundle, type PlainInputField, type ZObject, defineTrigger } from 'zapier-platform-core'

import { isRecord } from '../shapes/common.js'

import { type DropdownChoice, requireWorkspaceId, toChoice } from './workspace.js'

/** Lists the workspace's lists, newest-agnostic — `lists.list` is unpaginated. */
export const listLists = async (z: ZObject, bundle: Bundle): Promise<DropdownChoice[]> => {
  const workspaceId = requireWorkspaceId(bundle.inputData)

  const response = await z.request<unknown>({
    url: '/api/lists.list',
    method: 'GET',
    params: { workspace_id: workspaceId },
  })

  // The endpoint wraps its array in an object, unlike workspaces.list. Reading it
  // defensively rather than asserting the shape keeps a future envelope change
  // from throwing inside a dropdown, where the error surfaces as an unexplained
  // empty form.
  const payload: unknown = response.data
  const records = isRecord(payload) && Array.isArray(payload.lists) ? payload.lists : []
  return records.map(toChoice).filter((choice): choice is DropdownChoice => choice !== null)
}

/** The list picker, as a hidden trigger. */
export const listDropdown = defineTrigger({
  key: 'listOptions',
  noun: 'List',
  display: {
    label: 'List',
    description: 'Lists the mailing lists in the chosen workspace.',
    hidden: true,
  },
  operation: {
    type: 'polling',
    perform: listLists,
  },
})

/** A single list, for an operation that watches or writes exactly one. */
export const listField = {
  key: 'list_id',
  label: 'List',
  type: 'string',
  required: true,
  dynamic: 'listOptions.id.name',
  helpText: 'Which mailing list to use.',
} satisfies PlainInputField

/**
 * One or more lists, for the subscribe action.
 *
 * `lists.subscribe` takes an array and reports one membership per entry, so
 * accepting several here costs nothing and saves a Zap three near-identical
 * steps. The resulting status is decided per list, which is why the action
 * returns them individually rather than a single verdict.
 */
export const listIdsField = {
  key: 'list_ids',
  label: 'Lists',
  type: 'string',
  required: true,
  list: true,
  dynamic: 'listOptions.id.name',
  helpText: 'The lists to subscribe the contact to. Each one reports its own resulting status.',
} satisfies PlainInputField

export default listDropdown
