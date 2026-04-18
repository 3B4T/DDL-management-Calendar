export interface WindowPosition {
  x: number
  y: number
}

export interface WindowSize {
  width: number
  height: number
}

export interface BoundsRect {
  x: number
  y: number
  width: number
  height: number
}

export interface MoveSyncDecision {
  shouldSync: boolean
  delta: WindowPosition
}

export function isValidWindowPosition(value: unknown): value is WindowPosition {
  if (!value || typeof value !== 'object') {
    return false
  }
  const candidate = value as Partial<WindowPosition>
  return Number.isFinite(candidate.x) && Number.isFinite(candidate.y)
}

export function parseStoredWindowPosition(raw: string | null): WindowPosition | null {
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isValidWindowPosition(parsed)) {
      return null
    }
    return { x: parsed.x, y: parsed.y }
  } catch {
    return null
  }
}

export function serializeWindowPosition(position: WindowPosition): string {
  return JSON.stringify(position)
}

export function calculateDelta(from: WindowPosition, to: WindowPosition): WindowPosition {
  return {
    x: to.x - from.x,
    y: to.y - from.y,
  }
}

export function isZeroDelta(delta: WindowPosition): boolean {
  return delta.x === 0 && delta.y === 0
}

export function applyDelta(position: WindowPosition, delta: WindowPosition): WindowPosition {
  return {
    x: position.x + delta.x,
    y: position.y + delta.y,
  }
}

function clampNumber(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}

export function clampPositionToBounds(
  position: WindowPosition,
  size: WindowSize,
  bounds: BoundsRect,
): WindowPosition {
  const maxX = bounds.x + Math.max(bounds.width - size.width, 0)
  const maxY = bounds.y + Math.max(bounds.height - size.height, 0)
  return {
    x: clampNumber(position.x, bounds.x, maxX),
    y: clampNumber(position.y, bounds.y, maxY),
  }
}

export function resolveMoveSyncDecision(
  previous: WindowPosition | null,
  current: WindowPosition,
  isProgrammaticMove: boolean,
): MoveSyncDecision {
  if (isProgrammaticMove || !previous) {
    return {
      shouldSync: false,
      delta: { x: 0, y: 0 },
    }
  }

  const delta = calculateDelta(previous, current)
  return {
    shouldSync: !isZeroDelta(delta),
    delta,
  }
}
