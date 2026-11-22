import rules from './rules.js';

export default function defineGame() {
  return {
    ...rules,
    id: 'tilt-ball',
    aliases: ['arcade-tilt-ball'],
    category: 'arcade',
    order: 8,
    label: 'Tilt-Ball Arena',
    icon: '🔮',
    min: 2,
    max: 8,
    blurb: '2–8 players • Tilt your phone to knock rivals off the shrinking arena!',
    soloBlurb: 'Solo vs AI • Knock the bots off the shrinking arena!',
    music: true,
    roundCountdown: false,
    // TV physics steers bot_N marbles at 60 FPS; engine bot hook stays idle.
    ai: { default: 3, max: 5, choose: () => null },
  };
}
Object.assign(defineGame, defineGame());
