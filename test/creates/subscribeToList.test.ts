import type { InputFields, PlainInputField } from 'zapier-platform-core'
import nock from 'nock'
import { createAppTester } from 'zapier-platform-core'
import { afterEach, describe, expect, it } from 'vitest'

import { CLOUD_API_URL } from '../../src/constants.js'
import subscribeToList, {
  buildSubscriptionResult,
  performSubscribe,
  readListIds,
} from '../../src/creates/subscribeToList.js'
import App from '../../src/index.js'

const appTester = createAppTester(App)
const authData = { apiKey: 'jwt-token' }

/**
 * A lists.subscribe response. `success` is the key an older client reads and the
 * memberships were added beside it, one per requested list.
 */
const membership = (listID: string, status: string) => ({
  email: 'bob.sample@example.com',
  list_id: listID,
  list_name: listID === 'newsletter' ? 'Monthly Newsletter' : 'Product Updates',
  status,
  created_at: '2026-08-01T09:30:00Z',
  updated_at: '2026-08-25T14:12:00.123456Z',
  deleted_at: null,
})

/** Captures the JSON body the action posts, and answers with the given memberships. */
const captureSubscribe = (contactLists: unknown[]): { body: Record<string, unknown> } => {
  const captured: { body: Record<string, unknown> } = { body: {} }

  nock(CLOUD_API_URL)
    .post('/api/lists.subscribe', (body: Record<string, unknown>) => {
      captured.body = body
      return true
    })
    .reply(200, { success: true, contact_lists: contactLists })

  return captured
}

const plainFields = (fields: InputFields | undefined): PlainInputField[] =>
  (fields ?? []).filter((field): field is PlainInputField => typeof field !== 'function')

afterEach(() => {
  nock.cleanAll()
})

