const VIEW_STORAGE_KEY = 'waterworld:viewDistanceChunks';
const GRASS_DENSITY_STORAGE_KEY = 'waterworld:grassDensityPercent';
const GRASS_DISTANCE_STORAGE_KEY = 'waterworld:grassRenderDistance';

const MIN_VIEW_DISTANCE = 2;
const MAX_VIEW_DISTANCE = 8;
const DEFAULT_VIEW_DISTANCE = 3;
const CHUNK_SIZE_METRES = 64;

const MIN_GRASS_DENSITY = 0;
const MAX_GRASS_DENSITY = 400;
const DEFAULT_GRASS_DENSITY = 100;

const MIN_GRASS_DISTANCE = 10;
const MAX_GRASS_DISTANCE = 100;
const DEFAULT_GRASS_DISTANCE = 46;

export interface BootSettingsValue {
  viewDistanceChunks: number;
  grassDensityPercent: number;
  grassRenderDistance: number;
}

function clampViewDistance(value: number): number {
  return Math.max(MIN_VIEW_DISTANCE, Math.min(MAX_VIEW_DISTANCE, Math.round(value)));
}

function clampGrassDensity(value: number): number {
  return Math.max(MIN_GRASS_DENSITY, Math.min(MAX_GRASS_DENSITY, Math.round(value / 10) * 10));
}

function clampGrassDistance(value: number): number {
  return Math.max(MIN_GRASS_DISTANCE, Math.min(MAX_GRASS_DISTANCE, Math.round(value / 2) * 2));
}

function storedNumber(key: string, clamp: (value: number) => number): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? clamp(value) : null;
  } catch {
    return null;
  }
}

function saveNumber(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Storage can be unavailable in private / restricted browser modes. The
    // setting still works for the current launch, so there is nothing to do.
  }
}

/**
 * Small DOM-only pre-boot settings screen.
 *
 * Keeping this outside Game means world-generation and content settings are
 * chosen before workers, chunks, the renderer and WebXR are constructed.
 */
export class BootSettings {
  private readonly panel = document.getElementById('boot-settings')!;
  private readonly viewSlider = document.getElementById('view-distance') as HTMLInputElement;
  private readonly viewValue = document.getElementById('view-distance-value')!;
  private readonly densitySlider = document.getElementById('grass-density') as HTMLInputElement;
  private readonly densityValue = document.getElementById('grass-density-value')!;
  private readonly grassDistanceSlider = document.getElementById('grass-distance') as HTMLInputElement;
  private readonly grassDistanceValue = document.getElementById('grass-distance-value')!;
  private readonly startButton = document.getElementById('boot-start') as HTMLButtonElement;
  private readonly bootBar = document.getElementById('boot-bar')!;
  private readonly status = document.getElementById('boot-status')!;

  constructor(
    urlViewDistance?: number,
    urlGrassDensity?: number,
    urlGrassDistance?: number,
  ) {
    const view = clampViewDistance(
      urlViewDistance ?? storedNumber(VIEW_STORAGE_KEY, clampViewDistance) ?? DEFAULT_VIEW_DISTANCE,
    );
    const density = clampGrassDensity(
      urlGrassDensity ?? storedNumber(GRASS_DENSITY_STORAGE_KEY, clampGrassDensity) ?? DEFAULT_GRASS_DENSITY,
    );
    const grassDistance = clampGrassDistance(
      urlGrassDistance ?? storedNumber(GRASS_DISTANCE_STORAGE_KEY, clampGrassDistance) ?? DEFAULT_GRASS_DISTANCE,
    );

    this.viewSlider.value = String(view);
    this.densitySlider.value = String(density);
    this.grassDistanceSlider.value = String(grassDistance);
    this.updateViewLabel(view);
    this.updateDensityLabel(density);
    this.updateGrassDistanceLabel(grassDistance);

    this.viewSlider.addEventListener('input', () => this.updateViewLabel(this.currentViewDistance()));
    this.densitySlider.addEventListener('input', () => this.updateDensityLabel(this.currentGrassDensity()));
    this.grassDistanceSlider.addEventListener('input', () =>
      this.updateGrassDistanceLabel(this.currentGrassDistance()),
    );
  }

  waitForStart(): Promise<BootSettingsValue> {
    return new Promise((resolve) => {
      this.startButton.addEventListener(
        'click',
        () => {
          const viewDistanceChunks = this.currentViewDistance();
          const grassDensityPercent = this.currentGrassDensity();
          const grassRenderDistance = this.currentGrassDistance();

          saveNumber(VIEW_STORAGE_KEY, viewDistanceChunks);
          saveNumber(GRASS_DENSITY_STORAGE_KEY, grassDensityPercent);
          saveNumber(GRASS_DISTANCE_STORAGE_KEY, grassRenderDistance);

          this.panel.hidden = true;
          this.bootBar.hidden = false;
          this.status.textContent = 'initialising';
          resolve({ viewDistanceChunks, grassDensityPercent, grassRenderDistance });
        },
        { once: true },
      );
    });
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  private currentViewDistance(): number {
    return clampViewDistance(Number(this.viewSlider.value));
  }

  private currentGrassDensity(): number {
    return clampGrassDensity(Number(this.densitySlider.value));
  }

  private currentGrassDistance(): number {
    return clampGrassDistance(Number(this.grassDistanceSlider.value));
  }

  private updateViewLabel(chunks: number): void {
    const metres = chunks * CHUNK_SIZE_METRES;
    this.viewValue.textContent = `${chunks} chunks · ~${metres} m radius`;
  }

  private updateDensityLabel(percent: number): void {
    this.densityValue.textContent = `${percent}%`;
  }

  private updateGrassDistanceLabel(metres: number): void {
    this.grassDistanceValue.textContent = `${metres} m`;
  }
}
