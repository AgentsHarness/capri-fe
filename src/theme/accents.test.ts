import { describe, expect, it } from 'vitest'
import { FINISH_FLASH_MS } from './wave'
import { Accents, resolveAccent, resolveBullet, type AccentResolveOpts } from './accents'

function opts(over: Partial<AccentResolveOpts> = {}): AccentResolveOpts {
  return { kind: 'user', now: 10_000, ...over }
}

const noPaint = { show: false, color: 'transparent', animated: false }

describe('resolveAccent — finish flash', () => {
  it('thought 完成闪：thinking 色；折叠行不画 rail（TUI Collapsed 门）', () => {
    const p = resolveAccent(
      opts({ kind: 'thought', finishedAt: 9_999, expanded: true }),
    )
    expect(p).toMatchObject({ show: true, color: Accents.thinking, animated: false })
    const collapsed = resolveAccent(opts({ kind: 'thought', finishedAt: 9_999 }))
    expect(collapsed).toEqual(noPaint)
  })

  it('tool execute 完成闪：成功绿 / 失败红（展开态）', () => {
    const ok = resolveAccent(
      opts({ kind: 'tool', kindName: 'execute', finishedAt: 9_999, expanded: true }),
    )
    expect(ok).toMatchObject({ show: true, color: Accents.success })
    const bad = resolveAccent(
      opts({ kind: 'tool', kindName: 'execute', failed: true, finishedAt: 9_999, expanded: true }),
    )
    expect(bad).toMatchObject({ show: true, color: Accents.error })
  })

  it('standard 工具完成闪：tool 色 / 失败 error', () => {
    const p = resolveAccent(
      opts({ kind: 'tool', kindName: 'mcp', finishedAt: 9_999, expanded: true }),
    )
    expect(p).toMatchObject({ color: Accents.tool })
  })

  it('never / edit 家族失败也闪绿（TUI unwrap_or(accent_success)）', () => {
    const bad = resolveAccent(
      opts({ kind: 'tool', kindName: 'read', failed: true, finishedAt: 9_999, expanded: true }),
    )
    expect(bad).toMatchObject({ show: true, color: Accents.success })
    const badEdit = resolveAccent(
      opts({ kind: 'tool', kindName: 'edit', failed: true, finishedAt: 9_999, expanded: true }),
    )
    expect(badEdit).toMatchObject({ show: true, color: Accents.success })
  })

  it('窗口外不闪（>= FINISH_FLASH_MS 前）', () => {
    const p = resolveAccent(opts({ kind: 'tool', kindName: 'read', finishedAt: 10_000 - FINISH_FLASH_MS }))
    // read 是 never 家族 → 无 rail
    expect(p).toEqual(noPaint)
  })

  it('running 中不闪', () => {
    const p = resolveAccent(opts({ kind: 'thought', running: true, finishedAt: 9_999 }))
    expect(p).toMatchObject({ color: Accents.thinkingDefault, animated: true })
  })
})

describe('resolveAccent — group_header', () => {
  it('verb 失败 → error；running → tool 动效 + freeze', () => {
    const f = resolveAccent(opts({ kind: 'group_header', groupHeader: { variant: 'verb', failed: true } }))
    expect(f).toMatchObject({ show: true, color: Accents.error })

    const r = resolveAccent(
      opts({ kind: 'group_header', groupHeader: { variant: 'verb', running: true }, pendingFreeze: true }),
    )
    expect(r).toMatchObject({ show: true, color: Accents.tool, animated: true, frozen: true })

    const idle = resolveAccent(opts({ kind: 'group_header', groupHeader: { variant: 'verb' } }))
    expect(idle).toMatchObject({ show: true, color: Accents.tool, collapsedGlyph: true, dim: true })
  })

  it('truncation header → 短 tick dim', () => {
    const p = resolveAccent(opts({ kind: 'group_header', groupHeader: { variant: 'truncation' } }))
    expect(p).toMatchObject({ show: true, color: Accents.tool, collapsedGlyph: true, dim: true })
  })

  it('无 groupHeader 信息 → 兜底无色（不画）', () => {
    expect(resolveAccent(opts({ kind: 'group_header' }))).toEqual(noPaint)
  })
})

