#!/usr/bin/env node
/**
 * localTransport 拆类迁移脚本 v2（修正版）：
 * - sig/body 正确分割（{ 行归属 sig，body 从 { 行后开始）
 * - 生成 rpc/core.ts（xaiCall + 5 个响应解析辅助）
 * - rpc 文件自动生成 import（TransportCore + 类型引用提取）
 */
const fs = require('fs')
const path = require('path')
const SRC = path.resolve('src/api')
const ORIG = fs.readFileSync(path.join(SRC, 'localTransport.ts'), 'utf8')
const lines = ORIG.split('\n')

// ── 方法边界（括号平衡）──
const methods = []
lines.forEach((l, i) => {
  // 支持多修饰符（`private async fetch(`）与无修饰符（`setHost(`）
  const m = l.match(/^  ((?:private |public |protected |async )*)([a-zA-Z][a-zA-Z0-9_]*)(\()/)
  if (m && !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    methods.push({ name: m[2], line: i + 1 })
})
function findBody(startIdx) {
  let B = -1
  let angle = 0
  let paren = 0
  for (let i = startIdx; i < lines.length; i++) {
    const t = lines[i].trim()
    // 圆括号/尖括号跨行累计（多行签名：`async x(` … `): Promise<X> {`）
    paren += (lines[i].match(/\(/g) || []).length - (lines[i].match(/\)/g) || []).length
    // 排除 `=>` 箭头里的 `>`（如 `(): () => void`）
    const clean = lines[i].replace(/=>/g, '')
    angle += (clean.match(/</g) || []).length - (clean.match(/>/g) || []).length
    // 方法体 { 行：行尾 {、括号跨行累计归零
    if (t.endsWith('{') && paren === 0 && angle === 0) { B = i; break }
  }
  if (B < 0) return [-1, -1]
  let depth = 1
  for (let i = B + 1; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++
      else if (ch === '}') { depth--; if (depth === 0) return [B + 1, i + 1] }
    }
  }
  return [B + 1, lines.length]
}
const withBounds = methods.map((m) => {
  const [bs, be] = findBody(m.line - 1)
  return { ...m, bodyStart: bs, bodyEnd: be }
})
/** 签名（方法名行 → { 行，含，去尾部 {）；body（{ 行后 → } 行前） */
function splitMethod(m) {
  const sig = lines.slice(m.line - 1, m.bodyStart).join('\n').replace(/\{\s*$/, '').trimEnd()
  const body = lines.slice(m.bodyStart, m.bodyEnd - 1).join('\n')
  return { sig, body }
}

/** 在签名首参位置插入 `this: TransportCore`（RPC 模块方法标注）。 */
function rewriteSig(sig) {
  const open = sig.indexOf('(')
  if (open < 0) return sig
  const after = sig[open + 1]
  return (
    sig.slice(0, open + 1) +
    'this: TransportCore' +
    (after === ')' || after === undefined ? '' : ', ') +
    sig.slice(open + 1)
  )
}

// ── 分组 ──
const KEEP = new Set(['setHost','getHost','setAccessToken','apiBase','setConnectionMode','getConnectionMode','getHubUrl','setLocalHostId','isLocalPage','isLocalDirect','detectMode','getAccessToken','probeAccess','onEvent','emit','emitLocal','lastLiveEventAt','isLiveOpen','url','apiUrl','apiFetch','fetch','gapPull','onWsMessage','abortInflight','liveWsURL','trackSeq','reconcileSeq','connect','syncLocalSSE','connectWS','connectSSE','disconnect'])
const GROUPS = {
  'sessions.ts': ['listSessions','workspaceList','loadSession','loadSessionHistory','sessionRunningTasks','status','sessionInfo','forkSession','renameSession','recap','sessionDelete','compact','rewindPoints','rewindExecute','schedulerDelete','sessionState','sessionResume','sessionClose','sessionImport','sessionRepair','sessionRehydrate','sessionLoadHistory','sessionUpdateMcpServers','sessionAddLocalWorkspace','sessionResolveWorktreeResume','sessionInfoExt','sessionUsage','sessionSearch','sessionShare','sessionsListExt','sessionSummariesSessionList','sessionSummariesWorkspaceListRecent','subagentListRunning','subagentGet','workspacesList','promptHistory','commandsList'],
  'git.ts': ['gitInfo','gitStatus','gitDiffs','gitStage','gitUnstage','gitDiscard','gitCommit','gitFiles','gitBranches','gitCheckout','gitCheckoutCommit','gitCheckoutSessionHead','gitStash','gitCurrentCommit','gitRepoRoot','gitStageContent','gitWorktreeCreate','gitWorktreeRemove','gitWorktreeApply','gitWorktreeCreateFromWorktree','gitWorktreeCreateFromWorktreeSync','gitWorktreeResumeSession','gitWorktreeList','gitWorktreeShow','gitWorktreeGc','gitWorktreeDbStats','gitWorktreeDbRebuild','gitWorktreeDbPath'],
  'tools.ts': ['mcpList','mcpToggleTool','mcpToggle','mcpAdd','mcpRemove','mcpAuthTrigger','mcpCall','mcpReadResource','mcpSetup','mcpAuthStatus','memoryFlush','memoryRewrite','terminalCreate','terminalOutput','terminalRelease','terminalBackground','terminalWaitForExit','skillsList','skillsToggle','skillsAdd','skillsRemove','skillsRefreshBaseline','skillsReset','skillsConfig','pluginsList','pluginsAction','pluginsReload','pluginsNotifyUpdates','hooksList','hooksAction','marketplaceList','marketplaceAction','workflowsList','listCustomModels','upsertCustomModel','deleteCustomModel','setModel','setDefaultModel','extensions','settings'],
  'misc.ts': ['prompt','cancel','respondPermission','respondClientRequest','newSession','listHosts','pairingCode','rotatePairingCode','renameHost','unpairHost','getPrefs','putPrefs','billing','usageReport','goalSet','goalStatus','goalPause','goalResume','goalClear','cancelSubagent','killTask','listTasks','taskOutput','setMode','togglePlanMode','permissionsReset','queueRemove','queueClear','queueReorder','queueEdit','queueInterject','queueHoldEdit','queueReleaseEdit','queueStatus','btw','interject','suggest','suggestPrompt','xaiCallGeneric'],
}

// ── rpc/core.ts：xaiCall + 响应解析辅助 ──
fs.mkdirSync(path.join(SRC, 'rpc'), { recursive: true })
function extractFn(name) {
  const start = lines.findIndex((l) => l.match(new RegExp(`^(  )?(async )?(private )?${name}[<(]|^function ${name}[<(]`)))
  if (start < 0) { console.error('缺失函数：', name); return null }
  let depth = 0, end = -1
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++
      else if (ch === '}') { depth--; if (depth === 0 && i > start) { end = i; break } }
    }
    if (end >= 0) break
  }
  const block = lines.slice(start, end + 1).join('\n')
  // 加 export（原文件为模块内私有函数）
  return block.replace(/^function /, 'export function ')
}
// xaiCall：类方法（1404）→ 模块函数
const xaiStart = lines.findIndex((l) => l.includes('private async xaiCall('))
let xaiEnd = -1, depth = 0
for (let i = xaiStart; i < lines.length; i++) {
  for (const ch of lines[i]) {
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0 && i > xaiStart) { xaiEnd = i; break } }
  }
  if (xaiEnd >= 0) break
}
let xaiBody = lines.slice(xaiStart, xaiEnd + 1).join('\n')
xaiBody = xaiBody
  .replace(/^  private async xaiCall\(/, 'export async function xaiCall(core: TransportCore, ')
  .replace(/this\.fetch\(/g, 'core.fetch(')
  .replace(/this\.url\(/g, 'core.url(')
const coreFile = [
  `import type { TransportCore } from '../transport'`,
  ``,
  xaiBody,
  ``,
  extractFn('findField'),
  ``,
  extractFn('findArrayField'),
  ``,
  extractFn('findObjectField'),
  ``,
  extractFn('unwrapExtResult'),
  ``,
  extractFn('pickSummaryActivityAt'),
  ``,
].join('\n')
fs.writeFileSync(path.join(SRC, 'rpc/core.ts'), coreFile)
console.log('生成 rpc/core.ts')

// ── 类型引用提取 ──
const BUILTIN = new Set(['this','TransportCore','void','unknown','string','number','boolean','Record','Promise','Array','Date','Set','Map','Partial','Pick','Omit','Exclude','Readonly','keyof','typeof','import','never','any','undefined','null','true','false','Error','AbortController','RequestInit','Response','Headers','ReturnType','Awaited'])
const TYPE_FROM_TRANSPORT = new Set(['McpListServer','McpToolInfo','ExtensionsPayload','SettingsPayload','TerminalOutput','TransportMode','TransportHandler','AgentTurnError','AccessTokenError'])
function extractTypeRefs(text) {
  // 排除注释行与 inline import（`import('../types').X` 保留原样）
  const cleaned = text
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n')
    .replace(/import\(['"][^'"]+['"]\)\./g, '')
  const refs = new Set()
  for (const m of cleaned.matchAll(/\b([A-Z][a-zA-Z0-9_]*)\b/g)) {
    const t = m[1]
    if (!BUILTIN.has(t) && !TYPE_FROM_TRANSPORT.has(t)) refs.add(t)
  }
  return [...refs]
}

// ── 生成 rpc 领域文件 ──
fs.mkdirSync(path.join(SRC, 'rpc'), { recursive: true })
for (const [file, names] of Object.entries(GROUPS)) {
  const parts = []
  const allText = []
  for (const n of names) {
    const m = withBounds.find((x) => x.name === n)
    if (!m) { console.error('缺失方法：', n); continue }
    const { sig, body } = splitMethod(m)
    let b = body
      .replace(/this\.xaiCall\(/g, 'xaiCall(this, ')
      .replace(/this\.parseTaskSnap\(/g, 'parseTaskSnap(')
      // rpc/ 目录深一层：inline import 类型路径修正
      .replace(/import\('\.\/types'\)/g, "import('../types')")
    let s = rewriteSig(sig).replace(/import\('\.\/types'\)/g, "import('../types')")
    parts.push(`${s} {\n${b}\n  }`)
    allText.push(sig + '\n' + body)
  }
  const refs = extractTypeRefs(allText.join('\n'))
  const imports = [
    `import type { TransportCore } from '../transport'`,
  ]
  // 领域类型 import（固定配置——自动提取噪音太多）
  const TYPE_IMPORTS = {
    'sessions.ts': [
      `import { findArrayField, findObjectField, pickSummaryActivityAt, unwrapExtResult, xaiCall } from './core'`,
      `import type {\n  HostStatus,\n  RewindMode,\n  RewindPoint,\n  SessionInfo,\n  SessionInfoDetail,\n  SessionState,\n  SessionUsageData,\n  WorkspaceGroup,\n  WorkspaceSummary,\n} from '../types'`,
    ],
    'git.ts': [
      `import { findArrayField, unwrapExtResult, xaiCall } from './core'`,
      `import type { GitBranch, GitBranchesData } from '../types'`,
    ],
    'tools.ts': [
      `import { findArrayField, findField, findObjectField, unwrapExtResult, xaiCall } from './core'`,
      `import type { AgentSkill, CustomModelConfig } from '../types'`,
      `import type { ExtensionsPayload, McpListServer, McpToolInfo, SettingsPayload, TerminalOutput } from '../transport'`,
    ],
    'misc.ts': [
      `import { AccessTokenError, AgentTurnError } from '../transport'`,
      `import { findArrayField, unwrapExtResult, xaiCall } from './core'`,
      `import type { ContentBlock, HostInfo, HubPrefsDoc, PermissionScope } from '../types'`,
      ``,
      `/**\n * POST /api/prompt 的超时上限（受理即返回后实际毫秒级；旧 host 阻塞式\n * 回合最长 30min）。调用方可按需用 prompt({ timeoutMs }) 覆盖。\n */\nconst PROMPT_TIMEOUT_MS = 30 * 60_000`,
    ],
  }
  if (TYPE_IMPORTS[file]) imports.push(...TYPE_IMPORTS[file])
  const exportName = `${file.replace('.ts', '')}Rpc`
  const header = [
    ...imports,
    ``,
    `/**`,
    ` * ${file.replace('.ts', '')} — RPC 命令发送（api/rpc/，经 Object.assign 挂到`,
    ` * LocalTransport.prototype；方法内 \`this\` 即 TransportCore）。`,
    ` */`,
    `export const ${exportName} = {`,
  ]
  // misc.ts 附加 parseTaskSnap 模块函数（返回类型为裸对象 `): {`，
  // 需从方法名行起做深度平衡，跳过返回类型对象）
  let tail = `}`
  if (file === 'misc.ts') {
    const pts = withBounds.find((x) => x.name === 'parseTaskSnap')
    let depth = 0, end = pts.line - 1, started = false
    for (let i = pts.line - 1; i < lines.length; i++) {
      // 逐行处理后再判结束：`}: {` 行先 `}` 归零、后 `{` 开启方法体，
      // 整行处理完 depth 不为 0，不会提前截断
      for (const ch of lines[i]) {
        if (ch === '{') { depth++; started = true }
        else if (ch === '}') { depth-- }
      }
      if (started && depth === 0) { end = i; break }
    }
    let block = lines.slice(pts.line - 1, end + 1).join('\n')
      .replace(/^  private parseTaskSnap/, 'function parseTaskSnap')
    tail = `}\n\n${block}`
  }
  fs.writeFileSync(path.join(SRC, 'rpc', file), header.join('\n') + '\n' + parts.join(',\n\n') + '\n' + tail + '\n')
  console.log('生成 rpc/' + file, names.length + ' 方法，类型引用：', refs.join(','))
}

// ── transport.ts ──
// 类前模块级定义（连接管理依赖，写死模板——union type/无分号常量
// 用提取容易出错）
const moduleBlocks = `type HubWsFrame =
  | { type: 'hello'; service?: string; hosts?: unknown; defaultHostId?: string; seqs?: Record<string, number>; [k: string]: unknown }
  | { type: 'events'; events: AcpEvent[] }
  | { type: 'ping'; ts?: number }
  | { type: string; [k: string]: unknown }

/**
 * Default hard timeout for transport fetches. Host-side endpoints are
 * quick operations; 30s covers slow hubs while bounding half-open TCP
 * connections that would otherwise hang the fetch (and, for gap pulls,
 * wedge the per-host \`pulling\` slot) forever.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 30_000

/** 无 DecompressionStream 环境（旧浏览器）压缩帧会被丢弃——只告警一次。 */
let warnedNoDecompression = false
function warnNoDecompressionOnce(): void {
  if (warnedNoDecompression) return
  warnedNoDecompression = true
  console.warn('deflate 解压不可用，丢弃压缩帧')
}`

const TYPE_NAMES = ['TransportHandler', 'AgentTurnKind', 'AgentTurnError', 'AccessTokenError', 'TransportMode', 'McpListServer', 'McpToolInfo', 'ExtensionsPayload', 'SettingsPayload', 'TerminalOutput']
const typeBlocks = []
for (const tn of TYPE_NAMES) {
  const start = lines.findIndex((l) => l.match(new RegExp(`^export (type|class) ${tn}\\b`)))
  if (start < 0) { console.error('缺失类型：', tn); continue }
  let depth = 0, end = start
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    if (depth === 0 && i > start) { end = i; break }
    if (i === start && !lines[i].includes('{')) { end = start; break }
  }
  let s = start
  while (s > 0) {
    const t = lines[s - 1].trim()
    const isComment = t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.endsWith('*/')
    if (t === '' || isComment) { s--; continue }
    break
  }
  typeBlocks.push(lines.slice(s, end + 1).join('\n'))
}
const pubConn = withBounds.filter((m) => KEEP.has(m.name) && !['apiBase','url','fetch','abortInflight','liveWsURL','trackSeq','reconcileSeq','emit','syncLocalSSE','connectWS','connectSSE','gapPull','onWsMessage','isLocalPage','isLocalDirect'].includes(m.name))
const ifaceMembers = []
for (const m of pubConn.sort((a, b) => a.line - b.line)) {
  const { sig } = splitMethod(m)
  // 接口成员清理：去 async/private/public 前缀；参数默认值转可选（`= x` → `?:`）
  let s = sig.replace(/^  (async |private |public )+/, '  ')
  s = s.replace(/([a-zA-Z_$][\w$]*)(\??)(: [^,=)]+)? = [^,)]+/g, (mm, name, q, type) => name + '?:' + (type ? type.slice(2) : 'unknown'))
  // 无返回类型注解的方法补 `: void`（接口成员不能隐式 any）
  if (!/\)\s*:/.test(s)) s = s + ': void'
  ifaceMembers.push('  ' + s + ';')
}
const coreIface = `/** RPC 模块可见的传输核心能力（LocalTransport 实现）。 */
export interface TransportCore {
  url(path: string): string
  apiBase(): string
  mode: TransportMode
  fetch(
    path: string,
    init?: RequestInit,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<Response>
}`
fs.writeFileSync(
  path.join(SRC, 'transport.ts'),
  `import type { AcpEvent } from './types'
import type { ExtensionHook, ExtensionPlugin, ExtensionSkill } from './types'

${typeBlocks.join('\n\n')}

${coreIface}
`,
)
console.log('生成 transport.ts（TransportCore + 类型）')

// ── 重写 localTransport.ts ──
const keepMethods = withBounds.filter((m) => KEEP.has(m.name)).sort((a, b) => a.line - b.line)
const classStart = lines.findIndex((l) => l.startsWith('export class LocalTransport'))
const segs = []
segs.push(`import type { AcpEvent } from './types'
import { loadStr, removeKey, saveStr } from '../lib/storage'
import type { TransportCore } from './transport'
import type { TransportHandler, TransportMode } from './transport'
import { sessionsRpc } from './rpc/sessions'
import { gitRpc } from './rpc/git'
import { toolsRpc } from './rpc/tools'
import { miscRpc } from './rpc/misc'
`)
// 类头：classStart → 第一个保留方法签名行前
// 类外模块级函数（resolveAccessToken）一并迁移
const ratStart = lines.findIndex((l) => l.match(/^function resolveAccessToken/))
let ratBlock = ''
if (ratStart >= 0) {
  let depth = 0, ratEnd = ratStart
  for (let i = ratStart; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++
      else if (ch === '}') { depth--; if (depth === 0 && i > ratStart) { ratEnd = i; break } }
    }
    if (ratEnd > ratStart) break
  }
  ratBlock = lines.slice(ratStart, ratEnd + 1).join('\n') + '\n\n'
}
segs.push(ratBlock + moduleBlocks + '\n\n' + lines.slice(classStart, keepMethods[0].line - 1).join('\n'))
for (const m of keepMethods) {
  const { sig, body } = splitMethod(m)
  segs.push(`${sig} {\n${body}\n  }`)
}
segs.push(`}

// ── RPC mixin：按领域拆出的命令发送方法（api/rpc/*），挂到原型 ──
Object.assign(LocalTransport.prototype, sessionsRpc, gitRpc, toolsRpc, miscRpc)

export type { TransportCore }
`)
fs.writeFileSync(path.join(SRC, 'localTransport.ts'), segs.join('\n\n') + '\n')
console.log('重写 localTransport.ts，保留方法：', keepMethods.length)

