/* Приёмочный прогон в браузере. Вставляется в страницу собранной игры и
   возвращает JSON-отчёт. Ничего не чинит — только проверяет.

   Использование: скопировать тело в консоль страницы / выполнить через
   javascript_tool и прочитать результат. */
(function () {
  const R = { ok: true, errors: [], warn: [], info: {} };
  const bad = m => { R.ok = false; R.errors.push(m); };
  const warn = m => R.warn.push(m);

  /* 1. Публичный API из контракта обязан существовать */
  const NEED = {
    'ядро': ['CFG', 'PAL', 'AMMO', 'DIFFS', 'SFX', 'splashDamage', 'clamp', 'damp', 'V', '$', 'keys'],
    'рендер': ['renderer', 'scene', 'camera', 'world', 'sun', 'toon', 'basic', 'setShadows', 'LIGHTS'],
    'текстуры': ['TEX', 'toonT'],
    'рельеф': ['terrainH', 'terrainN', 'buildTerrain', 'buildSky', 'FLATS'],
    'физика': ['BOXES', 'Box', 'rayBoxes', 'rayTerrain', 'losClear', 'moveHoriz', 'moveVert',
               'CLIMBS', 'ZIPS', 'addClimb', 'climbAt', 'addZip', 'zipNear', 'mantleFind', 'climbStep'],
    'карта': ['POSTS', 'SPAWNS_RED', 'SPAWNS_BLU', 'PICKUPS', 'buildMap', 'BRIDGES', 'updateMapDynamics', 'gh'],
    'модели': ['mBox', 'mCyl', 'mkRifle', 'mkSniper'],
    'эффекты': ['FX', 'explode', 'PMAT'],
    'оружие': ['player', 'wpn', 'wind', 'game', 'A', 'tryFire', 'startReload', 'switchAmmo',
               'bullets', 'spawnBullet', 'updateBullets', 'segPlayer', 'updateWeapon', 'updateRangefinder'],
    'ии': ['enemies', 'Enemy', 'SQUAD', 'angDiff'],
    'бой': ['hurtPlayer', 'killPlayer', 'respawnPlayer', 'updatePickups', 'burnPlayer', 'tickPlayerBurn'],
    'hud': ['updateHP', 'updateAmmoHUD', 'updateScore', 'addFeed', 'toast', 'updateReticle',
            'setDashHUD', 'setBurnHUD', 'setStatus', 'clearStatus'],
    'игрок': ['updatePlayer', 'updateCamera', 'accelerate'],
    'цикл': ['startGame', 'pauseGame', 'resumeGame', 'endGame', 'loop', 'boot', 'initInput']
  };
  // ВАЖНО: const/let/class верхнего уровня классического скрипта живут в
  // лексической записи глобального окружения и НЕ становятся полями window.
  // Поэтому проверяем именно разрешение идентификатора, а не window[n].
  const has = n => { try { return new Function('return typeof ' + n + ' !== "undefined"')(); } catch (e) { return false; } };
  for (const grp in NEED)
    for (const n of NEED[grp])
      if (!has(n)) bad(`нет ${grp}/${n}`);

  if (!R.ok) return JSON.stringify(R);

  /* 2. Состояние мира после boot() */
  R.info.boxes = BOXES.length;
  R.info.posts = POSTS.length;
  R.info.climbs = CLIMBS.length;
  R.info.zips = ZIPS.length;
  R.info.bridges = BRIDGES.length;
  R.info.pickups = PICKUPS.length;
  R.info.sceneChildren = scene.children.length;
  let meshes = 0, lights = 0;
  scene.traverse(o => { if (o.isMesh) meshes++; if (o.isLight) lights++; });
  R.info.meshes = meshes;
  R.info.lights = lights;
  if (lights > 16) warn(`многовато источников света в сцене: ${lights}`);
  if (CLIMBS.length === 0) bad('нет ни одной зоны лазания — паркур не зарегистрирован на карте');
  if (ZIPS.length === 0) warn('нет ни одного троса');
  if (BRIDGES.length === 0) warn('нет ни одного навесного мостика');

  /* POSTS обязаны нести новые поля для ИИ */
  const p0 = POSTS[0] || {};
  ['level', 'cover', 'sector'].forEach(f => {
    if (p0[f] === undefined) bad(`POSTS не содержит поля ${f} (нужно ИИ)`);
  });
  const levels = {};
  POSTS.forEach(p => { levels[p.level] = (levels[p.level] || 0) + 1; });
  R.info.postsByLevel = levels;
  if (Object.keys(levels).length < 2) warn('позиции ботов только на одном ярусе');

  /* 3. Боеприпасы: откаты и крит */
  R.info.ammo = AMMO.map(a => ({ id: a.id, cd: a.cd, crit: a.crit }));
  if (AMMO[1].crit !== false) bad('фугасный обязан быть без крита');
  if (AMMO[2].cd !== 5) bad('откат зажигательного должен быть 5 с');
  /* спад фугасного урона от эпицентра */
  const a1 = AMMO[1];
  const dNear = splashDamage(0, a1.splashR, a1.splashMax, a1.splashFall, false);
  const dMid = splashDamage(a1.splashR * 0.5, a1.splashR, a1.splashMax, a1.splashFall, false);
  const dFar = splashDamage(a1.splashR * 0.95, a1.splashR, a1.splashMax, a1.splashFall, false);
  R.info.splash = { near: +dNear.toFixed(1), mid: +dMid.toFixed(1), far: +dFar.toFixed(1) };
  if (!(dNear > dMid && dMid > dFar)) bad('фугасный урон не падает с расстоянием');

  /* 4. Запуск боя */
  const errs = [];
  const oldErr = window.onerror;
  window.onerror = (m, s, l) => { errs.push(m + ' @' + l); return false; };
  try {
    startGame();
  } catch (e) { bad('startGame упал: ' + e.message); }
  R.info.state = game.state;
  R.info.enemies = enemies.length;
  if (wpn.cd.join(',') !== '0,0,0') bad('startGame не сбросил откаты');
  if (player.burn !== 0) bad('startGame не сбросил горение');

  /* 5. Прогон кадров: цикл не должен падать.
     loop() первым делом сам планирует requestAnimationFrame, поэтому ручной
     прогон надо делать с заглушенным rAF — иначе каждый шаг плодит ещё один
     реальный кадр и браузер уходит в лавину. */
  const rafReal = window.requestAnimationFrame;
  // Рендер в offscreen-таргет: в скрытой вкладке отрисовка в экранный буфер
  // блокируется, а нам нужен именно настоящий loop() со всеми его вызовами.
  const rt = new THREE.WebGLRenderTarget(320, 180);
  const step = (n, t0ms) => {
    window.requestAnimationFrame = () => 0;
    renderer.setRenderTarget(rt);
    let f = 0;
    try { for (let i = 0; i < n; i++) { loop(t0ms + i * 16.7); f++; } }
    catch (e) { bad(`цикл упал на кадре ${f}: ${e.message}`); }
    finally { window.requestAnimationFrame = rafReal; renderer.setRenderTarget(null); }
    return f;
  };
  const t0 = performance.now();
  const frames = step(120, performance.now());
  R.info.framesRun = frames;
  R.info.msPerFrame = +((performance.now() - t0) / Math.max(1, frames)).toFixed(2);

  /* 6. Откаты: выстрел зажигательным ставит 5 с и блокирует повтор */
  try {
    switchAmmo(2);
    wpn.bolt = 0; wpn.rel = 0; wpn.cd = [0, 0, 0];
    const shotsBefore = game.shots;
    tryFire();
    R.info.fireCdAfterShot = wpn.cd[2];
    if (wpn.cd[2] <= 0) bad('выстрел зажигательным не поставил откат');
    wpn.bolt = 0;
    tryFire();
    if (game.shots > shotsBefore + 1) bad('откат не блокирует повторный выстрел зажигательным');
    /* откат тикает и при другом выбранном типе */
    switchAmmo(0);
    const cdWas = wpn.cd[2];
    for (let i = 0; i < 30; i++) updateWeapon(0.016);
    if (!(wpn.cd[2] < cdWas)) bad('откат не тикает, пока выбран другой тип');
  } catch (e) { bad('проверка отката упала: ' + e.message); }

  /* 7. Утечки: пули и эффекты не должны копиться бесконечно */
  const bulletsPeak = bullets.length;
  step(300, performance.now() + 2000);
  R.info.bulletsAfter = bullets.length;
  R.info.bulletsPeak = bulletsPeak;
  let meshes2 = 0;
  scene.traverse(o => { if (o.isMesh) meshes2++; });
  R.info.meshesAfter = meshes2;
  if (meshes2 > meshes * 1.6 + 200) warn(`сцена разрослась: было ${meshes}, стало ${meshes2}`);

  rt.dispose();
  window.onerror = oldErr;
  if (errs.length) { R.errors.push(...errs.slice(0, 10)); R.ok = false; }
  return JSON.stringify(R);
})()
