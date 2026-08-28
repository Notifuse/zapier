import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import nock from 'nock'
import { type Bundle, type ZObject, createAppTester } from 'zapier-platform-core'
import { afterEach, describe, expect, it } from 'vitest'

import { CLOUD_API_URL } from '../src/constants.js'
import subscribeToList from '../src/creates/subscribeToList.js'
import upsertContact from '../src/creates/upsertContact.js'
import { listDropdown } from '../src/dropdowns/list.js'
import { segmentDropdown } from '../src/dropdowns/segment.js'
import { workspaceDropdown } from '../src/dropdowns/workspace.js'
import App from '../src/index.js'
import { type NotifuseEventType, sampleEnvelope } from '../src/samples/index.js'
import { type WebhookEnvelope, isRecord } from '../src/shapes/common.js'
import contactUnsubscribed from '../src/triggers/contactUnsubscribed.js'
import newContact from '../src/triggers/newContact.js'
import newListSubscriber from '../src/triggers/newListSubscriber.js'
import segmentJoined from '../src/triggers/segmentJoined.js'
import segmentLeft from '../src/triggers/segmentLeft.js'
import updatedContact from '../src/triggers/updatedContact.js'

import { hookOperation } from './triggers/support.js'

/**
 * The app-level audit: the review rules that are properties of the whole
 * integration rather than of any one operation, checked here so they cannot be
 * satisfied one file at a time and then broken by the next file.
 *
 * Three of these reject a public integration outright — a REST hook without
 * subscribe and unsubscribe is a static webhook (D006, D016, D017), and an
 * operation without a static sample fails D012. The fourth fails silently
 * instead: a sample advertising a key the live payload lacks (T004) blanks every
 * mapping a user built from it, on every run, with nothing in Zap History to say
 * why.
 *
 * The registry assertions are here for a different reason. This app was written
 * by three authors into one `src/index.ts`, and an operation registered under a
 * key that is not its own is accepted by the schema and then unreachable: dynamic
 * dropdown references, stored subscriptions and the Zaps users have already built
 * all address an operation by key.
 */

const appTester = createAppTester(App)
const authData = { apiKey: 'jwt-token' }

afterEach(() => {
  nock.cleanAll()
})

type TriggerKey = keyof typeof App.triggers
type CreateKey = keyof typeof App.creates

/**
 * Narrows an operation's `perform` back to the function it is.
 *
 * The platform types it as a union with a request object — the shape an operation
 * that is nothing but an HTTP call would use — so nothing can call it without
 * saying which of the two it is.
 */
type Perform = (z: ZObject, bundle: Bundle) => unknown
const performOf = (operation: unknown): Perform =>
  (operation as { perform?: unknown }).perform as Perform

/** The pickers, which Zapier can only express as hidden triggers. */
const DROPDOWNS = [workspaceDropdown, listDropdown, segmentDropdown]

const CREATES = [upsertContact, subscribeToList]

/**
 * One visible trigger and a delivery of the kind it subscribes to.
 *
 * The event type is the load-bearing column: it names an entry of
 * `src/samples/payloads.json`, which a real database produced, so everything
 * below is checked against what Notifuse actually sends rather than against a
 * fixture written to agree with the code.
 */
interface HookCase {
  key: TriggerKey
  event: NotifuseEventType
  /** The id the two narrowed triggers filter deliveries by. */
  filter?: 'list_id' | 'segment_id'
}

const HOOKS: HookCase[] = [
  { key: newContact.key, event: 'contact.created' },
  { key: updatedContact.key, event: 'contact.updated' },
  { key: newListSubscriber.key, event: 'list.subscribed', filter: 'list_id' },
  { key: contactUnsubscribed.key, event: 'list.unsubscribed', filter: 'list_id' },
  { key: segmentJoined.key, event: 'segment.joined', filter: 'segment_id' },
  { key: segmentLeft.key, event: 'segment.left', filter: 'segment_id' },
]

/** The module each visible trigger key must resolve to. */
const TRIGGER_MODULES = [
  newContact,
  updatedContact,
  newListSubscriber,
  contactUnsubscribed,
  segmentJoined,
  segmentLeft,
]

/**
 * The Zap configuration such a delivery would arrive at, read out of the delivery
 * itself so the trigger's own filter passes.
 */
const inputFor = (hook: HookCase, envelope: WebhookEnvelope): Record<string, unknown> => ({
  workspace_id: envelope.workspace_id,
  ...(hook.filter === undefined ? {} : { [hook.filter]: envelope.data[hook.filter] }),
})

