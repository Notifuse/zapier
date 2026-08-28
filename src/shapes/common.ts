/**
 * Shared vocabulary for the shape layer.
 *
 * Notifuse describes the same record two different ways depending on which door
 * it comes through, and neither description is wrong:
 *
 * - A webhook payload is `to_jsonb()` over the database row. Raw column names,
 *   every column present, an unset one sent as `null`, and the `db_*` bookkeeping
 *   columns included.
 * - An API response is the marshalled Go struct. JSON tags, `omitempty` on every
 *   optional field so an unset one is *absent*, no `db_*` columns, and joins
 *   (`contact_lists`, `contact_segments`) that the webhook never carries.
 *
 * Zapier requires a hook trigger's `performList` records to match the hook
 * payload in spelling, casing and nesting, and checks it at review time. When the
 * two diverge nothing errors: the Zap keeps running and every field the user
 * mapped resolves to blank. The helpers here are what collapse the two
 * descriptions into one, and every trigger returns only shapes built from them.
 */

/** The delivery envelope Notifuse POSTs to a subscribed URL. */
export interface WebhookEnvelope {
  /** The delivery row id. Unique per POST — but see the note on ids below. */
  id: string
  /** The event type, e.g. `list.resubscribed`. */
  type: string
  workspace_id: string
  /** Stamped by the delivery worker at send time; never stored. */
  timestamp: string
  data: Record<string, unknown>
}

/** A decoded JSON object from the Notifuse API. */
export type ApiRecord = Readonly<Record<string, unknown>>

/** A segment as the Zap author picked it in the trigger's input field. */
export interface SegmentReference {
  id: string
  name?: string | null
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Reads a value as text, treating an absent key and an explicit null as the same
 * thing — which they are, to a Zap: both render as an empty cell, and the two
 * sources disagree about which one to send for an unset field.
 */
export const text = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return null
}

/**
 * Reads a value as a number. The string branch is not theoretical: a numeric
 * column can reach JSON as a quoted value depending on how it was serialised, and
 * a silently blanked number field is exactly the failure this module exists to
 * prevent.
 */
export const decimal = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * Renders a timestamp as one instant in ISO 8601 UTC.
 *
 * The same moment is spelled differently by the two paths and a Zap can see
 * neither reason: PostgreSQL renders a `timestamptz` in the session's time zone,
 * so `to_jsonb` produces an offset where Go produces `Z`, and the API marshals a
 * nullable datetime at second precision while the webhook carries the
 * microseconds the column stores. What the shape owes a user is the same instant
 * in the format Zapier expects for a date field, not the same characters.
 *
 * A value that does not parse is passed through untouched rather than dropped: a
 * surprising string in a field beats a blank one, and it is visible in Zap
 * History.
 */
export const instant = (value: unknown): string | null => {
  const raw = text(value)
  if (raw === null) {
    return null
  }
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString()
}

/**
 * Passes a JSON value through, mapping an absent key to null so the key set stays
 * the same on both paths. Custom JSON slots hold whatever the workspace put in
 * them, so there is nothing to coerce.
 */
export const json = (value: unknown): unknown => (value === undefined ? null : value)

/**
 * Reads a value that the record cannot be built without.
 *
 * Throwing beats emitting a record with a blank key: the Zap run fails loudly in
 * Zap History instead of writing an empty row into whatever the user connected
 * downstream, and a payload missing its identifier means the producer changed.
 */
/**
 * Reads a value that must be an object before anything can be read out of it.
 *
 * The interesting case is an API response that is shaped correctly but empty —
 * `contacts.upsert` leaves its read-back `contact` unset when the write committed
 * and the read that follows it did not. Reaching into that would throw a
 * `TypeError` about `undefined` several frames from the cause.
 */
export const requireRecord = (value: unknown, message: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(message)
  }
  return value
}

export const requireText = (value: unknown, message: string): string => {
  const read = text(value)
  if (read === null || read === '') {
    throw new Error(message)
  }
  return read
}
