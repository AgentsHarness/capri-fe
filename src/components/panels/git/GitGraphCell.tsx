import {
  getLaneX,
  GRAPH_ROW_HEIGHT,
  GRAPH_CENTER_Y,
  type GitGraphRowData,
} from './gitGraph'

export function GitGraphCell({
  row,
  width,
}: {
  row?: GitGraphRowData
  width: number
}) {
  if (!row) {
    return <span className="shrink-0" style={{ width }} aria-hidden="true" />
  }

  const { nodeLane, nodeColor, isHead, lines } = row
  const nodeX = getLaneX(nodeLane)
  const centerY = GRAPH_CENTER_Y

  return (
    <span
      className="flex shrink-0 items-center justify-center self-stretch"
      style={{ width }}
      aria-hidden="true"
    >
      <svg
        width={width}
        height={GRAPH_ROW_HEIGHT}
        viewBox={`0 0 ${width} ${GRAPH_ROW_HEIGHT}`}
        className="block shrink-0"
      >
        {lines.map((line) => (
          <path
            key={line.key}
            d={line.d}
            fill="none"
            stroke={line.color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}

        {isHead ? (
          <circle
            data-testid="git-graph-node"
            cx={nodeX}
            cy={centerY}
            r={5}
            fill="none"
            stroke={nodeColor}
            strokeWidth={2.2}
          />
        ) : (
          <circle
            data-testid="git-graph-node"
            cx={nodeX}
            cy={centerY}
            r={3.8}
            fill={nodeColor}
          />
        )}
      </svg>
    </span>
  )
}
