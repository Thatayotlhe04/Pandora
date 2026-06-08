# Pandora African-Language Data Acquisition

Pandora's public-corpus path is for data that is already licensed for reuse and
has preserved provenance. It is separate from platform-user data, even though it
uses the same signed ingestion API and `model_training` scope.

## Pipeline

1. Discover public sources with `scripts/discover-hf-corpora.mjs`.
2. Add approved sources to `datasets/sources/african-open-corpora.json`.
3. Dry-run import events and inspect payload shape.
4. Mirror/fork high-value datasets before high-volume ingestion.
5. Live-ingest approved rows through `/ingest/batch`.
6. Build versioned dataset cuts with `services/datasets`.

```bash
node scripts/discover-hf-corpora.mjs --limit 30
node scripts/import-public-corpus.mjs --all --limit-per-source 2
node scripts/import-public-corpus.mjs --all --live \
  --endpoint https://pandora.example \
  --key pk_nubia_xxx \
  --secret "$PANDORA_SECRET" \
  --source nubia \
  --limit-per-source 1000
```

## Current Approved Lanes

The registry currently imports text or transcript rows from permissive sources:

- Setswana-English parallel text.
- Hausa, Yoruba, Swahili, and Kinyarwanda sentiment rows.
- Swahili news classification.
- Setswana, Sepedi, Xhosa, and Yoruba ASR transcript slices.
- Igbo-English translation.
- African UltraChat instruction-dialogue rows.

## Review Lanes

These should be pursued next, but not silently imported:

- Common Voice: CC0, but mirror the current Data Collective release first.
- African Next Voices: very valuable Setswana/Zulu/Xhosa/Sesotho/etc. speech,
  but gated and ASR-only with no TTS/voice synthesis usage.
- Wikimedia/Tatoeba/African Storybook: valuable public text, but attribution,
  share-alike, and per-item license metadata must be preserved.
- OPUS: approve subcorpora one by one; OPUS itself is a catalogue of mixed
  upstream licenses.

## Dataset Card Requirements

Every downstream Pandora dataset cut should include:

- registry source ids and upstream URLs,
- license and attribution text,
- import timestamp/range,
- event counts by source/language/task,
- exclusion statement for restricted/evaluation-only sources,
- transformation summary,
- opt-out basis for platform-user rows, if mixed with platform data.