/**
 * The keys the raw delivery carries that a canonical record must not.
 *
 * The envelope's own fields and the `db_*` bookkeeping columns `to_jsonb()` copies
 * out of the row are the two families no read endpoint can reproduce, so one of
 * them reaching a trigger's output is a field that exists on the hook path and
 * nowhere else — the mismatch the shape layer exists to prevent.
 */
const rawOnlyKeys = (envelope: WebhookEnvelope): string[] => {
  const nested = isRecord(envelope.data.contact) ? Object.keys(envelope.data.contact) : []
  return [
    'type',
    'data',
    'workspace_id',
    'timestamp',
    'contact',
    ...nested.filter((key) => key.startsWith('db_')),
  ]
}

/**
 * Every path in `sample` that `live` does not have, at every level.
 *
 * The direction is the whole point: a key the live payload carries and the sample
 * omits costs a user nothing, while a key the sample advertises and the payload
 * lacks silently resolves their mapping to blank. Line items are compared entry
 * to entry, because a key inside `memberships[]` breaks a mapping exactly as
 * thoroughly as a top-level one.
 */
const missingFromLive = (sample: unknown, live: unknown, path = ''): string[] => {
  if (Array.isArray(sample)) {
    if (!Array.isArray(live)) {
      return [`${path}[] (the run did not answer with a list)`]
    }
    if (sample.length === 0) {
      return []
    }
    if (live.length === 0) {
      return [`${path}[] (the run produced no entry to compare)`]
    }
    return missingFromLive(sample[0], live[0], `${path}[]`)
  }

  if (!isRecord(sample)) {
    return []
  }
  if (!isRecord(live)) {
    return [path]
  }

  return Object.keys(sample).flatMap((key) => {
    const at = path === '' ? key : `${path}.${key}`
    return key in live ? missingFromLive(sample[key], live[key], at) : [at]
  })
}

describe('operation registry', () => {
  it('registers each trigger module once, under the key the module names', () => {
    for (const module of TRIGGER_MODULES) {
      expect(App.triggers[module.key as TriggerKey]).toBe(module)
    }

    for (const dropdown of DROPDOWNS) {
      expect(App.triggers[dropdown.key as TriggerKey]).toBe(dropdown)
    }
  })

  it('registers each action once, under the key the module names', () => {
    for (const create of CREATES) {
      expect(App.creates[create.key as CreateKey]).toBe(create)
    }
  })

  it('registers nothing else, so no half-merged copy of an operation survives', () => {
    const expected = [
      ...TRIGGER_MODULES.map((module) => module.key),
      ...DROPDOWNS.map((dropdown) => dropdown.key),
    ]

    expect(Object.keys(App.triggers).sort()).toEqual(expected.sort())
    expect(Object.keys(App.creates).sort()).toEqual(CREATES.map((create) => create.key).sort())
  })

  it('covers every registered trigger in the table the audits below iterate', () => {
    // The audits below iterate HOOKS. A trigger added to the app and not to that
    // table would be registered, shipped, and checked by nothing in this file.
    expect(HOOKS.map((hook) => hook.key).sort()).toEqual(
      TRIGGER_MODULES.map((module) => module.key).sort(),
    )
  })

  it('asks every operation for the workspace, which no API key can imply', () => {
    // An API key belongs to one workspace and nearly every endpoint demands the id
    // anyway, but custom auth has no computed fields — so it cannot be derived and
    // hidden. Every operation asks for it, through the same dropdown, or it asks
    // the user to type an opaque id by hand.
    const inputFields = [
      ...HOOKS.map((hook) => hookOperation(hook.key).inputFields ?? []),
      ...CREATES.map((create) => create.operation.inputFields ?? []),
    ]

    for (const fields of inputFields) {
      const workspace = fields.find(
        (field) => typeof field === 'object' && 'key' in field && field.key === 'workspace_id',
      )

      expect(workspace).toMatchObject({ required: true, dynamic: 'workspaceOptions.id.name' })
    }
  })

  it('shows the pickers to nobody and the triggers to everybody', () => {
    for (const dropdown of DROPDOWNS) {
      expect(dropdown.display.hidden).toBe(true)
    }

    for (const module of TRIGGER_MODULES) {
      expect(module.display.hidden).toBeFalsy()
    }
  })
})

