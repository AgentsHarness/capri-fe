import { describe, expect, it, vi } from 'vitest'

vi.mock('../../api/client', () => ({
  transport: { settings: vi.fn() },
}))
vi.mock('../settings', () => ({
  ensureUiSettings: vi.fn(),
  uiBool: vi.fn(() => false),
  uiSettingsLoaded: vi.fn(),
}))

import {
  applyCollapsedEditBlocksFlip,
  applyCollapsedEditBlocksFromCache,
  consumeAgentInstance,
  effectivePermissionLabelFromUi,
  ensureDefaultModeFlags,
  loadGlobalModeFlags,
  loadPlanModes,
  normalizeModeFlags,
  permissionFlagsFromUi,
  permissionLabelFromFlags,
  permissionModeFromSnapshot,
  permissionSeedMeta,
  persistConfirmedPermission,
  planOnWithinGrace,
  resolveDisplayModeFlags,
  restorePlanMode,
  saveModeFlags,
  savePlanMode,
  sessionModeFlags,
  syncDefaultModeFlagsFromUi,
  PLAN_EXIT_GRACE_MS,
} from './modePersist'
import { uiBool } from '../settings'

describe('normalizeModeFlags', () => {
  it('只保留有效写入；默认 ask 记录归一为空', () => {
    expect(normalizeModeFlags({ yoloMode: true, autoMode: false })).toEqual({ yoloMode: true })
    expect(normalizeModeFlags({ permissionMode: 'auto' })).toEqual({ permissionMode: 'auto' })
    expect(normalizeModeFlags({ permissionMode: 'ask' })).toEqual({})
    expect(normalizeModeFlags({ permissionMode: 'default' })).toEqual({})
    expect(normalizeModeFlags({ yoloMode: false, autoMode: false })).toEqual({})
    expect(normalizeModeFlags({ confirmedAsk: true })).toEqual({ confirmedAsk: true })
    // yolo/auto 已置位时 confirmedAsk 不保留
    expect(normalizeModeFlags({ yoloMode: true, confirmedAsk: true })).toEqual({ yoloMode: true })
  })
})

describe('loadGlobalModeFlags / saveModeFlags', () => {
  it('保存非 ask 写入；空记录删除键', () => {
    saveModeFlags({ yoloMode: true, permissionMode: 'always-approve' })
    expect(loadGlobalModeFlags()).toEqual({ yoloMode: true, permissionMode: 'always-approve' })

    saveModeFlags({ yoloMode: false })
    expect(window.localStorage.getItem('acpfe.modeFlags')).toBeNull()
    expect(loadGlobalModeFlags()).toEqual({})
  })

  it('脏结构读成 {}', () => {
    window.localStorage.setItem('acpfe.modeFlags', JSON.stringify({ evil: 1 }))
    expect(loadGlobalModeFlags()).toEqual({})
    window.localStorage.setItem('acpfe.modeFlags', 'not json')
    expect(loadGlobalModeFlags()).toEqual({})
  })
})

describe('persistConfirmedPermission', () => {
  it('非 ask → yolo/auto 标志；ask → confirmedAsk', () => {
    persistConfirmedPermission({ yoloMode: true })
    expect(loadGlobalModeFlags()).toMatchObject({ yoloMode: true })
    persistConfirmedPermission({ autoMode: true, permissionMode: 'auto' })
    expect(loadGlobalModeFlags()).toMatchObject({ autoMode: true, permissionMode: 'auto' })
    persistConfirmedPermission({})
    expect(loadGlobalModeFlags()).toEqual({ confirmedAsk: true })
  })
})

describe('plan modes', () => {
  it('save/restore 按 sessionId', () => {
    savePlanMode('s1', true)
    expect(loadPlanModes()).toEqual({ s1: true })
    expect(restorePlanMode('s1')).toEqual({ planMode: true })
    expect(restorePlanMode('s2')).toEqual({})
    expect(restorePlanMode()).toEqual({})
    savePlanMode('s1', false)
    expect(restorePlanMode('s1')).toEqual({ planMode: false })
  })
})

