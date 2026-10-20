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

/**
 * 下面按 renderCommand 的命令表分组覆盖：这层是纯字符串转换
 * （从 TUI 的 latex/commands.rs 移植），移植最容易出的错是某个
 * 命令静默退化成裸名字或丢参数，所以每条都钉住具体输出。
 */
describe('latexToUnicode — 分数与二项式', () => {
  it('dfrac / tfrac / cfrac 与 frac 同款', () => {
    for (const cmd of ['frac', 'dfrac', 'tfrac', 'cfrac']) {
      expect(latexToUnicodeInline(`\\${cmd}{a}{b}`)).toBe('a/b')
    }
  })

  it('分子/分母只给一个时不塌成裸名', () => {
    // 缺分母：只输出分子（不是 'a/' 也不是 '\frac'）
    expect(latexToUnicodeInline('\\frac{a}')).toBe('a')
  })

  it('binom / tbinom / dbinom → C(n, k)', () => {
    expect(latexToUnicodeInline('\\binom{n}{k}')).toBe('C(n, k)')
    expect(latexToUnicodeInline('\\dbinom{n}{k}')).toBe('C(n, k)')
    expect(latexToUnicodeInline('\\tbinom{n}{k}')).toBe('C(n, k)')
  })

  it('binom 参数不全时不输出', () => {
    expect(latexToUnicodeInline('\\binom{n}')).toBe('')
  })
})

describe('latexToUnicode — 根号', () => {
  it('无下标 → √；2 → √；3 → ∛', () => {
    expect(latexToUnicodeInline('\\sqrt{x}')).toBe('√x')
    expect(latexToUnicodeInline('\\sqrt[2]{x}')).toBe('√x')
    expect(latexToUnicodeInline('\\sqrt[3]{x}')).toBe('∛x')
  })

  it('4 → ∜；2/3 有专门字形', () => {
    // 4 次方有预置的 ∜ 字形，不走「上标 + √」的路
    expect(latexToUnicodeInline('\\sqrt[4]{x}')).toBe('∜x')
  })

  it('非数字下标走上标前缀', () => {
    expect(latexToUnicodeInline('\\sqrt[n]{x}')).toBe('ⁿ√x')
  })

  it('下标无法转上标时回落到带括号的前缀', () => {
    // '+-' 有上标字形（ⁿ⁺）→ 走 prefix+√；这里钉住的是「有字形就不加括号」
    expect(latexToUnicodeInline('\\sqrt[n+]{x}')).toBe('ⁿ⁺√x')
    // 含无上标字形的字符 → 回落带括号
    expect(latexToUnicodeInline('\\sqrt[q]{x}')).toBe('(q)√x')
  })

  it('多字符被开方数加括号（避免读成 (√a)b）', () => {
    expect(latexToUnicodeInline('\\sqrt{ab}')).toBe('√(ab)')
  })

  it('缺被开方数时只剩根号', () => {
    expect(latexToUnicodeInline('\\sqrt')).toBe('√')
  })
})

describe('latexToUnicode — 文本族与字母表', () => {
  it('text / mathrm / operatorname 等按文本模式取参数', () => {
    for (const cmd of ['text', 'textrm', 'textit', 'textbf', 'texttt', 'operatorname', 'mathrm']) {
      expect(latexToUnicodeInline(`\\${cmd}{abc}`)).toBe('abc')
    }
  })

  it('mathbb / mathcal / mathfrak / mathbf 映射到 Unicode 字母表', () => {
    expect(latexToUnicodeInline('\\mathbb{R}')).toBe('ℝ')
    expect(latexToUnicodeInline('\\mathcal{L}')).toBe('ℒ')
    expect(latexToUnicodeInline('\\mathfrak{g}')).toBe('𝔤')
    expect(latexToUnicodeInline('\\mathbf{x}')).toBe('𝐱')
    expect(latexToUnicodeInline('\\boldsymbol{x}')).toBe('𝐱')
  })
})

describe('latexToUnicode — 重音', () => {
  it('每个重音命令都贴到前一个字符上（组合记号）', () => {
    const cases: Array<[string, string]> = [
      ['hat', '\u0302'],
      ['widehat', '\u0302'],
      ['bar', '\u0304'],
      ['overline', '\u0304'],
      ['tilde', '\u0303'],
      ['widetilde', '\u0303'],
      ['vec', '\u20D7'],
      ['dot', '\u0307'],
      ['ddot', '\u0308'],
      ['check', '\u030C'],
      ['breve', '\u0306'],
      ['acute', '\u0301'],
      ['grave', '\u0300'],
      ['mathring', '\u030A'],
      ['underline', '\u0332'],
    ]
    for (const [cmd, mark] of cases) {
      expect(latexToUnicodeInline('\\' + cmd + '{x}')).toBe(`x${mark}`)
      expect(latexToUnicodeInline('\\' + cmd + ' x')).toBe(`x${mark}`)
    }
  })
})