describe('REST hook contract', () => {
  it('gives every visible trigger subscribe, unsubscribe and list, so none is a static webhook', () => {
    // A REST hook missing performSubscribe or performUnsubscribe *is* a static
    // webhook, which a public integration may not ship (D016, D017), and one
    // missing performList leaves the Zap editor no sample records to map against
    // (D006).
    for (const { key } of HOOKS) {
      const operation = hookOperation(key)

      expect(operation.type).toBe('hook')
      expect(typeof operation.perform).toBe('function')
      expect(typeof operation.performList).toBe('function')
      expect(typeof operation.performSubscribe).toBe('function')
      expect(typeof operation.performUnsubscribe).toBe('function')
    }
  })

  it.each(HOOKS)('answers a $event delivery with an array of canonical records', async (hook) => {
    const envelope = sampleEnvelope(hook.event)

    const delivered = await appTester(performOf(hookOperation(hook.key)), {
      authData,
      inputData: inputFor(hook, envelope),
      cleanedRequest: envelope,
    })

    expect(Array.isArray(delivered)).toBe(true)

    const [record] = delivered as Record<string, unknown>[]
    expect(record?.id).toBe(envelope.id)

    for (const key of rawOnlyKeys(envelope)) {
      expect(record).not.toHaveProperty(key)
    }
  })

  it.each(HOOKS)('keeps the $key sample inside the keys a $event run produces', async (hook) => {
    const envelope = sampleEnvelope(hook.event)

    const [record] = (await appTester(performOf(hookOperation(hook.key)), {
      authData,
      inputData: inputFor(hook, envelope),
      cleanedRequest: envelope,
    })) as Record<string, unknown>[]

    const sample = hookOperation(hook.key).sample
    expect(sample).toBeDefined()
    expect(Object.keys(sample ?? {}).length).toBeGreaterThan(0)
    expect(missingFromLive(sample, record)).toEqual([])
  })

  it('advertises no workspace-specific custom slot in any sample', () => {
    // The twenty slots are returned for every user and mean something different in
    // every workspace, so a sample naming one teaches a mapping that is wrong
    // almost everywhere it is read.
    for (const { key } of HOOKS) {
      const sample = hookOperation(key).sample ?? {}

      expect(Object.keys(sample).filter((field) => field.startsWith('custom_'))).toEqual([])
    }
  })
})

describe('actions', () => {
  it('answers the upsert with one object, not an array, and stays inside its sample', async () => {
    // A create returns the single record it wrote, and the platform rejects an
    // array here — the opposite of the rule every trigger lives by.
    nock(CLOUD_API_URL)
      .post('/api/contacts.upsert')
      .reply(200, {
        email: 'bob.sample@example.com',
        action: 'create',
        contact: {
          email: 'bob.sample@example.com',
          external_id: 'crm-4815',
          first_name: 'Bob',
          created_at: '2024-01-15T09:30:00Z',
          updated_at: '2024-01-15T09:30:00Z',
        },
      })

    const written = await appTester(performOf(upsertContact.operation), {
      authData,
      inputData: { workspace_id: 'acme', email: 'bob.sample@example.com' },
    })

    expect(Array.isArray(written)).toBe(false)
    expect(isRecord(written)).toBe(true)
    expect(missingFromLive(upsertContact.operation.sample, written)).toEqual([])
  })

  it('answers the subscribe with one object, and stays inside its sample line items', async () => {
    nock(CLOUD_API_URL)
      .post('/api/lists.subscribe')
      .reply(200, {
        success: true,
        contact_lists: [
          {
            email: 'bob.sample@example.com',
            list_id: 'newsletter',
            list_name: 'Monthly Newsletter',
            status: 'pending',
            created_at: '2024-01-15T09:30:00Z',
            updated_at: '2024-01-15T09:30:00Z',
          },
        ],
      })

    const written = await appTester(performOf(subscribeToList.operation), {
      authData,
      inputData: {
        workspace_id: 'acme',
        list_ids: ['newsletter'],
        email: 'bob.sample@example.com',
      },
    })

    expect(Array.isArray(written)).toBe(false)
    expect(missingFromLive(subscribeToList.operation.sample, written)).toEqual([])
  })
})

