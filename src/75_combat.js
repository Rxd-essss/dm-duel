/* =====================================================================
   H · Урон игроку, горение, пикапы.
   Всё, что случается с игроком между «выстрелили в него» и «он снова в бою».
   ===================================================================== */

/* Свои временные вектора: в кадре ничего не аллоцируем.
   CMB_vL держим отдельно — его адрес уходит в LIGHTS.flash, и его нельзя
   переиспользовать под мелкие расчёты. */
const CMB_v1 = new THREE.Vector3();
const CMB_v2 = new THREE.Vector3();
const CMB_vL = new THREE.Vector3();

let CMB_cause = '';         // чем убили — нужно киллфиду
let CMB_burning = false;    // логическое состояние горения (сам эффект в оптике прячется)
let CMB_burnSfx = 0;        // до следующего «пшш» горения
let CMB_burnLight = 0;      // до следующей вспышки света от пламени
let CMB_burnStamp = -1;     // отметка кадра: горение списывается ровно один раз за кадр
let CMB_hpShown = 100;      // что уже нарисовано в HUD — чтобы не дёргать DOM каждый кадр
let CMB_burnShown = -1;

/* Сетевые накопители самоурона (NETCONTRACT §9.1). Горение тикает каждый кадр,
   а слать по заявке на кадр — это 60 пакетов в секунду; копим и заявляем реже. */
let CMB_burnClaim = 0;      // сколько урона горением ещё не заявлено серверу
let CMB_burnAcc   = 0;      // сколько секунд копим
let CMB_selfQuiet = -1e9;   // performance.now() последней заявки о горении

const CMB_SELF_TICK  = 0.35;  // как часто заявляем горение
const CMB_SELF_QUIET = 900;   // мс: столько эхо своего же урона не дублирует отклик

/* ------------------------------ УРОН ИГРОКУ ------------------------------ */
/* Заявка о самоуроне. В сети здоровьем владеет ТОЛЬКО сервер: мы говорим
   «мне прилетело столько-то и вот от чего», а он решает, сколько снять и
   умерли ли мы. Причина нужна серверу, чтобы ограничить величину за тик.
   Метод reportSelf() ведёт 92_net.js; запасной путь через NET.send() оставлен,
   чтобы сборка со старым сетевым модулем не теряла урон вовсе. */
function CMB_reportSelf(dmg, cause){
  if(!NET_ACTIVE || !(dmg>0)) return;
  if(typeof NET.reportSelf === 'function'){ NET.reportSelf(dmg, cause); return; }
  NET.send({ t:'self', d:Math.round(dmg*10)/10, c:cause });
}

function hurtPlayer(dmg, from, label){
  if(!player.alive || game.state!=='play' || !(dmg>0)) return;
  player.lastHurt = 0;
  // фугас считаем отдельно: по нему видно, выкурили тебя из укрытия или переиграли в дуэли
  if(label==='ФУГАС') game.fragTaken = (game.fragTaken||0) + dmg;
  // тряска растёт с уроном, но не настолько, чтобы отобрать управление
  SFX.hurt(); shake(clamp(0.22 + dmg*0.006, 0.22, 0.6));
  dmgFlash(dmg);
  if(from) dirIndicator(from);
  if(label) toast(label, '');
  CMB_cause = label || 'shot';

  /* Сеть: отклик показали, а здоровье не трогаем — уйдёт заявка, вернётся
     авторитетное hp в netDamage(). Списать локально нельзя дважды: чужое
     попадание тут же откатило бы hp вверх, а локальная смерть сделала бы
     из игрока «призрака», которого комната считает живым.
     Причина: фугас под ногами — 'frag', всё остальное сюда приходит только
     как падение/добивание — 'fall' (у сервера свой потолок на каждую). */
  /* Заявляем ТОЛЬКО то, что действительно является самоуроном: свой фугас под
     ногами и огонь. Пуля бота сюда тоже приходит (у хоста боты настоящие), но
     о ней сервер узнаёт по каналу 'bhit' из 70_ai.js — заявить её ещё и здесь
     значило бы снять с хоста двойной урон за одно попадание. Отклик при этом
     рисуем в любом случае: игрок обязан понимать, что в него попали. */
  if(NET_ACTIVE){
    // dmgTaken не накапливаем: его посчитает netDamage() по разнице hp
    const cause = (label==='ФУГАС') ? 'frag' : (label==='ОГОНЬ') ? 'burn' : null;
    if(cause) CMB_reportSelf(dmg, cause);
    return;
  }

  player.hp -= dmg;
  game.dmgTaken = (game.dmgTaken||0) + dmg;
  CMB_hpShown = Math.max(0, Math.round(player.hp));
  updateHP();
  if(player.hp<=0) killPlayer();
}

