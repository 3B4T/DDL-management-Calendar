import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type WheelEvent,
} from 'react'
import { emitTo, listen } from '@tauri-apps/api/event'
import {
  Window,
  currentMonitor,
  getCurrentWindow,
  monitorFromPoint,
  PhysicalPosition,
  primaryMonitor,
  type Monitor,
} from '@tauri-apps/api/window'

import {
  clearItemDailyPlan,
  createItem,
  deleteItem,
  getItemDailyPlan,
  getSettings,
  listItems,
  markItemDone,
  minimizeToOrb,
  quitApp,
  replaceItemDailyPlan,
  restoreFromOrb,
  snoozeItem,
  updateItem,
  updateSettings,
} from './api'
import type {
  CalendarItem,
  CalendarView,
  DailyPlanEntryPayload,
  ItemPayload,
  ItemType,
  PageTab,
  ReminderAlert,
  ReminderSettings,
  StatusFilter,
} from './types'
import {
  activeDaysInclusive,
  applyListFilters,
  calculateDayWorkloadSummary,
  dateKeyFromIso,
  formatDateOnly,
  formatDue,
  isTodoOverdue,
  itemCoversDate,
  itemsForDate,
  localInputFromIso,
  monthMatrix,
  overdueDays,
  plannedHoursForDate,
  weekDays,
} from './utils'
import {
  applyDelta,
  clampPositionToBounds,
  isValidWindowPosition,
  parseStoredWindowPosition,
  resolveMoveSyncDecision,
  serializeWindowPosition,
  type BoundsRect,
  type WindowPosition,
  type WindowSize,
} from './window-position-sync'

const TAB_LABELS: Record<PageTab, string> = {
  calendar: '日历',
  daily: '每日计划',
  todo: '近期待办',
  ddl: '未来 DDL',
}

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']

const OFFSET_OPTIONS = [
  { label: '提前 1 天', value: 1440 },
  { label: '提前 1 小时', value: 60 },
  { label: '到点提醒', value: 0 },
]

const DEFAULT_SETTINGS: ReminderSettings = {
  reminder_mode: 'toast_sound',
  default_offsets: [1440, 60, 0],
  autostart: true,
  close_to_tray: true,
}

const DEFAULT_TODO_OVERDUE_DAYS = 3
const DEFAULT_ESTIMATED_HOURS = 6
const WORKLOAD_MIN_COLOR = { r: 124, g: 205, b: 147 }
const WORKLOAD_MAX_COLOR = { r: 231, g: 145, b: 145 }
const MAIN_WINDOW_LABEL = 'main'
const ORB_WINDOW_LABEL = 'orb'
const MAIN_POSITION_STORAGE_KEY = 'windows-calendar:main-position'
const ORB_POSITION_STORAGE_KEY = 'windows-calendar:orb-position'
const WINDOW_POSITION_SYNC_EVENT = 'windows-calendar:sync-window-position'

interface FormState {
  id: number | null
  type: ItemType
  title: string
  note: string
  startAt: string
  dueAt: string
  estimatedHours: string
  dailyHoursOverride: string
  remindEnabled: boolean
  offsets: number[]
  todoOverdueDays: number
  hasComplexPlan: boolean
  originalStartAt: string | null
  originalDueDateKey: string | null
}

interface ComplexPlanRow {
  date: string
  hours: string
}

type DailyPlanCache = Record<number, Record<string, number>>
type HoursSyncSource = 'estimated' | 'daily'

function normalizeOffsets(offsets: number[]): number[] {
  const next = Array.from(new Set(offsets.filter((value) => value >= 0)))
  next.sort((a, b) => b - a)
  return next.length === 0 ? [1440, 60, 0] : next
}

function parsePositiveNumber(input: string): number | null {
  if (!input.trim()) {
    return null
  }
  const parsed = Number(input)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null
  }
  return parsed
}

function formatHoursInput(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1)
}

function dueMetaFromLocalInput(localDateTime: string): { iso: string; dateKey: string } | null {
  if (!localDateTime.trim()) {
    return null
  }
  const parsed = new Date(localDateTime)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  const iso = parsed.toISOString()
  return {
    iso,
    dateKey: dateKeyFromIso(iso),
  }
}

