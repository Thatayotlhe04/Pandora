# Pandora

The proprietary data spine for the portfolio — one ingestion API, one lake, one
SDK, feeding one model. Five sources emit events through `@pandora/tracker`:
**Monolith** (web design/dev), **Nubia** (African student education, free access,
with an AI inside), **Nimbus** (student accommodation), **Primedrive** (car
marketplace), **Prototype** (Gaborone maps). The allowed `model_training` slice becomes the
training corpus for **Atlas** — the owned, verticalized African model.

Think Bloomberg with a touch of Scale: the moat isn't "we have African data," it's
that we own the pipeline that produced a model nobody else could. Heisenberg — a
thin wrapper over Gemini/DeepSeek answering queries inside Nubia today — is
scaffolding. Atlas is the successor, and Pandora is how it gets built and how it
stops costing per-token.

## The invariant that makes this defensible

Every event carries a **consent scope**, and the scope decides where the data may
ever go:

- `product_improvement` — internal only. Analytics, debugging, making each product
  better. Never leaves the building, never sold. **Metadata only** — raw content
  fields (`text`, `body`, `transcript`, `prompt`, `response`, `completion`) are
  rejected by validation under this scope.
- `model_training` — default-on with a clear opt-out, and the only scope that is
  ever externally distributable or saleable. This is the corpus Atlas trains on;
  under this scope the content *is* the signal.

Two enforcement points, both in code, not just docs: the SDK refuses to send an
event for a scope the user has opted out of, and ingestion rejects content fields
on `product_improvement` events. So you can track that an AI response happened and
its latency/tokens internally, while answer text only flows in `model_training`
until that user revokes it.

Provenance is the asset. The value of a dataset is that you can prove how every row
was obtained — which is exactly what `services/datasets` packages.

## Architecture

```
  platform backend (one of five sources)
        │  @pandora/tracker  — opt-out check → batch → HMAC sign
        ▼
  POST /ingest  ·  POST /ingest/batch        ── Hono ──
        │
        ▼
  Zod validation + scope/content guard ── fail ──▶ 400 + rejection logged
        │
       pass
        ▼
  BullMQ queue (Upstash Redis)   jobId = eventId  ⇒ dedupe
        │
        ▼
  worker (micro-batched) ──▶ Supabase Postgres (hot)   [durable source of truth]
        │
        ▼
  compaction (scheduled) ──▶ R2 (cold, SNAPPY Parquet by source/scope/date)
        │
        ▼
  services/datasets ──▶ versioned, provenance-stamped JSONL  ⇒  Atlas corpus
```

Idempotency runs end to end: the SDK generates `eventId`, the queue dedupes on it,
Postgres has a unique constraint on it. At-least-once delivery becomes
exactly-once at rest.

## The model loop (Atlas's corpus)

The AI lives *inside* the platforms (Nubia today). Its events — `ai.queried`,
`ai.responded`, `ai.feedback` — capture the triple that makes a trainable model:
the query, the model's output, and the user's reaction (the reward signal). The
`model` field carries identity (`heisenberg` now, `atlas` later), so one
continuous corpus spans the transition. `conversationId` + `turnIndex` let the
dataset builder reconstruct whole dialogues into **long-context** training
examples — the proof that the pipeline produces world-class signal, not just rows.

## The dataset layer

Turns the allowed `model_training` lake into versioned, provenance-stamped
datasets. This is the cost lever (train Atlas instead of paying Gemini/DeepSeek)
and the saleable artifact (provenance travels with the data).

```bash
npm run build:dataset -w @pandora/datasets -- \
  --name nubia-tutoring-v1 \
  --scope model_training \
  --source nubia \
  --type ai.queried,ai.responded,ai.feedback \
  --group session \
  --from 2025-01-01 --to 2026-01-01
```

Output: JSONL in R2 under `datasets/<id>/data.jsonl` + a `manifest.json`, and a row
in the `datasets` table. `--group session` (or `user`) emits one coherent sequence
per line for long-context training; `none` emits atomic events. Every build records
opt-out basis, sources, types, time range, counts, schema versions, and a SHA-256
content hash. `product_improvement` cuts require `--internal` and are stamped
non-distributable.

Public Setswana data can be funneled through the same signed path after a source
manifest is approved. Start with a dry run:

```bash
node scripts/import-public-corpus.mjs --limit 5
```

Then ingest a controlled slice with a Nubia Pandora key:

```bash
node scripts/import-public-corpus.mjs --live \
  --endpoint https://pandora.example \
  --key pk_nubia_xxx \
  --secret "$PANDORA_SECRET" \
  --source nubia \
  --limit 1000
```

## Efficiency

The runtime path is lean where leanness is throughput and cost:

- **Micro-batched hot writes.** The worker runs at high concurrency feeding a
  batcher that collapses events into one multi-row upsert per ~100 events / 200ms,
  instead of one request per event — the main write-path lever.
- **SNAPPY-compressed Parquet** in cold storage, no native build step.
- **Idempotent everywhere**, so retries and replays cost nothing extra.
- **Cached, fail-closed auth** (30s key cache) and fire-and-forget rejection /
  last-used writes that never block ingest.

## Repo layout

```
packages/
  core/      @pandora/core     env, Supabase, Redis, R2, logger, HMAC
  schema/    @pandora/schema   master envelope + per-source vocab + validateEvent
  tracker/   @pandora/tracker  the server-side SDK (published)
services/
  ingestion/ Hono API: /ingest, /ingest/batch, /health, auth, rejection logging
  worker/    BullMQ consumer (batched hot write) + scheduled cold compaction
  datasets/  dataset builder CLI (provenance-stamped, grouped JSONL → R2)
db/
  schema.sql events, rejections, consent, api_keys, datasets, view, function
scripts/     mint-key.mjs, send-test.mjs
INTEGRATION.md  how to embed the SDK on each platform (start here for wiring)
```

## Setup

1. **Database** — run `db/schema.sql` in the Supabase SQL editor.
2. **Mint a key** per source and run the printed SQL:
   ```bash
   node scripts/mint-key.mjs nubia
   ```
3. **Env** — `cp .env.example .env` and fill Supabase (service role), Upstash Redis
   (`rediss://`), R2.
4. **Install & build** (services import the internal packages as compiled JS):
   ```bash
   npm install && npm run build
   ```
5. **Run** (two long-lived processes):
   ```bash
   npm run start:ingestion   # Hono API on :8787
   npm run start:worker      # batched worker + compaction
   ```
6. **Verify** end to end:
   ```bash
   node scripts/send-test.mjs http://localhost:8787 pk_nubia_xxx <secret> nubia
   ```
7. **Embed the SDK** on each platform — see `INTEGRATION.md`.

## Deployment note

The stack lists "Cloudflare Workers or a VPS." **BullMQ needs a long-lived Node
process and persistent Redis connections — it can't run on Workers.** Deploy the
ingestion API and worker as long-running processes (VPS, Fly, Railway, a
container). A true edge tier later means swapping BullMQ for Cloudflare Queues; the
rest holds. Mind Upstash's free-tier daily command quota — BullMQ polls.

## Roadmap

The foundation is here — ingestion, lake, SDK, model loop, dataset packaging. Next,
in order of leverage toward Atlas:

- **Quality + labeling** — dedup beyond `eventId`, schema-drift detection, and
  human-in-the-loop annotation over the cold store (the Scale-style layer).
- **Query layer** — a catalog over the Parquet partitions (DuckDB/Athena-style) so
  analysts hit cold storage without a custom job.
- **Atlas finetuning harness** — consume `model_training` datasets directly into a
  training run, closing the loop from event to model.