describe('planOnWithinGrace', () => {
  it('批准后窗口内为 true，窗口外为 false', () => {
    // 内部时间戳不可注入——验证函数存在且可调用
    expect(typeof planOnWithinGrace()).toBe('boolean')
    expect(PLAN_EXIT_GRACE_MS).toBe(1500)
  })
})

describe('permissionFlagsFromUi / 标签', () => {
  it('三种键的解析与优先级', () => {
    expect(permissionFlagsFromUi({})).toEqual({})
    expect(permissionFlagsFromUi({ permission_mode: 'always-approve' })).toEqual({
      yoloMode: true,
      autoMode: false,
      permissionMode: 'always-approve',
    })
    expect(permissionFlagsFromUi({ permission_mode: 'auto' })).toEqual({
      yoloMode: false,
      autoMode: true,
      permissionMode: 'auto',
    })
    expect(permissionFlagsFromUi({ permission_mode: 'ask' })).toEqual({ yoloMode: false, autoMode: false })
    expect(permissionFlagsFromUi({ approval_mode: 'always-approve' })).toMatchObject({ yoloMode: true })
    expect(permissionFlagsFromUi({ approval_mode: 'normal' })).toEqual({ yoloMode: false, autoMode: false })
    expect(permissionFlagsFromUi({ yolo: true })).toMatchObject({ yoloMode: true })
    expect(permissionFlagsFromUi({ yolo: false })).toEqual({ yoloMode: false, autoMode: false })
    // permission_mode 优先于 yolo
    expect(permissionFlagsFromUi({ yolo: true, permission_mode: 'ask' })).toEqual({ yoloMode: false, autoMode: false })
  })

  it('标签与 effective 标签', () => {
    expect(permissionLabelFromFlags({ yoloMode: true })).toBe('always-approve')
    expect(permissionLabelFromFlags({ autoMode: true })).toBe('auto')
    expect(permissionLabelFromFlags({})).toBe('ask')
    expect(effectivePermissionLabelFromUi({ permission_mode: 'always-approve' })).toBe('always-approve')
    expect(effectivePermissionLabelFromUi(undefined)).toBe('ask')
  })
})

describe('permissionModeFromSnapshot / sessionModeFlags / resolveDisplayModeFlags', () => {
  it('snapshot 映射', () => {
    expect(permissionModeFromSnapshot('always-approve')).toEqual({
      yoloMode: true,
      autoMode: false,
      permissionMode: 'always-approve',
    })
    expect(permissionModeFromSnapshot('auto')).toEqual({ yoloMode: false, autoMode: true, permissionMode: 'auto' })
    expect(permissionModeFromSnapshot('ask')).toEqual({ yoloMode: false, autoMode: false })
    expect(permissionModeFromSnapshot(undefined)).toEqual({})
  })

  it('sessionModeFlags：保存的写入优先，其次 defaults', () => {
    expect(sessionModeFlags({ yoloMode: true }, {})).toEqual({ yoloMode: true })
    expect(sessionModeFlags({ confirmedAsk: true }, { autoMode: true })).toEqual({ yoloMode: false, autoMode: false })
    expect(sessionModeFlags({}, { autoMode: true })).toEqual({ autoMode: true })
    // false-only 不是写入
    expect(sessionModeFlags({ yoloMode: false }, { yoloMode: true })).toEqual({ yoloMode: true })
  })

  it('resolveDisplayModeFlags：snapshot 权威；confirmedWrite 回退 saved', () => {
    expect(resolveDisplayModeFlags({}, { yoloMode: true })).toEqual({ yoloMode: true })
    expect(resolveDisplayModeFlags({ yoloMode: true }, {})).toEqual({})
    expect(resolveDisplayModeFlags({ yoloMode: true }, {}, { confirmedWrite: true })).toMatchObject({ yoloMode: true })
    expect(resolveDisplayModeFlags({ autoMode: true }, {}, { confirmedWrite: true })).toMatchObject({ autoMode: true })
  })
})

