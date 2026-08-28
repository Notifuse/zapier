# notifuse-zapier — Project Instructions

Zapier CLI integration for [Notifuse](https://www.notifuse.com), a self-hosted and cloud-hosted email marketing platform. Triggers are REST Hooks layered on Notifuse's existing outbound webhook subsystem; actions call its RPC API.

**The backend lives in a separate repository** (`../notifuse`, Go + PostgreSQL). The design rationale, the backend prerequisites and the publishing plan are in `../notifuse/plans/zapier-integration-plan.md` — read it before changing anything structural here. Payload shapes are produced by PL/pgSQL triggers in that repo, so **no compiler in this repository can see them change**. That single fact drives most of the rules below.

Status: scaffolded and green — six REST Hook triggers, two actions, three dropdowns. `npm test`, `npm run typecheck` and `npx zapier-platform validate` all pass; nothing has been pushed or promoted. *Architecture* below describes what exists.

## Non-negotiables

Violating any of these produces a bug that is silent, ships to users, and cannot be fixed without a new major version — which existing Zaps can never be migrated onto (Zapier blocked cross-major migration in February 2026).

1. **Hook triggers are not deduplicated. At all.** Check D010: *"Hooks are not deduped, so they're not required to have a primary key."* Emit `id` for legibility, never as a dedup mechanism. Every POST Notifuse sends fires the Zap. Once-and-only-once is the producer's job, not ours.
2. **`perform` must return an array**, even for a single object. `{}` or `null` is a structural failure.
3. **`performList` must work with zero subscription state.** Zapier calls it *instead of* subscribing when it exists, so there is no `bundle.subscribeData`, no `bundle.targetUrl`, and no guarantee a delivery log exists yet. It must also be side-effect-free and idempotent — `performSubscribe` has been observed firing on draft Zaps that are never unsubscribed, so tolerate duplicate subscribe calls too.
4. **`performList` output must match the hook payload exactly** — spelling, casing, nesting. This is machine-checked against real runs (T004, T006). A `perform` returning `OrderNo` against a `performList` returning `orderNo` silently blanks every user's field mappings. This is the single most common way a Zapier app fails review, and the reason `src/shapes/` exists.
5. **`sample` must be a *subset* of live keys, never a superset.** A key present in the sample but absent from the live payload is exactly what breaks mappings. One item (not an array), representative values (`"Bob"`, not `"string"`), only keys returned for *every* user (so no custom-field slots), ISO-8601 dates with offset (D023), no PII.
6. **Do not declare `outputFields` unless a field is genuinely opaque.** They are optional, but declaring them opts into validation against the static sample (D024), the stored polling sample (Z001) *and* live Zap History (T005). A partial `outputFields` is worse than none.
7. **`bundle.subscribeData` exists only in `performUnsubscribe`.** Never read it in `perform`. The webhook signing secret is therefore unreachable at delivery time — do not design around verifying signatures. The unguessability of the `hooks.zapier.com` URL is the only authentication on that channel.
8. **Unsubscribe with `webhookSubscriptions.delete`, never `.update`.** The update endpoint is a full replace, not a patch; omitted fields blank `name` and `url`.
9. **HTTPS only.** D007 makes it mandatory for public apps and Zapier accepts only public-CA certificates. Reject `http://` in the auth field with a message that names the URL.
10. **Never add a trigger or action without a plan to keep a live Zap running for it.** S002 and T001 require one live Zap and one successful run per *visible* operation, checked against the integration admins' Zap History.

## The TDD loop

Every trigger, action and helper starts as a failing test. No exceptions — the payloads come from another repository and the review checks are automated, so tests are the only place the contract is actually pinned.

**Red → Green → Refactor, with the fixture as the contract:**

1. **Start from the generated sample.** `src/samples/payloads.json` is produced by a Go integration test in the backend repo (`tests/integration/webhook_payload_samples_test.go`), which inserts a real record and captures the resulting `webhook_deliveries.payload`. It is checked in here. **Never hand-write or hand-edit it** — reading payload shapes out of PL/pgSQL string literals by eye guarantees drift.
2. **Write the shape test first.** Assert that `fromWebhook(<generated payload>)` and `fromApi(<API fixture>)` produce objects with identical key sets. That assertion is the whole point of the architecture; write it before either constructor exists.
3. **Write the operation test.** Use `createAppTester` with `nock` intercepting the Notifuse API. Assert on the returned array, its `id`, and the exact keys — not just that it "worked".
4. **Then implement.** Smallest change that turns the test green.
5. **Refactor** with the tests as the safety net.

**Before every commit**, `npm test` must pass and `zapier-platform validate` must be clean.

Three test kinds, all required for a trigger:

| Kind | File | Asserts |
| --- | --- | --- |
| Shape parity | `test/shapes/<noun>.test.ts` | `fromWebhook` and `fromApi` yield identical key sets; unknowable fields are `null` in both |
| Sample conformance | `test/app.test.ts` | every `sample` is a subset — at every level, line items included — of the keys its `perform` produces from the generated payload |
| Operation | `test/triggers/<name>.test.ts` | `perform` returns an array; `performList` returns an array with zero subscription state; `performSubscribe` posts the right body and is idempotent |

When a test needs a payload the generated file does not contain, **fix the generator in the backend repo**. Do not add a hand-written fixture — that reintroduces exactly the drift the generator exists to prevent.

## Architecture

```
src/
  index.ts               defineApp — the registry every operation is wired into
  authentication.ts      custom auth: apiUrl (optional, cloud default) + apiKey
  constants.ts           the cloud API host, so auth and middleware need not import each other
  middleware.ts          beforeRequest: URL normalisation + Bearer; afterResponse: error mapping
  shapes/                the contract layer — see below
    common.ts            the coercions both constructors share
    contact.ts           fromWebhook(envelope) | fromApi(record) -> Contact
    listMembership.ts
    segmentMembership.ts
    index.ts             namespaced re-exports
  triggers/              newContact, updatedContact, newListSubscriber,
                         contactUnsubscribed, segmentJoined, segmentLeft
    common.ts            input fields, envelopeFrom, and the performList sources
  creates/               upsertContact, subscribeToList
  dropdowns/             workspace, list, segment, customFields
  hooks/subscribe.ts     shared performSubscribe / performUnsubscribe
  samples/
    payloads.json        GENERATED by the backend repo — do not edit
    index.ts             sampleEnvelope(eventType), which hands out a copy
test/
  app.test.ts            the app-level audit: registry, hook contract, samples, boundaries
```

**`src/shapes/` is the load-bearing module.** Notifuse's webhook payloads are not its API resource shapes: `contact.*` sends `to_jsonb(row)` — raw database column names including `db_created_at` and `custom_string_1` — while the API returns JSON-tagged fields; `list.*` carries `previous_status`, which no read endpoint can reproduce. Each shape module exposes `fromWebhook` and `fromApi` returning one canonical object, and **both `perform` and `performList` return that object and nothing else**. Fields a `performList` record cannot know are emitted as `null` in both paths so the key set stays identical.

Never let a raw envelope field reach a trigger's return value. If you find yourself writing `bundle.cleanedRequest.data.something` outside `src/shapes/`, stop.

## Zapier platform facts that are easy to get wrong

- **The CLI binary is `zapier-platform`, not `zapier`.** The `zapier` binary was removed in platform v19.0.0 (2026-05-18). Anything you remember or find online using `zapier push` is stale.
- Platform packages are on 19.x. The CLI needs Node ≥18.20; **integrations execute on Node 22.**
- TypeScript is first-class and **ESM-only**: `"type": "module"`, `module: NodeNext`, `exports: "./dist/index.js"`, and a `_zapier-build` npm script the CLI invokes. Use the `defineApp` / `defineTrigger` / `defineCreate` / `defineSearch` / `defineInputFields` helpers and `satisfies Authentication` for inference.
- **There is no `rest-hooks` init template.** Scaffold from `custom-auth`, then set `type: 'hook'` on scaffolded triggers.
- `zapier-platform test` wraps `npm test` and also runs `validate`. `zapier-platform invoke` runs an operation locally; `-a <auth-id>` relays through Zapier with production auth.
- Inbound hook POSTs cap at 10,485,760 bytes (10 MiB, inclusive). Rate limit is 20,000 requests per 5 minutes **per Zapier user** — key any limiter on the user segment of the target URL, since one user may own many subscriptions.
- **Zapier's hook URLs return success unconditionally.** Staff: *"The hook URLs respond with a success always to keep our infra highly available."* A 200 means bytes accepted — not validity, not existence, not execution. You cannot validate a target URL by POSTing to it.
- Terminal codes differ by URL family: `/hooks/standard/` (REST Hook target URLs, what `bundle.targetUrl` always is) signals death with **410**; `/hooks/catch/` (Catch Hook) uses **404**, and a single 404 is explicitly retryable — only sustained 404s are terminal.
- **Never redirect Zapier.** 301/302 responses are documented to fail outright.

## Notifuse API notes

- RPC-style, dot notation: `POST /api/contacts.upsert`, `GET /api/lists.list`. Not REST.
- Auth is `Authorization: Bearer <api_key JWT>`. **`workspace_id` is required on nearly every call** and cannot be derived — custom auth has no `computed` fields. It belongs in a per-operation input field with a dynamic dropdown over `workspaces.list`, not in the auth form. A connection is therefore single-workspace.
- `GET /api/workspaces.list` is the auth test: no `workspace_id`, no permission gate, returns a bare array, and touches the database so a revoked key is detected.
- Subscribe and unsubscribe use `webhookSubscriptions.create` / `.delete`, always with `source: "zapier"` so the console can distinguish our subscriptions from the user's own.
- The delivery envelope is `{id, type, workspace_id, timestamp, data}`.
- **`list.subscribed` fires only on INSERT with `status='active'`.** A returning contact emits `list.confirmed` or `list.resubscribed` instead, so "New List Subscriber" must subscribe to all three or it silently misses every re-subscriber.
- **Custom fields are 20 fixed slots** (`custom_string_1..5`, `custom_number_1..5`, `custom_datetime_1..5`, `custom_json_1..5`). Use the function form of `inputFields` to read `custom_field_labels` from the workspace settings and render only the labelled slots under their human labels.
- **`lists.subscribe` has an asymmetry worth surfacing to users:** a returning unsubscribed contact is forced to `pending` (double opt-in), while a brand-new contact lands `active` even on a double-opt-in list, because the caller is authenticated. `bounced` and `complained` are skipped silently, and an already-active membership is an idempotent no-op.
- Error codes are not yet uniform across endpoints. Map 401 to `z.errors.ExpiredAuthError` and 403 to a clear "this key lacks the required permission" message; do not assume a given status means the same thing everywhere until the backend's error-code work has landed.

## Commands

```
npm test                        # vitest — must pass before every commit
npx zapier-platform validate    # schema + style checks
npx zapier-platform test        # npm test + validate
npx zapier-platform invoke      # run an operation locally
npx zapier-platform push        # upload a version
```

## Release

`push` → `promote` (makes a version public and default) → `migrate FROM TO [PERCENT]` → `deprecate`. Migration works only within a major; **cross-major migration has been blocked since February 2026**, so the first published major must be right. Ship a deliberately small v1 and use private previews aggressively before the first `promote`.

## Never

- Never edit `src/samples/payloads.json` by hand, or derive samples from Notifuse's `webhookSubscriptions.test` endpoint — that endpoint invents fields (`subject`, `url`, `bounce_type`, `tags`) that appear in no real delivery.
- Never add a static webhook trigger — one missing `performSubscribe`/`performUnsubscribe` is rejected for public integrations (D016, D017).
- Never add AI attribution: no "Generated with Claude", no `Co-Authored-By`, no signatures in commits, changelogs, PR descriptions or code comments.
