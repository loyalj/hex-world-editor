import type { SeasonScope, WeatherType } from '@loyalj/hex-world';
import { loadUiPref, storeUiPref } from '../ui/uiPrefs.ts';
import type { CellPos, Tool, ToolContext, ToolId } from './tool.ts';

/**
 * The environment panel's full state, in raw control units (the slider values
 * as they appear in the DOM), so snapshot/restore involve no conversions.
 * Travels inside save files and autosaves.
 */
export interface EnvironmentState {
  tod: number;            // minutes past midnight, 0–1440
  todAnimate: boolean;
  dayLength: number;      // seconds per full day
  weather: WeatherType;
  intensity: number;      // 0–100
  clouds: boolean;
  windSpeed: number;
  windDir: number;        // degrees
  windGust: number;       // 0–100
  scatterTexture: number; // 0–100
  seasonsOn: boolean;
  seasonPhase: number;    // 0–100
  seasonAnimate: boolean;
  seasonDays: number;
  seasonScope: SeasonScope;
}

/** Minutes past midnight as "HH:MM". */
function formatClock(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * Scene-wide settings rather than a paint brush: time of day, weather, wind,
 * scatter texture, and seasons, each a folding section of the panel. The
 * panel is the source of truth — its opening state is pushed into the scene
 * at construction, because the library builds its day/weather/season systems
 * lazily and browsers restore control state across a reload without firing
 * `change`.
 */
export class EnvironmentTool implements Tool {
  readonly id: ToolId = 'environment';
  readonly title = 'Environment';
  readonly panel = document.getElementById('environment-options') as HTMLElement;
  /** Edits global settings, not cells — the selection mask never applies. */
  readonly ignoresSelectionMask = true;
  readonly ignoresLocks = true;

  private readonly ctx: ToolContext;
  private weatherKind: WeatherType = 'clear';

  /** Capture the whole panel for a save file. Assigned in the constructor. */
  snapshot!: () => EnvironmentState;
  /** Push a saved panel state back through the controls' own wiring. */
  restore!: (state: EnvironmentState) => void;

  private readonly todSlider     = document.getElementById('tod-slider')       as HTMLInputElement;
  private readonly todValue      = document.getElementById('tod-value')        as HTMLElement;
  private readonly todAnimate    = document.getElementById('tod-animate')      as HTMLInputElement;
  private readonly seasonsEnable = document.getElementById('seasons-enable')   as HTMLInputElement;
  private readonly seasonPhase   = document.getElementById('season-phase')     as HTMLInputElement;
  private readonly seasonPhaseVal = document.getElementById('season-phase-value') as HTMLElement;
  private readonly seasonAnimate = document.getElementById('season-animate')   as HTMLInputElement;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
    const scene = ctx.scene;

    // ---- Folding sections ----
    // Which sections stand open is a per-browser convenience, like panel
    // visibility, not document state — so it lives in the UI prefs, not the
    // snapshot. The info-tip glyph inside a summary must not toggle the fold.
    for (const section of this.panel.querySelectorAll<HTMLDetailsElement>('details.env-section')) {
      const name = section.dataset['section'] ?? '';
      const stored = loadUiPref(`env-section:${name}`);
      if (stored !== null) section.open = stored;
      section.addEventListener('toggle', () => storeUiPref(`env-section:${name}`, section.open));
      section.querySelector('summary')?.addEventListener('click', e => {
        if ((e.target as HTMLElement).closest('.info-tip')) e.preventDefault();
      });
    }

    // ---- Time of day + weather ----
    const todSlider     = this.todSlider;
    const todValue      = this.todValue;
    const todAnimate    = this.todAnimate;
    const dayLengthEl   = document.getElementById('day-length')       as HTMLInputElement;
    const dayLengthVal  = document.getElementById('day-length-value') as HTMLElement;
    const weatherIntEl  = document.getElementById('weather-intensity')       as HTMLInputElement;
    const weatherIntVal = document.getElementById('weather-intensity-value') as HTMLElement;
    const windSpeedEl   = document.getElementById('wind-speed')       as HTMLInputElement;
    const windSpeedVal  = document.getElementById('wind-speed-value') as HTMLElement;
    const windDirEl     = document.getElementById('wind-dir')         as HTMLInputElement;
    const windDirVal    = document.getElementById('wind-dir-value')   as HTMLElement;
    const windGustEl    = document.getElementById('wind-gust')        as HTMLInputElement;
    const windGustVal   = document.getElementById('wind-gust-value')  as HTMLElement;
    const scatterTexEl  = document.getElementById('scatter-texture')       as HTMLInputElement;
    const scatterTexVal = document.getElementById('scatter-texture-value') as HTMLElement;
    const weatherClouds = document.getElementById('weather-clouds')   as HTMLInputElement;
    const todPresetBtns   = document.querySelectorAll<HTMLButtonElement>('#tod-preset-group button');
    const weatherTypeBtns = document.querySelectorAll<HTMLButtonElement>('#weather-type-group button');

    /** Wind heading in degrees → the ground-plane vector the library drifts clouds along. */
    const windVector = (): { windX: number; windY: number } => {
      const speed = Number(windSpeedEl.value);
      const rad   = (Number(windDirEl.value) * Math.PI) / 180;
      return { windX: Math.cos(rad) * speed, windY: Math.sin(rad) * speed };
    };

    /** Push the whole weather picture at once — switching type rebuilds the layer. */
    const applyWeather = (): void => {
      scene.setWeather(this.weatherKind, {
        intensity: Number(weatherIntEl.value) / 100,
        clouds:    weatherClouds.checked,
        ...windVector(),
      });
    };

    todSlider.addEventListener('input', () => {
      const minutes = Number(todSlider.value);
      todValue.textContent = formatClock(minutes);
      todPresetBtns.forEach(b => b.classList.toggle('active', b.dataset['tod'] === todSlider.value));
      scene.setTimeOfDay(minutes / 1440);
    });

    todPresetBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        todSlider.value = btn.dataset['tod'] ?? '720';
        todSlider.dispatchEvent(new Event('input'));
      });
    });

    todAnimate.addEventListener('change', () => {
      scene.setDayCycle(todAnimate.checked, Number(dayLengthEl.value));
    });

    dayLengthEl.addEventListener('input', () => {
      dayLengthVal.textContent = `${dayLengthEl.value}s`;
      if (todAnimate.checked) scene.setDayCycle(true, Number(dayLengthEl.value));
    });

    weatherTypeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        this.weatherKind = btn.dataset['weather'] as WeatherType;
        weatherTypeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        applyWeather();
      });
    });

    weatherIntEl.addEventListener('input', () => {
      weatherIntVal.textContent = `${weatherIntEl.value}%`;
      scene.setWeatherIntensity(Number(weatherIntEl.value) / 100);
    });

    const onWindChange = (): void => {
      windSpeedVal.textContent = Number(windSpeedEl.value).toFixed(1);
      windDirVal.textContent   = `${windDirEl.value}°`;
      windGustVal.textContent  = `${windGustEl.value}%`;
      const { windX, windY } = windVector();
      scene.setWind(windX, windY);
      scene.setGustiness(Number(windGustEl.value) / 100);
    };
    windSpeedEl.addEventListener('input', onWindChange);
    windDirEl.addEventListener('input', onWindChange);
    windGustEl.addEventListener('input', onWindChange);

    const onScatterTexChange = (): void => {
      scatterTexVal.textContent = `${scatterTexEl.value}%`;
      scene.setScatterTexture(Number(scatterTexEl.value) / 100);
    };
    scatterTexEl.addEventListener('input', onScatterTexChange);
    // The attach default and the slider agree at 18%, but push anyway rather than
    // relying on that — the two live in different files and drift silently.
    onScatterTexChange();
    // Same reasoning as the applyWeather() call below — the sliders' opening values
    // have to reach the scene, or the panel reads 35% gust over a steady wind.
    onWindChange();

    weatherClouds.addEventListener('change', applyWeather);

    // Push the controls' starting state now: the library builds its WeatherSystem
    // on the first setWeather call, so without this the scene opens with no cloud
    // shadows at all and only picks them up once the weather is touched.
    applyWeather();

    // ---- Seasons ----
    const seasonsEnableEl = this.seasonsEnable;
    const seasonPhaseEl   = this.seasonPhase;
    const seasonPhaseVal  = this.seasonPhaseVal;
    const seasonAnimateEl = this.seasonAnimate;
    const seasonDaysEl    = document.getElementById('season-days')        as HTMLInputElement;
    const seasonDaysVal   = document.getElementById('season-days-value')  as HTMLElement;
    const seasonPresetBtns = document.querySelectorAll<HTMLButtonElement>('#season-preset-group button');
    const seasonScopeBtns  = document.querySelectorAll<HTMLButtonElement>('#season-scope-group button');

    /** Grey out the season controls until seasons are actually running. */
    const updateSeasonControls = (): void => {
      const on = seasonsEnableEl.checked;
      for (const el of [seasonPhaseEl, seasonAnimateEl, seasonDaysEl]) el.disabled = !on;
      seasonPresetBtns.forEach(b => { b.disabled = !on; });
      seasonScopeBtns.forEach(b => {
        b.disabled = !on;
        b.classList.toggle('active', b.dataset['seasonScope'] === scene.seasonScope);
      });
      seasonPhaseVal.textContent = on ? scene.seasonLabel : 'off';
    };

    seasonScopeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        scene.setSeasonScope(btn.dataset['seasonScope'] as SeasonScope);
        updateSeasonControls();
      });
    });

    /** Push the season controls' current state into the scene. */
    const applySeasonControls = (): void => {
      scene.setSeasonsEnabled(seasonsEnableEl.checked);
      if (seasonsEnableEl.checked) {
        scene.setSeasonPhase(Number(seasonPhaseEl.value) / 100);
        scene.setSeasonCycle(seasonAnimateEl.checked, Number(seasonDaysEl.value));
      }
      updateSeasonControls();
    };

    seasonsEnableEl.addEventListener('change', applySeasonControls);

    seasonPhaseEl.addEventListener('input', () => {
      const phase = Number(seasonPhaseEl.value) / 100;
      scene.setSeasonPhase(phase);
      seasonPhaseVal.textContent = scene.seasonLabel;
      seasonPresetBtns.forEach(b => b.classList.toggle('active', Number(b.dataset['season']) === phase));
    });

    seasonPresetBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        seasonPhaseEl.value = String(Number(btn.dataset['season']) * 100);
        seasonPhaseEl.dispatchEvent(new Event('input'));
      });
    });

    seasonAnimateEl.addEventListener('change', () => {
      scene.setSeasonCycle(seasonAnimateEl.checked, Number(seasonDaysEl.value));
    });

    seasonDaysEl.addEventListener('input', () => {
      seasonDaysVal.textContent = `${seasonDaysEl.value} days`;
      scene.setSeasonCycle(seasonAnimateEl.checked, Number(seasonDaysEl.value));
    });

    // Day clock and year clock: read the restored checkbox state, don't assume
    // it matches the defaults.
    if (todAnimate.checked) scene.setDayCycle(true, Number(dayLengthEl.value));
    applySeasonControls();

    // ---- Snapshot / restore ----
    // Closures rather than methods so they can reach every control wired above.
    this.snapshot = () => ({
      tod:            Number(todSlider.value),
      todAnimate:     todAnimate.checked,
      dayLength:      Number(dayLengthEl.value),
      weather:        this.weatherKind,
      intensity:      Number(weatherIntEl.value),
      clouds:         weatherClouds.checked,
      windSpeed:      Number(windSpeedEl.value),
      windDir:        Number(windDirEl.value),
      windGust:       Number(windGustEl.value),
      scatterTexture: Number(scatterTexEl.value),
      seasonsOn:      seasonsEnableEl.checked,
      seasonPhase:    Number(seasonPhaseEl.value),
      seasonAnimate:  seasonAnimateEl.checked,
      seasonDays:     Number(seasonDaysEl.value),
      seasonScope:    scene.seasonScope,
    });

    this.restore = (st: EnvironmentState) => {
      // Restore by writing the controls and firing their own events, so the
      // scene is updated by exactly the code paths the user's clicks take.
      todSlider.value = String(st.tod);
      todSlider.dispatchEvent(new Event('input'));
      dayLengthEl.value = String(st.dayLength);
      dayLengthEl.dispatchEvent(new Event('input'));
      todAnimate.checked = st.todAnimate;
      todAnimate.dispatchEvent(new Event('change'));

      windSpeedEl.value = String(st.windSpeed);
      windDirEl.value   = String(st.windDir);
      windGustEl.value  = String(st.windGust);
      windSpeedEl.dispatchEvent(new Event('input')); // one dispatch pushes all three
      scatterTexEl.value = String(st.scatterTexture);
      scatterTexEl.dispatchEvent(new Event('input'));

      // Weather last among the sky controls: clicking the type button rebuilds
      // the layer from the intensity/clouds/wind restored above.
      weatherIntEl.value = String(st.intensity);
      weatherIntEl.dispatchEvent(new Event('input'));
      weatherClouds.checked = st.clouds;
      document.querySelector<HTMLButtonElement>(
        `#weather-type-group button[data-weather="${st.weather}"]`)?.click();

      // Seasons: values first, then the enable toggle pushes them into the
      // scene. The scope is set directly — its buttons are disabled while
      // seasons are off, and applySeasonControls re-highlights from the scene.
      scene.setSeasonScope(st.seasonScope);
      seasonPhaseEl.value   = String(st.seasonPhase);
      seasonDaysEl.value    = String(st.seasonDays);
      seasonDaysEl.dispatchEvent(new Event('input'));
      seasonAnimateEl.checked = st.seasonAnimate;
      seasonsEnableEl.checked = st.seasonsOn;
      seasonsEnableEl.dispatchEvent(new Event('change'));
      if (st.seasonsOn) seasonPhaseEl.dispatchEvent(new Event('input'));
    };
  }

  /**
   * While a cycle runs, the clock is the scene's and not the slider's — the
   * controls follow the sim rather than driving it. Called from the editor's
   * readout loop, already throttled.
   */
  syncAnimatedControls(): void {
    const scene = this.ctx.scene;
    if (this.todAnimate.checked) {
      const minutes = scene.timeOfDay * 1440;
      this.todSlider.value      = String(Math.round(minutes / 5) * 5);
      this.todValue.textContent = formatClock(minutes);
    }
    // The enable check matters because a disabled checkbox keeps its state:
    // with seasons switched off nothing is advancing, and the slider would
    // otherwise be dragged to whatever phase the cycle last held.
    if (this.seasonsEnable.checked && this.seasonAnimate.checked) {
      this.seasonPhase.value          = String(Math.round(scene.seasonPhase * 100));
      this.seasonPhaseVal.textContent = scene.seasonLabel;
    }
  }

  brushRadius(): number { return 0; }
  deactivate(): void {}
  pointerDown(_cell: CellPos, _e: PointerEvent): void {} // scene-wide settings, nothing to paint
  pointerMove(_cell: CellPos | null, _e: PointerEvent): void {}
  pointerUp(): void {}

  statusText(): string {
    return `Environment · ${this.todValue.textContent} · ${this.weatherKind}`;
  }
}
