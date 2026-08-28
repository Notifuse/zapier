import type { Bundle, ZObject } from 'zapier-platform-core'

import { type ApiRecord, isRecord, text } from '../shapes/common.js'

/**
 * The shared REST Hook plumbing: one Notifuse webhook subscription per Zap
 * trigger, created when the Zap is turned on and deleted when it is turned off.
 *
 * Two properties of the platform shape everything here:
 *
 * - **`performSubscribe` can fire more than once for the same Zap.** It has been
 *   observed running while a Zap is merely being drafted, and only the last
 *   returned id reaches `bundle.subscribeData` — so a helper that blindly creates
 *   would double every delivery while the Zap is live and orphan the earlier row
 *   forever, since nothing left knows its id.
 * - **`bundle.subscribeData` exists only in `performUnsubscribe`.** Whatever this
 *   returns is stored by Zapier and handed back there, and nowhere else.
 */

/** What a trigger wants Notifuse to deliver to its target URL. */
export interface SubscriptionIntent {
  workspaceId: string
  /** The trigger's display label; it becomes the subscription name in the console. */
  label: string
  eventTypes: readonly string[]
  /** Narrows `list.*` deliveries to these lists. Empty means every list. */
  listIds?: readonly string[]
  /** Narrows `segment.*` deliveries to these segments. Empty means every segment. */
  segmentIds?: readonly string[]
}

/**
 * What `performSubscribe` hands back for Zapier to store.
 *
 * Deliberately not the whole subscription. A hook trigger cannot verify a signature
 * anyway — `bundle.subscribeData` is unreadable from `perform` — so storing the signing
 * secret would put a credential in Zapier's hands for no purpose it could ever serve.
 *
 * Note that not storing it is only half of keeping it out of Zapier: the platform's own
 * middleware logs every response body it receives, so anything `webhookSubscriptions.create`
 * answers with reaches Zapier's log store whatever this maps. That is why Notifuse
 * withholds the secret from a subscription carrying a `source` — see
 * WebhookSubscriptionService.Create — rather than relying on the app not to read it.
 *
 * The workspace is not stored either. It is a required input field, so
 * `performUnsubscribe` reads it from the same bundle the Zap was configured with.
 */
export interface StoredSubscription {
  id: string
}

/**
 * Names the subscription so the console can say which Zap owns it.
 *
 * The prefix is not decoration: the console's Zapier badge, the docs and the delete
 * dialog all describe a subscription "named after this trigger", and it is what a user
 * scanning Settings → Webhooks reads to tell one Zap's row from another's.
 */
export const subscriptionName = (label: string): string => `Zapier — ${label}`

/** Reads an array of ids off a stored subscription, absent or malformed alike. */
const idsFrom = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return []
  }
  return value.map(text).filter((id): id is string => id !== null && id !== '')
}

