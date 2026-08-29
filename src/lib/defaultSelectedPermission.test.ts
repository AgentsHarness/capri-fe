import { describe, expect, it, afterEach } from 'vitest'
import {
  DEFAULT_SELECTED_PERMISSION_DFLT,
  DEFAULT_SELECTED_PERMISSION_KEY,
  loadDefaultSelectedPermission,
  resolveInitialSelection,
  saveDefaultSelectedPermission,
  type PermissionOptionLike,
} from './defaultSelectedPermission'
import { loadStr, removeKey, saveStr } from './storage'

function opt(optionId: string, over: Partial<PermissionOptionLike> = {}): PermissionOptionLike {
  return { optionId, ...over }
}

afterEach(() => {
  window.localStorage.clear()
})

describe('defaultSelectedPermission — 持久化', () => {
  it('未设置 → 默认 always_allow_all_sessions；保存后可读回', () => {
    expect(loadDefaultSelectedPermission()).toBe('always_allow_all_sessions')
    saveDefaultSelectedPermission('allow_once')
    expect(loadDefaultSelectedPermission()).toBe('allow_once')
    saveDefaultSelectedPermission('allow_command_always')
    expect(loadDefaultSelectedPermission()).toBe('allow_command_always')
    saveDefaultSelectedPermission('reject')
    expect(loadDefaultSelectedPermission()).toBe('reject')
    saveDefaultSelectedPermission('always_allow_all_sessions')
    expect(loadDefaultSelectedPermission()).toBe('always_allow_all_sessions')
  })

  it('无法识别的存储值 → 回到默认（对齐 TUI from_config_value 全映射）', () => {
    saveStr(DEFAULT_SELECTED_PERMISSION_KEY, 'bogus')
    expect(loadDefaultSelectedPermission()).toBe(DEFAULT_SELECTED_PERMISSION_DFLT)
    saveStr(DEFAULT_SELECTED_PERMISSION_KEY, '')
    expect(loadDefaultSelectedPermission()).toBe(DEFAULT_SELECTED_PERMISSION_DFLT)
    removeKey(DEFAULT_SELECTED_PERMISSION_KEY)
    expect(loadDefaultSelectedPermission()).toBe(DEFAULT_SELECTED_PERMISSION_DFLT)
    expect(loadStr(DEFAULT_SELECTED_PERMISSION_KEY)).toBeNull()
  })
})

describe('resolveInitialSelection — 默认（always_allow_all_sessions）', () => {
  it('未设置时按身份选中 enable-always-approve 行（不在 0 也能命中）', () => {
    const options = [
      opt('allow-once', { name: 'Yes' }),
      opt('enable-always-approve', { name: 'Yes, and always-approve from now on' }),
      opt('reject-once', { name: 'No' }),
    ]
    expect(resolveInitialSelection(options, 'always_allow_all_sessions')).toBe(1)
  })

  it('没有 enable-always-approve 行 → 回落 0', () => {
    const options = [opt('allow-once'), opt('reject-once')]
    expect(resolveInitialSelection(options, 'always_allow_all_sessions')).toBe(0)
    expect(resolveInitialSelection([], 'always_allow_all_sessions')).toBe(0)
  })
})

describe('resolveInitialSelection — allow_once', () => {
  it('跳过同 kind 的 YOLO 行（YOLO 的 kind 就是 allow_once），落在普通 allow 行', () => {
    const options = [
      opt('enable-always-approve', { kind: 'allow_once' }),
      opt('allow-once', { kind: 'allow_once', name: 'Yes, proceed' }),
      opt('reject-once', { kind: 'reject_once' }),
    ]
    expect(resolveInitialSelection(options, 'allow_once')).toBe(1)
  })

  it('kind 字段缺失时按 kebab optionId 识别', () => {
    const options = [opt('enable-always-approve'), opt('allow-once'), opt('reject-once')]
    expect(resolveInitialSelection(options, 'allow_once')).toBe(1)
  })

  it('找不到 allow-once 行 → 回落 0', () => {
    const options = [opt('enable-always-approve'), opt('reject-once')]
    expect(resolveInitialSelection(options, 'allow_once')).toBe(0)
  })
})

