import { defineTrigger } from 'zapier-platform-core'

import { performSubscribe, performUnsubscribe } from '../hooks/subscribe.js'
import { sampleEnvelope } from '../samples/index.js'
import { contact } from '../shapes/index.js'
import {
  envelopeFrom,
  listRecentContacts,
  requireInput,
  withoutCustomSlots,
  workspaceFields,
} from './common.js'

const LABEL = 'Updated Contact'

export default defineTrigger({
  key: 'updated_contact',
  noun: 'Contact',

  display: {
    label: LABEL,
    // The database compares an explicit list of columns before emitting anything,
    // so re-saving a contact with the same values fires nothing at all. Someone
    // testing the Zap that way would otherwise conclude it is broken.
    description:
      'Triggers when an existing contact changes. A save that leaves every stored field unchanged does not fire.',
  },

  operation: {
    type: 'hook',
    inputFields: workspaceFields,

    perform: (_z, bundle) => [contact.fromWebhook(envelopeFrom(bundle))],

    // No "recently updated" listing exists, and none is needed: performList only
    // has to hand the editor records of the right shape to map against.
    performList: listRecentContacts,

    performSubscribe: (z, bundle) =>
      performSubscribe(z, bundle, {
        workspaceId: requireInput(bundle, 'workspace_id', 'Workspace'),
        label: LABEL,
        eventTypes: ['contact.updated'],
      }),

    performUnsubscribe,

    sample: withoutCustomSlots(contact.fromWebhook(sampleEnvelope('contact.updated'))),
  },
})
