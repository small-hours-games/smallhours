// Small Hours - Pure Quiz Round State Machine
// Shared by built-in Trivia Quiz, Music Quiz (via sdk.quiz), and API-created custom quizzes.
// Pure functions only — no I/O or network calls.

/**
 * Deterministic shuffle seeded by an integer.
 * Ensures all viewers (host + players) see the same answer order for a given question.
 */
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

/** Easy before medium; stable, so the shuffled order holds within each difficulty. */
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
          return {
            state,
            events: [{ type: 'error', playerId, message: 'Not in question phase' }],
          };
        }

        if (state.answers[playerId]) {
          return {
            state,
            events: [{ type: 'error', playerId, message: 'Already answered' }],
          };
        }

        let newPowerups = state.powerups;
        let newFiftyActivatedOn = state.fiftyActivatedOn || {};
        if (powerupType) {
          const playerPowerups = state.powerups[playerId];
          if (!playerPowerups || !playerPowerups[powerupType]) {
            return {
              state,
              events: [{ type: 'error', playerId, message: `Powerup ${powerupType} not available` }],
            };
          }
          newPowerups = {
            ...state.powerups,
            [playerId]: {
              ...playerPowerups,
              [powerupType]: false,
            },
          };
          if (powerupType === 'fifty') {
            newFiftyActivatedOn = { ...newFiftyActivatedOn, [playerId]: state.currentQuestion };
          }
        }

        const newAnswers = {
          ...state.answers,
          [playerId]: {
            answerId,
            timestamp: Date.now(),
            powerupType: powerupType || null,
          },
        };

        return {
          state: {
            ...state,
            answers: newAnswers,
            powerups: newPowerups,
            fiftyActivatedOn: newFiftyActivatedOn,
          },
          events: [
            {
              type: 'answer_submitted',
              playerId,
              usedPowerup: powerupType || null,
            },
          ],
        };
      },

      useFifty(state, { playerId }) {
        if (state.phase !== 'question') {
          return {
            state,
            events: [{ type: 'error', playerId, message: 'Not in question phase' }],
          };
        }
        if (state.answers[playerId]) {
          return {
            state,
            events: [{ type: 'error', playerId, message: 'Already answered' }],
          };
        }
        const playerPowerups = state.powerups[playerId];
        if (!playerPowerups || !playerPowerups.fifty) {
          return {
            state,
            events: [{ type: 'error', playerId, message: 'Powerup fifty not available' }],
          };
        }
        return {
          state: {
            ...state,
            powerups: {
              ...state.powerups,
              [playerId]: { ...playerPowerups, fifty: false },
            },
            fiftyActivatedOn: {
              ...(state.fiftyActivatedOn || {}),
              [playerId]: state.currentQuestion,
            },
          },
          events: [{ type: 'powerup_activated', playerId, powerupType: 'fifty' }],
        };
      },

      timerExpired(state, { phase }) {
        if (state.phase !== phase) {
          return { state, events: [] };
        }

        switch (phase) {
          case 'countdown': {
            return {
              state: {
                ...state,
                phase: 'question',
                questionStartTime: Date.now(),
                answers: {},
              },
              events: [{ type: 'phase_change', phase: 'question', questionIndex: state.currentQuestion }],
            };
          }

          case 'question': {
            const question = state.questions[state.currentQuestion];
            const correctAnswer = question.correct_answer;
            const newScores = { ...state.scores };
            const newStreaks = { ...state.streaks };
            const correctPlayers = [];

            for (const [pid, answer] of Object.entries(state.answers)) {
              const isCorrect = answer.answerId === correctAnswer;
              if (isCorrect) {
                const elapsed = answer.timestamp - state.questionStartTime;
                const timeRatio = Math.max(0, 1 - elapsed / (state.questionDuration || defaultQuestionDuration));
                let points = Math.round(1000 * (0.5 + 0.5 * timeRatio));

                if (answer.powerupType === 'double') {
                  points *= 2;
                }

                newStreaks[pid] = (newStreaks[pid] || 0) + 1;
                newScores[pid] = (newScores[pid] || 0) + points;
                correctPlayers.push(pid);
              } else {
                newStreaks[pid] = 0;
              }
            }

            for (const pid of Object.keys(newStreaks)) {
              if (!state.answers[pid]) {
                newStreaks[pid] = 0;
              }
            }

            return {
              state: {
                ...state,
                phase: 'reveal',
                scores: newScores,
                streaks: newStreaks,
              },
              events: [
                {
                  type: 'phase_change',
                  phase: 'reveal',
                  correctAnswer,
                  correctPlayers,
                },
              ],
            };
          }

          case 'reveal': {
            const nextQuestion = state.currentQuestion + 1;
            const hasMore = nextQuestion < state.questions.length;

            if (!hasMore) {
              return {
                state: { ...state, phase: 'finished' },
                events: [{ type: 'phase_change', phase: 'finished' }],
              };
            }

            return {
              state: {
                ...state,
                phase: 'between',
                currentQuestion: nextQuestion,
              },
              events: [{ type: 'phase_change', phase: 'between', nextQuestion }],
            };
          }

          case 'between': {
            return {
              state: {
                ...state,
                phase: 'question',
                questionStartTime: Date.now(),
                answers: {},
                round: state.round + 1,
              },
              events: [{ type: 'phase_change', phase: 'question', questionIndex: state.currentQuestion }],
            };
          }

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

          if (question.image && !question.media) {
            base.question.image = question.image;
          }

          if (question.media) {
            base.question.media = state.phase === 'reveal'
              ? { ...question.media }
              : { preview: question.media.preview };
          }

          const fiftyOn = state.fiftyActivatedOn && state.fiftyActivatedOn[playerId];
          const usedFiftyHere = fiftyOn === state.currentQuestion;

          if (usedFiftyHere) {
            const shuffledIncorrect = seededShuffle(question.incorrect_answers, state.currentQuestion);
            const keepIncorrect = shuffledIncorrect[0];
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

        const whoGotItRight = [];
        for (const [pid, answer] of Object.entries(state.answers)) {
          if (answer.answerId === question.correct_answer) {
            whoGotItRight.push(pid);
          }
        }
        base.correctPlayers = whoGotItRight;
        base.playerAnswers = Object.fromEntries(
          Object.entries(state.answers).map(([pid, answer]) => [pid, answer.answerId])
        );
      }

      if (state.phase === 'finished') {
        base.finalScores = { ...state.scores };
      }

      return base;
    },

    endIf(state) {
      if (state.phase !== 'finished') {
        return null;
      }

      let winner = null;
      let highScore = -1;
      for (const [pid, score] of Object.entries(state.scores)) {
        if (score > highScore) {
          highScore = score;
          winner = pid;
        }
      }

      return {
        winner,
        scores: { ...state.scores },
      };
    },
  };
}

export const quizEngine = createQuizEngine();
export default quizEngine;
