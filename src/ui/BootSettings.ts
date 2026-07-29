import type { GameMode } from '../build/BuildSystem.ts';

const VIEW_STORAGE_KEY = 'waterworld:viewDistanceChunks';
const GRASS_DENSITY_STORAGE_KEY = 'waterworld:grassDensityPercent';
const GRASS_DISTANCE_STORAGE_KEY = 'waterworld:grassRenderDistance';
const MODE_STORAGE_KEY = 'waterworld:launchMode';

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
  mode: GameMode;
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

function parseMode(value: string | null | undefined): GameMode | null {
  return value === 'story' || value === 'build' ? value : null;
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

function storedMode(): GameMode | null {
  try {
    return parseMode(localStorage.getItem(MODE_STORAGE_KEY));
  } catch {
    return null;
  }
}

function saveNumber(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Restricted/private browser storage still allows the current launch to continue.
  }
}

function saveMode(mode: GameMode): void {
  try {
    localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    // Same as the numeric settings: persistence is optional, launch is not.
  }
}

/**
 * Small DOM-only pre-boot settings screen.
 *
 * Story/Build is deliberately a launch choice on the existing panel rather than
 * a third screen. Build still loads the same procedural world, just with the
 * authored-object editor enabled and gameplay thrusters disabled.
 */
export class BootSettings {
  private readonly panel = document.getElementById('boot-settings')!;
  private readonly storyButton = document.getElementById('mode-story') as HTMLButtonElement;
  private readonly buildButton = document.getElementById('mode-build') as HTMLButtonElement;
  private readonly viewSlider = document.getElementById('view-distance') as HTMLInputElement;
  private readonly viewValue = document.getElementById('view-distance-value')!;
  private readonly densitySlider = document.getElementById('grass-density') as HTMLInputElement;
  private readonly densityValue = document.getElementById('grass-density-value')!;
  private readonly grassDistanceSlider = document.getElementById('grass-distance') as HTMLInputElement;
  private readonly grassDistanceValue = document.getElementById('grass-distance-value')!;
  private readonly startButton = document.getElementById('boot-start') as HTMLButtonElement;
  private readonly bootBar = document.getElementById('boot-bar')!;
  private readonly status = document.getElementById('boot-status')!;

  private mode: GameMode;

  constructor(
    urlViewDistance?: number,
    urlGrassDensity?: number,
    urlGrassDistance?: number,
    urlMode?: string | null,
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

    this.mode = parseMode(urlMode) ?? storedMode() ?? 'story';
    this.viewSlider.value = String(view);
    this.densitySlider.value = String(density);
    this.grassDistanceSlider.value = String(grassDistance);
    this.updateModeButtons();
    this.updateViewLabel(view);
    this.updateDensityLabel(density);
    this.updateGrassDistanceLabel(grassDistance);

    this.storyButton.addEventListener('click', () => this.setMode('story'));
    this.buildButton.addEventListener('click', () => this.setMode('build'));
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

          saveMode(this.mode);
          saveNumber(VIEW_STORAGE_KEY, viewDistanceChunks);
          saveNumber(GRASS_DENSITY_STORAGE_KEY, grassDensityPercent);
          saveNumber(GRASS_DISTANCE_STORAGE_KEY, grassRenderDistance);

          this.panel.hidden = true;
          this.bootBar.hidden = false;
          this.status.textContent = 'initialising';
          resolve({ mode: this.mode, viewDistanceChunks, grassDensityPercent, grassRenderDistance });
        },
        { once: true },
      );
    });
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  private setMode(mode: GameMode): void {
    this.mode = mode;
    this.updateModeButtons();
  }

  private updateModeButtons(): void {
    this.storyButton.classList.toggle('active', this.mode === 'story');
    this.buildButton.classList.toggle('active', this.mode === 'build');
    this.startButton.textContent = this.mode === 'build' ? 'Enter build mode' : 'Enter story mode';
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
