mod db;
mod models;
mod reminder;

use std::path::PathBuf;

use models::{
  CalendarItem,
  DailyPlanEntry,
  DailyPlanEntryInput,
  DateRange,
  ItemPayload,
  ReminderSettings,
  SettingsPayload,
};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
  AppHandle,
  LogicalSize,
  Manager,
  Size,
  State,
  WebviewUrl,
  WebviewWindow,
  WebviewWindowBuilder,
  WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutoStartManagerExt};

#[derive(Clone)]
struct AppState {
  db_path: PathBuf,
}

const MAIN_WINDOW_LABEL: &str = "main";
const ORB_WINDOW_LABEL: &str = "orb";
const ORB_WINDOW_SIZE: f64 = 64.0;

fn app_error<E: std::fmt::Display>(err: E) -> String {
  err.to_string()
}

fn show_orb_hide_main(app: &AppHandle) -> Result<(), tauri::Error> {
  if let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) {
    let _ = main.hide();
  }

  if let Some(orb) = app.get_webview_window(ORB_WINDOW_LABEL) {
    let _ = orb.show();
    let _ = orb.set_focus();
  }

  Ok(())
}

fn show_main_hide_orb(app: &AppHandle) -> Result<(), tauri::Error> {
  if let Some(orb) = app.get_webview_window(ORB_WINDOW_LABEL) {
    let _ = orb.hide();
  }

  if let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) {
    let _ = main.show();
    let _ = main.set_focus();
  }

  Ok(())
}

fn toggle_main_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
    let visible = window.is_visible().unwrap_or(false);
    if visible {
      let _ = show_orb_hide_main(app);
    } else {
      let _ = show_main_hide_orb(app);
    }
  } else {
    let _ = show_main_hide_orb(app);
  }
}

fn resize_main_window(window: &WebviewWindow) -> Result<(), tauri::Error> {
  let monitor = window.current_monitor()?.or(window.primary_monitor()?).ok_or_else(|| {
    tauri::Error::AssetNotFound("No monitor found for window sizing".to_string())
  })?;

  let width_px = monitor.size().width as f64;
  let height_px = monitor.size().height as f64;
  let target_area = (width_px * height_px) / 12.0;
  let mut target_width = (target_area * 4.0 / 3.0).sqrt();
  let mut target_height = target_width * 3.0 / 4.0;

  target_width = target_width.max(420.0);
  target_height = target_height.max(315.0);

  window.set_size(Size::Logical(LogicalSize::new(target_width, target_height)))?;
  Ok(())
}

fn apply_main_window_mode(window: &WebviewWindow) -> Result<(), tauri::Error> {
  window.set_decorations(false)?;
  window.set_always_on_top(true)?;
  window.set_visible_on_all_workspaces(true)?;
  window.set_maximizable(false)?;
  window.set_closable(false)?;
  Ok(())
}

fn setup_orb_window(app: &tauri::App) -> Result<(), tauri::Error> {
  if app.get_webview_window(ORB_WINDOW_LABEL).is_some() {
    return Ok(());
  }

  let orb = WebviewWindowBuilder::new(app, ORB_WINDOW_LABEL, WebviewUrl::App("index.html".into()))
    .title("Windows Calendar Orb")
    .inner_size(ORB_WINDOW_SIZE, ORB_WINDOW_SIZE)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .closable(false)
    .decorations(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .transparent(true)
    .shadow(false)
    .visible(false)
    .build()?;

  let orb_for_close = orb.clone();
  orb.on_window_event(move |event| {
    if let WindowEvent::CloseRequested { api, .. } = event {
      api.prevent_close();
      let app_handle = orb_for_close.app_handle();
      let _ = show_main_hide_orb(&app_handle);
    }
  });

  Ok(())
}

fn setup_tray(app: &tauri::App) -> Result<(), tauri::Error> {
  let toggle_item = MenuItemBuilder::with_id("toggle_visibility", "显示/隐藏").build(app)?;
  let menu = MenuBuilder::new(app).items(&[&toggle_item]).build()?;

  TrayIconBuilder::new()
    .menu(&menu)
    .on_menu_event(|app, event| match event.id().as_ref() {
      "toggle_visibility" => toggle_main_window(app),
      _ => {}
    })
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
      } = event
      {
        toggle_main_window(&tray.app_handle());
      }
    })
    .build(app)?;

  Ok(())
}

