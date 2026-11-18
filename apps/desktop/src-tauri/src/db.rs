//! Local history, usage and the Local-mode dictionary in SQLite (spec 3.2). One file in the app
//! data dir; kept audio (only with "Keep audio" on) sits next to it in `audio/<run id>.wav`.
//!
//! Day boundaries use the Mac's local time zone through SQLite's `localtime` modifier.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult, ErrorCode};

pub const FILE_NAME: &str = "comma.db";
/// Matches the server's `MAX_DICTIONARY_TERMS`.
pub const MAX_TERMS: usize = 1000;
pub const MAX_TERM_CHARS: usize = 100;

const SCHEMA_VERSION: i64 = 1;

const MIGRATION_1: &str = "
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  mode TEXT NOT NULL,
  provider TEXT NOT NULL,
  app TEXT,
  raw_text TEXT NOT NULL DEFAULT '',
  refined_text TEXT NOT NULL DEFAULT '',
  language TEXT,
  model TEXT,
  audio_secs REAL NOT NULL DEFAULT 0,
  stt_ms REAL,
  llm_ttft_ms REAL,
  llm_total_ms REAL,
  total_ms REAL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  stt_cost_usd REAL,
  words INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL,
  error TEXT,
  output TEXT,
  audio_path TEXT
);
CREATE INDEX runs_ts ON runs (ts);
CREATE TABLE dictionary (
  id TEXT PRIMARY KEY,
  term TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX dictionary_term ON dictionary (lower(term));
";

/// One row of `runs`. Times in milliseconds; `ts` is Unix ms.
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
pub struct RunRecord {
    pub id: String,
    pub ts: i64,
    pub mode: String,
    pub provider: String,
    pub app: Option<String>,
    pub raw_text: String,
    pub refined_text: String,
    pub language: Option<String>,
    pub model: Option<String>,
    pub audio_secs: f64,
    pub stt_ms: Option<f64>,
    pub llm_ttft_ms: Option<f64>,
    pub llm_total_ms: Option<f64>,
    pub total_ms: Option<f64>,
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub stt_cost_usd: Option<f64>,
    pub words: i64,
    pub ok: bool,
    pub error: Option<String>,
    pub output: Option<String>,
    pub has_audio: bool,
    #[serde(skip)]
    pub audio_path: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunsQuery {
    pub search: Option<String>,
    pub before: Option<i64>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum UsageRange {
    #[serde(rename = "today")]
    Today,
    #[serde(rename = "7d")]
    Week,
    #[serde(rename = "30d")]
    Month,
    #[serde(rename = "90d")]
    Quarter,
}

impl UsageRange {
    pub fn days(self) -> i64 {
        match self {
            UsageRange::Today => 1,
            UsageRange::Week => 7,
            UsageRange::Month => 30,
            UsageRange::Quarter => 90,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct UsageTotals {
    pub runs: i64,
    pub errors: i64,
    pub words: i64,
    pub audio_secs: f64,
    pub stt_cost_usd: f64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Keyed {
    pub key: String,
    #[serde(flatten)]
    pub totals: UsageTotals,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Day {
    pub date: String,
    #[serde(flatten)]
    pub totals: UsageTotals,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
pub struct Percentiles {
    pub p50: Option<f64>,
    pub p95: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Stages {
    pub stt: Percentiles,
    pub llm_ttft: Percentiles,
    pub llm_total: Percentiles,
    pub total: Percentiles,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UsageSummary {
    pub range: UsageRange,
    pub totals: UsageTotals,
    pub by_mode: Vec<Keyed>,
    pub by_model: Vec<Keyed>,
    pub by_app: Vec<Keyed>,
    pub stages: Stages,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Term {
    pub id: String,
    pub term: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ImportResult {
    pub added: usize,
    pub skipped: usize,
}

fn db_err(err: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::Io, format!("history database: {err}"))
}

/// Words for "time saved": whitespace-separated tokens, with each CJK character counted as one.
pub fn count_words(text: &str) -> i64 {
    let cjk = |c: char| matches!(c as u32, 0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xAC00..=0xD7AF | 0xF900..=0xFAFF);
    text.split_whitespace()
        .map(|token| {
            let ideographs = token.chars().filter(|&c| cjk(c)).count() as i64;
            let rest = token.split(cjk).filter(|s| s.chars().any(char::is_alphanumeric)).count() as i64;
            ideographs + rest
        })
        .sum()
}

/// Trims, folds inner whitespace, and checks a term like the server's `DictionaryTermText`.
pub fn clean_term(raw: &str) -> AppResult<String> {
    let term = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if term.is_empty() || term.chars().count() > MAX_TERM_CHARS {
        return Err(AppError::invalid("A term is 1 to 100 characters"));
    }
    if term.chars().any(|c| matches!(c, '<' | '>' | '{' | '}' | '[' | ']' | '\\')) {
        return Err(AppError::invalid("A term must not contain < > { } [ ] or \\"));
    }
    Ok(term)
}

/// The first column of each CSV row, unquoted; a `term` header and blank rows are dropped.
pub fn csv_terms(csv: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (i, line) in csv.lines().enumerate() {
        let line = line.trim_start_matches('\u{feff}');
        let first = if let Some(rest) = line.trim_start().strip_prefix('"') {
            let mut cell = String::new();
            let mut chars = rest.chars().peekable();
            while let Some(c) = chars.next() {
                if c == '"' {
                    if chars.peek() == Some(&'"') {
                        cell.push('"');
                        chars.next();
                    } else {
                        break;
                    }
                } else {
                    cell.push(c);
                }
            }
            cell
        } else {
            line.split([',', ';', '\t']).next().unwrap_or_default().to_owned()
        };
        let first = first.trim();
        if first.is_empty() || (i == 0 && first.eq_ignore_ascii_case("term")) {
            continue;
        }
        out.push(first.to_owned());
    }
    out
}

fn csv_cell(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

/// Nearest-rank percentile of sorted values.
fn percentile(sorted: &[f64], p: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    Some(sorted[rank.clamp(1, sorted.len()) - 1])
}

pub struct Db {
    conn: Mutex<Connection>,
    audio_dir: PathBuf,
}

const RUN_COLUMNS: &str = "id, ts, mode, provider, app, raw_text, refined_text, language, model, audio_secs, stt_ms, \
     llm_ttft_ms, llm_total_ms, total_ms, prompt_tokens, completion_tokens, stt_cost_usd, words, ok, error, output, audio_path";

fn run_from_row(row: &Row<'_>) -> rusqlite::Result<RunRecord> {
    let audio_path: Option<String> = row.get(21)?;
    Ok(RunRecord {
        id: row.get(0)?,
        ts: row.get(1)?,
        mode: row.get(2)?,
        provider: row.get(3)?,
        app: row.get(4)?,
        raw_text: row.get(5)?,
        refined_text: row.get(6)?,
        language: row.get(7)?,
        model: row.get(8)?,
        audio_secs: row.get(9)?,
        stt_ms: row.get(10)?,
        llm_ttft_ms: row.get(11)?,
        llm_total_ms: row.get(12)?,
        total_ms: row.get(13)?,
        prompt_tokens: row.get(14)?,
        completion_tokens: row.get(15)?,
        stt_cost_usd: row.get(16)?,
        words: row.get(17)?,
        ok: row.get(18)?,
        error: row.get(19)?,
        output: row.get(20)?,
        has_audio: audio_path.is_some(),
        audio_path,
    })
}

/// `strftime` modifiers for the start of the local day `days - 1` days before `now_ms`.
const RANGE_START: &str =
    "CAST(strftime('%s', ?1 / 1000, 'unixepoch', 'localtime', 'start of day', ?2, 'utc') AS INTEGER) * 1000";

impl Db {
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path).map_err(db_err)?;
        let audio_dir = path.parent().unwrap_or(Path::new(".")).join("audio");
        Self::init(conn, audio_dir)
    }

    #[cfg(test)]
    pub fn in_memory(audio_dir: PathBuf) -> AppResult<Self> {
        Self::init(Connection::open_in_memory().map_err(db_err)?, audio_dir)
    }

    fn init(conn: Connection, audio_dir: PathBuf) -> AppResult<Self> {
        conn.pragma_update(None, "journal_mode", "WAL").map_err(db_err)?;
        conn.pragma_update(None, "foreign_keys", "ON").map_err(db_err)?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(db_err)?;
        if version > SCHEMA_VERSION {
            return Err(AppError::new(ErrorCode::Io, "The history database is from a newer Comma"));
        }
        if version < 1 {
            conn.execute_batch(&format!("BEGIN; {MIGRATION_1} PRAGMA user_version = 1; COMMIT;")).map_err(db_err)?;
        }
        Ok(Self { conn: Mutex::new(conn), audio_dir })
    }

    fn conn(&self) -> AppResult<MutexGuard<'_, Connection>> {
        self.conn.lock().map_err(|_| AppError::internal("database lock poisoned"))
    }

    #[cfg(test)]
    pub fn audio_dir(&self) -> &Path {
        &self.audio_dir
    }

    // ---- runs -----------------------------------------------------------------------------------

    /// Inserts a run; `audio` (bytes and file extension) is written next to the database when
    /// given (Keep audio).
    pub fn insert_run(&self, run: &RunRecord, audio: Option<(&[u8], &str)>) -> AppResult<()> {
        let audio_path = match audio {
            Some((bytes, ext)) => {
                std::fs::create_dir_all(&self.audio_dir)?;
                let ext = if ext == "ogg" { "ogg" } else { "wav" };
                let path = self.audio_dir.join(format!("{}.{ext}", run.id));
                std::fs::write(&path, bytes)?;
                Some(path.to_string_lossy().into_owned())
            }
            None => None,
        };
        self.conn()?
            .execute(
                &format!("INSERT INTO runs ({RUN_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)"),
                params![
                    run.id, run.ts, run.mode, run.provider, run.app, run.raw_text, run.refined_text, run.language, run.model,
                    run.audio_secs, run.stt_ms, run.llm_ttft_ms, run.llm_total_ms, run.total_ms, run.prompt_tokens,
                    run.completion_tokens, run.stt_cost_usd, run.words, run.ok, run.error, run.output, audio_path
                ],
            )
            .map_err(db_err)?;
        Ok(())
    }

    pub fn list_runs(&self, q: &RunsQuery) -> AppResult<Vec<RunRecord>> {
        let mut sql = format!("SELECT {RUN_COLUMNS} FROM runs WHERE 1 = 1");
        let mut args: Vec<rusqlite::types::Value> = Vec::new();
        if let Some(search) = q.search.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let escaped = search.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
            sql.push_str(" AND (raw_text LIKE ? ESCAPE '\\' OR refined_text LIKE ? ESCAPE '\\' OR app LIKE ? ESCAPE '\\')");
            let pattern = format!("%{escaped}%");
            args.extend([pattern.clone().into(), pattern.clone().into(), pattern.into()]);
        }
        if let Some(before) = q.before {
            sql.push_str(" AND ts < ?");
            args.push(before.into());
        }
        sql.push_str(" ORDER BY ts DESC LIMIT ?");
        args.push(i64::from(q.limit.unwrap_or(100).clamp(1, 500)).into());
        let conn = self.conn()?;
        let mut stmt = conn.prepare(&sql).map_err(db_err)?;
        let rows = stmt.query_map(params_from_iter(args), run_from_row).map_err(db_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
    }

    pub fn get_run(&self, id: &str) -> AppResult<RunRecord> {
        self.conn()?
            .query_row(&format!("SELECT {RUN_COLUMNS} FROM runs WHERE id = ?1"), [id], run_from_row)
            .optional()
            .map_err(db_err)?
            .ok_or_else(|| AppError::invalid("That run is no longer in your history"))
    }

    pub fn last_ok_run(&self) -> AppResult<Option<RunRecord>> {
        self.conn()?
            .query_row(&format!("SELECT {RUN_COLUMNS} FROM runs WHERE ok = 1 ORDER BY ts DESC LIMIT 1"), [], run_from_row)
            .optional()
            .map_err(db_err)
    }

    /// After a rerun of the rewrite.
    pub fn update_rewrite(&self, id: &str, refined: &str, model: &str, ttft_ms: Option<f64>, total_ms: f64, tokens: (Option<i64>, Option<i64>)) -> AppResult<RunRecord> {
        let changed = self
            .conn()?
            .execute(
                "UPDATE runs SET refined_text = ?2, model = ?3, llm_ttft_ms = ?4, llm_total_ms = ?5, prompt_tokens = ?6, \
                 completion_tokens = ?7, words = ?8, ok = 1, error = NULL WHERE id = ?1",
                params![id, refined, model, ttft_ms, total_ms, tokens.0, tokens.1, count_words(refined)],
            )
            .map_err(db_err)?;
        if changed == 0 {
            return Err(AppError::invalid("That run is no longer in your history"));
        }
        self.get_run(id)
    }

    fn remove_audio(paths: impl IntoIterator<Item = String>) {
        for path in paths {
            let _ = std::fs::remove_file(path);
        }
    }

    pub fn delete_run(&self, id: &str) -> AppResult<()> {
        let conn = self.conn()?;
        let path: Option<Option<String>> =
            conn.query_row("SELECT audio_path FROM runs WHERE id = ?1", [id], |r| r.get(0)).optional().map_err(db_err)?;
        conn.execute("DELETE FROM runs WHERE id = ?1", [id]).map_err(db_err)?;
        Self::remove_audio(path.flatten());
        Ok(())
    }

    pub fn clear_runs(&self) -> AppResult<()> {
        let conn = self.conn()?;
        conn.execute("DELETE FROM runs", []).map_err(db_err)?;
        drop(conn);
        if self.audio_dir.exists() {
            for entry in std::fs::read_dir(&self.audio_dir)?.flatten() {
                if entry.path().extension().is_some_and(|e| e == "wav" || e == "ogg") {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        Ok(())
    }

    /// Deletes runs older than `days` (0 keeps everything). Returns how many went.
    pub fn prune(&self, days: u32, now_ms: i64) -> AppResult<usize> {
        if days == 0 {
            return Ok(0);
        }
        let cutoff = now_ms - i64::from(days) * 86_400_000;
        let conn = self.conn()?;
        let mut stmt = conn.prepare("SELECT audio_path FROM runs WHERE ts < ?1 AND audio_path IS NOT NULL").map_err(db_err)?;
        let paths = stmt.query_map([cutoff], |r| r.get::<_, String>(0)).map_err(db_err)?.flatten().collect::<Vec<_>>();
        drop(stmt);
        let n = conn.execute("DELETE FROM runs WHERE ts < ?1", [cutoff]).map_err(db_err)?;
        Self::remove_audio(paths);
        Ok(n)
    }

    /// Kept audio of a run.
    pub fn run_audio(&self, id: &str) -> AppResult<Vec<u8>> {
        let run = self.get_run(id)?;
        let path = run.audio_path.ok_or_else(|| AppError::invalid("No audio was kept for this run"))?;
        Ok(std::fs::read(path)?)
    }

    /// How many successful dictations had at least `min_secs` of audio (for the hands-free hint).
    pub fn long_dictations(&self, min_secs: f64) -> AppResult<i64> {
        self.conn()?
            .query_row("SELECT count(*) FROM runs WHERE ok = 1 AND mode = 'dictate' AND audio_secs >= ?1", [min_secs], |r| r.get(0))
            .map_err(db_err)
    }

    // ---- usage ----------------------------------------------------------------------------------

    fn range_start(&self, conn: &Connection, range: UsageRange, now_ms: i64) -> AppResult<i64> {
        conn.query_row(&format!("SELECT {RANGE_START}"), params![now_ms, format!("-{} days", range.days() - 1)], |r| r.get(0))
            .map_err(db_err)
    }

    const TOTALS: &'static str = "count(*) FILTER (WHERE ok = 1), count(*) FILTER (WHERE ok = 0), \
        coalesce(sum(words) FILTER (WHERE ok = 1), 0), coalesce(sum(audio_secs) FILTER (WHERE ok = 1), 0), \
        coalesce(sum(stt_cost_usd) FILTER (WHERE ok = 1), 0), coalesce(sum(prompt_tokens) FILTER (WHERE ok = 1), 0), \
        coalesce(sum(completion_tokens) FILTER (WHERE ok = 1), 0)";

    fn totals_from(row: &Row<'_>, offset: usize) -> rusqlite::Result<UsageTotals> {
        Ok(UsageTotals {
            runs: row.get(offset)?,
            errors: row.get(offset + 1)?,
            words: row.get(offset + 2)?,
            audio_secs: row.get(offset + 3)?,
            stt_cost_usd: row.get(offset + 4)?,
            prompt_tokens: row.get(offset + 5)?,
            completion_tokens: row.get(offset + 6)?,
        })
    }

    fn breakdown(conn: &Connection, column: &str, start: i64) -> AppResult<Vec<Keyed>> {
        let sql = format!(
            "SELECT coalesce({column}, ''), {} FROM runs WHERE ts >= ?1 GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 50",
            Self::TOTALS
        );
        let mut stmt = conn.prepare(&sql).map_err(db_err)?;
        let rows = stmt
            .query_map([start], |row| Ok(Keyed { key: row.get(0)?, totals: Self::totals_from(row, 1)? }))
            .map_err(db_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
    }

    fn stage(conn: &Connection, column: &str, start: i64) -> AppResult<Percentiles> {
        let sql = format!("SELECT {column} FROM runs WHERE ts >= ?1 AND ok = 1 AND {column} IS NOT NULL ORDER BY 1");
        let mut stmt = conn.prepare(&sql).map_err(db_err)?;
        let values = stmt.query_map([start], |r| r.get::<_, f64>(0)).map_err(db_err)?.collect::<Result<Vec<_>, _>>().map_err(db_err)?;
        Ok(Percentiles { p50: percentile(&values, 50.0), p95: percentile(&values, 95.0) })
    }

    pub fn usage_summary(&self, range: UsageRange, now_ms: i64) -> AppResult<UsageSummary> {
        let conn = self.conn()?;
        let start = self.range_start(&conn, range, now_ms)?;
        let totals = conn
            .query_row(&format!("SELECT {} FROM runs WHERE ts >= ?1", Self::TOTALS), [start], |r| Self::totals_from(r, 0))
            .map_err(db_err)?;
        Ok(UsageSummary {
            range,
            totals,
            by_mode: Self::breakdown(&conn, "mode", start)?,
            by_model: Self::breakdown(&conn, "model", start)?,
            by_app: Self::breakdown(&conn, "app", start)?,
            stages: Stages {
                stt: Self::stage(&conn, "stt_ms", start)?,
                llm_ttft: Self::stage(&conn, "llm_ttft_ms", start)?,
                llm_total: Self::stage(&conn, "llm_total_ms", start)?,
                total: Self::stage(&conn, "total_ms", start)?,
            },
        })
    }

    pub fn usage_daily(&self, range: UsageRange, now_ms: i64) -> AppResult<Vec<Day>> {
        let conn = self.conn()?;
        let start = self.range_start(&conn, range, now_ms)?;
        let sql = format!(
            "SELECT date(ts / 1000, 'unixepoch', 'localtime'), {} FROM runs WHERE ts >= ?1 GROUP BY 1",
            Self::TOTALS
        );
        let mut stmt = conn.prepare(&sql).map_err(db_err)?;
        let found = stmt
            .query_map([start], |row| Ok((row.get::<_, String>(0)?, Self::totals_from(row, 1)?)))
            .map_err(db_err)?
            .collect::<Result<std::collections::HashMap<_, _>, _>>()
            .map_err(db_err)?;
        let mut days = Vec::new();
        for back in (0..range.days()).rev() {
            let date: String = conn
                .query_row("SELECT date(?1 / 1000, 'unixepoch', 'localtime', ?2)", params![now_ms, format!("-{back} days")], |r| r.get(0))
                .map_err(db_err)?;
            let totals = found.get(&date).cloned().unwrap_or_default();
            days.push(Day { date, totals });
        }
        Ok(days)
    }

    /// The range's runs as CSV: metrics only, never the text.
    pub fn usage_csv(&self, range: UsageRange, now_ms: i64) -> AppResult<String> {
        let conn = self.conn()?;
        let start = self.range_start(&conn, range, now_ms)?;
        let mut stmt = conn
            .prepare(
                "SELECT strftime('%Y-%m-%dT%H:%M:%S', ts / 1000, 'unixepoch', 'localtime'), mode, provider, coalesce(app, ''), \
                 coalesce(model, ''), words, audio_secs, stt_ms, llm_ttft_ms, llm_total_ms, total_ms, prompt_tokens, \
                 completion_tokens, stt_cost_usd, ok, coalesce(error, '') FROM runs WHERE ts >= ?1 ORDER BY ts",
            )
            .map_err(db_err)?;
        let mut out = String::from(
            "time,mode,provider,app,model,words,audio_secs,stt_ms,llm_ttft_ms,llm_total_ms,total_ms,prompt_tokens,completion_tokens,stt_cost_usd,ok,error\n",
        );
        let num = |v: Option<f64>| v.map(|v| format!("{v}")).unwrap_or_default();
        let int = |v: Option<i64>| v.map(|v| v.to_string()).unwrap_or_default();
        let mut rows = stmt.query([start]).map_err(db_err)?;
        while let Some(r) = rows.next().map_err(db_err)? {
            let cells = [
                r.get::<_, String>(0).map_err(db_err)?,
                r.get::<_, String>(1).map_err(db_err)?,
                r.get::<_, String>(2).map_err(db_err)?,
                csv_cell(&r.get::<_, String>(3).map_err(db_err)?),
                csv_cell(&r.get::<_, String>(4).map_err(db_err)?),
                r.get::<_, i64>(5).map_err(db_err)?.to_string(),
                format!("{}", r.get::<_, f64>(6).map_err(db_err)?),
                num(r.get(7).map_err(db_err)?),
                num(r.get(8).map_err(db_err)?),
                num(r.get(9).map_err(db_err)?),
                num(r.get(10).map_err(db_err)?),
                int(r.get(11).map_err(db_err)?),
                int(r.get(12).map_err(db_err)?),
                num(r.get(13).map_err(db_err)?),
                (if r.get::<_, bool>(14).map_err(db_err)? { "1" } else { "0" }).to_owned(),
                csv_cell(&r.get::<_, String>(15).map_err(db_err)?),
            ];
            out.push_str(&cells.join(","));
            out.push('\n');
        }
        Ok(out)
    }

    // ---- dictionary -----------------------------------------------------------------------------

    pub fn terms(&self) -> AppResult<Vec<Term>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare("SELECT id, term, created_at FROM dictionary ORDER BY created_at, rowid").map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| Ok(Term { id: r.get(0)?, term: r.get(1)?, created_at: r.get(2)? }))
            .map_err(db_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
    }

    fn insert_term(conn: &Connection, term: &str) -> AppResult<Term> {
        let count: i64 = conn.query_row("SELECT count(*) FROM dictionary", [], |r| r.get(0)).map_err(db_err)?;
        if count as usize >= MAX_TERMS {
            return Err(AppError::invalid("The dictionary is full (1000 terms)").with_reason("dictionary_full"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let created_at: String = conn.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |r| r.get(0)).map_err(db_err)?;
        match conn.execute("INSERT INTO dictionary (id, term, created_at) VALUES (?1, ?2, ?3)", params![id, term, created_at]) {
            Ok(_) => Ok(Term { id, term: term.to_owned(), created_at }),
            Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::ConstraintViolation => {
                Err(AppError::invalid("That term is already in the dictionary").with_reason("term_exists"))
            }
            Err(e) => Err(db_err(e)),
        }
    }

    pub fn add_term(&self, raw: &str) -> AppResult<Term> {
        let term = clean_term(raw)?;
        let conn = self.conn()?;
        Self::insert_term(&conn, &term)
    }

    pub fn update_term(&self, id: &str, raw: &str) -> AppResult<Term> {
        let term = clean_term(raw)?;
        let conn = self.conn()?;
        let changed = match conn.execute("UPDATE dictionary SET term = ?2 WHERE id = ?1", params![id, term]) {
            Ok(n) => n,
            Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::ConstraintViolation => {
                return Err(AppError::invalid("That term is already in the dictionary").with_reason("term_exists"));
            }
            Err(e) => return Err(db_err(e)),
        };
        if changed == 0 {
            return Err(AppError::invalid("That term was already deleted"));
        }
        conn.query_row("SELECT id, term, created_at FROM dictionary WHERE id = ?1", [id], |r| {
            Ok(Term { id: r.get(0)?, term: r.get(1)?, created_at: r.get(2)? })
        })
        .map_err(db_err)
    }

    pub fn delete_term(&self, id: &str) -> AppResult<()> {
        self.conn()?.execute("DELETE FROM dictionary WHERE id = ?1", [id]).map_err(db_err)?;
        Ok(())
    }

    pub fn import_terms(&self, csv: &str) -> AppResult<ImportResult> {
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(db_err)?;
        let (mut added, mut skipped) = (0, 0);
        for raw in csv_terms(csv) {
            match clean_term(&raw).and_then(|t| Self::insert_term(&tx, &t)) {
                Ok(_) => added += 1,
                Err(e) if e.code == ErrorCode::InvalidInput => skipped += 1,
                Err(e) => return Err(e),
            }
        }
        tx.commit().map_err(db_err)?;
        Ok(ImportResult { added, skipped })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2026-11-18 12:00 local time, whatever the zone the tests run in.
    fn noon(db: &Db) -> i64 {
        db.conn()
            .unwrap()
            .query_row("SELECT CAST(strftime('%s', '2026-11-18 12:00:00', 'utc') AS INTEGER) * 1000", [], |r| r.get(0))
            .unwrap()
    }

    fn db() -> (Db, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        (Db::open(&dir.path().join(FILE_NAME)).unwrap(), dir)
    }

    fn run(id: &str, ts: i64, mode: &str, ok: bool) -> RunRecord {
        RunRecord {
            id: id.into(),
            ts,
            mode: mode.into(),
            provider: "local".into(),
            app: Some("Notes".into()),
            raw_text: "um hello there".into(),
            refined_text: "Hello there.".into(),
            model: Some("m".into()),
            audio_secs: 2.5,
            stt_ms: Some(400.0),
            llm_ttft_ms: Some(200.0),
            llm_total_ms: Some(300.0),
            total_ms: Some(800.0),
            prompt_tokens: Some(100),
            completion_tokens: Some(10),
            stt_cost_usd: Some(0.0002),
            words: 2,
            ok,
            error: (!ok).then(|| "boom".into()),
            output: Some("pasted".into()),
            ..Default::default()
        }
    }

    #[test]
    fn words_count_latin_and_cjk() {
        assert_eq!(count_words("Hello, wide world."), 3);
        assert_eq!(count_words("今天开会 at 3"), 6);
        assert_eq!(count_words("  - "), 0);
    }

    #[test]
    fn runs_insert_list_search_page_delete() {
        let (db, _dir) = db();
        let now = noon(&db);
        db.insert_run(&run("a", now - 3000, "dictate", true), None).unwrap();
        let mut b = run("b", now - 2000, "ask", true);
        b.refined_text = "100% sure_thing".into();
        db.insert_run(&b, Some((b"RIFF", "wav"))).unwrap();
        db.insert_run(&run("c", now - 1000, "translate", false), None).unwrap();

        let all = db.list_runs(&RunsQuery::default()).unwrap();
        assert_eq!(all.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["c", "b", "a"]);
        assert!(all[1].has_audio && !all[0].has_audio);

        // LIKE wildcards in the search are literal.
        let found = db.list_runs(&RunsQuery { search: Some("100%".into()), ..Default::default() }).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(db.list_runs(&RunsQuery { search: Some("_".into()), ..Default::default() }).unwrap().len(), 1);
        assert_eq!(db.list_runs(&RunsQuery { search: Some("notes".into()), ..Default::default() }).unwrap().len(), 3);

        let page = db.list_runs(&RunsQuery { before: Some(now - 1000), limit: Some(1), ..Default::default() }).unwrap();
        assert_eq!(page[0].id, "b");

        assert_eq!(db.run_audio("b").unwrap(), b"RIFF");
        let path = db.get_run("b").unwrap().audio_path.unwrap();
        db.delete_run("b").unwrap();
        assert!(!Path::new(&path).exists(), "deleting a run deletes its audio");
        assert_eq!(db.get_run("b").unwrap_err().code, ErrorCode::InvalidInput);

        let r = db.update_rewrite("c", "Fixed now.", "m2", Some(90.0), 120.0, (Some(5), Some(3))).unwrap();
        assert!(r.ok && r.error.is_none());
        assert_eq!((r.refined_text.as_str(), r.words, r.model.as_deref()), ("Fixed now.", 2, Some("m2")));
        assert_eq!(db.last_ok_run().unwrap().unwrap().id, "c");

        db.clear_runs().unwrap();
        assert!(db.list_runs(&RunsQuery::default()).unwrap().is_empty());
    }

    #[test]
    fn prune_keeps_recent_runs() {
        let (db, _dir) = db();
        let now = noon(&db);
        db.insert_run(&run("old", now - 40 * 86_400_000, "dictate", true), Some((b"x", "ogg"))).unwrap();
        db.insert_run(&run("new", now - 86_400_000, "dictate", true), None).unwrap();
        assert_eq!(db.prune(0, now).unwrap(), 0);
        assert_eq!(db.prune(30, now).unwrap(), 1);
        assert_eq!(db.list_runs(&RunsQuery::default()).unwrap().len(), 1);
        assert!(std::fs::read_dir(db.audio_dir()).unwrap().next().is_none());
    }

    #[test]
    fn usage_totals_breakdowns_days_and_percentiles() {
        let (db, _dir) = db();
        let now = noon(&db);
        let day = 86_400_000;
        for (i, ms) in [100.0, 200.0, 300.0, 400.0, 1000.0].into_iter().enumerate() {
            let mut r = run(&format!("t{i}"), now - (i as i64) * 1000, if i == 0 { "ask" } else { "dictate" }, true);
            r.stt_ms = Some(ms);
            db.insert_run(&r, None).unwrap();
        }
        db.insert_run(&run("err", now - 500, "dictate", false), None).unwrap();
        db.insert_run(&run("yesterday", now - day, "dictate", true), None).unwrap();
        db.insert_run(&run("lastmonth", now - 40 * day, "dictate", true), None).unwrap();

        let today = db.usage_summary(UsageRange::Today, now).unwrap();
        assert_eq!((today.totals.runs, today.totals.errors, today.totals.words), (5, 1, 10));
        assert!((today.totals.audio_secs - 12.5).abs() < 1e-9);
        assert_eq!(today.by_mode[0].key, "dictate");
        assert_eq!(today.by_mode[0].totals.runs, 4);
        assert_eq!(today.by_app[0].key, "Notes");
        assert_eq!(today.stages.stt, Percentiles { p50: Some(300.0), p95: Some(1000.0) });

        let week = db.usage_summary(UsageRange::Week, now).unwrap();
        assert_eq!(week.totals.runs, 6);
        let days = db.usage_daily(UsageRange::Week, now).unwrap();
        assert_eq!(days.len(), 7);
        assert_eq!(days[6].date, "2026-11-18");
        assert_eq!((days[6].totals.runs, days[5].totals.runs, days[0].totals.runs), (5, 1, 0));

        let csv = db.usage_csv(UsageRange::Week, now).unwrap();
        assert_eq!(csv.lines().count(), 1 + 7);
        assert!(csv.lines().nth(1).unwrap().starts_with("2026-11-17T12:00:00,dictate,local,Notes,m,2,2.5,"));
        assert!(!csv.contains("Hello there"), "the export never holds the text");
        assert_eq!(serde_json::to_value(&days[6]).unwrap()["runs"], 5);
    }

    #[test]
    fn dictionary_add_update_dedupe_import() {
        let (db, _dir) = db();
        let a = db.add_term("  Comma   app ").unwrap();
        assert_eq!(a.term, "Comma app");
        assert_eq!(db.add_term("comma APP").unwrap_err().reason.as_deref(), Some("term_exists"));
        assert!(db.add_term("a<b").is_err());
        assert!(db.add_term(&"x".repeat(101)).is_err());
        let b = db.add_term("ElevenLabs").unwrap();
        assert_eq!(db.update_term(&b.id, "comma app").unwrap_err().reason.as_deref(), Some("term_exists"));
        assert_eq!(db.update_term(&b.id, "Eleven Labs").unwrap().term, "Eleven Labs");

        let res = db.import_terms("term\n\"Ada, Lovelace\",x\nmagpie;y\nELEVEN LABS\n\n{bad}\n").unwrap();
        assert_eq!(res, ImportResult { added: 2, skipped: 2 });
        let terms: Vec<String> = db.terms().unwrap().into_iter().map(|t| t.term).collect();
        assert_eq!(terms, ["Comma app", "Eleven Labs", "Ada, Lovelace", "magpie"]);
        db.delete_term(&a.id).unwrap();
        assert_eq!(db.terms().unwrap().len(), 3);
    }

    #[test]
    fn reopening_keeps_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        Db::open(&path).unwrap().add_term("kept").unwrap();
        assert_eq!(Db::open(&path).unwrap().terms().unwrap()[0].term, "kept");
    }
}
