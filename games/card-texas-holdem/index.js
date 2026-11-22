import rules, { configureRules } from './rules.js';
import { chooseHoldemAction, configureBot } from './bot.js';

export default function defineGame(sdk) {
  if (sdk?.cards) configureRules(sdk.cards);
  if (sdk?.bots) configureBot(sdk.bots);
  return {
    ...rules,
    id: 'card-texas-holdem',
    aliases: ['texas-holdem'],
    category: 'card',
    order: 7,
    label: "Texas Hold'em",
    icon: '🤠',
    theme: { color: '#2dd4bf' },
    min: 2,
    max: 8,
    blurb: '2–8 players • No-Limit Hold’em on the TV, hole cards on your phone!',
    soloBlurb: 'Solo vs AI • Play No-Limit Hold’em against the bots!',
    music: true,
    roundCountdown: false,
    ai: { default: 3, max: 5, choose: chooseHoldemAction },
    privateKeys: ['myHand', 'myToCall', 'myMinRaiseTo', 'myMaxBetTo', 'myCanCheck'],
  };
}
