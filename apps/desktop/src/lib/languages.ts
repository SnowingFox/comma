/** Languages offered as chips in onboarding and Settings. Tags match the shared `LanguageTag`. */
export const LANGUAGES = [
  { tag: "en", name: "English", native: "English" },
  { tag: "zh", name: "Chinese", native: "中文" },
  { tag: "es", name: "Spanish", native: "Español" },
  { tag: "fr", name: "French", native: "Français" },
  { tag: "de", name: "German", native: "Deutsch" },
  { tag: "ja", name: "Japanese", native: "日本語" },
  { tag: "ko", name: "Korean", native: "한국어" },
  { tag: "pt", name: "Portuguese", native: "Português" },
  { tag: "it", name: "Italian", native: "Italiano" },
  { tag: "ru", name: "Russian", native: "Русский" },
  { tag: "ar", name: "Arabic", native: "العربية" },
  { tag: "hi", name: "Hindi", native: "हिन्दी" },
  { tag: "nl", name: "Dutch", native: "Nederlands" },
  { tag: "pl", name: "Polish", native: "Polski" },
  { tag: "tr", name: "Turkish", native: "Türkçe" },
  { tag: "vi", name: "Vietnamese", native: "Tiếng Việt" },
] as const;

export function languageName(tag: string): string {
  return LANGUAGES.find((l) => l.tag === tag)?.name ?? tag;
}

/** ElevenLabs reports ISO 639-3 (`eng`); show it by name when we know it. */
const THREE: Record<string, string> = {
  eng: "en", zho: "zh", cmn: "zh", yue: "zh", spa: "es", fra: "fr", deu: "de", jpn: "ja", kor: "ko", por: "pt",
  ita: "it", rus: "ru", ara: "ar", hin: "hi", nld: "nl", pol: "pl", tur: "tr", vie: "vi",
};

export function detectedLanguageName(code: string): string {
  if (!code) return "Unknown language";
  return languageName(THREE[code.toLowerCase()] ?? code.toLowerCase());
}
