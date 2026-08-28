import nock from 'nock'
import { createAppTester } from 'zapier-platform-core'
import { afterEach, describe, expect, it } from 'vitest'

import App from '../../src/index.js'
import { CLOUD_API_URL } from '../../src/authentication.js'
import { hookOperation } from './support.js'

const appTester = createAppTester(App)

const authData = { apiKey: 'jwt-token' }
const TARGET_URL = 'https://hooks.zapier.com/hooks/standard/1234/abcdef/'

const subscribeBundle = (inputData: Record<string, string>) => ({
  authData,
  inputData,
  targetUrl: TARGET_URL,
})

/** One subscription as `webhookSubscriptions.list` returns it. */
const storedSubscription = (overrides: Record<string, unknown> = {}) => ({
  id: 'sub_existing',
  name: 'Zapier — New Contact',
  url: TARGET_URL,
  secret: 'whsec_do_not_store_me',
  enabled: true,
  source: 'zapier',
  event_types: ['contact.created'],
  consecutive_failures: 0,
  created_at: '2024-01-15T09:30:00Z',
  updated_at: '2024-01-15T09:30:00Z',
  ...overrides,
})

afterEach(() => {
  nock.cleanAll()
})

describe('performSubscribe', () => {
  it('creates a subscription attributed to Zapier, pointed at the target URL', async () => {
    let body: Record<string, unknown> = {}
    const scope = nock(CLOUD_API_URL)
      .get('/api/webhookSubscriptions.list')
      .query({ workspace_id: 'acme' })
      .reply(200, { subscriptions: [] })
      .post('/api/webhookSubscriptions.create', (posted: Record<string, unknown>) => {
        body = posted
        return true
      })
      .reply(201, { subscription: { id: 'sub_new', url: TARGET_URL, secret: 'whsec_secret' } })

    const result = await appTester(
      hookOperation('new_contact').performSubscribe,
      subscribeBundle({ workspace_id: 'acme' }),
    )

    expect(scope.isDone()).toBe(true)
    expect(body).toMatchObject({
      workspace_id: 'acme',
      name: 'Zapier — New Contact',
      url: TARGET_URL,
      event_types: ['contact.created'],
      source: 'zapier',
    })
    expect(result).toEqual({ id: 'sub_new' })
  })

  it('keeps the signing secret out of what Zapier stores', async () => {
    // Whatever performSubscribe returns is persisted as bundle.subscribeData, and
    // the secret is unreachable at delivery time anyway — a hook payload cannot be
    // verified from inside a trigger — so storing it would be a secret held for no
    // purpose.
    nock(CLOUD_API_URL)
      .get('/api/webhookSubscriptions.list')
      .query(true)
      .reply(200, { subscriptions: [] })
      .post('/api/webhookSubscriptions.create')
      .reply(201, { subscription: { id: 'sub_new', secret: 'whsec_secret', url: TARGET_URL } })

    const result = await appTester(
      hookOperation('new_contact').performSubscribe,
      subscribeBundle({ workspace_id: 'acme' }),
    )

    expect(JSON.stringify(result)).not.toContain('whsec_secret')
  })

  // The name is what a user scanning Settings → Webhooks reads to tell one Zap's row from
  // another's, and it is the phrase the console's delete dialog, the docs and this app's
  // own error messages all use ("the subscription named after this trigger"). Nothing else
  // pinned the format, so it could drift away from all three without a test noticing.
  it("names the subscription after the trigger, so the console can say which Zap owns it", async () => {
    let body: Record<string, unknown> = {}
    nock(CLOUD_API_URL)
      .get('/api/webhookSubscriptions.list')
      .query(true)
      .reply(200, { subscriptions: [] })
      .post('/api/webhookSubscriptions.create', (posted: Record<string, unknown>) => {
        body = posted
        return true
      })
      .reply(201, { subscription: { id: 'sub_new', url: TARGET_URL } })

    await appTester(
      hookOperation('new_contact').performSubscribe,
      subscribeBundle({ workspace_id: 'acme' }),
    )

    expect(body.name).toBe('Zapier — New Contact')
  })

  it('narrows the fan-out to the chosen list', async () => {
    // Notifuse matches deliveries on event type alone, so without this every Zap
    // watching one list would receive a delivery row and an outbound request for
    // every other list in the workspace.
    let body: Record<string, unknown> = {}
    nock(CLOUD_API_URL)
      .get('/api/webhookSubscriptions.list')
      .query(true)
      .reply(200, { subscriptions: [] })
      .post('/api/webhookSubscriptions.create', (posted: Record<string, unknown>) => {
        body = posted
        return true
      })
      .reply(201, { subscription: { id: 'sub_new' } })

    await appTester(
      hookOperation('new_list_subscriber').performSubscribe,
      subscribeBundle({ workspace_id: 'acme', list_id: 'zapsamplelist' }),
    )

    expect(body.list_ids).toEqual(['zapsamplelist'])
    expect(body.event_types).toEqual(['list.subscribed', 'list.confirmed', 'list.resubscribed'])
  })

  it('narrows the fan-out to the chosen segment', async () => {
    let body: Record<string, unknown> = {}
    nock(CLOUD_API_URL)
      .get('/api/webhookSubscriptions.list')
      .query(true)
      .reply(200, { subscriptions: [] })
      .post('/api/webhookSubscriptions.create', (posted: Record<string, unknown>) => {
        body = posted
        return true
      })
      .reply(201, { subscription: { id: 'sub_new' } })

    await appTester(
      hookOperation('segment_joined').performSubscribe,
      subscribeBundle({ workspace_id: 'acme', segment_id: 'zapsampleseg' }),
    )

    expect(body.segment_ids).toEqual(['zapsampleseg'])
    expect(body.event_types).toEqual(['segment.joined'])
  })

  it('reuses the subscription already pointed at this target URL', async () => {
    // performSubscribe has been observed firing more than once on a draft Zap.
    // Creating a second row would double every delivery while the Zap is live and
    // orphan the first one forever, since only the last id reaches subscribeData.
    const scope = nock(CLOUD_API_URL)
      .get('/api/webhookSubscriptions.list')
      .query(true)
      .reply(200, { subscriptions: [storedSubscription()] })

    const result = await appTester(
      hookOperation('new_contact').performSubscribe,
      subscribeBundle({ workspace_id: 'acme' }),
    )

    expect(result).toEqual({ id: 'sub_existing' })
    expect(scope.isDone()).toBe(true)
    // No create was intercepted, so nock would have thrown had one been attempted.
  })

  it('ignores a subscription the user created by hand at the same URL', async () => {
    nock(CLOUD_API_URL)
      .get('/api/webhookSubscriptions.list')
      .query(true)
      .reply(200, { subscriptions: [storedSubscription({ source: '', id: 'sub_user' })] })
      .post('/api/webhookSubscriptions.create')
      .reply(201, { subscription: { id: 'sub_new' } })

    const result = await appTester(
      hookOperation('new_contact').performSubscribe,
      subscribeBundle({ workspace_id: 'acme' }),
    )

    expect(result).toEqual({ id: 'sub_new' })
  })

  it('replaces a subscription whose filters no longer match the Zap', async () => {
    // Same target URL, different list: the row is a leftover from an edit whose
    // unsubscribe did not land. Leaving it would keep delivering the wrong list.
    let deleted: Record<string, unknown> = {}
    nock(CLOUD_API_URL)
      .get('/api/webhookSubscriptions.list')
      .query(true)
      .reply(200, {
        subscriptions: [
          storedSubscription({
            id: 'sub_stale',
            event_types: ['list.subscribed', 'list.confirmed', 'list.resubscribed'],
            list_ids: ['otherlist'],
          }),
        ],
      })
      .post('/api/webhookSubscriptions.delete', (posted: Record<string, unknown>) => {
        deleted = posted
        return true
      })
      .reply(200, { success: true })
      .post('/api/webhookSubscriptions.create')
      .reply(201, { subscription: { id: 'sub_new' } })

    const result = await appTester(
      hookOperation('new_list_subscriber').performSubscribe,
      subscribeBundle({ workspace_id: 'acme', list_id: 'zapsamplelist' }),
    )

    expect(deleted).toEqual({ workspace_id: 'acme', id: 'sub_stale' })
    expect(result).toEqual({ id: 'sub_new' })
  })

  it('replaces a subscription that has been auto-disabled', async () => {
    // Reusing a disabled row would leave the Zap switched on and permanently
    // silent, which is the failure mode this whole helper exists to avoid.
    nock(CLOUD_API_URL)
      .get('/api/webhookSubscriptions.list')
      .query(true)
      .reply(200, {
        subscriptions: [
          storedSubscription({
            id: 'sub_disabled',
            enabled: false,
            disabled_reason: 'too many consecutive delivery failures',
          }),
        ],
      })
      .post('/api/webhookSubscriptions.delete')
      .reply(200, { success: true })
      .post('/api/webhookSubscriptions.create')
      .reply(201, { subscription: { id: 'sub_new' } })

    const result = await appTester(
      hookOperation('new_contact').performSubscribe,
      subscribeBundle({ workspace_id: 'acme' }),
    )

    expect(result).toEqual({ id: 'sub_new' })
  })

  it('still subscribes when the key cannot read existing subscriptions', async () => {
    // Losing the duplicate check is a smaller failure than a Zap that cannot be
    // turned on at all, so a denial on the lookup falls through to the create.
    nock(CLOUD_API_URL)
      .get('/api/webhookSubscriptions.list')
      .query(true)
      .reply(403, { error: 'Insufficient permissions: read access to webhook subscriptions required' })
      .post('/api/webhookSubscriptions.create')
      .reply(201, { subscription: { id: 'sub_new' } })

    const result = await appTester(
      hookOperation('new_contact').performSubscribe,
      subscribeBundle({ workspace_id: 'acme' }),
    )

    expect(result).toEqual({ id: 'sub_new' })
  })

  it('says which permission is missing when the key cannot subscribe', async () => {
    nock(CLOUD_API_URL)
      .get('/api/webhookSubscriptions.list')
      .query(true)
      .reply(200, { subscriptions: [] })
      .post('/api/webhookSubscriptions.create')
      .reply(403, { error: 'Insufficient permissions: write access to webhook subscriptions required' })

    await expect(
      appTester(
        hookOperation('new_contact').performSubscribe,
        subscribeBundle({ workspace_id: 'acme' }),
      ),
    ).rejects.toThrow(/write access to webhook subscriptions/)
  })

  it('refuses to subscribe without a workspace', async () => {
    await expect(
      appTester(hookOperation('new_contact').performSubscribe, {
        authData,
        inputData: {},
        targetUrl: TARGET_URL,
      }),
    ).rejects.toThrow(/Workspace/)
  })
})

