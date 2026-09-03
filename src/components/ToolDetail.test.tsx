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

  it('仅 error → error 行；error + output → 只渲染输出（TUI：有输出不追加错误行）', () => {
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
    expect(c2.textContent).not.toContain('exit code 2')
    expect(c2.querySelector('[style*="accent-error"]')).toBeNull()
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

  it('error / no content 分支；(empty)/(pdf) 占位只在行头，正文不再重复', () => {
    const { container } = renderDetail(
      { rawInput: { path: 'a' }, rawOutput: { Read: { NotFound: 'no such file' } } },
      'read',
    )
    expect(container.textContent).toContain('no such file')

    const { container: c2 } = renderDetail(
      { rawInput: { path: 'a' }, rawOutput: { Read: { FileContent: { content: '' } } } },
      'read',
    )
    expect(c2.textContent).not.toContain('(empty)')

    const { container: c3 } = renderDetail({ rawInput: { path: 'a' } }, 'read')
    expect(c3.textContent).toContain('(no content)')

    const { container: c4 } = renderDetail(
      { rawInput: { path: 'a.pdf' }, rawOutput: { Read: { Pdf: { data: 'x' } } } },
      'read',
    )
    expect(c4.textContent).not.toContain('(pdf)')
    expect(c4.textContent).not.toContain('pages')
  })

  it('图片 base64 内容 → 渲染 <img>（wire mime 包装成 data URI）', () => {
    // 1x1 PNG，真实 base64，长度足以通过 readImageSrc 校验
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const { container } = renderDetail(
      {
        rawInput: { path: 'a.png' },
        rawOutput: { Read: { ImageContent: { data: png, mime_type: 'image/png' } } },
      },
      'read',
    )
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toBe(`data:image/png;base64,${png}`)
    expect(container.textContent).not.toContain('(image)')
  })

  it('图片内容缺失/无效 → 正文不再渲染 (image) 占位（只在行头后缀显示）', () => {
    const { container } = renderDetail(
      { rawInput: { path: 'a.png' }, rawOutput: { Read: { ImageContent: {} } } },
      'read',
    )
    expect(container.textContent).not.toContain('(image)')
    expect(container.querySelector('img')).toBeNull()
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

  it('结构化 diff：diffstat + 行内容；@@ hunk 头行不上屏（TUI 只在补丁文本里有 @@）', () => {
    const { container } = renderDetail(
      { title: 'EditFile: /src/x.ts', rawInput: { path: '/src/x.ts' }, rawOutput: editsApplied },
      'edit',
    )
    expect(container.textContent).toMatch(/\+1/)
    expect(container.textContent).toContain('a')
    expect(container.textContent).toContain('b')
    const rows = Array.from(container.querySelectorAll('div')).map((d) => d.textContent)
    expect(rows.some((t) => t?.includes('@@'))).toBe(false)
  })

  it('合并 extra hunks（mergedRaws）中间分隔带不变行数（TUI hunk_gap_lines）', () => {
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
    // 主 detail 最后的新文件行号 3（insert b）→ 第二个 raw 起于 9：间隔 5 行
    const separators = Array.from(container.querySelectorAll('div')).filter(
      (d) => d.textContent === '… 5 unchanged lines',
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

  it('超长 diff 行内不截断（TUI Truncated/Expanded 同路径全量渲染）', () => {
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
    // 首尾 hunk 都直接可见，没有 head/tail 截断
    expect(container.textContent).toContain('new0')
    expect(container.textContent).toContain('new49')
    expect(container.textContent).not.toContain('… +')
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
  it('list_dir：输出 / 空 / 错误；行内展开全量渲染不截断（TUI list_dir.rs）', () => {
    const { container } = renderDetail(
      { rawInput: { target_directory: '/tmp' }, rawOutput: { ListDir: { content: 'a\nb' } } },
      'list_dir',
    )
    expect(container.textContent).toContain('a')
    expect(container.textContent).toContain('b')

    const many = Array.from({ length: 15 }, (_, i) => `entry${i}`).join('\n')
    const { container: cLong } = renderDetail(
      { rawInput: { target_directory: '/tmp' }, rawOutput: { ListDir: { content: many } } },
      'list_dir',
    )
    expect(cLong.textContent).toContain('entry0')
    expect(cLong.textContent).toContain('entry14')
    expect(cLong.textContent).not.toContain('… +')

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

  it('web_search：内容 + 编号引用（引用可点击 <a>，带 title）', () => {
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
    const links = Array.from(container.querySelectorAll('a'))
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://a.dev', 'https://b.dev'])
    expect(links[0]!.getAttribute('title')).toBe('https://a.dev')
    expect(links[0]!.getAttribute('target')).toBe('_blank')
    expect(links[0]!.getAttribute('rel')).toBe('noreferrer')
  })

  it('use_tool：args KV + output / error；失败时 output 转红 error 不双显', () => {
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
    // 原始输出整体挪进红色 error 行，stdout 正文不再重复出现
    expect(c2.textContent!.split('boom').length - 1).toBe(1)
    expect(c2.querySelector('[style*="accent-error"]')).not.toBeNull()

    // null 参数显示 "null"（TUI Value::Null）
    const { container: c3 } = renderDetail(
      { rawInput: { toolName: 't', tool_input: { channel: null } } },
      'use_tool',
    )
    expect(c3.textContent).toContain('channel:')
    expect(c3.textContent).toContain('null')
  })

  it('ask_user：AskUserQuestion 输出渲染编号问答行', () => {
    const answered =
      'User has answered your questions: "Which framework?"="React", "Why?"="Speed. selected preview: x". You can now continue with the user\'s answers in mind.'
    const { container } = renderDetail({ title: 'AskUserQuestion', content: answered }, 'other')
    expect(container.textContent).toContain('1. Which framework?')
    expect(container.textContent).toContain('React')
    expect(container.textContent).toContain('2. Why?')
    expect(container.textContent).toContain('Speed.')
    expect(container.textContent).not.toContain('selected preview:')

    // 未作答 → (no answer)
    const plan =
      'Questions asked\n- "Deploy where?"\n  (No answer provided)'
    const { container: c2 } = renderDetail({ title: 'AskUserQuestion', content: plan }, 'other')
    expect(c2.textContent).toContain('1. Deploy where?')
    expect(c2.textContent).toContain('(no answer)')
  })

  it('generic：inputArgs + (no output) 兜底', () => {
    const { container } = renderDetail({ title: 'MyTool', rawInput: { a: '1' } }, 'custom')
    expect(container.textContent).toContain('a:')
    expect(container.textContent).toContain('1')

    const { container: c2 } = renderDetail({ title: 'EmptyTool' }, 'custom')
    expect(c2.textContent).toContain('(no output)')
  })
})