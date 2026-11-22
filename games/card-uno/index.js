import rules, { configureRules } from './rules.js';

export default function defineGame(sdk) {
  if (sdk?.cards) configureRules(sdk.cards);
  return {
    ...rules,
    id: 'card-uno',
    aliases: ['uno'],
    category: 'card',
    hidden: true, // no screens yet
    label: 'Uno',
    icon: '🎴',
    min: 2,
    max: 8,
  };
}
