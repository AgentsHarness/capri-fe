import { describe, expect, it } from 'vitest'
import {
  latexToUnicode,
  latexToUnicodeDisplay,
  latexToUnicodeInline,
  normalizeMathDelimiters,
  remarkMathPlugin,
  scanMathSpans,
} from './latexMath'

describe('normalizeMathDelimiters', () => {
  it('$$...$$ 保留并整理内容', () => {
    expect(normalizeMathDelimiters('a $$  x+y  $$ b')).toBe('a $$x+y$$ b')
  })

  it('$...$（非空白开头）归一', () => {
    expect(normalizeMathDelimiters('a $x$ b')).toBe('a $x$ b')
  })

  it('\\(...\\) / \\[...\\] → $ 形式', () => {
    expect(normalizeMathDelimiters('a \\(x+y\\) b')).toBe('a $x+y$ b')
    expect(normalizeMathDelimiters('\\[x+y\\]')).toBe('$$x+y$$')
  })

  it('\\begin{equation*}…\\end{equation*} → $$ 形式', () => {
    expect(normalizeMathDelimiters('\\begin{equation*}\nx+y\n\\end{equation*}')).toBe('$$x+y$$')
  })

  it('多行内容 join + 反斜杠保护', () => {
    expect(normalizeMathDelimiters('$a\\\\b\nc$')).toBe('$a\\\\\\\\b c$')
  })

  it('未闭合分隔符原样保留', () => {
    expect(normalizeMathDelimiters('a $x b')).toBe('a $x b')
    expect(normalizeMathDelimiters('a \\(x b')).toBe('a \\(x b')
    // 转义 \\ 对不触发开符
    expect(normalizeMathDelimiters('a \\\\( b')).toBe('a \\\\( b')
  })

  it('代码块 / 行内代码不转换', () => {
    expect(normalizeMathDelimiters('```\n$x$\n```')).toBe('```\n$x$\n```')
    expect(normalizeMathDelimiters('`$x$`')).toBe('`$x$`')
  })

  it('$ 转义美元不是开符', () => {
    expect(normalizeMathDelimiters('\\$5')).toBe('\\$5')
  })
})

describe('scanMathSpans', () => {
  it('普通文本块 + inline/display 分隔', () => {
    const spans = scanMathSpans('aaa $x$ bbb $$y$$')
    expect(spans).toEqual([
      { kind: 'text', text: 'aaa ' },
      { kind: 'inline', src: 'x' },
      { kind: 'text', text: ' bbb ' },
      { kind: 'display', src: 'y' },
    ])
  })

  it('未闭合 $ 视为普通文本', () => {
    expect(scanMathSpans('a $x b')).toEqual([{ kind: 'text', text: 'a $x b' }])
  })

  it('\\\\( 转义对不触发', () => {
    const spans = scanMathSpans('\\\\') // 两个反斜杠 = 字面量
    expect(spans).toEqual([{ kind: 'text', text: '\\\\' as never }])
  })
})

describe('latexToUnicode', () => {
  it('幂 / 下标', () => {
    expect(latexToUnicodeInline('x^2')).toBe('x²')
    expect(latexToUnicodeInline('x_1')).toBe('x₁')
    expect(latexToUnicodeInline('x^{n+1}')).toBe('xⁿ⁺¹')
  })

  it('分数', () => {
    expect(latexToUnicodeInline('\\frac{a}{b}')).toBe('a/b')
  })

  it('希腊字母与常用符号', () => {
    expect(latexToUnicodeInline('\\alpha \\beta \\pi')).toBe('α β π')
    expect(latexToUnicodeInline('\\infty')).toBe('∞')
  })

  it('根号 / 求和', () => {
    expect(latexToUnicodeInline('\\sqrt{x}')).toBe('√x')
    expect(latexToUnicodeInline('\\sum_{i=1}^{n} i')).toBe('∑ᵢ₌₁ⁿ i')
  })

  it('超长输入 → null', () => {
    expect(latexToUnicode('x'.repeat(5000))).toBeNull()
    expect(latexToUnicodeDisplay('x'.repeat(5000))).toBeNull()
  })

  it('行分隔 \\\\ → 多行输出', () => {
    const lines = latexToUnicodeDisplay('a \\\\ b')
    expect(Array.isArray(lines)).toBe(true)
    expect((lines ?? []).length).toBeGreaterThan(1)
  })
})

describe('remarkMathPlugin', () => {
  it('mdast 文本中的 $...$ 转 inlineMath 节点', () => {
    const tree: { type: 'root'; children: unknown[] } = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: '公式 $x^2$ 结束' }, { type: 'break' }],
        },
      ],
    }
    remarkMathPlugin()(tree)
    const para = tree.children[0] as {
      children: Array<{ type: string; value?: string; children?: unknown[] }>
    }
    const types = para.children.map((n) => n.type)
    expect(types).toContain('inlineMath')
    const math = para.children.find((n) => n.type === 'inlineMath')
    expect(math?.children?.[0]).toMatchObject({ type: 'text', value: 'x²' })
  })

  it('无数学的文本保持原节点', () => {
    const tree = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: '普通文本' }] }],
    }
    remarkMathPlugin()(tree)
    const para = tree.children[0] as { children: Array<{ type: string }> }
    expect(para.children.map((n) => n.type)).toEqual(['text'])
  })

  it('独立 display span → math 块节点', () => {
    const tree = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: '$$a+b$$' }] }],
    }
    remarkMathPlugin()(tree)
    const para = tree.children[0] as { children: Array<{ type: string }> }
    expect(para.children[0].type).toBe('math')
  })
})