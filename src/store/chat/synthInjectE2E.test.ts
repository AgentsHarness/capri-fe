// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { useChatStore } from '../chat'
import {
  applyEntryLiteStats,
  applyEntryMsgSeq,
  replayUpdates,
  sortEntriesByMsgSeq,
} from './history'
import { settleTurnEntries } from './turnLifecycle'
import { extractToolBodies, applyToolBodies } from './historyFill'
import type { ScrollEntry, ToolCall } from '../../api/types'

vi.mock('../../api/client', () => ({
  transport: {
    loadSessionHistory: vi.fn(),
    queueStatus: vi.fn().mockResolvedValue({ queue: [] }),
    sessionResume: vi.fn(),
    loadSession: vi.fn(),
    sessionStats: vi.fn(),
    sessionRunningTasks: vi.fn(),
    gitInfo: vi.fn(),
    status: vi.fn(),
    rewindExecute: vi.fn(),
    rewindPoints: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    getConnectionMode: vi.fn(() => 'local'),
    prefsOrigin: vi.fn(() => ''),
    getPrefs: vi.fn(async () => ({ prefs: {} })),
    putPrefs: vi.fn(async () => ({})),
    connect: vi.fn(),
    disconnect: vi.fn(),
  },
}))

describe('Host Synthetic ToolCallId + FE Full Completion E2E', () => {
  const sessionPath = '/Users/benin/.grok/sessions/%2FUsers%2Fbenin%2Fccwork/01a0630c-9370-72e0-87ad-ded5d1af3198/updates.jsonl'

  beforeEach(() => {
    useChatStore.setState({ entries: [], toolIndex: {} })
  })

  afterEach(() => {
    useChatStore.setState({ entries: [], toolIndex: {} })
  })

  it('verifies real session 01a0630c reaches 100% full fill rate with synthetic IDs', () => {
    if (!fs.existsSync(sessionPath)) {
      console.warn('Session 01a0630c not found on local machine, skipping')
      return
    }

    const lines = fs.readFileSync(sessionPath, 'utf8').split('\n').filter((l) => l.trim().length > 0)
    const fullUpdates = lines.map((l, idx) => {
      const obj = JSON.parse(l)
      obj.msgSeq = idx
      return obj
    })

    // 模拟 host 端由 resolveSyntheticToolCallIDs 计算并在 localUpdatesPage 中注入的合成 ID：
    // 在 host 端，无 call id 的 tool_call 拿到 synth:call:<startMsgSeq>，后续 update 拿到相同 ID
    // 这里我们运行 host 同步过来的注入逻辑
    type OpenCall = { msgSeq: number; id: string; name: string; cmd?: string; path?: string; offset?: number; hasOffset?: boolean; url?: string; query?: string; taskId?: string }
    let openCalls: OpenCall[] = []
    const injectedFullUpdates = fullUpdates.map((env) => {
      const copy = JSON.parse(JSON.stringify(env))
      const up = copy.params?.update
      if (!up) return copy
      const su = up.sessionUpdate
      if (su === 'turn_completed') {
        openCalls = []
        return copy
      }
      if (su === 'tool_call') {
        let tid = (up.toolCallId || '').trim()
        if (!tid) {
          tid = `synth:call:${copy.msgSeq}`
          up.toolCallId = tid
        }
        const ri = up.rawInput || {}
        openCalls.push({
          msgSeq: copy.msgSeq,
          id: tid,
          name: up.title || up._meta?.['x.ai/tool']?.name || '',
          cmd: ri.command,
          path: ri.target_file || ri.path,
          offset: ri.offset,
          hasOffset: typeof ri.offset === 'number',
          url: ri.url,
          query: ri.query,
          taskId: Array.isArray(ri.task_id) ? ri.task_id[0] : (ri.task_id || ri.taskId),
        })
      } else if (su === 'tool_call_update') {
        let tid = (up.toolCallId || '').trim()
        if (!tid && openCalls.length > 0) {
          // 匹配
          const ri = up.rawInput || {}
          const ro = up.rawOutput || {}
          let matchIdx = -1

          // 1. ri
          const cmd = ri.command
          const p = ri.target_file || ri.path
          const u = ri.url
          const q = ri.query
          const tidArg = ri.task_id || ri.taskId

          if (cmd || p || u || q || tidArg) {
            matchIdx = openCalls.findIndex(
              (c) => (cmd && c.cmd === cmd) || (p && c.path === p) || (u && c.url === u) || (q && c.query === q) || (tidArg && c.taskId === tidArg),
            )
          }

          // 2. ro
          if (matchIdx < 0 && ro && typeof ro === 'object') {
            if (ro.command) {
              matchIdx = openCalls.findIndex((c) => c.cmd === ro.command)
            }
            if (matchIdx < 0 && ro.FileContent?.content) {
              const cnt = String(ro.FileContent.content)
              matchIdx = openCalls.findIndex((c) => {
                if (c.name !== 'read_file') return false
                if (c.hasOffset && cnt.slice(0, 40).includes(`${c.offset}→`)) return true
                if (!c.hasOffset && cnt.slice(0, 40).includes('1→')) return true
                return false
              })
            }
            if (matchIdx < 0 && ro.type) {
              const t = ro.type
              const filterName =
                t === 'Bash'
                  ? 'run_terminal_command'
                  : t === 'WebSearch'
                    ? 'web_search'
                    : t === 'SearchTool'
                      ? 'search_tool'
                      : t === 'TaskOutput'
                        ? 'get_command_or_subagent_output'
                        : t === 'TodosUpdated'
                          ? 'todo_write'
                          : ''
              if (filterName) {
                const cands = openCalls.filter((c) => c.name === filterName)
                if (cands.length === 1) matchIdx = openCalls.indexOf(cands[0]!)
              }
            }
          }

          // 3. text / error
          if (matchIdx < 0) {
            const txt = (up.title || '') + ' ' + (ro?.message || '') + ' ' + JSON.stringify(up.content || '')
            matchIdx = openCalls.findIndex(
              (c) => (c.path && txt.includes(c.path)) || (c.url && txt.includes(c.url)) || (c.taskId && txt.includes(c.taskId)),
            )
          }

          // 4. kind
          if (matchIdx < 0 && up.kind) {
            const k = up.kind
            const targetName =
              k === 'execute'
                ? 'run_terminal_command'
                : k === 'read'
                  ? 'read_file'
                  : k === 'fetch'
                    ? 'web_fetch'
                    : k === 'think'
                      ? 'todo_write'
                      : ''
            if (targetName) {
              const cands = openCalls.filter((c) => c.name === targetName)
              if (cands.length === 1) matchIdx = openCalls.indexOf(cands[0]!)
            }
          }

          // 5. fast fail or sole
          if (matchIdx < 0 && (up.status === 'failed' || openCalls.length === 1)) {
            matchIdx = openCalls.length - 1
          }

          if (matchIdx >= 0) {
            const matched = openCalls[matchIdx]!
            up.toolCallId = matched.id
            if (up.status === 'completed' || up.status === 'failed') {
              openCalls.splice(matchIdx, 1)
            }
          }
        }
      }
      return copy
    })

    // 构造 lite 版本的 updates（模拟 host 的 lite 投影）：
    const injectedLiteUpdates = injectedFullUpdates.map((env) => {
      const copy = JSON.parse(JSON.stringify(env))
      const up = copy.params?.update
      if (!up) return copy
      const su = up.sessionUpdate
      if (su === 'tool_call' || su === 'tool_call_update') {
        let omitted = 0
        const fields: string[] = []
        if (up.content) {
          omitted += 200
          fields.push('content')
          up.content = [{ type: 'text', omitted: 200 }]
        }
        if (up.rawOutput) {
          omitted += 800
          fields.push('rawOutput')
          up.rawOutput = { omitted: 800 }
        }
        if (omitted > 0) {
          up._meta = up._meta || {}
          up._meta.lite = { omitted, fields }
        }
      }
      return copy
    })

    // FE 回放 Lite 页面
    const get = () => useChatStore.getState()
    const replay = replayUpdates(get, injectedLiteUpdates)
    const entries = sortEntriesByMsgSeq(
      applyEntryLiteStats(
        applyEntryMsgSeq(settleTurnEntries(get().entries), replay.entryMsgSeq),
        replay.entryMsgSeqEnd,
        replay.entryLiteOmitted,
      ),
    )
    useChatStore.setState({ entries })

    const toolRows = entries.filter((e) => e.kind === 'tool') as Extract<ScrollEntry, { kind: 'tool' }>[]
    const owedRows = toolRows.filter((e) => (e.liteOmitted ?? 0) > 0)
    expect(owedRows.length).toBeGreaterThan(150)

    // 验证每个工具条目都拿到了非空的 toolCallId
    for (const row of owedRows) {
      expect(row.toolCallId).toBeTruthy()
      expect(row.toolCallId).toMatch(/^synth:call:\d+$/)
    }

    // FE 提取全量正文
    const bodies = extractToolBodies(injectedFullUpdates)
    expect(bodies.size).toBeGreaterThan(150)

    // FE 回填正文
    const afterFill = applyToolBodies(entries, bodies)
    const afterRows = afterFill.filter((e) => e.kind === 'tool') as Extract<ScrollEntry, { kind: 'tool' }>[]
    const filledCount = afterRows.filter((r) => r.liteState === 'filled').length
    const unfilledCount = afterRows.filter((r) => (r.liteOmitted ?? 0) > 0 && r.liteState !== 'filled').length

    expect(unfilledCount).toBe(0)
    expect(filledCount).toBe(owedRows.length)
  })
})
