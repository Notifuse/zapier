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

const LABEL = 'New Contact'

export default defineTrigger({
  key: 'new_contact',
  noun: 'Contact',

  display: {
    label: LABEL,
    description: 'Triggers when a new contact is created.',
  },

  operation: {
    type: 'hook',
    inputFields: workspaceFields,

    // One delivery, one record, always in an array — a hook perform returning a
    // bare object is a structural failure rather than a mapping problem.
    perform: (_z, bundle) => [contact.fromWebhook(envelopeFrom(bundle))],

    performList: listRecentContacts,

    performSubscribe: (z, bundle) =>
      performSubscribe(z, bundle, {
        workspaceId: requireInput(bundle, 'workspace_id', 'Workspace'),
        label: LABEL,
        eventTypes: ['contact.created'],
      }),

    performUnsubscribe,

    // Built from a recorded delivery rather than written by hand, so its keys are
    // the keys a real payload has. Only the custom slots are removed.
    sample: withoutCustomSlots(contact.fromWebhook(sampleEnvelope('contact.created'))),
  },
})
