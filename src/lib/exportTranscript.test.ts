import { describe, expect, it } from 'vitest'
import type { ScrollEntry } from '../api/types'
import {
  likelyOlderHistory,
  renderTranscript,
  safeExportFilename,
  type ExportMeta,
} from './exportTranscript'

function user(text: string): ScrollEntry {
  return { id: `u-${text.length}`, kind: 'user', text } as ScrollEntry
}

function assistant(text: string): ScrollEntry {
  return { id: `a-${text.length}`, kind: 'assistant', text } as ScrollEntry
}

function thought(text: string): ScrollEntry {
  return { id: 't', kind: 'thought', text } as ScrollEntry
}

function status(text: string): ScrollEntry {
  return { id: 's', kind: 'status', text } as ScrollEntry
}

function tool(partial: Partial<Extract<ScrollEntry, { kind: 'tool' }>> = {}): ScrollEntry {
  return {
    id: 'tool-1',
    kind: 'tool',
    title: 'Read: /tmp/x',
    verb: 'read',
    ...partial,
  } as ScrollEntry
}

function readTool(extra: Record<string, unknown> = {}): ScrollEntry {
  return tool({
    kindName: 'read',
    title: '/tmp/x.txt',
    raw: {
      kind: 'read',
      title: '/tmp/x.txt',
      rawInput: { file_path: '/tmp/x.txt', offset: 1, limit: 3 },
      rawOutput: { FileContent: { content: 'a\nb\nc', total_lines: 5 } },
      ...extra,
    },
  })
}

describe('renderTranscript — TUI render_blocks_to_markdown 对齐', () => {
  it('空 entries → 空字符串', () => {
    expect(renderTranscript([])).toBe('')
  })

  it('只有非对话 chrome（status/error/thought/plan）→ 空字符串', () => {
    expect(
      renderTranscript([
        status('ready'),
        thought('不该出现'),
        { id: 'e', kind: 'error', text: 'boom' } as ScrollEntry,
      ]),
    ).toBe('')
    // 即使 meta 带历史提示，空内容也不产出一行假文档
    expect(
      renderTranscript([thought('x')], { historyLoadedStart: 5, sessionId: 'sid' }),
    ).toBe('')
  })

  it('user / assistant 结构：## User 与 ## Assistant 分段', () => {
    const md = renderTranscript([user('你好'), assistant('回复你')])
    expect(md).toBe('## User\n\n你好\n\n## Assistant\n\n回复你')
  })

  it('连续 assistant 合并到同一个 ## Assistant 标题下', () => {
    const md = renderTranscript([
      user('q'),
      assistant('第一段'),
      assistant('第二段'),
      assistant('第三段'),
    ])
    expect(md).toBe('## User\n\nq\n\n## Assistant\n\n第一段\n\n第二段\n\n第三段')
  })

  it('thought 块跳过（TUI Thinking 不导出）', () => {
    const md = renderTranscript([user('q'), thought('推理内容'), assistant('答')])
    expect(md).not.toContain('推理内容')
    expect(md).toBe('## User\n\nq\n\n## Assistant\n\n答')
  })

  it('streaming assistant 并入 liveStream 文本', () => {
    const md = renderTranscript(
      [
        user('q'),
        { id: 'a1', kind: 'assistant', text: '已有', streaming: true } as ScrollEntry,
      ],
      undefined,
      { entryId: 'a1', text: '还在流' },
    )
    expect(md).toContain('## Assistant\n\n已有还在流')
  })

  it('tools section：一行摘要、连续工具行间无空行', () => {
    const md = renderTranscript([
      user('q'),
      readTool(),
      tool({ kindName: 'read', title: '/tmp/x.txt' }),
    ])
    expect(md).toBe(
      '## User\n\nq\n\n## Tools\n\n- Read: /tmp/x.txt (2-4 of 5)\n- Read: /tmp/x.txt',
    )
  })

  it('工具摘要：execute 对齐 TUI command (description) 字段结构', () => {
    const md = renderTranscript([
      user('q'),
      tool({
        kindName: 'execute',
        title: '$echo hi',
        raw: {
          kind: 'execute',
          title: '$echo hi',
          rawInput: { command: 'echo hi', description: '打招呼' },
          rawOutput: { Bash: { output: 'hi', exit_code: 0 } },
        },
      }),
    ])
    // 屏幕折叠行显示 description||command；导出取 TUI 的 command 优先
    expect(md).toContain('- Run: echo hi (打招呼)')
  })

  it('工具摘要：execute 失败带 error suffix', () => {
    const md = renderTranscript([
      tool({
        kindName: 'execute',
        status: 'failed',
        raw: {
          kind: 'execute',
          rawInput: { command: 'false' },
          rawOutput: { Bash: { output: '', exit_code: 1 } },
        },
      }),
    ])
    expect(md).toContain('- Run: false (exit code 1)')
  })

  it('工具摘要：edit 保留下游 diffstat suffix（屏幕同源）', () => {
    const md = renderTranscript([
      tool({
        kindName: 'edit',
        title: '/tmp/a.ts',
        raw: {
          kind: 'edit',
          rawInput: { file_path: '/tmp/a.ts' },
          rawOutput: { SearchReplace: { details: [{ old_string: 'a', new_string: 'b' }] } },
        },
      }),
    ])
    expect(md).toContain('- Edit: /tmp/a.ts (+1/−1)')
  })

  it('工具摘要：无 raw 的 tool 行回退到 kindName verb + title', () => {
    const md = renderTranscript([tool({ kindName: 'read', title: '/tmp/x' })])
    expect(md).toContain('- Read: /tmp/x')
  })

  it('tools section 遇到下一条 user 后复位（TUI 空行收尾）', () => {
    const md = renderTranscript([
      user('q1'),
      readTool(),
      user('q2'),
      assistant('答'),
    ])
    expect(md).toBe(
      '## User\n\nq1\n\n## Tools\n\n- Read: /tmp/x.txt (2-4 of 5)\n\n## User\n\nq2\n\n## Assistant\n\n答',
    )
  })
})

