import { describe, expect, it } from 'vitest'
import type { ToolCall } from '../api/types'
import {
  contentText,
  extractToolDetail,
  readPathOf,
  skillNameFromPath,
  type DiffLine,
  type KvPair,
} from './toolDetail'

/** 最小 ToolCall 构造器（kind 留空，分类由 kindName 参数决定）。 */
function tc(over: Partial<ToolCall> & { rawInput?: Record<string, unknown>; rawOutput?: unknown }): ToolCall {
  const { rawInput, rawOutput, ...rest } = over
  return { id: 't1', title: '', kind: '', ...rest, rawInput, rawOutput } as ToolCall
}

function detail(over: Parameters<typeof tc>[0], kindName?: string) {
  return extractToolDetail(tc(over), kindName)
}

describe('contentText', () => {
  it('字符串直接返回；空/缺省为空串', () => {
    expect(contentText(tc({ content: 'hello' }))).toBe('hello')
    expect(contentText(tc({}))).toBe('')
  })

  it('content block 结构（type: content → ContentBlock::Text）', () => {
    expect(
      contentText(tc({ content: { type: 'content', content: { type: 'text', text: 'block1' } } })),
    ).toBe('block1')
    expect(contentText(tc({ content: { type: 'text', text: 'direct' } }))).toBe('direct')
  })

  it('toplevel text 字段', () => {
    expect(contentText(tc({ content: { text: 'plain' } }))).toBe('plain')
  })

  it('数组拼接（跳过非对象项）；嵌套递归', () => {
    const c = [
      'a',
      { type: 'content', content: { type: 'text', text: 'b' } },
      null,
      42 as unknown,
      { content: { text: 'c' } },
    ]
    expect(contentText(tc({ content: c }))).toBe('a\nb\nc')
    expect(contentText(tc({ content: 42 }))).toBe('')
  })
})

describe('extractToolDetail — execute', () => {
  it('命令来自 rawInput.command / cmd，description 透传', () => {
    const d = detail({ rawInput: { command: 'ls -la', description: 'list files' } }, 'execute') as {
      kind: string
      command?: string
      description?: string
      output?: string
      error?: string
    }
    expect(d).toMatchObject({ kind: 'execute', command: 'ls -la', description: 'list files' })
    expect(d.output).toBeUndefined()
    expect(d.error).toBeUndefined()
  })

  it('description 与 command 相同则省略', () => {
    const d = detail({ rawInput: { command: 'ls', description: 'ls' } }, 'execute')
    expect(d).toMatchObject({ command: 'ls', description: undefined })
  })

  it('title 以 $ 开头时剥前缀当命令；title 兜底命令', () => {
    const d = detail({ title: '$ npm run dev' }, 'execute')
    expect(d).toMatchObject({ kind: 'execute', command: 'npm run dev' })
    const d2 = detail({ title: 'custom cmd' }, 'execute')
    expect(d2).toMatchObject({ command: 'custom cmd' })
  })

  it('bash 同义 kind 名（bash/shell/run/command）都归 execute', () => {
    for (const k of ['bash', 'shell', 'run', 'command']) {
      const d = detail({ rawInput: { cmd: 'x' } }, k)
      expect(d.kind).toBe('execute')
    }
  })

  it('Bash tagged rawOutput → output + exitCode（snake 与 camel）', () => {
    const d = detail(
      { rawInput: { command: 'ls' }, rawOutput: { Bash: { output: 'log.txt', exit_code: 0 } } },
      'execute',
    )
    expect(d).toMatchObject({ kind: 'execute', output: 'log.txt', exitCode: 0 })

    const d2 = detail(
      { rawInput: { command: 'ls' }, rawOutput: { Bash: { stdout: 'out', exitCode: 3 } } },
      'execute',
    )
    expect(d2).toMatchObject({ output: 'out', exitCode: 3 })
  })

  it('非零 exit code → error；signal 优先于 exit code', () => {
    const d1 = detail(
      { rawInput: { command: 'ls' }, rawOutput: { Bash: { exit_code: 2 } } },
      'execute',
    )
    expect(d1).toMatchObject({ exitCode: 2, error: 'exit code 2' })

    const d2 = detail(
      { rawInput: { command: 'ls' }, rawOutput: { Bash: { exit_code: 1, signal: 'SIGKILL' } } },
      'execute',
    )
    expect(d2).toMatchObject({ signal: 'SIGKILL', error: 'SIGKILL' })
  })

  it('failed 状态兜底 error；streaming 内容兜底 output', () => {
    const d = detail(
      { status: 'failed', rawInput: { command: 'ls' }, content: 'permission denied' },
      'execute',
    )
    expect(d).toMatchObject({ error: 'permission denied', output: 'permission denied' })
  })

  it('非 Bash rawOutput 且非 failed → 无 error 无 output', () => {
    const d = detail({ rawInput: { command: 'ls' }, rawOutput: { Something: { x: 1 } } }, 'execute') as {
      kind: string
      command?: string
      output?: string
      error?: string
    }
    expect(d).toMatchObject({ command: 'ls' })
    expect(d.output).toBeUndefined()
    expect(d.error).toBeUndefined()
  })
})

