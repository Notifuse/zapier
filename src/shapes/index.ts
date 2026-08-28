/**
 * The shape layer: one canonical record per trigger noun, built by two
 * constructors that agree on every key.
 *
 * Triggers import from here and return what these build, nothing else. A raw
 * envelope field reaching a trigger's return value — `bundle.cleanedRequest.data.something`
 * outside this directory — is the bug the layer exists to prevent.
 */
export * as contact from './contact.js'
export * as listMembership from './listMembership.js'
export * as segmentMembership from './segmentMembership.js'

export type { ApiRecord, SegmentReference, WebhookEnvelope } from './common.js'
export type { Contact } from './contact.js'
export type { ListMembership } from './listMembership.js'
export type { SegmentMembership } from './segmentMembership.js'
