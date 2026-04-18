import { describe, expect, it } from 'vitest'

import {
  activeDaysInclusive,
  autoDailyHours,
  applyListFilters,
  calculateDayWorkloadSummary,
  dateKeyFromIso,
  itemCoversDate,
  hasDdlTrailOnDate,
  hasTodoTrailOnDate,
  isTodoOverdue,
  monthMatrix,
  overdueDays,
  plannedHoursForDate,
  weekDays,
} from './utils'
import type { CalendarItem } from './types'

const sampleItems: CalendarItem[] = [
  {
    id: 1,
    type: 'todo',
    title: 'Write report',
    note: 'Quarterly summary',
    start_at: '2026-04-10',
    due_at: '2026-04-20T08:00:00.000Z',
    estimated_hours: 12,
    daily_hours_override: null,
    has_complex_plan: false,
    done: false,
    remind_enabled: true,
    remind_offsets: [1440, 60, 0],
    reminder_cursor: 0,
    next_remind_at: null,
    postpone_used: false,
    todo_overdue_days: 3,
    todo_anchor_at: '2026-04-10T08:00:00.000Z',
    created_at: '2026-04-10T08:00:00.000Z',
    updated_at: '2026-04-10T08:00:00.000Z',
  },
  {
    id: 2,
    type: 'ddl',
    title: 'Submit paper',
    note: 'For conference',
    start_at: '2026-04-10',
    due_at: '2026-04-21T12:00:00.000Z',
    estimated_hours: 8,
    daily_hours_override: 1.5,
    has_complex_plan: false,
    done: true,
    remind_enabled: true,
    remind_offsets: [1440, 60, 0],
    reminder_cursor: 0,
    next_remind_at: null,
    postpone_used: false,
    todo_overdue_days: 2,
    todo_anchor_at: '2026-04-10T08:00:00.000Z',
    created_at: '2026-04-10T08:00:00.000Z',
    updated_at: '2026-04-10T08:00:00.000Z',
  },
]

