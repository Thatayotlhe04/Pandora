# Public Language Data Sources

Pandora can ingest public language data only after a source manifest records the
license, provenance, intended use, and attribution requirements. Do not mix public
corpora into the live event lake without a manifest; downstream dataset builds
must be able to prove where every row came from.

## Approved Candidate Sources

### Setswana parallel text

- Source: `michsethowusu/english-setswana_sentence-pairs_mt560`
- URL: `https://huggingface.co/datasets/michsethowusu/english-setswana_sentence-pairs_mt560`
- License: CC BY 4.0
- Use: translation examples, multilingual instruction tuning, Setswana/English
  alignment for Heisenberg/Atlas.
- Import posture: approved candidate. Fork or mirror the dataset in a controlled
  data bucket before funneling records into Pandora.

### Setswana sentiment

- Source: `dsfsi/setswana-sentiment`
- URL: `https://huggingface.co/datasets/dsfsi/setswana-sentiment`
- License: CC BY 4.0
- Use: sentiment/classification evaluation and lightweight Setswana benchmark
  data.
- Import posture: approved candidate. Preserve the dataset citation and
  annotator/provenance metadata.

## Import Rules

1. Mirror or fork the dataset first; never depend on a mutable remote as the only
   source of truth.
2. Keep attribution metadata with every import batch.
3. Mark public-corpus rows separately from platform-user events.
4. Build distributable cuts only from rows whose source license allows that use.
5. If a license is unclear, non-commercial, or no-derivatives, hold it out of
   saleable datasets until reviewed.
