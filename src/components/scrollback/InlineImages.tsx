/**
 * Inline images for a conversation row. `size` selects the layout:
 * assistant rows get wide images (max 65%), user rows small thumbnails
 * (max-h-24, hover scale). Click opens the block viewer for the owning
 * entry — the full-size view with byte/mime meta lives there.
 */
export function InlineImages({
  images,
  size,
  onOpen,
}: {
  images: Array<{ data: string; mimeType?: string }>
  size: 'assistant' | 'user'
  onOpen: () => void
}) {
  if (!images.length) return null
  return (
    <div
      className={`flex flex-wrap ${
        size === 'assistant' ? 'items-start gap-2' : 'items-end gap-1.5'
      }`}
    >
      {images.map((img, i) => (
        <img
          key={i}
          src={img.data}
          alt={img.mimeType ? `image (${img.mimeType})` : 'image'}
          loading="lazy"
          onClick={onOpen}
          title="点击放大查看"
          className={
            size === 'assistant'
              ? 'max-w-[65%] cursor-zoom-in rounded border border-gn-prompt-border'
              : 'max-h-24 max-w-[45%] cursor-zoom-in rounded border border-gn-prompt-border object-contain transition-transform duration-150 hover:scale-110'
          }
        />
      ))}
    </div>
  )
}
