use std::{collections::HashSet, fs, path::Path};

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::models::{
  CalendarItem,
  DailyPlanEntry,
  DailyPlanEntryInput,
  DateRange,
  ItemPayload,
  ReminderAlert,
  ReminderSettings,
  SettingsPayload,
};

const DEFAULT_TODO_OVERDUE_DAYS: i64 = 3;
const DATE_FORMAT: &str = "%Y-%m-%d";

fn open_conn(db_path: &Path) -> Result<Connection> {
  let parent = db_path
    .parent()
    .ok_or_else(|| anyhow!("database path parent not found"))?;
  fs::create_dir_all(parent).with_context(|| "failed to create app data directory")?;
  let conn = Connection::open(db_path).with_context(|| "failed to open sqlite connection")?;
  conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
  Ok(conn)
}

fn now_iso() -> String {
  Utc::now().to_rfc3339()
}

fn parse_datetime(input: &str) -> Result<DateTime<Utc>> {
  DateTime::parse_from_rfc3339(input)
    .map(|d| d.with_timezone(&Utc))
    .with_context(|| format!("invalid datetime: {input}"))
}

fn parse_date(input: &str) -> Result<NaiveDate> {
  NaiveDate::parse_from_str(input, DATE_FORMAT)
    .with_context(|| format!("invalid date: {input}, expected YYYY-MM-DD"))
}

fn due_date_from_due_at(input: &str) -> Result<NaiveDate> {
  Ok(parse_datetime(input)?.date_naive())
}

fn ensure_valid_item_type(item_type: &str) -> Result<()> {
  if matches!(item_type, "todo" | "ddl") {
    Ok(())
  } else {
    Err(anyhow!("invalid item type: {item_type}"))
  }
}

fn normalize_todo_overdue_days(days: Option<i64>) -> i64 {
  days.unwrap_or(DEFAULT_TODO_OVERDUE_DAYS).max(1)
}

fn validate_item_payload(payload: &ItemPayload) -> Result<()> {
  ensure_valid_item_type(&payload.item_type)?;
  if payload.title.trim().is_empty() {
    return Err(anyhow!("title cannot be empty"));
  }

  if payload.estimated_hours <= 0.0 {
    return Err(anyhow!("estimated_hours must be > 0"));
  }

  if let Some(hours) = payload.daily_hours_override {
    if hours <= 0.0 {
      return Err(anyhow!("daily_hours_override must be > 0"));
    }
  }

  let start_date = parse_date(&payload.start_at)?;
  let due_date = due_date_from_due_at(&payload.due_at)?;
  if start_date > due_date {
    return Err(anyhow!("start_at cannot be later than due_at"));
  }
  Ok(())
}

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
  let pragma = format!("PRAGMA table_info({table})");
  let mut statement = conn.prepare(&pragma)?;
  let rows = statement.query_map([], |row| row.get::<_, String>("name"))?;
  for row in rows {
    if row? == column {
      return Ok(true);
    }
  }
  Ok(false)
}

fn add_column_if_missing(conn: &Connection, table: &str, column: &str, definition: &str) -> Result<()> {
  if has_column(conn, table, column)? {
    return Ok(());
  }
  let alter = format!("ALTER TABLE {table} ADD COLUMN {definition}");
  conn.execute(&alter, [])?;
  Ok(())
}

fn normalize_offsets(offsets: &[i64]) -> Vec<i64> {
  let mut cleaned = offsets.iter().copied().filter(|v| *v >= 0).collect::<Vec<_>>();
  cleaned.sort_by(|a, b| b.cmp(a));
  cleaned.dedup();
  if cleaned.is_empty() {
    vec![1440, 60, 0]
  } else {
    cleaned
  }
}

fn compute_initial_schedule(due_at: &str, offsets: &[i64], now: DateTime<Utc>) -> Result<(i64, Option<String>)> {
  if offsets.is_empty() {
    return Ok((0, None));
  }

  let due = parse_datetime(due_at)?;
  for (index, offset) in offsets.iter().enumerate() {
    let candidate = due - Duration::minutes(*offset);
    if candidate >= now {
      return Ok((index as i64, Some(candidate.to_rfc3339())));
    }
  }

  if due >= now {
    Ok(((offsets.len() - 1) as i64, Some(due.to_rfc3339())))
  } else {
    Ok(((offsets.len() - 1) as i64, Some(now.to_rfc3339())))
  }
}

