import rules, { configureRules } from './rules.js';
import { chooseSjuanAction, configureBot } from './bot.js';

export default function defineGame(sdk) {
  if (sdk?.cards) configureRules(sdk.cards);
  if (sdk?.bots) configureBot(sdk.bots);
  return {
    ...rules,
    id: 'card-sjuan',
    aliases: ['sjuan'],
    category: 'card',
    order: 5,
    label: 'Sjuan',
    icon: '7️⃣',
    theme: { color: '#fb923c' },
    min: 2,
    max: 8,
    blurb: '2–8 players • Build from the sevens, be first out!',
    soloBlurb: 'Solo vs AI • Build from the sevens, beat the bots!',
    music: true,
    ai: { default: 2, max: 4, choose: chooseSjuanAction },
  };
}