#[tauri::command]
fn list_items(
  state: State<'_, AppState>,
  range: Option<DateRange>,
  item_type: Option<String>,
  status: Option<String>,
  search: Option<String>,
) -> Result<Vec<CalendarItem>, String> {
  db::list_items(&state.db_path, range, item_type, status, search).map_err(app_error)
}

#[tauri::command]
fn create_item(state: State<'_, AppState>, payload: ItemPayload) -> Result<CalendarItem, String> {
  db::create_item(&state.db_path, &payload).map_err(app_error)
}

#[tauri::command]
fn update_item(
  state: State<'_, AppState>,
  id: i64,
  payload: ItemPayload,
) -> Result<CalendarItem, String> {
  db::update_item(&state.db_path, id, &payload).map_err(app_error)
}

#[tauri::command]
fn delete_item(state: State<'_, AppState>, id: i64) -> Result<(), String> {
  db::delete_item(&state.db_path, id).map_err(app_error)
}

#[tauri::command]
fn mark_item_done(state: State<'_, AppState>, id: i64, done: bool) -> Result<CalendarItem, String> {
  db::mark_item_done(&state.db_path, id, done).map_err(app_error)
}

#[tauri::command]
fn snooze_item(state: State<'_, AppState>, id: i64, minutes: i64) -> Result<CalendarItem, String> {
  db::snooze_item(&state.db_path, id, minutes).map_err(app_error)
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Result<ReminderSettings, String> {
  db::get_settings(&state.db_path).map_err(app_error)
}

#[tauri::command]
fn update_settings(
  app: AppHandle,
  state: State<'_, AppState>,
  payload: SettingsPayload,
) -> Result<ReminderSettings, String> {
  let updated = db::update_settings(&state.db_path, &payload).map_err(app_error)?;
  let autostart = app.autolaunch();
  if updated.autostart {
    let _ = autostart.enable();
  } else {
    let _ = autostart.disable();
  }
  Ok(updated)
}

#[tauri::command]
fn get_item_daily_plan(
  state: State<'_, AppState>,
  item_id: i64,
) -> Result<Vec<DailyPlanEntry>, String> {
  db::get_item_daily_plan(&state.db_path, item_id).map_err(app_error)
}

#[tauri::command]
fn replace_item_daily_plan(
  state: State<'_, AppState>,
  item_id: i64,
  entries: Vec<DailyPlanEntryInput>,
) -> Result<Vec<DailyPlanEntry>, String> {
  db::replace_item_daily_plan(&state.db_path, item_id, &entries).map_err(app_error)
}

#[tauri::command]
fn clear_item_daily_plan(state: State<'_, AppState>, item_id: i64) -> Result<(), String> {
  db::clear_item_daily_plan(&state.db_path, item_id).map_err(app_error)
}

#[tauri::command]
fn minimize_to_orb(app: AppHandle) -> Result<(), String> {
  show_orb_hide_main(&app).map_err(app_error)
}

#[tauri::command]
fn restore_from_orb(app: AppHandle) -> Result<(), String> {
  show_main_hide_orb(&app).map_err(app_error)
}

#[tauri::command]
fn quit_app(app: AppHandle) {
  app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_autostart::init(
      MacosLauncher::LaunchAgent,
      None::<Vec<&str>>,
    ))
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| tauri::Error::AssetNotFound(e.to_string()))?;
      let db_path = data_dir.join("calendar.db");
      db::init(&db_path).map_err(|e| tauri::Error::AssetNotFound(e.to_string()))?;

      let state = AppState { db_path };
      app.manage(state.clone());
      if let Ok(settings) = db::get_settings(&state.db_path) {
        let autostart = app.handle().autolaunch();
        if settings.autostart {
          let _ = autostart.enable();
        } else {
          let _ = autostart.disable();
        }
      }

      setup_orb_window(app)?;
      setup_tray(app)?;

      if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        resize_main_window(&window)?;
        apply_main_window_mode(&window)?;

        let app_handle = window.app_handle().clone();
        window.on_window_event(move |event| {
          if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = show_orb_hide_main(&app_handle);
          }
        });
      }

      reminder::start_loop(app.handle().clone(), state);
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      list_items,
      create_item,
      update_item,
      delete_item,
      mark_item_done,
      snooze_item,
      get_settings,
      update_settings,
      get_item_daily_plan,
      replace_item_daily_plan,
      clear_item_daily_plan,
      minimize_to_orb,
      restore_from_orb,
      quit_app
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
