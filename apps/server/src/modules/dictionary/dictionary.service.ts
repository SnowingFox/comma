import { HttpStatus, Injectable } from '@nestjs/common'
import { InjectDrizzle } from '@nestjs/drizzle'
import { type DictionaryImportResponse, type DictionaryTerm, DictionaryTermText, MAX_DICTIONARY_TERMS } from '@comma/shared'
import { and, asc, count, eq } from 'drizzle-orm'
import { type DictionaryTermRow, dictionaryTerms } from '@/entity'
import { ApiException } from '@/filter/api-error.filter'
import type { Database } from '@/utils/database'
import { termsFromCsv } from './internal/csv'

function present(row: DictionaryTermRow): DictionaryTerm {
  return { id: row.id, term: row.term, created_at: row.createdAt.toISOString() }
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } })?.code ?? (error as { cause?: { code?: string } })?.cause?.code
  return code === '23505'
}

const exists = () => new ApiException(HttpStatus.CONFLICT, 'term_exists', 'That term is already in the dictionary')
const notFound = () => new ApiException(HttpStatus.NOT_FOUND, 'not_found', 'Term not found')

@Injectable()
export class DictionaryService {
  @InjectDrizzle()
  private readonly db: Database

  async list(userId: string): Promise<DictionaryTerm[]> {
    const rows = await this.db.query.dictionaryTerms.findMany({
      where: eq(dictionaryTerms.userId, userId),
      orderBy: [asc(dictionaryTerms.createdAt), asc(dictionaryTerms.id)]
    })
    return rows.map(present)
  }

  /** The terms alone, for keyterms and the prompt. */
  async terms(userId: string): Promise<string[]> {
    return (await this.list(userId)).map((row) => row.term)
  }

  async add(userId: string, term: string): Promise<DictionaryTerm> {
    if ((await this.count(userId)) >= MAX_DICTIONARY_TERMS) {
      throw new ApiException(HttpStatus.CONFLICT, 'dictionary_full', `The dictionary holds at most ${MAX_DICTIONARY_TERMS} terms`)
    }
    const [row] = await this.db.insert(dictionaryTerms).values({ userId, term }).onConflictDoNothing().returning()
    if (!row) throw exists()
    return present(row)
  }

  async update(userId: string, id: string, term: string): Promise<DictionaryTerm> {
    let row: DictionaryTermRow | undefined
    try {
      ;[row] = await this.db
        .update(dictionaryTerms)
        .set({ term })
        .where(and(eq(dictionaryTerms.id, id), eq(dictionaryTerms.userId, userId)))
        .returning()
    } catch (error) {
      if (isUniqueViolation(error)) throw exists()
      throw error
    }
    if (!row) throw notFound()
    return present(row)
  }

  async remove(userId: string, id: string): Promise<void> {
    const deleted = await this.db
      .delete(dictionaryTerms)
      .where(and(eq(dictionaryTerms.id, id), eq(dictionaryTerms.userId, userId)))
      .returning({ id: dictionaryTerms.id })
    if (deleted.length === 0) throw notFound()
  }

  /** Valid, new terms are added up to the limit; everything else is counted as skipped. */
  async import(userId: string, csv: string): Promise<DictionaryImportResponse> {
    const rows = termsFromCsv(csv)
    const seen = new Set<string>()
    const candidates: string[] = []
    for (const raw of rows) {
      const parsed = DictionaryTermText.safeParse(raw)
      if (!parsed.success || seen.has(parsed.data.toLowerCase())) continue
      seen.add(parsed.data.toLowerCase())
      candidates.push(parsed.data)
    }
    const room = Math.max(0, MAX_DICTIONARY_TERMS - (await this.count(userId)))
    const inserted =
      candidates.length && room
        ? await this.db
            .insert(dictionaryTerms)
            .values(candidates.slice(0, room).map((term) => ({ userId, term })))
            .onConflictDoNothing()
            .returning()
        : []
    return { added: inserted.length, skipped: rows.length - inserted.length, terms: inserted.map(present) }
  }

  private async count(userId: string): Promise<number> {
    const [row] = await this.db.select({ value: count() }).from(dictionaryTerms).where(eq(dictionaryTerms.userId, userId))
    return row?.value ?? 0
  }
}