describe('subscribe contact to list', () => {
  it('is registered under its own key, and is one a user can choose', () => {
    expect(App.creates[subscribeToList.key]).toBe(subscribeToList)
    expect(subscribeToList.display.hidden).not.toBe(true)
  })

  it('states the four outcomes a user cannot predict from the form', () => {
    const description = subscribeToList.display.description ?? ''

    // A new contact lands active even on a double opt-in list, because the API
    // call is authenticated.
    expect(description).toMatch(/active/)
    expect(description).toMatch(/double opt.?in/i)
    // Someone who unsubscribed before is forced back through confirmation.
    expect(description).toMatch(/pending/)
    expect(description).toMatch(/unsubscribed/i)
    // Bounced, complained and disposable addresses are skipped in silence.
    expect(description).toMatch(/bounced/i)
    expect(description).toMatch(/complained/i)
    expect(description).toMatch(/disposable/i)
    // An already-active membership is an idempotent no-op.
    expect(description).toMatch(/already active/i)

    expect(description.length).toBeLessThanOrEqual(1000)
  })

  it('asks for a workspace, at least one list, and an address', () => {
    const fields = plainFields(subscribeToList.operation.inputFields)

    expect(fields.filter((field) => field.required === true).map((field) => field.key)).toEqual([
      'workspace_id',
      'list_ids',
      'email',
    ])
    expect(fields.find((field) => field.key === 'list_ids')?.list).toBe(true)
  })

  it('upserts the contact and subscribes it in the one call the API offers', async () => {
    const captured = captureSubscribe([membership('newsletter', 'active')])

    const result = await appTester(performSubscribe, {
      authData,
      inputData: {
        workspace_id: 'acme',
        list_ids: ['newsletter'],
        email: 'bob.sample@example.com',
        first_name: 'Bob',
      },
    })

    expect(captured.body).toEqual({
      workspace_id: 'acme',
      list_ids: ['newsletter'],
      contact: { email: 'bob.sample@example.com', first_name: 'Bob' },
    })

    expect(result).toEqual({
      id: 'subscribe:bob.sample@example.com:newsletter',
      email: 'bob.sample@example.com',
      list_ids: ['newsletter'],
      list_id: 'newsletter',
      list_name: 'Monthly Newsletter',
      status: 'active',
      memberships: [
        {
          list_id: 'newsletter',
          list_name: 'Monthly Newsletter',
          status: 'active',
          created_at: '2026-08-01T09:30:00.000Z',
          updated_at: '2026-08-25T14:12:00.123Z',
        },
      ],
    })
  })

  it('reports the status each list ended up in, not the one that was asked for', async () => {
    // A contact who unsubscribed before is forced back to pending whatever the
    // list's setting; a new one lands active on the same call. The request cannot
    // tell them apart, which is why the response has to.
    captureSubscribe([membership('newsletter', 'pending'), membership('product', 'active')])

    const result = await appTester(performSubscribe, {
      authData,
      inputData: {
        workspace_id: 'acme',
        list_ids: ['newsletter', 'product'],
        email: 'bob.sample@example.com',
      },
    })

    expect(result.memberships.map((entry) => entry.status)).toEqual(['pending', 'active'])
    expect(result.status).toBe('pending')
  })

  it('reports a bounced membership as the refusal it is', async () => {
    // The call succeeds and nothing happens. Without the status, that is
    // indistinguishable from a contact who is now reachable.
    captureSubscribe([membership('newsletter', 'bounced')])

    const result = await appTester(performSubscribe, {
      authData,
      inputData: {
        workspace_id: 'acme',
        list_ids: ['newsletter'],
        email: 'bob.sample@example.com',
      },
    })

    expect(result.status).toBe('bounced')
  })

  it('keeps its shape when the address was dropped without a word', async () => {
    // A disposable-domain address is skipped silently: success, and no membership
    // at all. The empty list is the only thing that says so.
    captureSubscribe([])

    const result = await appTester(performSubscribe, {
      authData,
      inputData: {
        workspace_id: 'acme',
        list_ids: ['newsletter'],
        email: 'bob.sample@mailinator.com',
      },
    })

    expect(result.memberships).toEqual([])
    expect(result.status).toBeNull()
    expect(result.list_id).toBeNull()
    expect(Object.keys(result).sort()).toEqual([
      'email',
      'id',
      'list_id',
      'list_ids',
      'list_name',
      'memberships',
      'status',
    ])
  })

  it('takes a single mapped list as readily as a chosen one', () => {
    expect(readListIds('newsletter')).toEqual(['newsletter'])
    expect(readListIds(['newsletter', 'product'])).toEqual(['newsletter', 'product'])
  })

  it('asks for a list once, however many times it was chosen', () => {
    // Notifuse loops over the ids it is given, so a duplicate would come back as
    // two memberships for one list.
    expect(readListIds(['newsletter', 'newsletter'])).toEqual(['newsletter'])
  })

  it('refuses to subscribe to nothing', () => {
    expect(() => readListIds([])).toThrow(/list/i)
    expect(() => readListIds('')).toThrow(/list/i)
  })

  it('ignores an entry the response could not identify', () => {
    const result = buildSubscriptionResult('bob.sample@example.com', ['newsletter'], {
      success: true,
      contact_lists: [{ status: 'active' }, membership('newsletter', 'active')],
    })

    expect(result.memberships.map((entry) => entry.list_id)).toEqual(['newsletter'])
  })

  it('keeps its shape when the response carries no memberships at all', () => {
    // An older instance answers `{"success": true}` and nothing else. It is the
    // wrong version to run a Zap against, but it must not throw inside the step.
    const result = buildSubscriptionResult('bob.sample@example.com', ['newsletter'], {
      success: true,
    })

    expect(result.memberships).toEqual([])
    expect(result.list_ids).toEqual(['newsletter'])
  })

  it('keeps its sample within the keys a run actually produces', async () => {
    captureSubscribe([membership('newsletter', 'pending')])

    const result = await appTester(performSubscribe, {
      authData,
      inputData: {
        workspace_id: 'acme',
        list_ids: ['newsletter'],
        email: 'bob.sample@example.com',
      },
    })

    const live = Object.keys(result)
    const sample = subscribeToList.operation.sample ?? {}
    for (const key of Object.keys(sample)) {
      expect(live).toContain(key)
    }

    const liveMembershipKeys = Object.keys(result.memberships[0] ?? {})
    const sampleMemberships = sample.memberships
    const [sampleMembership] = Array.isArray(sampleMemberships) ? sampleMemberships : []
    for (const key of Object.keys((sampleMembership ?? {}) as Record<string, unknown>)) {
      expect(liveMembershipKeys).toContain(key)
    }
  })
})
