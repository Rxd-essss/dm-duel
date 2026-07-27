/* =====================================================================
   H · Ввод, состояния матча, главный цикл, загрузка.
   ===================================================================== */

/* ------------------------------ ВВОД ------------------------------ */
let GM_pauseAt = 0;          // когда встала пауза — чтобы Esc не снял её тем же нажатием

function GM_lock(){
  try{
    const r = document.getElementById('c').requestPointerLock();
    if(r && r.catch) r.catch(()=>{});   // браузер отказывает ~1 с после выхода по Esc — это не ошибка
  }catch(err){}
}
function GM_dropKeys(){ for(const k in keys) keys[k] = false; }

function initInput(){
  const cv = document.getElementById('c');
  cv.addEventListener('click', ()=>{ if(game.state==='play' && !document.pointerLockElement) GM_lock(); });
  document.addEventListener('pointerlockchange', ()=>{
    if(!document.pointerLockElement && game.state==='play') pauseGame();
  });
  document.addEventListener('mousemove', e=>{
    if(!document.pointerLockElement || game.state!=='play') return;
    const zf = camera.fov/game.fov;
    const s = game.sens*0.0016*zf;
    player.yaw -= e.movementX*s;
    player.pitch -= e.movementY*s;
    player.pitch = clamp(player.pitch, -Math.PI/2+0.02, Math.PI/2-0.02);
    wpn.swayX = clamp(wpn.swayX + e.movementX*0.00022, -0.05, 0.05);
    wpn.swayY = clamp(wpn.swayY + e.movementY*0.00018, -0.04, 0.04);
  });
  document.addEventListener('mousedown', e=>{
    if(game.state!=='play' || !document.pointerLockElement) return;
    if(e.button===0) tryFire();
    if(e.button===2){ wpn.scoped = !wpn.scoped; SFX[wpn.scoped?'scopeIn':'scopeOut'](); }
  });
  document.addEventListener('contextmenu', e=>{ if(game.state==='play') e.preventDefault(); });
  document.addEventListener('wheel', e=>{
    if(game.state!=='play') return;
    if(wpn.sT>0.5){ wpn.zoom = clamp(wpn.zoom + (e.deltaY>0?-1:1), 0, ZOOMS.length-1); updateReticle(); SFX.scopeIn(); }
    else { switchAmmo((wpn.idx + (e.deltaY>0?1:2))%3); }
  }, {passive:true});

  addEventListener('keydown', e=>{
    if(e.code==='Escape'){
      if(game.state==='play') pauseGame();
      // Esc сам снимает захват мыши, пауза уже встала по pointerlockchange —
      // тот же самый Esc не должен её мгновенно снять обратно
      else if(game.state==='pause' && performance.now()-GM_pauseAt > 350) resumeGame();
      return;
    }
    if(game.state!=='play') return;
    /* Флаг клавиши ставим ДО любых разборов и return: рывок (Q), подкат (Ctrl/C),
       прыжок и лестницы читают keys[...] напрямую из модуля паркура. */
    keys[e.code] = true;
    if(e.code==='Space' || e.code==='Tab') e.preventDefault();
    if(e.repeat) return;              // автоповтор не должен щёлкать перезарядкой и сменой патрона
    if(e.code==='Digit1') switchAmmo(0);
    if(e.code==='Digit2') switchAmmo(1);
    if(e.code==='Digit3') switchAmmo(2);
    if(e.code==='KeyR') startReload();
  });
  addEventListener('keyup', e=>{ keys[e.code] = false; });
  addEventListener('blur', GM_dropKeys);
  // свернули вкладку — замираем: иначе бой идёт вслепую, а кадр после возврата гигантский
  document.addEventListener('visibilitychange', ()=>{
    if(document.hidden){ GM_dropKeys(); if(game.state==='play') pauseGame(); }
  });
}

/* ------------------------- СОСТОЯНИЯ ИГРЫ ------------------------- */
/* Между матчами в мире не должно оставаться чужого огня, дыма и цифр урона.
   Лезем в FX аккуратно и через проверки — внутренности 55_fx.js не наши. */
