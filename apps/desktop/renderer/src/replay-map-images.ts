export interface ReplayMapImageEntry {
  image: HTMLImageElement;
  status: 'loading' | 'ready' | 'failed';
}

/** Bounded to one map's finite layer list, owned by one Replay session. */
export class ReplayMapImages {
  readonly entries = new Map<string, ReplayMapImageEntry>();
  private disposed = false;

  constructor(urls: readonly [string, string][], createImage: () => HTMLImageElement = () => new Image()) {
    for (const [layerId, url] of urls) {
      const image = createImage(), entry: ReplayMapImageEntry = { image, status: 'loading' };
      this.entries.set(layerId, entry);
      image.onload = () => {
        void image.decode().then(() => {
          if (!this.disposed) entry.status = 'ready';
        }, () => { if (!this.disposed) entry.status = 'failed'; });
      };
      image.onerror = () => { if (!this.disposed) entry.status = 'failed'; };
      image.src = url;
    }
  }

  dispose() {
    this.disposed = true;
    for (const { image } of this.entries.values()) {
      image.onload = null;
      image.onerror = null;
      image.removeAttribute('src');
    }
    this.entries.clear();
  }
}
