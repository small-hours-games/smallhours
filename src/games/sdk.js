// Small Hours - Platform SDK injected into game plugins
// Games export `export default function defineGame(sdk) { ... }` so they never need
// relative ../../src/ imports and can live in a separate `games` repository.

import { SUITS, createDeck, shuffle, deal } from '../cards/deck.js';
import { AI_PERSONAS, personaFor } from '../engine/bots/personas.js';
import { createGame, processAction, getView, checkEnd } from '../engine/engine.js';
import { fetchQuestions } from '../fetcher/cached-fetcher.js';
import { warmQuizNarration } from '../fetcher/cached-narration.js';
import { enrichQuestionsWithImages } from '../fetcher/cached-question-images.js';
import { musicPlaylists, fetchPlaylistTracks, buildMusicQuestions } from '../fetcher/deezer.js';
import { createQuizEngine, quizEngine, PHASE_DURATIONS, seededShuffle, easierFirst } from './quiz-engine.js';

export function createPlatformSdk(overrides = {}) {
  return Object.freeze({
    version: '1',
    cards: Object.freeze({
      SUITS,
      createDeck,
      shuffle,
      deal,
      ...(overrides.cards || {}),
    }),
    bots: Object.freeze({
      AI_PERSONAS,
      personaFor,
      ...(overrides.bots || {}),
    }),
    content: Object.freeze({
      fetchQuestions,
      warmQuizNarration,
      enrichQuestionsWithImages,
      musicPlaylists,
      fetchPlaylistTracks,
      buildMusicQuestions,
      ...(overrides.content || {}),
    }),
    quiz: Object.freeze({
      createQuizEngine,
      quizEngine,
      PHASE_DURATIONS,
      seededShuffle,
      easierFirst,
      ...(overrides.quiz || {}),
    }),
    engine: Object.freeze({
      createGame,
      processAction,
      getView,
      checkEnd,
      ...(overrides.engine || {}),
    }),
  });
}

export const platformSdk = createPlatformSdk();
