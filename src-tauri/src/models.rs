use serde::{Deserialize, Serialize};

pub const DEFAULT_OFFSETS: [i64; 3] = [1440, 60, 0];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReminderMode {
  ToastSound,
  ToastOnly,
  InAppOnly,
}

impl Default for ReminderMode {
  fn default() -> Self {
    Self::ToastSound
  }
}

impl ReminderMode {
  pub fn as_str(&self) -> &'static str {
    match self {
      Self::ToastSound => "toast_sound",
      Self::ToastOnly => "toast_only",
      Self::InAppOnly => "in_app_only",
    }
  }

  pub fn from_str(value: &str) -> Self {
    match value {
      "toast_only" => Self::ToastOnly,
      "in_app_only" => Self::InAppOnly,
      _ => Self::ToastSound,
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalendarItem {
  pub id: i64,
  #[serde(rename = "type")]
  pub item_type: String,
  pub title: String,
  pub note: String,
  pub start_at: Option<String>,
  pub due_at: String,
  pub estimated_hours: Option<f64>,
  pub daily_hours_override: Option<f64>,
  pub has_complex_plan: bool,
  pub done: bool,
  pub remind_enabled: bool,
  pub remind_offsets: Vec<i64>,
  pub reminder_cursor: i64,
  pub next_remind_at: Option<String>,
  pub postpone_used: bool,
  pub todo_overdue_days: i64,
  pub todo_anchor_at: String,
  pub created_at: String,
  pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReminderSettings {
  pub reminder_mode: String,
  pub default_offsets: Vec<i64>,
  pub autostart: bool,
  pub close_to_tray: bool,
}

impl Default for ReminderSettings {
  fn default() -> Self {
    Self {
      reminder_mode: ReminderMode::default().as_str().to_string(),
      default_offsets: DEFAULT_OFFSETS.to_vec(),
      autostart: true,
      close_to_tray: true,
    }
  }
}

#[derive(Debug, Clone, Deserialize)]
pub struct DateRange {
  pub start: Option<String>,
  pub end: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ItemPayload {
  #[serde(rename = "type")]
  pub item_type: String,
  pub title: String,
  pub note: Option<String>,
  pub start_at: String,
  pub due_at: String,
  pub estimated_hours: f64,
  pub daily_hours_override: Option<f64>,
  pub remind_enabled: bool,
  pub remind_offsets: Option<Vec<i64>>,
  pub todo_overdue_days: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SettingsPayload {
  pub reminder_mode: Option<String>,
  pub default_offsets: Option<Vec<i64>>,
  pub autostart: Option<bool>,
  pub close_to_tray: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReminderAlert {
  pub id: String,
  pub item_id: i64,
  pub item_type: String,
  pub title: String,
  pub due_at: String,
  pub postpone_used: bool,
  pub trigger_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyPlanEntry {
  pub plan_date: String,
  pub hours: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DailyPlanEntryInput {
  pub plan_date: String,
  pub hours: f64,
}