describe('extractToolDetail — read', () => {
  it('path 从 rawInput 提取（多个候选键）', () => {
    expect(detail({ rawInput: { file_path: '/a/b.txt' } }, 'read')).toMatchObject({
      kind: 'read',
      path: '/a/b.txt',
    })
    expect(detail({ rawInput: { target_file: 'x.ts' } }, 'read')).toMatchObject({ path: 'x.ts' })
    expect(detail({ rawInput: { filePath: 'y.ts' } }, 'read')).toMatchObject({ path: 'y.ts' })
  })

  it('FileContent tagged → content + totalLines', () => {
    const d = detail(
      { rawInput: { target_file: 'x.ts' }, rawOutput: { Read: { FileContent: { content: 'abc', total_lines: 3 } } } },
      'read',
    )
    expect(d).toMatchObject({ kind: 'read', content: 'abc', totalLines: 3 })
  })

  it('serde internally-tagged {"type":"ReadFile","FileContent":{…}} → 内容可解析', () => {
    // host 实测 wire 形状（grokbuild-issue.md）：rawOutput 为 internally
    // tagged newtype，payload 键与 type 键平级。
    const d = detail(
      {
        rawInput: { target_file: 'x.ts' },
        rawOutput: {
          type: 'ReadFile',
          FileContent: {
            content: 'abc',
            raw_output: 'raw abc',
            total_lines: 42,
            offset: 0,
            limit: 10,
          },
        },
      },
      'read',
    )
    expect(d).toMatchObject({
      kind: 'read',
      content: 'raw abc',
      totalLines: 42,
      lineStart: 1,
      lineEnd: 10,
    })
  })

  it('internally-tagged ImageContent → media image + base64 内容', () => {
    const d = detail(
      {
        rawInput: { target_file: 'i.png' },
        rawOutput: {
          type: 'ReadFile',
          ImageContent: { data: 'aGk=', mime_type: 'image/png' },
        },
      },
      'read',
    )
    expect(d).toMatchObject({
      kind: 'read',
      media: 'image',
      content: 'aGk=',
      imageMime: 'image/png',
    })
  })

  it('internally-tagged 错误变体 → error', () => {
    const d = detail(
      { rawInput: { target_file: 'nope' }, rawOutput: { type: 'ReadFile', FileNotFound: 'no such file' } },
      'read',
    )
    expect(d).toMatchObject({ kind: 'read', error: 'no such file' })
  })

  it('rawOutput 扁平 raw_output → lineStart/lineEnd 由 offset+limit 推导并钳到 totalLines', () => {
    const d = detail(
      { rawInput: { file_path: 'a.ts' }, rawOutput: { raw_output: 'x', total_lines: 100, offset: 10, limit: 30 } },
      'read',
    )
    expect(d).toMatchObject({ lineStart: 11, lineEnd: 40, totalLines: 100 })
  })

  it('limit 超过 totalLines 时 lineEnd 钳制', () => {
    const d = detail(
      { rawInput: { file_path: 'a.ts' }, rawOutput: { Read: { FileContent: { content: 'x', totalLines: 5, offset: 3, limit: 30 } } } },
      'read',
    )
    expect(d).toMatchObject({ lineStart: 4, lineEnd: 5 })
  })

  it('rawInput 的 offset/limit 兜底', () => {
    const d = detail({ rawInput: { path: 'a.ts', offset: 0, limit: 9 } }, 'read')
    expect(d).toMatchObject({ lineStart: 1, lineEnd: 9 })
  })

  it('NotFound tagged → error；Image/ImageContent/Pdf tag → media', () => {
    const d1 = detail(
      { rawInput: { path: 'a' }, rawOutput: { Read: { NotFound: 'no such file' } } },
      'read',
    )
    expect(d1).toMatchObject({ kind: 'read', error: 'no such file' })

    // ImageContent 含 "content" 子串，需先于 FileContent 分支命中
    const d2 = detail(
      { rawInput: { path: 'a.png' }, rawOutput: { Read: { ImageContent: { data: 'z' } } } },
      'read',
    )
    expect(d2).toMatchObject({ media: 'image', content: 'z' })

    const d3 = detail(
      { rawInput: { path: 'a.png' }, rawOutput: { Read: { Image: { data: 'z' } } } },
      'read',
    )
    expect(d3).toMatchObject({ media: 'image', content: 'z' })

    const d4 = detail(
      { rawInput: { path: 'a.pdf' }, rawOutput: { Read: { Pdf: { data: 'z' } } } },
      'read',
    )
    expect(d4).toMatchObject({ media: 'pdf' })
  })

  it('title 兜底 path；空字符串内容 → empty', () => {
    const d = detail({ title: 'read_file: /x/y.ts', rawOutput: {} }, 'read')
    expect(d).toMatchObject({ kind: 'read', path: 'read_file: /x/y.ts', content: undefined })

    const d2 = detail(
      { rawInput: { path: 'x' }, rawOutput: { Read: { FileContent: { content: '' } } } },
      'read',
    )
    expect(d2).toMatchObject({ kind: 'read', content: '', empty: true })
  })

  it('SKILL.md 读取 → skill 字段（父目录名）；普通读取无 skill', () => {
    const d = detail(
      { rawInput: { path: '/x/skills/deploy/SKILL.md' }, rawOutput: { Read: { FileContent: { content: 'y' } } } },
      'read',
    )
    expect(d).toMatchObject({ kind: 'read', path: '/x/skills/deploy/SKILL.md', skill: 'deploy' })

    const plain = detail({ rawInput: { path: '/x/skills/deploy/README.md' }, rawOutput: {} }, 'read')
    expect(plain).toMatchObject({ kind: 'read', skill: undefined })
  })

  it('readPathOf：camel/snake rawInput 优先，title 兜底', () => {
    expect(readPathOf(tc({ rawInput: { path: '/a/b.ts' } }))).toBe('/a/b.ts')
    expect(readPathOf(tc({ rawInput: { file_path: '/a/b.ts' } }))).toBe('/a/b.ts')
    expect(readPathOf(tc({ rawInput: { filePath: '/a/b.ts' } }))).toBe('/a/b.ts')
    expect(readPathOf(tc({ rawInput: { path: '/a/b.ts' }, title: 'Read `/a/b.ts`' }))).toBe('/a/b.ts')
    expect(readPathOf(tc({ title: 'Read `/a/b.ts`' }))).toBe('Read `/a/b.ts`')
    expect(readPathOf(tc({}))).toBe('')
  })

  it('skillNameFromPath：仅基名 SKILL.md 且需有父目录；容忍标题反引号包裹与反斜杠', () => {
    expect(skillNameFromPath('/x/.grok/skills/deploy/SKILL.md')).toBe('deploy')
    expect(skillNameFromPath('skills/deploy/SKILL.md')).toBe('deploy')
    expect(skillNameFromPath('Read `/x/skills/deploy/SKILL.md`')).toBe('deploy')
    expect(skillNameFromPath('C:\\x\\skills\\deploy\\SKILL.md')).toBe('deploy')
    expect(skillNameFromPath('/x/README.md')).toBeUndefined()
    expect(skillNameFromPath('SKILL.md')).toBeUndefined()
    expect(skillNameFromPath('/SKILL.md')).toBeUndefined()
    expect(skillNameFromPath('/x/skills/deploy/SKILL.md/')).toBe('deploy')
  })
})

