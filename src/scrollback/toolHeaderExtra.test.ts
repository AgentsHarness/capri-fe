import { describe, expect, it } from 'vitest'
import type { ToolCall } from '../api/types'
import { discoveredToolAction, extractToolDetail } from './toolDetail'
import { toolHeaderExtra } from './toolHeaderExtra'

function tc(over: Partial<ToolCall> & { rawInput?: Record<string, unknown>; rawOutput?: unknown }): ToolCall {
  const { rawInput, rawOutput, ...rest } = over
  return { id: 't', title: '', kind: '', ...rest, rawInput, rawOutput } as ToolCall
}

function he(over: Parameters<typeof tc>[0], kindName?: string, failed = false, mergedRaws?: ToolCall[]) {
  return toolHeaderExtra(tc(over), kindName, failed, mergedRaws)
}

/** 带 surface/cwd 的行头（工具行按 TUI ToolPathSurface 打印路径）。 */
function hep(
  over: Parameters<typeof tc>[0],
  kindName: string | undefined,
  paint: Parameters<typeof toolHeaderExtra>[4],
) {
  return toolHeaderExtra(tc(over), kindName, false, undefined, paint)
}

describe('toolHeaderExtra — read', () => {
  it('行范围 + 总数 → " (start-end of total)"', () => {
    const d = he(
      { rawInput: { target_file: '/a/b.ts' }, rawOutput: { Read: { FileContent: { content: 'x', total_lines: 100, offset: 0, limit: 10 } } } },
      'read',
    )
    expect(d).toEqual({ target: '/a/b.ts', suffix: ' (1-10 of 100)' })
  })

  it('rawInput offset/limit → " (start-end)"；media → (image)', () => {
    const d = he(
      { rawInput: { file_path: 'a.png', offset: 5, limit: 10 }, rawOutput: { Read: { Image: { data: 'z' } } } },
      'read',
    )
    expect(d).toEqual({ target: 'a.png', suffix: ' (6-15) (image)' })
  })

  it('无行范围 → 无 suffix', () => {
    const d = he({ rawInput: { path: 'x' }, rawOutput: {} }, 'read')
    expect(d).toEqual({ target: 'x' })
  })

  it('SKILL.md 读取 → 行头 "Skill {name}"（TUI：无 Read 动词、无路径、无范围后缀）', () => {
    const d = he(
      { rawInput: { target_file: '/x/.grok/skills/deploy/SKILL.md' }, rawOutput: { Read: { FileContent: { content: 'x', total_lines: 100, offset: 0, limit: 10 } } } },
      'read',
    )
    expect(d).toEqual({ verb: 'Skill', target: 'deploy' })
  })

  it('PDF 读取 → " (N pages)"（页数已知时不显示 (pdf)）', () => {
    const d = he(
      { rawInput: { path: '/x/a.pdf' }, rawOutput: { Read: { PdfPageImages: { pages: [], total_pages: 7 } } } },
      'read',
    )
    expect(d).toEqual({ target: '/x/a.pdf', suffix: ' (7 pages)' })
  })
})

describe('toolHeaderExtra — execute', () => {
  it('command 作为 target，非失败无 suffix', () => {
    const d = he({ rawInput: { command: 'ls' }, rawOutput: { Bash: { exit_code: 1 } } }, 'execute')
    expect(d).toEqual({ target: 'ls' })
  })

  it('failed + error → " (exit code N)"', () => {
    const d = he({ rawInput: { command: 'ls' }, rawOutput: { Bash: { exit_code: 1 } } }, 'execute', true)
    expect(d).toEqual({ target: 'ls', suffix: ' (exit code 1)' })
  })

  it('title 兜底 target', () => {
    const d = he({ title: 'custom' }, 'execute')
    expect(d).toEqual({ target: 'custom' })
  })

  it('description 里重复的 Run/Running 被剥掉（行头已有 Run 名词）', () => {
    expect(he({ rawInput: { command: 'npm t', description: 'Run the tests' } }, 'execute')).toEqual({
      target: 'the tests',
    })
    expect(
      he({ rawInput: { command: 'npm t', description: 'running: tests' } }, 'execute'),
    ).toEqual({ target: 'running: tests' })
    // 词边界：Runner / 无空格前缀不剥
    expect(
      he({ rawInput: { command: 'x', description: 'Runner up' } }, 'execute'),
    ).toEqual({ target: 'Runner up' })
    // 整句只有 Run → 视为无 description，回落命令
    expect(he({ rawInput: { command: 'npm t', description: 'Run' } }, 'execute')).toEqual({
      target: 'npm t',
    })
  })

  it('多行 description 折成一行（TUI description_display）', () => {
    expect(
      he({ rawInput: { command: 'ls', description: 'a\nb' } }, 'execute'),
    ).toEqual({ target: 'a b' })
  })
})