describe('latexToUnicode — 否定 \\not', () => {
  it('有预置否定形的符号换成否定形', () => {
    expect(latexToUnicodeInline('\\not=')).toBe('≠')
  })

  it('没有预置否定形时叠组合斜线', () => {
    expect(latexToUnicodeInline('\\not x')).toBe('x\u0338')
  })
})

describe('latexToUnicode — 装饰（overset / stackrel / underset）', () => {
  it('overset 把上标内容放到基座上', () => {
    expect(latexToUnicodeInline('\\overset{a}{x}')).toBe('xᵃ')
  })

  it('stackrel 在没有可转上标的内容时只留基座', () => {
    // '!' 无上标字形 → 只输出基座 '='
    expect(latexToUnicodeInline('\\stackrel{!}{=}')).toBe('=')
    // 'a' 有上标字形 → =ᵃ
    expect(latexToUnicodeInline('\\stackrel{a}{=}')).toBe('=ᵃ')
  })

  it('underset 用下标', () => {
    expect(latexToUnicodeInline('\\underset{i}{x}')).toBe('xᵢ')
  })

  it('参数不全时不输出', () => {
    expect(latexToUnicodeInline('\\overset{a}')).toBe('')
    expect(latexToUnicodeInline('\\underset{a}')).toBe('')
  })
})

describe('latexToUnicode — 模运算与间距', () => {
  it('pmod 前补空格并包成 (mod …)；行首不补', () => {
    expect(latexToUnicodeInline('a\\pmod{n}')).toBe('a (mod n)')
    expect(latexToUnicodeInline('\\pmod{n}')).toBe('(mod n)')
  })

  it('bmod → mod', () => {
    expect(latexToUnicodeInline('a\\bmod b')).toBe('a mod b')
  })

  it('细间距归一成一个空格；quad / qquad 是固定宽度', () => {
    expect(latexToUnicodeInline('a\\,b')).toBe('a b')
    expect(latexToUnicodeInline('a\\;b')).toBe('a b')
    expect(latexToUnicodeInline('a\\quad b')).toBe('a  b')
    expect(latexToUnicodeInline('a\\qquad b')).toBe('a    b')
  })

  it('负间距与 \\! 不产出任何字符', () => {
    expect(latexToUnicodeInline('a\\!b')).toBe('ab')
    // 负间距命令本身不产出字符，但它前面的空白仍算已输出的空格
    expect(latexToUnicodeInline('a\\negthinspace b')).toBe('a b')
  })

  it('\\ 是行分隔而不是符号', () => {
    expect(latexToUnicodeDisplay('a \\\\ b')).toEqual(['a', 'b'])
  })
})

describe('latexToUnicode — 盒子与 \\left/\\right', () => {
  it('boxed 保留内容；fbox / framebox 按文本模式（丢框）', () => {
    expect(latexToUnicodeInline('\\boxed{x}')).toBe('x')
    expect(latexToUnicodeInline('\\fbox{ab}')).toBe('ab')
    expect(latexToUnicodeInline('\\framebox{ab}')).toBe('ab')
  })

  it('\\left( \\right) 保留定界符', () => {
    expect(latexToUnicodeInline('\\left(x\\right)')).toBe('(x)')
  })

  it('\\left. 表示无定界符（不产出字符）', () => {
    expect(latexToUnicodeInline('\\left.x\\right|')).toBe('x|')
  })

  it('\\left 后跟命令时渲染该命令', () => {
    expect(latexToUnicodeInline('\\left\\{x\\right\\}')).toBe('{x}')
  })
})

describe('latexToUnicode — 无操作命令与未知命令', () => {
  it('字号 / 样式 / 结构提示类命令被丢弃，但参数保留', () => {
    expect(latexToUnicodeInline('\\displaystyle x')).toBe('x')
    expect(latexToUnicodeInline('\\textstyle x')).toBe('x')
    expect(latexToUnicodeInline('\\big( x \\big)')).toBe('( x )')
    expect(latexToUnicodeInline('\\mathstrut x')).toBe('x')
    expect(latexToUnicodeInline('\\limits x')).toBe('x')
  })

  it('\\label / \\tag 连同参数一起丢弃', () => {
    expect(latexToUnicodeInline('x\\label{eq:1}')).toBe('x')
    expect(latexToUnicodeInline('x\\tag{42}')).toBe('x')
  })

  it('未知命令退化成裸名字（TUI 语义）', () => {
    expect(latexToUnicodeInline('\\notacommand')).toBe('notacommand')
  })

  it('裸反斜杠保留', () => {
    expect(latexToUnicodeInline('\\')).toBe('\\')
  })
})

describe('latexToUnicode — 行环境与 \\end 孤立', () => {
  it('matrix 按行拆分', () => {
    const lines = latexToUnicodeDisplay(
      '\\begin{matrix}a & b \\\\ c & d\\end{matrix}',
    )
    expect((lines ?? []).length).toBe(2)
  })

  it('孤立 \\end 丢参数不产生字符', () => {
    expect(latexToUnicodeInline('\\end{matrix}x')).toBe('x')
  })

  it('\\begin 参数不全时不抛错', () => {
    expect(() => latexToUnicodeInline('\\begin')).not.toThrow()
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