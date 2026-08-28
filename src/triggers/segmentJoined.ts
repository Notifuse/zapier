import { defineTrigger } from 'zapier-platform-core'

import { performSubscribe, performUnsubscribe } from '../hooks/subscribe.js'
import { sampleEnvelope } from '../samples/index.js'
import { segmentMembership } from '../shapes/index.js'
import {
  asSample,
  envelopeFrom,
  listSegmentMembers,
  requireInput,
  segmentFields,
} from './common.js'

const LABEL = 'Contact Joined Segment'

export default defineTrigger({
  key: 'segment_joined',
  noun: 'Segment Member',

  display: {
    label: LABEL,
    description: 'Triggers when a contact starts matching the chosen segment.',
  },

  operation: {
    type: 'hook',
    inputFields: segmentFields,

    perform: (_z, bundle) => {
      const record = segmentMembership.fromWebhook(envelopeFrom(bundle))

      return record.segment_id === requireInput(bundle, 'segment_id', 'Segment') ? [record] : []
    },

    performList: listSegmentMembers,

    performSubscribe: (z, bundle) =>
      performSubscribe(z, bundle, {
        workspaceId: requireInput(bundle, 'workspace_id', 'Workspace'),
        label: LABEL,
        eventTypes: ['segment.joined'],
        segmentIds: [requireInput(bundle, 'segment_id', 'Segment')],
      }),

    performUnsubscribe,

    sample: asSample(segmentMembership.fromWebhook(sampleEnvelope('segment.joined'))),
  },
})
