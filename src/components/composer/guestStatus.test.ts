import { describe, expect, it } from 'vitest'
import { guestWaitingLabel, guestWaitingSince } from './guestStatus'
import type { GuestSessionState } from '../../api/types'

/**
 * 访客「等 Human」那句文案的判定。
 *
 * 状态行本身与管理员共用一套渲染（活动标签、相位计时、statusText 各写入点
 * 都不变），这里只覆盖访客独有的那一段：有 pending 时说什么、计时起点取
 * 哪里、没有 pending 时退回 undefined（让调用方走管理员那套）。
 */

function waiting(kind: string, count = 1, receivedAt?: number): GuestSessionState {
  return {
    sessionState: 'awaiting',
    busy: true,
    awaitingInput: true,
    pendingInput: {
      kind: kind as NonNullable<GuestSessionState['pendingInput']>['kind'],
      count,
      ...(receivedAt != null ? { receivedAt } : {}),
    },
  }
}

describe('guestWaitingLabel', () => {
  it('permission / question / plan 各自点名', () => {
    expect(guestWaitingLabel(waiting('permission'))).toContain('权限')
    expect(guestWaitingLabel(waiting('question'))).toContain('提问')
    expect(guestWaitingLabel(waiting('plan'))).toContain('计划')
  })

  it('文案点明等的是 Human，而不是 agent', () => {
    for (const kind of ['permission', 'question', 'plan', 'diff_review', 'mcp_elicit']) {
      expect(guestWaitingLabel(waiting(kind))).toContain('Human')
    }
  })

  it('多条待处理 → 标出条数', () => {
    expect(guestWaitingLabel(waiting('question', 3))).toContain('3')
    // 单条不标，避免噪声
    expect(guestWaitingLabel(waiting('question', 1))).not.toContain('共')
  })

  it('未知类别也给一句人话（不把内部方法名漏给访客）', () => {
    const label = guestWaitingLabel(waiting('some-future-kind'))
    expect(label).toBeDefined()
    expect(label).toContain('Human')
    expect(label).not.toContain('some-future-kind')
  })

  it('没有 pending → undefined（调用方退回管理员的 statusText 渲染）', () => {
    expect(guestWaitingLabel(undefined)).toBeUndefined()
    expect(
      guestWaitingLabel({
        sessionState: 'active',
        busy: true,
        awaitingInput: false,
      }),
    ).toBeUndefined()
    expect(
      guestWaitingLabel({ sessionState: 'idle', busy: false, awaitingInput: false }),
    ).toBeUndefined()
  })

  it('awaitingInput 为真但没有 pendingInput → 不编造等待文案', () => {
    expect(
      guestWaitingLabel({
        sessionState: 'awaiting',
        busy: true,
        awaitingInput: true,
      }),
    ).toBeUndefined()
  })
})

describe('guestWaitingSince', () => {
  it('取 host 收到请求的时刻（重连不清零）', () => {
    expect(guestWaitingSince(waiting('permission', 1, 1_700_000_000_000))).toBe(
      1_700_000_000_000,
    )
  })

  it('host 没带 receivedAt → undefined（不显示计时，也不编造起点）', () => {
    expect(guestWaitingSince(waiting('permission'))).toBeUndefined()
    expect(guestWaitingSince(undefined)).toBeUndefined()
  })
})
