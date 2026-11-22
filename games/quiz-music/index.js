import rules, { PHASE_DURATIONS, configureRules } from './rules.js';

export default function defineGame(sdk) {
  if (sdk?.content) configureRules(sdk.content);
  return {
    ...rules,
    id: 'music-quiz',
    aliases: ['quiz-music'],
    category: 'quiz',
    potEligible: true,
    order: 2,
    label: 'Music Quiz',
    icon: '🎵',
    theme: { color: '#a78bfa' },
    min: 1,
    max: 20,
    blurb: 'Audio trivia • Hear the track & guess the hit',
    phases: PHASE_DURATIONS,
    privateKeys: ['hasAnswered', 'selectedAnswer', 'eliminatedAnswers'],
  };
}