describe('performUnsubscribe', () => {
  it('deletes the subscription it created', async () => {
    // Never `.update`: that endpoint is a full replace, so an omitted field blanks
    // the name and the URL rather than leaving them alone.
    let body: Record<string, unknown> = {}
    const scope = nock(CLOUD_API_URL)
      .post('/api/webhookSubscriptions.delete', (posted: Record<string, unknown>) => {
        body = posted
        return true
      })
      .reply(200, { success: true })

    await appTester(hookOperation('new_contact').performUnsubscribe, {
      authData,
      inputData: { workspace_id: 'acme' },
      subscribeData: { id: 'sub_new' },
    })

    expect(scope.isDone()).toBe(true)
    expect(body).toEqual({ workspace_id: 'acme', id: 'sub_new' })
  })

  // The subscription really can vanish under a live Zap: a user can delete it by hand in
  // Settings → Webhooks behind a "Delete anyway" dialog, and Notifuse deletes a
  // Zapier-created subscription outright when its endpoint answers 410 Gone. Zapier also
  // retries a delete whose response was lost, so the second call finds nothing there
  // either. If any of those threw, turning the Zap off would be the one action that
  // cannot succeed — including the recovery the console's own dialog prescribes.
  it.each([
    ['404 from a current Notifuse', 404, { error: 'Webhook subscription not found' }],
    ['410 from anything that reports it that way', 410, { error: 'gone' }],
    [
      '500 from a Notifuse older than the release that answers 404',
      500,
      { error: 'Failed to delete webhook subscription: webhook subscription not found' },
    ],
  ])('treats a subscription that is already gone as removed: %s', async (_name, status, body) => {
    const scope = nock(CLOUD_API_URL)
      .post('/api/webhookSubscriptions.delete')
      .reply(status, body)

    const result = await appTester(hookOperation('new_contact').performUnsubscribe, {
      authData,
      inputData: { workspace_id: 'acme' },
      subscribeData: { id: 'sub_new' },
    })

    expect(scope.isDone()).toBe(true)
    expect(result).toEqual({ id: 'sub_new' })
  })

  // A delete that silently did not happen leaves a subscription delivering to a Zap that
  // is switched off, so anything that is not "already gone" still has to fail loudly.
  it('still fails when the delete was refused for another reason', async () => {
    nock(CLOUD_API_URL)
      .post('/api/webhookSubscriptions.delete')
      .reply(403, { error: 'Insufficient permissions: write access to webhooks required' })

    await expect(
      appTester(hookOperation('new_contact').performUnsubscribe, {
        authData,
        inputData: { workspace_id: 'acme' },
        subscribeData: { id: 'sub_new' },
      }),
    ).rejects.toThrow()
  })

  it('says where to look when the Zap no longer names a workspace', async () => {
    // Nothing can be deleted without one, and a silent no-op would leave a
    // subscription posting at a switched-off Zap until the failure reaper caught it.
    await expect(
      appTester(hookOperation('new_contact').performUnsubscribe, {
        authData,
        inputData: {},
        subscribeData: { id: 'sub_new' },
      }),
    ).rejects.toThrow(/Settings/)
  })

  it('does nothing when no subscription was ever stored', async () => {
    // A subscribe that failed leaves nothing to delete, and throwing here would
    // only stop the user turning the Zap off.
    const result = await appTester(hookOperation('new_contact').performUnsubscribe, {
      authData,
      inputData: { workspace_id: 'acme' },
    })

    expect(result).toEqual({ id: '' })
  })
})

// Which triggers are registered, that each is a REST hook carrying all three hook
// operations, and that none declares outputFields, are audited in test/app.test.ts
// — over the trigger modules themselves rather than over a second list of keys
// written out here, which would be free to fall behind the first.