function GM_clearFx(){
  // у самого модуля сброс сделан правильно (в том числе он знает, что текстуры
  // цифр урона лежат в общем кэше и уничтожать их нельзя) — доверяем ему
  if(typeof FX.reset === 'function'){ FX.reset(); return; }
  if(Array.isArray(FX.pools)){
    for(const f of FX.pools) if(f && f.g) scene.remove(f.g);
    FX.pools.length = 0;
  }
  if(Array.isArray(FX.nums)){
    for(const n of FX.nums){
      if(!n || !n.sp) continue;
      scene.remove(n.sp);
      // material.map НЕ трогаем: карта общая и живёт в кэше цифр
      if(n.sp.material) n.sp.material.dispose();
    }
    FX.nums.length = 0;
  }
  if(Array.isArray(FX.pool)) for(const it of FX.pool){ if(it && it.m){ it.life = 0; it.m.visible = false; } }
  if(Array.isArray(FX.decals)) for(const d of FX.decals) if(d) d.visible = false;
}

function startGame(){
  SFX.init(); SFX.resume();
  game.state='play'; game.kills=0; game.deaths=0; game.shots=0; game.hits=0;
  game.heads=0; game.best=0; game.time=0;
  game.dmgTaken=0; game.burnTaken=0; game.fragTaken=0; game.picks=0;
  GM_dropKeys();
  GM_shownSec = -1;
  D = DIFFS[game.diff];

  // оружие: откаты типов обязаны обнулиться, иначе рестарт начинается «в блоке»
  wpn.idx=0; wpn.zoom=0; wpn.scoped=false; wpn.sT=0; wpn.charge=0;
  wpn.bolt=0; wpn.rel=0; wpn.relTotal=0; wpn.bloom=0; wpn.rec=0;
  // ejected=true означает «выбрасывать нечего»: иначе первый же цикл затвора
  // на старте матча выплюнет гильзу-фантом до единого выстрела
  wpn.kick=0; wpn.kickV=0; wpn.boltAnim=0; wpn.hold=false; wpn.ejected=true;
  wpn.swayX=0; wpn.swayY=0;
  wpn.cd = [0,0,0];
  wpn.res = [AMMO[0].resMax, AMMO[1].resMax, AMMO[2].resMax];
  wpn.loaded = [AMMO[0].mag, AMMO[1].mag, AMMO[2].mag];

  // подвижность и горение: без сброса рестарт стартует с грязным состоянием
  player.burn = 0; player.dashCd = 0; player.dashT = 0; player.slideT = 0;
  player.mantleT = 0; player.noGrav = false; player.climb = null; player.zip = null;
  player.airJumps = 0; player.coyote = 0; player.jumpBuf = 0;
  player.vel.set(0,0,0); player.h = CFG.height; player.crouching = false;
  player.grounded = false; player.stam = 1; player.bobT = 0; player.bob = 0;
  player.dip = 0; player.lastHurt = 99; player.landV = 0;
  CMB_extinguish();
  clearStatus('cd');
  // отложенные задачи HUD (киллфид, вспышка урона, указатели направления)
  // переживали рестарт и продолжали трогать DOM уже нового боя
  clearHudTimers();

  // геометрия визуала пули — ОДНА общая на весь пул 60_weapon.js; уничтожать её
  // здесь значит выбрасывать чужой ресурс по разу на каждую летящую пулю
  for(const b of bullets){ scene.remove(b.mesh); scene.remove(b.glow); }
  bullets.length = 0;
  for(const h of flyingHats) scene.remove(h.m);
  flyingHats.length = 0;
  GM_clearFx();
  for(const p of PICKUPS){ p.alive=true; if(p.mesh) p.mesh.visible=true; p.t=0; p.cmbGlow=0; p.cmbPop=1; }
  // позиции освобождаем до перебора ботов: выброшенные боты держали их «занятыми»
  for(const q of POSTS) q.taken = null;

  // Сколько ботов в бою, в сети решает сервер (свободные слоты), офлайн — сложность
  const botTarget = netOn() ? (NET.botCount|0) : D.bots;
  while(enemies.length > botTarget){ const e=enemies.pop(); scene.remove(e.m); if(e.m.userData.dot) scene.remove(e.m.userData.dot); }
  while(enemies.length < botTarget) enemies.push(new Enemy(enemies.length));
  respawnPlayer();
  player.yaw = 0; player.pitch = -0.05;
  for(const e of enemies) e.respawn(true);

  updateWind(); updateScore(); updateAmmoHUD(); updateHP(); updateReticle();
  $('menu').classList.add('hide'); $('pause').classList.add('hide'); $('end').classList.add('hide');
  $('hud').classList.remove('hide');
  GM_last = performance.now();
  GM_lock();
}
function pauseGame(){
  if(game.state!=='play') return;
  game.state='pause';
  GM_pauseAt = performance.now();
  $('pause').classList.remove('hide');
  if(document.pointerLockElement) document.exitPointerLock();
  GM_dropKeys();
}
function resumeGame(){
  if(game.state!=='pause') return;
  game.state='play';
  $('pause').classList.add('hide');
  GM_last = performance.now();      // цикл крутился и на паузе, но подстрахуемся от скачка dt
  GM_lock();
}
function endGame(win){
  if(game.state==='end') return;
  game.state='end';
  if(document.pointerLockElement) document.exitPointerLock();
  CMB_extinguish();
  clearStatus('cd');
  $('endTitle').textContent = win ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ';
  $('endTitle').style.color = win ? '#e9c46a' : '#d1493f';
  const dmg  = Math.round(game.dmgTaken||0);
  const burn = Math.round(game.burnTaken||0);
  const frag = Math.round(game.fragTaken||0);
  $('endSub').textContent = 'DM_DUEL v3 · '+DIFFS[game.diff].name+
    ' · ПОЛУЧЕНО УРОНА '+dmg+' (ОГОНЬ '+burn+' · ФУГАС '+frag+')'+
    ' · ПОДОБРАНО '+(game.picks||0);
  $('eK').textContent = game.kills; $('eD').textContent = game.deaths;
  $('eH').textContent = game.heads;
  $('eA').textContent = (game.shots? Math.round(game.hits/game.shots*100):0)+'%';
  $('eR').textContent = Math.round(game.best)+' м';
  $('eT').textContent = fmtTime(game.time);
  // необязательные боксы: заполняем, только если F добавил их в разметку
  const opt = (id, v)=>{ const el = $(id); if(el) el.textContent = v; };
  opt('eP', game.picks||0);
  opt('eB', burn+' HP');
  opt('eF', frag+' HP');
  $('end').classList.remove('hide');
  $('hud').classList.add('hide');
}

