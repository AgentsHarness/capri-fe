import { describe, expect, it } from 'vitest'
import type { ScrollEntry } from '../api/types'
import type { AccentResolveOpts } from '../theme/accents'
import { accentOpts } from './accentOpts'

describe('accentOpts', () => {
  const base: AccentResolveOpts = {
    kind: 'user',
    running: false,
    failed: false,
    expanded: false,
    selected: false,
    hovered: false,
    pendingFreeze: false,
    now: 1000,
    inGroup: false,
  }

  it('普通条目透传基础字段（短 user 文本视为已展开）', () => {
    const e: ScrollEntry = { id: 'u', kind: 'user', text: 'x' }
    expect(accentOpts(e, true, false, 1000, true)).toEqual({
      ...base,
      kind: 'user',
      expanded: true,
      selected: true,
      hovered: true,
    })
  })

  it('tool → kindName + finishedAt', () => {
    const e: ScrollEntry = {
      id: 't',
      kind: 'tool',
      title: 't',
      verb: 'v',
      kindName: 'read',
      status: 'completed',
      finishedAt: 900,
    }
    expect(accentOpts(e, false, false, 1000)).toEqual({
      ...base,
      kind: 'tool',
      kindName: 'read',
      finishedAt: 900,
      running: false,
      failed: false,
    })
  })

  it('tool（running）→ running: true；failed 状态识别', () => {
    const running: ScrollEntry = {
      id: 't',
      kind: 'tool',
      title: 't',
      verb: 'v',
      status: 'in_progress',
    }
    expect(accentOpts(running, false, false, 1000).running).toBe(true)
    const failed: ScrollEntry = {
      id: 't',
      kind: 'tool',
      title: 't',
      verb: 'v',
      status: 'failed',
    }
    expect(accentOpts(failed, false, false, 1000).failed).toBe(true)
  })

  it('thought → finishedAt，无 kindName', () => {
    const e: ScrollEntry = { id: 'th', kind: 'thought', text: 'x', finishedAt: 950 }
    expect(accentOpts(e, false, false, 1000)).toEqual({
      ...base,
      kind: 'thought',
      finishedAt: 950,
    })
  })

  it('subagent → subagentStatus；workflow → workflowStatus；bg_task → bgTaskStatus', () => {
    const sa: ScrollEntry = { id: 's', kind: 'subagent', title: 's', status: 'started', running: true }
    expect(accentOpts(sa, false, false, 1000).subagentStatus).toBe('started')

    const wf: ScrollEntry = { id: 'w', kind: 'workflow', title: 'w', status: 'running', running: true }
    expect(accentOpts(wf, false, false, 1000).workflowStatus).toBe('running')

    const bg: ScrollEntry = { id: 'b', kind: 'bg_task', title: 'b', status: 'started', running: true }
    expect(accentOpts(bg, false, false, 1000).bgTaskStatus).toBe('started')
  })

  it('session_event → recap/warning 透传；group_header → verbRun 或 truncation', () => {
    const se: ScrollEntry = { id: 'e', kind: 'session_event', text: 'x', recap: true, warning: false }
    expect(accentOpts(se, false, false, 1000).sessionEvent).toEqual({ recap: true, warning: false })

    const gh: ScrollEntry = {
      id: 'g',
      kind: 'group_header',
      count: 2,
      verbRun: { running: true, failed: false, verb: 'Read' },
    }
    expect(accentOpts(gh, false, false, 1000).groupHeader).toEqual({
      variant: 'verb',
      running: true,
      failed: false,
    })

    const trunc: ScrollEntry = { id: 'g2', kind: 'group_header', count: 5 }
    expect(accentOpts(trunc, false, false, 1000).groupHeader).toEqual({
      variant: 'truncation',
    })
  })

  it('pendingFreeze 透传', () => {
    const e: ScrollEntry = { id: 'u', kind: 'user', text: 'x' }
    expect(accentOpts(e, false, true, 1000).pendingFreeze).toBe(true)
  })
})