import type { CalendarItem, StatusFilter } from './types'

export interface DayWorkloadSummary {
  score: number
  plannedHours: number
  ddlCount: number
  todoCount: number
  taskCount: number
}

const WORKLOAD_SCORE_WEIGHTS = {
  ddl: 5,
  todo: 1,
  plannedHours: 0.5,
} as const

function dayStart(input: Date): Date {
  const next = new Date(input)
  next.setHours(0, 0, 0, 0)
  return next
}

function daysBetween(start: Date, end: Date): number {
  const delta = dayStart(end).getTime() - dayStart(start).getTime()
  return Math.floor(delta / 86_400_000)
}

export function dateKeyFromIso(iso: string): string {
  const date = new Date(iso)
  const y = date.getFullYear()
  const m = `${date.getMonth() + 1}`.padStart(2, '0')
  const d = `${date.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function localInputFromIso(iso: string): string {
  const date = new Date(iso)
  const tzOffset = date.getTimezoneOffset() * 60_000
  const localDate = new Date(date.getTime() - tzOffset)
  return localDate.toISOString().slice(0, 16)
}

export function isoFromLocalInput(localDateTime: string): string {
  return new Date(localDateTime).toISOString()
}

export function formatDue(iso: string): string {
  return new Date(iso).toLocaleString()
}

export function formatDateOnly(input: Date): string {
  return `${input.getFullYear()}-${`${input.getMonth() + 1}`.padStart(2, '0')}-${`${input.getDate()}`.padStart(2, '0')}`
}

export function dateFromDateKey(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00`)
}

export function monthMatrix(baseDate: Date): Date[] {
  const first = new Date(baseDate.getFullYear(), baseDate.getMonth(), 1)
  const daysInMonth = new Date(baseDate.getFullYear(), baseDate.getMonth() + 1, 0).getDate()
  const firstWeekday = (first.getDay() + 6) % 7
  const neededCells = firstWeekday + daysInMonth
  const gridStart = new Date(first)
  if (neededCells <= 35) {
    gridStart.setDate(first.getDate() - firstWeekday)
  }
  return Array.from({ length: 35 }, (_, index) => {
    const day = new Date(gridStart)
    day.setDate(gridStart.getDate() + index)
    return day
  })
}

export function weekDays(selected: Date): Date[] {
  const mondayOffset = (selected.getDay() + 6) % 7
  const monday = new Date(selected)
  monday.setDate(selected.getDate() - mondayOffset)
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(monday)
    day.setDate(monday.getDate() + index)
    return day
  })
}

export function itemsForDate(items: CalendarItem[], date: Date): CalendarItem[] {
  const key = `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`
  return items.filter((item) => dateKeyFromIso(item.due_at) === key)
}

export function activeDaysInclusive(startAt: string, dueAtIso: string): number {
  const start = dateFromDateKey(startAt)
  const due = dateFromDateKey(dateKeyFromIso(dueAtIso))
  return Math.max(1, daysBetween(start, due) + 1)
}

export function autoDailyHours(item: CalendarItem): number {
  if (!item.start_at || !item.estimated_hours || item.estimated_hours <= 0) {
    return 0
  }
  return item.estimated_hours / activeDaysInclusive(item.start_at, item.due_at)
}

export function itemCoversDate(item: CalendarItem, targetDateKey: string): boolean {
  if (!item.start_at) {
    return false
  }
  const dueKey = dateKeyFromIso(item.due_at)
  return item.start_at <= targetDateKey && targetDateKey <= dueKey
}

export function plannedHoursForDate(
  item: CalendarItem,
  _targetDateKey: string,
  complexPlanHours?: number,
): number {
  if (typeof complexPlanHours === 'number') {
    return complexPlanHours
  }
  if (typeof item.daily_hours_override === 'number' && item.daily_hours_override > 0) {
    return item.daily_hours_override
  }
  return autoDailyHours(item)
}

export function calculateDayWorkloadSummary(
  items: CalendarItem[],
  targetDateKey: string,
  complexPlanCache: Record<number, Record<string, number>> = {},
): DayWorkloadSummary {
  const activeItems = items.filter(
    (item) =>
      !item.done &&
      !!item.start_at &&
      !!item.estimated_hours &&
      item.estimated_hours > 0 &&
      itemCoversDate(item, targetDateKey),
  )

  const plannedHours = activeItems.reduce((sum, item) => {
    const complexPlanHours = complexPlanCache[item.id]?.[targetDateKey]
    return sum + plannedHoursForDate(item, targetDateKey, complexPlanHours)
  }, 0)

  const ddlCount = activeItems.filter((item) => item.type === 'ddl').length
  const todoCount = activeItems.length - ddlCount
  const score =
    ddlCount * WORKLOAD_SCORE_WEIGHTS.ddl +
    todoCount * WORKLOAD_SCORE_WEIGHTS.todo +
    plannedHours * WORKLOAD_SCORE_WEIGHTS.plannedHours

  return {
    score,
    plannedHours,
    ddlCount,
    todoCount,
    taskCount: activeItems.length,
  }
}

export function applyListFilters(
  items: CalendarItem[],
  status: StatusFilter,
  search: string,
): CalendarItem[] {
  const needle = search.trim().toLowerCase()
  return items.filter((item) => {
    if (status === 'done' && !item.done) return false
    if (status === 'undone' && item.done) return false
    if (!needle) return true
    return (
      item.title.toLowerCase().includes(needle) ||
      item.note.toLowerCase().includes(needle)
    )
  })
}

export function overdueDays(item: CalendarItem, today: Date = new Date()): number {
  const anchor = new Date(item.todo_anchor_at)
  return Math.max(0, daysBetween(anchor, today))
}

export function isTodoOverdue(item: CalendarItem, today: Date = new Date()): boolean {
  if (item.type !== 'todo' || item.done) {
    return false
  }
  return overdueDays(item, today) >= Math.max(1, item.todo_overdue_days)
}

export function hasTodoTrailOnDate(
  item: CalendarItem,
  date: Date,
  today: Date = new Date(),
): boolean {
  if (item.type !== 'todo' || item.done) {
    return false
  }
  const day = dayStart(date)
  const start = dayStart(new Date(item.todo_anchor_at))
  const end = dayStart(today)
  if (start > end) {
    return false
  }
  return day >= start && day <= end
}

export function hasDdlTrailOnDate(
  item: CalendarItem,
  date: Date,
  today: Date = new Date(),
): boolean {
  if (item.type !== 'ddl' || item.done) {
    return false
  }
  const day = dayStart(date)
  const start = dayStart(today)
  const end = dayStart(new Date(item.due_at))
  if (end < start) {
    return false
  }
  return day >= start && day <= end
}
