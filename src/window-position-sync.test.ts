import { describe, expect, it } from 'vitest'

import {
  applyDelta,
  clampPositionToBounds,
  parseStoredWindowPosition,
  resolveMoveSyncDecision,
  serializeWindowPosition,
} from './window-position-sync'

describe('window-position-sync', () => {
  it('serializes and parses valid position payloads', () => {
    const raw = serializeWindowPosition({ x: 320, y: 180 })
    expect(parseStoredWindowPosition(raw)).toEqual({ x: 320, y: 180 })
  })

  it('returns null for invalid stored payloads', () => {
    expect(parseStoredWindowPosition('not-json')).toBeNull()
    expect(parseStoredWindowPosition('{"x":"bad","y":100}')).toBeNull()
    expect(parseStoredWindowPosition('{"x":100}')).toBeNull()
  })

  it('computes and applies delta movement', () => {
    const decision = resolveMoveSyncDecision(
      { x: 100, y: 200 },
      { x: 136, y: 240 },
      false,
    )
    expect(decision.shouldSync).toBe(true)
    expect(decision.delta).toEqual({ x: 36, y: 40 })
    expect(applyDelta({ x: 400, y: 500 }, decision.delta)).toEqual({ x: 436, y: 540 })
  })

  it('suppresses sync for programmatic movement to avoid loops', () => {
    const decision = resolveMoveSyncDecision(
      { x: 100, y: 100 },
      { x: 120, y: 130 },
      true,
    )
    expect(decision.shouldSync).toBe(false)
    expect(decision.delta).toEqual({ x: 0, y: 0 })
  })

  it('clamps position inside monitor work area including negative coordinates', () => {
    const bounds = {
      x: -1920,
      y: 0,
      width: 1920,
      height: 1080,
    }

    expect(
      clampPositionToBounds(
        { x: -2500, y: -80 },
        { width: 500, height: 400 },
        bounds,
      ),
    ).toEqual({ x: -1920, y: 0 })

    expect(
      clampPositionToBounds(
        { x: 100, y: 900 },
        { width: 500, height: 400 },
        bounds,
      ),
    ).toEqual({ x: -500, y: 680 })
  })
})
