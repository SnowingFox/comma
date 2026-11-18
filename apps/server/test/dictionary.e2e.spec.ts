import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { DictionaryImportResponse, DictionaryListResponse, DictionaryTermResponse } from '@comma/shared'
import { bearer, createTestApp, signUp, type TestApp } from './test-app'

describe('dictionary', () => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp()
  })
  afterAll(async () => {
    await t.close()
  })

  test('add, list, rename, delete; per user and case-insensitive unique', async () => {
    const auth = bearer((await signUp(t, 'dict@example.com')).access_token)
    const other = bearer((await signUp(t, 'dict-other@example.com')).access_token)
    const added = DictionaryTermResponse.parse((await t.http().post('/v1/dictionary').set(auth).send({ term: '  Comma   app ' }).expect(201)).body)
    expect(added.term.term).toBe('Comma app')
    expect((await t.http().post('/v1/dictionary').set(auth).send({ term: 'comma APP' }).expect(409)).body.code).toBe('term_exists')
    await t.http().post('/v1/dictionary').set(auth).send({ term: 'ElevenLabs' }).expect(201)
    await t.http().post('/v1/dictionary').set(other).send({ term: 'Comma app' }).expect(201)

    const list = DictionaryListResponse.parse((await t.http().get('/v1/dictionary').set(auth).expect(200)).body)
    expect(list.terms.map((term) => term.term)).toEqual(['Comma app', 'ElevenLabs'])

    const id = added.term.id
    expect((await t.http().patch(`/v1/dictionary/${id}`).set(auth).send({ term: 'elevenlabs' }).expect(409)).body.code).toBe('term_exists')
    const renamed = await t.http().patch(`/v1/dictionary/${id}`).set(auth).send({ term: 'Comma' }).expect(200)
    expect(renamed.body.term.term).toBe('Comma')
    await t.http().patch(`/v1/dictionary/${id}`).set(other).send({ term: 'Mine now' }).expect(404)
    await t.http().delete(`/v1/dictionary/${id}`).set(other).expect(404)
    await t.http().delete(`/v1/dictionary/${id}`).set(auth).expect(204)
    await t.http().delete(`/v1/dictionary/${id}`).set(auth).expect(404)
    await t.http().delete('/v1/dictionary/not-a-uuid').set(auth).expect(400)
  })

  test('rejects empty, overlong and delimiter-like terms', async () => {
    const auth = bearer((await signUp(t, 'dict-bad@example.com')).access_token)
    for (const term of ['   ', 'x'.repeat(101), 'a <b>', 'curly {x}']) {
      expect((await t.http().post('/v1/dictionary').set(auth).send({ term }).expect(400)).body.code).toBe('validation_failed')
    }
  })

  test('CSV import adds new terms, skips header, duplicates and invalid rows', async () => {
    const auth = bearer((await signUp(t, 'dict-csv@example.com')).access_token)
    await t.http().post('/v1/dictionary').set(auth).send({ term: 'Existing' }).expect(201)
    const csv = 'term,notes\r\nKubernetes,k8s\n"Smith, John",person\nexisting\nKubernetes\n\n"a ""quoted"" name"\nbad <term>\n'
    const result = DictionaryImportResponse.parse((await t.http().post('/v1/dictionary/import').set(auth).send({ csv }).expect(200)).body)
    expect(result.terms.map((term) => term.term)).toEqual(['Kubernetes', 'Smith, John', 'a "quoted" name'])
    expect(result).toMatchObject({ added: 3, skipped: 3 })
    const list = DictionaryListResponse.parse((await t.http().get('/v1/dictionary').set(auth).expect(200)).body)
    expect(list.terms).toHaveLength(4)
  })

  test('holds at most 1000 terms', async () => {
    const session = await signUp(t, 'dict-full@example.com')
    const auth = bearer(session.access_token)
    const csv = Array.from({ length: 1005 }, (_, i) => `term ${i}`).join('\n')
    const result = await t.http().post('/v1/dictionary/import').set(auth).send({ csv }).expect(200)
    expect(result.body).toMatchObject({ added: 1000, skipped: 5 })
    expect((await t.http().post('/v1/dictionary').set(auth).send({ term: 'one more' }).expect(409)).body.code).toBe('dictionary_full')
  })
})
