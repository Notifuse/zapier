import { type Bundle, type PlainInputField, type ZObject, defineTrigger } from 'zapier-platform-core'

import { isRecord } from '../shapes/common.js'

import { type DropdownChoice, requireWorkspaceId, toChoice } from './workspace.js'

/**
 * Lists the workspace's segments.
 *
 * `with_count` is deliberately not asked for. The contact count is the expensive
 * half of that endpoint and a dropdown renders on every pass over the form, while
 * the count would never be shown — the choice carries an id and a name.
 */
export const listSegments = async (z: ZObject, bundle: Bundle): Promise<DropdownChoice[]> => {
  const workspaceId = requireWorkspaceId(bundle.inputData)

  const response = await z.request<unknown>({
    url: '/api/segments.list',
    method: 'GET',
    params: { workspace_id: workspaceId },
  })

  const payload: unknown = response.data
  const records = isRecord(payload) && Array.isArray(payload.segments) ? payload.segments : []
  return records.map(toChoice).filter((choice): choice is DropdownChoice => choice !== null)
}

/** The segment picker, as a hidden trigger. */
export const segmentDropdown = defineTrigger({
  key: 'segmentOptions',
  noun: 'Segment',
  display: {
    label: 'Segment',
    description: 'Lists the segments in the chosen workspace.',
    hidden: true,
  },
  operation: {
    type: 'polling',
    perform: listSegments,
  },
})

/** A single segment, for an operation that watches exactly one. */
export const segmentField = {
  key: 'segment_id',
  label: 'Segment',
  type: 'string',
  required: true,
  dynamic: 'segmentOptions.id.name',
  helpText: 'Which segment to watch.',
} satisfies PlainInputField

export default segmentDropdown