/* Сколько ждать до появления. Офлайн — прежние 3 с; в сети время назначает
   сервер (welcome.respawn → NET.respawnTime), и дублировать константу нельзя:
   разъехавшись, клиент либо поднимется раньше сервера, либо будет ждать
   лишнее. Значение всё равно проверяем: битое поле не должно вешать смерть. */
function CMB_respawnTime(){
  if(NET_ACTIVE){
    const t = NET.respawnTime;
    if(typeof t === 'number' && isFinite(t) && t > 0) return t;
  }
  return 3.0;
}

/* net — необязательный пакет с сервера {byName, part}. В сети счёт и таймер
   респавна ведёт сервер, поэтому локальные счётчики и конец матча пропускаем. */
function killPlayer(net){
  if(!player.alive) return;             // пуля и огонь могут добить в одном кадре
  player.alive = false; player.respawnT = CMB_respawnTime();
  player.hp = 0;
  if(!net) game.deaths++;
  CMB_extinguish();
  // паркурные состояния гасим здесь же, иначе труп продолжит ехать по тросу
  player.noGrav = false; player.climb = null; player.zip = null;
  player.dashT = 0; player.slideT = 0; player.mantleT = 0; player.airJumps = 0;
  player.vel.set(0,0,0);
  addFeed(net ? CMB_netDeathFeed(net) : CMB_deathFeed());
  updateScore(); updateHP();
  const dd = $('dead');
  if(dd){ dd.classList.remove('hide'); dd.style.display='flex'; }
  wpn.scoped = false; wpn.charge = 0; wpn.hold = false;
  FX.burst(playerCenter(CMB_v1), 16, {mat:PMAT.blood, speed:7, life:0.9, size:0.12});
  shake(0.55);
  if(!net && game.deaths >= CFG.killGoal) endGame(false);
}

/* ------------------------- СЕТЕВОЙ УРОН И СМЕРТЬ ------------------------- */
/* Здоровье в сети ведёт сервер: он присылает уже посчитанное значение, а мы
   только показываем отклик. Локально hp не уменьшаем — иначе два источника
   правды разъедутся, и игрок будет видеть не то, что видит комната. */
function netDamage(fromPos, dmg, hp, part){
  if(game.state!=='play' || !player.alive) return;
  const was = player.hp;
  player.hp = hp;
  player.lastHurt = 0;
  const real = Math.max(0, was - hp);
  game.dmgTaken = (game.dmgTaken||0) + real;
  /* Эхо собственной заявки о горении отклик уже показало (тик горения рисует
     свою вспышку и «пшш»), и подтверждение с сервера прилетает три раза в
     секунду. Тряска на каждое такое эхо отобрала бы прицел на всё время
     горения — поэтому подтверждение без источника в этом окне применяем молча. */
  const echo = !fromPos && (performance.now() - CMB_selfQuiet < CMB_SELF_QUIET);
  if(!echo){
    SFX.hurt(); shake(clamp(0.22 + real*0.006, 0.22, 0.6));
    dmgFlash(real || dmg);
    if(fromPos) dirIndicator(fromPos);
    if(part==='head') toast('В ГОЛОВУ', '');
  }
  CMB_hpShown = Math.max(0, Math.round(player.hp));
  updateHP();
}
function CMB_netDeathFeed(net){
  const who = net && net.byName ? net.byName : 'ОГОНЬ';
  return '<span class="r">'+who+'</span> ✖ <span class="b">ВЫ</span>' +
         (net && net.part==='head' ? ' <span class="w">· ХЕДШОТ</span>' : '');
}
function netKill(byName, part){ killPlayer({ byName, part }); }
/* Сервер сам решает, где и когда мы появимся. Координаты проверяем: одно NaN
   в позиции расползается по всей физике за кадр, и игрок проваливается сквозь
   мир без единой ошибки в консоли. Битую точку заменяем своей (§9.5). */
