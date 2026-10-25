/** Effect images belong to a single mounted Replay, including their native sources. */
export function mountReplayEffectImages(urls: Readonly<Record<string, string>>,
  publish: (key: string, image: HTMLImageElement) => void,
  createImage: () => HTMLImageElement = () => new Image()): () => void {
  let disposed = false;
  let listener: typeof publish | null = publish;
  let images = Object.entries(urls).map(([key, url]) => {
    const image = createImage();
    image.onload = () => { if (!disposed) listener?.(key, image); };
    image.src = url;
    return image;
  });
  return () => {
    if (disposed) return;
    disposed = true;
    listener = null;
    const owned = images;
    images = [];
    for (const image of owned) {
      image.onload = image.onerror = null;
      // In the bundled Electron, removing src retained detached Image wrappers
      // across natural collections. Empty src releases both the source and wrapper.
      image.src = '';
    }
  };
}

/** Shrink setup-owned nodes, even after React has nulled/reassigned the live refs. */
export function releaseReplayCanvases(canvases: readonly (HTMLCanvasElement | null)[]): void {
  for (const canvas of canvases) if (canvas) canvas.width = canvas.height = 1;
}