/** Compares two id lists as sets, since neither side promises an order. */
const sameIds = (left: readonly string[] | undefined, right: readonly string[]): boolean => {
  const a = [...(left ?? [])].sort()
  const b = [...right].sort()
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/**
 * Decides whether an existing subscription is the one this Zap wants.
 *
 * A disabled row fails the test on purpose. Sustained delivery failures switch a
 * subscription off, and reusing one in that state would leave the Zap turned on
 * and permanently silent — the exact failure this helper exists to prevent.
 */
const isReusable = (subscription: ApiRecord, intent: SubscriptionIntent): boolean =>
  subscription.enabled !== false &&
  sameIds(intent.eventTypes, idsFrom(subscription.event_types)) &&
  sameIds(intent.listIds, idsFrom(subscription.list_ids)) &&
  sameIds(intent.segmentIds, idsFrom(subscription.segment_ids))

/**
 * Finds the subscription already pointed at this Zap's target URL, if any.
 *
 * Only subscriptions Notifuse attributes to Zapier are candidates: a webhook the
 * user wrote by hand is theirs to manage, and adopting one would mean deleting it
 * when the Zap is turned off.
 *
 * A failure here is swallowed rather than raised. Reading subscriptions is a
 * separate grant from writing them, and a key that can subscribe but not list is
 * better served by a possible duplicate than by a Zap that cannot be turned on.
 */
const findExisting = async (
  z: ZObject,
  workspaceId: string,
  targetUrl: string,
): Promise<ApiRecord | null> => {
  const response = await z.request({
    url: '/api/webhookSubscriptions.list',
    method: 'GET',
    params: { workspace_id: workspaceId },
    skipThrowForStatus: true,
  })

  if (response.status >= 400) {
    return null
  }

  const subscriptions: unknown = isRecord(response.data) ? response.data.subscriptions : undefined
  if (!Array.isArray(subscriptions)) {
    return null
  }

  const match = subscriptions.find(
    (entry) => isRecord(entry) && text(entry.url) === targetUrl && text(entry.source) === 'zapier',
  )
  return isRecord(match) ? match : null
}

/**
 * Removes one subscription. Always `.delete` — `.update` is a full replace.
 *
 * A subscription that is already gone counts as removed. It really can vanish under a
 * live Zap: a user can delete it by hand in Settings → Webhooks behind a warning
 * dialog, and Notifuse itself deletes a Zapier-created subscription outright when its
 * endpoint answers 410 Gone. Zapier also retries a delete whose response was lost, so
 * the second call finds nothing there either. Treating any of those as a failure would
 * make turning the Zap off the one action that cannot succeed — including the recovery
 * the console's own dialog tells the user to perform.
 *
 * Any other failure still throws, because a delete that silently did not happen leaves
 * a subscription delivering to a Zap that is switched off.
 */
const deleteSubscription = async (
  z: ZObject,
  workspaceId: string,
  id: string,
): Promise<void> => {
  const response = await z.request({
    url: '/api/webhookSubscriptions.delete',
    method: 'POST',
    body: { workspace_id: workspaceId, id },
    skipThrowForStatus: true,
  })

  if (response.status < 400 || alreadyGone(response)) {
    return
  }

  throw new z.errors.Error(
    `Notifuse could not remove this Zap's webhook subscription (HTTP ${response.status}). Delete the subscription named after this trigger from Settings → Webhooks in Notifuse.`,
    'DeleteFailed',
    response.status,
  )
}

/**
 * Reads a delete failure as "the row was already gone".
 *
 * 404 and 410 are the statuses that say so. The message check covers a Notifuse older
 * than the release that started answering 404 here, where the same outcome arrived as a
 * 500 — the app has to work against whichever version the user is self-hosting.
 */
const alreadyGone = (response: { status: number; data?: unknown; content?: string }): boolean => {
  if (response.status === 404 || response.status === 410) {
    return true
  }

  const body = isRecord(response.data) ? text(response.data.error) : null
  const haystack = (body ?? response.content ?? '').toLowerCase()
  return haystack.includes('webhook subscription not found')
}

/**
 * Subscribes this Zap's target URL to the events its trigger cares about.
 *
 * Called again for a Zap that is already subscribed, it returns the existing
 * subscription instead of adding a second one. A row at the same URL whose
 * filters no longer match the Zap — a leftover from an edit whose unsubscribe did
 * not land — is replaced rather than left running, because it would keep
 * delivering events the Zap was reconfigured away from.
 */
export const performSubscribe = async (
  z: ZObject,
  bundle: Bundle,
  intent: SubscriptionIntent,
): Promise<StoredSubscription> => {
  const targetUrl = text(bundle.targetUrl)
  if (targetUrl === null || targetUrl === '') {
    throw new z.errors.Error(
      'This trigger was asked to subscribe without a target URL, so there is nowhere to deliver events. Turn the Zap off and on again.',
      'NoTargetUrl',
      400,
    )
  }

  const existing = await findExisting(z, intent.workspaceId, targetUrl)
  if (existing) {
    const existingId = text(existing.id)
    if (existingId !== null && existingId !== '') {
      if (isReusable(existing, intent)) {
        return { id: existingId }
      }
      await deleteSubscription(z, intent.workspaceId, existingId)
    }
  }

  const response = await z.request({
    url: '/api/webhookSubscriptions.create',
    method: 'POST',
    body: {
      workspace_id: intent.workspaceId,
      name: subscriptionName(intent.label),
      url: targetUrl,
      event_types: [...intent.eventTypes],
      // Absent rather than empty: the backend reads an absent filter as "every
      // list", and sending [] invites the opposite reading somewhere downstream.
      ...(intent.listIds && intent.listIds.length > 0 ? { list_ids: [...intent.listIds] } : {}),
      ...(intent.segmentIds && intent.segmentIds.length > 0
        ? { segment_ids: [...intent.segmentIds] }
        : {}),
      // Attribution is write-once: a row created without it can never be told
      // apart from one the user made by hand, which is what lets the console label
      // these and lets a dead endpoint be deleted rather than merely disabled.
      source: 'zapier',
    },
  })

  const created: unknown = isRecord(response.data) ? response.data.subscription : undefined
  const id = isRecord(created) ? text(created.id) : null
  if (id === null || id === '') {
    throw new z.errors.Error(
      'Notifuse accepted the subscription but did not return its id, so this Zap could not be unsubscribed later. Check the webhook list in Settings for a subscription named after this trigger.',
      'NoSubscriptionId',
      500,
    )
  }

  return { id }
}

/**
 * Deletes the subscription this Zap created.
 *
 * `webhookSubscriptions.delete`, never `.update`: update is a full replace rather
 * than a patch, so the fields it is not given come back blank — including the URL
 * the subscription exists to deliver to.
 */
export const performUnsubscribe = async (
  z: ZObject,
  bundle: Bundle,
): Promise<{ id: string }> => {
  const stored = bundle.subscribeData as Partial<StoredSubscription> | undefined
  const id = text(stored?.id)

  if (id === null || id === '') {
    // Nothing was ever stored, so there is nothing to delete — a subscribe that
    // failed, most likely. Failing here would only stop the user turning the Zap
    // off.
    return { id: '' }
  }

  const workspaceId = text(bundle.inputData?.workspace_id)
  if (workspaceId === null || workspaceId === '') {
    throw new z.errors.Error(
      'This Zap no longer names the workspace its subscription belongs to, so it cannot be removed automatically. Delete the subscription named after this trigger from Settings → Webhooks in Notifuse.',
      'NoWorkspace',
      400,
    )
  }

  await deleteSubscription(z, workspaceId, id)
  return { id }
}
