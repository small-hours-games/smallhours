// Small Hours - The phone and TV parts of each game plugin, written into the pages.
// A game may ship client/lib/*.js, client/phone.js, client/tv.js, client/phone.html
// (its phone section) and client/style.css inside its own sourceDir. All of them are optional.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCatalogVersion, getGame, listGames, publicGames } from './registry.js';
import { isGameVisibleInLobby } from './visibility.js';
import { publicPersonas } from '../engine/bots/personas.js';
import { API_CARD_CLIENT_DIR, DEFAULT_GAMES_DIR } from './paths.js';

export const GAMES_DIR = DEFAULT_GAMES_DIR;

export function clientDirForGame(gameOrId) {
  if (!gameOrId) return null;
  if (gameOrId === '_api-card') return API_CARD_CLIENT_DIR;
  const game = typeof gameOrId === 'string' ? getGame(gameOrId) : gameOrId;
  if (game?.sourceDir) return join(game.sourceDir, 'client');
  const fallbackFolder = typeof gameOrId === 'string' ? gameOrId : game?.folder || game?.id;
  return fallbackFolder ? join(DEFAULT_GAMES_DIR, fallbackFolder, 'client') : null;
}

const fragmentCache = new Map();

function scriptsFor(gameOrId, screen) {
  const id = typeof gameOrId === 'string' ? gameOrId : gameOrId.id;
  const dir = clientDirForGame(gameOrId);
  if (!dir || !existsSync(dir)) return [];
  const lib = existsSync(join(dir, 'lib'))
    ? readdirSync(join(dir, 'lib')).filter(f => f.endsWith('.js')).sort().map(f => 'lib/' + f)
    : [];
  return [...lib, `${screen}.js`].filter(f => existsSync(join(dir, f))).map(f => `/games/${id}/${f}`);
}

function getPageFragments(screen) {
  const version = getCatalogVersion();
  const cached = fragmentCache.get(screen);
  if (cached && cached.version === version) return cached;

  const games = listGames().filter(g => isGameVisibleInLobby(g));
  const customAliases = games
    .filter(g => g.isCustom && (g.kind === 'card-rules' || g.kind === 'card-remote' || g.kind === 'quiz'))
    .map(g => ({ id: g.id, base: g.kind === 'quiz' ? 'quiz' : '_api-card' }));
  // Register both canonical ID and any legacy aliases (e.g. 'card-palace' <-> 'shithead')
  // so client plugins calling SH.registerGame with either name work seamlessly.
  const builtInAliases = games.flatMap(g =>
    (g.aliases || []).flatMap(alias => [
      { id: alias, base: g.id },
      { id: g.id, base: alias },
    ])
  );
  const dynamicAliases = [...customAliases, ...builtInAliases];

  const catalog = '<script>var SH_GAMES = ' + JSON.stringify(publicGames()).replace(/</g, '\\u003c') + ';' +
    'var SH_AI = ' + JSON.stringify(publicPersonas()).replace(/</g, '\\u003c') + ';' +
    'var SH_DYNAMIC_ALIASES = ' + JSON.stringify(dynamicAliases).replace(/</g, '\\u003c') + ';</script>';
  const styles = games
    .filter(g => {
      const dir = clientDirForGame(g);
      return dir && existsSync(join(dir, 'style.css'));
    })
    .map(g => `<link rel="stylesheet" href="/games/${g.id}/style.css">`).join('\n  ');
  const apiCardScripts = scriptsFor('_api-card', screen);
  const scripts = [...new Set([...games.flatMap(g => scriptsFor(g, screen)), ...apiCardScripts])]
    .map(src => `<script src="${src}"></script>`).join('\n  ');
  const apiCardSection = screen === 'phone' && existsSync(join(API_CARD_CLIENT_DIR, 'phone.html'))
    ? [readFileSync(join(API_CARD_CLIENT_DIR, 'phone.html'), 'utf8')]
    : [];
  const sections = screen === 'phone'
    ? [
      ...games
        .map(g => {
          const dir = clientDirForGame(g);
          return dir ? join(dir, 'phone.html') : null;
        })
        .filter(f => f && existsSync(f))
        .map(f => readFileSync(f, 'utf8')),
      ...apiCardSection,
    ].join('\n')
    : '';

  const entry = { version, catalog, styles, sections, scripts };
  fragmentCache.set(screen, entry);
  return entry;
}

/** Fill in the plugin markers of host.html ('tv') or player.html ('phone'). */
export function renderGamePage(html, screen) {
  const { catalog, styles, sections, scripts } = getPageFragments(screen);
  return html
    .replace('<!-- game-catalog -->', () => catalog)
    .replace('<!-- game-styles -->', () => styles)
    .replace('<!-- game-sections -->', () => sections)
    .replace('<!-- game-scripts -->', () => scripts);
}
