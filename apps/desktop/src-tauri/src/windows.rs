//! Show and hide helpers for the three windows declared in `tauri.conf.json`.

use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, Runtime, WebviewWindow};

use crate::error::{AppError, AppResult};

/// Gap between the bar and the bottom of the work area (above the Dock), in logical px.
const BAR_BOTTOM_MARGIN: f64 = 24.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowLabel {
    Hub,
    Onboarding,
    Bar,
}

impl WindowLabel {
    pub fn as_str(self) -> &'static str {
        match self {
            WindowLabel::Hub => "hub",
            WindowLabel::Onboarding => "onboarding",
            WindowLabel::Bar => "bar",
        }
    }
}

fn window<R: Runtime>(app: &AppHandle<R>, label: WindowLabel) -> AppResult<WebviewWindow<R>> {
    app.get_webview_window(label.as_str())
        .ok_or_else(|| AppError::internal(format!("window `{}` is missing", label.as_str())))
}

pub fn show<R: Runtime>(app: &AppHandle<R>, label: WindowLabel) -> AppResult<()> {
    let win = window(app, label)?;
    if label == WindowLabel::Bar {
        position_bar(&win)?;
        // The bar never takes focus: showing it must not pull focus from the app being typed in.
        win.show()?;
        return Ok(());
    }
    if win.is_minimized().unwrap_or(false) {
        win.unminimize()?;
    }
    win.show()?;
    win.set_focus()?;
    Ok(())
}

pub fn hide<R: Runtime>(app: &AppHandle<R>, label: WindowLabel) -> AppResult<()> {
    window(app, label)?.hide()?;
    Ok(())
}

/// The bar window's size for each layout, in logical px. `Full` has room above the pill for a hint
/// or the answer card; the page draws everything bottom-aligned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BarLayout {
    Hidden,
    Dot,
    Full,
}

impl BarLayout {
    fn size(self) -> (f64, f64) {
        match self {
            BarLayout::Hidden | BarLayout::Dot => (48.0, 28.0),
            BarLayout::Full => (460.0, 340.0),
        }
    }
}

static BAR: Mutex<BarLayout> = Mutex::new(BarLayout::Hidden);

/// Shows the full bar on the screen that has the mouse, before the recording's first frame.
pub fn prepare_bar<R: Runtime>(app: &AppHandle<R>) -> AppResult<()> {
    set_bar(app, BarLayout::Full, false)
}

/// `interactive` lets the window take clicks; otherwise they pass through to the app below.
pub fn set_bar<R: Runtime>(app: &AppHandle<R>, layout: BarLayout, interactive: bool) -> AppResult<()> {
    let win = window(app, WindowLabel::Bar)?;
    let previous = BAR.lock().map(|mut b| std::mem::replace(&mut *b, layout)).unwrap_or(BarLayout::Hidden);
    if layout == BarLayout::Hidden {
        win.hide()?;
        return Ok(());
    }
    let (w, h) = layout.size();
    win.set_size(LogicalSize::new(w, h))?;
    // A new run follows the mouse to its screen; a run in progress stays where it started.
    let monitor = if previous == BarLayout::Full {
        win.current_monitor()?
    } else {
        app.cursor_position().ok().and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten()).or(win.primary_monitor()?)
    };
    if let Some(monitor) = monitor {
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        let size = ((w * scale).round() as u32, (h * scale).round() as u32);
        let margin = ((BAR_BOTTOM_MARGIN - if layout == BarLayout::Full { 12.0 } else { 0.0 }) * scale).round() as i32;
        let (x, y) = bar_origin((area.position.x, area.position.y), (area.size.width, area.size.height), size, margin);
        win.set_position(PhysicalPosition::new(x, y))?;
    }
    win.set_ignore_cursor_events(!interactive)?;
    win.show()?;
    Ok(())
}

