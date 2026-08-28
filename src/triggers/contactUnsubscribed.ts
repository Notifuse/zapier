import { defineTrigger } from 'zapier-platform-core'

import { performSubscribe, performUnsubscribe } from '../hooks/subscribe.js'
import { sampleEnvelope } from '../samples/index.js'
import { listMembership } from '../shapes/index.js'
import { asSample, envelopeFrom, listFields, listMembersOfList, requireInput } from './common.js'

const LABEL = 'Contact Unsubscribed From List'

export default defineTrigger({
  key: 'contact_unsubscribed',
  noun: 'List Unsubscribe',

  display: {
    label: LABEL,
    description: 'Triggers when a contact unsubscribes from the chosen list.',
  },

  operation: {
    type: 'hook',
    inputFields: listFields,

    perform: (_z, bundle) => {
      const record = listMembership.fromWebhook(envelopeFrom(bundle))

      return record.list_id === requireInput(bundle, 'list_id', 'List') ? [record] : []
    },

    performList: (z, bundle) => listMembersOfList(z, bundle, 'unsubscribed'),

    performSubscribe: (z, bundle) =>
      performSubscribe(z, bundle, {
        workspaceId: requireInput(bundle, 'workspace_id', 'Workspace'),
        label: LABEL,
        eventTypes: ['list.unsubscribed'],
        listIds: [requireInput(bundle, 'list_id', 'List')],
      }),

    performUnsubscribe,

    sample: asSample(listMembership.fromWebhook(sampleEnvelope('list.unsubscribed'))),
  },
})
