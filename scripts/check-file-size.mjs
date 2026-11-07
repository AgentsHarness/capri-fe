#!/usr/bin/env node
/**
 * 源码单文件行数上限检查。
 *
 * src/ 下的 .ts / .tsx（排除 *.test.ts(x) 与 *.d.ts）不得超过 800 行。
 * scripts/file-size-baseline.json 是棘轮：存量超标文件记下当时的行数，
 * 之后只能下降或持平；不在基线里的新文件超过上限即失败。
 * 已降到 800 行以内（或已删除）的基线项只提示可清理，不算失败。
 *
 * 用法:
 *   node scripts/check-file-size.mjs                   # 检查，有违规时 exit 1
 *   node scripts/check-file-size.mjs --update-baseline # 重写基线，只收录当前超标文件
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = path.join(ROOT, 'src')
const BASELINE_PATH = path.join(ROOT, 'scripts', 'file-size-baseline.json')
const LIMIT = 800

/** @param {string} name */
function isSourceFile(name) {
  if (!name.endsWith('.ts') && !name.endsWith('.tsx')) return false
  if (name.endsWith('.test.ts') || name.endsWith('.test.tsx')) return false
  if (name.endsWith('.d.ts')) return false
  return true
}

/**
 * @param {string} dir
 * @param {string[]} out
 */
function collectFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectFiles(full, out)
    else if (entry.isFile() && isSourceFile(entry.name)) out.push(full)
  }
  return out
}

/** 与 wc -l 一致：末尾无换行时最后一行也计入。 @param {string} file */
function countLines(file) {
  const buf = readFileSync(file)
  if (buf.length === 0) return 0
  let breaks = 0
  for (const byte of buf) if (byte === 10) breaks += 1
  return buf[buf.length - 1] === 10 ? breaks : breaks + 1
}

/** @param {string} full */
function relPath(full) {
  return path.relative(ROOT, full).split(path.sep).join('/')
}

/** @returns {Record<string, number> | null} null 表示基线文件不存在 */
function readBaseline() {
  let raw
  try {
    raw = readFileSync(BASELINE_PATH, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  const parsed = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${relPath(BASELINE_PATH)} 应为 { 文件路径: 行数 } 形式的对象`)
  }
  for (const [file, lines] of Object.entries(parsed)) {
    if (!Number.isInteger(lines) || lines <= 0) {
      throw new Error(`基线项 ${file} 的行数应为正整数，实际为 ${JSON.stringify(lines)}`)
    }
  }
  return parsed
}

/** @param {Record<string, number>} entries */
function writeBaseline(entries) {
  const sorted = Object.fromEntries(
    Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )
  writeFileSync(BASELINE_PATH, `${JSON.stringify(sorted, null, 2)}\n`)
}

const args = process.argv.slice(2)
const unknown = args.filter((arg) => arg !== '--update-baseline')
if (unknown.length > 0) {
  console.error(`未知参数: ${unknown.join(' ')}`)
  console.error('用法: node scripts/check-file-size.mjs [--update-baseline]')
  process.exit(2)
}
const updateBaseline = args.includes('--update-baseline')

/** @type {Map<string, number>} */
const counts = new Map()
for (const full of collectFiles(SRC_DIR)) counts.set(relPath(full), countLines(full))

const previous = readBaseline()

if (updateBaseline) {
  const over = Object.fromEntries(
    [...counts].filter(([, lines]) => lines > LIMIT),
  )
  writeBaseline(over)
  const before = previous ?? {}
  const added = Object.keys(over).filter((file) => !(file in before))
  const removed = Object.keys(before).filter((file) => !(file in over))
  const changed = Object.keys(over).filter(
    (file) => file in before && before[file] !== over[file],
  )
  console.log(`基线已写入 ${relPath(BASELINE_PATH)}：${Object.keys(over).length} 个超标文件`)
  for (const file of added) console.log(`  + ${file}: ${over[file]} 行`)
  for (const file of changed) console.log(`  ~ ${file}: ${before[file]} → ${over[file]} 行`)
  for (const file of removed) console.log(`  - ${file}（原 ${before[file]} 行）`)
  process.exit(0)
}

const baseline = previous ?? {}
if (previous === null) {
  console.log(
    `未找到基线文件 ${relPath(BASELINE_PATH)}，按空基线检查（可先运行 --update-baseline 生成）`,
  )
}

/** @type {{ file: string, lines: number, reason: string }[]} */
const violations = []
for (const [file, lines] of [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
  if (lines <= LIMIT) continue
  if (!(file in baseline)) {
    violations.push({ file, lines, reason: `新文件超过上限 ${LIMIT} 行（+${lines - LIMIT}），请拆分` })
  } else if (lines > baseline[file]) {
    violations.push({
      file,
      lines,
      reason: `超过基线 ${baseline[file]} 行（+${lines - baseline[file]}），基线只允许下降或持平`,
    })
  }
}

/** @type {string[]} */
const stale = []
for (const [file, baseLines] of Object.entries(baseline).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
  const lines = counts.get(file)
  if (lines === undefined) stale.push(`${file}（文件已不存在，基线 ${baseLines} 行）`)
  else if (lines <= LIMIT) stale.push(`${file}（当前 ${lines} 行，已在 ${LIMIT} 行以内，基线 ${baseLines} 行）`)
}

if (violations.length > 0) {
  console.log(`源码行数检查未通过（上限 ${LIMIT} 行），违规 ${violations.length} 项：`)
  for (const { file, lines, reason } of violations) console.log(`  ${file}: ${lines} 行 —— ${reason}`)
  if (stale.length > 0) {
    console.log(`另有可清理的基线项 ${stale.length} 项（不是失败项，可用 --update-baseline 移除）：`)
    for (const entry of stale) console.log(`  ${entry}`)
  }
  console.log(`扫描 ${counts.size} 个文件，基线 ${Object.keys(baseline).length} 项。`)
  process.exit(1)
}

const overCount = [...counts.values()].filter((lines) => lines > LIMIT).length
if (overCount === 0) {
  console.log(`源码行数检查通过：扫描 ${counts.size} 个文件，没有超过 ${LIMIT} 行的文件。`)
} else {
  console.log(
    `源码行数检查通过：扫描 ${counts.size} 个文件，${overCount} 个超标文件均在基线内（上限 ${LIMIT} 行）。`,
  )
}
if (stale.length > 0) {
  console.log(`可清理的基线项 ${stale.length} 项（可用 --update-baseline 移除）：`)
  for (const entry of stale) console.log(`  ${entry}`)
}
