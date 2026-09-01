import nock from 'nock'
import { createAppTester } from 'zapier-platform-core'
import { afterEach, describe, expect, it } from 'vitest'

import { CLOUD_API_URL } from '../../src/constants.js'
import {
  listNotifications,
  notificationDropdown,
  notificationField,
} from '../../src/dropdowns/transactionalNotification.js'
import App from '../../src/index.js'

const appTester = createAppTester(App)
const authData = { apiKey: 'jwt-token' }

const notifications = {
  notifications: [
    {
      id: 'order_confirmation',
      name: 'Order Confirmation',
      channels: { email: { template_id: 'tpl_order' } },
    },
    {
      id: 'password_reset',
      name: 'Password Reset',
      channels: { email: { template_id: 'tpl_reset' } },
    },
  ],
  total: 2,
}

afterEach(() => {
  nock.cleanAll()
})

describe('transactional notification dropdown', () => {
  it('is registered under the key the notification field points at', () => {
    const [key] = notificationField.dynamic.split('.')

    expect(key).toBe(notificationDropdown.key)
    expect(App.triggers[notificationDropdown.key]).toBe(notificationDropdown)
  })

  it('is hidden, so it never appears as a trigger a user can choose', () => {
    expect(notificationDropdown.display.hidden).toBe(true)
  })

  it('scopes the read to the chosen workspace', async () => {
    const scope = nock(CLOUD_API_URL)
      .get('/api/transactional.list')
      .query((query) => query.workspace_id === 'acme')
      .reply(200, notifications)

    const choices = await appTester(listNotifications, {
      authData,
      inputData: { workspace_id: 'acme' },
    })

    expect(choices).toEqual([
      { id: 'order_confirmation', name: 'Order Confirmation' },
      { id: 'password_reset', name: 'Password Reset' },
    ])
    expect(scope.isDone()).toBe(true)
  })

  it('asks for a bounded page', async () => {
    // transactional.list has no default limit and no cap: omitting it returns
    // every notification in the workspace, on every render of the form.
    const scope = nock(CLOUD_API_URL)
      .get('/api/transactional.list')
      .query((query) => Number(query.limit) > 0)
      .reply(200, notifications)

    await appTester(listNotifications, { authData, inputData: { workspace_id: 'acme' } })

    expect(scope.isDone()).toBe(true)
  })

  it('answers nothing when the workspace has no notifications', async () => {
    // The repository never initialises its slice, so an empty result marshals as
    // JSON null rather than []. Reading it as an array would throw.
    nock(CLOUD_API_URL)
      .get('/api/transactional.list')
      .query(true)
      .reply(200, { notifications: null, total: 0 })

    await expect(
      appTester(listNotifications, { authData, inputData: { workspace_id: 'acme' } }),
    ).resolves.toEqual([])
  })

  it('answers nothing rather than throwing when the envelope changes', async () => {
    nock(CLOUD_API_URL).get('/api/transactional.list').query(true).reply(200, { data: [] })

    await expect(
      appTester(listNotifications, { authData, inputData: { workspace_id: 'acme' } }),
    ).resolves.toEqual([])
  })

  it('keeps a notification whose channels it cannot read', async () => {
    // The shape comes from another repository and no compiler here sees it
    // change. Dropping records on an unrecognised `channels` would empty a
    // required field and make the action impossible to configure, reporting
    // nothing; keeping them costs one bad option and a legible error on send.
    nock(CLOUD_API_URL)
      .get('/api/transactional.list')
      .query(true)
      .reply(200, {
        notifications: [
          { id: 'absent', name: 'Channels Absent' },
          { id: 'listy', name: 'Channels As A List', channels: ['email'] },
          { id: 'stringy', name: 'Channels As Text', channels: 'email' },
        ],
        total: 3,
      })

    const choices = await appTester(listNotifications, {
      authData,
      inputData: { workspace_id: 'acme' },
    })

    expect(choices.map((choice) => choice.id)).toEqual(['absent', 'listy', 'stringy'])
  })

  it('walks past the first page when Zapier asks for more', async () => {
    const scope = nock(CLOUD_API_URL)
      .get('/api/transactional.list')
      .query((query) => Number(query.offset) === Number(query.limit))
      .reply(200, notifications)

    await appTester(listNotifications, {
      authData,
      inputData: { workspace_id: 'acme' },
      meta: { page: 1 },
    })

    expect(scope.isDone()).toBe(true)
  })

  it('hides a notification whose channels are readable and lack email', async () => {
    // The action always asks to send through email. A notification configured for
    // some other channel would answer `no valid channels to send notification` at
    // run time, so it is not offered as something to pick in the first place.
    nock(CLOUD_API_URL)
      .get('/api/transactional.list')
      .query(true)
      .reply(200, {
        notifications: [
          { id: 'emailable', name: 'Emailable', channels: { email: { template_id: 'tpl' } } },
          { id: 'other', name: 'Some Other Channel', channels: { sms: { template_id: 'tpl' } } },
          { id: 'none', name: 'No Channels At All', channels: {} },
        ],
        total: 3,
      })

    const choices = await appTester(listNotifications, {
      authData,
      inputData: { workspace_id: 'acme' },
    })

    expect(choices).toEqual([{ id: 'emailable', name: 'Emailable' }])
  })

  it('asks for a workspace before it asks the API for anything', async () => {
    // No interceptor is registered: a request here would fail the test rather
    // than reach the network.
    await expect(appTester(listNotifications, { authData, inputData: {} })).rejects.toThrow(
      /workspace/i,
    )
  })
})
