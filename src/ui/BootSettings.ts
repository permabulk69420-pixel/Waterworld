const STORAGE_KEY = 'waterworld:viewDistanceChunks';
const MIN_VIEW_DISTANCE = 2;
const MAX_VIEW_DISTANCE = 8;
const DEFAULT_VIEW_DISTANCE = 3;
const CHUNK_SIZE_METRES = 64;

export interface BootSettingsValue {
  viewDistanceChunks: number;
}

function clampViewDistance(value: number): number {
  return Math.max(MIN_VIEW_DISTANCE, Math.min(MAX_VIEW_DISTANCE, Math.round(value)));
}

function storedViewDistance(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? clampViewDistance(value) : null;
  } catch {
    return null;
  }
}

function saveViewDistance(value: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // Storage can be unavailable in private / restricted browser modes. The
    // setting still works for the current launch, so there is nothing to do.
  }
}

/**
 * Small DOM-only pre-boot settings screen.
 *
 * Keeping this outside Game means world-generation settings are chosen before
 * workers, chunks, the renderer and WebXR are constructed. It also gives us one
 * place to add future launch-time graphics/performance settings without mixing
 * menu DOM code into the game loop.
 */
export class BootSettings {
  private readonly panel = document.getElementById('boot-settings')!;
  private readonly slider = document.getElementById('view-distance') as HTMLInputElement;
  private readonly value = document.getElementById('view-distance-value')!;
  private readonly startButton = document.getElementById('boot-start') as HTMLButtonElement;
  private readonly bootBar = document.getElementById('boot-bar')!;
  private readonly status = document.getElementById('boot-status')!;

  constructor(urlViewDistance?: number) {
    const initial = clampViewDistance(
      urlViewDistance ?? storedViewDistance() ?? DEFAULT_VIEW_DISTANCE,
    );
    this.slider.value = String(initial);
    this.updateLabel(initial);
    this.slider.addEventListener('input', () => this.updateLabel(this.currentViewDistance()));
  }

  waitForStart(): Promise<BootSettingsValue> {
    return new Promise((resolve) => {
      this.startButton.addEventListener(
        'click',
        () => {
          const viewDistanceChunks = this.currentViewDistance();
          saveViewDistance(viewDistanceChunks);
          this.panel.hidden = true;
          this.bootBar.hidden = false;
          this.status.textContent = 'initialising';
          resolve({ viewDistanceChunks });
        },
        { once: true },
      );
    });
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  private currentViewDistance(): number {
    return clampViewDistance(Number(this.slider.value));
  }

  private updateLabel(chunks: number): void {
    const metres = chunks * CHUNK_SIZE_METRES;
    this.value.textContent = `${chunks} chunks · ~${metres} m radius`;
  }
}
