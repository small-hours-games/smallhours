import rules, { configureRules } from './rules.js';
import { chooseGinAction } from './bot.js';

export default function defineGame(sdk) {
  if (sdk?.cards) configureRules(sdk.cards);
  return {
    ...rules,
    id: 'card-gin-rummy',
    aliases: ['gin-rummy'],
    category: 'card',
    roundUnit: 'Hand',
    order: 4,
    label: 'Gin Rummy',
    icon: '♠️',
    theme: { color: '#fb7185' },
    min: 2,
    max: 2,
    blurb: '2 players • Build sets & runs, knock low!',
    soloBlurb: 'Solo vs AI • Knock before Nova-7 does!',
    music: true,
    ai: { default: 1, max: 1, choose: chooseGinAction },
    privateKeys: ['canKnock', 'lastDrawnCardId'],
  };
}
