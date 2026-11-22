import rules from './rules.js';

export default function defineGame() {
  return {
    ...rules,
    id: 'sensor-lab',
    aliases: ['dev-sensor-lab'],
    category: 'dev',
    status: 'dev',
    order: 99,
    label: 'Sensor Lab',
    icon: '📱',
    theme: { color: '#22d3ee' },
    hasUi: true,
    hidden: true, // Development game: toggle on/off in /admin -> Lobby Visibility
    min: 1,
    max: 8,
    blurb: 'Dev tool • Live 3D phone gyro, accel & device telemetry',
    music: false,
    roundCountdown: false,
  };
}
