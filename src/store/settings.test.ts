import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api/client', () => ({
  transport: {
    settings: vi.fn(),
  },
}))

import { transport } from '../api/client'

const settingsMock = vi.mocked(transport.settings)

beforeEach(() => {
  settingsMock.mockReset()
})

type SettingsModule = typeof import('./settings')

/**
 * settings.ts 有模块级缓存（cachedUi / inflight），每个用例用全新模块
 * 实例重跑初始化。vi.mock 对 resetModules 后的动态导入依然生效。
 */
let seq = 0
async function freshSettings(): Promise<SettingsModule> {
  vi.resetModules()
  return import(`./settings?fresh${++seq}`)
}

describe('ensureUiSettings / uiSettings', () => {
  it('拉取失败 → {} 且不缓存（下次重试）', async () => {
    const mod = await freshSettings()
    settingsMock.mockRejectedValue(new Error('network down'))
    expect(await mod.ensureUiSettings()).toEqual({})
    expect(mod.uiSettingsLoaded()).toBe(false)
    // 第二次调用会重试
    settingsMock.mockResolvedValue({ ui: { k: false } })
    await mod.ensureUiSettings()
    expect(settingsMock).toHaveBeenCalledTimes(2)
    expect(mod.uiBool('k', true)).toBe(false)
  })

  it('首次拉取成功 → 缓存 + 通知 ready', async () => {
    const mod = await freshSettings()
    settingsMock.mockResolvedValue({ ui: { page_flip_on_send: true, notifications: { condition: 'always' } } })
    const ready = vi.fn()
    mod.onUiSettingsReady(ready)
    const ui = await mod.ensureUiSettings()
    expect(ui).toEqual({ page_flip_on_send: true, notifications: { condition: 'always' } })
    expect(mod.uiBool('page_flip_on_send', false)).toBe(true)
    expect(mod.uiSettingsLoaded()).toBe(true)
    expect(ready).toHaveBeenCalledTimes(1)
  })

  it('并发调用共享一个 inflight', async () => {
    const mod = await freshSettings()
    settingsMock.mockResolvedValue({ ui: { a: 1 } })
    const [a, b] = await Promise.all([mod.ensureUiSettings(), mod.ensureUiSettings()])
    expect(a).toEqual({ a: 1 })
    expect(b).toEqual({ a: 1 })
    expect(settingsMock).toHaveBeenCalledTimes(1)
  })
})

describe('applyUiSettings / 同步访问器', () => {
  it('apply 后立即生效并通知 change 监听', async () => {
    const mod = await freshSettings()
    const change = vi.fn()
    const off = mod.onUiSettingsChange(change)
    mod.applyUiSettings({ collapsed_edit_blocks: true, note: 'x' })
    expect(mod.uiSettings()).toEqual({ collapsed_edit_blocks: true, note: 'x' })
    expect(mod.uiBool('collapsed_edit_blocks', false)).toBe(true)
    expect(mod.uiBool('missing', true)).toBe(true)
    expect(mod.uiString('note')).toBe('x')
    expect(mod.uiString('missing')).toBeUndefined()
    expect(change).toHaveBeenCalledTimes(1)
    off()
    mod.applyUiSettings({})
    expect(change).toHaveBeenCalledTimes(1)
  })

  it('onUiSettingsReady 已加载时立即回调', async () => {
    const mod = await freshSettings()
    mod.applyUiSettings({ a: 1 })
    const cb = vi.fn()
    mod.onUiSettingsReady(cb)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('notificationsSettings 容错', async () => {
    const mod = await freshSettings()
    mod.applyUiSettings({ notifications: {} })
    expect(mod.notificationsSettings()).toEqual({})
    mod.applyUiSettings({ notifications: 'nope' })
    expect(mod.notificationsSettings()).toEqual({})
    mod.applyUiSettings({})
    expect(mod.notificationsSettings()).toEqual({})
  })
})