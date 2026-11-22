import rules, { PHASE_DURATIONS, configureRules } from './rules.js';

export default function defineGame(sdk) {
  if (sdk?.content) configureRules(sdk.content);
  return {
    ...rules,
    id: 'quiz',
    aliases: ['quiz-trivia'],
    category: 'quiz',
    categoryVote: true,
    potEligible: true,
    order: 1,
    label: 'Quiz',
    title: 'Quiz Time',
    icon: '🎯',
    theme: { color: '#fb7185' },
    min: 1,
    max: 20,
    blurb: 'Trivia challenge • Pick a topic & race the clock',
    music: true,
    phases: PHASE_DURATIONS,
    privateKeys: ['hasAnswered', 'selectedAnswer', 'eliminatedAnswers'],
  };
}
