import { describe, expect, it } from 'vitest'

import { V1_EVENT_TYPES, sampleEnvelope } from '../../src/samples/index.js'

describe('generated payload samples', () => {
  it('carries a recorded delivery for every v1 event type', () => {
    for (const eventType of V1_EVENT_TYPES) {
      const envelope = sampleEnvelope(eventType)

      expect(envelope.type).toBe(eventType)
      expect(envelope.id).not.toBe('')
      expect(envelope.timestamp).not.toBe('')
      expect(Object.keys(envelope.data).length).toBeGreaterThan(0)
    }
  })

  it('hands out a copy, so one caller cannot reshape another caller sample', () => {
    const first = sampleEnvelope('contact.created')
    delete first.data.contact

    expect(sampleEnvelope('contact.created').data.contact).toBeDefined()
  })
})
