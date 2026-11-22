import rules, { configureRules } from './rules.js';

// Copy this folder to games/card-<your-id>/ and set id to that same name.
export default function defineGame(sdk) {
  if (sdk?.cards) configureRules(sdk.cards);
  return {
    ...rules,
    id: '_template',
    category: 'card',
    label: 'Match Up',
    icon: '🃏',
    min: 2,
    max: 6,
    blurb: '2–6 players • Match the pile, be first out!',
    music: true,
  };
}
