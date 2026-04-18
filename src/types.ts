export type PageTab = 'calendar' | 'daily' | 'todo' | 'ddl'
export type CalendarView = 'month' | 'week'
export type ItemType = 'todo' | 'ddl'
export type StatusFilter = 'all' | 'undone' | 'done'

export interface CalendarItem {
  id: number
  type: ItemType
  title: string
  note: string
  start_at: string | null
  due_at: string
  estimated_hours: number | null
  daily_hours_override: number | null
  has_complex_plan: boolean
  done: boolean
  remind_enabled: boolean
  remind_offsets: number[]
  reminder_cursor: number
  next_remind_at: string | null
  postpone_used: boolean
  todo_overdue_days: number
  todo_anchor_at: string
  created_at: string
  updated_at: string
}

export interface ReminderSettings {
  reminder_mode: 'toast_sound' | 'toast_only' | 'in_app_only'
  default_offsets: number[]
  autostart: boolean
  close_to_tray: boolean
}

export interface ItemPayload {
  type: ItemType
  title: string
  note?: string
  start_at: string
  due_at: string
  estimated_hours: number
  daily_hours_override?: number | null
  remind_enabled: boolean
  remind_offsets?: number[]
  todo_overdue_days?: number
}

export interface SettingsPayload {
  reminder_mode?: ReminderSettings['reminder_mode']
  default_offsets?: number[]
  autostart?: boolean
  close_to_tray?: boolean
}

export interface ReminderAlert {
  id: string
  item_id: number
  item_type: ItemType
  title: string
  due_at: string
  postpone_used: boolean
  trigger_at: string
}

export interface DailyPlanEntry {
  plan_date: string
  hours: number
}

export interface DailyPlanEntryPayload {
  plan_date: string
  hours: number
}
