mod account;
mod audio;
mod commands;
mod error;
mod http;
mod llm;
mod permissions;
mod prompts;
mod secrets;
mod settings;
mod stt;
mod tray;
mod windows;

use tauri::{Manager, RunEvent, WindowEvent};

use commands::AppState;
use windows::WindowLabel;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let settings_path = app.path().app_config_dir()?.join(settings::FILE_NAME);
            let settings = settings::load(&settings_path);
            let first_window = if settings.onboarding_completed { WindowLabel::Hub } else { WindowLabel::Onboarding };
            app.manage(AppState::new(settings, settings_path, Box::new(secrets::KeychainStore)));
            tray::create(app.handle())?;
            windows::show(app.handle(), first_window)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the hub or onboarding hides it; Comma keeps running in the menu bar.
            if let WindowEvent::CloseRequested { api, .. } = event
                && window.label() != WindowLabel::Bar.as_str()
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings_get,
            commands::settings_set,
            commands::secret_set,
            commands::secret_status,
            commands::permissions_status,
            commands::open_settings_pane,
            commands::window_show,
            commands::window_hide,
            commands::llm_models,
            commands::llm_test,
            commands::stt_test,
            commands::stt_transcribe,
            commands::refine_text,
            commands::account_check,
            commands::account_register,
            commands::account_verify_email,
            commands::account_resend_code,
            commands::account_sign_in,
            commands::account_status,
            commands::account_sign_out,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the Comma app");

    app.run(|handle, event| {
        // Clicking the Dock icon with no window visible reopens the hub.
        if let RunEvent::Reopen { has_visible_windows: false, .. } = event {
            let _ = tray::open_main(handle);
        }
    });
}