describe('resolveInitialSelection — allow_command_always', () => {
  it('选中 allow-always 类行（per-command / per-mcp / per-domain）', () => {
    const options = [
      opt('enable-always-approve', { kind: 'allow_once' }),
      opt('allow-once', { kind: 'allow_once' }),
      opt('allow-always-command', { kind: 'allow_always' }),
      opt('reject-once', { kind: 'reject_once' }),
    ]
    expect(resolveInitialSelection(options, 'allow_command_always')).toBe(2)
    const mcp = [
      opt('enable-always-approve', { kind: 'allow_once' }),
      opt('allow-always-mcp', { kind: 'allow_always' }),
      opt('allow-once', { kind: 'allow_once' }),
    ]
    expect(resolveInitialSelection(mcp, 'allow_command_always')).toBe(1)
  })

  it('kind 缺失时按 optionId 识别 always-allow / allow-edits-session', () => {
    const options = [opt('allow-once'), opt('always-allow'), opt('reject-once')]
    expect(resolveInitialSelection(options, 'allow_command_always')).toBe(1)
    const edits = [opt('allow-once'), opt('allow-edits-session')]
    expect(resolveInitialSelection(edits, 'allow_command_always')).toBe(1)
  })

  it('绝不选中全局 always 行：即使老 host 把 YOLO 标成 allow_always，身份排除优先', () => {
    // 最容易被写错的一条：YOLO 行的 optionId 含 always、标签也含 always，
    // 用 isAlwaysOption/ALWAYS_RE 匹配就会命中它；身份匹配必须优先。
    const options = [
      opt('enable-always-approve', {
        kind: 'allow_always',
        name: "Yes, and don't ask again for anything (always-approve mode)",
      }),
      opt('allow-always-command', { kind: 'allow_always' }),
      opt('allow-once', { kind: 'allow_once' }),
    ]
    expect(resolveInitialSelection(options, 'allow_command_always')).toBe(1)
  })

  it('标签兜底：无 kind/无识别 optionId 时按标签识别；全局行标签优先归为 allow_once', () => {
    const options = [
      opt('yolo-row', { name: 'Yes, and always-approve from now on' }),
      opt('always', { name: '始终允许该命令' }),
      opt('yes', { name: '允许一次' }),
    ]
    expect(resolveInitialSelection(options, 'allow_command_always')).toBe(1)
    // 清理后只剩全局行标签 → 不命中 allow_always → 回落 0
    const onlyYolo = [opt('yolo-row', { name: '始终允许（所有会话）' }), opt('yes', { name: '允许一次' })]
    expect(resolveInitialSelection(onlyYolo, 'allow_command_always')).toBe(0)
  })

  it('没有任何 allow-always 行 → 回落 0', () => {
    const options = [
      opt('enable-always-approve', { kind: 'allow_once' }),
      opt('allow-once', { kind: 'allow_once' }),
      opt('reject-once', { kind: 'reject_once' }),
    ]
    expect(resolveInitialSelection(options, 'allow_command_always')).toBe(0)
  })
})

describe('resolveInitialSelection — reject', () => {
  it('命中 reject-once', () => {
    const options = [
      opt('enable-always-approve', { kind: 'allow_once' }),
      opt('allow-once', { kind: 'allow_once' }),
      opt('reject-once', { kind: 'reject_once' }),
    ]
    expect(resolveInitialSelection(options, 'reject')).toBe(2)
  })

  it('只提供 reject-always 的弹窗也能命中（TUI matches_kind 两种 reject kind 都算）', () => {
    const options = [
      opt('enable-always-approve', { kind: 'allow_once' }),
      opt('allow-once', { kind: 'allow_once' }),
      opt('reject-always', { kind: 'reject_always' }),
    ]
    expect(resolveInitialSelection(options, 'reject')).toBe(2)
    const kebab = [opt('allow-once'), opt('reject-always-command')]
    expect(resolveInitialSelection(kebab, 'reject')).toBe(1)
  })

  it('标签兜底：无 kind/无识别 optionId 时按标签识别 reject', () => {
    const options = [opt('yes', { name: '允许一次' }), opt('no', { name: '拒绝' })]
    expect(resolveInitialSelection(options, 'reject')).toBe(1)
  })

  it('没有 reject 行 → 回落 0', () => {
    const options = [opt('enable-always-approve'), opt('allow-once')]
    expect(resolveInitialSelection(options, 'reject')).toBe(0)
  })
})