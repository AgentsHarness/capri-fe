import { describe, expect, it } from 'vitest'
import { isWakePrompt } from './promptOrigin'

describe('isWakePrompt', () => {
  it('task / subagent / workflow / parent-message / notifications 为 wake', () => {
    expect(isWakePrompt('task-completed-abc-123')).toBe(true)
    expect(isWakePrompt('subagent-completed-xyz-789')).toBe(true)
    expect(isWakePrompt('workflow-completed-wf-1-9')).toBe(true)
    expect(isWakePrompt('parent-message-msg-123')).toBe(true)
    expect(isWakePrompt('notifications-019e0000-0000-7000-8000-0000000000aa')).toBe(true)
  })

  it('用户回合、/loop、goal、plan-resume 不是 wake', () => {
    expect(isWakePrompt('my-prompt')).toBe(false)
    expect(isWakePrompt('scheduler-fired-019e51a3-abcd-1234')).toBe(false)
    expect(isWakePrompt('goal-summary-019e2d3e')).toBe(false)
    expect(isWakePrompt('goal-classifier-nudge-019e2d3e')).toBe(false)
    expect(isWakePrompt('plan-resume-1730000000000')).toBe(false)
  })
})
