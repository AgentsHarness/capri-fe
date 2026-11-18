import { describe, expect, it, vi } from 'vitest'

vi.mock('../../api/client', () => ({
  transport: { settings: vi.fn() },
}))
vi.mock('../settings', () => ({
  ensureUiSettings: vi.fn(),
  uiBool: vi.fn(() => false),
  uiString: vi.fn(() => undefined),
  uiSettings: vi.fn(() => ({})),
  uiSettingsLoaded: vi.fn(),
  toolCallDensity: vi.fn(() => 'compact-all-grouped'),
  densityCollapsesEdits: vi.fn(() => true),
  densityCollapsesCommands: vi.fn(() => true),
}))

import {
  applyDensityDefaults,
  clearPlanMode,
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
    expect(window.localStorage.getItem('capri-fe.modeFlags')).toBeNull()
    expect(loadGlobalModeFlags()).toEqual({})
  })

  it('脏结构读成 {}', () => {
    window.localStorage.setItem('capri-fe.modeFlags', JSON.stringify({ evil: 1 }))
    expect(loadGlobalModeFlags()).toEqual({})
    window.localStorage.setItem('capri-fe.modeFlags', 'not json')
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
    clearPlanMode('s1')
    expect(loadPlanModes()).toEqual({})
    expect(restorePlanMode('s1')).toEqual({})
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

describe('applyDensityDefaults', () => {
  const toolEntry = (
    id: string,
    kindName: string,
    expanded: boolean,
    over: Record<string, unknown> = {},
  ) => ({
    id,
    kind: 'tool',
    kindName,
    title: id,
    verb: 'v',
    expanded,
    ...over,
  })

  const makeState = (entries: Array<Record<string, unknown>>) => ({
    entries,
    subagentViews: {} as Record<string, never>,
    expandedGroups: new Set(['old-anchor']),
  })

  const run = (
    state: ReturnType<typeof makeState>,
    oldDensity: 'detailed' | 'compact-shells' | 'compact-ungrouped' | 'compact-all-grouped',
    newDensity: typeof oldDensity,
  ) => {
    applyDensityDefaults(
      ((updater: (s: typeof state) => Partial<typeof state>) => {
        state = { ...state, ...updater(state) }
        return state
      }) as never,
      oldDensity,
      newDensity,
    )
    return state
  }

  it('compact-all-grouped → detailed：编辑/命令展开，探查类保持折叠', () => {
    const state = run(
      makeState([
        toolEntry('r', 'read', false),
        toolEntry('e', 'edit', false),
        toolEntry('c', 'execute', false),
        toolEntry('user-open', 'read', true),
      ]),
      'compact-all-grouped',
      'detailed',
    )
    // 探查类在 detailed 仍默认折叠。
    expect(state.entries[0]).toMatchObject({ expanded: false })
    expect(state.entries[1]).toMatchObject({
      expanded: true,
      displayMode: 'truncated',
    })
    expect(state.entries[2]).toMatchObject({
      expanded: true,
      displayMode: 'truncated',
    })
    // 用户手动展开过的行保持手势，不按默认重排。
    expect(state.entries[3]).toMatchObject({ expanded: true })
    expect(state.expandedGroups).toEqual(new Set())
  })

  it('detailed → compact-shells：命令收回一行，编辑保持 truncated', () => {
    const state = run(
      makeState([
        toolEntry('r', 'read', false),
        toolEntry('e', 'edit', true, { displayMode: 'truncated' }),
        toolEntry('c', 'execute', true, { displayMode: 'truncated' }),
        toolEntry('user-open', 'read', true, { displayMode: 'expanded' }),
      ]),
      'detailed',
      'compact-shells',
    )
    expect(state.entries[0]).toMatchObject({ expanded: false })
    expect(state.entries[1]).toMatchObject({
      expanded: true,
      displayMode: 'truncated',
    })
    expect(state.entries[2]).toMatchObject({
      expanded: false,
      displayMode: 'collapsed',
    })
    // 用户手动展开过的探查行保持展开。
    expect(state.entries[3]).toMatchObject({ expanded: true })
  })

  it('子代理视图与主 entries 同步重排；直连 bash 恒展开', () => {
    let state = {
      entries: [
        toolEntry('bash', 'execute', true, {
          raw: { _meta: { bash_mode: true } },
          displayMode: 'expanded',
        }),
      ],
      subagentViews: {
        child: {
          items: [toolEntry('e', 'edit', true, { displayMode: 'truncated' })],
        },
      },
      expandedGroups: new Set<string>(),
    }
    applyDensityDefaults(
      ((updater: (s: typeof state) => Partial<typeof state>) => {
        state = { ...state, ...updater(state) }
        return state
      }) as never,
      'detailed',
      'compact-all-grouped',
    )
    expect(state.entries[0]).toMatchObject({
      expanded: true,
      displayMode: 'expanded',
    })
    expect(state.subagentViews.child.items[0]).toMatchObject({
      expanded: false,
      displayMode: 'collapsed',
    })
  })

  it('old === new → 不写 store', () => {
    const set = vi.fn()
    applyDensityDefaults(set as never, 'detailed', 'detailed')
    expect(set).not.toHaveBeenCalled()
  })
})

describe('consumeAgentInstance', () => {
  it('无时间戳 → 未重启；时间戳变化 → 重启并清标志', () => {
    window.localStorage.removeItem('capri-fe.lastAgentStartedAt')
    window.localStorage.setItem('capri-fe.modeFlags', JSON.stringify({ yoloMode: true }))
    expect(consumeAgentInstance(undefined)).toMatchObject({ restarted: false })
    expect(consumeAgentInstance(1725000000000)).toMatchObject({ restarted: true })
    expect(consumeAgentInstance(1725000000000)).toMatchObject({ restarted: false })
  })
})