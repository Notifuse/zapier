import type { Authentication, Bundle, ZObject } from 'zapier-platform-core'

import { CLOUD_API_URL } from './constants.js'
import { normalizeBaseUrl } from './middleware.js'

export { CLOUD_API_URL }

/** One entry of the bare array `workspaces.list` answers with. */
interface WorkspaceRecord {
  id?: unknown
  name?: unknown
}

/** What the connection test reports, and what `connectionLabel` then reads. */
interface ConnectionSummary {
  workspace_id: string
  workspace_name: string
  host: string
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** The one endpoint the connection test calls; named so the failure can quote it. */
const WORKSPACES_PATH = '/api/workspaces.list'

/** The host of a base URL, for labelling; falls back to the raw string. */
const hostOf = (baseUrl: string): string => {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

/**
 * Confirms the key works, and reports what the connection is attached to.
 *
 * `workspaces.list` is the right endpoint to ask: it needs no `workspace_id`, no
 * permission gates it, it answers with a bare array, and it reads the database —
 * so a key that was revoked fails here rather than passing a check that never
 * left the process.
 */
export const testAuth = async (z: ZObject, bundle: Bundle): Promise<ConnectionSummary> => {
  const baseUrl = normalizeBaseUrl(bundle.authData?.apiUrl)

  const response = await z.request<WorkspaceRecord[]>({
    url: WORKSPACES_PATH,
    method: 'GET',
  })

  if (!Array.isArray(response.data)) {
    // Not "no workspace": whatever answered is not this API, and a body that is
    // not JSON leaves `data` undefined — the platform swallows the parse error and
    // `afterResponse` lets anything under 400 through untouched. A wrong address
    // is how that happens, and it does not announce itself: Notifuse answers an
    // unknown path under `/console` with the SPA's index.html and a 200, so every
    // endpoint returns HTML. Blaming the key here would send the user to create a
    // second one, and a third, while the field that is actually wrong goes
    // untouched.
    throw new z.errors.Error(
      `${baseUrl}${WORKSPACES_PATH} did not answer with a list of Notifuse workspaces, so that address is not a Notifuse API. Check the API URL on this connection: it takes the scheme and domain of your instance and nothing more, such as https://emails.yourcompany.com.`,
      'NotNotifuseApi',
      400,
    )
  }

  const workspaces = response.data
  if (workspaces.length === 0) {
    // The key authenticates but reaches nothing. Every trigger and action needs a
    // workspace, so failing here beats an empty dropdown three screens later.
    throw new z.errors.Error(
      'This API key does not belong to any workspace. Create the key inside the workspace you want Zapier to use, from Settings → Integrations → Zapier.',
      'NoWorkspace',
      403,
    )
  }

  // An API key belongs to exactly one workspace, so the first entry is the one.
  const [workspace] = workspaces
  return {
    workspace_id: text(workspace?.id),
    workspace_name: text(workspace?.name),
    host: hostOf(baseUrl),
  }
}

/**
 * Labels the connection with the workspace and the host it lives on.
 *
 * The host is half the label because a customer can hold connections to several
 * instances — a self-hosted one and the cloud, staging and production — and
 * workspace names repeat across them.
 */
export const connectionLabel = async (_z: ZObject, bundle: Bundle): Promise<string> => {
  const summary = bundle.inputData as Partial<ConnectionSummary> | undefined
  const name = text(summary?.workspace_name)
  const host = text(summary?.host) || hostOf(normalizeBaseUrl(bundle.authData?.apiUrl))

  if (name === '') {
    return host
  }
  return `${name} (${host})`
}

/**
 * Custom auth: an API key, plus the address of the instance it belongs to.
 *
 * There is no `workspace_id` field here on purpose. Nearly every endpoint needs
 * one and it cannot be derived from the key, but custom auth does not support
 * computed fields — so a field here would be typed by hand, unvalidated, and
 * wrong for every operation that disagreed with it. It lives in a per-operation
 * input field backed by a dropdown over `workspaces.list` instead, which
 * resolves to the key's single workspace and selects it.
 */
const authentication = {
  type: 'custom',
  fields: [
    {
      key: 'apiUrl',
      label: 'API URL',
      type: 'string',
      required: false,
      default: CLOUD_API_URL,
      placeholder: 'https://emails.yourcompany.com',
      helpText:
        'Only change this if you self-host Notifuse. Enter the address you open the Notifuse console at — scheme and domain only. It must be reachable over HTTPS with a certificate from a public certificate authority. [Finding your API URL](https://docs.notifuse.com/integrations/zapier)',
      // The instance address is not a secret, and marking it so keeps it readable
      // in logs and in the connection label.
      isNoSecret: true,
    },
    {
      key: 'apiKey',
      label: 'API Key',
      type: 'password',
      required: true,
      helpText:
        'Create one in Notifuse under Settings → Integrations → Zapier, which scopes the key to what a Zap needs. The token is shown once, when the connection is made. [What the key can reach](https://docs.notifuse.com/integrations/zapier)',
    },
  ],
  test: testAuth,
  connectionLabel,
} satisfies Authentication

export default authentication