describe('renderTranscript — 会话元信息注释头', () => {
  it('title/model/sessionId/cwd → HTML 注释头（渲染不可见、raw 可溯源）', () => {
    const meta: ExportMeta = {
      title: '我的会话',
      modelName: 'grok-4',
      sessionId: 's-1234',
      cwd: '/tmp/proj',
    }
    const md = renderTranscript([user('q')], meta)
    expect(md.startsWith('<!-- transcript 我的会话 · model: grok-4 · s-1234 · cwd: /tmp/proj -->\n\n## User')).toBe(
      true,
    )
  })

  it('无 meta / 全空 meta → 无注释头', () => {
    expect(renderTranscript([user('q')]).startsWith('## User')).toBe(true)
    expect(
      renderTranscript([user('q')], { title: '  ', cwd: undefined }).startsWith('## User'),
    ).toBe(true)
  })
})

describe('renderTranscript — 未加载历史提示', () => {
  it('historyLoadedStart > 0 → 末尾提示行', () => {
    const md = renderTranscript([user('q')], { historyLoadedStart: 12 })
    expect(md.endsWith('补全）。*\n')).toBe(true)
    expect(md).toContain('\n\n---\n\n*注：')
  })

  it('historyHasMore === true → 同样提示', () => {
    expect(renderTranscript([user('q')], { historyHasMore: true })).toContain('*注：')
  })

  it('historyLoadedStart === 0（已全部加载）→ 无提示', () => {
    expect(renderTranscript([user('q')], { historyLoadedStart: 0 })).not.toContain('*注：')
  })

  it('无 meta → 无提示', () => {
    expect(renderTranscript([user('q')])).not.toContain('*注：')
  })
})

describe('likelyOlderHistory', () => {
  it('historyHasMore / loadedStart>0 → true；其余 false', () => {
    expect(likelyOlderHistory(undefined)).toBe(false)
    expect(likelyOlderHistory({})).toBe(false)
    expect(likelyOlderHistory({ historyLoadedStart: 0 })).toBe(false)
    expect(likelyOlderHistory({ historyLoadedStart: 3 })).toBe(true)
    expect(likelyOlderHistory({ historyHasMore: true })).toBe(true)
    expect(likelyOlderHistory({ historyHasMore: false, historyLoadedStart: 1 })).toBe(true)
  })
})

describe('safeExportFilename — 浏览器下载文件名安全化', () => {
  it('路径分隔符与控制字符拍平为 _', () => {
    expect(safeExportFilename('a/b\\c\u0000d')).toBe('a_b_c_d.md')
  })

  it('~ 前导剥掉（Web 无 tilde 展开）', () => {
    expect(safeExportFilename('~/exports/x')).toBe('exports_x.md')
    expect(safeExportFilename('~\\x')).toBe('x.md')
  })

  it('.. 目录穿越段拍平', () => {
    expect(safeExportFilename('../evil')).toBe('__evil.md')
  })

  it('缺 .md 后缀补上；已有不重复', () => {
    expect(safeExportFilename('conversation')).toBe('conversation.md')
    expect(safeExportFilename('conversation.txt')).toBe('conversation.txt.md')
    expect(safeExportFilename('notes.MD')).toBe('notes.MD')
    expect(safeExportFilename('notes.md')).toBe('notes.md')
  })

  it('空白 / . / .. 兜底 transcript', () => {
    expect(safeExportFilename('   ')).toBe('transcript.md')
    expect(safeExportFilename('.')).toBe('transcript.md')
    expect(safeExportFilename('..')).toBe('transcript.md')
  })

  it('非 ASCII 文件名保留', () => {
    expect(safeExportFilename('会话记录')).toBe('会话记录.md')
  })
})