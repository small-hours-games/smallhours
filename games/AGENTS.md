# AGENTS.md — Small Hours Games (`games` repository)

Standalone game development repository for the Small Hours Games platform (`small-hours`).

## Repository Boundary & Platform SDK

Games in this repository are **self-contained plugins**. Never import from `../../src/` or `../../tests/` in `small-hours` — those paths do not exist when `games` lives in its own repository.

Instead:
- Export `export default function defineGame(sdk = defaultSdk)` from `<folder>/index.js` (and `Object.assign(defineGame, defineGame())` so the export can also be inspected directly as a manifest object).
- Import standalone helpers, card utilities, quiz engine, and test harness from `../_sdk/index.js`:
  - `sdk.cards` / `{ SUITS, createDeck, shuffle, deal }`
  - `sdk.bots` / `{ AI_PERSONAS, personaFor }`
  - `sdk.quiz` / `{ createQuizEngine, quizEngine, PHASE_DURATIONS, seededShuffle, easierFirst }`
  - `sdk.content` / `{ fetchQuestions, warmQuizNarration, enrichQuestionsWithImages, musicPlaylists, fetchPlaylistTracks, buildMusicQuestions }`
  - Test harness exports from `../_sdk/index.js`: `{ createTestGame, act, actChain, viewFor, isOver, playUntilEnd, manifestProblem }`
- When loaded by `small-hours` (via default `./games` or `GAMES_DIR=/path/to/games`), `small-hours` injects its live `platformSdk` into `defineGame(sdk)`.

## Folder Naming Convention

Every game lives in a category-prefixed folder:

| Prefix | Category | Examples |
| --- | --- | --- |
| `card-<name>` | Card games | `card-palace`, `card-gin-rummy`, `card-sjuan`, `card-blackjack`, `card-texas-holdem`, `card-hilow`, `card-uno` |
| `quiz-<name>` | Quiz & trivia | `quiz-trivia` (`id: 'quiz'`), `quiz-music` (`id: 'music-quiz'`) |
| `arcade-<name>` | 3D / motion arcade | `arcade-tennis` (`id: 'tennis'`), `arcade-runner` (`id: 'runner'`), `arcade-tilt-ball` (`id: 'tilt-ball'`) |
| `dev-<name>` | Experimental / dev tools | `dev-sensor-lab` (`id: 'sensor-lab'`, `status: 'dev'`) |
| `_template`, `_sdk` | Internal template & SDK | Ignored by the game loader (`_*`) |

A game's `id` in `index.js` must either equal the folder name (recommended for new games, e.g. `id: 'card-palace'`), list the folder name in `aliases`, or match the unprefixed part of `<category>-<id>`. Use `aliases: ['old-id']` whenever renaming an existing game so saved links, pot rooms, and `/admin` visibility overrides continue to resolve.

## Lobby Visibility & `/admin` Guardrail

- Games with `hidden: true`, `status: 'dev'`, or in a `dev-*` folder default to **hidden** from the TV/phone lobby until explicitly toggled **On** in `/admin`.
- Setting `GAMES_DEFAULT_HIDDEN=1` on the platform hides all newly added games by default until approved in `/admin`.