/* ------------------------------ ЦИКЛ ------------------------------ */
let GM_last = performance.now();
let GM_shownSec = -1;          // секунда, уже нарисованная в счётчике времени
let GM_frame = 0;

/* Сеть опциональна: модули 92/94/96 могут вообще отсутствовать в сборке.
   Флаг обновляется раз в кадр, чтобы горячие пути (баллистика перебирает пули
   подшагами) читали дешёвое булево, а не лезли в try/catch. */
let NET_ACTIVE = false;
function netOn(){
  try { return NET.on === true; } catch(e){ return false; }
}
function loop(now){
  requestAnimationFrame(loop);
  GM_frame++;
  let dt = (now-GM_last)/1000; GM_last = now;
  if(!(dt>0)) dt = 0;          // подстраховка от отрицательного/NaN времени
  if(dt>0.05) dt = 0.05;       // после паузы и сворачивания кадр не должен «прыгать»

  NET_ACTIVE = netOn();
  if(NET_ACTIVE) NET.update(dt);          // приём снапшотов и отправка своего состояния

  if(game.state==='play'){
    game.time += dt;
    updatePlayer(dt);
    tickPlayerBurn(dt);        // страховка: если A уже списал горение в этом кадре — вызов пустой
    updateWeapon(dt);
    // Боты живут на одном клиенте — хосте. Остальные видят реплики, которые
    // двигает интерполяция в NETP, поэтому локальный ИИ у них молчит.
    if(!NET_ACTIVE || NET.host){
      SQUAD.update(dt);
      for(const e of enemies) e.update(dt);
    }
    if(NET_ACTIVE) NETP.update(dt);
    updateBullets(dt);
    updatePickups(dt);
    updateMapDynamics(dt);
    FX.update(dt);
    updateCamera(dt);
    LIGHTS.update(dt, camera.position);
    updateRangefinder();
    updateAmmoHUD();
    updateWindHUD();

    const sec = Math.floor(game.time);
    if(sec !== GM_shownSec){ GM_shownSec = sec; const el = $('scTime'); if(el) el.textContent = fmtTime(game.time); }

    // летящие шляпы (их роняет 70_ai.js при хедшоте)
    for(let i=flyingHats.length-1;i>=0;i--){
      const h = flyingHats[i]; h.t += dt;
      h.v.y -= 16*dt;
      h.m.position.addScaledVector(h.v, dt);
      h.m.rotation.x += h.w.x*dt; h.m.rotation.y += h.w.y*dt; h.m.rotation.z += h.w.z*dt;
      const g = terrainH(h.m.position.x, h.m.position.z);
      if(h.m.position.y < g+0.05){ h.m.position.y = g+0.05; h.v.multiplyScalar(0.3); h.v.y=Math.abs(h.v.y)*0.35; }
      if(h.t>7){ scene.remove(h.m); flyingHats.splice(i,1); }
    }
    // таймеры мелких элементов HUD ведёт F; если он их убрал — просто пропускаем
    if(typeof hitT === 'number' && hitT>0){ hitT-=dt; if(hitT<=0) $('hitmark').style.opacity=0; }
    if(typeof toastT === 'number' && toastT>0){ toastT-=dt; if(toastT<=0) $('toast').style.opacity=0; }
  } else if(game.state!=='pause'){
    // в брифинге и на итогах мир живёт фоном: качаются мостики, дышат жаровни.
    // На паузе не обновляем НИЧЕГО — бой обязан замереть целиком.
    updateMapDynamics(dt);
    LIGHTS.update(dt, camera.position);
  }

  // Солнце едет за игроком, поэтому карта тени пересчитывается каждый кадр и
  // стоит около трети кадрового времени. Обновляем её через кадр: при 60 fps
  // отставание тени на 16 мс не читается, а половина этой цены возвращается.
  renderer.shadowMap.needsUpdate = renderer.shadowMap.enabled && ((GM_frame & 1) === 0);

  renderer.clear();
  renderer.render(scene, camera);
  renderer.clearDepth();
  if(game.state==='play' && vmRoot && vmRoot.visible) renderer.render(vmScene, vmCamera);
}

