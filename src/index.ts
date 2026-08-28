import { createRequire } from 'node:module'

import { defineApp, version as platformVersion } from 'zapier-platform-core'

import authentication from './authentication.js'
import subscribeToList from './creates/subscribeToList.js'
import upsertContact from './creates/upsertContact.js'
import { listDropdown } from './dropdowns/list.js'
import { segmentDropdown } from './dropdowns/segment.js'
import { workspaceDropdown } from './dropdowns/workspace.js'
import { afterResponse, beforeRequest } from './middleware.js'
import contactUnsubscribed from './triggers/contactUnsubscribed.js'
import newContact from './triggers/newContact.js'
import newListSubscriber from './triggers/newListSubscriber.js'
import segmentJoined from './triggers/segmentJoined.js'
import segmentLeft from './triggers/segmentLeft.js'
import updatedContact from './triggers/updatedContact.js'

// The integration's own version has to match package.json — the CLI reads that
// file when it pushes, and a version that disagrees with the one in the bundle is
// a version nobody can find again. Reading it at runtime keeps one source.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

export default defineApp({
  version,
  platformVersion,

  authentication,

  // Every outgoing request is resolved against the user's instance and signed
  // here, so no operation has to know how the API URL was typed, and every
  // failure reaches the user as the same three sentences.
  beforeRequest: [beforeRequest],
  afterResponse: [afterResponse],

  flags: {
    // What a blank field means is decided by the operation that reads it, not by
    // a platform default that strips empties before any of this code runs: an
    // omitted contact field leaves the stored value alone, while an empty one
    // would erase it, and the two must not be collapsed on the way in. Declared
    // once here rather than per operation so a new trigger inherits the same
    // reading; the two creates restate it, because that is where it bites.
    cleanInputData: false,
  },

  // A dynamic dropdown is a hidden trigger — that is the only shape Zapier has
  // for "call the API to fill in this field" — so the three pickers live in this
  // object next to the six visible triggers.
  triggers: {
    [workspaceDropdown.key]: workspaceDropdown,
    [listDropdown.key]: listDropdown,
    [segmentDropdown.key]: segmentDropdown,

    [newContact.key]: newContact,
    [updatedContact.key]: updatedContact,
    [newListSubscriber.key]: newListSubscriber,
    [contactUnsubscribed.key]: contactUnsubscribed,
    [segmentJoined.key]: segmentJoined,
    [segmentLeft.key]: segmentLeft,
  },

  // Each visible operation is an obligation as well as a feature: it needs a live
  // Zap and one successful run in the integration admins' account before public
  // review passes, and Zapier has blocked migrating users across integration
  // majors since February 2026 — so the first published major cannot be escaped
  // later by adding a third action.
  creates: {
    [upsertContact.key]: upsertContact,
    [subscribeToList.key]: subscribeToList,
  },
})
