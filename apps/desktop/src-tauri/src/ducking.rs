//! Lowers the Mac's output volume while recording ("Lower other audio", on by default) so music
//! or a video does not end up in the dictation, and puts it back afterwards.
//!
//! The volume is restored only when it is still the ducked value (the user did not change it
//! meanwhile). The level before ducking is also written to a file, so a crash mid-recording is
//! repaired on the next launch.

use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::commands::AppState;

/// Ducked level as a share of the current one.
const DUCK_TO: f64 = 0.3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Ducked {
    before: u32,
    set: u32,
}

static DUCKED: Mutex<Option<Ducked>> = Mutex::new(None);
/// The latest request; a duck that loses the race against a quick release does nothing.
static WANT: AtomicBool = AtomicBool::new(false);
static FILE: Mutex<Option<PathBuf>> = Mutex::new(None);

/// The target level, or `None` when ducking would change nothing audible.
fn ducked_level(before: u32) -> Option<u32> {
    let set = (f64::from(before) * DUCK_TO).round() as u32;
    (before >= 5 && set < before).then_some(set)
}

/// Restore only what we set ourselves (macOS rounds the level to its 16 steps, so allow a little).
fn should_restore(ducked: Ducked, now: u32) -> bool {
    now.abs_diff(ducked.set) <= 3
}

fn osascript(script: &str) -> Option<String> {
    let out = std::process::Command::new("/usr/bin/osascript").args(["-e", script]).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

/// Output volume 0 to 100, `None` when muted or unknown (nothing to duck then).
fn volume() -> Option<u32> {
    let muted = osascript("output muted of (get volume settings)")?;
    if muted == "true" {
        return None;
    }
    osascript("output volume of (get volume settings)")?.parse().ok()
}

fn set_volume(level: u32) {
    // `level` is a number we computed, never outside input.
    let _ = osascript(&format!("set volume output volume {}", level.min(100)));
}

/// Remembers where the crash-repair file lives; restores a level a crash left behind.
pub fn init(dir: PathBuf) {
    let path = dir.join("ducked-volume");
    if let Ok(raw) = std::fs::read_to_string(&path)
        && let Some((before, set)) = raw.trim().split_once(' ')
        && let (Ok(before), Ok(set)) = (before.parse::<u32>(), set.parse::<u32>())
    {
        std::thread::spawn(move || {
            if volume().is_some_and(|now| should_restore(Ducked { before, set }, now)) {
                set_volume(before);
            }
        });
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(mut f) = FILE.lock() {
        *f = Some(path);
    }
}

fn file() -> Option<PathBuf> {
    FILE.lock().ok().and_then(|f| f.clone())
}

pub fn duck(state: &AppState) {
    if !state.snapshot().is_ok_and(|s| s.feedback.duck_audio) {
        return;
    }
    WANT.store(true, Ordering::SeqCst);
    std::thread::spawn(|| {
        let Ok(mut ducked) = DUCKED.lock() else { return };
        if ducked.is_some() || !WANT.load(Ordering::SeqCst) {
            return;
        }
        let Some(before) = volume() else { return };
        let Some(set) = ducked_level(before) else { return };
        set_volume(set);
        *ducked = Some(Ducked { before, set });
        if let Some(path) = file() {
            let _ = std::fs::write(path, format!("{before} {set}"));
        }
    });
}

pub fn restore(_state: &AppState) {
    WANT.store(false, Ordering::SeqCst);
    std::thread::spawn(|| {
        let Ok(mut ducked) = DUCKED.lock() else { return };
        let Some(d) = ducked.take() else { return };
        if volume().is_some_and(|now| should_restore(d, now)) {
            set_volume(d.before);
        }
        if let Some(path) = file() {
            let _ = std::fs::remove_file(path);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels() {
        assert_eq!(ducked_level(50), Some(15));
        assert_eq!(ducked_level(100), Some(30));
        assert_eq!(ducked_level(3), None, "already quiet");
        assert!(should_restore(Ducked { before: 50, set: 15 }, 15));
        assert!(!should_restore(Ducked { before: 50, set: 15 }, 40), "the user turned it up meanwhile");
    }
}
