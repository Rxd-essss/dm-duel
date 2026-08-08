/* Автопроверка планировки по MAPDESIGN.md §7.
   Вставляется в страницу собранной игры и возвращает JSON-отчёт.

   Смысл: «гармонично построенная карта» должна быть проверяемым свойством,
   а не вкусовым впечатлением. Здесь проверяются ровно те правила, которые
   записаны в документе, — канонические высоты, заполненность этажей,
   связность, безопасность респавнов, проходимость и бюджет.

   Использование: поднять tools/serve.js, открыть игру и выполнить
   (function(){var x=new XMLHttpRequest();x.open('GET','/tools/mapcheck.js',false);
    x.send();return eval(x.responseText);})()                                  */
(function () {
  const R = { ok: true, fail: [], warn: [], info: {} };
  const bad = (m, v) => { R.ok = false; R.fail.push(m + (v !== undefined ? ' -> ' + JSON.stringify(v) : '')); };
  const warn = (m, v) => R.warn.push(m + (v !== undefined ? ' -> ' + JSON.stringify(v) : ''));

  const need = ['POSTS', 'BOXES', 'SPAWNS_BLU', 'SPAWNS_RED', 'CFG', 'terrainH', 'losClear', 'scene'];
  for (const n of need) {
    if (!new Function('return typeof ' + n + ' !== "undefined"')()) { bad('нет ' + n); return JSON.stringify(R); }
  }

  /* ---------- §7.1 канонические высоты ---------- */
  const LV = [null, CFG.floor1, CFG.floor2, CFG.floor3];
  const offLevel = [];
  for (const p of POSTS) {
    if (!p.level) continue;                       // этаж 0 — по рельефу
    const want = LV[p.level];
    if (want === undefined) { offLevel.push({ name: p.name, level: p.level, y: +p.y.toFixed(1), why: 'неизвестный этаж' }); continue; }
    if (Math.abs(p.y - want) > CFG.floorTol) offLevel.push({ name: p.name, level: p.level, y: +p.y.toFixed(1), want });
  }
  R.info.позицийВсего = POSTS.length;
  if (offLevel.length) bad('§7.1 позиции вне канонических высот: ' + offLevel.length, offLevel.slice(0, 8));

  /* ---------- §7.2 заполненность этажей ---------- */
  const byLv = { 0: [], 1: [], 2: [], 3: [] };
  for (const p of POSTS) (byLv[p.level | 0] || (byLv[p.level | 0] = [])).push(p);
  R.info.поЭтажам = { 0: (byLv[0] || []).length, 1: (byLv[1] || []).length, 2: (byLv[2] || []).length };
  for (const lv of [0, 1, 2, 3]) {
    const a = byLv[lv] || [];
    if (a.length < 12) bad('§7.2 на этаже ' + lv + ' меньше 12 позиций', a.length);
    const south = a.filter(p => p.z < 0).length, north = a.length - south;
    if (!south || !north) bad('§7.2 этаж ' + lv + ' не покрывает обе половины карты', { юг: south, север: north });
  }

  /* ---------- §7.3 связность ---------- */
  /* Переход вниз ищем по фактической геометрии: рампы и зоны лазания —
     это и есть узаконенные переходы между этажами. */
  const links = [];
  if (typeof RAMPS !== 'undefined') for (const r of RAMPS) links.push({ x: r.x, z: r.z, y0: Math.min(r.y0, r.y1), y1: Math.max(r.y0, r.y1) });
  if (typeof CLIMBS !== 'undefined') for (const c of CLIMBS) links.push({ x: c.x, z: c.z, y0: c.y0, y1: c.y1 });
  R.info.переходов = links.length;
  if (!links.length) { bad('§7.3 не найдено ни одного перехода (RAMPS и CLIMBS пусты)'); }

  const farthest = { 1: 0, 2: 0, 3: 0 };
  const badLink = [];
  for (const lv of [1, 2, 3]) {
    const limit = 22;   // §10.5: с любой точки яруса до спуска не больше 22 м
    for (const p of byLv[lv] || []) {
      let best = 1e9;
      for (const l of links) {
        // переход годится, если он реально пересекает наш этаж по высоте
        if (l.y1 < p.y - 2.5 || l.y0 > p.y + 2.5) continue;
        const d = Math.hypot(l.x - p.x, l.z - p.z);
        if (d < best) best = d;
      }
      if (best > farthest[lv]) farthest[lv] = best;
      if (best > limit) badLink.push({ name: p.name, level: lv, дистанция: +best.toFixed(1), лимит: limit });
    }
  }
  R.info.дальшеВсегоДоПерехода = { ярус1: +farthest[1].toFixed(1), ярус2: +farthest[2].toFixed(1), ярус3: +farthest[3].toFixed(1) };
  if (badLink.length) bad('§7.3 позиции без близкого перехода вниз: ' + badLink.length, badLink.slice(0, 8));

  /* ---------- §7.4 респавны не простреливаются с этажа 2 ----------
     Проверяем не только сами позиции, но и площадку вокруг каждой: стрелок
     редко стоит ровно в точке POST, а в двух метрах в сторону прострел уже
     может открыться. */
  const _a = new THREE.Vector3(), _b = new THREE.Vector3();
  const exposed = [];
  const spawns = SPAWNS_BLU.concat(SPAWNS_RED);
  const RING = [[0, 0], [2.5, 0], [-2.5, 0], [0, 2.5], [0, -2.5], [1.8, 1.8], [-1.8, -1.8], [1.8, -1.8], [-1.8, 1.8]];
  /* Запрет из §5 — «не видит ЧУЖОЙ респавн». Видеть свой со своей же башни
     нормально и даже нужно: иначе защитник не понимает, что происходит у него
     за спиной. Поэтому спавны помечаем стороной и сверяем со стороной позиции
     (север карты — RED, юг — BLU). */
  const marked = SPAWNS_BLU.map(s => ({ s, team: 0 })).concat(SPAWNS_RED.map(s => ({ s, team: 1 })));
  for (const p0 of (byLv[2] || []).concat(byLv[3] || [])) {
   const pTeam = p0.z > 0 ? 1 : 0;
   for (const off of RING) {
    const p = { x: p0.x + off[0], y: p0.y, z: p0.z + off[1], name: p0.name };
    _a.set(p.x, p.y + 1.6, p.z);
    for (const m of marked) {
      if (m.team === pTeam) continue;                 // свой респавн видеть можно
      const s = m.s;
      _b.set(s.x, (s.y !== undefined ? s.y : terrainH(s.x, s.z)) + 1.1, s.z);
      if (_a.distanceTo(_b) > 200) continue;
      if (losClear(_a, _b)) {
        exposed.push({ позиция: p.name, смещение: off, чужойСпавн: [Math.round(s.x), Math.round(s.z)] });
        break;
      }
    }
   }
  }
  if (exposed.length) bad('§7.4 респавны простреливаются с верхних ярусов: ' + exposed.length, exposed.slice(0, 6));

  /* ---------- над позицией должно быть место встать ----------
     Позиция внутри стога или обломка выглядит рабочей в списке, но бот в ней
     не помещается: скрипт этого раньше не ловил. */
  const cramped = [];
  for (const p of POSTS) {
    let head = 1e9;
    for (const b of BOXES) {
      if (Math.abs(b.lx(p.x, p.z)) >= b.hx + CFG.radius * 0.5) continue;
      if (Math.abs(b.lz(p.x, p.z)) >= b.hz + CFG.radius * 0.5) continue;
      if (b.bot >= p.y + 0.1 && b.bot < head) head = b.bot;
      if (b.top > p.y + 0.1 && b.bot < p.y + 0.1) { head = p.y; break; }   // позиция ВНУТРИ коробки
    }
    const free = head - p.y;
    if (free < CFG.height - 0.05) cramped.push({ name: p.name, свободно: +Math.max(0, free).toFixed(2) });
  }
  if (cramped.length) bad('позиции без полного роста над ними: ' + cramped.length, cramped.slice(0, 6));

  /* ---------- §7.5 проходимость ---------- */
  function support(x, z, yMax) {
    let best = terrainH(x, z);
    if (typeof rampAt === 'function') { const r = rampAt(x, z, yMax); if (r !== null && r !== undefined && r > best && r <= yMax + 0.02) best = r; }
    for (const b of BOXES) {
      if (Math.abs(b.lx(x, z)) >= b.hx || Math.abs(b.lz(x, z)) >= b.hz) continue;
      if (b.top <= yMax + 0.02 && b.top > best) best = b.top;
    }
    return best;
  }
  /* Сетку гоняем НЕСКОЛЬКИМИ ФАЗАМИ. Одна фаза врёт: узлы просто не попадают в
     проблемные створы, и проверка показывает ноль там, где игрок застревает.
     Шаг мельче и три сдвига — застревание обязано быть нулевым при любой фазе. */
  const save = { x: player.pos.x, y: player.pos.y, z: player.pos.z };
  let tries = 0, jams = 0; const jamAt = [];
  const H = CFG.half - 6;
  const STEP = 5.5;
  for (const ph of [0, STEP / 3, STEP * 2 / 3]) {
  for (let gx = -H + ph; gx <= H; gx += STEP) {
    for (let gz = -H + ph; gz <= H; gz += STEP) {
      for (let d = 0; d < 8; d++) {
        const ang = d * Math.PI / 4, dx = Math.cos(ang), dz = Math.sin(ang);
        const sy = support(gx, gz, 1e4);
        player.pos.set(gx, sy, gz); player.vel.set(0, 0, 0);
        player.grounded = true; player.h = CFG.height; player.crouching = false;
        player.noGrav = false; player.climb = null; player.zip = null;
        player.dashT = 0; player.slideT = 0; player.mantleT = 0; player.airJumps = 0;
        let stall = 0;
        for (let f = 0; f < 30; f++) {
          player.vel.x = dx * CFG.sprint; player.vel.z = dz * CFG.sprint;
          const px = player.pos.x, pz = player.pos.z;
          moveHoriz(player, 0.016); moveVert(player, 0.016);
          if (Math.hypot(player.pos.x - px, player.pos.z - pz) < CFG.sprint * 0.016 * 0.25) stall++;
        }
        tries++;
        if (stall >= 18) {
          /* Уступ впереди меряем ТЕМ ЖЕ раздутым следом, каким его видит
             moveHoriz: он расширяет коробку на CFG.radius, поэтому точечная
             проба под ногами пропускает угол плиты, который и держит игрока. */
          let rise = -1;
          for (const off of [0, -0.35, 0.35]) {
            const ox = -dz * off, oz = dx * off;
            const fx = player.pos.x + dx * (CFG.radius + 0.15) + ox;
            const fz = player.pos.z + dz * (CFG.radius + 0.15) + oz;
            const r = support(fx, fz, player.pos.y + CFG.height) - player.pos.y;
            if (r > rise) rise = r;
          }
          /* Однозначный критерий вместо «впереди что-то низкое». Проба опоры
             легко попадает на соседний бортик, тогда как держит игрока стена
             рядом — так рождались призрачные находки. Поэтому повторяем тот же
             забег со старта, поднятого ровно на высоту шага: если после этого
             путь открылся, физика действительно не отработала уступ; если нет,
             упор правильный и это стена. */
          if (rise > 0.04 && rise <= CFG.step + 0.02) {
            const ax = player.pos.x, az = player.pos.z;
            player.pos.set(gx, sy + CFG.step + 0.04, gz); player.vel.set(0, 0, 0);
            player.grounded = true; player.noGrav = false; player.climb = null;
            player.zip = null; player.dashT = 0; player.slideT = 0; player.mantleT = 0;
            let s2 = 0;
            for (let f = 0; f < 30; f++) {
              player.vel.x = dx * CFG.sprint; player.vel.z = dz * CFG.sprint;
              const px = player.pos.x, pz = player.pos.z;
              moveHoriz(player, 0.016); moveVert(player, 0.016);
              if (Math.hypot(player.pos.x - px, player.pos.z - pz) < CFG.sprint * 0.016 * 0.25) s2++;
            }
            const advLift = Math.hypot(player.pos.x - gx, player.pos.z - gz);
            const advBase = Math.hypot(ax - gx, az - gz);
            if (s2 < 18 && advLift > advBase + 1.0) {
              jams++;
              if (jamAt.length < 10) jamAt.push({ x: +gx.toFixed(1), z: +gz.toFixed(1), уступ: +rise.toFixed(2), фаза: +ph.toFixed(1) });
            }
          }
        }
      }
    }
  }
  }
  player.pos.set(save.x, save.y, save.z); player.vel.set(0, 0, 0);
  R.info.проходимость = { проб: tries, застреваний: jams, фаз: 3, шаг: STEP };
  if (jams) bad('§7.5 застревания на проходимом уступе: ' + jams, jamAt);

  /* ---------- §7.6 бюджет ---------- */
  let meshes = 0, tris = 0;
  scene.traverse(o => {
    if (!o.isMesh) return;
    meshes++;
    const g = o.geometry, p = g && g.attributes && g.attributes.position;
    if (p) tris += (g.index ? g.index.count : p.count) / 3;
  });
  tris = Math.round(tris);
  R.info.бюджет = { мешей: meshes, треугольников: tris };
  if (meshes > 700) bad('§7.6 мешей больше 700', meshes);
  if (tris > 220000) bad('§7.6 треугольников больше 220 тыс.', tris);

  /* ---------- §10.2 ДИСТАНЦИЯ: ради неё карта и переделывалась ----------
     Снайперская игра держится на том, что до цели далеко и поправку надо брать.
     Если бой идёт на 30 м, падение пули неразличимо и вся баллистика — украшение. */
  const bs = SPAWNS_BLU[0], rs = SPAWNS_RED[0];
  const baseToBase = Math.hypot(bs.x - rs.x, bs.z - rs.z);
  R.info.торецДоТорца = +baseToBase.toFixed(0);
  if (baseToBase < 120) bad('§10.3 торец до торца меньше 120 м', +baseToBase.toFixed(0));

  const south = POSTS.filter(p => p.z < 0), north = POSTS.filter(p => p.z > 0);
  const cross = [];
  for (const a of south) for (const b of north) cross.push(Math.hypot(a.x - b.x, a.z - b.z));
  cross.sort((u, v) => u - v);
  const med = cross.length ? cross[cross.length >> 1] : 0;
  R.info.медианаМеждуПоловинами = +med.toFixed(0);
  if (med < 55) bad('§10.3 медиана между позициями половин меньше 55 м', +med.toFixed(0));

  /* Чистые линии огня: сколько пар позиций реально видят друг друга далеко. */
  let longLines = 0, longest = 0;
  for (const a of south) for (const b of north) {
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    if (d < 100) continue;
    _a.set(a.x, a.y + 1.6, a.z); _b.set(b.x, b.y + 1.6, b.z);
    if (losClear(_a, _b)) { longLines++; if (d > longest) longest = d; }
  }
  R.info.чистыхЛинийОт100 = longLines;
  R.info.самаяДлиннаяЛиния = +longest.toFixed(0);
  if (longLines < 8) bad('§10.3 чистых линий огня ≥100 м меньше восьми', longLines);

  /* Падение пули на предельной линии — честной интеграцией той же баллистики,
     что и в бою. Если падение меньше 0.7 м, поправку брать не нужно. */
  if (longest > 0) {
    const am = AMMO[0];
    let vx = am.v, y = 0, t = 0, x = 0;
    let vy = 0;
    const g = CFG.bulletG * am.gMul, h = 1 / 240;
    while (x < longest && t < 6) {
      vy -= g * h;
      const sp = Math.sqrt(vx * vx + vy * vy);
      const k = Math.max(0.2, 1 - am.drag * h);
      vx *= k; vy *= k;
      x += vx * h; y += vy * h; t += h;
    }
    R.info.падениеПули = { дистанция: +longest.toFixed(0), метров: +(-y).toFixed(2), времяПолёта: +t.toFixed(2) };
    if (-y < 0.7) bad('§10.3 падение пули на предельной линии меньше 0.7 м', +(-y).toFixed(2));
  }

  /* ---------- §10.3 ОТКРЫТОСТЬ ----------
     Доля свободных длинных линий между случайными открытыми точками поля.
     Это и есть численное выражение «долина, а не свалка». */
  let pairs = 0, clear = 0;
  let sd = 20250729;
  const rnd2 = () => { sd = (Math.imul(sd, 1664525) + 1013904223) >>> 0; return sd / 4294967296; };
  for (let i = 0; i < 400; i++) {
    const ax = (rnd2() * 2 - 1) * 70, az = (rnd2() * 2 - 1) * 70;
    const bx = (rnd2() * 2 - 1) * 70, bz = (rnd2() * 2 - 1) * 70;
    if (Math.hypot(ax - bx, az - bz) < 100) continue;
    pairs++;
    _a.set(ax, terrainH(ax, az) + 1.6, az);
    _b.set(bx, terrainH(bx, bz) + 1.6, bz);
    if (losClear(_a, _b)) clear++;
  }
  const openPct = pairs ? clear / pairs * 100 : 0;
  R.info.открытость = { парПроверено: pairs, 'чистыхЛинийОт100м%': +openPct.toFixed(1) };
  if (openPct < 8) warn('§10.3 свободных длинных линий мало даже для зала', +openPct.toFixed(1));

  /* ---------- БАРЬЕРЫ БАЗ: наружу можно, внутрь чужому нельзя ----------
     Барьер обязан быть односторонним ПО КОМАНДЕ, а не клеткой. Хозяин базы
     выходит с неё свободно — иначе противник заперт и боя не будет вовсе
     (ровно эта беда у нас уже случалась с ботами, не выходившими с базы).
     Проверяем оба направления настоящей физикой, а не намерением. */
  if (typeof BARRIERS !== 'undefined' && BARRIERS.length) {
    const probe = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), h: CFG.height,
                    grounded: true, stepUp: 0, landV: 0, noGrav: false, team: 0 };
    /* Шагаем сущностью нужной команды из точки в точку и смотрим, докуда дошли.

       Три вещи, без которых заливка МОЛЧА показывает то, чего не проверяла:

       1) Шаг обязан быть длиннее клетки. При 16 кадрах ходьбы боец проходит
          5.6 * 0.016 * 16 = 1.43 м, а клетка сетки 3 м: округление возвращает
          ту же клетку, отсев `< G*0.6` съедает остаток, и заливка умирает на
          первом же узле (ровно один узел, оба вердикта пустые). 44 кадра дают
          3.94 м — клетку боец покидает гарантированно.

       2) Ярус надо нести с собой. `support(x, z, 1e4)` отдаёт САМУЮ ВЕРХНЮЮ
          опору в точке, то есть кровлю зала: заливка уезжала гулять по крыше
          и про базу под ней не узнавала ничего. Потолок поиска — свой ярус
          плюс шаг, а высота узла кладётся в ключ: зал четырёхъярусный, и
          «та же клетка на другом ярусе» — это другое место.
          Параметр sy для этого и заводился, но в теле не использовался.

       3) Точка появления теперь не одна на базу и не только на полу, поэтому
          «чужой дошёл» проверяем по ВСЕМ точкам стороны и по всем ярусам. */
    const G = 3, FR = 44;
    const kOf = (x, z, y) => x + ',' + z + ',' + Math.round(y / 3);
    const reach = (team, sx, sz, sy, limit) => {
      const seen = Object.create(null);
      const q = [[Math.round(sx / G) * G, Math.round(sz / G) * G, sy]];
      seen[kOf(q[0][0], q[0][1], sy)] = 1;
      let best = 1e9, guard = 0;
      while (q.length && guard++ < limit) {
        const c = q.shift();
        const d0 = Math.hypot(c[0], c[1]);
        if (d0 < best) best = d0;
        const cy = support(c[0], c[1], c[2] + CFG.step);
        for (let d = 0; d < 8; d++) {
          const a = d * Math.PI / 4, dx = Math.cos(a), dz = Math.sin(a);
          probe.pos.set(c[0], cy, c[1]); probe.vel.set(0, 0, 0);
          probe.grounded = true; probe.noGrav = false; probe.team = team;
          probe.h = CFG.height;
          for (let f = 0; f < FR; f++) {
            probe.vel.x = dx * CFG.walk; probe.vel.z = dz * CFG.walk;
            moveHoriz(probe, 0.016); moveVert(probe, 0.016);
          }
          if (!probe.grounded) continue;              // в полёте — это не узел
          const nx = Math.round(probe.pos.x / G) * G, nz = Math.round(probe.pos.z / G) * G;
          const k = kOf(nx, nz, probe.pos.y);
          if (seen[k] || Math.hypot(nx - c[0], nz - c[1]) < G * 0.6) continue;
          seen[k] = 1; q.push([nx, nz, probe.pos.y]);
        }
      }
      return { seen, nearestToCenter: best, узлов: Object.keys(seen).length };
    };
    const seenAt = (seen, p) => {
      const x = Math.round(p.x / G) * G, z = Math.round(p.z / G) * G;
      for (let t = -1; t < 9; t++) if (seen[x + ',' + z + ',' + t]) return true;
      return false;
    };
    const sides = [{ t: 0, sp: SPAWNS_BLU }, { t: 1, sp: SPAWNS_RED }];
    R.info.барьеры = { штук: BARRIERS.length };
    for (const s of sides) {
      if (!s.sp.length) continue;
      const nm = s.t ? 'RED' : 'BLU';
      const p0 = s.sp[0];
      const y0 = (p0.y !== undefined) ? p0.y : terrainH(p0.x, p0.z);
      // 1. ХОЗЯИН обязан выйти со своей базы к центру карты
      const own = reach(s.t, p0.x, p0.z, y0, 2400);
      R.info.барьеры['свой' + nm + 'ДоцентраМ'] = +own.nearestToCenter.toFixed(0);
      R.info.барьеры['свой' + nm + 'Узлов'] = own.узлов;
      if (own.узлов < 50)
        bad('заливка своей команды ' + nm + ' не пошла: узлов ' + own.узлов);
      else if (own.nearestToCenter > 30)
        bad('барьер запер СВОЮ команду ' + nm + ' на базе: ближе ' +
            own.nearestToCenter.toFixed(0) + ' м к центру не вышли');
      // 2. ЧУЖОЙ не должен попасть внутрь: идём с пола центра и не должны
      //    достать ни одной точки появления хозяина ни на одном ярусе
      const foe = reach(s.t ^ 1, 0, 0, terrainH(0, 0), 3200);
      let got = 0;
      for (const q of s.sp) if (seenAt(foe.seen, q)) got++;
      R.info.барьеры['чужойУзлов' + nm] = foe.узлов;
      R.info.барьеры['чужойДостигСпавнов' + nm] = got;
      if (foe.узлов < 50) bad('заливка чужой команды к ' + nm + ' не пошла: узлов ' + foe.узлов);
      if (got) bad('барьер не держит чужого: с центра дошли до ' + got + ' точек появления ' + nm);
    }
  }

  /* ---------- сводка по геометрии переходов ---------- */
  R.info.геометрия = {
    рамп: (typeof RAMPS !== 'undefined') ? RAMPS.length : 'нет',
    лестниц: (typeof CLIMBS !== 'undefined') ? CLIMBS.length : 'нет',
    тросов: (typeof ZIPS !== 'undefined') ? ZIPS.length : 'нет',
    мостиков: (typeof BRIDGES !== 'undefined') ? BRIDGES.length : 'нет',
    коллизий: BOXES.length
  };
  if (typeof ZIPS !== 'undefined' && ZIPS.length < 4) warn('§4 тросов меньше четырёх', ZIPS.length);

  return JSON.stringify(R);
})()
