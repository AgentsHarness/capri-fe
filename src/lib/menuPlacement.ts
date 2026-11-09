/**
 * Viewport placement for a dropdown that prefers to sit under the right edge
 * of its trigger.
 *
 * `right-0` alone breaks when the trigger wraps to the left edge on a narrow
 * screen: the panel keeps its full width and runs off the left side. Clamp the
 * left edge to `pad` and cap the width so a panel wider than the viewport still
 * leaves the padding on both sides.
 */
export function placePanel(
  anchorRight: number,
  width: number,
  viewportWidth: number,
  pad = 8,
): { left: number; width: number } {
  const capped = Math.min(width, Math.max(0, viewportWidth - pad * 2))
  const left = Math.max(pad, Math.min(anchorRight - capped, viewportWidth - pad - capped))
  return { left, width: capped }
}
