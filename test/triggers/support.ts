import type { Bundle, PlainInputField, ZObject } from 'zapier-platform-core'

import App from '../../src/index.js'

/**
 * The hook operations of one trigger, typed by the record that trigger emits.
 *
 * A `Trigger`'s `operation` is a union of the polling, hook and hook-to-poll
 * shapes, so nothing is readable off it without narrowing, and `createAppTester`
 * infers what it returns from the function it is handed. Naming the record type
 * here is what lets a test assert on a field rather than on `unknown` — and
 * saying it out loud is the point: `perform` and `performList` returning the same
 * type is the contract the whole shape layer exists to keep.
 */
export interface HookOperation<T> {
  type?: string
  perform: (z: ZObject, bundle: Bundle) => T[] | Promise<T[]>
  performList: (z: ZObject, bundle: Bundle) => T[] | Promise<T[]>
  performSubscribe: (z: ZObject, bundle: Bundle) => Promise<unknown>
  performUnsubscribe: (z: ZObject, bundle: Bundle) => Promise<unknown>
  inputFields?: readonly PlainInputField[]
  outputFields?: readonly unknown[]
  sample?: Record<string, unknown>
}

type RegisteredTrigger = keyof typeof App.triggers

/** Reads one registered trigger's operation as the hook it is. */
export const hookOperation = <T>(key: RegisteredTrigger): HookOperation<T> =>
  App.triggers[key].operation as unknown as HookOperation<T>

/** The registered trigger itself, for the parts outside `operation`. */
export const registeredTrigger = (key: RegisteredTrigger) => App.triggers[key]
