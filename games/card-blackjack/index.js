import rules, { configureRules } from './rules.js';

export default function defineGame(sdk) {
  if (sdk?.cards) configureRules(sdk.cards);
  return {
    ...rules,
    id: 'card-blackjack',
    aliases: ['blackjack'],
    category: 'card',
    order: 6,
    label: 'Blackjack',
    icon: '🃏',
    theme: { color: '#34d399' },
    min: 1,
    max: 8,
    blurb: '1–8 players • Beat the dealer to 21 without busting!',
    soloBlurb: 'Solo vs Dealer • Bet chips, hit, stand or double down!',
    music: true,
    roundCountdown: false,
    privateKeys: ['mySeat', 'myCanDouble', 'myCanSplit'],
  };
}