fn parse_offsets(raw: &str) -> Vec<i64> {
  serde_json::from_str::<Vec<i64>>(raw)
    .ok()
    .map(|v| normalize_offsets(&v))
    .unwrap_or_else(|| vec![1440, 60, 0])
}

fn row_to_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<CalendarItem> {
  let offsets_raw: String = row.get("remind_offsets")?;
  let note: Option<String> = row.get("note")?;
  let start_at: Option<String> = row.get("start_at")?;
  let created_at: String = row.get("created_at")?;
  let todo_anchor_at: Option<String> = row.get("todo_anchor_at")?;
  Ok(CalendarItem {
    id: row.get("id")?,
    item_type: row.get("item_type")?,
    title: row.get("title")?,
    note: note.unwrap_or_default(),
    start_at,
    due_at: row.get("due_at")?,
    estimated_hours: row.get("estimated_hours")?,
    daily_hours_override: row.get("daily_hours_override")?,
    has_complex_plan: row.get::<_, i64>("has_complex_plan")? == 1,
    done: row.get::<_, i64>("done")? == 1,
    remind_enabled: row.get::<_, i64>("remind_enabled")? == 1,
    remind_offsets: parse_offsets(&offsets_raw),
    reminder_cursor: row.get("reminder_cursor")?,
    next_remind_at: row.get("next_remind_at")?,
    postpone_used: row.get::<_, i64>("postpone_used")? == 1,
    todo_overdue_days: row.get("todo_overdue_days")?,
    todo_anchor_at: todo_anchor_at.unwrap_or_else(|| created_at.clone()),
    created_at,
    updated_at: row.get("updated_at")?,
  })
}

