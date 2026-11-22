// Small Hours - Game plugins
// Discovers game plugins across configured GAMES_DIR directories (default ./games).
// Supports both factory plugins `export default function defineGame(sdk) { ... }`
// and plain manifest objects, category-prefixed folders (e.g. `card-palace/`),
// and backward-compatible ID `aliases` (e.g. `aliases: ['shithead']`).

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { loadCustomGames, buildCustomGameDefinition } from './custom-store.js';
import { isGameVisibleInLobby, isGameDefaultHidden, getVisibilityOverride } from './visibility.js';
import { DEFAULT_GAMES_DIR, resolveGamesDirs } from './paths.js';
import { platformSdk } from './sdk.js';

export const CATEGORY_PREFIXES = new Set([
  'card',
  'quiz',
  'arcade',
  'motion',
  'board',
  'party',
  'word',
  'dev',
]);

export function inferCategoryFromFolder(folder = '') {
  const idx = String(folder).indexOf('-');
  if (idx <= 0) return 'party';
  const prefix = folder.slice(0, idx);
  return CATEGORY_PREFIXES.has(prefix) ? prefix : 'party';
}

function folderMatchesManifest(game, folder) {
  if (!folder) return true;
  if (game.id === folder) return true;
  const idx = folder.indexOf('-');
  if (idx > 0) {
    const prefix = folder.slice(0, idx);
    const rest = folder.slice(idx + 1);
    if (CATEGORY_PREFIXES.has(prefix) && rest === game.id) return true;
  }
  if (Array.isArray(game.aliases) && game.aliases.includes(folder)) return true;
  return false;
}

/** Why a manifest cannot be used, or null when it is fine. */
export function manifestProblem(game, folder) {
  if (!game || typeof game !== 'object') return 'index.js has no default export';
  if (!game.id || typeof game.id !== 'string') return 'id is missing';
  if (!folderMatchesManifest(game, folder)) return `id "${game.id}" does not match the folder`;
  for (const fn of ['setup', 'view', 'endIf']) {
    if (typeof game[fn] !== 'function') return `${fn}() is missing`;
  }
  if (!game.actions || typeof game.actions !== 'object') return 'actions are missing';
  if (!game.label) return 'label is missing';
  if (!Number.isInteger(game.min) || !Number.isInteger(game.max) || game.min > game.max) return 'min/max players are invalid';
  return null;
}

/**
 * Load every game from one or more directories.
 * `dir` may be a single directory path or an array of directory paths.
 * Returns a Map of canonical game.id -> manifest.
 */
export async function loadGames(dir = resolveGamesDirs(), { sdk = platformSdk } = {}) {
  const dirs = Array.isArray(dir) ? dir : [dir || DEFAULT_GAMES_DIR];
  const games = new Map();
  const seenAliases = new Map();

  for (const rawDir of dirs) {
    const baseDir = resolve(rawDir);
    let entries = [];
    try {
      entries = await readdir(baseDir, { withFileTypes: true });
    } catch (err) {
      console.error('[games] cannot read', baseDir, err.message);
      continue;
    }
    const hasPrefix = name => {
      const idx = name.indexOf('-');
      return idx > 0 && CATEGORY_PREFIXES.has(name.slice(0, idx));
    };
    entries.sort((a, b) => (hasPrefix(b.name) - hasPrefix(a.name)) || a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      // If a category-prefixed folder (e.g. card-palace) already registered this legacy
      // folder name as an alias or id, silently skip the superseded legacy folder.
      if (games.has(entry.name) || seenAliases.has(entry.name)) continue;
      const sourceDir = join(baseDir, entry.name);
      try {
        const mod = await import(pathToFileURL(join(sourceDir, 'index.js')).href);
        const exported = mod.default;
        const rawGame = typeof exported === 'function' ? await exported(sdk) : exported;
        const problem = manifestProblem(rawGame, entry.name);
        if (problem) {
          console.error(`[games] skipping ${entry.name}: ${problem}`);
          continue;
        }
        if (games.has(rawGame.id) || seenAliases.has(rawGame.id)) {
          console.error(`[games] skipping ${entry.name}: duplicate id "${rawGame.id}"`);
          continue;
        }
        const aliases = Array.isArray(rawGame.aliases)
          ? [...new Set(rawGame.aliases.map(a => String(a || '').trim()).filter(a => a && a !== rawGame.id))]
          : [];
        const category = rawGame.category || inferCategoryFromFolder(entry.name);
        const hasClientFiles = existsSync(join(sourceDir, 'client', 'tv.js')) || existsSync(join(sourceDir, 'client', 'phone.js'));
        const game = {
          ...rawGame,
          aliases,
          category,
          folder: entry.name,
          sourceDir,
          hasClientFiles,
        };
        games.set(game.id, game);
        for (const alias of aliases) {
          if (!games.has(alias) && !seenAliases.has(alias)) {
            seenAliases.set(alias, game.id);
          }
        }
      } catch (err) {
        console.error(`[games] skipping ${entry.name}:`, err.message);
      }
    }
  }
  return games;
}

