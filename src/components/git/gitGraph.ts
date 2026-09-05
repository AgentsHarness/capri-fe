import type { GitLogEntry } from '../../api/types'

export const GRAPH_ROW_HEIGHT = 28
export const GRAPH_CENTER_Y = 14
export const GRAPH_LANE_MARGIN = 14
export const GRAPH_LANE_STEP = 16

/**
 * IDEA / VS Code 风格标志性分支泳道配色：
 * 主干优先使用鲜明的亮蓝色，各分支使用高区分度的对比色彩。
 */
export const GRAPH_LANE_COLORS = [
  '#3b82f6', // 亮蓝 (VS Code / IDEA 主分支经典颜色)
  '#10b981', // 鲜绿
  '#a855f7', // 紫色
  '#f59e0b', // 琥珀/橙
  '#06b6d4', // 青蓝
  '#ec4899', // 粉红
  '#eab308', // 黄色
]

export function getLaneX(lane: number): number {
  return GRAPH_LANE_MARGIN + lane * GRAPH_LANE_STEP
}

export function getLaneColor(lane: number): string {
  const index = Math.abs(lane) % GRAPH_LANE_COLORS.length
  return GRAPH_LANE_COLORS[index]
}

export type GitGraphLine = {
  key: string
  d: string
  color: string
}

export type GitGraphRowData = {
  nodeLane: number
  nodeColor: string
  isHead: boolean
  lines: GitGraphLine[]
  maxLane: number
}

export type GitGraphResult = {
  rows: GitGraphRowData[]
  graphWidth: number
}

function straightLine(x1: number, y1: number, x2: number, y2: number): string {
  return `M ${x1} ${y1} L ${x2} ${y2}`
}

