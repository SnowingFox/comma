//! Menu bar icon with Open Comma and Quit.

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Runtime};

use crate::commands::AppState;
use crate::error::AppResult;
use crate::windows::{self, WindowLabel};

const OPEN_ID: &str = "open";
const QUIT_ID: &str = "quit";

pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, OPEN_ID, "Open Comma", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT_ID, "Quit Comma", true, Some("CmdOrCtrl+Q"))?;
    let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit])?;
    let icon = Image::from_bytes(include_bytes!("../icons/tray-template.png"))?;

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Comma")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN_ID => {
                let _ = open_main(app);
            }
            QUIT_ID => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// The hub, or onboarding while it has not been finished.
pub fn open_main<R: Runtime>(app: &AppHandle<R>) -> AppResult<()> {
    let onboarded = app
        .try_state::<AppState>()
        .and_then(|state| state.settings.lock().ok().map(|s| s.onboarding_completed))
        .unwrap_or(true);
    windows::show(app, if onboarded { WindowLabel::Hub } else { WindowLabel::Onboarding })
}