describe('extractToolDetail — edit', () => {
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

  it('structured edits → diff 行 + 统计（含 gap）', () => {
    const d = detail(
      { title: 'EditFile: /src/x.ts', rawInput: { file_path: '/src/x.ts' }, rawOutput: editsApplied },
      'edit',
    )
    if (d.kind !== 'edit') throw new Error('expected edit')
    expect(d.path).toBe('/src/x.ts')
    expect(d.insertions).toBeGreaterThan(0)
    expect(d.deletions).toBeGreaterThan(0)
    const kinds = d.lines.map((l) => l.kind)
    expect(kinds).toContain('header')
    expect(kinds).toContain('insert')
    expect(kinds).toContain('delete')
    expect(kinds).toContain('gap')
  })

  it('content Diff blocks → hunks', () => {
    const d = detail(
      { rawInput: { path: '/x.ts' }, content: { type: 'diff', oldText: 'one\ntwo', newText: 'one\ntwo\nthree' } },
      'edit',
    )
    if (d.kind !== 'edit') throw new Error('expected edit')
    expect(d.insertions).toBe(1)
    expect(d.deletions).toBe(0)
    expect(d.lines.some((l) => l.text === 'three' && l.kind === 'insert')).toBe(true)
  })

  it('failed → 空 diff + error', () => {
    const d = detail({ status: 'failed', rawInput: { path: 'x' }, content: 'no' }, 'edit')
    expect(d).toMatchObject({ kind: 'edit', lines: [], insertions: 0, deletions: 0 })
    if (d.kind === 'edit') expect(d.error).toBe('no')
  })

  it('write/create → creating；title 含 create → creating；纯 edit → 否', () => {
    expect(detail({ rawInput: { path: 'new.txt' } }, 'write')).toMatchObject({ kind: 'edit', creating: true })
    expect(detail({ title: 'Create new: /x', rawInput: { path: '/x' } }, 'edit')).toMatchObject({
      kind: 'edit',
      creating: true,
    })
    expect(detail({ title: 'EditFile: /x', rawInput: { path: '/x' } }, 'edit')).toMatchObject({
      kind: 'edit',
      creating: false,
    })
  })

  it('delete / move kind 也归 edit 分支', () => {
    expect(detail({ rawInput: { path: 'x' } }, 'delete')).toMatchObject({ kind: 'edit' })
    expect(detail({ rawInput: { path: 'x' } }, 'move')).toMatchObject({ kind: 'edit' })
  })
})