describe('toolHeaderExtra — edit', () => {
  it('diffstat suffix 合并 mergedRaws 的统计', () => {
    const raw: ToolCall = tc({
      rawInput: { path: '/x.ts' },
      content: { type: 'diff', oldText: 'a', newText: 'b' },
    })
    const d = he({ title: 'EditFile: /x.ts', rawInput: { path: '/x.ts' } }, 'edit', false, [raw] as never)
    expect(d).toEqual({ target: '/x.ts', suffix: ' (+1/−1)' })
  })

  it('零变更 → 无 suffix', () => {
    const d = he(
      { title: 'EditFile: /x.ts', rawInput: { path: '/x.ts' }, rawOutput: { SearchReplace: { EditsApplied: { details: [] } } } },
      'edit',
    )
    expect(d).toEqual({ target: '/x.ts' })
  })

  it('mergedRaws 里非 edit 的条目被忽略', () => {
    const other: ToolCall = tc({ rawInput: { command: 'ls' } })
    const d = he({ title: 'EditFile: /x.ts', rawInput: { path: '/x.ts' } }, 'edit', false, [other] as never)
    expect(d).toEqual({ target: '/x.ts' })
  })
})

describe('toolHeaderExtra — search', () => {
  it('0 匹配 → (no matches)', () => {
    const d = he({ rawInput: { pattern: 'foo' }, rawOutput: {} }, 'search')
    expect(d).toEqual({ target: '"foo"', suffix: ' (no matches)' })
  })

  it('files 模式 → (N files)', () => {
    const d = he(
      { rawInput: { pattern: 'foo', output_mode: 'files_with_matches' }, rawOutput: { Grep: { match_count: 2, file_matches: [] } } },
      'search',
    )
    expect(d).toEqual({ target: '"foo"', suffix: ' (2 files)' })
  })

  it('多文件 → matches in files；单匹配 → (1 match)', () => {
    const d = he(
      {
        rawInput: { pattern: 'z' },
        rawOutput: {
          Grep: {
            match_count: 5,
            file_matches: [
              { path: 'a', matches: [{ line_number: 1, content: 'z' }] },
              { path: 'b', matches: [] },
            ],
          },
        },
      },
      'search',
    )
    expect(d).toEqual({ target: '"z"', suffix: ' (5 matches in 2 files)' })

    const d1 = he(
      { rawInput: { pattern: 'q' }, rawOutput: { Grep: { match_count: 1, file_matches: [{ path: 'a', matches: [{ line_number: 1, content: 'q' }] }] } } },
      'search',
    )
    expect(d1).toEqual({ target: '"q"', suffix: ' (1 match)' })
  })

  it('pattern 为 "." 且有 glob → target 用 glob', () => {
    const d = he({ rawInput: { pattern: '.', glob: '*.ts' } }, 'search')
    expect(d).toMatchObject({ target: '*.ts' })
  })
})