const GAMES = new Map();
const ALIAS_TO_ID = new Map();
const BUILTIN_IDS = new Set();
let catalogVersion = 0;

function rebuildAliasMap() {
  ALIAS_TO_ID.clear();
  for (const game of GAMES.values()) {
    if (Array.isArray(game.aliases)) {
      for (const alias of game.aliases) {
        if (alias && !GAMES.has(alias) && !ALIAS_TO_ID.has(alias)) {
          ALIAS_TO_ID.set(alias, game.id);
        }
      }
    }
  }
}

export async function reloadGames(dir = resolveGamesDirs()) {
  const loaded = await loadGames(dir);
  GAMES.clear();
  BUILTIN_IDS.clear();
  for (const [id, game] of loaded) {
    GAMES.set(id, game);
    BUILTIN_IDS.add(id);
  }
  rebuildAliasMap();

  for (const spec of await loadCustomGames()) {
    if (spec.enabled && !BUILTIN_IDS.has(spec.id) && !ALIAS_TO_ID.has(spec.id)) {
      GAMES.set(spec.id, { ...buildCustomGameDefinition(spec), isCustom: true });
    }
  }
  catalogVersion += 1;
  return GAMES;
}

await reloadGames();

export function getCatalogVersion() {
  return catalogVersion;
}

export function bumpCatalogVersion() {
  catalogVersion += 1;
  return catalogVersion;
}

/** Resolve a canonical game ID or legacy alias to the canonical game ID (or null). */
export function resolveGameId(id) {
  const key = String(id || '').trim();
  if (!key) return null;
  if (GAMES.has(key)) return key;
  return ALIAS_TO_ID.get(key) || null;
}

export function isBuiltInGame(id) {
  const resolved = resolveGameId(id);
  return resolved ? BUILTIN_IDS.has(resolved) : false;
}

export function registerDynamicGame(game) {
  if (!game || !game.id || BUILTIN_IDS.has(game.id) || ALIAS_TO_ID.has(game.id)) return false;
  GAMES.set(game.id, { ...game, isCustom: true });
  catalogVersion += 1;
  return true;
}

export function unregisterDynamicGame(id) {
  if (BUILTIN_IDS.has(id)) return false;
  const deleted = GAMES.delete(id);
  if (deleted) catalogVersion += 1;
  return deleted;
}

export function getGame(id) {
  const resolved = resolveGameId(id);
  return resolved ? GAMES.get(resolved) : undefined;
}

/** All loaded games, in catalog order. */
export function listGames() {
  return [...GAMES.values()].sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.id.localeCompare(b.id));
}

/** Games eligible for Swish pot rooms (`potEligible: true`), falling back to quiz/music-quiz. */
export function potGameIds(games = listGames()) {
  const eligible = games.filter(g => g.potEligible).map(g => g.id);
  return eligible.length > 0 ? eligible : ['quiz', 'music-quiz'];
}

/** The games people can pick, in the shape the phone and TV use. */
export function publicGames(games = listGames()) {
  return games.filter(g => isGameVisibleInLobby(g)).map(g => ({
    type: g.id,
    label: g.label,
    ...(g.title ? { title: g.title } : {}),
    ...(g.category ? { category: g.category } : {}),
    ...(g.folder ? { folder: g.folder } : {}),
    ...(g.aliases?.length ? { aliases: g.aliases } : {}),
    ...(g.roundUnit ? { roundUnit: g.roundUnit } : {}),
    ...(g.theme ? { theme: g.theme } : {}),
    ...(g.music ? { music: true } : {}),
    ...(g.potEligible ? { potEligible: true } : {}),
    ...(g.categoryVote ? { categoryVote: true } : {}),
    icon: g.icon,
    min: g.min,
    max: g.max,
    hasUi: g.hasUi !== undefined ? Boolean(g.hasUi) : (!isGameDefaultHidden(g) || Boolean(g.hasClientFiles) || getVisibilityOverride(g) === true),
    blurb: g.blurb,
    ...(g.soloBlurb ? { soloBlurb: g.soloBlurb } : {}),
    ...(g.ai ? { aiMax: g.ai.max } : {}),
  }));
}

/** Intro stories by game id (plus aliases), for the TV's story overlay. */
export function gameStories() {
  const out = {};
  for (const g of listGames()) {
    if (!g.story) continue;
    out[g.id] = g.story;
    for (const alias of g.aliases || []) out[alias] = g.story;
  }
  return out;
}
