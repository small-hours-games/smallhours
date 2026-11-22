// Small Hours Games — Standalone Platform SDK & Test Harness
// Allows the `games` repository to run and test every game completely standalone
// (zero relative imports into the `small-hours` platform repo).
// At runtime inside `small-hours`, the platform injects its live `sdk` into `defineGame(sdk)`.

export const SUITS = ['h', 'd', 'c', 's'];

export function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function createDeck({ aceHigh = false, decks = 1, opaqueIds = false, idSuffix = '' } = {}) {
  const [low, high] = aceHigh ? [2, 14] : [1, 13];
  const cards = [];
  for (let d = 0; d < decks; d++) {
    for (const suit of SUITS) {
      for (let rank = low; rank <= high; rank++) {
        cards.push({ id: `${rank}${suit}${idSuffix}${decks > 1 ? '_' + d : ''}`, suit, rank });
      }
    }
  }
  const deck = shuffle(cards);
  return opaqueIds ? deck.map(({ suit, rank }, i) => ({ id: 'c' + i, suit, rank })) : deck;
}

export function deal(deck, players, count) {
  const rest = [...deck];
  const hands = Object.fromEntries(players.map(id => [id, []]));
  for (let round = 0; round < count; round++) {
    for (const id of players) {
      if (rest.length) hands[id].push(rest.pop());
    }
  }
  return { hands, rest };
}

export const AI_PERSONAS = [
  { name: 'Nova-7', avatar: '\u{1F916}', style: 'calculating', entrance: 'boot' },
  { name: 'Glitch', avatar: '\u{1F47E}', style: 'chaotic', entrance: 'glitch' },
  { name: 'Prof. Byte', avatar: '\u{1F9E0}', style: 'cautious', entrance: 'dizzy' },
  { name: 'Turbo', avatar: '\u{1F680}', style: 'aggressive', entrance: 'zoom' },
  { name: 'Echo', avatar: '\u{1F6F0}\u{FE0F}', style: 'calculating', entrance: 'boot' },
];

export function personaFor(botId) {
  const m = /^bot_(\d+)$/.exec(String(botId || ''));
  return m ? AI_PERSONAS[(Number(m[1]) - 1) % AI_PERSONAS.length] : null;
}