function netRespawn(x, y, z){
  respawnPlayer();
  if(isFinite(x) && isFinite(y) && isFinite(z)) player.pos.set(x, y, z);
  player.vel.set(0,0,0);
}

/* Киллфид должен различать пулю, фугас и огонь — иначе смерть от очага
   выглядит как баг («меня никто не стрелял»). */
function CMB_deathFeed(){
  if(CMB_cause==='burn')   return '<span class="r">ОГОНЬ</span> ✖ <span class="b">ВЫ</span>';
  if(CMB_cause==='ФУГАС')  return '<span class="r">ФУГАС</span> ✖ <span class="b">ВЫ</span>';
  return '<span class="r">RED СНАЙПЕР</span> ✖ <span class="b">ВЫ</span>' +
         (CMB_cause==='В ГОЛОВУ' ? ' <span class="w">· ХЕДШОТ</span>' : '');
}

/* Дистанция до ближайшего живого противника. Боты играют за RED, поэтому для
   игрока RED они союзники и от них прятаться незачем; зато в сети рядом со
   спавном могут стоять живые люди из чужой команды — их берём из NET.players
   (позиции обновляет снапшот). Респавн зовётся раз в смерть, не в кадре. */
function CMB_foeDist(x, z){
  let near = 1e9;
  const botsFoe = !NET_ACTIVE || NET.team !== 1;   // RED-бот врагом RED-игроку не является
  if(botsFoe)
    for(const e of enemies){
      if(!e.alive) continue;
      const d = Math.hypot(e.pos.x-x, e.pos.z-z);
      if(d < near) near = d;
    }
  if(NET_ACTIVE)
    for(const p of NET.players.values()){
      if(!p.alive || p.id === NET.id || p.team === NET.team) continue;
      const d = Math.hypot(p.x-x, p.z-z);
      if(d < near) near = d;
    }
  return near;
}

function respawnPlayer(){
  /* Точка появления — по своей команде: в сети RED, поднятый на спавнах BLU,
     начинал матч внутри чужой базы. Офлайн игрок всегда BLU. */
  const list = (NET_ACTIVE && NET.team === 1) ? SPAWNS_RED : SPAWNS_BLU;
  // спавн подальше от живых врагов: появиться в упор под чужой прицел — не бой, а лотерея
  let best = null, bs = -1e9;
  for(const s of list){
    let near = CMB_foeDist(s.x, s.z);
    if(near > 1e8) near = 60;
    const sc = Math.min(near, 70) + rnd(0, 12);
    if(sc > bs){ bs = sc; best = s; }
  }
  if(!best) best = pick(list);

  // высоту берём по рельефу: площадка базы может уехать вверх-вниз при правках террейна
  const gy = terrainH(best.x, best.z);
  player.pos.set(best.x, Math.max(best.y, gy) + 0.05, best.z);
  player.vel.set(0,0,0);
  player.hp = 100; player.alive = true; player.stam = 1;
  player.h = CFG.height; player.crouching = false; player.grounded = false;
  player.lastHurt = 99; player.landV = 0; player.dip = 0; player.bob = 0;
  // новое состояние подвижности: после смерти оно обязано быть чистым
  player.burn = 0; player.dashT = 0; player.slideT = 0; player.mantleT = 0;
  player.airJumps = 0; player.coyote = 0; player.jumpBuf = 0;
  player.noGrav = false; player.climb = null; player.zip = null;
  CMB_extinguish();

  wpn.loaded = [AMMO[0].mag, AMMO[1].mag, AMMO[2].mag];
  wpn.bolt = 0.5; wpn.rel = 0; wpn.charge = 0; wpn.scoped = false;
  const dd = $('dead');
  if(dd){ dd.style.display='none'; dd.classList.add('hide'); }
  CMB_hpShown = 100;
  updateHP(); updateAmmoHUD(); SFX.spawn();
  // короткая магическая вспышка на месте появления — видно, что ты «собрался» заново
  FX.magic(playerCenter(CMB_v1), 14, PAL.arcane);
}