pub const MENU_COPY: &str = "bar:copy";
pub const MENU_OPEN: &str = "bar:open";
pub const MENU_LANG: &str = "bar:lang:";

/// The bar's right-click menu (spec 2.3.1): copy last result, output language, open Comma.
pub fn bar_menu<R: Runtime>(app: &AppHandle<R>, has_last: bool, targets: &[String]) -> AppResult<()> {
    let win = window(app, WindowLabel::Bar)?;
    let copy = MenuItem::with_id(app, MENU_COPY, "Copy last result", has_last, None::<&str>)?;
    let mut langs: Vec<String> = targets.to_vec();
    for common in ["en", "zh-Hans", "es", "fr", "de", "ja"] {
        if langs.len() >= 6 {
            break;
        }
        if !langs.iter().any(|l| l == common) {
            langs.push(common.to_owned());
        }
    }
    let items = langs
        .iter()
        .enumerate()
        .map(|(i, tag)| {
            CheckMenuItem::with_id(app, format!("{MENU_LANG}{tag}"), comma_voice::prompts::language_name(tag), true, i == 0 && !targets.is_empty(), None::<&str>)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let refs: Vec<&dyn tauri::menu::IsMenuItem<R>> = items.iter().map(|i| i as &dyn tauri::menu::IsMenuItem<R>).collect();
    let language = Submenu::with_items(app, "Translate into", true, &refs)?;
    let open = MenuItem::with_id(app, MENU_OPEN, "Open Comma", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&copy, &language, &PredefinedMenuItem::separator(app)?, &open])?;
    win.popup_menu(&menu)?;
    Ok(())
}

/// `tag` first, keeping at most three targets.
pub fn with_first_target(targets: &[String], tag: &str) -> Vec<String> {
    let mut next = vec![tag.to_owned()];
    next.extend(targets.iter().filter(|t| *t != tag).cloned());
    next.truncate(3);
    next
}

/// Bottom centre of the primary monitor's work area, for the dev preview.
fn position_bar<R: Runtime>(win: &WebviewWindow<R>) -> AppResult<()> {
    let Some(monitor) = win.primary_monitor()? else { return Ok(()) };
    let area = monitor.work_area();
    let size = win.outer_size()?;
    let margin = (BAR_BOTTOM_MARGIN * monitor.scale_factor()).round() as i32;
    let (x, y) = bar_origin(
        (area.position.x, area.position.y),
        (area.size.width, area.size.height),
        (size.width, size.height),
        margin,
    );
    win.set_position(PhysicalPosition::new(x, y))?;
    Ok(())
}

fn bar_origin(area_pos: (i32, i32), area_size: (u32, u32), win_size: (u32, u32), margin: i32) -> (i32, i32) {
    let x = area_pos.0 + (area_size.0 as i32 - win_size.0 as i32) / 2;
    let y = area_pos.1 + area_size.1 as i32 - win_size.1 as i32 - margin;
    (x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bar_sits_bottom_centre() {
        // 1512x945 logical at 2x, work area starting below a 37px menu bar.
        assert_eq!(bar_origin((0, 74), (3024, 1816), (720, 128), 48), (1152, 1714));
        // A secondary monitor to the left of the primary.
        assert_eq!(bar_origin((-1920, 0), (1920, 1080), (360, 64), 24), (-1140, 992));
    }

    #[test]
    fn first_target_moves_to_front() {
        let t = |v: &[&str]| v.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        assert_eq!(with_first_target(&t(&["fr", "de"]), "de"), t(&["de", "fr"]));
        assert_eq!(with_first_target(&t(&["fr", "de", "ja"]), "es"), t(&["es", "fr", "de"]));
    }

    #[test]
    fn labels_parse() {
        assert_eq!(serde_json::from_str::<WindowLabel>("\"bar\"").unwrap(), WindowLabel::Bar);
        assert!(serde_json::from_str::<WindowLabel>("\"main\"").is_err());
    }
}
