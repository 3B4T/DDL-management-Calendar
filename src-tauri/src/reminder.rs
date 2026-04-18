use std::{path::PathBuf, time::Duration};

use chrono::Utc;
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;
use tokio::time::sleep;

use crate::{db, models::ReminderMode, AppState};

#[cfg(target_os = "windows")]
fn play_system_beep() {
  print!("\x07");
}

#[cfg(not(target_os = "windows"))]
fn play_system_beep() {}

fn should_play_sound(mode: &str) -> bool {
  matches!(ReminderMode::from_str(mode), ReminderMode::ToastSound)
}

fn should_show_toast(mode: &str) -> bool {
  !matches!(ReminderMode::from_str(mode), ReminderMode::InAppOnly)
}

fn handle_alerts(app: &AppHandle, db_path: &PathBuf) -> anyhow::Result<()> {
  let now = Utc::now();
  let promoted = db::promote_overdue_ddls(db_path, now)?;
  if promoted > 0 {
    log::info!("promoted {promoted} overdue ddl item(s) to todo");
  }
  let settings = db::get_settings(db_path)?;
  let alerts = db::collect_due_alerts(db_path, now)?;
  for alert in alerts {
    if should_show_toast(&settings.reminder_mode) {
      let body = format!("{} | 截止时间 {}", alert.title, alert.due_at);
      let _ = app
        .notification()
        .builder()
        .title("Windows Calendar 提醒")
        .body(&body)
        .show();
    }
    if should_play_sound(&settings.reminder_mode) {
      play_system_beep();
    }
    let _ = app.emit("reminder-alert", alert);
  }
  Ok(())
}

pub fn start_loop(app: AppHandle, state: AppState) {
  tauri::async_runtime::spawn(async move {
    loop {
      if let Err(err) = handle_alerts(&app, &state.db_path) {
        log::error!("reminder loop error: {err}");
      }
      sleep(Duration::from_secs(30)).await;
    }
  });
}