/* ------------------------------ ГОРЕНИЕ ------------------------------ */
/* Пламя на самом игроке: несколько аддитивных спрайтов вокруг ног и пояса.
   Строим один раз и переиспользуем — прячем, а не удаляем. */
function CMB_makeBurnFx(){
  const g = new THREE.Group();
  for(let i=0;i<7;i++){
    const a = (i/7)*Math.PI*2 + rnd(-0.3,0.3);
    const r = rnd(0.30, 0.50);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map:TEX_FIRE, color:0xff8a34, blending:THREE.AdditiveBlending,
      depthWrite:false, transparent:true, opacity:0.85
    }));
    s.position.set(Math.cos(a)*r, 0.12 + (i%3)*0.30, Math.sin(a)*r);
    s.scale.setScalar(0.5);
    s.userData.ph = rnd(0, 6.283);
    s.userData.y0 = s.position.y;
    s.userData.k  = rnd(0.75, 1.25);
    g.add(s);
  }
  g.renderOrder = 3;
  g.visible = false;
  scene.add(g);
  return g;
}

/* Накопить урон горением. Именно накопить: два очага подряд должны жечь
   дольше, а не перезаписывать друг друга. Потолок нужен, чтобы стопка
   попаданий не превращалась в неотвратимую смерть. */
function burnPlayer(total){
  if(!(total>0) || !player.alive || game.state!=='play') return;
  if(!(player.burn>0)) player.burn = 0;
  const fresh = player.burn <= 0.001;
  player.burn = Math.min(player.burn + total, 96);
  if(!player.burnFx) player.burnFx = CMB_makeBurnFx();
  if(!CMB_burning){
    CMB_burning = true;
    CMB_burnSfx = 0; CMB_burnLight = 0;
    setBurnHUD(true);
  }
  if(fresh){ SFX.burn(); shake(0.2); toast('ГОРИТЕ', 'СМЕНИТЕ ПОЗИЦИЮ'); }
}

/* Списание урона за кадр. Зовёт A из updatePlayer; 90_game.js страхует
   повторным вызовом — двойного списания не будет, кадр помечается game.time. */
