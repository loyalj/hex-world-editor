/**
 * UI-chrome preferences (panel visibility and the like) in localStorage —
 * per-browser conveniences, deliberately separate from the document autosave
 * in sessionStore. Every access is guarded: a blocked storage (private
 * windows, storage pressure) degrades to defaults, never to an error.
 */

const STORAGE_KEY = 'hex-world-editor:ui';

function readAll(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The stored preference, or null when unset/unavailable (caller defaults). */
export function loadUiPref(name: string): boolean | null {
  const value = readAll()[name];
  return typeof value === 'boolean' ? value : null;
}

export function storeUiPref(name: string, value: boolean): void {
  storeUiPrefValue(name, value);
}

/**
 * A structured preference (the theme, say) — any JSON-serializable value.
 * The caller owns validation: what comes back is whatever was stored.
 */
export function loadUiPrefValue<T>(name: string): T | null {
  const value = readAll()[name];
  return value === undefined ? null : (value as T);
}

export function storeUiPrefValue(name: string, value: unknown): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readAll(), [name]: value }));
  } catch {
    // Preference simply won't survive the reload.
  }
}