describe('resolveAccent — subagent / workflow / bg_task / session_event', () => {
  it('subagent started + running → running 色；其余无色', () => {
    expect(
      resolveAccent(opts({ kind: 'subagent', subagentStatus: 'started', running: true })),
    ).toMatchObject({ show: true, color: Accents.running })
    expect(resolveAccent(opts({ kind: 'subagent', subagentStatus: 'completed' }))).toEqual(noPaint)
  })

  it('workflow running → running 色；done → 无色', () => {
    expect(
      resolveAccent(opts({ kind: 'workflow', workflowStatus: 'running', running: true })),
    ).toMatchObject({ show: true, color: Accents.running })
    expect(resolveAccent(opts({ kind: 'workflow', workflowStatus: 'done' }))).toEqual(noPaint)
  })

  it('bg_task running → running 色；否则无色', () => {
    expect(resolveAccent(opts({ kind: 'bg_task', running: true }))).toMatchObject({
      show: true,
      color: Accents.running,
    })
    expect(resolveAccent(opts({ kind: 'bg_task' }))).toEqual(noPaint)
  })

  it('session_event：warning → warning 色；recap running → gray 动效；recap expanded → tool 色', () => {
    expect(resolveAccent(opts({ kind: 'session_event', sessionEvent: { warning: true } }))).toMatchObject({
      show: true,
      color: Accents.warning,
    })
    expect(
      resolveAccent(opts({ kind: 'session_event', sessionEvent: { recap: true }, running: true })),
    ).toMatchObject({ show: true, color: Accents.gray, animated: true })
    expect(
      resolveAccent(opts({ kind: 'session_event', sessionEvent: { recap: true }, expanded: true })),
    ).toMatchObject({ show: true, color: Accents.tool })
    expect(resolveAccent(opts({ kind: 'session_event', sessionEvent: { recap: true } }))).toEqual(noPaint)
  })
})

describe('resolveAccent — credit_limit / plan / error / user / status', () => {
  it('credit_limit 与 plan 与 error 各有色', () => {
    expect(resolveAccent(opts({ kind: 'credit_limit' }))).toMatchObject({ color: Accents.warning })
    expect(resolveAccent(opts({ kind: 'plan' }))).toMatchObject({ color: Accents.plan })
    expect(resolveAccent(opts({ kind: 'error' }))).toMatchObject({ color: Accents.error })
  })

  it('user / assistant / status → 从不画色', () => {
    expect(resolveAccent(opts({ kind: 'user' }))).toEqual(noPaint)
    expect(resolveAccent(opts({ kind: 'assistant' }))).toEqual(noPaint)
    expect(resolveAccent(opts({ kind: 'status' }))).toEqual(noPaint)
  })
})

describe('resolveAccent — thought 状态机', () => {
  it('折叠空闲：组内短 tick，组外无色', () => {
    expect(resolveAccent(opts({ kind: 'thought' }))).toEqual(noPaint)
    expect(resolveAccent(opts({ kind: 'thought', inGroup: true }))).toMatchObject({
      show: true,
      color: Accents.thinkingDefault,
      collapsedGlyph: true,
      dim: true,
    })
  })

  it('running → 动效；展开 → 静态色', () => {
    expect(resolveAccent(opts({ kind: 'thought', running: true }))).toMatchObject({
      color: Accents.thinkingDefault,
      animated: true,
    })
    expect(resolveAccent(opts({ kind: 'thought', expanded: true }))).toMatchObject({
      color: Accents.thinkingDefault,
      animated: false,
    })
  })
})

describe('resolveAccent — tool 家族矩阵', () => {
  it('read/search/list_dir（never）→ 永不画', () => {
    expect(resolveAccent(opts({ kind: 'tool', kindName: 'read' }))).toEqual(noPaint)
    expect(resolveAccent(opts({ kind: 'tool', kindName: 'read', running: true }))).toEqual(noPaint)
    expect(resolveAccent(opts({ kind: 'tool', kindName: 'search', failed: true }))).toEqual(noPaint)
  })

  it('edit → 默认无 rail', () => {
    expect(resolveAccent(opts({ kind: 'tool', kindName: 'edit', running: true }))).toEqual(noPaint)
  })

  it('execute：折叠短 tick dim；running animated + freeze；失败红', () => {
    const collapsed = resolveAccent(opts({ kind: 'tool', kindName: 'execute' }))
    expect(collapsed).toMatchObject({ show: true, color: Accents.success, collapsedGlyph: true, dim: true })

    const running = resolveAccent(opts({ kind: 'tool', kindName: 'execute', running: true, pendingFreeze: true }))
    expect(running).toMatchObject({ show: true, color: Accents.running, animated: true, frozen: true, collapsedGlyph: false })

    const failed = resolveAccent(opts({ kind: 'tool', kindName: 'execute', failed: true }))
    expect(failed).toMatchObject({ show: true, color: Accents.error })

    const expanded = resolveAccent(opts({ kind: 'tool', kindName: 'execute', expanded: true }))
    expect(expanded).toMatchObject({ collapsedGlyph: false })
  })

  it('standard：折叠不画；失败/运行/展开才画', () => {
    expect(resolveAccent(opts({ kind: 'tool', kindName: 'mcp' }))).toEqual(noPaint)
    expect(
      resolveAccent(opts({ kind: 'tool', kindName: 'mcp', failed: true })),
    ).toEqual(noPaint)
    expect(resolveAccent(opts({ kind: 'tool', kindName: 'mcp', running: true }))).toMatchObject({
      color: Accents.running,
      animated: true,
    })
    expect(resolveAccent(opts({ kind: 'tool', kindName: 'mcp', expanded: true }))).toMatchObject({
      color: Accents.tool,
    })
  })
})