function tickPlayerBurn(dt){
  if(CMB_burnStamp === game.time) return;
  CMB_burnStamp = game.time;

  if(!(player.burn>0)){
    if(CMB_burning) CMB_extinguish();
    return;
  }
  if(!player.alive || game.state!=='play'){ CMB_extinguish(); return; }

  const dps = AMMO[2].burnDps;
  let tick = dps*dt;
  if(tick > player.burn) tick = player.burn;
  player.burn -= tick;
  player.lastHurt = 0;                  // пока горишь — дыхание не восстанавливается
  if(NET_ACTIVE){
    /* Запас горения ведём локально (это наш «топливный бак»), а вот hp —
       сервера: копим списанное и заявляем пачкой раз в CMB_SELF_TICK.
       dmgTaken посчитает netDamage() по авторитетной разнице; burnTaken
       иначе не узнать ниоткуда — причина известна только здесь. */
    CMB_burnClaim += tick;
    CMB_burnAcc += dt;
    game.burnTaken = (game.burnTaken||0) + tick;
    if(CMB_burnAcc >= CMB_SELF_TICK || player.burn <= 1e-4) CMB_flushBurn();
  } else {
    player.hp -= tick;
    game.dmgTaken  = (game.dmgTaken||0)  + tick;
    game.burnTaken = (game.burnTaken||0) + tick;
  }

  // пламя живёт на игроке и колышется
  const fx = player.burnFx || (player.burnFx = CMB_makeBurnFx());
  if(!CMB_burning){ CMB_burning = true; setBurnHUD(true); }
  // в оптике FOV 7.5°, и спрайты у ног перекрыли бы весь кадр — там о горении
  // говорят виньетка и строка статуса
  fx.visible = wpn.sT < 0.6;
  fx.position.set(player.pos.x, player.pos.y, player.pos.z);
  const k = clamp(player.burn/26, 0.4, 1);
  for(let i=0;i<fx.children.length;i++){
    const s = fx.children[i], u = s.userData;
    s.scale.setScalar((0.40 + 0.20*Math.sin(game.time*13 + u.ph))*u.k*k);
    s.position.y = u.y0 + 0.10*Math.sin(game.time*7 + u.ph);
    s.material.opacity = 0.45 + 0.40*Math.abs(Math.sin(game.time*9 + u.ph*2));
  }

  // звук, искры и вспышка света — редкими тиками, чтобы не забивать кадр
  CMB_burnSfx -= dt;
  if(CMB_burnSfx <= 0){
    CMB_burnSfx = 0.5;
    SFX.burn();
    dmgFlash(12);
    FX.burst(CMB_v1.set(player.pos.x, player.pos.y+0.35, player.pos.z), 3,
             {mat:PMAT.fire||PMAT.spark, speed:2.0, life:0.55, size:0.07, s1:0.01, g:-2.4});
  }
  CMB_burnLight -= dt;
  if(CMB_burnLight <= 0){
    CMB_burnLight = 0.2;
    LIGHTS.flash(CMB_vL.set(player.pos.x, player.pos.y+0.7, player.pos.z), 0xff7a28, 1.6, 8, 0.26);
  }

  const hp = Math.max(0, Math.round(player.hp));
  if(hp !== CMB_hpShown){ CMB_hpShown = hp; updateHP(); }

  // добить себя горением может только сервер: локальная смерть в сети запрещена
  if(!NET_ACTIVE && player.hp <= 0){ CMB_cause = 'burn'; player.burn = 0; killPlayer(); return; }
  // гасим в том же кадре, в котором догорело: лишний кадр виньетки читается как залипание
  if(player.burn <= 1e-4){ CMB_extinguish(); return; }
  const left = Math.ceil(player.burn);
  if(left !== CMB_burnShown){ CMB_burnShown = left; setStatus('burn', 'ГОРИТ · '+left, '#ff8a3c'); }
}

/* Отправить накопленное горение. Отдельной функцией — её зовут и тик, и
   тушение: недоспавший остаток обязан уйти, иначе последняя доля урона
   пропадёт, и клиент с сервером разойдутся на пару очков здоровья. */
function CMB_flushBurn(){
  const d = CMB_burnClaim;
  CMB_burnClaim = 0; CMB_burnAcc = 0;
  if(!NET_ACTIVE || !(d > 0.05)) return;
  CMB_selfQuiet = performance.now();    // ответное 'dmg' отклик уже не дублирует
  CMB_reportSelf(d, 'burn');
}

/* Погасить: и логику, и эффект, и HUD. Зовут также startGame/endGame. */
function CMB_extinguish(){
  if(CMB_burnClaim > 0) CMB_flushBurn();
  CMB_burnClaim = 0; CMB_burnAcc = 0;
  player.burn = 0;
  CMB_burning = false;
  if(player.burnFx) player.burnFx.visible = false;
  CMB_burnShown = -1;
  setBurnHUD(false);
  clearStatus('burn');
}

/* ------------------------------ ПОДБОР ------------------------------ */
/* Ореол подсветки навешиваем сами и лениво: меши пикапов строит 45_map.js,
   лезть туда нельзя, а найти аптечку на верхнем ярусе без свечения тяжело. */
