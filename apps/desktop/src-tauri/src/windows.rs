//! Show and hide helpers for the three windows declared in `tauri.conf.json`.

use serde::Deserialize;
use tauri::{AppHandle, Manager, PhysicalPosition, Runtime, WebviewWindow};

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

/// Bottom centre of the primary monitor's work area. Phase 2 moves it to the monitor with
/// the mouse (spec 2.1).
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
    fn labels_parse() {
        assert_eq!(serde_json::from_str::<WindowLabel>("\"bar\"").unwrap(), WindowLabel::Bar);
        assert!(serde_json::from_str::<WindowLabel>("\"main\"").is_err());
    }
}
