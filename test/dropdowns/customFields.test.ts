import nock from 'nock'
import { createAppTester } from 'zapier-platform-core'
import { afterEach, describe, expect, it } from 'vitest'

import { CLOUD_API_URL } from '../../src/constants.js'
import {
  CUSTOM_FIELD_SLOTS,
  customFieldInputFields,
  readCustomFieldLabels,
} from '../../src/dropdowns/customFields.js'
import App from '../../src/index.js'

const appTester = createAppTester(App)
const authData = { apiKey: 'jwt-token' }
const inputData = { workspace_id: 'acme' }

const workspaceWith = (labels: Record<string, string> | undefined) => [
  {
    id: 'acme',
    name: 'Acme Marketing',
    settings: { timezone: 'Europe/Paris', ...(labels === undefined ? {} : { custom_field_labels: labels }) },
  },
  { id: 'globex', name: 'Globex', settings: { custom_field_labels: { custom_string_1: 'Wrong workspace' } } },
]

afterEach(() => {
  nock.cleanAll()
})

describe('custom field input fields', () => {
  it('covers five slots of each of the four kinds', () => {
    expect(CUSTOM_FIELD_SLOTS).toHaveLength(20)

    const byKind = (kind: string) => CUSTOM_FIELD_SLOTS.filter((slot) => slot.kind === kind)
    expect(byKind('string').map((slot) => slot.key)).toEqual([
      'custom_string_1',
      'custom_string_2',
      'custom_string_3',
      'custom_string_4',
      'custom_string_5',
    ])
    expect(byKind('number')).toHaveLength(5)
    expect(byKind('datetime')).toHaveLength(5)
    expect(byKind('json')).toHaveLength(5)
  })

  it('renders only the labelled slots, under their labels', async () => {
    nock(CLOUD_API_URL)
      .get('/api/workspaces.list')
      .reply(200, workspaceWith({ custom_string_2: 'Plan', custom_number_1: 'Lifetime Value' }))

    const fields = await appTester(customFieldInputFields, { authData, inputData })

    expect(fields).toEqual([
      expect.objectContaining({ key: 'custom_string_2', label: 'Plan', type: 'string' }),
      expect.objectContaining({ key: 'custom_number_1', label: 'Lifetime Value', type: 'number' }),
    ])
  })

  it('types a datetime slot as a date and a JSON slot as free text', async () => {
    // The platform's `json` type rejects a bare string or number at the root, and
    // a Notifuse JSON slot holds whatever the workspace put in it.
    nock(CLOUD_API_URL)
      .get('/api/workspaces.list')
      .reply(200, workspaceWith({ custom_datetime_3: 'Renewal', custom_json_5: 'Preferences' }))

    const fields = await appTester(customFieldInputFields, { authData, inputData })

    expect(fields).toEqual([
      expect.objectContaining({ key: 'custom_datetime_3', type: 'datetime' }),
      expect.objectContaining({ key: 'custom_json_5', type: 'text', helpText: expect.stringMatching(/JSON/) }),
    ])
  })

  it('never marks a custom field required', async () => {
    // Every slot is nullable in the database, and a required field here would
    // block a Zap whose source record simply does not carry that value.
    nock(CLOUD_API_URL)
      .get('/api/workspaces.list')
      .reply(200, workspaceWith({ custom_string_1: 'Plan' }))

    const fields = await appTester(customFieldInputFields, { authData, inputData })

    expect(fields.every((field) => field.required !== true)).toBe(true)
  })

  it('reads the labels of the chosen workspace, not the first one', async () => {
    nock(CLOUD_API_URL)
      .get('/api/workspaces.list')
      .reply(200, workspaceWith({ custom_string_1: 'Right workspace' }))

    const labels = await appTester(
      (z) => readCustomFieldLabels(z, 'globex'),
      { authData, inputData },
    )

    expect(labels).toEqual({ custom_string_1: 'Wrong workspace' })
  })

  it('explains the empty section instead of leaving it blank', async () => {
    nock(CLOUD_API_URL).get('/api/workspaces.list').reply(200, workspaceWith(undefined))

    const fields = await appTester(customFieldInputFields, { authData, inputData })

    expect(fields).toEqual([
      expect.objectContaining({ type: 'copy', helpText: expect.stringMatching(/Settings/) }),
    ])
  })

  it('falls back to the column name when a label was blanked', async () => {
    // A label removed from the settings leaves the column holding data. Hiding the
    // field would drop it from the form while the value stayed in the database.
    nock(CLOUD_API_URL)
      .get('/api/workspaces.list')
      .reply(200, workspaceWith({ custom_string_4: '   ', custom_string_5: 'Plan' }))

    const fields = await appTester(customFieldInputFields, { authData, inputData })

    expect(fields.map((field) => field.key)).toEqual(['custom_string_4', 'custom_string_5'])
    expect(fields[0]?.label).toBe('custom_string_4')
  })

  it('ignores a slot name the schema does not have', async () => {
    nock(CLOUD_API_URL)
      .get('/api/workspaces.list')
      .reply(200, workspaceWith({ custom_string_9: 'Out of range', favourite_colour: 'Nope' }))

    const fields = await appTester(customFieldInputFields, { authData, inputData })

    expect(fields).toEqual([expect.objectContaining({ type: 'copy' })])
  })

  it('contributes nothing until a workspace is chosen, and never throws there', async () => {
    // This runs on every render of the form, so an error would stop the form from
    // appearing at all — including the workspace field whose absence caused it,
    // which the user would then have no way to fill in. No interceptor is
    // registered either: a request here would fail the test rather than reach the
    // network.
    await expect(appTester(customFieldInputFields, { authData, inputData: {} })).resolves.toEqual(
      [],
    )
  })

  it('reads workspaces.list rather than workspaces.get', async () => {
    // workspaces.get demands `workspace:read`, which the API key scope the
    // onboarding documentation recommends does not include — the custom-field
    // section would 403 for exactly the keys the integration tells people to make.
    const scope = nock(CLOUD_API_URL)
      .get('/api/workspaces.list')
      .reply(200, workspaceWith({ custom_string_1: 'Plan' }))

    await appTester(customFieldInputFields, { authData, inputData })

    expect(scope.isDone()).toBe(true)
  })
})

describe('the app the custom fields belong to', () => {
  it('offers both actions and no search', () => {
    // Every visible operation owes public review a live Zap and a successful run,
    // so a third one is a decision rather than an addition.
    expect(Object.keys(App.creates).sort()).toEqual(['subscribe_to_list', 'upsert_contact'])
    expect(App).not.toHaveProperty('searches')
  })
})
