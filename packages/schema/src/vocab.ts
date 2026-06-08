import { z } from 'zod';
import type { SourceName } from './envelope.js';

/**
 * Per-source event vocabulary. Each entry validates the `data` payload for a
 * given source + event type. A registered type enforces its payload; an
 * unregistered type is allowed through (so new events aren't blocked before
 * they're modelled) but flagged `known: false` by validateEvent.
 *
 * The content rule is scope-gated and enforced in code (see validateEvent):
 *   - product_improvement  → metadata and counts only. Raw content is rejected.
 *   - model_training        → content allowed unless the user opted out. This
 *                             is the distributable Atlas corpus; the text IS
 *                             the signal.
 */
type SourceVocab = Record<string, z.ZodTypeAny>;

/**
 * The model loop. Lives inside the platforms that embed an AI (Nubia today).
 * `model` carries the model identity — 'heisenberg' now (a thin wrapper over
 * Gemini/DeepSeek), 'atlas' once the owned model is live — so a single corpus
 * spans the transition. conversationId + turnIndex let the dataset builder
 * reconstruct whole dialogues into long-context training sequences.
 *
 * `text` fields are optional and only populated under model_training; under
 * product_improvement they're rejected, so ops metrics (latency, tokens) can be
 * tracked internally while content stays out once a user opts out.
 */
export const aiEvents: SourceVocab = {
  'ai.queried': z.object({
    conversationId: z.string(),
    turnIndex: z.number().int().nonnegative(),
    model: z.string(),
    modelVersion: z.string().optional(),
    subject: z.string().optional(),
    language: z.string().optional(),
    inputMode: z.enum(['speech', 'typed']).optional(),
    queryChars: z.number().int().nonnegative().optional(),
    text: z.string().optional(), // content; model_training only
  }),
  'ai.responded': z.object({
    conversationId: z.string(),
    turnIndex: z.number().int().nonnegative(),
    model: z.string(),
    modelVersion: z.string().optional(),
    language: z.string().optional(),
    latencyMs: z.number().int().nonnegative().optional(),
    promptTokens: z.number().int().nonnegative().optional(),
    completionTokens: z.number().int().nonnegative().optional(),
    finishReason: z.string().optional(),
    text: z.string().optional(), // content; model_training only
  }),
  'ai.feedback': z.object({
    conversationId: z.string(),
    turnIndex: z.number().int().nonnegative().optional(),
    model: z.string().optional(),
    signal: z.enum(['thumbs_up', 'thumbs_down', 'regenerate', 'copied', 'followed_up', 'abandoned']),
    reward: z.number().min(-1).max(1).optional(),
    comment: z.string().optional(),
  }),
};

const nubia: SourceVocab = {
  'study_session.completed': z.object({
    subject: z.string(),
    durationSec: z.number().int().nonnegative(),
    score: z.number().min(0).max(1).optional(),
    cardsReviewed: z.number().int().nonnegative().optional(),
  }),
  'quiz.answered': z.object({
    quizId: z.string(),
    questionId: z.string(),
    correct: z.boolean(),
    latencyMs: z.number().int().nonnegative().optional(),
  }),
  'content.viewed': z.object({
    contentId: z.string(),
    contentType: z.string(),
    dwellMs: z.number().int().nonnegative().optional(),
  }),
  'search.performed': z.object({
    query: z.string(),
    resultCount: z.number().int().nonnegative(),
  }),
  'public_corpus.sentence_pair': z.object({
    sourceId: z.string(),
    sourceUrl: z.string().url(),
    license: z.string(),
    upstream: z.string().optional(),
    rowIndex: z.number().int().nonnegative(),
    languagePair: z.tuple([z.string(), z.string()]),
    en: z.string(),
    tn: z.string(),
  }),
  ...aiEvents, // the AI inside Nubia
};

const nimbus: SourceVocab = {
  'listing.viewed': z.object({
    listingId: z.string(),
    priceBwp: z.number().nonnegative().optional(),
  }),
  'listing.searched': z.object({
    query: z.string().optional(),
    filters: z.record(z.string(), z.unknown()).optional(),
    resultCount: z.number().int().nonnegative(),
  }),
  'message.sent': z.object({
    threadId: z.string(),
    length: z.number().int().nonnegative().optional(),
  }),
  'booking.requested': z.object({
    listingId: z.string(),
    moveInDate: z.string().optional(),
  }),
};

const monolith: SourceVocab = {
  'quote.requested': z.object({
    service: z.string(),
    budgetBand: z.string().optional(),
  }),
  'page.viewed': z.object({
    path: z.string(),
    referrer: z.string().optional(),
  }),
  'demo.interacted': z.object({
    demo: z.string(),
    step: z.string().optional(),
  }),
};

const primedrive: SourceVocab = {
  'trip.completed': z.object({
    tripId: z.string(),
    distanceKm: z.number().nonnegative().optional(),
    durationSec: z.number().int().nonnegative().optional(),
  }),
  'route.searched': z.object({
    origin: z.string().optional(),
    destination: z.string().optional(),
  }),
  'listing.viewed': z.object({
    listingId: z.string(),
    priceBwp: z.number().nonnegative().optional(),
  }),
};

const prototype: SourceVocab = {
  'map.viewed': z.object({
    center: z.tuple([z.number(), z.number()]).optional(),
    zoom: z.number().optional(),
  }),
  'location.searched': z.object({
    query: z.string(),
    resultCount: z.number().int().nonnegative(),
  }),
  'place.corrected': z.object({
    placeId: z.string(),
    field: z.string(),
  }),
};

export const VOCAB: Record<SourceName, SourceVocab> = {
  nubia,
  nimbus,
  monolith,
  primedrive,
  prototype,
};

export function lookupPayloadSchema(source: SourceName, type: string): z.ZodTypeAny | null {
  return VOCAB[source]?.[type] ?? null;
}
