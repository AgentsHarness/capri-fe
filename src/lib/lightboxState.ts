/**
 * Mounted full-screen image previews (`ui/ImageLightbox`). Outer dialogs
 * listen for Esc in the capture phase, which runs before the lightbox's own
 * capture listener; they consult this counter so one Esc closes the preview
 * instead of closing the preview and the dialog underneath together.
 */
let openLightboxes = 0

export function hasOpenLightbox(): boolean {
  return openLightboxes > 0
}

/** Registers an open preview; returns the matching cleanup. */
export function trackLightbox(): () => void {
  openLightboxes += 1
  return () => {
    openLightboxes -= 1
  }
}