describe('resolveAccent — interaction', () => {
  it('selected > hover（仅颜色，不改高度）', () => {
    const p = resolveAccent(opts({ kind: 'tool', kindName: 'execute', expanded: true, selected: true, hovered: true }))
    expect(p).toMatchObject({ interaction: 'selected', dim: false })
    const h = resolveAccent(opts({ kind: 'tool', kindName: 'execute', expanded: true, hovered: true }))
    expect(h).toMatchObject({ interaction: 'hover', dim: false })
    const idle = resolveAccent(opts({ kind: 'tool', kindName: 'execute', expanded: true }))
    expect(idle).toMatchObject({ interaction: 'idle' })
  })

  it('无色条目不受 interaction 影响', () => {
    const p = resolveAccent(opts({ kind: 'user', selected: true, hovered: true }))
    expect(p).toEqual(noPaint)
  })
})

describe('resolveBullet', () => {
  it('thought：running 动效（freeze 停），否则灰', () => {
    expect(resolveBullet(opts({ kind: 'thought', running: true }))).toEqual({
      color: Accents.thinkingDefault,
      animated: true,
    })
    expect(resolveBullet(opts({ kind: 'thought', running: true, pendingFreeze: true }))).toEqual({
      color: Accents.thinkingDefault,
      animated: false,
    })
    expect(resolveBullet(opts({ kind: 'thought' }))).toEqual({ color: Accents.gray })
  })

  it('tool：failed 红；execute 运行/成功；never/edit 灰阶；standard 三态', () => {
    expect(resolveBullet(opts({ kind: 'tool', kindName: 'mcp', failed: true }))).toEqual({ color: Accents.error })
    expect(resolveBullet(opts({ kind: 'tool', kindName: 'execute', running: true }))).toEqual({
      color: Accents.running,
      animated: true,
    })
    expect(resolveBullet(opts({ kind: 'tool', kindName: 'execute' }))).toEqual({ color: Accents.success })
    expect(resolveBullet(opts({ kind: 'tool', kindName: 'read' }))).toEqual({ color: Accents.grayDim })
    expect(resolveBullet(opts({ kind: 'tool', kindName: 'read', expanded: true }))).toEqual({ color: Accents.gray })
    expect(resolveBullet(opts({ kind: 'tool', kindName: 'mcp', running: true }))).toEqual({
      color: Accents.running,
      animated: true,
    })
    expect(resolveBullet(opts({ kind: 'tool', kindName: 'mcp', expanded: true }))).toEqual({ color: Accents.tool })
    expect(resolveBullet(opts({ kind: 'tool', kindName: 'mcp' }))).toEqual({ color: Accents.grayDim })
  })

  it('subagent / workflow / bg_task 状态色', () => {
    expect(resolveBullet(opts({ kind: 'subagent', subagentStatus: 'started', running: true }))).toMatchObject({
      color: Accents.running,
    })
    expect(resolveBullet(opts({ kind: 'subagent', subagentStatus: 'completed' }))).toEqual({ color: Accents.success })
    expect(resolveBullet(opts({ kind: 'subagent', subagentStatus: 'failed' }))).toEqual({ color: Accents.error })
    expect(resolveBullet(opts({ kind: 'subagent', subagentStatus: 'cancelled' }))).toEqual({ color: Accents.error })

    expect(resolveBullet(opts({ kind: 'workflow', workflowStatus: 'running', running: true }))).toMatchObject({
      color: Accents.running,
    })
    expect(resolveBullet(opts({ kind: 'workflow', workflowStatus: 'done' }))).toEqual({ color: Accents.success })
    expect(resolveBullet(opts({ kind: 'workflow', workflowStatus: 'failed' }))).toEqual({ color: Accents.error })
    expect(resolveBullet(opts({ kind: 'workflow', workflowStatus: 'cancelled' }))).toEqual({ color: Accents.grayDim })
    expect(resolveBullet(opts({ kind: 'workflow', workflowStatus: 'paused' }))).toEqual({ color: Accents.warning })

    expect(resolveBullet(opts({ kind: 'bg_task', running: true }))).toMatchObject({ color: Accents.running })
    expect(resolveBullet(opts({ kind: 'bg_task', failed: true }))).toEqual({ color: Accents.error })
    expect(resolveBullet(opts({ kind: 'bg_task', bgTaskStatus: 'started' }))).toEqual({
      color: Accents.running,
      animated: false,
    })
    expect(resolveBullet(opts({ kind: 'bg_task', bgTaskStatus: 'completed' }))).toEqual({ color: Accents.success })
  })

  it('error / group_header / 其余 → gray 系', () => {
    expect(resolveBullet(opts({ kind: 'error' }))).toEqual({ color: Accents.error })
    expect(
      resolveBullet(opts({ kind: 'group_header', groupHeader: { variant: 'verb', running: true } })),
    ).toEqual({ color: Accents.tool, animated: true })
    expect(resolveBullet(opts({ kind: 'group_header', groupHeader: { variant: 'verb', failed: true } }))).toEqual({
      color: Accents.error,
    })
    expect(resolveBullet(opts({ kind: 'user' }))).toEqual({ color: Accents.gray })
    expect(resolveBullet(opts({ kind: 'unknown_kind' }))).toEqual({ color: Accents.gray })
  })
})