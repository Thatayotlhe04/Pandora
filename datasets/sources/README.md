# Public Language Data Sources

Pandora can ingest public African-language data only when a source manifest
records license, provenance, intended use, and attribution requirements. The
current registry is `african-open-corpora.json`.

## Import Posture

The importer is deliberately conservative:

- `approved` + `approvedForModelTraining: true` + `adapter: "hf_rows"` flows into
  Pandora with `scope: "model_training"`.
- `candidate_review`, `share_alike_review`, `evaluation_only`, and `restricted`
  stay visible in the registry but are not imported by default.
- Non-commercial, no-derivatives, unknown, gated use-restricted, or
  evaluation-only sources must not enter saleable/distributable Atlas cuts.

## Commands

List every catalogued source and its posture:

```bash
node scripts/import-public-corpus.mjs --list
```

Dry-run all importable sources with two rows per source:

```bash
node scripts/import-public-corpus.mjs --all --limit-per-source 2
```

Dry-run one source:

```bash
node scripts/import-public-corpus.mjs \
  --source-id hf-michsethowusu-english-setswana-mt560 \
  --limit 5
```

Live ingest, after a Pandora key is minted for the target source:

```bash
node scripts/import-public-corpus.mjs --all --live \
  --endpoint https://pandora.example \
  --key pk_nubia_xxx \
  --secret "$PANDORA_SECRET" \
  --source nubia \
  --limit-per-source 1000
```

Refresh Hugging Face discovery candidates:

```bash
node scripts/discover-hf-corpora.mjs --limit 30
```

## Currently Importable

- English-Setswana OPUS MT560 mirror, CC BY 4.0.
- AfriSenti Classification slices for Hausa, Yoruba, Swahili, and Kinyarwanda,
  CC BY 4.0.
- Swahili News classification corpus, CC BY 4.0.
- NCHLT Setswana and Sepedi speech transcript slices, CC BY 3.0.
- Xhosa and Yoruba speech transcript slices, CC BY 3.0 / CC BY 4.0.
- Igbo-English translation corpus, Apache 2.0.
- African UltraChat, MIT.

## Important Holds

- Common Voice is CC0, but the active download flow now lives on Mozilla Data
  Collective; mirror a release with version metadata before importing.
- African Next Voices is CC BY 4.0, but it is gated and explicitly restricted
  against TTS/voice cloning/voice synthesis. Use for ASR only after review.
- FLORES+ is CC BY-SA 4.0 and useful for evaluation, but its dataset card says
  it should not be used as training data.
- Wikimedia dumps and Tatoeba can be useful, but attribution and share-alike
  obligations must travel with any derivative dataset.
- MasakhaNER is non-commercial; keep it out of external/saleable Pandora cuts.
- DSFSI Setswana Sentiment is currently held because the live dataset card shows
  NOODL/other despite older metadata indicating CC BY.

## Rules

1. Mirror or fork approved datasets before high-volume ingestion.
2. Keep attribution metadata with every imported row.
3. Mark public-corpus rows separately from platform-user events.
4. Build distributable cuts only from rows whose source license allows that use.
5. If a license is unclear, non-commercial, no-derivatives, share-alike, gated,
   or evaluation-only, hold it out until reviewed.
