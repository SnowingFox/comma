// ElevenLabs reports the detected language as ISO 639-3 ("zho", "eng"); users pick tags such as "zh-Hans" or "en".
// Both are reduced to ISO 639-1 for the retry rule. A code missing from the table never counts as preferred.

const THREE_TO_TWO: Record<string, string> = {
  zho: 'zh', cmn: 'zh', yue: 'zh', wuu: 'zh',
  eng: 'en', spa: 'es', hin: 'hi', ara: 'ar', por: 'pt', rus: 'ru', jpn: 'ja', deu: 'de', fra: 'fr', kor: 'ko',
  ita: 'it', tur: 'tr', vie: 'vi', ind: 'id', pol: 'pl', nld: 'nl', tha: 'th', ukr: 'uk', swe: 'sv', ces: 'cs',
  ell: 'el', heb: 'he', ron: 'ro', hun: 'hu', dan: 'da', fin: 'fi', nor: 'no', nob: 'no', nno: 'no', bul: 'bg',
  hrv: 'hr', slk: 'sk', cat: 'ca', msa: 'ms', zlm: 'ms', fil: 'tl', tgl: 'tl', ben: 'bn', tam: 'ta', urd: 'ur',
  fas: 'fa', pes: 'fa', srp: 'sr', slv: 'sl', lit: 'lt', lav: 'lv', est: 'et'
}

const TWO = new Set(Object.values(THREE_TO_TWO))

/** "zho", "zh", "zh-Hans" and "ZH_tw" all give "zh"; undefined when the code is not recognised. */
export function toIso1(code: string | undefined): string | undefined {
  const base = (code ?? '').trim().toLowerCase().split(/[-_]/, 1)[0] ?? ''
  if (base.length === 2) return TWO.has(base) ? base : undefined
  if (base.length === 3) return THREE_TO_TWO[base]
  return undefined
}

/** The user's languages as ISO 639-1, deduplicated, unknown entries dropped, order kept. */
export function normalizeLanguages(list: readonly string[] | undefined): string[] {
  const out: string[] = []
  for (const raw of list ?? []) {
    const code = toIso1(raw)
    if (code && !out.includes(code)) out.push(code)
  }
  return out
}

/** Below this `language_probability` the detection is not trusted. */
export const MIN_LANGUAGE_PROBABILITY = 0.5

/** "fr" -> "French", for the translate prompt. */
export function languageName(tag: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) ?? tag
  } catch {
    return tag
  }
}