describe('utils', () => {
  it('builds a month matrix of 35 cells', () => {
    const matrix = monthMatrix(new Date('2026-04-10T00:00:00.000Z'))
    expect(matrix).toHaveLength(35)
  })

  it('builds a week array of 7 days', () => {
    const days = weekDays(new Date('2026-04-16T00:00:00.000Z'))
    expect(days).toHaveLength(7)
  })

  it('creates date key from iso', () => {
    expect(dateKeyFromIso('2026-04-16T12:30:00.000Z')).toMatch(/^2026-04-\d{2}$/)
  })

  it('applies status and search filters', () => {
    expect(applyListFilters(sampleItems, 'undone', '').length).toBe(1)
    expect(applyListFilters(sampleItems, 'all', 'paper').length).toBe(1)
  })

  it('calculates overdue todo by anchor date and threshold', () => {
    const today = new Date('2026-04-14T00:00:00.000Z')
    expect(overdueDays(sampleItems[0], today)).toBe(4)
    expect(isTodoOverdue(sampleItems[0], today)).toBe(true)
  })

  it('checks todo trail date range inclusively', () => {
    const today = new Date('2026-04-14T12:00:00.000Z')
    expect(hasTodoTrailOnDate(sampleItems[0], new Date('2026-04-10T00:00:00.000Z'), today)).toBe(true)
    expect(hasTodoTrailOnDate(sampleItems[0], new Date('2026-04-14T00:00:00.000Z'), today)).toBe(true)
    expect(hasTodoTrailOnDate(sampleItems[0], new Date('2026-04-15T00:00:00.000Z'), today)).toBe(false)
  })

  it('checks ddl trail from today to due date', () => {
    const ddl: CalendarItem = {
      ...sampleItems[1],
      done: false,
      due_at: '2026-04-20T12:00:00.000Z',
    }
    const today = new Date('2026-04-16T00:00:00.000Z')
    expect(hasDdlTrailOnDate(ddl, new Date('2026-04-16T00:00:00.000Z'), today)).toBe(true)
    expect(hasDdlTrailOnDate(ddl, new Date('2026-04-20T00:00:00.000Z'), today)).toBe(true)
    expect(hasDdlTrailOnDate(ddl, new Date('2026-04-21T00:00:00.000Z'), today)).toBe(false)
  })

  it('computes active days and auto daily hours', () => {
    expect(activeDaysInclusive('2026-04-10', '2026-04-12T08:00:00.000Z')).toBe(3)
    expect(autoDailyHours(sampleItems[0])).toBeCloseTo(12 / 11, 5)
  })

  it('checks if item covers a target day', () => {
    expect(itemCoversDate(sampleItems[0], '2026-04-15')).toBe(true)
    expect(itemCoversDate(sampleItems[0], '2026-04-21')).toBe(false)
  })

  it('applies planning priority complex > fixed > auto', () => {
    const withFixed = { ...sampleItems[0], daily_hours_override: 2 }
    expect(plannedHoursForDate(withFixed, '2026-04-15', 3.25)).toBe(3.25)
    expect(plannedHoursForDate(withFixed, '2026-04-15')).toBe(2)
    expect(plannedHoursForDate(sampleItems[0], '2026-04-15')).toBeCloseTo(12 / 11, 5)
  })

  it('returns none when day has no active items', () => {
    const summary = calculateDayWorkloadSummary(sampleItems, '2026-04-30')
    expect(summary.score).toBe(0)
    expect(summary.plannedHours).toBe(0)
    expect(summary.ddlCount).toBe(0)
    expect(summary.todoCount).toBe(0)
    expect(summary.taskCount).toBe(0)
  })

  it('computes daily workload score with default weights', () => {
    const summary = calculateDayWorkloadSummary(sampleItems, '2026-04-12')
    expect(summary.plannedHours).toBeCloseTo(12 / 11, 5)
    expect(summary.ddlCount).toBe(0)
    expect(summary.todoCount).toBe(1)
    expect(summary.score).toBeCloseTo(1 + (12 / 11) * 0.5, 5)
    expect(summary.taskCount).toBe(1)
  })

  it('adds score from multiple active items', () => {
    const heavy: CalendarItem = {
      ...sampleItems[0],
      id: 3,
      title: 'Heavy task',
      estimated_hours: 66,
      daily_hours_override: null,
    }
    const summary = calculateDayWorkloadSummary([sampleItems[0], heavy], '2026-04-12')
    expect(summary.plannedHours).toBeCloseTo(12 / 11 + 66 / 11, 5)
    expect(summary.score).toBeCloseTo(2 + (12 / 11 + 66 / 11) * 0.5, 5)
    expect(summary.todoCount).toBe(2)
    expect(summary.taskCount).toBe(2)
  })

  it('uses complex plan first when computing day score', () => {
    const withFixed = { ...sampleItems[0], daily_hours_override: 2 }
    const summary = calculateDayWorkloadSummary(
      [withFixed],
      '2026-04-12',
      {
        1: {
          '2026-04-12': 4.5,
        },
      },
    )
    expect(summary.plannedHours).toBe(4.5)
    expect(summary.score).toBe(1 + 4.5 * 0.5)
  })

  it('does not count done items in day score', () => {
    const doneItem: CalendarItem = {
      ...sampleItems[0],
      id: 8,
      done: true,
      daily_hours_override: 5,
    }
    const summary = calculateDayWorkloadSummary([doneItem], '2026-04-12')
    expect(summary.score).toBe(0)
    expect(summary.plannedHours).toBe(0)
    expect(summary.taskCount).toBe(0)
  })

  it('applies higher weight to ddl than todo', () => {
    const activeDdl: CalendarItem = {
      ...sampleItems[1],
      done: false,
      start_at: '2026-04-10',
      due_at: '2026-04-20T12:00:00.000Z',
      daily_hours_override: 2,
    }
    const summary = calculateDayWorkloadSummary([sampleItems[0], activeDdl], '2026-04-12')
    expect(summary.ddlCount).toBe(1)
    expect(summary.todoCount).toBe(1)
    expect(summary.plannedHours).toBeCloseTo(12 / 11 + 2, 5)
    expect(summary.score).toBeCloseTo(5 + 1 + (12 / 11 + 2) * 0.5, 5)
  })
})