function bezierCurve(x1: number, y1: number, x2: number, y2: number): string {
  const midY = (y1 + y2) / 2
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`
}

/**
 * 构建 IDEA / VS Code 风格的 Git 图谱（Lanes, Nodes, Curves）：
 * - 自动分配与复用泳道（Lanes）
 * - 当前 HEAD / 最新节点展示为空心圆环，历史提交为实心圆点
 * - 单线时无多余引出线，多分支时生成平滑三次贝塞尔曲线
 */
export function buildGitGraph(commits: GitLogEntry[]): GitGraphResult {
  if (commits.length === 0) {
    return {
      rows: [],
      graphWidth: GRAPH_LANE_MARGIN + GRAPH_LANE_STEP,
    }
  }

  const hasAnyExplicitHead = commits.some((c) => c.refs?.includes('HEAD'))
  let currentLanes: (string | null)[] = []
  let overallMaxLane = 0
  const rows: GitGraphRowData[] = []

  const H = GRAPH_ROW_HEIGHT
  const centerY = GRAPH_CENTER_Y

  for (let index = 0; index < commits.length; index++) {
    const commit = commits[index]
    const cHash = commit.hash

    const isHead = hasAnyExplicitHead
      ? commit.refs?.includes('HEAD') === true
      : index === 0

    const parents =
      commit.parents && commit.parents.length > 0
        ? commit.parents
        : commits[index + 1]
          ? [commits[index + 1].hash]
          : []

    // 查找上一行是否有等待该 commit 的泳道
    const incomingLanes: number[] = []
    for (let l = 0; l < currentLanes.length; l++) {
      if (currentLanes[l] === cHash) {
        incomingLanes.push(l)
      }
    }

    // 确定当前 commit 的泳道 nodeLane：
    // 若有进入的泳道，优先复用最小的泳道；若没有，寻找 null 空槽或追加
    let nodeLane: number
    if (incomingLanes.length > 0) {
      nodeLane = incomingLanes[0]
    } else {
      const freeIdx = currentLanes.indexOf(null)
      nodeLane = freeIdx !== -1 ? freeIdx : currentLanes.length
      currentLanes[nodeLane] = cHash
    }

    const nodeColor = getLaneColor(nodeLane)
    const nodeX = getLaneX(nodeLane)
    const lines: GitGraphLine[] = []
    let rowMaxLane = nodeLane

    // 1. 上方连线（Incoming to node）
    for (const inLane of incomingLanes) {
      rowMaxLane = Math.max(rowMaxLane, inLane)
      const fromX = getLaneX(inLane)
      const color = getLaneColor(inLane)
      if (inLane === nodeLane) {
        // 直线进入当前节点。空心圆环到其上外边缘（留出中空区域），实心小圆点到圆心
        const endY = isHead ? centerY - 4.5 : centerY
        lines.push({
          key: `in-${inLane}-${nodeLane}`,
          d: straightLine(nodeX, 0, nodeX, endY),
          color,
        })
      } else {
        // 平滑贝塞尔曲线汇入当前节点
        lines.push({
          key: `in-${inLane}-${nodeLane}`,
          d: bezierCurve(fromX, 0, nodeX, centerY),
          color,
        })
      }
    }

    // 2. 旁路直通线（Passing lanes）
    // 其他活跃但不在 incoming 里的泳道直线穿过本行
    for (let l = 0; l < currentLanes.length; l++) {
      if (currentLanes[l] !== null && !incomingLanes.includes(l) && l !== nodeLane) {
        rowMaxLane = Math.max(rowMaxLane, l)
        const laneX = getLaneX(l)
        lines.push({
          key: `pass-${l}-${currentLanes[l]}`,
          d: straightLine(laneX, 0, laneX, H),
          color: getLaneColor(l),
        })
      }
    }

    // 3. 下方连线（Outgoing to parents）
    const nextLanes = [...currentLanes]
    // 释放已经被本行消费的所有 incoming 泳道和 nodeLane
    for (const l of incomingLanes) {
      nextLanes[l] = null
    }
    nextLanes[nodeLane] = null

    if (parents.length > 0) {
      // 主父提交
      const primaryParent = parents[0]
      const existingPrimaryLane = nextLanes.indexOf(primaryParent)

      if (existingPrimaryLane !== -1) {
        // 父提交已经在其它泳道被安排了（合并/汇合）
        rowMaxLane = Math.max(rowMaxLane, existingPrimaryLane)
        const targetX = getLaneX(existingPrimaryLane)
        lines.push({
          key: `out-${nodeLane}-${existingPrimaryLane}`,
          d: bezierCurve(nodeX, centerY, targetX, H),
          color: getLaneColor(existingPrimaryLane),
        })
      } else {
        // 父提交继承当前 nodeLane
        nextLanes[nodeLane] = primaryParent
        const startY = isHead ? centerY + 4.5 : centerY
        lines.push({
          key: `out-${nodeLane}-${nodeLane}`,
          d: straightLine(nodeX, startY, nodeX, H),
          color: nodeColor,
        })
      }

      // 次级父提交（Merge commit 的其余父提交）
      for (let p = 1; p < parents.length; p++) {
        const pHash = parents[p]
        const existingLane = nextLanes.indexOf(pHash)
        if (existingLane !== -1) {
          rowMaxLane = Math.max(rowMaxLane, existingLane)
          lines.push({
            key: `out-${nodeLane}-${existingLane}-${p}`,
            d: bezierCurve(nodeX, centerY, getLaneX(existingLane), H),
            color: getLaneColor(existingLane),
          })
        } else {
          // 分配新泳道
          const freeSlot = nextLanes.indexOf(null)
          const targetLane = freeSlot !== -1 ? freeSlot : nextLanes.length
          nextLanes[targetLane] = pHash
          rowMaxLane = Math.max(rowMaxLane, targetLane)
          lines.push({
            key: `out-${nodeLane}-${targetLane}-${p}`,
            d: bezierCurve(nodeX, centerY, getLaneX(targetLane), H),
            color: getLaneColor(targetLane),
          })
        }
      }
    }

    // 压缩末尾连续的 null
    while (nextLanes.length > 0 && nextLanes[nextLanes.length - 1] === null) {
      nextLanes.pop()
    }
    currentLanes = nextLanes

    overallMaxLane = Math.max(overallMaxLane, rowMaxLane)

    rows.push({
      nodeLane,
      nodeColor,
      isHead,
      lines,
      maxLane: rowMaxLane,
    })
  }

  // 保证整列图谱宽度自适应且与表头严格对齐
  const graphWidth = GRAPH_LANE_MARGIN + (overallMaxLane + 1) * GRAPH_LANE_STEP

  return { rows, graphWidth }
}