describe('extractToolDetail — search / grep', () => {
  it('基本 search：pattern + 输出模式 + 大小写 + fileType', () => {
    const d = detail(
      { rawInput: { pattern: 'foo', path: '/src', '-i': true, output_mode: 'count', type: 'ts' } },
      'search',
    )
    expect(d).toMatchObject({
      kind: 'search',
      pattern: 'foo',
      path: '/src',
      outputMode: 'count',
      caseInsensitive: true,
      fileType: 'ts',
    })
  })

  it('output_mode 归一：files_with_matches → files；默认 content', () => {
    const d1 = detail({ rawInput: { pattern: 'x', outputMode: 'files_with_matches' } }, 'search')
    expect(d1).toMatchObject({ outputMode: 'files' })
    const d2 = detail({ rawInput: { pattern: 'x' } }, 'search')
    expect(d2).toMatchObject({ outputMode: 'content' })
  })

  it('grep tagged rawOutput → matchCount + fileMatches + filePaths', () => {
    const d = detail(
      {
        rawInput: { pattern: 'x' },
        rawOutput: {
          Grep: {
            match_count: 3,
            file_matches: [{ path: 'a.ts', matches: [{ line_number: 2, content: 'xx' }] }],
          },
        },
      },
      'search',
    )
    expect(d).toMatchObject({
      kind: 'search',
      matchCount: 3,
      fileMatches: [{ path: 'a.ts', matches: [{ lineNumber: 2, content: 'xx' }] }],
      filePaths: [],
    })
  })

  it('file_paths 蛇形/驼峰均可；stdout 兜底 filePaths（过滤 <>/Found 行）', () => {
    const d = detail(
      { rawInput: { query: 'y' }, rawOutput: { grep: { match_count: 2, file_paths: ['b.ts'] } } },
      'search',
    )
    expect(d).toMatchObject({ matchCount: 2, filePaths: ['b.ts'] })

    const d2 = detail(
      { rawInput: { query: 'y' }, rawOutput: { grep: { matchCount: 2, stdout: 'c.ts\n<binary file>\nFound 2 matches' } } },
      'search',
    )
    expect(d2).toMatchObject({ matchCount: 2, filePaths: ['c.ts'] })
  })

  it('grep 空载荷 → 全 0 兜底', () => {
    const d = detail({ rawInput: { pattern: 'z' }, rawOutput: {} }, 'search')
    expect(d).toMatchObject({ kind: 'search', matchCount: 0, fileMatches: [], filePaths: [] })
  })

  it('WebSearch / XSearch variant → web_search', () => {
    const d = detail(
      {
        rawInput: { query: 'react', variant: 'WebSearch' },
        rawOutput: { WebSearch: { content: 'results', citations: ['https://a'] } },
      },
      'search',
    )
    expect(d).toMatchObject({
      kind: 'web_search',
      query: 'react',
      content: 'results',
      citations: ['https://a'],
    })

    const dx = detail({ title: 'X search: "grok"', rawInput: { variant: 'XSearch' } }, 'search')
    expect(dx).toMatchObject({ kind: 'web_search', query: 'grok', label: 'X Search' })
  })
})