function clamp01(value: number): number {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function interpolateColor(start: number, end: number, ratio: number): number {
  return Math.round(start + (end - start) * clamp01(ratio))
}

function workloadHeatBackground(intensity: number): string {
  const ratio = clamp01(intensity)
  const red = interpolateColor(WORKLOAD_MIN_COLOR.r, WORKLOAD_MAX_COLOR.r, ratio)
  const green = interpolateColor(WORKLOAD_MIN_COLOR.g, WORKLOAD_MAX_COLOR.g, ratio)
  const blue = interpolateColor(WORKLOAD_MIN_COLOR.b, WORKLOAD_MAX_COLOR.b, ratio)
  return `linear-gradient(160deg, rgba(${red}, ${green}, ${blue}, 0.4) 0%, rgba(255, 255, 255, 0.95) 100%)`
}

function eachDateKeyInRange(startAt: string, dueAtIso: string): string[] {
  const dueKey = dateKeyFromIso(dueAtIso)
  const dates: string[] = []
  let cursor = new Date(`${startAt}T00:00:00`)
  const end = new Date(`${dueKey}T00:00:00`)
  while (cursor <= end) {
    dates.push(formatDateOnly(cursor))
    const next = new Date(cursor)
    next.setDate(next.getDate() + 1)
    cursor = next
  }
  return dates
}

function defaultDueInput(selectedDate?: Date): string {
  const base = selectedDate ? new Date(selectedDate) : new Date()
  base.setMinutes(0, 0, 0)
  if (selectedDate) {
    base.setHours(18, 0, 0, 0)
  } else {
    base.setHours(base.getHours() + 1)
  }
  return localInputFromIso(base.toISOString())
}

function emptyForm(
  type: ItemType = 'todo',
  selectedDate?: Date,
  offsets: number[] = [1440, 60, 0],
): FormState {
  const startAt = selectedDate ? formatDateOnly(selectedDate) : formatDateOnly(new Date())
  return {
    id: null,
    type,
    title: '',
    note: '',
    startAt,
    dueAt: defaultDueInput(selectedDate),
    estimatedHours: `${DEFAULT_ESTIMATED_HOURS}`,
    dailyHoursOverride: '',
    remindEnabled: true,
    offsets: normalizeOffsets(offsets),
    todoOverdueDays: DEFAULT_TODO_OVERDUE_DAYS,
    hasComplexPlan: false,
    originalStartAt: null,
    originalDueDateKey: null,
  }
}

type DefaultPositionResolver = (windowHandle: Window) => Promise<WindowPosition | null>

function loadStoredPosition(storageKey: string): WindowPosition | null {
  return parseStoredWindowPosition(localStorage.getItem(storageKey))
}

function saveStoredPosition(storageKey: string, position: WindowPosition) {
  localStorage.setItem(storageKey, serializeWindowPosition(position))
}

function toBoundsRect(monitor: Monitor): BoundsRect {
  const workArea = monitor.workArea
  return {
    x: workArea.position.x,
    y: workArea.position.y,
    width: workArea.size.width,
    height: workArea.size.height,
  }
}

async function getWindowPosition(windowHandle: Window): Promise<WindowPosition | null> {
  try {
    const position = await windowHandle.outerPosition()
    return { x: position.x, y: position.y }
  } catch {
    return null
  }
}

async function resolveMonitorForPosition(
  position: WindowPosition,
): Promise<Monitor | null> {
  const fromPoint = await monitorFromPoint(position.x, position.y).catch(() => null)
  if (fromPoint) {
    return fromPoint
  }
  const fromCurrent = await currentMonitor().catch(() => null)
  if (fromCurrent) {
    return fromCurrent
  }
  return primaryMonitor().catch(() => null)
}

async function clampWindowPosition(
  windowHandle: Window,
  position: WindowPosition,
): Promise<WindowPosition> {
  const [size, monitor] = await Promise.all([
    windowHandle.outerSize().catch(() => null),
    resolveMonitorForPosition(position),
  ])
  if (!size || !monitor) {
    return position
  }
  const windowSize: WindowSize = { width: size.width, height: size.height }
  return clampPositionToBounds(position, windowSize, toBoundsRect(monitor))
}

function useLinkedWindowPositionSync({
  peerWindowLabel,
  currentPositionStorageKey,
  peerPositionStorageKey,
  resolveDefaultPosition,
}: {
  peerWindowLabel: string
  currentPositionStorageKey: string
  peerPositionStorageKey: string
  resolveDefaultPosition?: DefaultPositionResolver
}) {
  const currentWindow = useMemo(() => getCurrentWindow(), [])
  const currentPositionRef = useRef<WindowPosition | null>(null)
  const peerPositionRef = useRef<WindowPosition | null>(null)
  const programmaticMoveRef = useRef(false)

  useEffect(() => {
    let unlistenMoved: (() => void) | undefined
    let unlistenSync: (() => void) | undefined
    let disposed = false

    async function applyProgrammaticPosition(position: WindowPosition) {
      const clamped = await clampWindowPosition(currentWindow, position)
      if (
        currentPositionRef.current &&
        currentPositionRef.current.x === clamped.x &&
        currentPositionRef.current.y === clamped.y
      ) {
        saveStoredPosition(currentPositionStorageKey, clamped)
        return
      }
      programmaticMoveRef.current = true
      try {
        await currentWindow.setPosition(new PhysicalPosition(clamped.x, clamped.y))
      } catch {
        programmaticMoveRef.current = false
        return
      }
      currentPositionRef.current = clamped
      saveStoredPosition(currentPositionStorageKey, clamped)
    }

    async function resolvePeerBasePosition(): Promise<WindowPosition | null> {
      if (peerPositionRef.current) {
        return peerPositionRef.current
      }
      const stored = loadStoredPosition(peerPositionStorageKey)
      if (stored) {
        peerPositionRef.current = stored
        return stored
      }
      const peerWindow = await Window.getByLabel(peerWindowLabel).catch(() => null)
      if (!peerWindow) {
        return null
      }
      const live = await getWindowPosition(peerWindow)
      if (live) {
        peerPositionRef.current = live
        saveStoredPosition(peerPositionStorageKey, live)
      }
      return live
    }

    async function syncPeerByDelta(delta: WindowPosition) {
      const basePosition = await resolvePeerBasePosition()
      if (!basePosition) {
        return
      }
      const peerWindow = await Window.getByLabel(peerWindowLabel).catch(() => null)
      if (!peerWindow) {
        return
      }
      const desired = applyDelta(basePosition, delta)
      const clamped = await clampWindowPosition(peerWindow, desired)
      peerPositionRef.current = clamped
      saveStoredPosition(peerPositionStorageKey, clamped)
      await emitTo(peerWindowLabel, WINDOW_POSITION_SYNC_EVENT, clamped).catch(() => undefined)
    }

    async function handleCurrentWindowMoved(position: WindowPosition) {
      const decision = resolveMoveSyncDecision(
        currentPositionRef.current,
        position,
        programmaticMoveRef.current,
      )

      currentPositionRef.current = position
      saveStoredPosition(currentPositionStorageKey, position)

      if (programmaticMoveRef.current) {
        programmaticMoveRef.current = false
        return
      }

      if (!decision.shouldSync) {
        return
      }

      await syncPeerByDelta(decision.delta)
    }

    async function initializePositionAndListeners() {
      const stored = loadStoredPosition(currentPositionStorageKey)
      if (stored) {
        await applyProgrammaticPosition(stored)
      } else if (resolveDefaultPosition) {
        const fallback = await resolveDefaultPosition(currentWindow).catch(() => null)
        if (fallback) {
          await applyProgrammaticPosition(fallback)
        }
      }

      const livePosition = await getWindowPosition(currentWindow)
      if (livePosition) {
        currentPositionRef.current = livePosition
        saveStoredPosition(currentPositionStorageKey, livePosition)
      }
      programmaticMoveRef.current = false

      const peerStored = loadStoredPosition(peerPositionStorageKey)
      if (peerStored) {
        peerPositionRef.current = peerStored
      }

      currentWindow
        .listen<WindowPosition>(WINDOW_POSITION_SYNC_EVENT, (event) => {
          if (isValidWindowPosition(event.payload)) {
            void applyProgrammaticPosition(event.payload)
          }
        })
        .then((fn) => {
          if (disposed) {
            fn()
            return
          }
          unlistenSync = fn
        })
        .catch(() => undefined)

      currentWindow
        .onMoved(({ payload }) => {
          void handleCurrentWindowMoved({ x: payload.x, y: payload.y })
        })
        .then((fn) => {
          if (disposed) {
            fn()
            return
          }
          unlistenMoved = fn
        })
        .catch(() => undefined)
    }

    void initializePositionAndListeners()

    return () => {
      disposed = true
      if (unlistenMoved) {
        unlistenMoved()
      }
      if (unlistenSync) {
        unlistenSync()
      }
    }
  }, [
    currentPositionStorageKey,
    currentWindow,
    peerPositionStorageKey,
    peerWindowLabel,
    resolveDefaultPosition,
  ])
}

function OrbApp() {
  const orbWindow = useMemo(() => getCurrentWindow(), [])
  const mouseDownRef = useRef<{ x: number; y: number } | null>(null)
  const didDragRef = useRef(false)
  const suppressClickRef = useRef(false)
  const resolveOrbDefaultPosition = useCallback(async (windowHandle: Window) => {
    const monitor = (await currentMonitor().catch(() => null)) ?? (await primaryMonitor().catch(() => null))
    if (!monitor) {
      return null
    }
    const size = await windowHandle.outerSize().catch(() => null)
    if (!size) {
      return null
    }
    const margin = 20
    return {
      x: monitor.position.x + monitor.size.width - size.width - margin,
      y: monitor.position.y + monitor.size.height - size.height - margin,
    }
  }, [])

  useLinkedWindowPositionSync({
    peerWindowLabel: MAIN_WINDOW_LABEL,
    currentPositionStorageKey: ORB_POSITION_STORAGE_KEY,
    peerPositionStorageKey: MAIN_POSITION_STORAGE_KEY,
    resolveDefaultPosition: resolveOrbDefaultPosition,
  })

  useEffect(() => {
    document.body.classList.add('orb-mode')
    return () => {
      document.body.classList.remove('orb-mode')
    }
  }, [])

  useEffect(() => {
    function handleGlobalMouseUp() {
      mouseDownRef.current = null
      didDragRef.current = false
    }
    window.addEventListener('mouseup', handleGlobalMouseUp)
    return () => {
      window.removeEventListener('mouseup', handleGlobalMouseUp)
    }
  }, [])

  function handleMouseDown(event: MouseEvent<HTMLButtonElement>) {
    if (event.button !== 0) return
    mouseDownRef.current = {
      x: event.clientX,
      y: event.clientY,
    }
    didDragRef.current = false
  }

  function handleMouseMove(event: MouseEvent<HTMLButtonElement>) {
    if (!mouseDownRef.current || didDragRef.current) return

    const dx = Math.abs(event.clientX - mouseDownRef.current.x)
    const dy = Math.abs(event.clientY - mouseDownRef.current.y)
    if (dx < 4 && dy < 4) return

    didDragRef.current = true
    suppressClickRef.current = true
    mouseDownRef.current = null
    void orbWindow.startDragging().catch(() => undefined)
  }

  function handleMouseUp(event: MouseEvent<HTMLButtonElement>) {
    if (event.button !== 0) return

    mouseDownRef.current = null
    didDragRef.current = false
  }

  function handleMouseLeave() {
    mouseDownRef.current = null
    didDragRef.current = false
  }

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    if (event.button !== 0) return
    if (suppressClickRef.current || didDragRef.current) {
      suppressClickRef.current = false
      didDragRef.current = false
      return
    }
    void restoreFromOrb()
  }

  function handleContextMenu(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    void quitApp()
  }

  return (
    <main className="orb-shell">
      <button
        className="orb-button"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title="Left click to restore, right click to quit"
        aria-label="Windows Calendar Orb"
      >
        <img src="/favicon.svg" alt="Windows Calendar" />
      </button>
    </main>
  )
}
function MainApp() {
  const [items, setItems] = useState<CalendarItem[]>([])
  const [settings, setSettings] = useState<ReminderSettings>(DEFAULT_SETTINGS)
  const [tab, setTab] = useState<PageTab>('calendar')
  const [calendarView, setCalendarView] = useState<CalendarView>('month')
  const [cursorDate, setCursorDate] = useState<Date>(new Date())
  const [selectedDate, setSelectedDate] = useState<Date>(new Date())
  const [dailyDate, setDailyDate] = useState<Date>(new Date())
  const [dailyShowDone, setDailyShowDone] = useState(false)
  const [status, setStatus] = useState<StatusFilter>('all')
  const [search, setSearch] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [createPickerOpen, setCreatePickerOpen] = useState(false)
  const [createPickerDate, setCreatePickerDate] = useState<Date | undefined>()
  const [formState, setFormState] = useState<FormState>(() => emptyForm('todo', new Date()))
  const [alerts, setAlerts] = useState<ReminderAlert[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [formError, setFormError] = useState('')
  const [info, setInfo] = useState('')
  const [lastEditedHoursField, setLastEditedHoursField] = useState<HoursSyncSource>('estimated')
  const [dailyPlanCache, setDailyPlanCache] = useState<DailyPlanCache>({})
  const [complexPlanOpen, setComplexPlanOpen] = useState(false)
  const [complexPlanLoading, setComplexPlanLoading] = useState(false)
  const [complexPlanRows, setComplexPlanRows] = useState<ComplexPlanRow[]>([])
  const [complexPlanItemId, setComplexPlanItemId] = useState<number | null>(null)
  const stripRef = useRef<HTMLDivElement | null>(null)
  const syncingHoursRef = useRef(false)

  useLinkedWindowPositionSync({
    peerWindowLabel: ORB_WINDOW_LABEL,
    currentPositionStorageKey: MAIN_POSITION_STORAGE_KEY,
    peerPositionStorageKey: ORB_POSITION_STORAGE_KEY,
  })

  useEffect(() => {
    document.body.classList.remove('orb-mode')
  }, [])

  async function refreshAll() {
    try {
      const [itemRows, appSettings] = await Promise.all([listItems(), getSettings()])
      setItems(itemRows)
      setSettings(appSettings)
      setError('')
    } catch (err) {
      setError(String(err))
    }
  }

  useEffect(() => {
    void refreshAll()
  }, [])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    listen<ReminderAlert>('reminder-alert', (event) => {
      setAlerts((prev) => [event.payload, ...prev].slice(0, 20))
    })
      .then((fn) => {
        unlisten = fn
      })
      .catch(() => undefined)

    return () => {
      if (unlisten) {
        unlisten()
      }
    }
  }, [])

  const today = useMemo(() => {
    const current = new Date()
    current.setHours(0, 0, 0, 0)
    return current
  }, [])

  const monthDays = useMemo(() => monthMatrix(cursorDate), [cursorDate])
  const week = useMemo(() => weekDays(selectedDate), [selectedDate])
  const visibleDays = calendarView === 'month' ? monthDays : week
  const dailyDateKey = useMemo(() => formatDateOnly(dailyDate), [dailyDate])
  const todayDateKey = useMemo(() => formatDateOnly(today), [today])

  useEffect(() => {
    if (tab !== 'daily' && tab !== 'calendar') {
      return
    }

    const visibleDateKeys =
      tab === 'daily'
        ? [dailyDateKey]
        : visibleDays.map((day) => formatDateOnly(day))
    const uniqueVisibleDateKeys = Array.from(new Set(visibleDateKeys))

    const targets = items
      .filter((item) => item.has_complex_plan && !item.done)
      .filter((item) =>
        uniqueVisibleDateKeys.some((dateKey) => itemCoversDate(item, dateKey)),
      )
      .map((item) => item.id)
    const missing = targets.filter((id) => !dailyPlanCache[id])
    if (missing.length === 0) {
      return
    }
    void Promise.all(
      missing.map(async (id) => {
        const rows = await getItemDailyPlan(id)
        return {
          id,
          map: rows.reduce<Record<string, number>>((acc, row) => {
            acc[row.plan_date] = row.hours
            return acc
          }, {}),
        }
      }),
    )
      .then((entries) => {
        setDailyPlanCache((prev) => {
          const next = { ...prev }
          for (const entry of entries) {
            next[entry.id] = entry.map
          }
          return next
        })
      })
      .catch(() => undefined)
  }, [dailyDateKey, dailyPlanCache, items, tab, visibleDays])

  const toolbarTitle = useMemo(() => {
    if (calendarView === 'month') {
      return `${cursorDate.getFullYear()} / ${cursorDate.getMonth() + 1}`
    }
    const start = week[0]
    const end = week[6]
    const sameMonth =
      start.getFullYear() === end.getFullYear() &&
      start.getMonth() === end.getMonth()
    if (sameMonth) {
      return `${start.getFullYear()} / ${start.getMonth() + 1} (${start.getDate()}-${end.getDate()})`
    }
    return `${start.getMonth() + 1}/${start.getDate()} - ${end.getMonth() + 1}/${end.getDate()}`
  }, [calendarView, cursorDate, week])

  const todos = useMemo(
    () => applyListFilters(items.filter((item) => item.type === 'todo'), status, search),
    [items, search, status],
  )
  const ddls = useMemo(
    () => applyListFilters(items.filter((item) => item.type === 'ddl'), status, search),
    [items, search, status],
  )
  const overdueTodos = useMemo(
    () =>
      items
        .filter((item) => isTodoOverdue(item, today))
        .sort((a, b) => {
          const overdueGap = overdueDays(b, today) - overdueDays(a, today)
          if (overdueGap !== 0) return overdueGap
          return new Date(a.due_at).getTime() - new Date(b.due_at).getTime()
        }),
    [items, today],
  )

  const dailyItems = useMemo(() => {
    return items
      .filter((item) => item.start_at && item.estimated_hours && itemCoversDate(item, dailyDateKey))
      .filter((item) => dailyShowDone || !item.done)
      .sort((a, b) => {
        if (a.done !== b.done) {
          return a.done ? 1 : -1
        }
        return new Date(a.due_at).getTime() - new Date(b.due_at).getTime()
      })
  }, [dailyDateKey, dailyShowDone, items])

  const dailyNeedsBackfill = useMemo(() => {
    return items.filter((item) => !item.start_at || !item.estimated_hours || item.estimated_hours <= 0)
  }, [items])

  const dailyPlannedTotal = useMemo(() => {
    return dailyItems.reduce((sum, item) => {
      const complexHours = dailyPlanCache[item.id]?.[dailyDateKey]
      return sum + plannedHoursForDate(item, dailyDateKey, complexHours)
    }, 0)
  }, [dailyDateKey, dailyItems, dailyPlanCache])

  const dayWorkloadByDate = useMemo(() => {
    const map: Record<
      string,
      ReturnType<typeof calculateDayWorkloadSummary>
    > = {}
    const uniqueDateKeys = Array.from(
      new Set(visibleDays.map((day) => formatDateOnly(day))),
    )
    for (const dateKey of uniqueDateKeys) {
      map[dateKey] = calculateDayWorkloadSummary(
        items,
        dateKey,
        dailyPlanCache,
      )
    }
    return map
  }, [dailyPlanCache, items, visibleDays])

  const dayScoreIntensityByDate = useMemo(() => {
    const entries = Object.entries(dayWorkloadByDate).filter(([, summary]) => summary.taskCount > 0)
    if (entries.length === 0) {
      return {} as Record<string, number>
    }

    const scores = entries.map(([, summary]) => summary.score)
    const minScore = Math.min(...scores)
    const maxScore = Math.max(...scores)

    return entries.reduce<Record<string, number>>((acc, [dateKey, summary]) => {
      if (maxScore === minScore) {
        acc[dateKey] = summary.score > 0 ? 0.6 : 0
        return acc
      }
      acc[dateKey] = clamp01((summary.score - minScore) / (maxScore - minScore))
      return acc
    }, {})
  }, [dayWorkloadByDate])

  function syncHoursFields(next: FormState, source: HoursSyncSource | null): FormState {
    if (!source || !next.startAt) {
      return next
    }
    const dueMeta = dueMetaFromLocalInput(next.dueAt)
    if (!dueMeta || next.startAt > dueMeta.dateKey) {
      return next
    }

    const totalDays = activeDaysInclusive(next.startAt, dueMeta.iso)
    if (totalDays <= 0) {
      return next
    }

    if (source === 'estimated') {
      const estimatedHours = parsePositiveNumber(next.estimatedHours)
      if (!estimatedHours) {
        return next
      }
      const nextDailyHours = formatHoursInput(estimatedHours / totalDays)
      if (next.dailyHoursOverride === nextDailyHours) {
        return next
      }
      return {
        ...next,
        dailyHoursOverride: nextDailyHours,
      }
    }

    const dailyHours = parsePositiveNumber(next.dailyHoursOverride)
    if (!dailyHours) {
      return next
    }
    const nextEstimatedHours = formatHoursInput(dailyHours * totalDays)
    if (next.estimatedHours === nextEstimatedHours) {
      return next
    }
    return {
      ...next,
      estimatedHours: nextEstimatedHours,
    }
  }

  function updateFormStateWithSync(
    updater: (prev: FormState) => FormState,
    source?: HoursSyncSource,
  ) {
    setFormState((prev) => {
      const raw = updater(prev)
      if (syncingHoursRef.current) {
        return raw
      }
      syncingHoursRef.current = true
      const synced = syncHoursFields(raw, source ?? lastEditedHoursField)
      syncingHoursRef.current = false
      return synced
    })
  }

  function openCreate(type: ItemType, date?: Date) {
    setFormState({
      ...emptyForm(type, date, settings.default_offsets),
      type,
    })
    setLastEditedHoursField('estimated')
    setFormError('')
    setInfo('')
    setFormOpen(true)
  }

  function shiftCalendar(direction: -1 | 1) {
    if (calendarView === 'month') {
      setCursorDate((prev) => new Date(prev.getFullYear(), prev.getMonth() + direction, 1))
      return
    }
    const next = new Date(selectedDate)
    next.setDate(next.getDate() + direction * 7)
    setSelectedDate(next)
    setCursorDate(new Date(next.getFullYear(), next.getMonth(), 1))
  }

  function shiftDaily(direction: -1 | 1) {
    setDailyDate((prev) => {
      const next = new Date(prev)
      next.setDate(next.getDate() + direction)
      return next
    })
  }

  function openCalendarCreatePicker(date?: Date) {
    setCreatePickerDate(date)
    setCreatePickerOpen(true)
  }

  function chooseCreateType(type: ItemType) {
    setCreatePickerOpen(false)
    openCreate(type, createPickerDate ?? selectedDate)
  }

  function openEdit(item: CalendarItem) {
    const startAt = item.start_at ?? dateKeyFromIso(item.due_at)
    const dailyHoursOverride =
      typeof item.daily_hours_override === 'number'
        ? `${item.daily_hours_override}`
        : ''
    setFormState({
      id: item.id,
      type: item.type,
      title: item.title,
      note: item.note,
      startAt,
      dueAt: localInputFromIso(item.due_at),
      estimatedHours: `${item.estimated_hours ?? DEFAULT_ESTIMATED_HOURS}`,
      dailyHoursOverride,
      remindEnabled: item.remind_enabled,
      offsets: normalizeOffsets(item.remind_offsets),
      todoOverdueDays: item.todo_overdue_days,
      hasComplexPlan: item.has_complex_plan,
      originalStartAt: startAt,
      originalDueDateKey: dateKeyFromIso(item.due_at),
    })
    setLastEditedHoursField(dailyHoursOverride ? 'daily' : 'estimated')
    setFormError('')
    setInfo('')
    setFormOpen(true)
  }

  function openEditById(id: number) {
    const item = items.find((entry) => entry.id === id)
    if (!item) {
      return
    }
    openEdit(item)
  }

  function dismissAlert(alertId: string) {
    setAlerts((prev) => prev.filter((alert) => alert.id !== alertId))
  }

  async function saveForm() {
    if (!formState.title.trim()) {
      setFormError('标题不能为空')
      return
    }
    if (!formState.startAt) {
      setFormError('请选择开始日期')
      return
    }
    if (!formState.dueAt) {
      setFormError('请选择截止时间')
      return
    }
    if (formState.remindEnabled && formState.offsets.length === 0) {
      setFormError('请至少选择一个提醒时间点')
      return
    }
    if (!Number.isInteger(formState.todoOverdueDays) || formState.todoOverdueDays < 1) {
      setFormError('X 天阈值必须是大于等于 1 的整数')
      return
    }
    const estimatedHours = parsePositiveNumber(formState.estimatedHours)
    if (!estimatedHours) {
      setFormError('总工时必须是大于 0 的数字')
      return
    }
    const dailyHoursOverride = parsePositiveNumber(formState.dailyHoursOverride)
    if (formState.dailyHoursOverride.trim() && !dailyHoursOverride) {
      setFormError('每日固定工时必须是大于 0 的数字')
      return
    }
    const dueMeta = dueMetaFromLocalInput(formState.dueAt)
    if (!dueMeta) {
      setFormError('请选择有效的截止时间')
      return
    }
    const dueDateKey = dueMeta.dateKey
    if (formState.startAt > dueDateKey) {
      setFormError('开始日期不能晚于截止日期')
      return
    }

    setBusy(true)
    setFormError('')
    setInfo('')
    try {
      if (
        formState.id !== null &&
        formState.hasComplexPlan &&
        (formState.startAt !== formState.originalStartAt || dueDateKey !== formState.originalDueDateKey)
      ) {
        const confirmed = window.confirm(
          '你修改了开始/截止日期。保存时会先清空复杂计划（按天工时）再继续，是否确认？',
        )
        if (!confirmed) {
          setBusy(false)
          return
        }
        await clearItemDailyPlan(formState.id)
        setDailyPlanCache((prev) => {
          const next = { ...prev }
          delete next[formState.id!]
          return next
        })
      }

      const payload: ItemPayload = {
        type: formState.type,
        title: formState.title.trim(),
        note: formState.note.trim(),
        start_at: formState.startAt,
        due_at: dueMeta.iso,
        estimated_hours: estimatedHours,
        daily_hours_override: dailyHoursOverride,
        remind_enabled: formState.remindEnabled,
        remind_offsets: normalizeOffsets(formState.offsets),
        todo_overdue_days: formState.todoOverdueDays,
      }

      if (formState.id === null) {
        await createItem(payload)
      } else {
        await updateItem(formState.id, payload)
      }
      setFormError('')
      setFormOpen(false)
      await refreshAll()
    } catch (err) {
      setFormError(String(err))
    } finally {
      setBusy(false)
    }
  }

  async function removeItem(id: number) {
    setBusy(true)
    try {
      await deleteItem(id)
      setDailyPlanCache((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      await refreshAll()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  async function toggleDone(item: CalendarItem) {
    setBusy(true)
    try {
      await markItemDone(item.id, !item.done)
      await refreshAll()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  async function postponeItem(itemId: number, minutes: number) {
    setBusy(true)
    try {
      await snoozeItem(itemId, minutes)
      await refreshAll()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  async function completeFromAlert(alert: ReminderAlert) {
    dismissAlert(alert.id)
    try {
      await markItemDone(alert.item_id, true)
      await refreshAll()
    } catch (err) {
      setError(String(err))
    }
  }

  async function postponeFromAlert(alert: ReminderAlert, minutes: number) {
    dismissAlert(alert.id)
    try {
      await snoozeItem(alert.item_id, minutes)
      await refreshAll()
    } catch (err) {
      setError(String(err))
    }
  }

  async function saveSettings() {
    setBusy(true)
    try {
      const updated = await updateSettings(settings)
      setSettings(updated)
      setSettingsOpen(false)
      setError('')
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  function handleTodoStripWheel(event: WheelEvent<HTMLDivElement>) {
    const strip = stripRef.current
    if (!strip) return
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
    if (strip.scrollWidth <= strip.clientWidth) return
    event.preventDefault()
    strip.scrollLeft += event.deltaY
  }

  async function minimizeMainWindow() {
    try {
      await minimizeToOrb()
    } catch (err) {
      setError(String(err))
    }
  }

  async function openComplexPlan() {
    if (formState.id === null) {
      return
    }
    const dueMeta = dueMetaFromLocalInput(formState.dueAt)
    if (!formState.startAt || !dueMeta) {
      setFormError('请先填写有效的开始日期和截止时间')
      return
    }
    if (formState.startAt > dueMeta.dateKey) {
      setFormError('开始日期不能晚于截止日期')
      return
    }
    setComplexPlanLoading(true)
    setComplexPlanItemId(formState.id)
    setComplexPlanOpen(true)
    setFormError('')
    try {
      const itemId = formState.id
      const dateKeys = eachDateKeyInRange(formState.startAt, dueMeta.iso)
      const existingRows = await getItemDailyPlan(itemId)
      const existingMap = existingRows.reduce<Record<string, number>>((acc, row) => {
        acc[row.plan_date] = row.hours
        return acc
      }, {})
      setDailyPlanCache((prev) => ({ ...prev, [itemId]: existingMap }))

      const totalDays = activeDaysInclusive(formState.startAt, dueMeta.iso)
      const estimatedHours = parsePositiveNumber(formState.estimatedHours) ?? DEFAULT_ESTIMATED_HOURS
      const autoHours = estimatedHours / totalDays
      const fixedHours = parsePositiveNumber(formState.dailyHoursOverride)
      const rows: ComplexPlanRow[] = dateKeys.map((date) => {
        const seed = existingMap[date] ?? fixedHours ?? autoHours
        return { date, hours: seed.toFixed(2).replace(/\.00$/, '') }
      })
      setComplexPlanRows(rows)
    } catch (err) {
      setFormError(String(err))
      setComplexPlanOpen(false)
      setComplexPlanItemId(null)
    } finally {
      setComplexPlanLoading(false)
    }
  }

  async function saveComplexPlan() {
    if (complexPlanItemId === null) return
    const entries: DailyPlanEntryPayload[] = []
    for (const row of complexPlanRows) {
      const parsed = parsePositiveNumber(row.hours)
      if (!parsed) {
        setFormError('复杂计划中每天工时都必须大于 0')
        return
      }
      entries.push({
        plan_date: row.date,
        hours: parsed,
      })
    }

    setBusy(true)
    setFormError('')
    try {
      const saved = await replaceItemDailyPlan(complexPlanItemId, entries)
      const map = saved.reduce<Record<string, number>>((acc, entry) => {
        acc[entry.plan_date] = entry.hours
        return acc
      }, {})
      const total = saved.reduce((sum, entry) => sum + entry.hours, 0)
      setDailyPlanCache((prev) => ({ ...prev, [complexPlanItemId]: map }))
      setFormState((prev) => ({
        ...prev,
        estimatedHours: total.toFixed(2).replace(/\.00$/, ''),
        hasComplexPlan: true,
      }))
      setComplexPlanOpen(false)
      setComplexPlanItemId(null)
      setInfo('复杂计划已保存，总工时已自动更新')
      await refreshAll()
    } catch (err) {
      setFormError(String(err))
    } finally {
      setBusy(false)
    }
  }

  async function clearComplexPlan() {
    if (complexPlanItemId === null) return
    setBusy(true)
    setFormError('')
    try {
      await clearItemDailyPlan(complexPlanItemId)
      setDailyPlanCache((prev) => {
        const next = { ...prev }
        delete next[complexPlanItemId]
        return next
      })
      setFormState((prev) => ({ ...prev, hasComplexPlan: false }))
      setComplexPlanOpen(false)
      setComplexPlanItemId(null)
      setInfo('复杂计划已清空，已恢复普通计划模式')
      await refreshAll()
    } catch (err) {
      setFormError(String(err))
    } finally {
      setBusy(false)
    }
  }

  function renderItemCard(item: CalendarItem) {
    return (
      <article className={`item-card ${item.done ? 'item-done' : 'item-undone'}`} key={item.id}>
        <header>
          <h4>{item.title}</h4>
          <span>{formatDue(item.due_at)}</span>
        </header>
        <p className="item-meta">
          开始：{item.start_at ?? '未填写'} | 总工时：
          {typeof item.estimated_hours === 'number' ? `${item.estimated_hours}h` : '未填写'}
          {item.has_complex_plan ? ' | 复杂计划' : ''}
        </p>
        {item.note && <p>{item.note}</p>}
        <footer>
          <button onClick={() => toggleDone(item)}>{item.done ? '标记未完成' : '标记完成'}</button>
          <button onClick={() => openEdit(item)}>编辑</button>
          {item.type === 'ddl' && !item.postpone_used && (
            <button onClick={() => postponeItem(item.id, 15)}>延期 15 分钟</button>
          )}
          <button className="danger" onClick={() => removeItem(item.id)}>
            删除
          </button>
        </footer>
      </article>
    )
  }

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div className="window-drag-handle" data-tauri-drag-region title="拖动窗口" aria-hidden="true" />
        <div className="tabs" role="tablist" aria-label="页面切换">
          {Object.entries(TAB_LABELS).map(([key, label]) => {
            const current = key as PageTab
            return (
              <button
                key={key}
                className={tab === current ? 'active' : ''}
                onClick={() => setTab(current)}
                role="tab"
                aria-selected={tab === current}
              >
                {label}
              </button>
            )
          })}
        </div>
        <div className="top-actions">
          <button
            className="primary"
            onClick={() => {
              if (tab === 'calendar') {
                openCalendarCreatePicker(selectedDate)
                return
              }
              if (tab === 'daily') {
                openCreate('todo', dailyDate)
                return
              }
              openCreate(tab as ItemType, selectedDate)
            }}
          >
            新增
          </button>
          <button className="window-minimize" onClick={() => void minimizeMainWindow()}>
            最小化
          </button>
        </div>
      </header>

      <section className="content-area">
        {tab === 'calendar' && (
          <section className={`calendar-page ${calendarView === 'week' ? 'week-layout' : 'month-layout'}`}>
            <section className="todo-strip">
              <header className="todo-strip-header">
                <h3>超时待办提醒</h3>
                <span>{overdueTodos.length} 条</span>
              </header>
              <div
                className="todo-strip-scroll"
                ref={stripRef}
                onWheel={handleTodoStripWheel}
                role="region"
                aria-label="超时待办横向列表"
              >
                {overdueTodos.length === 0 && <p className="todo-strip-empty">暂无超时待办</p>}
                {overdueTodos.map((item) => (
                  <button
                    key={item.id}
                    className="todo-strip-card"
                    onClick={() => openEdit(item)}
                    title="点击重新计划或完成该待办"
                  >
                    <strong>{item.title}</strong>
                    <small>已超时 {overdueDays(item, today)} 天</small>
                    <small>截止：{formatDue(item.due_at)}</small>
                  </button>
                ))}
              </div>
            </section>

            <div className="calendar-toolbar">
              <button onClick={() => shiftCalendar(-1)}>
                {calendarView === 'month' ? '上月' : '上周'}
              </button>
              <strong>{toolbarTitle}</strong>
              <button onClick={() => shiftCalendar(1)}>
                {calendarView === 'month' ? '下月' : '下周'}
              </button>
              <button onClick={() => setCalendarView(calendarView === 'month' ? 'week' : 'month')}>
                {calendarView === 'month' ? '切换周视图' : '切换月视图'}
              </button>
              <div className="score-legend" aria-label="复杂度图例">
                <span>
                  低复杂度
                </span>
                <i className="legend-gradient" />
                <span>高复杂度</span>
              </div>
            </div>

            <div className="calendar-weekdays">
              {WEEKDAY_LABELS.map((weekday) => (
                <span key={weekday}>{weekday}</span>
              ))}
            </div>

            <div className={`calendar-grid ${calendarView === 'week' ? 'week-mode' : 'month-mode'}`}>
              {visibleDays.map((day) => {
                const dayItems = itemsForDate(items, day)
                const dayKey = formatDateOnly(day)
                const isSelected = dateKeyFromIso(day.toISOString()) === dateKeyFromIso(selectedDate.toISOString())
                const isCurrentMonth = day.getMonth() === cursorDate.getMonth()
                const isToday = dayKey === todayDateKey
                const dayWorkload = dayWorkloadByDate[dayKey]
                const dayHeatIntensity = dayScoreIntensityByDate[dayKey] ?? 0
                const dayStyle =
                  dayWorkload && dayWorkload.taskCount > 0
                    ? { background: workloadHeatBackground(dayHeatIntensity) }
                    : undefined
                const workloadTitle =
                  dayWorkload && dayWorkload.taskCount > 0
                    ? `复杂度 ${dayWorkload.score.toFixed(2)} | DDL ${dayWorkload.ddlCount} | 待办 ${dayWorkload.todoCount} | 计划 ${dayWorkload.plannedHours.toFixed(2)}h`
                    : '当日无任务'
                return (
                  <button
                    key={`${day.toISOString()}-${calendarView}`}
                    className={`day-cell ${isSelected ? 'selected' : ''} ${isCurrentMonth ? '' : 'outside-month'}`}
                    title={workloadTitle}
                    style={dayStyle}
                    onClick={() => {
                      setSelectedDate(day)
                      if (calendarView === 'month') {
                        setCursorDate(new Date(day.getFullYear(), day.getMonth(), 1))
                      }
                    }}
                  >
                    <span className="day-number">{day.getDate()}</span>
                    {isToday && <span className="today-marker" title="今天" aria-label="今天" />}
                    <span className="dot-row">
                      {dayItems.slice(0, 3).map((item) => (
                        <i key={item.id} className={`dot ${item.type}`} title={item.title} />
                      ))}
                    </span>
                  </button>
                )
              })}
            </div>

            <div className="selected-list">
              <h3>{dateKeyFromIso(selectedDate.toISOString())} 的事项</h3>
              {itemsForDate(items, selectedDate).map(renderItemCard)}
              {itemsForDate(items, selectedDate).length === 0 && (
                <p className="empty-text">当天暂无事项，点击下方按钮快速新增。</p>
              )}
              <button className="ghost" onClick={() => openCalendarCreatePicker(selectedDate)}>
                为这一天新增待办或 DDL
              </button>
            </div>
          </section>
        )}

        {tab === 'daily' && (
          <section className="daily-page">
            <header className="daily-toolbar">
              <button onClick={() => shiftDaily(-1)}>前一天</button>
              <input
                type="date"
                value={dailyDateKey}
                onChange={(event) => setDailyDate(new Date(`${event.target.value}T00:00:00`))}
              />
              <button onClick={() => shiftDaily(1)}>后一天</button>
              <label className="inline daily-toggle">
                <input
                  type="checkbox"
                  checked={dailyShowDone}
                  onChange={(event) => setDailyShowDone(event.target.checked)}
                />
                显示已完成
              </label>
            </header>

            <section className="daily-summary">
              <strong>当天预计总工时：{dailyPlannedTotal.toFixed(2)}h</strong>
            </section>

            {dailyNeedsBackfill.length > 0 && (
              <section className="daily-backfill">
                <h4>待补全计划字段（开始日期 + 总工时）</h4>
                <div className="daily-backfill-list">
                  {dailyNeedsBackfill.map((item) => (
                    <button key={item.id} onClick={() => openEdit(item)}>
                      {item.title}
                    </button>
                  ))}
                </div>
              </section>
            )}

            <div className="daily-list">
              {dailyItems.length === 0 && <p className="empty-text">当天暂无任务安排</p>}
              {dailyItems.map((item) => {
                const complexHours = dailyPlanCache[item.id]?.[dailyDateKey]
                const hours = plannedHoursForDate(item, dailyDateKey, complexHours)
                return (
                  <article className={`item-card ${item.done ? 'item-done' : 'item-undone'}`} key={item.id}>
                    <header>
                      <h4>{item.title}</h4>
                      <span className={item.done ? 'state-done' : 'state-undone'}>
                        {item.done ? '已完成' : '进行中'}
                      </span>
                    </header>
                    <p className="item-meta">
                      今日预计：{hours.toFixed(2)}h | 截止：{formatDue(item.due_at)}
                    </p>
                    <p className="item-meta">
                      规则：{complexHours ? '复杂计划' : item.daily_hours_override ? '每日固定工时' : '自动均分'}
                    </p>
                    {item.note && <p>{item.note}</p>}
                    <footer>
                      <button onClick={() => toggleDone(item)}>{item.done ? '标记未完成' : '标记完成'}</button>
                      <button onClick={() => openEdit(item)}>编辑</button>
                      <button className="danger" onClick={() => removeItem(item.id)}>
                        删除
                      </button>
                    </footer>
                  </article>
                )
              })}
            </div>
          </section>
        )}

        {tab !== 'calendar' && tab !== 'daily' && (
          <section className="list-page">
            <div className="list-toolbar">
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索标题或备注"
              />
              <select value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}>
                <option value="all">全部</option>
                <option value="undone">未完成</option>
                <option value="done">已完成</option>
              </select>
            </div>
            <div className="list-body">{(tab === 'todo' ? todos : ddls).map(renderItemCard)}</div>
          </section>
        )}
      </section>

      <footer className="bottom-bar">
        <button className="settings-button" onClick={() => setSettingsOpen((open) => !open)}>
          设置
        </button>
        <span className={busy ? 'status busy' : 'status'}>{busy ? '处理中...' : '就绪'}</span>
      </footer>

      {error && !formOpen && <div className="error-banner">{error}</div>}
      {info && !error && <div className="info-banner">{info}</div>}

      {alerts.length > 0 && (
        <aside className="alerts-box">
          <h4>提醒中心</h4>
          {alerts.map((alert) => (
            <div key={alert.id} className="alert-row">
              <strong>{alert.title}</strong>
              <span>截止：{formatDue(alert.due_at)}</span>
              <div className="alert-actions">
                <button onClick={() => completeFromAlert(alert)}>完成</button>
                {alert.item_type === 'ddl' && !alert.postpone_used && (
                  <>
                    <button onClick={() => postponeFromAlert(alert, 5)}>5 分钟</button>
                    <button onClick={() => postponeFromAlert(alert, 15)}>15 分钟</button>
                    <button onClick={() => postponeFromAlert(alert, 30)}>30 分钟</button>
                  </>
                )}
                <button onClick={() => openEditById(alert.item_id)}>编辑</button>
              </div>
            </div>
          ))}
        </aside>
      )}

      {createPickerOpen && (
        <section className="modal">
          <div className="modal-card compact">
            <h3>选择事项类型</h3>
            <p className="picker-desc">日历仅保留待办与 DDL，两者都会标注到日历并参与提醒。</p>
            <div className="picker-actions">
              <button className="primary" onClick={() => chooseCreateType('todo')}>
                新建待办
              </button>
              <button onClick={() => chooseCreateType('ddl')}>新建 DDL</button>
              <button onClick={() => setCreatePickerOpen(false)}>取消</button>
            </div>
          </div>
        </section>
      )}

      {settingsOpen && (
        <section className="modal">
          <div className="modal-card">
            <h3>提醒设置</h3>
            <label>
              提醒形式
              <select
                value={settings.reminder_mode}
                onChange={(event) =>
                  setSettings((prev) => ({
                    ...prev,
                    reminder_mode: event.target.value as ReminderSettings['reminder_mode'],
                  }))
                }
              >
                <option value="toast_sound">系统通知 + 铃声</option>
                <option value="toast_only">仅系统通知</option>
                <option value="in_app_only">仅应用内提醒</option>
              </select>
            </label>
            <fieldset className="offset-fieldset">
              <legend>默认提醒时间</legend>
              <div className="offset-grid">
                {OFFSET_OPTIONS.map((offset) => (
                  <label key={offset.value} className="offset-option">
                    <input
                      type="checkbox"
                      checked={settings.default_offsets.includes(offset.value)}
                      onChange={(event) => {
                        setSettings((prev) => {
                          const next = event.target.checked
                            ? [...prev.default_offsets, offset.value]
                            : prev.default_offsets.filter((value) => value !== offset.value)
                          return {
                            ...prev,
                            default_offsets: normalizeOffsets(next),
                          }
                        })
                      }}
                    />
                    <span>{offset.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="inline">
              <input
                type="checkbox"
                checked={settings.autostart}
                onChange={(event) =>
                  setSettings((prev) => ({
                    ...prev,
                    autostart: event.target.checked,
                  }))
                }
              />
              开机自启动
            </label>
            <label className="inline">
              <input
                type="checkbox"
                checked={settings.close_to_tray}
                onChange={(event) =>
                  setSettings((prev) => ({
                    ...prev,
                    close_to_tray: event.target.checked,
                  }))
                }
              />
              关闭按钮最小化到托盘
            </label>
            <div className="modal-actions">
              <button className="primary" onClick={saveSettings}>
                保存设置
              </button>
              <button onClick={() => setSettingsOpen(false)}>关闭</button>
            </div>
          </div>
        </section>
      )}

      {formOpen && (
        <section className="modal">
          <div className="modal-card">
            <h3>{formState.id ? '编辑事项' : '新增事项'}</h3>
            {formError && (
              <div className="modal-error" role="alert">
                {formError}
              </div>
            )}
            <label>
              类型
              <select
                value={formState.type}
                onChange={(event) =>
                  setFormState((prev) => ({ ...prev, type: event.target.value as ItemType }))
                }
              >
                <option value="todo">近期待办</option>
                <option value="ddl">未来 DDL</option>
              </select>
            </label>
            <label>
              标题
              <input
                value={formState.title}
                onChange={(event) => setFormState((prev) => ({ ...prev, title: event.target.value }))}
                placeholder="输入事项标题"
              />
            </label>
            <div className="plan-grid">
              <label>
                开始日期
                <input
                  type="date"
                  value={formState.startAt}
                  onChange={(event) => {
                    const value = event.target.value
                    updateFormStateWithSync((prev) => ({ ...prev, startAt: value }))
                  }}
                />
              </label>
              <label>
                截止时间
                <input
                  type="datetime-local"
                  value={formState.dueAt}
                  onChange={(event) => {
                    const value = event.target.value
                    updateFormStateWithSync((prev) => ({ ...prev, dueAt: value }))
                  }}
                />
              </label>
              <label>
                总工时（小时）
                <input
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={formState.estimatedHours}
                  onChange={(event) => {
                    const value = event.target.value
                    setLastEditedHoursField('estimated')
                    updateFormStateWithSync(
                      (prev) => ({ ...prev, estimatedHours: value }),
                      'estimated',
                    )
                  }}
                />
              </label>
              <label>
                每日固定工时（可选）
                <input
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={formState.dailyHoursOverride}
                  onChange={(event) => {
                    const value = event.target.value
                    setLastEditedHoursField('daily')
                    updateFormStateWithSync(
                      (prev) => ({ ...prev, dailyHoursOverride: value }),
                      'daily',
                    )
                  }}
                  placeholder="留空则自动均分"
                />
              </label>
            </div>
            <div className="complex-plan-entry">
              <button
                onClick={openComplexPlan}
                disabled={formState.id === null}
                title={formState.id === null ? '请先保存任务后再编辑复杂计划' : '按日期逐天编辑工时'}
              >
                复杂计划（按日期编辑）
              </button>
              <span>
                {formState.id === null
                  ? '先保存任务后再编辑复杂计划'
                  : formState.hasComplexPlan
                    ? '当前任务已启用复杂计划'
                    : '当前任务使用普通计划'}
              </span>
            </div>
            <label>
              X 天阈值（超时后进入顶部提醒栏）
              <input
                type="number"
                min={1}
                value={formState.todoOverdueDays}
                onChange={(event) =>
                  setFormState((prev) => ({
                    ...prev,
                    todoOverdueDays: Number(event.target.value || DEFAULT_TODO_OVERDUE_DAYS),
                  }))
                }
              />
            </label>
            <label>
              备注
              <textarea
                value={formState.note}
                onChange={(event) => setFormState((prev) => ({ ...prev, note: event.target.value }))}
              />
            </label>
            <label className="inline">
              <input
                type="checkbox"
                checked={formState.remindEnabled}
                onChange={(event) =>
                  setFormState((prev) => ({ ...prev, remindEnabled: event.target.checked }))
                }
              />
              启用提醒
            </label>
            <fieldset className="offset-fieldset">
              <legend>提醒时间点</legend>
              <div className="offset-grid">
                {OFFSET_OPTIONS.map((offset) => (
                  <label key={offset.value} className="offset-option">
                    <input
                      type="checkbox"
                      checked={formState.offsets.includes(offset.value)}
                      onChange={(event) => {
                        setFormState((prev) => {
                          const next = event.target.checked
                            ? [...prev.offsets, offset.value]
                            : prev.offsets.filter((value) => value !== offset.value)
                          return {
                            ...prev,
                            offsets: normalizeOffsets(next),
                          }
                        })
                      }}
                    />
                    <span>{offset.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="modal-actions">
              <button className="primary" onClick={saveForm}>
                保存
              </button>
              <button
                onClick={() => {
                  setFormError('')
                  setFormOpen(false)
                }}
              >
                取消
              </button>
            </div>
          </div>
        </section>
      )}

      {complexPlanOpen && (
        <section className="modal">
          <div className="modal-card">
            <h3>复杂计划：按日期设置工时</h3>
            {formError && (
              <div className="modal-error" role="alert">
                {formError}
              </div>
            )}
            {complexPlanLoading ? (
              <p className="empty-text">加载中...</p>
            ) : (
              <>
                <p className="picker-desc">
                  优先级：复杂计划 {'>'} 每日固定工时 {'>'} 自动均分。保存后会自动回写总工时。
                </p>
                <div className="complex-plan-list">
                  {complexPlanRows.map((row, index) => (
                    <label key={row.date} className="complex-plan-row">
                      <span>{row.date}</span>
                      <input
                        type="number"
                        min={0.1}
                        step={0.1}
                        value={row.hours}
                        onChange={(event) => {
                          const value = event.target.value
                          setComplexPlanRows((prev) => {
                            const next = [...prev]
                            next[index] = { ...next[index], hours: value }
                            return next
                          })
                        }}
                      />
                    </label>
                  ))}
                </div>
                <div className="modal-actions">
                  <button className="primary" onClick={saveComplexPlan}>
                    保存复杂计划
                  </button>
                  <button onClick={clearComplexPlan}>清空复杂计划</button>
                  <button
                    onClick={() => {
                      setFormError('')
                      setComplexPlanOpen(false)
                      setComplexPlanItemId(null)
                    }}
                  >
                    关闭
                  </button>
                </div>
              </>
            )}
          </div>
        </section>
      )}
    </main>
  )
}

function App() {
  const windowLabel = getCurrentWindow().label
  if (windowLabel === ORB_WINDOW_LABEL) {
    return <OrbApp />
  }
  return <MainApp />
}

export default App