/* ------------------------------ СТАРТ ------------------------------ */
function bindUI(){
  const setDiff = d=>{
    game.diff = d; D = DIFFS[d];
    document.querySelectorAll('#diffSeg button, #diffSeg2 button').forEach(b=> b.classList.toggle('on', b.dataset.d===d));
    $('diffHint').textContent = DIFFS[d].hint;
  };
  document.querySelectorAll('#diffSeg button, #diffSeg2 button').forEach(b=>{
    b.onclick = ()=> setDiff(b.dataset.d);
  });
  setDiff('normal');
  for(let i=0;i<3;i++){ const el = $('s'+(i+1)); if(el) el.textContent = AMMO[i].stat; }
  $('playBtn').onclick = startGame;
  $('resumeBtn').onclick = resumeGame;
  $('restartBtn').onclick = startGame;
  $('againBtn').onclick = startGame;
  $('toMenuBtn').onclick = ()=>{ game.state='menu'; $('end').classList.add('hide'); $('menu').classList.remove('hide'); };
  SLOTS = Array.from(document.querySelectorAll('.slot'));
  SLOTS.forEach(s=> s.onclick = ()=> switchAmmo(+s.dataset.a));

  const sens=$('optSens'), fovI=$('optFov'), vol=$('optVol'), sh=$('optSh');
  sens.oninput = ()=>{ game.sens = sens.value/100; $('vSens').textContent = game.sens.toFixed(2); };
  fovI.oninput = ()=>{ game.fov = +fovI.value; $('vFov').textContent = fovI.value; updateReticle(); };
  vol.oninput  = ()=>{ SFX.setVol(vol.value/100); $('vVol').textContent = vol.value; };
  sh.oninput   = ()=>{ game.shadows=+sh.value; $('vSh').textContent = ['выкл','низ','выс'][sh.value]; setShadows(+sh.value); };
  sens.oninput(); fovI.oninput(); vol.oninput();
}

