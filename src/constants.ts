/**
 * The Notifuse Cloud API.
 *
 * It lives on its own rather than in `authentication.ts` because the middleware
 * needs it to resolve every request and `authentication.ts` needs the
 * middleware's URL normalisation to label a connection — importing one from the
 * other would make that a cycle.
 */
export const CLOUD_API_URL = 'https://v3.notifuse.com'
