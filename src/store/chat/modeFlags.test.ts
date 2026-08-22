import { describe, expect, it, vi } from 'vitest'
import {
  extractModeFlags,
  applyModeFlags,
  restorePlanMode,
  turnOnAlwaysApprove,
} from './modeFlags'
import type { SetState } from './types'

// 经 './modeFlags' 聚合入口调用，覆盖聚合 re-export 行。
describe('modeFlags 聚合入口（./modeFlags）', () => {
  it('extractModeFlags 经聚合可用', () => {
    expect(extractModeFlags({ currentModeId: 'plan' })).toEqual({ planMode: true })
  })

  it('applyModeFlags 经聚合可用', () => {
    const set = vi.fn() as unknown as SetState
    applyModeFlags(set, { yoloMode: true })
    expect(set).toHaveBeenCalledWith({ yoloMode: true })
  })

  it('restorePlanMode 经聚合可用（无记录 → {}）', () => {
    expect(restorePlanMode('unknown-sid-xyz')).toEqual({})
    expect(restorePlanMode(undefined)).toEqual({})
  })

  it('turnOnAlwaysApprove 导出存在', () => {
    expect(typeof turnOnAlwaysApprove).toBe('function')
  })
})