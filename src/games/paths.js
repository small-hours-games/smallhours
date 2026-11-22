// Small Hours - Game Directory Resolution
// Resolves one or more game plugin directories from GAMES_DIR (colon/semicolon separated
// via path.delimiter) or falls back to the local ./games folder.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DEFAULT_GAMES_DIR = path.join(REPO_ROOT, 'games');
export const API_CARD_CLIENT_DIR = fileURLToPath(new URL('./api-card-client/', import.meta.url));

/**
 * Resolve configured game plugin directories in priority order.
 * Supports `GAMES_DIR` containing a single path or multiple paths separated by `path.delimiter`
 * (`:` on POSIX, `;` on Windows). Relative paths are resolved against `cwd`.
 */
export function resolveGamesDirs({ env = process.env, cwd = process.cwd() } = {}) {
  const raw = String(env.GAMES_DIR || '').trim();
  if (!raw) return [DEFAULT_GAMES_DIR];
  const dirs = raw
    .split(path.delimiter)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => (path.isAbsolute(p) ? p : path.resolve(cwd, p)));
  return dirs.length > 0 ? [...new Set(dirs)] : [DEFAULT_GAMES_DIR];
}
