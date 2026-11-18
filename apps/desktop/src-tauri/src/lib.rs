mod account;
mod commands;
mod db;
mod ducking;
mod error;
mod permissions;
mod run;
mod secrets;
mod settings;
mod shortcuts;
mod tray;
mod windows;

use std::sync::Arc;

use tauri::{Manager, RunEvent, WindowEvent};

use commands::AppState;
use shortcuts::Shortcuts;
use windows::WindowLabel;

/// Rotate at 2 MB and keep five old files.
const LOG_MAX_BYTES: u128 = 2_000_000;

/// The app log (spec 4, Logging): lifecycle, listener and permission changes, run stages and
/// errors. Never keys other than the configured shortcut events, typed or dictated text,
/// transcripts, selected text or secrets.
fn log_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};
    let mut builder = tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(Target::new(TargetKind::LogDir { file_name: Some(commands::LOG_FILE.into()) }))
        .max_file_size(LOG_MAX_BYTES)
        .rotation_strategy(RotationStrategy::KeepSome(5))
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .level(log::LevelFilter::Info)
        // HTTP and webview internals are noise here, and could carry URLs with keys in a query.
        .level_for("reqwest", log::LevelFilter::Warn)
        .level_for("hyper", log::LevelFilter::Warn)
        .level_for("hyper_util", log::LevelFilter::Warn)
        .level_for("rustls", log::LevelFilter::Warn)
        .level_for("tao", log::LevelFilter::Warn)
        .level_for("wry", log::LevelFilter::Warn)
        .level_for("tracing", log::LevelFilter::Warn);
    if cfg!(debug_assertions) {
        builder = builder.target(Target::new(TargetKind::Stdout));
    }
    builder.build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(log_plugin())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if let Some(shortcuts) = app.try_state::<Shortcuts>() {
                        shortcuts.on_plugin_event(shortcut, event);
                    }
                })
                .build(),
        )
        .setup(|app| {
            log::info!(
                "Comma {} starting ({} build, pid {}, {})",
                app.package_info().version,
                if cfg!(debug_assertions) { "debug" } else { "release" },
                std::process::id(),
                std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default()
            );
            let config_dir = app.path().app_config_dir()?;
            let settings_path = config_dir.join(settings::FILE_NAME);
            let settings = settings::load(&settings_path);
            let data_dir = app.path().app_data_dir()?;
            let db = db::Db::open(&data_dir.join(db::FILE_NAME))?;
            let _ = db.prune(settings.privacy.history_days, commands::now_ms());
            ducking::init(data_dir);
            let first_window = if settings.onboarding_completed { WindowLabel::Hub } else { WindowLabel::Onboarding };
            let shortcut_settings = settings.shortcuts.clone();
            // Probing the Fn tap adds Comma to the Input Monitoring list; wait until onboarding has
            // explained why, unless it was finished before.
            let probe = settings.onboarding_completed;
            log::info!(
                "settings: mode {:?}, onboarding {}, shortcuts {} / {} / {}",
                settings.mode,
                if settings.onboarding_completed { "done".to_owned() } else { format!("at {:?}", settings.onboarding_step) },
                settings.shortcuts.dictate,
                settings.shortcuts.ask,
                settings.shortcuts.translate
            );
            let idle_bar = settings.feedback.show_idle_bar;
            app.manage(AppState::new(settings, settings_path, Box::new(secrets::KeychainStore), db));
            let shortcuts = Shortcuts::start(app.handle(), shortcut_settings, probe, Arc::new(run::on_action));
            app.manage(shortcuts);
            tray::create(app.handle())?;
            if idle_bar {
                let _ = windows::set_bar(app.handle(), windows::BarLayout::Dot, true);
            }
            windows::show(app.handle(), first_window)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id.starts_with("bar:") {
                commands::on_bar_menu(app, id);
            }
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
            commands::input_monitoring_request,
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
            commands::account_credits,
            commands::shortcuts_status,
            commands::shortcuts_capture,
            commands::shortcuts_suspend,
            commands::shortcuts_restart,
            commands::shortcuts_probe,
            commands::shortcuts_set_swallow,
            commands::pipeline_check,
            commands::log_tail,
            commands::log_write,
            commands::app_restart,
            commands::hints_reset,
            commands::pipeline_run,
            commands::pipeline_cancel,
            commands::output_insert,
            commands::clipboard_copy,
            commands::bar_layout,
            commands::bar_menu,
            commands::hint_take,
            commands::runs_list,
            commands::run_get,
            commands::run_delete,
            commands::runs_clear,
            commands::run_rerun,
            commands::run_audio,
            commands::usage_summary,
            commands::usage_daily,
            commands::usage_export_csv,
            commands::dictionary_list,
            commands::dictionary_add,
            commands::dictionary_update,
            commands::dictionary_delete,
            commands::dictionary_import_csv,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the Comma app");

    app.run(|handle, event| match event {
        // Clicking the Dock icon with no window visible reopens the hub.
        RunEvent::Reopen { has_visible_windows: false, .. } => {
            let _ = tray::open_main(handle);
        }
        RunEvent::Exit => {
            log::info!("Comma exiting");
            if let Some(state) = handle.try_state::<AppState>() {
                ducking::restore(&state);
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
        }
        _ => {}
    });
}
