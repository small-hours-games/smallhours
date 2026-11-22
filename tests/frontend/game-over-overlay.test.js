import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const playerHtml = readFileSync(new URL('../../public/player.html', import.meta.url), 'utf8');
const playerCss = readFileSync(new URL('../../public/css/player.css', import.meta.url), 'utf8');

function extractBlock(source, fnName) {
  const start = source.indexOf(`function ${fnName}(`);
  if (start === -1) throw new Error(`Function ${fnName} not found`);
  let depth = 0;
  let started = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') { depth += 1; started = true; }
    else if (ch === '}') {
      depth -= 1;
      if (started && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Unterminated function ${fnName}`);
}

describe('Mobile Game-Over Back to Lobby fronting frame', () => {
  it('renders #gameOverBanner as a fronting dialog overlay outside <main> with backdrop, card, standings, and Back to Lobby button', () => {
    const mainEnd = playerHtml.indexOf('</main>');
    const bannerStart = playerHtml.indexOf('id="gameOverBanner"');
    expect(mainEnd).toBeGreaterThan(0);
    expect(bannerStart).toBeGreaterThan(mainEnd);

    const snippet = playerHtml.slice(bannerStart - 60, bannerStart + 1200);
    expect(snippet).toContain('class="game-over-backdrop"');
    expect(snippet).toContain('class="game-over-card"');
    expect(snippet).toContain('role="dialog"');
    expect(snippet).toContain('aria-modal="true"');
    expect(snippet).toContain('aria-labelledby="gameOverTitle"');
    expect(snippet).toContain('id="gameOverTitle"');
    expect(snippet).toContain('id="gameOverStandings"');
    expect(snippet).toContain('id="backToLobbyBtn"');
    expect(snippet).toContain('Back to Lobby');
  });

  it('positions .game-over-banner as a fixed full-viewport overlay above controllers with scrollable standings', () => {
    const bannerRule = playerCss.match(/\.game-over-banner\s*\{[^}]+\}/)?.[0] || '';
    expect(bannerRule).toMatch(/position:\s*fixed/);
    expect(bannerRule).toMatch(/inset:\s*0/);
    expect(bannerRule).toMatch(/z-index:\s*220/);

    const cardRule = playerCss.match(/\.game-over-card\s*\{[^}]+\}/)?.[0] || '';
    expect(cardRule).toMatch(/max-height:/);

    const standingsRule = playerCss.match(/\.game-over-standings\s*\{[^}]+\}/)?.[0] || '';
    expect(standingsRule).toMatch(/overflow-y:\s*auto/);
  });

  it('opens with .is-open, renders sorted standings, focuses #backToLobbyBtn, and cleans up on hide', () => {
    const classes = new Set();
    const banner = {
      hidden: true,
      classList: {
        add: c => classes.add(c),
        remove: c => classes.delete(c),
        contains: c => classes.has(c),
      },
    };
    const title = { textContent: '' };
    const list = { innerHTML: '' };
    const backBtn = { focus: vi.fn() };
    const els = { gameOverBanner: banner, gameOverTitle: title, gameOverStandings: list, backToLobbyBtn: backBtn };

    const code = [
      extractBlock(playerHtml, 'showGameOverBanner'),
      extractBlock(playerHtml, 'hideGameOverBanner'),
    ].join('\n');

    const ctx = {
      document: { getElementById: id => els[id] || null },
      state: { playerId: 'p1', playerNames: { p1: 'Alice', p2: 'Bob' } },
      escapeHtml: s => String(s),
      requestAnimationFrame: fn => fn(),
    };
    runInNewContext(code, ctx);

    ctx.showGameOverBanner({
      winner: 'p1',
      scores: { p1: 120, p2: 80 },
      sessionPoints: { p1: 3, p2: 1 },
      playerNames: { p1: 'Alice', p2: 'Bob' },
    });

    expect(banner.hidden).toBe(false);
    expect(classes.has('is-open')).toBe(true);
    expect(title.textContent).toBe('You win!');
    expect(list.innerHTML).toContain('1. Alice (You)');
    expect(list.innerHTML).toContain('2. Bob');
    expect(backBtn.focus).toHaveBeenCalledTimes(1);

    ctx.hideGameOverBanner();
    expect(classes.has('is-open')).toBe(false);
    expect(banner.hidden).toBe(true);
  });
});
