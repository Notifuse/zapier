import {
  type ApiRecord,
  type SegmentReference,
  type WebhookEnvelope,
  instant,
  requireRecord,
  requireText,
  text,
} from './common.js'

/**
 * The canonical segment membership a Zapier segment trigger emits.
 *
 * The webhook sends `{email, segment_id, segment_name}`. The read endpoint behind
 * `performList` is `segments.contacts?expand=contact`, which answers "who is in
 * this segment" with `{contact, matched_at}` entries, most recently joined first
 * — so the segment's own id and name come from the trigger's input field, where
 * the Zap author picked the segment.
 *
 * The expanded contact is deliberately not merged in here. The hook payload
 * carries only the address, so any contact field would be blank on the path that
 * actually fires the Zap.
 */
export interface SegmentMembership {
  /**
   * The delivery row id on the hook path, a derived key on the read path. For
   * legibility and support only — hook triggers are not deduplicated.
   */
  id: string
  email: string
  segment_id: string
  segment_name: string | null
  /**
   * When the membership changed: the delivery timestamp on the hook path, the
   * `matched_at` join time on the read path.
   */
  occurred_at: string | null
}

/** Builds the canonical membership from a `segment.joined` / `segment.left` delivery. */
export const fromWebhook = (envelope: WebhookEnvelope): SegmentMembership => {
  const data = envelope.data

  return {
    id: envelope.id,
    email: requireText(data.email, 'a segment.* payload must carry an email'),
    segment_id: requireText(data.segment_id, 'a segment.* payload must carry a segment_id'),
    segment_name: text(data.segment_name),
    occurred_at: instant(envelope.timestamp),
  }
}

/**
 * Builds the canonical membership from one entry of an expanded
 * `segments.contacts` listing and the segment the trigger is watching.
 *
 * A bare contact is rejected rather than accepted: the endpoint nests it under
 * `contact`, so an unnested record means the request went out without
 * `expand=contact`, and the entry would carry no join time to order by.
 */
export const fromApi = (
  input: ApiRecord | null | undefined,
  segment: SegmentReference,
): SegmentMembership => {
  const member = requireRecord(input, 'no segment member to read; the API returned none')
  const contact = requireRecord(
    member.contact,
    'a segment member must nest its contact under `contact` (expand=contact)',
  )

  const email = requireText(contact.email, 'a segment member must carry an email')

  return {
    id: `segment:${segment.id}:${email}`,
    email,
    segment_id: segment.id,
    segment_name: text(segment.name),
    occurred_at: instant(member.matched_at),
  }
}
