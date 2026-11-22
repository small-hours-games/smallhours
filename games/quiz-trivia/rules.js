// Small Hours - Quiz / Trivia Game
import {
  defaultSdk,
  quizEngine,
  PHASE_DURATIONS,
  easierFirst,
} from '../_sdk/index.js';

let fetchQuestions = defaultSdk.content.fetchQuestions;
let warmQuizNarration = defaultSdk.content.warmQuizNarration;
let enrichQuestionsWithImages = defaultSdk.content.enrichQuestionsWithImages;

export function configureRules(content = {}) {
  if (content.fetchQuestions) fetchQuestions = content.fetchQuestions;
  if (content.warmQuizNarration) warmQuizNarration = content.warmQuizNarration;
  if (content.enrichQuestionsWithImages) enrichQuestionsWithImages = content.enrichQuestionsWithImages;
}

const EASY_POOL_SIZE = 50;

const quiz = {
  ...quizEngine,

  async prepare(config, { usedQuestionIds }) {
    const amount = config.questionCount || 10;

    // Party game: easy questions first. The mixed bucket is the fallback when they run out.
    let result = await fetchQuestions(config.categoryId, EASY_POOL_SIZE, { difficulty: 'easy' });
    if (!result.ok) result = await fetchQuestions(config.categoryId, amount);
    if (!result.ok) {
      throw new Error(`Failed to fetch questions: ${result.error.message}`);
    }

    // Shuffle the full pool, then prefer unseen questions. Set insertion order
    // records recency so exhausted pools rotate oldest questions first.
    let candidates = result.questions;
    if (candidates.filter(q => !usedQuestionIds.has(q.id)).length < amount) {
      const supplement = await fetchQuestions(config.categoryId, amount);
      if (supplement.ok) candidates = [...candidates, ...supplement.questions];
    }
    const pool = [...new Map(candidates.map(q => [q.id, q])).values()];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const recency = new Map([...usedQuestionIds].map((id, i) => [id, i]));
    const unused = pool.filter(q => !recency.has(q.id));
    const repeats = pool.filter(q => recency.has(q.id))
      .sort((a, b) => recency.get(a.id) - recency.get(b.id));
    const selected = [...easierFirst(unused), ...easierFirst(repeats)]
      .sort((a, b) => (a.difficulty === 'hard') - (b.difficulty === 'hard'))
      .slice(0, amount);
    if (selected.length === 0) {
      throw new Error('No questions available for this category');
    }
    const enriched = await enrichQuestionsWithImages(selected);
    if (enriched.length > 0 && process.env.GEMINI_API_KEY) {
      await Promise.race([
        warmQuizNarration(enriched.slice(0, 1), { maxRetries: 0 }),
        new Promise(resolve => setTimeout(resolve, 3500)),
      ]).catch(() => {});
    }
    warmQuizNarration(enriched).catch(() => {});
    return {
      config: { ...config, questions: enriched },
      trackIds: enriched.map(q => q.id),
    };
  },
};

export { PHASE_DURATIONS };
export default quiz;
