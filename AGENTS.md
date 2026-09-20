# 项目规则

## 界面改动不做浏览器自动化验证

- 涉及界面（UI / 布局 / 样式 / 交互 / 渲染数据）的需求，改完**默认不跑 playwright、不起 dev server 做浏览器验证**。直接说明改了哪些文件、在哪个入口能看到什么效果，由用户自己打开页面确认并反馈结果。
- 只有用户主动要求时才做浏览器验证（例如"你去浏览器验一下 / 跑 playwright / 帮我点一遍"）。届时按 `.grok/skills/capri-playwright/SKILL.md` 的流程走，尤其注意：8765 是真机 host，只能只读探测，任何会改会话/配置状态的操作都要用隔离 host。
- 单元测试（`npx vitest run`）只跑改动相关的、`npx tsc -b`、`npx oxlint` 属于常规收尾，不受上面限制，照常跑。

## 测试要能抓住缺陷，不要凑覆盖率

判断一句：把这个测试保护的实现改坏，它会红吗？答不上来就是在统计行数。写完绿了不算数。

三种常见的无效写法（本仓库里真实存在过；不是禁令清单——纯函数一条 `toBe` 对照可以是好测试）：

```ts
// 1) 重言式：右侧是实现副本，改了实现测试跟着改，永远绿
expect(SPINNER_INTERVAL_MS).toBe(133)
expect(SPINNER_FRAMES).toHaveLength(8)

// 2) 只跑 happy path：行被执行了、分支没被区分
it('渲染列表', () => {
  render(<List items={[a, b]} />)
  expect(screen.getByText(a)).toBeInTheDocument()
})

// 3) 只断言内部 mock 被调用，不断言用户可见结果
expect(fake.askBtw).toHaveBeenCalled()
```

写测试时：

- 构造能区分出错的输入（边界、失败路径、守卫两侧），不要只走默认路径。
- 断言可观察结果（DOM / 返回值 / store / wire 上的请求体）。断言协议契约（`transport.*`、`fetch` 请求体）合理；断言 `fake.internalHelper` 是弱的。
- 覆盖率盯分支：`vitest.config.ts` 的 `coverage.thresholds` 是棘轮，只许往上。只涨行不涨分支，说明又在补 happy path。
- 用例红了先读实现，别放宽断言。本仓库多次是测试写错、实现是对的（以为 `/v1/models` 失败后会继续试 `/models`，实际首个成功即返回；以为 `'@@@'` 会回落成 `'model'`，实际是 `'---'`）。
- `vi.stubGlobal('fetch', vi.fn(async () => …))` 的参数元组是空的，断言 `mock.calls[0][0]` 会被 `tsc -b` 判越界。要写 `vi.fn(async (url: string, init?: RequestInit) => …)`。
- 模板串里 `` `\\${cmd}` `` 会得到字面 `\hat`。用 `'\\' + cmd` 拼接。

评估一批测试有没有用，用 `python3 scripts/mutate.py`（一次性审计，不是每条新测试的必做步骤）。用法见脚本头注释。