describe('toolHeaderExtra — list_dir / fetch / web_search / use_tool', () => {
  it('list_dir → 目录路径（head/tail 拆分，绝不塌成 basename）+ entry 计数', () => {
    const d = he({ rawInput: { target_directory: '/tmp' }, rawOutput: { content: 'a' } }, 'list_dir')
    expect(d).toEqual({ head: '/', target: 'tmp', suffix: ' (1 entry)' })
  })

  it('list_dir 路径按会话目录缩短（TUI make_relative_path）', () => {
    const d = toolHeaderExtra(
      tc({ rawInput: { target_directory: '/me/pro/src' }, rawOutput: { content: 'a\nb' } }),
      'list_dir',
      false,
      undefined,
      { surface: 'collapsed', cwd: '/me/pro' },
    )
    expect(d).toEqual({ target: 'src', suffix: ' (2 entries)' })
  })

  it('failed 时不显示计数', () => {
    const d = he({ status: 'failed', rawInput: { target_directory: '/tmp' }, rawOutput: { content: 'a' } }, 'list_dir', true)
    expect(d).toEqual({ head: '/', target: 'tmp' })
  })

  it('fetch → (status)；web_search → query + (N sites)；use_tool → titleize', () => {
    const d = he({ rawInput: { url: 'https://x' }, rawOutput: { Fetch: { Ok: { status_code: 404 } } } }, 'fetch')
    expect(d).toEqual({ target: 'https://x', suffix: ' (404)' })

    const w = he(
      {
        rawInput: { query: 'hi', variant: 'WebSearch' },
        rawOutput: {
          WebSearch: {
            content: 'c',
            citations: ['https://a.com/1', 'https://a.com/2', 'https://b.com', 'https://c.com', 'https://d.com'],
          },
        },
      },
      'search',
    )
    // TUI 折叠行统计去重域名，不是引用条数。
    expect(w).toEqual({ target: 'hi', suffix: ' (4 sites)' })

    const u = he({ rawInput: { tool_name: 'git_status' } }, 'mcp')
    expect(u).toEqual({ target: 'Git Status' })
  })

  it('generic → target 为标题；Label: content 拆成 verb/target', () => {
    expect(he({ title: 'other' }, 'custom')).toEqual({ target: 'other' })
    expect(he({ title: 'Memory search: "auth"' }, 'custom')).toEqual({
      verb: 'Memory search',
      target: '"auth"',
    })
  })

  it('子代理消息行 → 整句标题（TUI SentMessagePresentation，随状态改写）', () => {
    const msg = { title: 'Sending message to subagent', rawInput: { message: 'hi' } }
    expect(hep(msg, 'active_agent_message', { status: 'in_progress' })).toEqual({
      bare: 'Sending message to subagent',
    })
    expect(hep(msg, 'active_agent_message', { status: 'completed' })).toEqual({
      bare: 'Sent message to subagent',
    })
    expect(hep(msg, 'active_agent_message', { status: 'failed' })).toEqual({
      bare: 'Failed to send message to subagent',
    })
    // 状态未知（如导出路径）→ 保留 wire 标题，不猜投递状态
    expect(he(msg, 'active_agent_message')).toEqual({
      target: 'Sending message to subagent',
    })
  })
})