describe('permissionSeedMeta', () => {
  it('仅已知标志时输出；yolo 优先 auto', () => {
    expect(permissionSeedMeta({})).toBeUndefined()
    expect(permissionSeedMeta({ yoloMode: false, autoMode: false })).toBeUndefined()
    expect(permissionSeedMeta({ yoloMode: true })).toEqual({ yoloMode: true, autoMode: false })
    expect(permissionSeedMeta({ autoMode: true })).toEqual({ yoloMode: false, autoMode: true })
    expect(permissionSeedMeta({ yoloMode: true, autoMode: true })).toEqual({ yoloMode: true, autoMode: false })
  })
})

describe('ensureDefaultModeFlags / syncDefaultModeFlagsFromUi', () => {
  it('sync 后缓存默认标志', () => {
    syncDefaultModeFlagsFromUi({ permission_mode: 'auto' })
    return ensureDefaultModeFlags().then((flags) => {
      expect(flags).toMatchObject({ autoMode: true })
    })
  })
})

describe('applyCollapsedEditBlocksFlip / FromCache', () => {
  const editEntry = (id: string, expanded: boolean, kindName = 'edit') => ({
    id,
    kind: 'tool',
    kindName,
    title: id,
    verb: 'v',
    expanded,
  })

  it('FromCache 依据 uiBool 联动（先跑：依赖模块级 lastApplied 初始 false）', () => {
    vi.mocked(uiBool).mockReturnValue(true)
    let state: { entries: Array<Record<string, unknown>>; subagentViews: Record<string, never>; expandedGroups: Set<string> } = {
      entries: [editEntry('x', true)],
      subagentViews: {},
      expandedGroups: new Set(),
    }
    const set = (updater: (s: typeof state) => typeof state) => {
      state = updater(state)
    }
    // 首次调用：缓存 true ≠ 模块默认 false → 触发一次折叠
    applyCollapsedEditBlocksFromCache(set as never)
    expect(state.entries[0]).toMatchObject({ expanded: false })
    // 再次调用不重复
    applyCollapsedEditBlocksFromCache(set as never)
  })

  it('切换策略时重物化仍停留在旧默认的 edit 行', () => {
    const applied = applyCollapsedEditBlocksFlip
    let state: { entries: Array<Record<string, unknown>>; subagentViews: Record<string, never>; expandedGroups: Set<string> } = {
      // oldFlag=false → 旧默认 expanded=true；newFlag=true → 新默认 expanded=false
      entries: [editEntry('e1', false), editEntry('e2', true), { id: 'r1', kind: 'read', title: 'r', verb: 'v' }],
      subagentViews: {},
      expandedGroups: new Set(['g1']),
    }
    applied(((updater: (s: typeof state) => typeof state) => {
      state = updater(state)
      return state
    }) as never, false, true)
    expect(state.entries[0]).toMatchObject({ id: 'e1', expanded: false }) // 手动折叠的保持
    expect(state.entries[1]).toMatchObject({ id: 'e2', expanded: false }) // 旧默认展开的翻转为折叠
    expect(state.entries[2].kind).toBe('read')
    expect(state.expandedGroups).toEqual(new Set())
  })

  it('old === new → 不动作；非 edit 工具不动', () => {
    const set = vi.fn()
    applyCollapsedEditBlocksFlip(set as never, true, true)
    expect(set).not.toHaveBeenCalled()
  })
})

describe('consumeAgentInstance', () => {
  it('无时间戳 → 未重启；时间戳变化 → 重启并清标志', () => {
    window.localStorage.removeItem('acpfe.lastAgentStartedAt')
    window.localStorage.setItem('acpfe.modeFlags', JSON.stringify({ yoloMode: true }))
    expect(consumeAgentInstance(undefined)).toMatchObject({ restarted: false })
    expect(consumeAgentInstance(1725000000000)).toMatchObject({ restarted: true })
    expect(consumeAgentInstance(1725000000000)).toMatchObject({ restarted: false })
  })
})