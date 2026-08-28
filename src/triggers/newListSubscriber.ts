import { defineTrigger } from 'zapier-platform-core'

import { performSubscribe, performUnsubscribe } from '../hooks/subscribe.js'
import { sampleEnvelope } from '../samples/index.js'
import { listMembership } from '../shapes/index.js'
import { asSample, envelopeFrom, listFields, listMembersOfList, requireInput } from './common.js'

const LABEL = 'New List Subscriber'

/**
 * `list.subscribed` fires only on a first INSERT with status active. A contact
 * who confirms a double opt-in emits `list.confirmed`, and one who comes back
 * after unsubscribing emits `list.resubscribed` — so a trigger bound to
 * `list.subscribed` alone silently misses every returning subscriber.
 *
 * Which one happened is exposed as the record's `event_type` rather than as three
 * separate triggers: they describe the same thing to a Zap, and three would mean
 * three live Zaps to maintain for public review and three ways to pick wrong.
 */
const SUBSCRIPTION_EVENTS = ['list.subscribed', 'list.confirmed', 'list.resubscribed'] as const

export default defineTrigger({
  key: 'new_list_subscriber',
  noun: 'List Subscriber',

  display: {
    label: LABEL,
    description:
      'Triggers when a contact subscribes to the chosen list, whether they are new, confirming a double opt-in, or returning after unsubscribing.',
  },

  operation: {
    type: 'hook',
    inputFields: listFields,

    perform: (_z, bundle) => {
      const record = listMembership.fromWebhook(envelopeFrom(bundle))

      // Notifuse already filters deliveries to the chosen list, but an instance
      // old enough to ignore that filter would fan every list out to every Zap.
      // An empty array runs no action step and consumes no task.
      return record.list_id === requireInput(bundle, 'list_id', 'List') ? [record] : []
    },

    performList: (z, bundle) => listMembersOfList(z, bundle, 'active'),

    performSubscribe: (z, bundle) =>
      performSubscribe(z, bundle, {
        workspaceId: requireInput(bundle, 'workspace_id', 'Workspace'),
        label: LABEL,
        eventTypes: SUBSCRIPTION_EVENTS,
        listIds: [requireInput(bundle, 'list_id', 'List')],
      }),

    performUnsubscribe,

    sample: asSample(listMembership.fromWebhook(sampleEnvelope('list.subscribed'))),
  },
})