describe('toolHeaderExtra — TUI 路径 surface', () => {
  const read = { rawInput: { path: '/Users/me/project/src/deep/tool.ts' } }

  it('collapsed（折叠行）= 只留文件名，无 head', () => {
    expect(hep(read, 'read', { surface: 'collapsed' })).toEqual({ target: 'tool.ts' })
  })

  it('expanded（行内展开）= cwd 相对 + head/tail 拆分（目录可被压缩，文件名固定）', () => {
    expect(
      hep(read, 'read', { surface: 'expanded', cwd: '/Users/me/project' }),
    ).toEqual({ head: 'src/deep/', target: 'tool.ts' })
  })

  it('fullscreen（查看器）= 规范化绝对路径 + head/tail 拆分', () => {
    expect(
      hep({ rawInput: { path: '/Users/me/project/./src/tool.ts' } }, 'read', {
        surface: 'fullscreen',
        cwd: '/Users/me/project',
      }),
    ).toEqual({ head: '/Users/me/project/src/', target: 'tool.ts' })
  })

  it('raw（导出）= 存储原路径，单串无 head', () => {
    expect(hep(read, 'read', { surface: 'raw' })).toEqual({
      target: '/Users/me/project/src/deep/tool.ts',
    })
  })

  it('edit 的 diffstat 只在折叠面出现，展开/全屏行头是裸路径', () => {
    const edit = {
      rawInput: { path: '/x/y/z.ts' },
      content: { type: 'diff', oldText: 'a', newText: 'b' },
    }
    expect(hep(edit, 'edit', { surface: 'collapsed' })).toEqual({
      target: 'z.ts',
      suffix: ' (+1/−1)',
    })
    expect(hep(edit, 'edit', { surface: 'expanded', cwd: '/x' })).toEqual({
      head: 'y/',
      target: 'z.ts',
    })
  })

  it('合并编辑无 diffstat → " (N edits)"', () => {
    const merged = tc({
      rawInput: { path: '/x/y.ts' },
      rawOutput: { SearchReplace: { EditsApplied: { details: [] } } },
    })
    expect(
      toolHeaderExtra(
        tc({ rawInput: { path: '/x/y.ts' }, rawOutput: { SearchReplace: { EditsApplied: { details: [] } } } }),
        'edit',
        false,
        [merged],
        { surface: 'collapsed' },
      ),
    ).toEqual({ target: 'y.ts', suffix: ' (2 edits)' })
  })

  it('workflows/*.rhai → "Editing workflow {stem}"（路径被脚本名替换）', () => {
    const wf = { rawInput: { file_path: '/x/.grok/workflows/review-changes.rhai' } }
    expect(hep(wf, 'edit', { surface: 'collapsed' })).toEqual({
      verb: 'Editing workflow',
      target: 'review-changes',
    })
    // write 工具 → Creating workflow
    expect(hep(wf, 'write', { surface: 'collapsed' })).toEqual({
      verb: 'Creating workflow',
      target: 'review-changes',
    })
  })

  it('普通 write → verb "Creating"（TUI EditToolCallBlock::with_prefix）', () => {
    expect(
      hep({ rawInput: { file_path: '/a/b/new.ts' } }, 'write', { surface: 'collapsed' }),
    ).toEqual({ verb: 'Creating', target: 'new.ts' })
  })

  it('MCP 限定名 → verb 为 server，target 为 action', () => {
    expect(hep({ rawInput: { tool_name: 'linear__save_issue' } }, 'mcp', {})).toEqual({
      verb: 'Linear',
      target: 'Save Issue',
    })
  })

  it('X Search → label 顶掉 Web Search 名词', () => {
    expect(
      hep({ rawInput: { query: 'q', variant: 'XSearch' } }, 'search', {}),
    ).toEqual({ verb: 'X Search', target: 'q' })
  })

  it('search 三形态：glob 提升 / "pat" in glob / in path（路径按 surface 打印）', () => {
    expect(
      hep({ rawInput: { pattern: '.', glob: '*.ts', path: '/x/y' } }, 'search', {
        surface: 'expanded',
        cwd: '/x',
      }),
    ).toEqual({ target: '*.ts in y', suffix: ' (no matches)' })
    expect(
      hep({ rawInput: { pattern: 'foo', glob: '*.ts', path: '/x/y' } }, 'search', {}),
    ).toEqual({ target: '"foo" in *.ts in /x/y', suffix: ' (no matches)' })
    expect(hep({ rawInput: { pattern: 'a"b', path: '/x' } }, 'search', {})).toEqual({
      target: '"a\\"b" in /x',
      suffix: ' (no matches)',
    })
  })

  it('搜索范围就是会话目录本身 → 省略 " in path"（TUI filter(p != ".")）', () => {
    expect(
      hep({ rawInput: { pattern: 'foo', path: '/me/pro' }, }, 'search', {
        surface: 'collapsed',
        cwd: '/me/pro',
      }),
    ).toEqual({ target: '"foo"', suffix: ' (no matches)' })
    // 折叠面也不能把范围塌成 basename
    expect(
      hep({ rawInput: { pattern: 'foo', path: '/me/pro/src' } }, 'search', {
        surface: 'collapsed',
        cwd: '/me/pro',
      }),
    ).toEqual({ target: '"foo" in src', suffix: ' (no matches)' })
  })

  it('search_tool → query + "(N results)"，计数只在折叠面出现', () => {
    const st = {
      rawInput: { variant: 'SearchTool', query: 'linear create', limit: 5 },
      rawOutput: {
        type: 'SearchTool',
        result_count: 3,
        content: JSON.stringify({
          results: [
            {
              server: 'linear',
              tools: [
                { tool_name: 'linear__save_issue', description: 'Create', score: 0.8 },
                { tool_name: 'linear__list_issues', description: 'List', score: 0.5 },
              ],
            },
            { server: 'slack', tools: [{ tool_name: 'slack__send_message', score: 0.3 }] },
          ],
        }),
      },
    }
    expect(hep(st, 'search_tool', { surface: 'collapsed' })).toEqual({
      target: 'linear create',
      suffix: ' (3 results)',
    })
    expect(hep(st, 'search_tool', { surface: 'expanded' })).toEqual({
      target: 'linear create',
    })
    const d = extractToolDetail(tc(st), 'search_tool')
    if (d.kind !== 'search_tool') throw new Error('expected search_tool')
    expect(d.results.map((r) => r.name)).toEqual([
      'linear__save_issue',
      'linear__list_issues',
      'slack__send_message',
    ])
    expect(discoveredToolAction(d.results[0])).toBe('save_issue')
    expect(discoveredToolAction(d.results[2])).toBe('send_message')
  })

  it('直连 bash 执行（_meta.bash_mode）→ (user) 标记', () => {
    const d = toolHeaderExtra(
      {
        id: 't',
        title: '',
        kind: 'execute',
        rawInput: { command: 'ls', description: 'list files' },
        _meta: { bash_mode: true },
      } as never,
      'execute',
      false,
    )
    expect(d).toEqual({ target: 'list files', marker: '(user)' })
  })

  it('count 模式 → "(N matches across M files)"；files 模式 0 命中 → (no files)', () => {
    expect(
      hep(
        {
          rawInput: { pattern: 'p', output_mode: 'count' },
          rawOutput: {
            Grep: {
              match_count: 9,
              file_paths: ['a', 'b', 'c'],
              file_matches: [],
            },
          },
        },
        'search',
        {},
      ),
    ).toMatchObject({ suffix: ' (9 matches across 3 files)' })
    expect(
      hep({ rawInput: { pattern: 'p', output_mode: 'files_with_matches' }, rawOutput: {} }, 'search', {}),
    ).toMatchObject({ suffix: ' (no files)' })
  })
})