export function seededShuffle(arr, seed) {
  const shuffled = [...arr];
  let s = seed | 0;
  for (let i = shuffled.length - 1; i > 0; i--) {
    s = Math.imul(s, 1664525) + 1013904223 | 0;
    const j = Math.abs(s) % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function easierFirst(questions) {
  return [...questions].sort((a, b) => (a.difficulty !== 'easy') - (b.difficulty !== 'easy'));
}

export const PHASE_DURATIONS = {
  countdown: 5000,
  question: 15000,
  reveal: 4000,
  between: 5000,
};

export function createQuizEngine({ defaultQuestionDuration = PHASE_DURATIONS.question } = {}) {
  return {
    setup({ players, config }) {
      const questions = config.questions || [];
      const questionCount = config.questionCount || questions.length;
      const selectedQuestions = questions.slice(0, questionCount);
      const scores = {};
      const streaks = {};
      const powerups = {};
      for (const id of players) {
        scores[id] = 0;
        streaks[id] = 0;
        powerups[id] = { double: true, fifty: true, freeze: true };
      }
      return {
        phase: 'countdown',
        currentQuestion: 0,
        questions: selectedQuestions,
        answers: {},
        scores,
        streaks,
        powerups,
        fiftyActivatedOn: {},
        questionStartTime: null,
        questionDuration: config.questionDuration || defaultQuestionDuration,
        round: 0,
      };
    },
    actions: {
      answer(state, { playerId, answerId, powerupType }) {
        if (state.phase !== 'question') {
          return { state, events: [{ type: 'error', playerId, message: 'Not in question phase' }] };
        }
        if (state.answers[playerId]) {
          return { state, events: [{ type: 'error', playerId, message: 'Already answered' }] };
        }
        let newPowerups = state.powerups;
        let newFiftyActivatedOn = state.fiftyActivatedOn || {};
        if (powerupType) {
          const playerPowerups = state.powerups[playerId];
          if (!playerPowerups || !playerPowerups[powerupType]) {
            return { state, events: [{ type: 'error', playerId, message: `Powerup ${powerupType} not available` }] };
          }
          newPowerups = { ...state.powerups, [playerId]: { ...playerPowerups, [powerupType]: false } };
          if (powerupType === 'fifty') {
            newFiftyActivatedOn = { ...newFiftyActivatedOn, [playerId]: state.currentQuestion };
          }
        }
        const newAnswers = {
          ...state.answers,
          [playerId]: { answerId, timestamp: Date.now(), powerupType: powerupType || null },
        };
        return {
          state: { ...state, answers: newAnswers, powerups: newPowerups, fiftyActivatedOn: newFiftyActivatedOn },
          events: [{ type: 'answer_submitted', playerId, usedPowerup: powerupType || null }],
        };
      },
      useFifty(state, { playerId }) {
        if (state.phase !== 'question') {
          return { state, events: [{ type: 'error', playerId, message: 'Not in question phase' }] };
        }
        if (state.answers[playerId]) {
          return { state, events: [{ type: 'error', playerId, message: 'Already answered' }] };
        }
        const playerPowerups = state.powerups[playerId];
        if (!playerPowerups || !playerPowerups.fifty) {
          return { state, events: [{ type: 'error', playerId, message: 'Powerup fifty not available' }] };
        }
        return {
          state: {
            ...state,
            powerups: { ...state.powerups, [playerId]: { ...playerPowerups, fifty: false } },
            fiftyActivatedOn: { ...(state.fiftyActivatedOn || {}), [playerId]: state.currentQuestion },
          },
          events: [{ type: 'powerup_activated', playerId, powerupType: 'fifty' }],
        };
      },
      timerExpired(state, { phase }) {
        if (state.phase !== phase) return { state, events: [] };
        switch (phase) {
          case 'countdown':
            return {
              state: { ...state, phase: 'question', questionStartTime: Date.now(), answers: {} },
              events: [{ type: 'phase_change', phase: 'question', questionIndex: state.currentQuestion }],
            };
          case 'question': {
            const question = state.questions[state.currentQuestion];
            const correctAnswer = question.correct_answer;
            const newScores = { ...state.scores };
            const newStreaks = { ...state.streaks };
            const correctPlayers = [];
            for (const [pid, answer] of Object.entries(state.answers)) {
              if (answer.answerId === correctAnswer) {
                const elapsed = answer.timestamp - state.questionStartTime;
                const timeRatio = Math.max(0, 1 - elapsed / (state.questionDuration || defaultQuestionDuration));
                let points = Math.round(1000 * (0.5 + 0.5 * timeRatio));
                if (answer.powerupType === 'double') points *= 2;
                newStreaks[pid] = (newStreaks[pid] || 0) + 1;
                newScores[pid] = (newScores[pid] || 0) + points;
                correctPlayers.push(pid);
              } else {
                newStreaks[pid] = 0;
              }
            }
            for (const pid of Object.keys(newStreaks)) {
              if (!state.answers[pid]) newStreaks[pid] = 0;
            }
            return {
              state: { ...state, phase: 'reveal', scores: newScores, streaks: newStreaks },
              events: [{ type: 'phase_change', phase: 'reveal', correctAnswer, correctPlayers }],
            };
          }
          case 'reveal': {
            const nextQuestion = state.currentQuestion + 1;
            if (nextQuestion >= state.questions.length) {
              return {
                state: { ...state, phase: 'finished' },
                events: [{ type: 'phase_change', phase: 'finished' }],
              };
            }
            return {
              state: { ...state, phase: 'between', currentQuestion: nextQuestion },
              events: [{ type: 'phase_change', phase: 'between', nextQuestion }],
            };
          }
          case 'between':
            return {
              state: { ...state, phase: 'question', questionStartTime: Date.now(), answers: {}, round: state.round + 1 },
              events: [{ type: 'phase_change', phase: 'question', questionIndex: state.currentQuestion }],
            };
          default:
            return { state, events: [] };
        }
      },
    },
    view(state, playerId) {
      const base = {
        phase: state.phase,
        currentQuestion: state.currentQuestion,
        totalQuestions: state.questions.length,
        scores: { ...state.scores },
        score: state.scores[playerId] || 0,
        myPowerups: state.powerups[playerId] ? { ...state.powerups[playerId] } : {},
        myStreak: state.streaks[playerId] || 0,
        round: state.round,
      };
      if (state.phase === 'question' || state.phase === 'reveal') {
        const question = state.questions[state.currentQuestion];
        if (question) {
          const allAnswers = [question.correct_answer, ...question.incorrect_answers];
          const answers = seededShuffle(allAnswers, state.currentQuestion);
          base.question = {
            id: question.id,
            text: question.question,
            answers,
            category: question.category,
            difficulty: question.difficulty,
          };
          if (question.image && !question.media) base.question.image = question.image;
          if (question.media) {
            base.question.media = state.phase === 'reveal' ? { ...question.media } : { preview: question.media.preview };
          }
          const fiftyOn = state.fiftyActivatedOn && state.fiftyActivatedOn[playerId];
          if (fiftyOn === state.currentQuestion) {
            const keepIncorrect = seededShuffle(question.incorrect_answers, state.currentQuestion)[0];
            base.eliminatedAnswers = answers
              .map((a, i) => (a === question.correct_answer || a === keepIncorrect ? -1 : i))
              .filter(i => i !== -1);
          } else {
            base.eliminatedAnswers = [];
          }
          base.hasAnswered = !!state.answers[playerId];
          base.selectedAnswer = state.answers[playerId]?.answerId ?? null;
        }
      }
      if (state.phase === 'reveal') {
        const question = state.questions[state.currentQuestion];
        base.correctAnswer = question.correct_answer;
        base.correctIndex = base.question ? base.question.answers.indexOf(question.correct_answer) : -1;
        base.correctPlayers = Object.entries(state.answers)
          .filter(([, a]) => a.answerId === question.correct_answer)
          .map(([pid]) => pid);
        base.playerAnswers = Object.fromEntries(
          Object.entries(state.answers).map(([pid, a]) => [pid, a.answerId])
        );
      }
      if (state.phase === 'finished') base.finalScores = { ...state.scores };
      return base;
    },
    endIf(state) {
      if (state.phase !== 'finished') return null;
      let winner = null;
      let highScore = -1;
      for (const [pid, score] of Object.entries(state.scores)) {
        if (score > highScore) {
          highScore = score;
          winner = pid;
        }
      }
      return { winner, scores: { ...state.scores } };
    },
  };
}

export const quizEngine = createQuizEngine();

// --- Pure Engine & Test Harness ---
let gameCounter = 0;

export function createGame(gameDefinition, ctx) {
  gameCounter += 1;
  return {
    id: `game_${Date.now()}_${gameCounter}`,
    state: gameDefinition.setup(ctx),
    definition: gameDefinition,
  };
}

export function processAction(game, action) {
  const { definition, state } = game;
  const { type, ...payload } = action;
  const handler = definition.actions[type];
  if (!handler) {
    return { game, events: [{ type: 'error', message: `Unknown action: ${type}` }] };
  }
  const result = handler(state, payload);
  return {
    game: { ...game, state: result.state },
    events: result.events || [],
  };
}

export function getView(game, playerId) {
  return game.definition.view(game.state, playerId);
}

export function checkEnd(game) {
  return game.definition.endIf(game.state);
}

export function createTestGame(gameDefinition, players = ['p1', 'p2'], config = {}) {
  const def = typeof gameDefinition === 'function' ? gameDefinition(defaultSdk) : gameDefinition;
  return createGame(def, { players, config });
}

export function act(game, type, playerId, payload = {}) {
  return processAction(game, { type, playerId, ...payload });
}

export function actChain(game, actions) {
  let current = game;
  const allEvents = [];
  for (const [type, playerId, payload] of actions) {
    const result = act(current, type, playerId, payload || {});
    current = result.game;
    allEvents.push(...result.events);
  }
  return { game: current, events: allEvents };
}

export function viewFor(game, playerId) {
  return getView(game, playerId);
}

export function isOver(game) {
  return checkEnd(game);
}

export function playUntilEnd(game, actionFn, maxTurns = 100) {
  let current = game;
  let turns = 0;
  while (!isOver(current) && turns < maxTurns) {
    const action = actionFn(current, turns);
    if (!action) break;
    const [type, playerId, payload] = action;
    current = act(current, type, playerId, payload || {}).game;
    turns++;
  }
  return { game: current, turns };
}

export function manifestProblem(rawGame, folder) {
  const game = typeof rawGame === 'function' ? rawGame(defaultSdk) : rawGame;
  if (!game || typeof game !== 'object') return 'index.js has no default export';
  if (!game.id || typeof game.id !== 'string') return 'id is missing';
  if (folder && game.id !== folder && !(Array.isArray(game.aliases) && game.aliases.includes(folder)) && !folder.endsWith('-' + game.id)) {
    return `id "${game.id}" does not match the folder`;
  }
  for (const fn of ['setup', 'view', 'endIf']) {
    if (typeof game[fn] !== 'function') return `${fn}() is missing`;
  }
  if (!game.actions || typeof game.actions !== 'object') return 'actions are missing';
  if (!game.label) return 'label is missing';
  if (!Number.isInteger(game.min) || !Number.isInteger(game.max) || game.min > game.max) return 'min/max players are invalid';
  return null;
}

export const defaultSdk = Object.freeze({
  version: '1',
  cards: Object.freeze({ SUITS, createDeck, shuffle, deal }),
  bots: Object.freeze({ AI_PERSONAS, personaFor }),
  content: Object.freeze({
    fetchQuestions: async () => ({ ok: false, error: { message: 'Not configured in standalone SDK' } }),
    warmQuizNarration: async () => {},
    enrichQuestionsWithImages: async questions => questions,
    musicPlaylists: () => [],
    fetchPlaylistTracks: async () => ({ ok: false, error: { message: 'Not configured in standalone SDK' } }),
    buildMusicQuestions: (tracks = [], count = 1, { usedIds = new Set(), category = 'Music', rng = Math.random, offset = 0 } = {}) => {
      const available = tracks.filter(t => t && !usedIds.has('dz_' + t.id));
      if (!available.length || tracks.length < 4) return [];
      const pick = available[Math.floor(rng() * available.length)];
      const mode = offset % 2 === 0 ? 'title' : 'artist';
      const correct = mode === 'title' ? pick.title : pick.artist;
      const pool = [...new Set(tracks.map(t => (mode === 'title' ? t.title : t.artist)).filter(v => v && v !== correct))];
      if (pool.length < 3) return [];
      return [{
        id: 'dz_' + pick.id,
        question: mode === 'title' ? 'What song is this?' : 'Who performs this track?',
        correct_answer: correct,
        incorrect_answers: pool.slice(0, 3),
        category,
        difficulty: 'easy',
        media: { preview: pick.preview, title: pick.title, artist: pick.artist, cover: pick.cover },
      }].slice(0, count);
    },
  }),
  quiz: Object.freeze({ createQuizEngine, quizEngine, PHASE_DURATIONS, seededShuffle, easierFirst }),
  engine: Object.freeze({ createGame, processAction, getView, checkEnd }),
});
