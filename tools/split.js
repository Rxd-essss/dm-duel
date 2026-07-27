/* Одноразовый скрипт: механически режет dm_duel_v2.html на модули src/.
   Границы подобраны по смыслу разделов, диапазоны строк непрерывны,
   поэтому сборка обязана дать байт-в-байт исходный файл. */
const fs = require('fs');
const path = require('path');

/* ВНИМАНИЕ: скрипт ПЕРЕЗАПИСЫВАЕТ весь src/ содержимым старой версии v2 и
   уничтожит всю последующую работу. Он оставлен только как документация того,
   как проект был разрезан. Запуск требует явного согласия. */
if (process.argv[2] !== '--yes-overwrite-src') {
  console.error('ОТКАЗ: этот скрипт перезапишет весь src/ версией v2.');
  console.error('Если это действительно нужно: node tools/split.js --yes-overwrite-src');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const lines = fs.readFileSync(path.join(ROOT, 'dm_duel_v2.html'), 'utf8').split('\n');

// [имя, первая строка, последняя строка] — 1-based, включительно
const PARTS = [
  ['00_head.html',   1,    172],
  ['01_body.html',   173,  331],
  ['10_core.js',     332,  491],
  ['20_render.js',   492,  578],
  ['25_terrain.js',  579,  680],
  ['30_physics.js',  681,  824],
  ['40_props.js',    825,  1034],
  ['45_map.js',      1035, 1152],
  ['50_models.js',   1153, 1272],
  ['55_fx.js',       1273, 1401],
  ['60_weapon.js',   1402, 1664],
  ['70_ai.js',       1665, 1989],
  ['75_combat.js',   1990, 2050],
  ['80_hud.js',      2051, 2152],
  ['85_player.js',   2153, 2358],
  ['90_game.js',     2359, 2539],
  ['99_tail.html',   2540, lines.length]
];

fs.mkdirSync(SRC, { recursive: true });
let cursor = 1;
for (const [name, a, b] of PARTS) {
  if (a !== cursor) throw new Error(`разрыв перед ${name}: ожидалась строка ${cursor}, получена ${a}`);
  fs.writeFileSync(path.join(SRC, name), lines.slice(a - 1, b).join('\n'), 'utf8');
  console.log(`${name.padEnd(16)} строки ${a}..${b}  (${b - a + 1})`);
  cursor = b + 1;
}
if (cursor !== lines.length + 1) throw new Error(`хвост не покрыт: ${cursor} != ${lines.length + 1}`);
console.log('готово');
