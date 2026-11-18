import { z } from 'zod'

/** Per user; also the ElevenLabs keyterm limit. */
export const MAX_DICTIONARY_TERMS = 1000

/**
 * One name or term. Terms longer than 50 characters or 5 words still reach the LLM prompt but are not sent to
 * speech to text as keyterms (the provider's limits).
 */
export const DictionaryTermText = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1).max(100).regex(/^[^<>{}[\]\\]*$/, 'must not contain < > { } [ ] or \\'))

export const DictionaryTerm = z.object({
  id: z.uuid(),
  term: z.string(),
  /** ISO 8601. */
  created_at: z.iso.datetime()
})
export type DictionaryTerm = z.infer<typeof DictionaryTerm>

/** `GET /v1/dictionary`, oldest first. */
export const DictionaryListResponse = z.object({ terms: z.array(DictionaryTerm) })
export type DictionaryListResponse = z.infer<typeof DictionaryListResponse>

/** `POST /v1/dictionary` -> 201 {@link DictionaryTermResponse}; `PATCH /v1/dictionary/:id` -> 200. 409 `term_exists`, `dictionary_full`. */
export const DictionaryTermRequest = z.object({ term: DictionaryTermText }).strict()
export type DictionaryTermRequest = z.infer<typeof DictionaryTermRequest>

export const DictionaryTermResponse = z.object({ term: DictionaryTerm })
export type DictionaryTermResponse = z.infer<typeof DictionaryTermResponse>

/** `PATCH|DELETE /v1/dictionary/:id`. */
export const DictionaryTermIdParam = z.uuid()
export type DictionaryTermIdParam = z.infer<typeof DictionaryTermIdParam>

/**
 * `POST /v1/dictionary/import` -> 200 {@link DictionaryImportResponse}. CSV text: the first column of each row is
 * a term; a first row of `term` is a header. Existing terms (case-insensitive) and invalid ones are skipped.
 */
export const DictionaryImportRequest = z.object({ csv: z.string().max(200_000) }).strict()
export type DictionaryImportRequest = z.infer<typeof DictionaryImportRequest>

export const DictionaryImportResponse = z.object({
  added: z.number().int().nonnegative(),
  /** Duplicates, invalid rows, and rows over {@link MAX_DICTIONARY_TERMS}. */
  skipped: z.number().int().nonnegative(),
  terms: z.array(DictionaryTerm)
})
export type DictionaryImportResponse = z.infer<typeof DictionaryImportResponse>
