/* =====================================================================
   DM_DUEL v3 — покадровое обновление оружия: откаты типов, оптика,
   отдача и анимация вида от первого лица.
   ===================================================================== */

/* HUD принадлежит F: узлы кэшируем и работаем через проверки, чтобы
   перекройка разметки не роняла кадр посреди боя. */
const WPN_HUD = {};
function WPN_el(id){
  let e = WPN_HUD[id];
  if(e === undefined){ e = WPN_HUD[id] = ($(id) || null); }
  return e;
}
function WPN_txt(id, s){ const e = WPN_el(id); if(e && e.textContent !== s) e.textContent = s; }
function WPN_wid(id, s){ const e = WPN_el(id); if(e) e.style.width = s; }
function WPN_op(id, v){ const e = WPN_el(id); if(e) e.style.opacity = v; }
function WPN_cls(id, c, on){ const e = WPN_el(id); if(e) e.classList.toggle(c, on); }

let WPN_cdShown = -1;      // какое значение отката уже нарисовано в статусе
let WPN_sprintK = 0;       // сглаженная поза «бег с оружием у бедра»
let WPN_mantleK = 0;       // ствол уходит вниз, пока игрок висит на уступе
let WPN_slideK = 0;        // подкат кладёт винтовку набок
let WPN_dashK = 0;         // рывок вжимает оружие в плечо
let WPN_scopeSnap = 0;     // короткий рывок при входе в оптику
let WPN_wasScoped = false;
let WPN_rfNext = -1;       // дальномер: следующий пересчёт по game.time
let WPN_rfTxt = '—';
let WPN_lastTime = 0;      // сторож рестарта: game.time обнуляется в startGame()
let WPN_wpnShown = '';     // какой ствол сейчас показан в руках
let WPN_wasFull = false;   // натяг уже дошёл до упора (щелчок играем один раз)
let WPN_bowZoomK = 0;      // сглаженное приближение при натяге лука

/* Ствол сменился между матчами. Меняется не только модель в руках:
   недотянутая тетива, открытая оптика и «горячий» ствол от прошлого боя
   не должны пережить смену оружия. Зовётся из updateWeapon сама, поэтому
   startGame() ничего про это знать не обязан. */
function WPN_applyWeapon(W){
  WPN_wpnShown = W.id;
  wpn.draw = 0; wpn.drawing = false; wpn.drawT = 0; wpn.creakT = 0;
  wpn.charge = 0; wpn.scoped = false; wpn.zoom = 0;
  wpn.heat = 0; wpn.bloom = 0; wpn.flashT = 0;
  wpn.boltAnim = 0; wpn.ejected = true; WPN_ejectArm = false;
  WPN_wasFull = false; WPN_bowZoomK = 0;
  for(const s of WPN_shells){ s.life = 0; s.m.visible = false; }
  for(const s of WPN_smoke) s.visible = false;
  if(vmFlash) vmFlash.visible = false;
  if(WPN_flashCore) WPN_flashCore.visible = false;
  if(vmRifle) vmRifle.visible = !W.bow;
  if(vmBow) vmBow.visible = (W.bow === true);
  WPN_clearStuck();
}