function CMB_pickHalo(p){
  const col = (p.type==='hp') ? 0x7ce89a : 0xffd479;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map:TEX_GLOW, color:col, blending:THREE.AdditiveBlending,
    depthWrite:false, transparent:true, opacity:0.12
  }));
  s.scale.setScalar(1.4);
  p.mesh.add(s);
  p.cmbHalo = s;
  p.cmbGlow = 0;
  p.cmbPop  = 1;
  // собственный масштаб группы задаёт 45_map.js — запоминаем и множим на него,
  // иначе анимация подбора «уравняет» все пикапы по размеру
  p.cmbScale = p.mesh.scale.x || 1;
}

/* Сколько лечит и сколько патронов даёт — одной формулой для обоих путей:
   офлайн применяет сразу, сеть — по подтверждению сервера. */
function CMB_healOf(p){ return (p.size==='m') ? 50 : 25; }
function CMB_giveAmmo(){
  let got = 0;
  for(let i=0;i<3;i++){
    if(wpn.res[i] < AMMO[i].resMax){
      const add = Math.min(AMMO[i].resMax - wpn.res[i], Math.ceil(AMMO[i].resMax*0.4));
      wpn.res[i] += add; got += add;
    }
  }
  return got;
}
/* Нужен ли предмет вообще. В сети это ещё и защита от пустой заявки: сервер
   отдал бы аптечку игроку с полным здоровьем и запустил её откат впустую. */
function CMB_wants(p){
  if(p.type==='hp') return player.hp < 100;
  for(let i=0;i<3;i++) if(wpn.res[i] < AMMO[i].resMax) return true;
  return false;
}
/* Отклик на подобранное: цифра, искры, кольцо, свет, звук.
   Цифра необязательна: в сети величину лечения знает только сервер, и по
   касанию её показывать нечем — пустую строку не рисуем. */
function CMB_takeFx(p, msg){
  const col = (p.type==='hp') ? 0x7ce89a : 0xffd479;
  CMB_v1.set(p.x, p.y+1.05, p.z);
  if(msg) FX.num(CMB_v1, msg, false);
  FX.magic(CMB_v1, 14, col);
  FX.ring(CMB_v2.set(p.x, p.y+0.18, p.z), 1.3, col);
  LIGHTS.flash(CMB_vL.set(p.x, p.y+0.8, p.z), col, 2.2, 9, 0.3);
  SFX.pickup(); SFX.chime(panOf(CMB_v1), 0.55*volOf(CMB_v1));
}
/* Спрятать предмет и завести откат возврата. Точное время возврата в сети
   пришлёт сервер в 'pick' — до тех пор держим свой, чтобы предмет не мигал. */
function CMB_hidePick(p){
  p.alive = false; p.cmbGlow = 0;
  if(p.mesh) p.mesh.visible = false;
  p.t = p.cd;
}

/* Подтверждение сервера на заявку разбирает 92_net.js: обработчик 'pick'
   зовёт netPickResult(i, mine, hp), и лечение/патроны накладывает ОН. Второго
   применителя здесь намеренно нет — два места, выдающие один и тот же предмет,
   рано или поздно выдадут его дважды. Наша половина §9.2 — заявка, пряталка
   предмета и отклик по касанию (см. updatePickups). */

