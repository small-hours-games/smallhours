# Mobile Game-Over "Back to Lobby" Fronting Frame — Design

**Date:** 2026-11-22
**Status:** Approved

## Intent & Why
When a game ends on mobile (`phase === 'finished'`), `#gameOverBanner` in `public/player.html` renders as a normal block below `<!-- game-sections -->`, so tall game controllers (card hands, touch pads, quiz controls) push **Back to Lobby** below the fold. Converting `#gameOverBanner` into a fixed fronting frame puts the final standings and **Back to Lobby** button directly in front of the controller area across every game.

## Approach
- **Chosen:** Turn `#gameOverBanner` in `public/player.html` + `public/css/player.css` into a fixed fronting overlay (`position: fixed; inset: 0; z-index: 220;`), matching the existing `#surrenderModal` transition pattern (`is-open`), with a dimmed backdrop (`rgba(4, 9, 22, 0.72)`), centered gold-bordered card (`max-width: 440px`, safe-area insets, scrollable standings within `max-height: 85dvh`), and a prominent full-width amber **Back to Lobby** CTA.
- **Why others don't fit:** Per-game overlays would duplicate UI across every game folder and violate the shared shell contract.

## Details
- Markup in `public/player.html`: move/wrap `#gameOverBanner` as a fixed modal container (`role="dialog" aria-modal="true" aria-labelledby="gameOverTitle"`) containing `.game-over-backdrop` and `.game-over-card` (preserving `#gameOverBanner`, `#gameOverTitle`, `#gameOverStandings`, `#backToLobbyBtn` IDs).
- JS in `public/player.html`: `showGameOverBanner(msg)` unhides `#gameOverBanner`, adds `.is-open` on next frame (matching `openSurrenderModal`), and focuses `#backToLobbyBtn`; `hideGameOverBanner()` removes `.is-open` and hides `#gameOverBanner`.
- CSS in `public/css/player.css`: `.game-over-banner` uses `position: fixed; inset: 0; z-index: 220;` (above all game controllers and `.avatar-sheet` 200, below `.toast-container` 1000 and `.round-countdown-overlay` 1300), fades in backdrop and pops in card smoothly, caps card height with scrollable `.game-over-standings` so **Back to Lobby** always remains visible at the bottom of the card on short/landscape screens.
