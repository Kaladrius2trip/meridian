/**
 * Test preload — runs before every test file.
 * Clears environment variables that would interfere with test isolation.
 */

// Auth middleware reads this at request time; clear it so tests don't need API keys
delete process.env.MERIDIAN_API_KEY

// Redirect settings persistence to a throwaway file — profile-switch tests
// otherwise write bogus activeProfile values into the real ~/.config/meridian
// of the host (and the production proxy reads that file live).
import { join } from "node:path"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
process.env.MERIDIAN_SETTINGS_FILE = join(mkdtempSync(join(tmpdir(), "meridian-test-settings-")), "settings.json")