describe('dropdowns', () => {
  interface Listing {
    picker: { operation: unknown }
    path: string
    /** The empty listing each endpoint answers with, in the envelope it uses. */
    body: Record<string, unknown> | unknown[]
  }

  const listings: Listing[] = [
    { picker: workspaceDropdown, path: '/api/workspaces.list', body: [] },
    { picker: listDropdown, path: '/api/lists.list', body: { lists: [] } },
    { picker: segmentDropdown, path: '/api/segments.list', body: { segments: [] } },
  ]

  it.each(listings)('answers $path with an array', async ({ picker, path, body }) => {
    nock(CLOUD_API_URL).get(path).query(true).reply(200, body)

    const choices = await appTester(performOf(picker.operation), {
      authData,
      inputData: { workspace_id: 'acme' },
    })

    expect(Array.isArray(choices)).toBe(true)
  })
})

describe('samples', () => {
  /** Every `*_at` value a sample carries, with the path that names it. */
  const timestampsIn = (value: unknown, path = ''): { path: string; value: unknown }[] => {
    if (Array.isArray(value)) {
      return value.flatMap((entry, index) => timestampsIn(entry, `${path}[${index}]`))
    }
    if (!isRecord(value)) {
      return []
    }

    return Object.entries(value).flatMap(([key, nested]) => {
      const at = path === '' ? key : `${path}.${key}`
      return key.endsWith('_at') ? [{ path: at, value: nested }] : timestampsIn(nested, at)
    })
  }

  const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

  it('dates every sample in ISO 8601 with an offset', () => {
    // D023. A date rendered any other way arrives as text in every step
    // downstream, which cannot compare it, format it, or delay until it.
    const samples = [
      ...HOOKS.map((hook) => hookOperation(hook.key).sample),
      ...CREATES.map((create) => create.operation.sample),
    ]

    for (const sample of samples) {
      for (const stamp of timestampsIn(sample)) {
        if (stamp.value === null) {
          continue
        }
        expect({ path: stamp.path, value: stamp.value }).toEqual({
          path: stamp.path,
          value: expect.stringMatching(ISO_8601),
        })
      }
    }
  })

  it('carries a recorded delivery for every event type a trigger subscribes to', () => {
    for (const hook of HOOKS) {
      expect(sampleEnvelope(hook.event).type).toBe(hook.event)
    }

    // The other two "New List Subscriber" listens for. A returning contact emits
    // one of these instead of list.subscribed, so a payload for each has to exist
    // before anyone can claim to know what that trigger delivers.
    for (const event of ['list.confirmed', 'list.resubscribed'] as const) {
      expect(sampleEnvelope(event).type).toBe(event)
    }
  })
})

describe('module boundaries', () => {
  const SRC = fileURLToPath(new URL('../src', import.meta.url))

  const sourceFiles = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        return sourceFiles(path)
      }
      return entry.name.endsWith('.ts') ? [path] : []
    })

  /**
   * Drops comments before scanning, so a rule can be *described* in the file it
   * governs without tripping the check that enforces it. The `://` guard keeps a
   * URL inside a string literal from reading as the start of a comment.
   */
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  const filesUsing = (expression: string): string[] =>
    sourceFiles(SRC)
      .filter((path) => stripComments(readFileSync(path, 'utf8')).includes(expression))
      .map((path) => relative(SRC, path).split(sep).join('/'))
      .sort()

  it('reads the stored subscription and the target URL only where they exist', () => {
    // Both are populated for performSubscribe and performUnsubscribe and nowhere
    // else. A performList reaching for either gets undefined — Zapier calls it
    // *instead of* subscribing — and the editor then shows an error, or worse an
    // empty list that reads as "this workspace has no data".
    expect(filesUsing('bundle.subscribeData')).toEqual(['hooks/subscribe.ts'])
    expect(filesUsing('bundle.targetUrl')).toEqual(['hooks/subscribe.ts'])
  })

  it('turns the raw delivery body into an envelope in one place', () => {
    // Everything downstream of envelopeFrom sees an envelope, and only the shape
    // modules look inside its `data`. That is what stops a raw column name
    // reaching a trigger's output, where no read endpoint could reproduce it.
    expect(filesUsing('bundle.cleanedRequest')).toEqual(['triggers/common.ts'])
  })

  it('declares no outputFields, which would opt into more review checks than it is worth', () => {
    // They are optional, and a partial set is worse than none: declaring them opts
    // the operation into validation against the static sample, the stored polling
    // sample and live Zap History.
    for (const { key } of HOOKS) {
      expect(hookOperation(key).outputFields).toBeUndefined()
    }
    for (const create of CREATES) {
      expect(create.operation.outputFields).toBeUndefined()
    }
  })
})
