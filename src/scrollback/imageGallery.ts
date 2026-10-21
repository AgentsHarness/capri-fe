import type { ScrollEntry } from '../api/types'
import type { DisplayRow } from './verbGroup'

/** 画廊组里的一行：仍是独立的 image 条目（各自 accent / 选中 / 查看器）。 */
export type GalleryRow = {
  row: Extract<DisplayRow, { type: 'entry' }>
  i: number
}

/** 连续独立 image 行的聚合组。 */
export type ImageGalleryGroup = {
  key: string
  rows: GalleryRow[]
  /** lightbox 的导航集合；必须与 rows 同步追加。 */
  images: Array<{ data: string; mimeType?: string }>
}

/**
 * 把一行独立 image 追加进画廊组（`group` 缺省时新建）。
 *
 * rows 与 images 必须一起追加：只追加 rows 会让组内任意一张的点开索引在
 * lightbox 里被 `Math.min(index, images.length - 1)` 夹到第一张（图集永远
 * 只显示首图）。
 */
export function appendImageRow(
  group: ImageGalleryGroup | undefined,
  row: Extract<DisplayRow, { type: 'entry' }>,
  i: number,
): ImageGalleryGroup {
  const e = row.entry as Extract<ScrollEntry, { kind: 'image' }>
  const image = { data: e.data, mimeType: e.mimeType }
  if (!group) {
    return { key: `ig_${row.entry.id}`, rows: [{ row, i }], images: [image] }
  }
  group.rows.push({ row, i })
  group.images.push(image)
  return group
}
