#!/usr/bin/env node
/* Сборка: склеивает src/* в один самодостаточный HTML.
   Порядок — лексикографический по имени файла (префиксы 00_, 10_, 20_ …),
   поэтому вся игра остаётся в одной области видимости <script>, как и была.

   Дополнительно проверяет синтаксис собранного скрипта (node --check) и
   ищет типовые ошибки интеграции: повторные объявления const/let/class/function
   верхнего уровня между модулями.

   Использование:  node build.js [выходной_файл]            */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, process.argv[2] || 'dm_duel_v3.html');

const files = fs.readdirSync(SRC)
  .filter(f => /\.(js|html)$/.test(f) && !f.startsWith('_'))
  .sort();
if (!files.length) { console.error('src/ пуст'); process.exit(1); }

const parts = files.map(f => ({ f, body: fs.readFileSync(path.join(SRC, f), 'utf8') }));
const out = parts.map(p => p.body).join('\n');
fs.writeFileSync(OUT, out, 'utf8');

const kb = (Buffer.byteLength(out, 'utf8') / 1024).toFixed(1);
console.log(`собрано ${files.length} модулей -> ${path.basename(OUT)}  (${out.split('\n').length} строк, ${kb} КБ)`);
for (const p of parts) console.log(`  ${p.f.padEnd(20)} ${String(p.body.split('\n').length).padStart(5)} строк`);

/* ---- проверка синтаксиса собранного скрипта ---- */
const m = out.match(/<script>\n([\s\S]*?)\n<\/script>/);
if (!m) { console.error('\nНЕ НАЙДЕН инлайновый <script> — проверка синтаксиса пропущена'); process.exit(1); }
const js = m[1];
const tmp = path.join(os.tmpdir(), 'dmduel_check_' + process.pid + '.js');
fs.writeFileSync(tmp, js, 'utf8');
let ok = true;
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  console.log('\n[синтаксис] OK');
} catch (e) {
  ok = false;
  const err = (e.stderr || Buffer.from('')).toString().replace(new RegExp(tmp.replace(/\\/g, '\\\\'), 'g'), '<собранный скрипт>');
  console.error('\n[синтаксис] ОШИБКА\n' + err);
  // подсказать, в каком модуле строка
  const lm = err.match(/<собранный скрипт>:(\d+)/);
  if (lm) {
    const target = +lm[1];
    const jsStart = out.slice(0, out.indexOf('<script>\n')).split('\n').length; // строк до <script>
    const abs = jsStart + target;
    let acc = 0;
    for (const p of parts) {
      const n = p.body.split('\n').length;
      if (abs <= acc + n) { console.error(`  -> модуль ${p.f}, строка ~${abs - acc}`); break; }
      acc += n + 1;
    }
  }
}
fs.unlinkSync(tmp);

/* ---- поиск дублирующихся объявлений верхнего уровня ---- */
const DECL = /^(?:const|let|class|function)\s+([A-Za-z_$][\w$]*)/;
const seen = new Map();
const dups = [];
for (const p of parts) {
  if (!p.f.endsWith('.js')) continue;
  const names = new Set();
  p.body.split('\n').forEach(line => {
    const d = line.match(DECL);
    if (d) names.add(d[1]);
  });
  for (const n of names) {
    if (seen.has(n) && seen.get(n) !== p.f) dups.push(`${n}: ${seen.get(n)} и ${p.f}`);
    else seen.set(n, p.f);
  }
}
if (dups.length) {
  ok = false;
  console.error('\n[конфликт имён] одно и то же объявлено в разных модулях:');
  dups.forEach(d => console.error('  ' + d));
} else console.log('[имена] конфликтов верхнего уровня нет');

process.exit(ok ? 0 : 1);
