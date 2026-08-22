import { describe, expect, it, vi, afterEach } from 'vitest'
import { applyUiSettings } from './settings'
import { shouldNotify, systemNotify, tabUnfocused } from './notifyConfig'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('tabUnfocused', () => {
  it('hidden 或失焦 → true（jsdom 默认 hidden=true，需显式 stub）', () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    expect(tabUnfocused()).toBe(false)

    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    expect(tabUnfocused()).toBe(true)

    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    expect(tabUnfocused()).toBe(true)
  })
})

describe('shouldNotify', () => {
  it('never → 恒 false', () => {
    applyUiSettings({ notifications: { condition: 'never', events: ['turn_complete'] } })
    expect(shouldNotify('turn_complete')).toBe(false)
  })

  it('always + 事件命中 → true；未知/未列事件 → false', () => {
    applyUiSettings({ notifications: { condition: 'always' } })
    expect(shouldNotify('turn_complete')).toBe(true)
    expect(shouldNotify('session_ready')).toBe(false)
    expect(shouldNotify('unknown_event' as never)).toBe(false)
  })

  it('unfocused（默认）→ 仅失焦时通知', () => {
    applyUiSettings({ notifications: { condition: 'unfocused', events: ['approval_required'] } })
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    expect(shouldNotify('approval_required')).toBe(false)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    expect(shouldNotify('approval_required')).toBe(true)
  })

  it('events 非法列表 → 回退默认事件集', () => {
    applyUiSettings({ notifications: { condition: 'always', events: ['bogus', 42] } })
    expect(shouldNotify('turn_complete')).toBe(true)
    expect(shouldNotify('approval_required')).toBe(true)
    expect(shouldNotify('agent_error')).toBe(false)
  })

  it('events 非数组 → 默认事件集', () => {
    applyUiSettings({ notifications: { condition: 'always', events: 'turn_complete' } })
    expect(shouldNotify('turn_complete')).toBe(true)
  })
})

describe('systemNotify', () => {
  it('Notification 不可用 → false', () => {
    expect(systemNotify('t', 'b')).toBe(false)
  })

  it('无权限 → false；granted → 触发并返回 true', () => {
    const ctor = vi.fn() as ReturnType<typeof vi.fn> & { permission: string }
    const original = (globalThis as Record<string, unknown>).Notification
    ;(globalThis as Record<string, unknown>).Notification = ctor
    ctor.permission = 'denied'
    expect(systemNotify('t', 'b')).toBe(false)

    ctor.permission = 'granted'
    ctor.mockImplementation(function (this: unknown) {
      return {}
    })
    expect(systemNotify('标题', '正文')).toBe(true)
    expect(ctor).toHaveBeenCalledWith('标题', { body: '正文' })

    ctor.mockImplementation(function (this: unknown) {
      throw new Error('blocked')
    })
    expect(systemNotify('t', 'b')).toBe(false)

    if (original === undefined) delete (globalThis as Record<string, unknown>).Notification
    else (globalThis as Record<string, unknown>).Notification = original
  })
})