describe('extractToolDetail — list_dir', () => {
  it('output 从 rawOutput / content 提取，entryCount 统计非空行', () => {
    const d = detail(
      { rawInput: { target_directory: '/tmp' }, rawOutput: { ListDir: { content: 'a\nb\n\nc' } } },
      'list_dir',
    )
    expect(d).toMatchObject({ kind: 'list_dir', path: '/tmp', output: 'a\nb\n\nc', entryCount: 3 })
  })

  it('kindName 不是 list 但 rawInput 有 target_directory → 也识别为 list_dir', () => {
    const d = detail({ rawInput: { target_directory: '/x' } })
    expect(d).toMatchObject({ kind: 'list_dir', path: '/x' })
  })

  it('失败时 error 标记', () => {
    const d = detail({ status: 'failed', rawInput: { path: '/tmp' } }, 'list_dir')
    expect(d).toMatchObject({ kind: 'list_dir', error: 'List directory failed' })
  })
})

describe('extractToolDetail — fetch', () => {
  it('statusCode / contentType / bytes 提取（多层 unwrap）', () => {
    const d = detail(
      { rawInput: { url: 'https://x.dev' }, rawOutput: { Fetch: { Ok: { status_code: 200, content_type: 'text/html', bytes: 12 } } } },
      'fetch',
    )
    expect(d).toMatchObject({ kind: 'fetch', url: 'https://x.dev', statusCode: 200, contentType: 'text/html', bytes: 12 })
  })

  it('title "Fetch:" 前缀兜底 url', () => {
    const d = detail({ title: 'Fetch: https://y.dev' }, 'fetch')
    expect(d).toMatchObject({ kind: 'fetch', url: 'https://y.dev' })
  })
})