function updatePickups(dt){
  const canTake = player.alive && game.state==='play';
  for(let pi=0; pi<PICKUPS.length; pi++){
    const p = PICKUPS[pi];
    const m = p.mesh;
    if(!m) continue;
    if(!p.cmbHalo) CMB_pickHalo(p);
    // предмет снова на месте (вернулся сам или его перезапустил рестарт) —
    // значит наша заявка отыграна в любом случае, ждать больше нечего
    if(p.alive && p.cmbReq) p.cmbReq = 0;

    if(!p.alive){
      p.t -= dt;
      if(p.t<=0){
        p.alive = true; m.visible = true; p.cmbPop = 0; p.cmbGlow = 0;
        CMB_v1.set(p.x, p.y+0.55, p.z);
        FX.magic(CMB_v1, 10, (p.type==='hp')?0x7ce89a:0xffd479);
        SFX.chime(panOf(CMB_v1), 0.45*volOf(CMB_v1));
      }
      continue;
    }

    /* Близость считаем и по вертикали: карта многоярусная, и ящик на мостике
       не должен подсвечиваться игроку, который стоит под мостиком. */
    let near = 0, reach = false;
    if(canTake){
      const dx = player.pos.x - p.x, dz = player.pos.z - p.z;
      const d2 = dx*dx + dz*dz;
      const cy = p.y + 0.55;                                  // центр пикапа
      // окно по вертикали: свой ярус (с запасом на прыжок и на ящик под ногами),
      // но не соседний — пикап на мостике сверху брать нельзя
      const sameLevel = cy > player.pos.y - 1.25 && cy < player.pos.y + player.h + 0.60;
      if(sameLevel && d2 < 34) near = clamp(1 - Math.sqrt(d2)/5.6, 0, 1);
      reach = sameLevel && d2 < 2.9;
    }
    p.cmbGlow = damp(p.cmbGlow, near, 8, dt);
    p.cmbPop  = damp(p.cmbPop, 1, 9, dt);

    // вращение и парение: у ног игрока предмет заметно оживает
    m.rotation.y += dt*(1.4 + p.cmbGlow*3.4);
    m.scale.setScalar(p.cmbScale*(0.55 + 0.45*p.cmbPop)*(1 + p.cmbGlow*0.14));
    m.position.y = p.y + 0.55 + Math.sin(game.time*2.4 + p.x)*0.08 + p.cmbGlow*0.10;
    const halo = p.cmbHalo;
    halo.material.opacity = 0.10 + p.cmbGlow*0.55 + 0.05*Math.sin(game.time*5 + p.z);
    halo.scale.setScalar(1.30 + p.cmbGlow*0.95 + 0.08*Math.sin(game.time*4 + p.x));

    if(!reach || p.cmbReq) continue;

    /* Сеть: эффект НЕ применяем — право на предмет арбитрирует сервер (§9.2).
       Шлём заявку и прячем предмет сразу, иначе подбор ощущается вязким;
       лечение и патроны выдаст netPickResult() из 92_net.js по ответу.
       Откажет сервер — предмет вернётся по своему откату.
       Отклик (искры, кольцо, свет, звук) даём по касанию: ждать его целый
       пинг — это и есть та самая вязкость. Цифру не показываем: величину
       лечения называет сервер, и соврать здесь хуже, чем промолчать. */
    if(NET_ACTIVE){
      if(!CMB_wants(p)) continue;
      p.cmbReq = 1;
      NET.reportPick(pi);
      CMB_hidePick(p);
      game.picks = (game.picks||0) + 1;   // счётчик итогов; отказы редки и погоды не делают
      CMB_takeFx(p, '');
      continue;
    }

    let took = false, msg = '';
    if(p.type==='hp'){
      const heal = CMB_healOf(p);
      if(player.hp < 100){
        const was = player.hp;
        player.hp = Math.min(100, player.hp + heal);
        msg = '+' + Math.round(player.hp - was);
        CMB_hpShown = Math.round(player.hp);
        updateHP();
        took = true;
        // аптечка сбивает пламя: лечиться, продолжая гореть, бессмысленно
        if(player.burn > 0){
          player.burn = Math.max(0, player.burn - heal*0.8);
          if(player.burn <= 0) CMB_extinguish();
        }
      }
    } else {
      const got = CMB_giveAmmo();
      if(got>0){ took = true; msg = '+'+got+' ПАТР.'; updateAmmoHUD(); }
    }

    if(took){
      CMB_hidePick(p);
      game.picks = (game.picks||0) + 1;
      CMB_takeFx(p, msg);
    }
  }
}

/* ------------------------------ HUD ------------------------------ */
/* $ и keys объявлены в 10_core.js; SLOTS наполняет bindUI() из 90_game.js */
let SLOTS = [];
