# Embedding `@pandora/tracker` on each platform

One SDK, five sources: **Monolith, Nubia, Nimbus, Primedrive, Prototype**. Each
platform mints its own key, initializes the tracker once on the server, and fires
events from its server-side code. The same pipeline carries everything.

## Non-negotiables

- **Server-side only.** The key secret signs requests; it must never reach a
  browser. Browser/app interactions call your platform's backend, which calls the
  tracker. (Next.js: route handlers, server actions, API routes — never client
  components.)
- **`product_improvement` is metadata-only and enforced.** If you put a raw
  content field (`text`, `body`, `transcript`, `prompt`, `response`,
  `completion`) on a `product_improvement` event, ingestion rejects it. Content
  flows only under `model_training`.
- **Access never depends on training data.** `model_training` is default-on under
  the platform ToS, but every platform must expose a clear opt-out. Do not gate
  features or free Nubia access on whether someone leaves training data enabled.

## 1. Install

In each platform's repo:

```bash
npm install @pandora/tracker
```

(Until it's published to a registry, point at the workspace or a tarball:
`npm install /path/to/pandora/packages/tracker`.)

## 2. Initialize once (per platform)

```ts
// pandora.ts — imported once at server startup
import { init } from '@pandora/tracker';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export const pandora = init({
  source: 'nubia', // ← this platform's source id
  endpoint: process.env.PANDORA_URL!, // https://ingest.pandora.dev
  keyId: process.env.PANDORA_KEY!, // pk_nubia_xxx
  secret: process.env.PANDORA_SECRET!, // HMAC secret
  resolveConsent: async (userId) => {
    const { data } = await supabase.rpc('granted_scopes', { p_source: 'nubia', p_user_id: userId });
    return data ?? [];
  },
});
```

`resolveConsent` is the opt-out gate: the SDK won't send an event for a scope the
user has revoked. `granted_scopes` ships in `db/schema.sql`; no row means allowed,
the latest `revoke` row removes a scope, and a later `grant` opts the user back in.

## 3. Fire events from the server

`track()` is fire-and-forget and never throws into your app. Use a stable
pseudonymous `userId` (e.g. the Supabase auth id) — never an email or name.

```ts
import { track, SCOPES } from '@pandora/tracker';

await track({
  userId,
  scope: SCOPES.PRODUCT_IMPROVEMENT, // internal analytics
  type: 'page.viewed',
  data: { path: '/pricing' },
});
```

## Per-platform event map

Fire what's listed; add new types freely (unknown types are accepted and flagged
until you add their schema to `packages/schema/src/vocab.ts`).

### Monolith — trymonolith.xyz
- `page.viewed` `{ path, referrer? }`
- `demo.interacted` `{ demo, step? }`
- `quote.requested` `{ service, budgetBand? }`

### Nubia — getnubia.com (free for African students; the AI lives here)
Learning signal:
- `study_session.completed` `{ subject, durationSec, score?, cardsReviewed? }`
- `quiz.answered` `{ quizId, questionId, correct, latencyMs? }`
- `content.viewed` `{ contentId, contentType, dwellMs? }`
- `search.performed` `{ query, resultCount }`

The model loop (this is Atlas's future corpus). `model` is `'heisenberg'` today,
`'atlas'` once the owned model is live — same events, one continuous corpus.
`conversationId` + `turnIndex` reconstruct full tutoring dialogues into
long-context training examples. Send raw `text` only under `model_training` when
the user has not opted out:

```ts
const allowedScopes = await resolvePandoraScopes(userId);
const trainingAllowed = allowedScopes.includes(SCOPES.MODEL_TRAINING);

// student asks/types in Setswana or another supported language
// Pandora logs raw input before Gemini/Heisenberg receives it
await track({ userId, scope: trainingAllowed ? SCOPES.MODEL_TRAINING : SCOPES.PRODUCT_IMPROVEMENT,
  type: 'ai.queried',
  data: { conversationId, turnIndex, model: 'heisenberg', subject: 'biology',
          language: 'tn', inputMode: 'typed',
          ...(trainingAllowed ? { text: question } : { queryChars: question.length }) } });

// Gemini/Heisenberg translates/responds, then Pandora logs the output too
await track({ userId, scope: trainingAllowed ? SCOPES.MODEL_TRAINING : SCOPES.PRODUCT_IMPROVEMENT,
  type: 'ai.responded',
  data: { conversationId, turnIndex, model: 'heisenberg', language: 'tn',
          latencyMs, completionTokens,
          ...(trainingAllowed ? { text: answer } : {}) } });

// the student reacts → the reward signal
await track({ userId, scope: SCOPES.MODEL_TRAINING, type: 'ai.feedback',
  data: { conversationId, turnIndex, signal: 'thumbs_up', reward: 1 } });
```

### Nimbus — student accommodation
- `listing.viewed` `{ listingId, priceBwp? }`
- `listing.searched` `{ query?, filters?, resultCount }`
- `message.sent` `{ threadId, length? }` — length only, never the message body
- `booking.requested` `{ listingId, moveInDate? }`

### Primedrive — car marketplace
- `listing.viewed` `{ listingId, priceBwp? }`
- `route.searched` `{ origin?, destination? }`
- `trip.completed` `{ tripId, distanceKm?, durationSec? }`

### Prototype — Gaborone map
- `map.viewed` `{ center?, zoom? }`
- `location.searched` `{ query, resultCount }`
- `place.corrected` `{ placeId, field }` — user-sourced map corrections

## Nubia language-capture flow

Push this through Heisenberg AI in Nubia:

1. User speaks or types in Setswana.
2. Pandora logs the raw input silently as `ai.queried`.
3. Gemini/Heisenberg receives the input, translates as needed, and responds.
4. Pandora logs Gemini/Heisenberg output as `ai.responded`.
5. The user receives the answer.

Use BCP-47 language tags in event data (`tn` for Setswana). For other free
African indigenous-language datasets, add a source manifest in Pandora before
funneling the data so provenance and license terms travel with the corpus.

## 4. The opt-out toggle (write side)

Scope state is an append-only log: a grant is a row, a revocation is another row.
`granted_scopes` derives the current state. The `model_training` scope is default
**on** under the ToS; the toggle disables or re-enables that scope without changing
platform access:

```ts
// when the user flips the model-training toggle in settings
await supabase.from('consent').insert({
  source: 'nubia',
  user_id: userId,
  scope: 'model_training',
  action: enabled ? 'grant' : 'revoke', // enabled=true opts back in
});
```

Because the SDK caches scope state briefly (default 60s), a revocation takes effect
within that window — fast enough to honour, cheap enough to scale.

## 5. Graceful shutdown

Flush in-flight events when a process exits:

```ts
import { flush } from '@pandora/tracker';
process.on('SIGTERM', async () => { await flush(); process.exit(0); });
```

That's the whole integration. Once all five are emitting, the lake fills, and the
`model_training` slice is what `services/datasets` packages into Atlas's corpus.