describe('extractToolDetail — use_tool / mcp', () => {
  it('toolName + 扁平 args（跳过 meta 键），超大 blob 截断', () => {
    const d = detail(
      { rawInput: { tool_name: 'linear_search', variant: 'UseTool', query: 'x', flag: true, n: 3, big: 'm'.repeat(5000) } },
      'mcp',
    )
    if (d.kind !== 'use_tool') throw new Error('expected use_tool')
    expect(d.toolName).toBe('linear_search')
    const byKey = Object.fromEntries(d.args.map((k: KvPair) => [k.key, k.value]))
    expect(byKey).toMatchObject({ query: 'x', flag: 'true', n: '3' })
    expect(byKey.variant).toBeUndefined()
    expect(byKey.big).toBe('m'.repeat(4000) + '…')
  })

  it('tool_input 嵌套对象 → 只展开其字段；null 值跳过', () => {
    const d = detail(
      { rawInput: { toolName: 'slack_post', tool_input: { channel: 'dev', text: 'hi', extra: null } } },
      'use_tool',
    )
    if (d.kind !== 'use_tool') throw new Error('expected use_tool')
    expect(d.args).toEqual([
      { key: 'channel', value: 'dev' },
      { key: 'text', value: 'hi' },
    ])
  })

  it('MCP tagged output → 提取文本；字符串 output 美化', () => {
    const d = detail(
      { rawInput: { tool_name: 'x' }, rawOutput: { MCP: { OkayOutput: 'task done' } } },
      'use_tool',
    )
    expect(d).toMatchObject({ kind: 'use_tool', output: 'task done' })

    const d2 = detail({ rawInput: { tool_name: 'x' }, rawOutput: { MCP: { result: '{"a":1}' } } }, 'use_tool')
    expect(d2).toMatchObject({ kind: 'use_tool', output: '{\n  "a": 1\n}' })
  })

  it('Text tagged output', () => {
    const d = detail({ rawInput: { tool_name: 'x' }, rawOutput: { Text: { text: 'plain' } } }, 'use_tool')
    expect(d).toMatchObject({ kind: 'use_tool', output: 'plain' })
  })
})

describe('extractToolDetail — generic fallback', () => {
  it('无匹配 kind → generic，展开 rawInput args（跳过 variant）', () => {
    const d = detail({ kindName: 'custom_thing', title: 'MyTool', rawInput: { a: 1, variant: 'X' } })
    expect(d).toMatchObject({ kind: 'generic', name: 'MyTool', summary: 'MyTool' })
    if (d.kind !== 'generic') throw new Error('expected generic')
    const keys = d.inputArgs.map((k) => k.key)
    expect(keys).toContain('a')
    expect(keys).not.toContain('variant')
  })

  it('字符串 rawOutput 原样透传；对象 rawOutput JSON 美化', () => {
    const d = detail({ rawOutput: 'plain text' as unknown })
    expect(d).toMatchObject({ kind: 'generic', output: 'plain text' })

    const d2 = detail({ rawOutput: { nested: { a: 1 } } })
    expect(d2).toMatchObject({ kind: 'generic', output: '{\n  "nested": {\n    "a": 1\n  }\n}' })
  })

  it('failed → error 兜底', () => {
    const d = detail({ status: 'failed' })
    expect(d).toMatchObject({ kind: 'generic', error: 'Failed' })
  })
})

describe('循环引用 payload → 不爆栈（digString 防环）', () => {
  it('name 键自引用对象 → 降级为 [object Object]，不抛 RangeError', () => {
    const cyc: Record<string, unknown> = { output: {} }
    cyc.output = cyc
    const d = detail({ rawOutput: cyc })
    if (d.kind !== 'generic') throw new Error('expected generic')
    expect(d.output).toBe('[object Object]')
  })

  it('unwrapTagged 单键循环包裹链（Text→Bash→回祖先）→ 不爆栈', () => {
    const a: Record<string, unknown> = {}
    const b: Record<string, unknown> = { Bash: a }
    a.Text = b
    const d = detail({ rawOutput: a })
    if (d.kind !== 'generic') throw new Error('expected generic')
    expect(d.output).toBe('[object Object]')
  })

  it('MCP tagged 循环 body → 不爆栈', () => {
    const cyc: Record<string, unknown> = { output: {} }
    cyc.output = cyc
    const d = detail({ rawInput: { tool_name: 'x' }, rawOutput: { MCP: cyc } }, 'use_tool')
    if (d.kind !== 'use_tool') throw new Error('expected use_tool')
    expect(d.output).toBe('[object Object]')
  })
})

