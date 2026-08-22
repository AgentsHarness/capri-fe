import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { ToolCall } from '../api/types'
import { ToolDetail } from './ToolDetail'

/** 最小 ToolCall 构造器（同 scrollback/toolDetail.test.ts 约定）。 */
function tc(
  over: Partial<ToolCall> & {
    rawInput?: Record<string, unknown>
    rawOutput?: unknown
  },
): ToolCall {
  const { rawInput, rawOutput, ...rest } = over
  return { id: 't1', title: '', kind: '', ...rest, rawInput, rawOutput } as ToolCall
}

function renderDetail(
  over: Parameters<typeof tc>[0],
  kindName?: string,
  props: Partial<{ full: boolean; mergedRaws: ToolCall[]; className: string }> = {},
) {
  return render(
    <ToolDetail raw={tc(over)} kindName={kindName} full={props.full} mergedRaws={props.mergedRaws} className={props.className} />,
  )
}

describe('ToolDetail — execute', () => {
  it('命令行 + stdout 截断窗口（head 2 / tail 3 + 省略行）', () => {
    const rawOutput = {
      Bash: { output: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n'), exit_code: 0 },
    }
    const { container } = renderDetail(
      { rawInput: { command: 'ls -la', description: 'list files' }, rawOutput },
      'execute',
    )
    // description 作为 $ 命令行出现条件（展示的是 command 本身）
    expect(container.textContent).toContain('ls -la')
    expect(container.textContent).toContain('… +3 lines')
    for (const line of ['a', 'b', 'f', 'g', 'h']) expect(container.textContent).toContain(line)
    expect(container.textContent).not.toContain('\nc\n')
  })

  it('full 模式不截断', () => {
    const rawOutput = { Bash: { output: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n') } }
    const { container } = renderDetail(
      { rawInput: { command: 'x' }, rawOutput },
      'execute',
      { full: true },
    )
    expect(container.textContent).toContain('h')
    expect(container.textContent).not.toContain('… +')
  })

  it('仅 error → error 行；error + output → 都在', () => {
    const { container } = renderDetail(
      { rawInput: { command: 'ls' }, rawOutput: { Bash: { exit_code: 2 } } },
      'execute',
    )
    expect(container.textContent).toContain('exit code 2')
    expect(container.querySelector('[style*="accent-error"]')).not.toBeNull()

    const { container: c2 } = renderDetail(
      { rawInput: { command: 'ls' }, rawOutput: { Bash: { exit_code: 2, output: 'partial' } } },
      'execute',
    )
    expect(c2.textContent).toContain('partial')
    expect(c2.textContent).toContain('exit code 2')
  })
})

describe('ToolDetail — read', () => {
  const lines = Array.from({ length: 12 }, (_, i) => `line${i}`)

  it('行号 gutter + 首尾截断；full 显示全部', () => {
    const rawOutput = { Read: { FileContent: { content: lines.join('\n'), total_lines: 12 } } }
    const { container } = renderDetail({ rawInput: { path: 'a.ts' }, rawOutput }, 'read')
    expect(container.textContent).toContain('… +4 lines')
    expect(container.textContent).toContain('1') // gutter 从 lineStart(1) 起
    expect(container.textContent).toContain('line11')
    expect(container.textContent).not.toContain('line5')

    const { container: c2 } = renderDetail(
      { rawInput: { path: 'a.ts' }, rawOutput },
      'read',
      { full: true },
    )
    expect(c2.textContent).toContain('line5')
    expect(c2.textContent).not.toContain('… +')
  })

  it('error / empty / no content / pdf 分支', () => {
    const { container } = renderDetail(
      { rawInput: { path: 'a' }, rawOutput: { Read: { NotFound: 'no such file' } } },
      'read',
    )
    expect(container.textContent).toContain('no such file')

    const { container: c2 } = renderDetail(
      { rawInput: { path: 'a' }, rawOutput: { Read: { FileContent: { content: '' } } } },
      'read',
    )
    expect(c2.textContent).toContain('(empty)')

    const { container: c3 } = renderDetail({ rawInput: { path: 'a' } }, 'read')
    expect(c3.textContent).toContain('(no content)')

    const { container: c4 } = renderDetail(
      { rawInput: { path: 'a.pdf' }, rawOutput: { Read: { Pdf: { data: 'x' } } } },
      'read',
    )
    expect(c4.textContent).toContain('(pdf)')
  })

  it('图片内容 → (image) 占位（content 缺失时）', () => {
    const { container } = renderDetail(
      { rawInput: { path: 'a.png' }, rawOutput: { Read: { ImageContent: { data: 'z' } } } },
      'read',
    )
    expect(container.textContent).toContain('(image)')
  })

  it('full + 超长内容分页：显示 200 行 + 加载更多按钮', () => {
    const big = Array.from({ length: 250 }, (_, i) => `row${i}`).join('\n')
    const rawOutput = { Read: { FileContent: { content: big, total_lines: 250 } } }
    const { container } = renderDetail(
      { rawInput: { path: 'big.txt' }, rawOutput },
      'read',
      { full: true },
    )
    expect(container.textContent).toContain('row0')
    expect(container.textContent).not.toContain('row249')
    fireEvent.click(screen.getByRole('button', { name: /\+50 lines/ }))
    expect(container.textContent).toContain('row249')
  })
})

describe('ToolDetail — edit', () => {
  const editsApplied = {
    SearchReplace: {
      EditsApplied: {
        details: [
          { old_string: 'a', new_string: 'b', new_line: 3 },
          { old_string: 'c', new_string: '', start_line: 5 },
        ],
      },
    },
  }

  it('结构化 diff：diffstat + 行内容（含 === 前缀头）', () => {
    const { container } = renderDetail(
      { title: 'EditFile: /src/x.ts', rawInput: { path: '/src/x.ts' }, rawOutput: editsApplied },
      'edit',
    )
    expect(container.textContent).toMatch(/\+1/)
    expect(container.textContent).toContain('a')
    expect(container.textContent).toContain('b')
    const rows = Array.from(container.querySelectorAll('div')).map((d) => d.textContent)
    expect(rows.some((t) => t?.includes('@@'))).toBe(true)
  })

  it('合并 extra hunks（mergedRaws）中间用 … 分隔', () => {
    const second = tc({
      title: 'EditFile: /src/x.ts',
      rawInput: { path: '/src/x.ts' },
      rawOutput: {
        SearchReplace: {
          EditsApplied: { details: [{ old_string: 'y', new_string: 'z', new_line: 9 }] },
        },
      },
    })
    const { container } = renderDetail(
      { title: 'EditFile: /src/x.ts', rawInput: { path: '/src/x.ts' }, rawOutput: editsApplied },
      'edit',
      { mergedRaws: [second] },
    )
    expect(container.textContent).toContain('z')
    const separators = Array.from(container.querySelectorAll('div')).filter(
      (d) => d.textContent === '…',
    )
    expect(separators.length).toBeGreaterThan(0)
  })

  it('error → error 行；无行 → (no diff)', () => {
    const { container } = renderDetail(
      { status: 'failed', rawInput: { path: 'x' }, content: 'no' },
      'edit',
    )
    expect(container.textContent).toContain('no')

    const { container: c2 } = renderDetail(
      { rawInput: { path: 'x' }, rawOutput: { SearchReplace: { EditsApplied: { details: [] } } } },
      'edit',
    )
    expect(c2.textContent).toContain('(no diff)')
  })

  it('超长 diff 行内截断（head 20 / tail 10 + gap）', () => {
    const manyDetails = Array.from({ length: 50 }, (_, i) => ({
      old_string: `old${i}`,
      new_string: `new${i}`,
      new_line: i + 1,
    }))
    const { container } = renderDetail(
      {
        title: 'EditFile: /x.ts',
        rawInput: { path: '/x.ts' },
        rawOutput: { SearchReplace: { EditsApplied: { details: manyDetails } } },
      },
      'edit',
    )
    expect(container.textContent).toMatch(/… \+1\d\d lines/)
    expect(container.textContent).toContain('new0')
    expect(container.textContent).toContain('new49')
  })
})

describe('ToolDetail — search', () => {
  it('meta 行 + 匹配文件行号', () => {
    const rawOutput = {
      Grep: {
        match_count: 3,
        file_matches: [
          {
            path: 'a.ts',
            matches: [{ line_number: 2, content: 'xx  ' }, { line_number: 7, content: 'yy' }],
          },
        ],
      },
    }
    const { container } = renderDetail({ rawInput: { pattern: 'foo' }, rawOutput }, 'search')
    expect(container.textContent).toContain('mode: pattern')
    expect(container.textContent).toContain('a.ts')
    expect(container.textContent).toContain('2')
    expect(container.textContent).toContain('7')
    expect(container.textContent).toContain('xx') // trailing 空白 trimEnd
    expect(container.textContent).not.toContain('xx  ')
  })

  it('no results / filePaths 列表 / error', () => {
    const { container } = renderDetail({ rawInput: { pattern: 'x' } }, 'search')
    expect(container.textContent).toContain('(no results)')

    const { container: c2 } = renderDetail(
      { rawInput: { query: 'y' }, rawOutput: { grep: { match_count: 2, file_paths: ['b.ts'] } } },
      'search',
    )
    expect(c2.textContent).toContain('b.ts')

    const { container: c3 } = renderDetail({ status: 'failed', rawInput: { pattern: 'x' } }, 'search')
    expect(c3.textContent).toContain('Search failed')
  })
})

describe('ToolDetail — list_dir / fetch / web_search / use_tool / generic', () => {
  it('list_dir：输出 / 空 / 错误', () => {
    const { container } = renderDetail(
      { rawInput: { target_directory: '/tmp' }, rawOutput: { ListDir: { content: 'a\nb' } } },
      'list_dir',
    )
    expect(container.textContent).toContain('a')
    expect(container.textContent).toContain('b')

    const { container: c2 } = renderDetail({ rawInput: { path: '/tmp' } }, 'list_dir')
    expect(c2.textContent).toContain('(empty)')

    const { container: c3 } = renderDetail(
      { status: 'failed', rawInput: { path: '/tmp' } },
      'list_dir',
    )
    expect(c3.textContent).toContain('List directory failed')
  })

  it('fetch：meta + 内容 / 无内容 / 错误', () => {
    const rawOutput = { Fetch: { Ok: { status_code: 200, content_type: 'text/html', bytes: 12 } } }
    const { container } = renderDetail(
      { rawInput: { url: 'https://x.dev' }, rawOutput, content: '<html>' },
      'fetch',
    )
    expect(container.textContent).toContain('status 200 · text/html · 12 B')
    expect(container.textContent).toContain('<html>')

    const { container: c2 } = renderDetail({ rawInput: { url: 'https://x.dev' } }, 'fetch')
    expect(c2.textContent).toContain('(no content)')

    const { container: c3 } = renderDetail(
      { status: 'failed', rawInput: { url: 'u' } },
      'fetch',
    )
    expect(c3.textContent).toContain('Fetch failed')
  })

  it('web_search：内容 + 编号引用', () => {
    const rawOutput = {
      WebSearch: { content: '结果', citations: ['https://a.dev', 'https://b.dev'] },
    }
    const { container } = renderDetail(
      { rawInput: { query: 'q', variant: 'WebSearch' }, rawOutput },
      'search',
    )
    expect(container.textContent).toContain('结果')
    expect(container.textContent).toContain('1. https://a.dev')
    expect(container.textContent).toContain('2. https://b.dev')
  })

  it('use_tool：args KV + output / error', () => {
    const { container } = renderDetail(
      {
        rawInput: { tool_name: 'linear_search', variant: 'UseTool', query: 'x' },
        rawOutput: { MCP: { OkayOutput: 'done' } },
      },
      'mcp',
    )
    expect(container.textContent).toContain('query:')
    expect(container.textContent).toContain('x')
    expect(container.textContent).toContain('done')

    const { container: c2 } = renderDetail(
      { rawInput: { tool_name: 't' }, rawOutput: { MCP: { Err: 'boom' } }, status: 'failed' },
      'use_tool',
    )
    expect(c2.textContent).toContain('boom')
  })

  it('generic：inputArgs + (no output) 兜底', () => {
    const { container } = renderDetail({ title: 'MyTool', rawInput: { a: '1' } }, 'custom')
    expect(container.textContent).toContain('a:')
    expect(container.textContent).toContain('1')

    const { container: c2 } = renderDetail({ title: 'EmptyTool' }, 'custom')
    expect(c2.textContent).toContain('(no output)')
  })
})