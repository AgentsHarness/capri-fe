import { describe, expect, it } from 'vitest'
import type { ToolCall } from '../api/types'
import { toolHeaderExtra } from './toolHeaderExtra'

function tc(over: Partial<ToolCall> & { rawInput?: Record<string, unknown>; rawOutput?: unknown }): ToolCall {
  const { rawInput, rawOutput, ...rest } = over
  return { id: 't', title: '', kind: '', ...rest, rawInput, rawOutput } as ToolCall
}

function he(over: Parameters<typeof tc>[0], kindName?: string, failed = false, mergedRaws?: ToolCall[]) {
  return toolHeaderExtra(tc(over), kindName, failed, mergedRaws)
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
  it('list_dir → entry 计数（单数 entry）', () => {
    const d = he({ rawInput: { target_directory: '/tmp' }, rawOutput: { content: 'a' } }, 'list_dir')
    expect(d).toEqual({ target: '/tmp', suffix: ' (1 entry)' })
  })

  it('failed 时不显示计数', () => {
    const d = he({ status: 'failed', rawInput: { target_directory: '/tmp' }, rawOutput: { content: 'a' } }, 'list_dir', true)
    expect(d).toEqual({ target: '/tmp' })
  })

  it('fetch → (status)；web_search → query；use_tool → toolName', () => {
    const d = he({ rawInput: { url: 'https://x' }, rawOutput: { Fetch: { Ok: { status_code: 404 } } } }, 'fetch')
    expect(d).toEqual({ target: 'https://x', suffix: ' (404)' })

    const w = he({ rawInput: { query: 'hi', variant: 'WebSearch' } }, 'search')
    expect(w).toEqual({ target: 'hi' })

    const u = he({ rawInput: { tool_name: 'git_status' } }, 'mcp')
    expect(u).toEqual({ target: 'git_status' })
  })

  it('generic → null', () => {
    expect(he({ kindName: 'custom' })).toBeNull()
    expect(he({ rawInput: { x: 1 } }, 'custom')).toBeNull()
  })
})