describe('extractToolDetail — diff 内部逻辑', () => {
  it('空 old → 纯 insert；空 new → 纯 delete；行号从 startLine 起', () => {
    const ins = detail(
      { rawInput: { path: 'x' }, content: { type: 'diff', oldText: '', newText: 'a\nb' } },
      'edit',
    )
    if (ins.kind !== 'edit') throw new Error('expected edit')
    expect(ins.lines.filter((l) => l.kind === 'insert')).toHaveLength(2)
    expect(ins.lines.some((l) => l.kind === 'delete')).toBe(false)

    const del = detail(
      { rawInput: { path: 'x' }, content: { type: 'diff', oldText: 'a\nb', newText: '' } },
      'edit',
    )
    if (del.kind !== 'edit') throw new Error('expected edit')
    expect(del.lines.filter((l) => l.kind === 'delete')).toHaveLength(2)
  })

  it('Myers 差分：相同行 equal，删除/新增行各归其位，header 带 @@ 行号', () => {
    const d = detail(
      { rawInput: { path: 'x' }, content: { type: 'diff', oldText: 'keep\nold', newText: 'keep\nnew' } },
      'edit',
    )
    if (d.kind !== 'edit') throw new Error('expected edit')
    const texts = d.lines.map((l: DiffLine) => [l.kind, l.text])
    expect(texts).toContainEqual(['equal', 'keep'])
    expect(texts).toContainEqual(['delete', 'old'])
    expect(texts).toContainEqual(['insert', 'new'])
    expect((d.lines[0] as DiffLine).kind).toBe('header')
    expect((d.insertions)).toBe(1)
    expect((d.deletions)).toBe(1)
  })

  it('超大 hunk（>400 行对）退化为全删+全插', () => {
    const big = Array.from({ length: 300 }, (_, i) => `line${i}`).join('\n')
    const d = detail(
      { rawInput: { path: 'x' }, content: { type: 'diff', oldText: big, newText: big + '\nnewline' } },
      'edit',
    )
    if (d.kind !== 'edit') throw new Error('expected edit')
    // 300 + 301 行 > 400 → 不走 Myers，直接全删全插
    expect(d.lines.some((l) => l.kind === 'equal')).toBe(false)
    expect(d.insertions).toBe(301)
    expect(d.deletions).toBe(300)
  })
})
describe('extractToolDetail 畸形 wire 字段（wire 不做运行时校验，渲染期绝不能抛）', () => {
  const shapes = [
    { title: 12345, kind: 'other', status: 'completed' },
    { title: { nested: true }, kind: 7, status: 'completed' },
    { title: '', kind: { o: 1 }, status: 0 },
    { title: '', kind: '', status: { s: 'failed' } },
    { title: ['a'], kind: 'execute', status: null },
    { title: undefined, kind: undefined, status: undefined },
  ] as const

  for (const [i, s] of shapes.entries()) {
    it(`shape #${i}：kind / status / title 非字符串时按缺省分类处理`, () => {
      expect(() =>
        extractToolDetail({ toolCallId: 't1', ...s } as unknown as ToolCall),
      ).not.toThrow()
      // 带 kindName 的调用路径同样不能抛（kindName 来自条目，也可能被污染）
      expect(() =>
        extractToolDetail({ toolCallId: 't1', ...s } as unknown as ToolCall, 'execute'),
      ).not.toThrow()
    })
  }

  it('数字 title 在 execute 分支被当作命令文本（不再是 .startsWith 崩溃点）', () => {
    const d = extractToolDetail({
      toolCallId: 't1',
      title: 42,
      kind: 'execute',
    } as unknown as ToolCall)
    if (d.kind !== 'execute') throw new Error(`expected execute, got ${d.kind}`)
    expect(d.command).toBe('42')
    expect(d.error).toBeUndefined()
  })

  it('status 非字符串不算失败；字符串 failed/error 才算', () => {
    const asCommand = (status: unknown) =>
      extractToolDetail({
        toolCallId: 't1',
        kind: 'execute',
        title: 'ls',
        status,
      } as unknown as ToolCall)
    const err = (d: ReturnType<typeof asCommand>) =>
      d.kind === 'execute' ? d.error : undefined
    expect(err(asCommand('failed'))).toBe('Command failed')
    expect(err(asCommand('FAILED'))).toBe('Command failed')
    expect(err(asCommand('completed'))).toBeUndefined()
    expect(err(asCommand(500))).toBeUndefined()
    expect(err(asCommand({ status: 'failed' }))).toBeUndefined()
  })
})