function updateWeapon(dt){
  const a = A();
  const W = curWeapon();
  const bow = (W.bow === true);
  if(W.id !== WPN_wpnShown) WPN_applyWeapon(W);

  /* Новый матч: сбрасываем всё переходное состояние ствола сами, чтобы
     недотикавший откат или увод камеры не переехали в следующий бой. */
  if(game.time < WPN_lastTime){
    wpn.cd[0] = wpn.cd[1] = wpn.cd[2] = 0;
    wpn.yawRec = 0; wpn.heat = 0; wpn.flashT = 0; wpn.bloom = 0; wpn.rec = 0;
    wpn.kickV = 0; wpn.kickXV = 0; wpn.ejected = true; WPN_ejectArm = false; wpn.relStage = 0;
    // натяг лука — такое же переходное состояние, как недокрученный затвор
    wpn.draw = 0; wpn.drawing = false; wpn.drawT = 0; wpn.creakT = 0;
    WPN_wasFull = false; WPN_bowZoomK = 0;
    for(const s of WPN_shells){ s.life = 0; s.m.visible = false; }
    WPN_clearStuck();
    if(vmFlash) vmFlash.visible = false;
    if(WPN_flashCore) WPN_flashCore.visible = false;
    WPN_cdShown = -1; WPN_statusOff('cd');
  }
  WPN_lastTime = game.time;

  /* ---------- откаты боеприпасов ----------
     Тикают всегда и у всех типов сразу: пока фугас остывает, можно бить
     матчевым, но фугас от этого готов не станет. */
  for(let i=0;i<wpn.cd.length;i++){
    if(wpn.cd[i] <= 0) continue;
    wpn.cd[i] -= dt;
    if(wpn.cd[i] <= 0){
      wpn.cd[i] = 0;
      SFX.ready();                                  // ровно один раз на тип
      if(i === wpn.idx){ WPN_cdShown = -1; WPN_statusOff('cd'); }
    }
  }
  const cdCur = wpn.cd[wpn.idx];
  if(cdCur > 0){
    const shown = Math.ceil(cdCur*10);              // обновляем строку раз в 0.1 с
    if(shown !== WPN_cdShown){
      WPN_cdShown = shown;
      WPN_status('cd', WPN_cdTxt(a, cdCur), '#e08a4a');
    }
  } else if(WPN_cdShown !== -1){
    WPN_cdShown = -1; WPN_statusOff('cd');
  }
  if(WPN_blockT > 0) WPN_blockT -= dt;

  /* ---------- затвор (у лука — наложить стрелу) и перезарядка ---------- */
  if(wpn.bolt>0){
    wpn.bolt -= dt;
    wpn.boltAnim = clamp(wpn.boltAnim + dt/Math.max(0.001,a.bolt), 0, 1);
    if(wpn.bolt<=0){
      wpn.boltAnim = 0;
      if(bow) SFX.noise({dur:0.05, f:2100, q:5, g:0.09});   // стрела легла на тетиву
    }
    if(wpn.bolt<=0 && wpn.loaded[wpn.idx]===0 && wpn.res[wpn.idx]>0) startReload();
  }
  if(wpn.rel>0){
    const p = 1 - wpn.rel/Math.max(0.001, wpn.relTotal);
    if(p>0.50 && wpn.relStage<1){ wpn.relStage=1; SFX.noise({dur:0.07,f:900,q:3,g:0.15}); }  // обойма села
    if(p>0.86 && wpn.relStage<2){ wpn.relStage=2; SFX.bolt(); }                              // затвор закрыт
    wpn.rel -= dt;
    if(wpn.rel<=0){ finishReload(); updateAmmoHUD(); }
  }

  /* ---------- натяг лука ----------
     Тянуть можно только когда стрела уже на тетиве, тип не на откате и
     колчан не пуст. Кнопка при этом может быть зажата и раньше: тогда
     натяг просто начнётся сам, как только оружие освободится. */
  if(bow){
    const dTime = Math.max(0.05, W.drawTime);
    const canDraw = player.alive && wpn.rel<=0 && wpn.bolt<=0 &&
                    wpn.cd[wpn.idx]<=0 && wpn.loaded[wpn.idx]>0;
    if(wpn.drawing && canDraw){
      wpn.draw = Math.min(1, wpn.draw + dt/dTime);
      // скрип плеч: частый на первой половине хода, к упору редеет
      wpn.creakT -= dt;
      if(wpn.creakT <= 0){
        wpn.creakT = 0.16 + wpn.draw*0.12;
        SFX.noise({dur:0.08, f:360 + wpn.draw*520, f2:250, q:2.4, g:0.045});
      }
      if(wpn.draw >= 1){
        if(!WPN_wasFull){ WPN_wasFull = true; SFX.tone({f:1180, dur:0.05, type:'square', g:0.05}); }
        wpn.drawT += dt;
        /* Полный натяг ест ту же выносливость, что и задержка дыхания у
           винтовки: держать лук «на всякий случай» дороже, чем дотянуть и
           пустить. Через пару секунд руки уже заметно ходят — см. swayAmp(). */
        if(wpn.drawT > BOW.holdFree)
          player.stam = clamp(player.stam - dt*BOW.stamDrain, 0, 1);
      }
    } else {
      wpn.draw = damp(wpn.draw, 0, 9, dt);
      if(wpn.draw < 0.002) wpn.draw = 0;
      wpn.drawT = 0;
      if(wpn.draw < 0.5) WPN_wasFull = false;
    }
  }

  /* ---------- оптика, заряд, отдача ---------- */
  /* У лука оптики нет вовсе. ПКМ приходит из общего обработчика ввода, и
     проще один раз погасить флаг здесь, чем требовать от ввода знания о том,
     какой ствол сейчас в руках. */
  if(bow && wpn.scoped) wpn.scoped = false;
  const wantScope = wpn.scoped && player.alive && wpn.rel<=0 && !bow;
  if(wantScope && !WPN_wasScoped) WPN_scopeSnap = 1;      // винтовку резко подкидывают к глазу
  WPN_wasScoped = wantScope;
  WPN_scopeSnap = damp(WPN_scopeSnap, 0, 9, dt);
  wpn.sT = damp(wpn.sT, wantScope?1:0, 13, dt);
  // заряд копится и на откате: ждать типа и заново выцеливать — двойное наказание
  if(wpn.sT<0.5) wpn.charge = 0;
  else if(wpn.bolt<=0 && wpn.rel<=0 && wpn.loaded[wpn.idx]>0)
    wpn.charge = Math.min(1, wpn.charge + dt/CFG.chargeMax);

  wpn.bloom = damp(wpn.bloom, 0, 3.2, dt);
  wpn.rec = damp(wpn.rec, 0, wpn.sT>0.5 ? 4.2 : 3.4, dt);
  // горизонтальный увод сводится обратно: камера возвращается туда, куда целились
  if(wpn.yawRec !== 0){
    const back = wpn.yawRec*(1 - Math.exp(-6.5*dt));
    player.yaw -= back; wpn.yawRec -= back;
    if(Math.abs(wpn.yawRec) < 1e-5) wpn.yawRec = 0;
  }
  wpn.kickV = damp(wpn.kickV, 0, 11, dt);
  wpn.kick = damp(wpn.kick, wpn.kickV*0.035, 22, dt);
  wpn.kickXV = damp(wpn.kickXV, 0, 10, dt);
  wpn.kickX = damp(wpn.kickX, wpn.kickXV*0.030, 18, dt);

  /* Натянутый лук чуть сужает поле зрения — так делает любой стрелок,
     когда сводит взгляд на цели. Это НЕ оптика: сетки нет, кратность не
     переключается, и на полном натяге это всего девять градусов. */
  WPN_bowZoomK = damp(WPN_bowZoomK, bow ? wpn.draw : 0, 8, dt);
  const fov = lerp(game.fov, ZOOMS[wpn.zoom], wpn.sT) + WPN_scopeSnap*1.6 - WPN_bowZoomK*BOW.zoom;
  if(Math.abs(camera.fov - fov) > 0.001){ camera.fov = fov; camera.updateProjectionMatrix(); }

  /* ---------- HUD ---------- */
  const sc = WPN_el('scope');
  if(sc){
    if(wpn.sT>0.72){ if(!sc.classList.contains('on')){ sc.classList.add('on'); updateReticle(); } }
    else sc.classList.remove('on');
  }
  WPN_op('xh', wpn.sT>0.6?0:1);
  vmRoot.visible = wpn.sT < 0.62;
  /* Полоса заряда служит и луку — только показывает натяг. Заводить вторую
     такую же в разметке незачем: смысл у неё один, «сколько накоплено». */
  const chg = bow ? wpn.draw : wpn.charge;
  WPN_cls('chargeWrap', 'on', bow ? (wpn.draw > 0.01) : (wpn.sT>0.6));
  WPN_wid('chargeFill', (chg*100)+'%');
  WPN_txt('chargeCap', bow
    ? (chg>=0.999 ? 'НАТЯГ ПОЛНЫЙ' : 'НАТЯГ '+Math.round(chg*100)+'%')
    : (chg>=0.999 ? 'ЗАРЯД ПОЛНЫЙ' : 'ЗАРЯД '+Math.round(chg*100)+'%'));
  WPN_cls('stam', 'on', player.stam<0.99);
  WPN_wid('stamFill', (player.stam*100)+'%');
  WPN_cls('reload', 'hide', !(wpn.rel>0 || wpn.bolt>0));
  if(wpn.rel>0){ WPN_txt('reloadTxt', bow?'КОЛЧАН':'ПЕРЕЗАРЯДКА'); WPN_wid('reloadFill', ((1-wpn.rel/wpn.relTotal)*100)+'%'); }
  else if(wpn.bolt>0){ WPN_txt('reloadTxt', bow?'НАЛОЖИТЬ СТРЕЛУ':'ЗАТВОР'); WPN_wid('reloadFill', ((1-wpn.bolt/a.bolt)*100)+'%'); }

  // прицельная марка от бедра
  const px = 6 + currentSpreadDeg()*7.5;
  let e = WPN_el('xhU'); if(e) e.style.top = (-px-11)+'px';
  e = WPN_el('xhD'); if(e) e.style.top = px+'px';
  e = WPN_el('xhL'); if(e) e.style.left = (-px-11)+'px';
  e = WPN_el('xhR'); if(e) e.style.left = px+'px';

  /* ---------- модель оружия ---------- */
  const t = game.time;
  // дыхание: на Shift в оптике почти замирает, на усталости — наоборот
  wpn.breathT += dt*(wpn.hold && player.stam>0.02 ? 0.32 : 1) * (1 + (1-player.stam)*0.55);
  const breath = Math.sin(wpn.breathT*1.5)*(wpn.hold && player.stam>0.02 ? 0.12 : 1);

  WPN_sprintK = damp(WPN_sprintK, (player.sprinting && wpn.sT<0.25 && player.grounded)?1:0, 8, dt);
  WPN_mantleK = damp(WPN_mantleK, player.mantleT>0 ? 1:0, 14, dt);
  WPN_slideK  = damp(WPN_slideK,  player.slideT>0  ? 1:0, 10, dt);
  WPN_dashK   = damp(WPN_dashK,   player.dashT>0   ? 1:0, 16, dt);

  /* Поза одна на оба ствола, разные только опорные точки. У винтовки s —
     это уход в оптику, у лука — натяг: жест «оружие идёт к лицу» один и
     тот же, и городить вторую копию всей анимации ради него незачем. */
  const aim = bow ? wpn.draw : wpn.sT;
  const s = smoothstep(0, 1, aim);              // 0 — от бедра, 1 — приклад у щеки
  const idle = 1 - aim*0.75;                    // в оптике болтанка модели гасится
  const bobX = Math.sin(t*7)*0.012*player.bob*idle;
  const bobY = Math.abs(Math.cos(t*7))*0.016*player.bob*idle;
  /* Опорные точки берём ОДНИ И ТЕ ЖЕ: лук собран в той же локальной системе,
     что винтовка (ось стрелы там же, где канал ствола, точка схода — там же,
     где дуло). Значит и «от бедра → к лицу» у них одинаковый, только у лука
     этот путь проходит натяг, а не оптика. Лишний набор чисел здесь означал
     бы, что стрела уходит не туда, куда смотрит марка. */
  const vm = (bow && vmBow) ? vmBow : vmRifle;
  vm.position.x = lerp(0.16, 0.012, s) + bobX + wpn.swayX + wpn.kickX*0.06 + WPN_sprintK*0.05;
  vm.position.y = lerp(-0.20, -0.105, s) + bobY + wpn.swayY
                - wpn.kick*0.25 - player.dip*0.3
                + breath*0.006*idle - WPN_sprintK*0.05 - WPN_mantleK*0.30 - WPN_slideK*0.10;
  vm.position.z = lerp(-0.42, -0.30, s) + wpn.kick*0.55 - WPN_scopeSnap*0.05 + WPN_dashK*0.07;
  vm.rotation.x = lerp(0.02, -0.012, s) + wpn.kick*1.2 + wpn.swayY*0.9
                + breath*0.004*idle + WPN_mantleK*0.75 + WPN_sprintK*0.12;
  vm.rotation.y = lerp(-0.055, -0.004, s) - wpn.swayX*1.1 + wpn.kickX*0.035 - WPN_sprintK*0.38;
  vm.rotation.z = lerp(0.02, 0.0, s) - wpn.swayX*1.4 + Math.sin(t*3.5)*0.006*idle
                + wpn.kick*0.22 + WPN_sprintK*0.52 + WPN_slideK*0.35;
  wpn.swayX = damp(wpn.swayX, 0, 7, dt);
  wpn.swayY = damp(wpn.swayY, 0, 7, dt);

  /* ---------- цикл затвора (только винтовка) ---------- */
  /* Соглашение модуля: wpn.ejected === true значит «выбрасывать нечего».
     Пока в матче не было ни одного выстрела, восстанавливаем это сами:
     чужой сброс поля на старте иначе прогонит затвор с гильзой из ниоткуда. */
  if(game.shots === 0 && !WPN_ejectArm) wpn.ejected = true;
  const bg = (!bow && vmRifle.userData) ? vmRifle.userData.bolt : null;
  if(bg){
    if(wpn.boltAnim>0){
      const p = wpn.boltAnim;
      const up   = smoothstep(0, 0.16, p) * (1 - smoothstep(0.84, 1, p));
      const back = smoothstep(0.16, 0.46, p) * (1 - smoothstep(0.54, 0.86, p));
      bg.rotation.z = -up*0.85;
      bg.position.z = 0.05 + back*0.17;
      // гильза уходит на самом откате затвора, а не в момент выстрела: это болтовка.
      // Заряжает выброс только tryFire() — анимация сама по себе гильз не рожает
      if(WPN_ejectArm && !wpn.ejected && p > 0.42){
        wpn.ejected = true; WPN_ejectArm = false; WPN_ejectShell(a);
      }
      // левая рука работает рукоятью, оружие кивает
      vmHandL.position.z = -0.40 + back*0.10;
      vm.rotation.x += back*0.06;
    } else {
      bg.rotation.z = 0; bg.position.z = 0.05;
      vmHandL.position.z = damp(vmHandL.position.z, -0.40, 12, dt);
    }
  }

  /* ---------- натяг в модели ----------
     Тетива складывается в «V», плечи гнутся навстречу, наложенная стрела
     уезжает назад вместе с рукой. Пока стрелу кладут на тетиву или набивают
     колчан — её на луке нет, и это единственная честная подсказка о том,
     что тянуть пока нечего. */
  if(bow && vmBow){
    const u = vmBow.userData;
    if(u && typeof u.draw === 'function') u.draw(wpn.draw);
    /* Стрела на тетиве появляется только когда её уже наложили. Это
       единственная честная подсказка «тянуть пока нечего» — полоса
       перезарядки внизу экрана в момент боя в глаза не бросается. */
    const ready = (wpn.bolt<=0 && wpn.rel<=0 && wpn.loaded[wpn.idx]>0);
    for(let i=0;i<WPN_vmArrows.length;i++){
      const want = ready && (i === wpn.idx);
      if(WPN_vmArrows[i].visible !== want) WPN_vmArrows[i].visible = want;
    }
  }

  /* ---------- перезарядка: обойма вниз, обойма вверх, затвор ---------- */
  if(wpn.rel>0){
    const p = 1 - wpn.rel/Math.max(0.001, wpn.relTotal);
    const tilt = Math.sin(clamp(p*1.35,0,1)*Math.PI);
    vm.rotation.x += tilt*0.55;
    vm.rotation.z += tilt*0.22;
    vm.position.y -= tilt*0.14;
    if(!bow){
      // рука ныряет за обоймой и возвращает её на место
      const hand = p<0.5 ? smoothstep(0,0.5,p) : (1-smoothstep(0.5,0.9,p));
      vmHandL.position.y = -0.11 - hand*0.22;
      vmHandL.position.x = -0.02 - hand*0.05;
      if(bg){ bg.rotation.z = -0.85*(1-smoothstep(0.80,1,p)); bg.position.z = 0.05 + 0.12*(1-smoothstep(0.80,1,p)); }
    }
  } else if(!bow){
    vmHandL.position.y = damp(vmHandL.position.y, -0.11, 12, dt);
    vmHandL.position.x = damp(vmHandL.position.x, -0.02, 12, dt);
  }

  /* ---------- дульная вспышка ---------- */
  if(wpn.flashT>0){
    wpn.flashT -= dt;
    const k = clamp(wpn.flashT/0.06, 0, 1);
    if(vmFlash){
      vmFlash.scale.setScalar(wpn.flashS*(0.45 + 0.55*k)*rnd(0.92,1.08));
      vmFlash.material.rotation += dt*9;
      vmFlash.material.opacity = k;
    }
    if(WPN_flashCore) WPN_flashCore.scale.setScalar(wpn.flashS*0.42*k);
    if(WPN_vmLight) WPN_vmLight.intensity = 7*k;
    if(wpn.flashT<=0){
      if(vmFlash){ vmFlash.visible = false; vmFlash.material.opacity = 1; }
      if(WPN_flashCore) WPN_flashCore.visible = false;
      if(WPN_vmLight) WPN_vmLight.intensity = 0;
    }
  }

  WPN_updateShells(dt);
  // у лука ствол не греется — обнуляем до вызова, чтобы дым не «унаследовался»
  if(bow) wpn.heat = 0;
  WPN_updateBarrelSmoke(dt);
  WPN_updateStuck(dt);      // воткнувшиеся стрелы живут в мире, а не в руках

  // блик на линзе прицела, когда винтовка идёт к глазу — мелочь, но читается
  const lens = vmRifle.userData ? vmRifle.userData.lens : null;
  if(lens && lens.material) lens.material.opacity = 0.55 + 0.35*wpn.sT;
}

/* Дальномер обновляем десять раз в секунду: на глаз разницы нет.
   Луч по коробкам и рельефу берём из общего кэша camRayDist() — тот же
   замер нужен подсказке зоны поражения, и делать его дважды незачем.
   Свой остаётся только перебор врагов: он на порядок дешевле луча. */
function updateRangefinder(){
  if(wpn.sT<0.72){
    if(WPN_rfTxt !== '—'){ WPN_rfTxt = '—'; WPN_txt('rangeTxt', '—'); }
    WPN_rfNext = -1;
    return;
  }
  if(game.time < WPN_rfNext) return;
  WPN_rfNext = game.time + 0.1;
  let best = camRayDist(400), tag='';
  camera.getWorldDirection(_fwd);
  for(const e of enemies){
    if(!e.alive) continue;
    const r = e.segHit(camera.position, _fwd, best);
    if(r && r.t<best){ best = r.t; tag=' ⟨ЦЕЛЬ⟩'; }
  }
  WPN_rfTxt = Math.round(best)+' М'+tag;
  WPN_txt('rangeTxt', WPN_rfTxt);
}
