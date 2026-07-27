/* Доводка границ: updateWeapon/updateRangefinder логически относятся к оружию,
   но после механической нарезки попали в 85_player.js. Переносим их в
   отдельный модуль 87_weapon_update.js, чтобы владение файлами не пересекалось. */
const fs = require('fs');
const path = require('path');

/* Разовая правка границ, уже применённая. Повторный запуск искалечит
   85_player.js (он давно не тот, что был при нарезке). Оставлен как документация. */
if (process.argv[2] !== '--yes-overwrite-src') {
  console.error('ОТКАЗ: разовый скрипт, уже применён. Повторный запуск испортит 85_player.js.');
  process.exit(1);
}

const SRC = path.join(__dirname, '..', 'src');

const p = path.join(SRC, '85_player.js');
const L = fs.readFileSync(p, 'utf8').split('\n');

// локальные 1-based индексы внутри 85_player.js
const keep = L.slice(0, 88)                    // accelerate + updatePlayer + swayT
  .concat(L.slice(166, 190));                  // updateCamera
const moved = ['/* ---------------- ОБНОВЛЕНИЕ ОРУЖИЯ И ДАЛЬНОМЕР ---------------- */']
  .concat(L.slice(88, 166))                    // updateWeapon
  .concat(L.slice(190, 205))                   // updateRangefinder
  .concat(['']);

const sanity = [
  [keep.join('\n'), 'function accelerate', 'function updatePlayer', 'function updateCamera', 'let swayT'],
  [moved.join('\n'), 'function updateWeapon', 'function updateRangefinder']
];
for (const [txt, ...needles] of sanity)
  for (const n of needles)
    if (!txt.includes(n)) throw new Error('потеряно: ' + n);
if (keep.join('\n').includes('function updateWeapon')) throw new Error('updateWeapon остался в 85');
if (moved.join('\n').includes('function updateCamera')) throw new Error('updateCamera уехал в 87');

fs.writeFileSync(p, keep.join('\n'), 'utf8');
fs.writeFileSync(path.join(SRC, '87_weapon_update.js'), moved.join('\n'), 'utf8');
console.log('85_player.js ->', keep.length, 'строк; 87_weapon_update.js ->', moved.length, 'строк');
