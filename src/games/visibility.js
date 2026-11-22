// Small Hours - Lobby Game Visibility Guardrail
// Persists per-game shown/hidden overrides in data/admin/lobby-visibility.json.
// Enforces default-hidden guardrails for in-development games (`hidden: true`, `status: 'dev'`,
// `dev-*` folders, or `GAMES_DEFAULT_HIDDEN=1`) until an admin enables them in /admin.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_VISIBILITY_FILE = fileURLToPath(new URL('../../data/admin/lobby-visibility.json', import.meta.url));

let overrides = loadSync(DEFAULT_VISIBILITY_FILE);

function loadSync(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data.overrides === 'object' && data.overrides ? { ...data.overrides } : {};
  } catch {
    return {};
  }
}

/** Whether a game starts hidden in the lobby before any /admin override is applied. */
export function isGameDefaultHidden(game, env = process.env) {
  if (!game || !game.id) return true;
  if (game.hidden) return true;
  if (game.status === 'dev' || game.category === 'dev') return true;
  if (typeof game.folder === 'string' && game.folder.startsWith('dev-')) return true;
  if (!game.isCustom && /^(1|true|yes)$/i.test(String(env.GAMES_DEFAULT_HIDDEN || ''))) return true;
  return false;
}

/** Look up an explicit /admin visibility override for `game.id` or any of its `aliases`. */
export function getVisibilityOverride(game, map = overrides) {
  if (!game || !game.id || !map) return undefined;
  if (Object.prototype.hasOwnProperty.call(map, game.id)) {
    return Boolean(map[game.id]);
  }
  if (Array.isArray(game.aliases)) {
    for (const alias of game.aliases) {
      if (Object.prototype.hasOwnProperty.call(map, alias)) {
        return Boolean(map[alias]);
      }
    }
  }
  return undefined;
}

export function isGameVisibleInLobby(game, map = overrides, env = process.env) {
  if (!game || !game.id) return false;
  const override = getVisibilityOverride(game, map);
  if (override !== undefined) return override;
  return !isGameDefaultHidden(game, env);
}

export function getLobbyVisibilityOverrides() {
  return { ...overrides };
}

export async function setGameLobbyVisibility(id, visible, file = DEFAULT_VISIBILITY_FILE, aliasOpt = {}) {
  const cleanId = String(id || '').trim();
  if (!cleanId) throw new Error('Game id required');
  const aliases = Array.isArray(aliasOpt) ? aliasOpt : (aliasOpt?.aliases || []);
  for (const alias of aliases) {
    if (alias && alias !== cleanId) delete overrides[alias];
  }
  if (visible === null || visible === undefined) {
    delete overrides[cleanId];
  } else {
    overrides[cleanId] = Boolean(visible);
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify({ overrides }, null, 2) + '\n');
  await fsp.rename(tmp, file);
  return getLobbyVisibilityOverrides();
}

export function resetVisibilityCacheForTest(next = {}) {
  overrides = { ...next };
}
