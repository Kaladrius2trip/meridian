/**
 * Persistent server settings.
 *
 * Stored in ~/.config/meridian/settings.json. Survives proxy restarts.
 * Shared between CLI, UI, and API — browser localStorage is only used
 * for client-only preferences (theme, collapsed sections, etc.).
 *
 * This is a leaf module — no imports from server.ts or session/.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"

// Resolved lazily so MERIDIAN_SETTINGS_FILE (set by the test preload) can
// redirect writes away from the real user config — profile-switch tests
// otherwise persist bogus activeProfile values into the running proxy's state.
function settingsFile(): string {
  return process.env.MERIDIAN_SETTINGS_FILE ?? join(homedir(), ".config", "meridian", "settings.json")
}

export interface MeridianSettings {
  /** Last active profile ID — restored on proxy startup */
  activeProfile?: string
  /** Profile routing mode (#383): "active" (default) or "sticky".
   *  MERIDIAN_ROUTING env var takes precedence when set. */
  routing?: string
}

/** Read settings from disk. Returns empty object if file doesn't exist or is invalid. */
export function loadSettings(): MeridianSettings {
  try {
    if (!existsSync(settingsFile())) return {}
    return JSON.parse(readFileSync(settingsFile(), "utf-8"))
  } catch {
    return {}
  }
}

/** Write settings to disk. Merges with existing settings (doesn't clobber unknown keys). */
export function saveSettings(updates: Partial<MeridianSettings>): void {
  const current = loadSettings()
  const merged = { ...current, ...updates }
  try {
    mkdirSync(dirname(settingsFile()), { recursive: true })
    writeFileSync(settingsFile(), JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 })
  } catch (err) {
    console.warn(`[meridian] Failed to write ${settingsFile()}: ${err instanceof Error ? err.message : err}`)
  }
}

/** Get a single setting value */
export function getSetting<K extends keyof MeridianSettings>(key: K): MeridianSettings[K] {
  return loadSettings()[key]
}

/** Set a single setting value and persist */
export function setSetting<K extends keyof MeridianSettings>(key: K, value: MeridianSettings[K]): void {
  saveSettings({ [key]: value })
}
