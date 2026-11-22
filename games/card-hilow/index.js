import rules, { configureRules } from './rules.js';

export default function defineGame(sdk) {
  if (sdk?.cards) configureRules(sdk.cards);
  return {
    ...rules,
    id: 'card-hilow',
    aliases: ['hilow'],
    category: 'card',
    hidden: true, // no screens yet
    label: 'Högt/Lågt',
    icon: '🃏',
    min: 2,
    max: 8,
    privateKeys: ['isActive'],
  };
}