// host 在裁正文前把折叠行行头要的数字折进 _meta.lite（契约 lite-replay [C]7），
// 全量补回来时标记被抹掉、改回由真实 diff 计算。
describe('toolHeaderExtra — lite 标记兜底折叠行后缀', () => {
  it('edit 正文被裁 → (+N/−M) 用折好的行数', () => {
    expect(
      hep(
        {
          status: 'completed',
          rawInput: { file_path: '/a/historyFill.ts' },
          rawOutput: { type: 'SearchReplace', EditsApplied: { absolute_path: '/a/historyFill.ts' } },
          _meta: { lite: { omitted: 29944, edits: { ins: 70, del: 3 } } },
        },
        'edit',
        { surface: 'collapsed' },
      ),
    ).toMatchObject({ target: 'historyFill.ts', suffix: ' (+70/−3)' })
  })

  it('合并的多次编辑 → 各自折好的行数相加', () => {
    const foldRaw = (ins: number, del: number) =>
      tc({
        status: 'completed',
        rawInput: { file_path: '/a/x.ts' },
        _meta: { lite: { omitted: 10, edits: { ins, del } } },
      })
    expect(
      toolHeaderExtra(foldRaw(3, 1), 'edit', false, [foldRaw(4, 0), foldRaw(4, 0)], {
        surface: 'collapsed',
      }),
    ).toMatchObject({ suffix: ' (+11/−1)' })
  })

  it('真实 diff 在时以 diff 为准，标记不覆盖', () => {
    expect(
      hep(
        {
          status: 'completed',
          rawInput: { file_path: '/a/x.ts' },
          content: [{ type: 'diff', path: '/a/x.ts', oldText: 'a\nb\nc', newText: 'a\nx\nc' }],
          _meta: { lite: { omitted: 999, edits: { ins: 70, del: 3 } } },
        },
        'edit',
        { surface: 'collapsed' },
      ),
    ).toMatchObject({ suffix: ' (+1/−1)' })
  })

  it('grep 正文被裁 → (N matches in M files) 用折好的文件数', () => {
    expect(
      hep(
        {
          status: 'completed',
          rawInput: { pattern: 'lite', glob: '*.{ts,tsx}', path: '/ws' },
          rawOutput: { type: 'GrepSearch', match_count: 55 },
          _meta: { lite: { omitted: 25486, files: 13 } },
        },
        'search',
        {},
      ),
    ).toMatchObject({ suffix: ' (55 matches in 13 files)' })
  })

  it('match_count 在载荷里 → 裁过正文也照常写 (no matches)', () => {
    expect(
      hep(
        {
          status: 'completed',
          rawInput: { pattern: 'nope' },
          rawOutput: { type: 'GrepSearch', match_count: 0 },
          _meta: { lite: { omitted: 10 } },
        },
        'search',
        {},
      ),
    ).toMatchObject({ suffix: ' (no matches)' })
  })

  it('match_count 也没给（旧 host / 预算裁过）→ 不写摘要，别误报空态', () => {
    const h = hep(
      { status: 'completed', rawInput: { pattern: 'nope' }, rawOutput: {}, _meta: { lite: { omitted: 10 } } },
      'search',
      {},
    )
    expect(h?.suffix).toBeUndefined()
  })

  it('use_tool 行头靠 rawInput.tool_name 拆出 Server + 动作', () => {
    expect(
      hep(
        {
          status: 'completed',
          kind: 'other',
          title: 'use_tool',
          rawInput: { tool_name: 'tasks__list' },
          rawOutput: { type: 'MCP', server_name: 'Automations' },
          _meta: { lite: { omitted: 80 }, 'x.ai/tool': { kind: 'use_tool', name: 'use_tool' } },
        },
        'use_tool',
        {},
      ),
    ).toMatchObject({ verb: 'Tasks', target: 'List' })
  })
})