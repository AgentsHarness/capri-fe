import { beforeEach, describe, expect, it } from 'vitest'
import { applyModeFlags, extractModeFlags, sessionModesPatch } from './modeApply'
import {
  markPlanExitApproved,
  resetPlanExitApprovedForTest,
} from './modePersist'
import type { ChatState } from './types'

function getState(patch: Partial<ChatState> = {}): () => ChatState {
  const s = { planMode: false, permissionMode: undefined, ...patch } as ChatState
  return () => s
}

describe('extractModeFlags — currentModeId 驱动 plan', () => {
  it('plan → planMode true', () => {
    expect(extractModeFlags({ currentModeId: 'plan' })).toEqual({ planMode: true })
  })

  it('default / ask / 未知 id 都是非 plan（对齐 TUI SessionMode::from_id）', () => {
    expect(extractModeFlags({ currentModeId: 'default' })).toEqual({ planMode: false })
    expect(extractModeFlags({ currentModeId: 'ask' })).toEqual({ planMode: false })
    expect(extractModeFlags({ currentModeId: 'browser_use' })).toEqual({ planMode: false })
  })

  it('auto / always-approve 同时恢复权限标志', () => {
    expect(extractModeFlags({ currentModeId: 'auto' })).toEqual({
      planMode: false,
      autoMode: true,
      permissionMode: 'auto',
    })
    expect(extractModeFlags({ currentModeId: 'always-approve' })).toEqual({
      planMode: false,
      yoloMode: true,
      permissionMode: 'always-approve',
    })
  })
})

describe('sessionModesPatch — 模型进出 plan', () => {
  beforeEach(() => {
    resetPlanExitApprovedForTest()
  })

  it('currentModeId plan → 当前会话 planMode true', () => {
    expect(sessionModesPatch(getState(), { currentModeId: 'plan' })).toEqual({
      planMode: true,
    })
  })

  it('currentModeId default → planMode false，并清掉残留 permissionMode plan', () => {
    const patch = sessionModesPatch(getState({ permissionMode: 'plan', planMode: true }), {
      currentModeId: 'default',
    })
    expect(patch).toMatchObject({ planMode: false, permissionMode: undefined })
  })

  it('exit_plan_mode 宽限内丢掉迟到的 plan-ON，避免 composer 被顶回', () => {
    markPlanExitApproved()
    expect(sessionModesPatch(getState({ planMode: false }), { currentModeId: 'plan' })).toEqual(
      null,
    )
  })
})

describe('applyModeFlags — 权限广播', () => {
  it('只有 permission_mode:ask 时清掉 yolo/auto，composer 不再卡在 always-approve', () => {
    const patches: unknown[] = []
    const set = ((p: unknown) => {
      patches.push(p)
    }) as never
    applyModeFlags(set, { permission_mode: 'ask' })
    expect(patches[0]).toMatchObject({
      permissionMode: 'ask',
      yoloMode: false,
      autoMode: false,
    })
  })

  it('显式 yolo_mode 优先于 permission_mode 推导', () => {
    const patches: unknown[] = []
    applyModeFlags(((p: unknown) => {
      patches.push(p)
    }) as never, { permission_mode: 'ask', yolo_mode: true })
    expect(patches[0]).toMatchObject({
      permissionMode: 'ask',
      yoloMode: true,
    })
  })
})