pub fn init(db_path: &Path) -> Result<()> {
  let conn = open_conn(db_path)?;
  conn.execute_batch(
    "
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_type TEXT NOT NULL,
      title TEXT NOT NULL,
      note TEXT,
      start_at TEXT,
      due_at TEXT NOT NULL,
      estimated_hours REAL,
      daily_hours_override REAL,
      done INTEGER NOT NULL DEFAULT 0,
      remind_enabled INTEGER NOT NULL DEFAULT 1,
      remind_offsets TEXT NOT NULL DEFAULT '[1440,60,0]',
      reminder_cursor INTEGER NOT NULL DEFAULT 0,
      next_remind_at TEXT,
      postpone_used INTEGER NOT NULL DEFAULT 0,
      todo_overdue_days INTEGER NOT NULL DEFAULT 3,
      todo_anchor_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS item_daily_plan (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL,
      plan_date TEXT NOT NULL,
      hours REAL NOT NULL CHECK (hours > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(item_id, plan_date),
      FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      reminder_mode TEXT NOT NULL DEFAULT 'toast_sound',
      default_offsets TEXT NOT NULL DEFAULT '[1440,60,0]',
      autostart INTEGER NOT NULL DEFAULT 1,
      close_to_tray INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    ",
  )?;

  add_column_if_missing(&conn, "items", "postpone_used", "postpone_used INTEGER NOT NULL DEFAULT 0")?;
  add_column_if_missing(
    &conn,
    "items",
    "todo_overdue_days",
    "todo_overdue_days INTEGER NOT NULL DEFAULT 3",
  )?;
  add_column_if_missing(&conn, "items", "todo_anchor_at", "todo_anchor_at TEXT")?;
  add_column_if_missing(&conn, "items", "start_at", "start_at TEXT")?;
  add_column_if_missing(&conn, "items", "estimated_hours", "estimated_hours REAL")?;
  add_column_if_missing(&conn, "items", "daily_hours_override", "daily_hours_override REAL")?;
  conn.execute(
    "UPDATE items SET item_type = 'todo' WHERE item_type = 'event' OR item_type NOT IN ('todo', 'ddl')",
    [],
  )?;
  conn.execute(
    "UPDATE items SET todo_overdue_days = ?1 WHERE todo_overdue_days IS NULL OR todo_overdue_days < 1",
    params![DEFAULT_TODO_OVERDUE_DAYS],
  )?;
  conn.execute(
    "UPDATE items SET todo_anchor_at = COALESCE(todo_anchor_at, created_at, updated_at) WHERE todo_anchor_at IS NULL OR todo_anchor_at = ''",
    [],
  )?;

  let exists: Option<i64> = conn
    .query_row("SELECT id FROM settings WHERE id = 1", [], |r| r.get(0))
    .optional()?;
  if exists.is_none() {
    conn.execute(
      "INSERT INTO settings (id, reminder_mode, default_offsets, autostart, close_to_tray, updated_at) VALUES (1, 'toast_sound', '[1440,60,0]', 1, 1, ?1)",
      params![now_iso()],
    )?;
  }
  Ok(())
}

pub fn get_settings(db_path: &Path) -> Result<ReminderSettings> {
  let conn = open_conn(db_path)?;
  let settings = conn.query_row(
    "SELECT reminder_mode, default_offsets, autostart, close_to_tray FROM settings WHERE id = 1",
    [],
    |row| {
      let offsets_raw: String = row.get(1)?;
      Ok(ReminderSettings {
        reminder_mode: row.get(0)?,
        default_offsets: parse_offsets(&offsets_raw),
        autostart: row.get::<_, i64>(2)? == 1,
        close_to_tray: row.get::<_, i64>(3)? == 1,
      })
    },
  )?;
  Ok(settings)
}

pub fn update_settings(db_path: &Path, payload: &SettingsPayload) -> Result<ReminderSettings> {
  let conn = open_conn(db_path)?;
  let current = get_settings(db_path)?;
  let next_mode = payload
    .reminder_mode
    .clone()
    .unwrap_or_else(|| current.reminder_mode.clone());
  let next_offsets = payload
    .default_offsets
    .clone()
    .map(|v| normalize_offsets(&v))
    .unwrap_or_else(|| current.default_offsets.clone());
  let next_autostart = payload.autostart.unwrap_or(current.autostart);
  let next_close = payload.close_to_tray.unwrap_or(current.close_to_tray);

  conn.execute(
    "UPDATE settings SET reminder_mode = ?1, default_offsets = ?2, autostart = ?3, close_to_tray = ?4, updated_at = ?5 WHERE id = 1",
    params![
      next_mode,
      serde_json::to_string(&next_offsets)?,
      if next_autostart { 1 } else { 0 },
      if next_close { 1 } else { 0 },
      now_iso()
    ],
  )?;
  get_settings(db_path)
}

pub fn list_items(
  db_path: &Path,
  range: Option<DateRange>,
  item_type: Option<String>,
  status: Option<String>,
  search: Option<String>,
) -> Result<Vec<CalendarItem>> {
  let conn = open_conn(db_path)?;
  let mut statement = conn.prepare(
    "SELECT items.id, items.item_type, items.title, items.note, items.start_at, items.due_at, items.estimated_hours, items.daily_hours_override, items.done, items.remind_enabled, items.remind_offsets, items.reminder_cursor, items.next_remind_at, items.postpone_used, items.todo_overdue_days, items.todo_anchor_at, items.created_at, items.updated_at,
            COALESCE((SELECT 1 FROM item_daily_plan plan WHERE plan.item_id = items.id LIMIT 1), 0) AS has_complex_plan
     FROM items
     ORDER BY due_at ASC",
  )?;
  let mapped = statement
    .query_map([], row_to_item)?
    .collect::<rusqlite::Result<Vec<_>>>()?;

  let lower_search = search.map(|s| s.to_lowercase());
  let filtered = mapped
    .into_iter()
    .filter(|item| {
      if let Some(ref item_type) = item_type {
        if item.item_type != *item_type {
          return false;
        }
      }

      if let Some(ref status) = status {
        if (status == "done" && !item.done) || (status == "undone" && item.done) {
          return false;
        }
      }

      if let Some(ref r) = range {
        if let Some(ref start) = r.start {
          if item.due_at < *start {
            return false;
          }
        }
        if let Some(ref end) = r.end {
          if item.due_at > *end {
            return false;
          }
        }
      }

      if let Some(ref needle) = lower_search {
        let title = item.title.to_lowercase();
        let note = item.note.to_lowercase();
        if !title.contains(needle) && !note.contains(needle) {
          return false;
        }
      }
      true
    })
    .collect::<Vec<_>>();

  Ok(filtered)
}

pub fn create_item(db_path: &Path, payload: &ItemPayload) -> Result<CalendarItem> {
  validate_item_payload(payload)?;
  let conn = open_conn(db_path)?;
  let settings = get_settings(db_path)?;
  let now = Utc::now();
  let todo_overdue_days = normalize_todo_overdue_days(payload.todo_overdue_days);
  let offsets = payload
    .remind_offsets
    .clone()
    .map(|v| normalize_offsets(&v))
    .unwrap_or_else(|| settings.default_offsets.clone());
  let (cursor, next_remind_at) = if payload.remind_enabled {
    compute_initial_schedule(&payload.due_at, &offsets, now)?
  } else {
    (0, None)
  };

  let now_text = now.to_rfc3339();
  conn.execute(
    "INSERT INTO items (item_type, title, note, start_at, due_at, estimated_hours, daily_hours_override, done, remind_enabled, remind_offsets, reminder_cursor, next_remind_at, postpone_used, todo_overdue_days, todo_anchor_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, ?10, ?11, 0, ?12, ?13, ?13, ?13)",
    params![
      payload.item_type,
      payload.title,
      payload.note.clone().unwrap_or_default(),
      payload.start_at,
      payload.due_at,
      payload.estimated_hours,
      payload.daily_hours_override,
      if payload.remind_enabled { 1 } else { 0 },
      serde_json::to_string(&offsets)?,
      cursor,
      next_remind_at,
      todo_overdue_days,
      now_text,
    ],
  )?;
  let id = conn.last_insert_rowid();
  get_item_by_id(db_path, id)
}

pub fn update_item(db_path: &Path, id: i64, payload: &ItemPayload) -> Result<CalendarItem> {
  validate_item_payload(payload)?;
  let conn = open_conn(db_path)?;
  let existing = get_item_by_id(db_path, id)?;
  let settings = get_settings(db_path)?;
  let now_text = now_iso();
  let todo_overdue_days = normalize_todo_overdue_days(payload.todo_overdue_days);
  let offsets = payload
    .remind_offsets
    .clone()
    .map(|v| normalize_offsets(&v))
    .unwrap_or_else(|| settings.default_offsets.clone());

  let (cursor, next_remind_at) = if payload.remind_enabled && !existing.done {
    compute_initial_schedule(&payload.due_at, &offsets, Utc::now())?
  } else {
    (0, None)
  };
  let todo_anchor_at = if payload.item_type == "todo" && existing.item_type != "todo" {
    now_text.clone()
  } else if existing.todo_anchor_at.is_empty() {
    existing.created_at.clone()
  } else {
    existing.todo_anchor_at.clone()
  };
  let postpone_used = if payload.item_type == "ddl" && existing.item_type == "ddl" {
    existing.postpone_used
  } else {
    false
  };

  conn.execute(
    "UPDATE items
     SET item_type = ?1, title = ?2, note = ?3, start_at = ?4, due_at = ?5, estimated_hours = ?6, daily_hours_override = ?7, remind_enabled = ?8, remind_offsets = ?9, reminder_cursor = ?10, next_remind_at = ?11, postpone_used = ?12, todo_overdue_days = ?13, todo_anchor_at = ?14, updated_at = ?15
     WHERE id = ?16",
    params![
      payload.item_type,
      payload.title,
      payload.note.clone().unwrap_or_default(),
      payload.start_at,
      payload.due_at,
      payload.estimated_hours,
      payload.daily_hours_override,
      if payload.remind_enabled { 1 } else { 0 },
      serde_json::to_string(&offsets)?,
      cursor,
      next_remind_at,
      if postpone_used { 1 } else { 0 },
      todo_overdue_days,
      todo_anchor_at,
      now_text,
      id,
    ],
  )?;
  get_item_by_id(db_path, id)
}

pub fn delete_item(db_path: &Path, id: i64) -> Result<()> {
  let conn = open_conn(db_path)?;
  conn.execute("DELETE FROM items WHERE id = ?1", params![id])?;
  Ok(())
}

pub fn get_item_by_id(db_path: &Path, id: i64) -> Result<CalendarItem> {
  let conn = open_conn(db_path)?;
  let mut statement = conn.prepare(
    "SELECT items.id, items.item_type, items.title, items.note, items.start_at, items.due_at, items.estimated_hours, items.daily_hours_override, items.done, items.remind_enabled, items.remind_offsets, items.reminder_cursor, items.next_remind_at, items.postpone_used, items.todo_overdue_days, items.todo_anchor_at, items.created_at, items.updated_at,
            COALESCE((SELECT 1 FROM item_daily_plan plan WHERE plan.item_id = items.id LIMIT 1), 0) AS has_complex_plan
     FROM items
     WHERE items.id = ?1",
  )?;
  let item = statement.query_row(params![id], row_to_item)?;
  Ok(item)
}

pub fn get_item_daily_plan(db_path: &Path, item_id: i64) -> Result<Vec<DailyPlanEntry>> {
  let conn = open_conn(db_path)?;
  let mut statement = conn.prepare(
    "SELECT plan_date, hours
     FROM item_daily_plan
     WHERE item_id = ?1
     ORDER BY plan_date ASC",
  )?;
  let rows = statement.query_map(params![item_id], |row| {
    Ok(DailyPlanEntry {
      plan_date: row.get(0)?,
      hours: row.get(1)?,
    })
  })?;

  Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn replace_item_daily_plan(
  db_path: &Path,
  item_id: i64,
  entries: &[DailyPlanEntryInput],
) -> Result<Vec<DailyPlanEntry>> {
  if entries.is_empty() {
    return Err(anyhow!("daily plan entries cannot be empty"));
  }

  let item = get_item_by_id(db_path, item_id)?;
  let start_at = item
    .start_at
    .as_deref()
    .ok_or_else(|| anyhow!("item start_at is required before creating complex plan"))?;
  let start_date = parse_date(start_at)?;
  let due_date = due_date_from_due_at(&item.due_at)?;
  if start_date > due_date {
    return Err(anyhow!("item start_at cannot be later than due_at"));
  }

  let mut seen_dates = HashSet::new();
  let mut normalized_entries = Vec::with_capacity(entries.len());
  let mut total_hours = 0.0_f64;
  for entry in entries {
    let date = parse_date(&entry.plan_date)?;
    if date < start_date || date > due_date {
      return Err(anyhow!(
        "plan_date {} is outside item range {}..{}",
        entry.plan_date,
        start_date.format(DATE_FORMAT),
        due_date.format(DATE_FORMAT)
      ));
    }
    if entry.hours <= 0.0 {
      return Err(anyhow!("daily plan hours must be > 0"));
    }
    let key = date.format(DATE_FORMAT).to_string();
    if !seen_dates.insert(key.clone()) {
      return Err(anyhow!("duplicate plan_date in payload: {key}"));
    }
    total_hours += entry.hours;
    normalized_entries.push((key, entry.hours));
  }

  let conn = open_conn(db_path)?;
  let now_text = now_iso();
  let tx = conn.unchecked_transaction()?;
  tx.execute("DELETE FROM item_daily_plan WHERE item_id = ?1", params![item_id])?;
  {
    let mut insert = tx.prepare(
      "INSERT INTO item_daily_plan (item_id, plan_date, hours, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)",
    )?;
    for (plan_date, hours) in &normalized_entries {
      insert.execute(params![item_id, plan_date, hours, now_text])?;
    }
  }
  tx.execute(
    "UPDATE items
     SET estimated_hours = ?1, updated_at = ?2
     WHERE id = ?3",
    params![total_hours, now_text, item_id],
  )?;
  tx.commit()?;

  get_item_daily_plan(db_path, item_id)
}

pub fn clear_item_daily_plan(db_path: &Path, item_id: i64) -> Result<()> {
  let conn = open_conn(db_path)?;
  let now_text = now_iso();
  conn.execute(
    "DELETE FROM item_daily_plan WHERE item_id = ?1",
    params![item_id],
  )?;
  conn.execute(
    "UPDATE items SET updated_at = ?1 WHERE id = ?2",
    params![now_text, item_id],
  )?;
  Ok(())
}

pub fn mark_item_done(db_path: &Path, id: i64, done: bool) -> Result<CalendarItem> {
  let conn = open_conn(db_path)?;
  let existing = get_item_by_id(db_path, id)?;
  let (cursor, next) = if done || !existing.remind_enabled {
    (existing.reminder_cursor, None)
  } else {
    compute_initial_schedule(&existing.due_at, &existing.remind_offsets, Utc::now())?
  };

  conn.execute(
    "UPDATE items SET done = ?1, reminder_cursor = ?2, next_remind_at = ?3, updated_at = ?4 WHERE id = ?5",
    params![if done { 1 } else { 0 }, cursor, next, now_iso(), id],
  )?;
  get_item_by_id(db_path, id)
}

pub fn snooze_item(db_path: &Path, id: i64, minutes: i64) -> Result<CalendarItem> {
  let conn = open_conn(db_path)?;
  let existing = get_item_by_id(db_path, id)?;
  if existing.item_type != "ddl" {
    return Err(anyhow!("only ddl items can be postponed"));
  }
  if existing.postpone_used {
    return Err(anyhow!("ddl can only be postponed once"));
  }

  let now = Utc::now();
  let delay_minutes = minutes.max(1);
  let due = parse_datetime(&existing.due_at)?;
  let base = if due > now { due } else { now };
  let next_due = (base + Duration::minutes(delay_minutes)).to_rfc3339();
  let (next_cursor, next_remind_at) = if existing.remind_enabled {
    compute_initial_schedule(&next_due, &existing.remind_offsets, now)?
  } else {
    (existing.reminder_cursor, None)
  };

  conn.execute(
    "UPDATE items SET done = 0, due_at = ?1, postpone_used = 1, reminder_cursor = ?2, next_remind_at = ?3, updated_at = ?4 WHERE id = ?5",
    params![next_due, next_cursor, next_remind_at, now_iso(), id],
  )?;
  get_item_by_id(db_path, id)
}

pub fn promote_overdue_ddls(db_path: &Path, now: DateTime<Utc>) -> Result<usize> {
  let conn = open_conn(db_path)?;
  let now_text = now.to_rfc3339();
  let affected = conn.execute(
    "UPDATE items
     SET item_type = 'todo',
         postpone_used = 0,
         todo_anchor_at = ?1,
         next_remind_at = CASE WHEN remind_enabled = 1 THEN ?1 ELSE NULL END,
         updated_at = ?1
     WHERE item_type = 'ddl' AND done = 0 AND due_at <= ?1",
    params![now_text],
  )?;
  Ok(affected)
}

pub fn collect_due_alerts(db_path: &Path, now: DateTime<Utc>) -> Result<Vec<ReminderAlert>> {
  let conn = open_conn(db_path)?;
  let now_text = now.to_rfc3339();
  let mut statement = conn.prepare(
    "SELECT id, item_type, title, due_at, remind_offsets, reminder_cursor, next_remind_at, postpone_used
     FROM items
     WHERE done = 0 AND remind_enabled = 1 AND next_remind_at IS NOT NULL AND next_remind_at <= ?1
     ORDER BY next_remind_at ASC",
  )?;

  let rows = statement.query_map(params![now_text], |row| {
    let id: i64 = row.get(0)?;
    let item_type: String = row.get(1)?;
    let title: String = row.get(2)?;
    let due_at: String = row.get(3)?;
    let offsets_raw: String = row.get(4)?;
    let cursor: i64 = row.get(5)?;
    let trigger: String = row.get(6)?;
    let postpone_used: bool = row.get::<_, i64>(7)? == 1;
    Ok((id, item_type, title, due_at, parse_offsets(&offsets_raw), cursor, trigger, postpone_used))
  })?;

  let mut alerts = Vec::new();
  for row in rows {
    let (id, item_type, title, due_at, offsets, cursor, trigger_at, postpone_used) = row?;
    let due = parse_datetime(&due_at)?;
    let mut next_cursor = (cursor + 1).max(0) as usize;
    let mut next_time = None;
    while next_cursor < offsets.len() {
      let candidate = due - Duration::minutes(offsets[next_cursor]);
      if candidate > now {
        next_time = Some(candidate.to_rfc3339());
        break;
      }
      next_cursor += 1;
    }

    conn.execute(
      "UPDATE items SET reminder_cursor = ?1, next_remind_at = ?2, updated_at = ?3 WHERE id = ?4",
      params![
        (next_cursor.min(offsets.len().saturating_sub(1))) as i64,
        next_time,
        now_iso(),
        id
      ],
    )?;

    alerts.push(ReminderAlert {
      id: Uuid::new_v4().to_string(),
      item_id: id,
      item_type,
      title,
      due_at,
      postpone_used,
      trigger_at,
    });
  }
  Ok(alerts)
}

#[cfg(test)]
mod tests {
  use std::path::PathBuf;

  use chrono::Utc;
  use uuid::Uuid;

  use crate::models::{DailyPlanEntryInput, ItemPayload};

  use super::{
    clear_item_daily_plan,
    compute_initial_schedule,
    ensure_valid_item_type,
    get_item_by_id,
    get_item_daily_plan,
    init,
    normalize_offsets,
    normalize_todo_overdue_days,
    replace_item_daily_plan,
    validate_item_payload,
    DEFAULT_TODO_OVERDUE_DAYS,
  };

  fn temp_db_path(prefix: &str) -> PathBuf {
    std::env::temp_dir().join(format!("windows-calendar-{prefix}-{}.db", Uuid::new_v4()))
  }

  #[test]
  fn offsets_are_sorted_and_unique() {
    let offsets = normalize_offsets(&[60, 1440, 60, 0, -1]);
    assert_eq!(offsets, vec![1440, 60, 0]);
  }

  #[test]
  fn initial_schedule_picks_first_future_trigger() {
    let now = Utc::now();
    let due = (now + chrono::Duration::hours(30)).to_rfc3339();
    let (cursor, next) = compute_initial_schedule(&due, &[1440, 60, 0], now).expect("schedule");
    assert_eq!(cursor, 0);
    assert!(next.is_some());
  }

  #[test]
  fn item_type_validation_blocks_unknown_types() {
    assert!(ensure_valid_item_type("todo").is_ok());
    assert!(ensure_valid_item_type("ddl").is_ok());
    assert!(ensure_valid_item_type("event").is_err());
  }

  #[test]
  fn todo_overdue_days_has_minimum_one_day() {
    assert_eq!(normalize_todo_overdue_days(None), DEFAULT_TODO_OVERDUE_DAYS);
    assert_eq!(normalize_todo_overdue_days(Some(0)), 1);
    assert_eq!(normalize_todo_overdue_days(Some(7)), 7);
  }

  #[test]
  fn validate_item_payload_requires_schedule_fields() {
    let payload = ItemPayload {
      item_type: "todo".to_string(),
      title: "Plan".to_string(),
      note: None,
      start_at: "2026-04-16".to_string(),
      due_at: "2026-04-18T08:00:00.000Z".to_string(),
      estimated_hours: 6.0,
      daily_hours_override: Some(2.0),
      remind_enabled: true,
      remind_offsets: Some(vec![60, 0]),
      todo_overdue_days: Some(2),
    };
    assert!(validate_item_payload(&payload).is_ok());

    let mut invalid = payload.clone();
    invalid.start_at = "bad-date".to_string();
    assert!(validate_item_payload(&invalid).is_err());
  }

  #[test]
  fn complex_plan_replaces_and_syncs_estimated_hours() {
    let db_path = temp_db_path("complex-plan");
    init(&db_path).expect("init");

    let payload = ItemPayload {
      item_type: "todo".to_string(),
      title: "Study".to_string(),
      note: None,
      start_at: "2026-04-16".to_string(),
      due_at: "2026-04-18T08:00:00.000Z".to_string(),
      estimated_hours: 9.0,
      daily_hours_override: None,
      remind_enabled: false,
      remind_offsets: Some(vec![60, 0]),
      todo_overdue_days: Some(3),
    };
    let item = super::create_item(&db_path, &payload).expect("create");
    let entries = vec![
      DailyPlanEntryInput {
        plan_date: "2026-04-16".to_string(),
        hours: 2.0,
      },
      DailyPlanEntryInput {
        plan_date: "2026-04-17".to_string(),
        hours: 3.5,
      },
    ];

    let saved = replace_item_daily_plan(&db_path, item.id, &entries).expect("replace");
    assert_eq!(saved.len(), 2);
    let refreshed = get_item_by_id(&db_path, item.id).expect("item");
    assert_eq!(refreshed.estimated_hours, Some(5.5));
    assert!(refreshed.has_complex_plan);

    clear_item_daily_plan(&db_path, item.id).expect("clear");
    let cleared = get_item_daily_plan(&db_path, item.id).expect("get");
    assert!(cleared.is_empty());
  }

  #[test]
  fn complex_plan_rejects_dates_outside_item_range() {
    let db_path = temp_db_path("complex-plan-range");
    init(&db_path).expect("init");

    let payload = ItemPayload {
      item_type: "ddl".to_string(),
      title: "Prepare".to_string(),
      note: None,
      start_at: "2026-04-16".to_string(),
      due_at: "2026-04-18T08:00:00.000Z".to_string(),
      estimated_hours: 4.0,
      daily_hours_override: None,
      remind_enabled: false,
      remind_offsets: Some(vec![60, 0]),
      todo_overdue_days: Some(3),
    };
    let item = super::create_item(&db_path, &payload).expect("create");
    let bad_entries = vec![DailyPlanEntryInput {
      plan_date: "2026-04-19".to_string(),
      hours: 2.0,
    }];
    assert!(replace_item_daily_plan(&db_path, item.id, &bad_entries).is_err());
  }
}
