import { invoke } from '@tauri-apps/api/core'

import type {
  CalendarItem,
  DailyPlanEntry,
  DailyPlanEntryPayload,
  ItemPayload,
  ReminderSettings,
  SettingsPayload,
} from './types'

export async function listItems(
  itemType: string | null = null,
  status: string | null = null,
  search: string | null = null,
): Promise<CalendarItem[]> {
  return invoke<CalendarItem[]>('list_items', {
    range: null,
    item_type: itemType,
    status,
    search,
  })
}

export async function createItem(payload: ItemPayload): Promise<CalendarItem> {
  return invoke<CalendarItem>('create_item', { payload })
}

export async function updateItem(id: number, payload: ItemPayload): Promise<CalendarItem> {
  return invoke<CalendarItem>('update_item', { id, payload })
}

export async function deleteItem(id: number): Promise<void> {
  return invoke<void>('delete_item', { id })
}

export async function markItemDone(id: number, done: boolean): Promise<CalendarItem> {
  return invoke<CalendarItem>('mark_item_done', { id, done })
}

export async function snoozeItem(id: number, minutes: number): Promise<CalendarItem> {
  return invoke<CalendarItem>('snooze_item', { id, minutes })
}

export async function getSettings(): Promise<ReminderSettings> {
  return invoke<ReminderSettings>('get_settings')
}

export async function updateSettings(payload: SettingsPayload): Promise<ReminderSettings> {
  return invoke<ReminderSettings>('update_settings', { payload })
}

export async function getItemDailyPlan(itemId: number): Promise<DailyPlanEntry[]> {
  return invoke<DailyPlanEntry[]>('get_item_daily_plan', { item_id: itemId })
}

export async function replaceItemDailyPlan(
  itemId: number,
  entries: DailyPlanEntryPayload[],
): Promise<DailyPlanEntry[]> {
  return invoke<DailyPlanEntry[]>('replace_item_daily_plan', { item_id: itemId, entries })
}

export async function clearItemDailyPlan(itemId: number): Promise<void> {
  return invoke<void>('clear_item_daily_plan', { item_id: itemId })
}

export async function minimizeToOrb(): Promise<void> {
  return invoke<void>('minimize_to_orb')
}

export async function restoreFromOrb(): Promise<void> {
  return invoke<void>('restore_from_orb')
}

export async function quitApp(): Promise<void> {
  return invoke<void>('quit_app')
}