// ── client.ts ──
fs.writeFileSync(
  path.join(SRC, 'client.ts'),
  `/**
 * Transport 薄层：组件/Store 只经由此处拿 transport，且只依赖
 * Transport 接口类型（实现细节在 localTransport.ts / rpc/* 中）。
 */
import { LocalTransport } from './localTransport'
import type { TransportCore, TransportHandler, TransportMode } from './transport'
import type { AcpEvent } from './types'
import type { sessionsRpc } from './rpc/sessions'
import type { gitRpc } from './rpc/git'
import type { toolsRpc } from './rpc/tools'
import type { miscRpc } from './rpc/misc'

/**
 * Transport 全公开 API：连接管理（类内实现）+ 命令发送
 * （api/rpc/* 的 mixin 方法，类型级组合，签名自动继承）。
 * 放此处（消费端）而非 transport.ts，避免 transport ↔ rpc 的类型环。
 */
export type Transport = TransportCore & {
${ifaceMembers.join('\n')}
} & typeof sessionsRpc & typeof gitRpc & typeof toolsRpc & typeof miscRpc

/** 全应用共享的 transport 单例（接口收窄，禁止触碰实现细节）。
 *  RPC 方法经 Object.assign 挂在原型上，TS 静态类型不认识，
 *  用双重断言收敛到 Transport 接口。 */
export const transport: Transport = new LocalTransport() as unknown as Transport

export type {
  TransportCore,
  TransportHandler,
  TransportMode,
  AgentTurnKind,
  McpListServer,
  McpToolInfo,
  ExtensionsPayload,
  SettingsPayload,
  TerminalOutput,
} from './transport'
export type { ExtensionHook, ExtensionPlugin, ExtensionSkill } from './types'
export { AgentTurnError, AccessTokenError } from './transport'
`,
)
console.log('生成 client.ts（Transport 组合类型 + 单例）')