/* Пул динамического света обязан существовать ДО buildMap(): карта ставит
   статические источники (жаровни, кристаллы) через LIGHTS.addStatic.
   initThree() у E1 уже может звать LIGHTS.init(), а второй вызов создал бы
   второй комплект ламп — поэтому сначала проверяем, есть ли они в сцене. */
function GM_initLights(){
  // пул реальных ламп у E1 называется _lamps; init() и сам идемпотентен
  if(LIGHTS._lamps && LIGHTS._lamps.length) return;
  LIGHTS.init();
}

/* Индекс поверхностей 55_fx.js читает исходные меши карты поштучно, а
   mergeStaticWorld() их схлопывает. Значит порядок жёсткий: сначала индекс,
   потом склейка. Имя функции у E3 могло получиться разным — зовём то, что есть. */
function GM_buildSurfaceIndex(){
  if(FX && typeof FX.buildIndex === 'function'){ FX.buildIndex(); return true; }
  if(typeof buildSurfaceIndex === 'function'){ buildSurfaceIndex(); return true; }
  if(typeof FX_buildIdx === 'function'){ FX_buildIdx(); return true; }
  return false;
}

/* Комната меняет число ботов при каждом входе и выходе: свободные слоты
   добиваются ИИ. Если состав не пересобрать, у одного клиента останется пять
   ботов, у другого три, и кадр 'bots' от хоста будет ссылаться на индексы,
   которых у остальных нет. Зовётся из 92_net.js на 'join' и 'leave'. */
function netBotsChanged(n){
  if(game.state !== 'play') return;      // до боя состав соберёт startGame()
  const want = clamp(n|0, 0, 16);
  while(enemies.length > want){
    const e = enemies.pop();
    scene.remove(e.m);
    if(e.m.userData.dot) scene.remove(e.m.userData.dot);
    if(e.post) e.post.taken = null;
  }
  while(enemies.length < want){
    const e = new Enemy(enemies.length);
    enemies.push(e);
    e.respawn(true);
  }
}

function boot(){
  initThree();
  // если E1 уже собрал это внутри initThree — не пересоздаём
  if(!GRAD && typeof gradientMap === 'function') GRAD = gradientMap();
  if(!TEX_GLOW)  TEX_GLOW  = sprTex('rgba(255,255,255,1)','rgba(255,220,160,0.55)');
  if(!TEX_FIRE)  TEX_FIRE  = sprTex('rgba(255,245,200,1)','rgba(255,120,30,0.6)');
  if(!TEX_SMOKE) TEX_SMOKE = sprTex('rgba(180,180,180,0.7)','rgba(120,120,120,0.25)');
  FX.init();
  GM_initLights();
  buildMap();
  GM_buildSurfaceIndex();   // до склейки: индексу нужны отдельные меши
  mergeStaticWorld();       // ~1400 статичных мешей -> сотни; см. 20_render.js
  buildViewmodel();
  initInput();
  bindUI();
  const s = SPAWNS_BLU[0];
  player.pos.set(s.x, Math.max(s.y, terrainH(s.x, s.z)), s.z);
  updateCamera(0.016);
  const ln = document.getElementById('loadNote');
  if(ln) ln.remove();
  GM_last = performance.now();
  requestAnimationFrame(loop);
}

/* Сам запуск живёт в 98_boot.js — последнем модуле сборки. Причина простая:
   сетевые модули (92/94/96) объявляют свои объекты через const, и если звать
   boot() отсюда, они окажутся во временной мёртвой зоне и всё упадёт. */
