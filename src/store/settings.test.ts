import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api/client', () => ({
  transport: {
    settings: vi.fn(),
    apiUrl: vi.fn((p: string) => p),
    getConnectionMode: vi.fn(() => 'local'),
    getHost: vi.fn(() => null),
  },
}))

import { transport } from '../api/client'

const settingsMock = vi.mocked(transport.settings)
const apiUrlMock = vi.mocked(transport.apiUrl)
const modeMock = vi.mocked(transport.getConnectionMode)
const hostMock = vi.mocked(transport.getHost)

beforeEach(() => {
  settingsMock.mockReset()
  apiUrlMock.mockReset()
  apiUrlMock.mockImplementation((p: string) => p)
  modeMock.mockReset()
  modeMock.mockReturnValue('local')
  hostMock.mockReset()
  hostMock.mockReturnValue(null)
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

// ── 同端点只问一次（GET /api/settings 是同一份完整应答）────────────────
describe('settings 请求去重', () => {
  it('[ui] 与 toolset 两个分区共用同一次 GET', async () => {
    const mod = await freshSettings()
    settingsMock.mockResolvedValue({
      ui: { page_flip_on_send: true },
      toolset: { ask_user_question: { timeout_secs: 60 } },
    })
    const [ui, ts] = await Promise.all([
      mod.ensureUiSettings(),
      mod.ensureToolsetSettings(),
    ])
    expect(ui).toEqual({ page_flip_on_send: true })
    expect(ts.ask_user_question?.timeout_secs).toBe(60)
    expect(settingsMock).toHaveBeenCalledTimes(1)
  })

  it('同一端点已读到数据 → 再次 ensure 不发请求', async () => {
    const mod = await freshSettings()
    settingsMock.mockResolvedValue({ ui: { a: 1 } })
    await mod.ensureUiSettings()
    await mod.ensureUiSettings()
    expect(settingsMock).toHaveBeenCalledTimes(1)
  })

  it('换 host（apiUrl 变了）→ 必须重读，旧 host 的 [ui] 不跨 host 复用', async () => {
    const mod = await freshSettings()
    settingsMock.mockResolvedValue({ ui: { yolo: false } })
    expect(await mod.ensureUiSettings()).toEqual({ yolo: false })
    // 选中另一台 host：同一个 path 现在指向不同端点
    apiUrlMock.mockImplementation((p: string) => `${p}?host=mbp`)
    settingsMock.mockResolvedValue({ ui: { yolo: true } })
    expect(await mod.ensureUiSettings()).toEqual({ yolo: true })
    expect(settingsMock).toHaveBeenCalledTimes(2)
    expect(mod.uiBool('yolo', false)).toBe(true)
  })

  it('hub 模式尚未选中 host → 不打这条注定 404 的请求', async () => {
    const mod = await freshSettings()
    modeMock.mockReturnValue('hub')
    hostMock.mockReturnValue(null)
    expect(await mod.ensureUiSettings()).toEqual({})
    expect(settingsMock).not.toHaveBeenCalled()
    // host 选定后照常能拉
    hostMock.mockReturnValue('mba')
    settingsMock.mockResolvedValue({ ui: { k: true } })
    expect(await mod.ensureUiSettings()).toEqual({ k: true })
    expect(settingsMock).toHaveBeenCalledTimes(1)
  })

  it('refreshUiSettings 与在途的 ensure 共享同一条请求', async () => {
    const mod = await freshSettings()
    let resolve!: (v: unknown) => void
    settingsMock.mockReturnValue(
      new Promise((r) => {
        resolve = r
      }) as never,
    )
    const a = mod.ensureUiSettings()
    const b = mod.refreshUiSettings()
    resolve({ ui: { page_flip_on_send: true } })
    expect(await a).toEqual({ page_flip_on_send: true })
    expect(await b).toEqual({ page_flip_on_send: true })
    expect(settingsMock).toHaveBeenCalledTimes(1)
  })
})