/* =====================================================================
   N3 · Удалённые игроки и реплики ботов (NETCONTRACT.md §6).

   Главная мысль модуля: на экране НИКОГДА не рисуется последний полученный
   снапшот. Пакеты приходят 20 раз в секунду, дорога до них неровная, и если
   ставить чужого бойца туда, где он «только что был», он будет дёргаться на
   любом пинге. Поэтому мы намеренно отстаём на NETP_DELAY мс и всегда имеем
   пару кадров ВОКРУГ времени отрисовки — между ними и интерполируем.
   Задержка стоит ровно столько, сколько стоит: чужой боец на 120 мс «в
   прошлом». Схема «попадание засчитывает стреляющий» это оплачивает —
   пуля проверяется по той же отрисованной позиции, которую видит игрок,
   поэтому дырок между «попал на экране» и «засчитали» не появляется.

   Что здесь принципиально:
   * кольцевой буфер кадров на каждого бойца, ноль аллокаций после ensure();
   * углы интерполируются по кратчайшей дуге (angDiff), а не покомпонентно:
     переход через ±π иначе разворачивает бойца через всю окружность;
   * при потере пакетов экстраполируем не больше NETP_EXTRAP мс и замираем —
     дальше врать вреднее, чем отстать;
   * поза считается из САМОЙ отрисованной траектории (скорость берём из
     разницы интерполированных позиций), поэтому походка не спорит с тем,
     что видно на экране.
   ===================================================================== */

/* Задержка отрисовки и потолок экстраполяции — в миллисекундах, как и
   серверное время NET.now(). Буфер на 24 кадра при 20 Гц — это ~1.2 с
   истории: с запасом и на джиттер, и на короткий провал связи. */
const NETP_DELAY  = 120;
const NETP_EXTRAP = 200;
const NETP_BUF    = 24;

/* Флаги состояния из §4. Дублируем у себя: лезть за ними в чужой модуль
   нельзя, а числа — часть протокола, а не чужого кода. */
const NETP_F_CROUCH = 1,  NETP_F_SLIDE  = 2,  NETP_F_LADDER = 4,   NETP_F_ZIP    = 8;
const NETP_F_SCOPE  = 16, NETP_F_DASH   = 32, NETP_F_GROUND = 64,  NETP_F_MANTLE = 128;

/* Коды состояний бота для поля st в сообщении 'bots'. Кодирует их отправитель,
   то есть 92_net.js, поэтому таблицу берём у него (NET.BOT_ST / NET.botState).
   Свою держим только как запасную: сборка без 92-го модуля не должна падать,
   а расхождение порядка — это молча замершие боты, худший вид ошибки. */
const NETP_ST = ['hold','settle','move','aim','shot','suppress','retreat','regroup','climb'];
function NETP_stName(st){
  if(typeof st === 'string') return st;
  const c = st | 0;
  const N = NETP_N();
  if(N){
    if(typeof N.botState === 'function') return N.botState(c) || 'hold';
    if(N.BOT_ST && N.BOT_ST[c]) return N.BOT_ST[c];
  }
  return NETP_ST[c] || 'hold';
}

const NETP_v1 = new THREE.Vector3(), NETP_v2 = new THREE.Vector3(), NETP_v3 = new THREE.Vector3();
/* Единственный объект результата segHit: он потребляется вызывающим сразу,
   до следующего вызова, а выделять его на каждую пулю нельзя. */
const NETP_hit = { t:0, part:'body', id:-1 };

const NETP_map  = new Map();   // id -> сущность
const NETP_list = [];          // те же сущности массивом: перебор без итератора
const NETP_bots = [];          // по индексу бота: {r, v} или null

/* Ссылку на транспорт ищем лениво: 92_net.js может вообще отсутствовать в
   сборке, и тогда обращение к NET — ReferenceError, а не undefined. */
let NETP_net = null;
function NETP_N(){
  if(NETP_net) return NETP_net;
  try { NETP_net = NET; } catch(e){ NETP_net = null; }
  return NETP_net;
}
function NETP_now(){
  const N = NETP_N();
  return (N && typeof N.now === 'function') ? N.now() : performance.now();
}

/* ------------------------------ КОМАНДЫ ------------------------------ */
/* Команда по проводу может прийти числом или строкой — нормализуем к 0/1. */
function NETP_teamId(t){
  if(t === 1 || t === '1' || t === 'red' || t === 'RED' || t === 'r') return 1;
  return 0;
}

/* ----------------------- ТАБЛИЧКА С ИМЕНЕМ -----------------------
   Спрайт с холстом. sizeAttenuation по умолчанию включён, поэтому вдали
   табличка сама уменьшается, а прозрачность добивает её до нуля: имя нужно
   в ближнем бою и мешало бы на дистанции снайперской работы. depthTest не
   отключаем — сквозь стену имён не видно, это не вол-хак. */
function NETP_mkLabel(name, team){
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 64;
  const g = cv.getContext('2d');
  const txt = String(name === undefined || name === null ? '?' : name).slice(0, 14).toUpperCase();
  g.font = '38px "Arial Black","Arial Bold",Impact,"Franklin Gothic Heavy","Noto Sans",sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineJoin = 'round'; g.lineWidth = 9;
  g.strokeStyle = 'rgba(0,0,0,0.85)';
  g.strokeText(txt, 128, 34);
  g.fillStyle = team ? '#ff9b90' : '#a6d6f2';
  g.fillText(txt, 128, 34);
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map:tex, transparent:true, depthWrite:false, opacity:1 }));
  sp.scale.set(1.6, 0.4, 1);
  sp.renderOrder = 5;
  return sp;
}

/* ------------------------- ОПОРНАЯ ПОЗА -------------------------
   Базовые смещения читаем из самой модели: 50_models.js живёт своей жизнью,
   и зашитые 0.86 / 1.24 однажды разъедутся. Ровно тем же приёмом пользуется
   70_ai.js — значит бот и удалённый игрок анимируются одинаково. */
function NETP_rest(U){
  const bolt = U.rifle.userData ? U.rifle.userData.bolt : null;
  return {
    hip:    U.hips.position.y,
    torso:  U.torso.position.y,
    head:   U.head.position.y - U.hips.position.y,
    armLY:  U.armL.A.position.y - U.hips.position.y,
    armRY:  U.armR.A.position.y - U.hips.position.y,
    rifleY: U.rifle.position.y - U.hips.position.y,
    rifleX: U.rifle.position.x, rifleZ: U.rifle.position.z,
    rifRx:  U.rifle.rotation.x,
    aLx: U.armL.A.rotation.x, aLy: U.armL.A.rotation.y, aLz: U.armL.A.rotation.z,
    aRx: U.armR.A.rotation.x, aRy: U.armR.A.rotation.y, aRz: U.armR.A.rotation.z,
    eLx: U.armL.E.rotation.x, eRx: U.armR.E.rotation.x,
    boltZ: bolt ? bolt.position.z : 0
  };
}
function NETP_poseRest(U, R){
  U.hips.position.y = R.hip; U.hips.rotation.set(0,0,0);
  U.torso.position.y = R.torso; U.torso.rotation.set(0,0,0);
  U.head.position.y = R.hip + R.head; U.head.rotation.set(0,0,0);
  U.legL.L.rotation.set(0,0,0); U.legR.L.rotation.set(0,0,0);
  U.legL.K.rotation.set(0,0,0); U.legR.K.rotation.set(0,0,0);
  U.armL.A.position.y = R.hip + R.armLY; U.armR.A.position.y = R.hip + R.armRY;
  U.armL.A.rotation.set(R.aLx, R.aLy, R.aLz);
  U.armR.A.rotation.set(R.aRx, R.aRy, R.aRz);
  U.armL.E.rotation.x = R.eLx; U.armR.E.rotation.x = R.eRx;
  U.rifle.position.set(R.rifleX, R.hip + R.rifleY, R.rifleZ);
  U.rifle.rotation.set(R.rifRx, 0, 0);
}

/* ------------------------- КОЛЬЦЕВОЙ БУФЕР ------------------------- */
function NETP_ring(){
  const b = new Array(NETP_BUF);
  for(let i=0;i<NETP_BUF;i++)
    b[i] = { k:0, x:0, y:0, z:0, yaw:0, pitch:0, h:CFG.height, f:0, hp:100, a:1, st:'hold' };
  return { b, head:-1, n:0 };
}
/* Опоздавший или повторный кадр молча роняем: с ним выборка начнёт скакать
   между двумя соседними снапшотами вместо того, чтобы ехать вперёд. */
function NETP_push(r, k){
  if(r.n > 0 && k <= r.b[r.head].k) return null;
  r.head = (r.head + 1) % NETP_BUF;
  if(r.n < NETP_BUF) r.n++;
  const fr = r.b[r.head];
  fr.k = k;
  return fr;
}
function NETP_idx(r, j){ return (r.head - j + NETP_BUF) % NETP_BUF; }

/* Результат выборки — один общий объект: он читается сразу после вызова. */
const NETP_S = { x:0, y:0, z:0, yaw:0, pitch:0, h:CFG.height, f:0, hp:100, a:1, st:'hold', ok:false };
function NETP_take(S, fr){
  S.x = fr.x; S.y = fr.y; S.z = fr.z;
  S.yaw = fr.yaw; S.pitch = fr.pitch; S.h = fr.h;
  S.f = fr.f; S.hp = fr.hp; S.a = fr.a; S.st = fr.st;
}
/* Состояние на момент rt (мс серверного времени). Три случая:
   1) rt внутри истории — линейная интерполяция пары соседних кадров;
   2) rt свежее всей истории — короткая экстраполяция по последней скорости;
   3) rt старше истории (только подключились) — самый старый кадр. */
function NETP_at(r, rt){
  const S = NETP_S;
  S.ok = false;
  if(r.n === 0) return S;
  S.ok = true;
  const b = r.b;

  let jA = -1;
  for(let j=0;j<r.n;j++) if(b[NETP_idx(r,j)].k <= rt){ jA = j; break; }

  if(jA < 0){ NETP_take(S, b[NETP_idx(r, r.n - 1)]); return S; }

  const A = b[NETP_idx(r, jA)];
  if(jA > 0){
    const B = b[NETP_idx(r, jA - 1)];
    const span = B.k - A.k;
    const u = span > 0 ? clamp((rt - A.k)/span, 0, 1) : 0;
    S.x = A.x + (B.x - A.x)*u;
    S.y = A.y + (B.y - A.y)*u;
    S.z = A.z + (B.z - A.z)*u;
    // углы — только по кратчайшей дуге, иначе на переходе через ±π боец
    // делает полный оборот вокруг себя
    S.yaw   = A.yaw   + angDiff(B.yaw,   A.yaw)*u;
    S.pitch = A.pitch + angDiff(B.pitch, A.pitch)*u;
    S.h = A.h + (B.h - A.h)*u;
    // дискретные поля берём из кадра «слева»: они не интерполируются
    S.f = A.f; S.hp = A.hp; S.a = A.a; S.st = A.st;
    return S;
  }

  // пакеты запаздывают: продлеваем движение, но недолго
  NETP_take(S, A);
  let dtE = rt - A.k;
  if(dtE <= 0) return S;
  if(dtE > NETP_EXTRAP) dtE = NETP_EXTRAP;   // дальше — замереть, а не улететь
  if(r.n >= 2){
    const P = b[NETP_idx(r, 1)];
    const span = A.k - P.k;
    // разрыв длиннее 400 мс — это не «шаг сетки», а провал связи: скорость
    // из него получится фантастическая
    if(span > 0 && span < 400){
      const k = dtE/span;
      S.x = A.x + (A.x - P.x)*k;
      S.y = A.y + (A.y - P.y)*k;
      S.z = A.z + (A.z - P.z)*k;
      // Углы НЕ продлеваем: додуманный разворот читается как рывок, а
      // отставший на 100 мс прицел не замечает никто.
    }
  }
  return S;
}

/* ---------------------------- СУЩНОСТЬ ----------------------------
   kind: 0 — удалённый игрок (есть флаги f), 1 — реплика бота (есть st). */
function NETP_view(kind){
  return {
    kind, U:null, R:null, m:null,
    x:0, y:0, z:0, yaw:0, pitch:0, h:CFG.height, f:0, st:'hold', pst:'hold', alive:true,
    walkT:0, crouch:0, aim:0, air:0, speed:0, moveYaw:0,
    px:0, pz:0, first:true, recoil:0, boltT:0, deadT:0, wasAlive:true,
    lasT:0, lasLen:20
  };
}

/* ------------------------------ ПОЗА ------------------------------
   Повторяет 70_ai.js: тот же набор узлов, те же коэффициенты. Так удалённый
   игрок и бот читаются на 100 м одинаково, а разница между ними — только
   в источнике данных (флаги против кода состояния). */
function NETP_poseBody(v, dt){
  const U = v.U, R = v.R;
  const ab = v.aim, carry = 1 - ab, cr = v.crouch, air = v.air;
  const gait = clamp(v.speed/6.2, 0, 1);
  const sw = Math.sin(v.walkT), sw2 = Math.cos(v.walkT);
  const amp = 0.16 + 0.78*gait;

  U.legL.L.rotation.x =  sw*amp - cr*0.95 + air*0.45;
  U.legR.L.rotation.x = -sw*amp - cr*0.95 - air*0.20;
  U.legL.K.rotation.x = Math.max(0, -sw*0.55)*amp + cr*1.65 + air*0.85;
  U.legR.K.rotation.x = Math.max(0,  sw*0.55)*amp + cr*1.65 + air*0.35;

  // Таз разворачивается по движению, корпус — по взгляду: бегущий боком и
  // смотрящий на тебя боец сразу читается как «меня заметили».
  const twist = (gait > 0.05) ? clamp(angDiff(v.moveYaw, v.yaw), -0.95, 0.95) : 0;
  U.hips.rotation.y = damp(U.hips.rotation.y, twist, 8, dt);
  U.hips.position.y = R.hip - cr*0.42 + gait*Math.abs(sw2)*0.05;
  U.torso.position.y = U.hips.position.y;

  const rp = v.pitch;
  U.torso.rotation.y = 0;
  U.torso.rotation.x = rp*0.32 + cr*0.22 + gait*0.16 - v.recoil*0.14;
  U.torso.rotation.z = -twist*0.10;

  U.head.position.y = U.hips.position.y + R.head;
  U.head.rotation.y = 0;
  U.head.rotation.x = rp*0.5 + ab*0.12 - gait*0.10;

  const aY = U.hips.position.y;
  U.armL.A.position.y = aY + R.armLY;
  U.armR.A.position.y = aY + R.armRY;

  // винтовка: к плечу при прицеливании, у бедра на бегу
  U.rifle.position.set(R.rifleX - carry*0.05, aY + R.rifleY - carry*0.15, R.rifleZ + carry*0.10);
  U.rifle.rotation.set(R.rifRx + rp*ab - carry*0.42 - v.recoil*0.30, 0, carry*0.30);

  const swing = sw*0.32*gait*carry;
  U.armR.A.rotation.set(R.aRx + carry*0.55 + swing + rp*0.6*ab, R.aRy, R.aRz);
  U.armL.A.rotation.set(R.aLx + carry*0.72 - swing + rp*0.6*ab, R.aLy, R.aLz);
  U.armR.E.rotation.x = R.eRx - carry*0.35;
  U.armL.E.rotation.x = R.eLx - carry*0.25;

  const bolt = U.rifle.userData ? U.rifle.userData.bolt : null;
  if(bolt){
    const total = AMMO[0].bolt;
    const k = v.boltT > 0 ? clamp(1 - v.boltT/Math.max(0.01, total), 0, 1) : 0;
    bolt.position.z = R.boltZ + Math.sin(k*Math.PI)*0.16;
  }
}
/* Лестница и трос: обе руки заняты, винтовка уходит за спину. Фазу перехвата
   берём от высоты, а не от таймера, — тогда руки идут в такт реальному подъёму
   даже когда кадры приходят рвано. */
function NETP_poseClimb(v, dt){
  const U = v.U, R = v.R;
  const s = Math.sin(v.y*3.2);
  U.hips.rotation.y = damp(U.hips.rotation.y, 0, 8, dt);
  U.hips.position.y = R.hip - 0.06;
  U.torso.position.y = U.hips.position.y;
  U.torso.rotation.set(0.22, 0, 0);
  U.head.position.y = U.hips.position.y + R.head;
  U.head.rotation.set(-0.22, 0, 0);
  U.legL.L.rotation.x = -0.55 + s*0.55;
  U.legR.L.rotation.x = -0.55 - s*0.55;
  U.legL.K.rotation.x = 0.95 - s*0.35;
  U.legR.K.rotation.x = 0.95 + s*0.35;
  const aY = U.hips.position.y;
  U.armL.A.position.y = aY + R.armLY;
  U.armR.A.position.y = aY + R.armRY;
  U.armL.A.rotation.set(-2.55 + s*0.55, 0, R.aLz*0.4);
  U.armR.A.rotation.set(-2.55 - s*0.55, 0, R.aRz*0.4);
  U.armL.E.rotation.x = -0.45;
  U.armR.E.rotation.x = -0.45;
  U.rifle.position.set(R.rifleX, aY + R.rifleY - 0.18, R.rifleZ + 0.34);
  U.rifle.rotation.set(0.5, 0, 1.25);
}

/* Кадр одного бойца: позиция, поза, телеграф. Данные к этому моменту уже
   интерполированы — поза считается по ним же, а не по сырому снапшоту. */
function NETP_draw(v, dt){
  const U = v.U, m = v.m;
  if(!U || !m) return;

  if(!v.alive){
    if(v.wasAlive){ v.wasAlive = false; v.deadT = 0; }
    v.deadT += dt;
    const k = clamp(v.deadT/0.5, 0, 1);
    m.visible = true;
    m.position.set(v.x, v.y + Math.sin(k*Math.PI)*0.12, v.z);
    m.rotation.set(-k*Math.PI/2*0.92, v.yaw, 0);
    U.laser.visible = false; U.dot.visible = false; U.glint.visible = false;
    return;
  }
  // Воскрес: после падения конечности вывернуты, и свежий боец появился бы
  // в позе трупа.
  if(!v.wasAlive){ v.wasAlive = true; v.first = true; NETP_poseRest(U, v.R); }

  m.visible = true;
  m.position.set(v.x, v.y, v.z);
  m.rotation.set(0, v.yaw, 0);

  /* Скорость берём из отрисованной траектории: так походка не спорит с тем,
     что видно на экране, и не зависит от того, шлёт ли сервер скорость. */
  let dx = v.x - v.px, dz = v.z - v.pz;
  if(v.first){ dx = 0; dz = 0; v.first = false; }
  v.px = v.x; v.pz = v.z;
  let dist = Math.hypot(dx, dz);
  if(dist > 3){ dist = 0; dx = 0; dz = 0; }      // респавн — это не пробежка
  const inst = dt > 1e-4 ? dist/dt : 0;
  v.speed = damp(v.speed, Math.min(inst, 14), 10, dt);
  if(dist > 0.004) v.moveYaw = Math.atan2(-dx, -dz);
  v.walkT += dist*3.4;
  // фаза шага не должна расти вечно: у float на больших числах шаг синуса
  // становится рваным, а матч идёт десятки минут
  if(v.walkT > 6.283185307) v.walkT %= 6.283185307;

  const player0 = (v.kind === 0);
  /* Присед считаем из ростовой отметки h — того самого числа, по которому
     потом проверяется попадание. Любой другой источник дал бы модель, которая
     не совпадает со своим габаритом. */
  let cT;
  if(player0){
    cT = clamp((CFG.height - v.h)/Math.max(0.01, CFG.height - CFG.crouchH), 0, 1);
    if(v.f & NETP_F_SLIDE) cT = 1;
  } else {
    cT = (v.h < CFG.height - 0.05) ? clamp((CFG.height - v.h)/0.42, 0, 1)
                                   : (v.st === 'suppress' ? 0.55 : 0);
  }
  v.crouch = damp(v.crouch, cT, 12, dt);

  const wantAim = player0 ? ((v.f & NETP_F_SCOPE) !== 0)
                          : (v.st === 'aim' || v.st === 'suppress' || v.st === 'shot');
  v.aim = damp(v.aim, wantAim ? 1 : 0, 7, dt);

  const wantAir = player0 ? ((v.f & NETP_F_GROUND) === 0) : false;
  v.air = damp(v.air, wantAir ? 1 : 0, 9, dt);

  v.recoil = Math.max(0, v.recoil - dt*4.2);
  v.boltT  = Math.max(0, v.boltT - dt);

  const climbing = player0 ? ((v.f & (NETP_F_LADDER | NETP_F_ZIP)) !== 0)
                           : (v.st === 'climb');
  if(climbing) NETP_poseClimb(v, dt);
  else NETP_poseBody(v, dt);

  if(player0){
    // луч и точка — телеграф бота, у живого игрока их быть не должно
    U.laser.visible = false; U.dot.visible = false;
    // блик оптики оставляем: он честно выдаёт того, кто смотрит в прицел
    NETP_glint(v, wantAim);
  } else NETP_telegraph(v, dt);
}

/* Блик объектива виден, только когда оптика смотрит примерно на камеру —
   ровно как у ботов: это подсказка «на тебя навелись», а не подсветка. */
function NETP_glint(v, on){
  const U = v.U;
  U.glint.visible = on;
  if(!on || !U.glint.material) return;
  NETP_v1.set(camera.position.x - v.x, camera.position.y - v.y, camera.position.z - v.z).normalize();
  NETP_v2.set(-Math.sin(v.yaw), 0, -Math.cos(v.yaw));
  const f = clamp((NETP_v1.dot(NETP_v2) - 0.88)*9, 0, 1);
  U.glint.material.opacity = f*(0.55 + 0.45*Math.sin(game.time*9));
}

/* Длина луча до первой преграды. Считать её каждый кадр на каждого бота
   дорого (перебор всех коробок), а на глаз разницы нет — обновляем 8 Гц. */
function NETP_rayLen(ox, oy, oz, dx, dy, dz){
  NETP_v1.set(ox, oy, oz);
  NETP_v2.set(dx, dy, dz);
  let t = 200;
  const rb = rayBoxes(NETP_v1, NETP_v2, t);   if(rb) t = rb.t;
  const rt = rayTerrain(NETP_v1, NETP_v2, t); if(rt) t = rt.t;
  return clamp(t, 0.5, 400);
}
/* Точка дула реплики — та же формула, что у Enemy.muzzle(): эффекты обязаны
   вылетать оттуда же, откуда у хоста. */
function NETP_muzzle(v, out){
  const cy = v.crouch*0.42;
  const gp = v.pitch, c = Math.cos(gp)*0.95;
  out.set(v.x - Math.sin(v.yaw)*c, v.y + 1.62 - cy + Math.sin(gp)*0.9, v.z - Math.cos(v.yaw)*c);
  return out;
}
function NETP_dir(v, out){
  const cp = Math.cos(v.pitch);
  return out.set(-Math.sin(v.yaw)*cp, Math.sin(v.pitch), -Math.cos(v.yaw)*cp);
}

/* Телеграф реплики бота. У не-хоста ИИ молчит, а игрок обязан получать тот же
   шанс среагировать, что и в одиночной игре: луч, точка, блик. */
function NETP_telegraph(v, dt){
  const U = v.U;
  const show = (v.st === 'aim' || v.st === 'suppress');
  U.laser.visible = show; U.dot.visible = show;
  if(show){
    v.lasT -= dt;
    if(v.lasT <= 0){
      v.lasT = 0.12;
      NETP_muzzle(v, NETP_v3); NETP_dir(v, NETP_v1);
      v.lasLen = NETP_rayLen(NETP_v3.x, NETP_v3.y, NETP_v3.z, NETP_v1.x, NETP_v1.y, NETP_v1.z);
    }
    const d = v.lasLen;
    U.laser.scale.y = d;
    U.laser.position.set(0, 0.02, -1.02 - d/2);
    if(U.laser.material) U.laser.material.opacity = 0.34;
    NETP_muzzle(v, NETP_v3); NETP_dir(v, NETP_v1);
    U.dot.position.set(NETP_v3.x + NETP_v1.x*d, NETP_v3.y + NETP_v1.y*d, NETP_v3.z + NETP_v1.z*d);
    U.dot.scale.setScalar(0.30 + 0.20*Math.sin(game.time*22));
  }
  NETP_glint(v, v.st === 'aim' || v.st === 'suppress');
}

/* ------------------------- ВЫСТРЕЛ ЧУЖОГО -------------------------
   Пуля чужого бойца у нас не летит: попадание считает тот, кто стрелял.
   Но выстрел обязан быть слышен и виден — иначе снайпер бьёт из ниоткуда. */
function NETP_shotFx(ox, oy, oz, dx, dy, dz, ammoIdx){
  const a = AMMO[ammoIdx|0] || AMMO[0];
  NETP_v1.set(ox, oy, oz);
  const len = NETP_rayLen(ox, oy, oz, dx, dy, dz);
  NETP_v2.set(ox + dx*len, oy + dy*len, oz + dz*len);
  if(FX && typeof FX.tracer === 'function') FX.tracer(NETP_v1, NETP_v2, a.trail, 0.09);
  if(FX && typeof FX.burst === 'function')
    FX.burst(NETP_v1, 4, { mat:PMAT.smoke, speed:2.2, life:0.5, size:0.09, s1:0.2, g:-0.7 });
  if(typeof LIGHTS !== 'undefined' && LIGHTS && typeof LIGHTS.flash === 'function')
    LIGHTS.flash(NETP_v1, 0xffcf8a, 2.6, 13, 0.07);
  const d = NETP_v1.distanceTo(camera.position);
  SFX.shot(a.id, panOf(NETP_v1), volOf(NETP_v1)*0.9, Math.min(0.9, d/340));
}

/* --------------------------- РЕПЛИКИ БОТОВ ---------------------------
   У не-хоста enemies[] не симулируются (90_game.js это уже делает), но их
   модели и габариты обязаны жить: пуля игрока проверяется по enemies[i]
   штатным Enemy.segHit(), поэтому pos/yaw/crouch/alive мы синхронизируем
   с той же задержкой 120 мс, что и всё остальное. */
function NETP_botsOn(){
  const N = NETP_N();
  return !!(N && N.on && !N.host);
}
function NETP_updBots(rt, dt){
  for(let i=0;i<NETP_bots.length;i++){
    const B = NETP_bots[i];
    if(!B) continue;
    const e = enemies[i];
    if(!e || !e.m) continue;
    const v = B.v;
    // startGame() пересоздаёт ботов — модель под индексом могла смениться
    if(v.m !== e.m){ v.m = e.m; v.U = e.m.userData; v.R = NETP_rest(v.U); v.first = true; }

    const S = NETP_at(B.r, rt);
    if(!S.ok) continue;
    v.x = S.x; v.y = S.y; v.z = S.z;
    v.yaw = S.yaw; v.pitch = S.pitch; v.h = S.h; v.st = S.st;
    v.alive = (S.a === 1);

    // Выстрел ловим по смене состояния: отдельного сообщения на выстрел бота
    // в протоколе нет, а 'shot' в снапшоте держится целый цикл затвора.
    if(v.st === 'shot' && v.pst !== 'shot' && v.alive){
      NETP_muzzle(v, NETP_v3); NETP_dir(v, NETP_v1);
      NETP_shotFx(NETP_v3.x, NETP_v3.y, NETP_v3.z, NETP_v1.x, NETP_v1.y, NETP_v1.z, 0);
      v.recoil = 1; v.boltT = AMMO[0].bolt;
    }
    v.pst = v.st;

    NETP_draw(v, dt);

    e.pos.set(v.x, v.y, v.z);
    e.yaw = v.yaw; e.pitch = v.pitch; e.h = v.h;
    e.alive = v.alive;
    // cy() решает габарит попадания — берём ровно тот присед, что нарисован
    e.crouch = v.crouch;
  }
}

/* --------------------------- ОСВОБОЖДЕНИЕ ---------------------------
   Геометрию и общие материалы модели не трогаем: они лежат в кэше 50_models.js
   и делятся между всеми бойцами. Своё у экземпляра — только материалы луча,
   точки, блика и холст таблички. */
function NETP_freeModel(E){
  const U = E.v.U;
  if(U){
    if(U.dot){ scene.remove(U.dot); if(U.dot.material) U.dot.material.dispose(); }
    if(U.laser && U.laser.material) U.laser.material.dispose();
    if(U.glint && U.glint.material) U.glint.material.dispose();
  }
  if(E.v.m) scene.remove(E.v.m);
  E.v.m = null; E.v.U = null; E.v.R = null;
}
function NETP_freeLabel(E){
  if(!E.label) return;
  if(E.label.parent) E.label.parent.remove(E.label);
  if(E.label.material){
    if(E.label.material.map) E.label.material.map.dispose();
    E.label.material.dispose();
  }
  E.label = null;
}
/* Тело бойца в цвете своей команды. Буфер кадров при пересборке не трогаем:
   он живёт отдельно от картинки, и терять историю из-за смены цвета глупо. */
function NETP_build(E){
  const t = E.team;
  const m = mkSniper(t ? PAL.red : PAL.blu, t ? PAL.redDk : PAL.bluDk);
  scene.add(m);
  const v = E.v;
  v.m = m; v.U = m.userData; v.R = NETP_rest(v.U);
  // луч и точка — телеграф бота, живому игроку они не полагаются
  v.U.laser.visible = false; v.U.dot.visible = false; v.U.glint.visible = false;
  v.first = true; v.wasAlive = true;
  // до первого снапшота бойца не показываем: иначе он мигнёт в нуле карты
  m.visible = false;
  E.label = NETP_mkLabel(E.name, t);
  E.labelName = E.name;
  m.add(E.label);
}
function NETP_freeEnt(E){ NETP_freeLabel(E); NETP_freeModel(E); }

/* ================================ NETP ================================ */
const NETP = {
  /* насколько отстаём от сервера — наружу для отладки и HUD */
  delay: NETP_DELAY,
  /* Своих не бьём: сервер всё равно отклонит заявку, а пуля, застрявшая в
     союзнике, испортит выстрел по-настоящему. Если команда неизвестна
     (нет welcome), проверка отключается сама — иначе стрелять станет не в кого. */
  friendlyFire: false,
  ST: NETP_ST,

  /* Идемпотентна: снапшот легко обгоняет 'join', и тогда боец заводится с
     командой по умолчанию, а настоящую мы узнаём вторым вызовом. Цвет модели
     решает, в кого можно стрелять, поэтому расхождение чиним пересборкой. */
  ensure(id, team, name){
    const t = (team === undefined || team === null) ? null : NETP_teamId(team);
    const nm = (name === undefined || name === null) ? null : String(name);
    let E = NETP_map.get(id);
    if(E){
      const teamChanged = (t !== null && t !== E.team);
      if(t !== null) E.team = t;
      if(nm !== null) E.name = nm;
      if(teamChanged){ NETP_freeLabel(E); NETP_freeModel(E); NETP_build(E); }
      else if(E.name !== E.labelName){
        NETP_freeLabel(E);
        E.label = NETP_mkLabel(E.name, E.team);
        E.labelName = E.name;
        E.v.m.add(E.label);
      }
      return E;
    }
    E = {
      id, team: (t === null) ? 0 : t,
      name: (nm === null) ? ('ИГРОК ' + id) : nm,
      labelName: null,
      v: NETP_view(0), r: NETP_ring(), label: null
    };
    NETP_build(E);
    NETP_map.set(id, E);
    NETP_list.push(E);
    return E;
  },

  drop(id){
    const E = NETP_map.get(id);
    if(!E) return;
    NETP_freeEnt(E);
    NETP_map.delete(id);
    const i = NETP_list.indexOf(E);
    if(i >= 0) NETP_list.splice(i, 1);
  },

  get(id){ return NETP_map.get(id) || null; },
  count(){ return NETP_list.length; },

  /* Кадр игроков. kServer — серверное время снапшота, общее на весь список. */
  applySnap(list, kServer){
    if(!list || !list.length) return;
    const N = NETP_N();
    const self = N ? N.id : -1;
    for(let i=0;i<list.length;i++){
      const s = list[i];
      if(!s) continue;
      const id = s.i;
      if(id === self) continue;
      let E = NETP_map.get(id);
      if(!E){
        // снапшот может обогнать 'join' — терять из-за этого бойца нельзя
        let team = (s.tm === undefined) ? 0 : s.tm, name = null;
        if(N && N.players && typeof N.players.get === 'function'){
          const p = N.players.get(id);
          if(p){ if(p.team !== undefined) team = p.team; if(p.name) name = p.name; }
        }
        E = this.ensure(id, team, name);
      }
      const fr = NETP_push(E.r, kServer);
      if(!fr) continue;
      fr.x = s.x; fr.y = s.y; fr.z = s.z;
      fr.yaw = s.yaw || 0; fr.pitch = s.pitch || 0;
      fr.h = (s.h === undefined) ? CFG.height : s.h;
      fr.f = s.f | 0;
      fr.hp = (s.hp === undefined) ? 100 : s.hp;
      fr.a = (s.a === undefined || s.a) ? 1 : 0;
      fr.st = 'hold';
    }
  },

  /* Кадр ботов от хоста. Индекс i — это индекс в enemies[]. */
  applyBots(list, kServer){
    if(!list || !list.length) return;
    for(let i=0;i<list.length;i++){
      const s = list[i];
      if(!s) continue;
      const bi = s.i | 0;
      if(bi < 0 || bi > 63) continue;
      let B = NETP_bots[bi];
      if(!B){
        B = { r: NETP_ring(), v: NETP_view(1) };
        NETP_bots[bi] = B;
      }
      const fr = NETP_push(B.r, kServer);
      if(!fr) continue;
      fr.x = s.x; fr.y = s.y; fr.z = s.z;
      fr.yaw = s.yaw || 0; fr.pitch = s.pitch || 0;
      fr.h = (s.h === undefined) ? CFG.height : s.h;
      fr.f = 0;
      fr.hp = 100;
      fr.a = (s.a === undefined || s.a) ? 1 : 0;
      fr.st = NETP_stName(s.st);
    }
  },

  /* Чужой выстрел: трассер, дым, вспышка, звук. Пуля не летит — попадание
     засчитывает стреляющий у себя. */
  shot(id, ammoIdx, ox, oy, oz, dx, dy, dz, chg){
    NETP_shotFx(ox, oy, oz, dx, dy, dz, ammoIdx);
    const E = NETP_map.get(id);
    if(E){
      E.v.recoil = 1;
      E.v.boltT = (AMMO[ammoIdx|0] || AMMO[0]).bolt;
    }
  },

  /* Кадр: выборка с задержкой, поза, таблички, реплики ботов. */
  update(dt){
    if(!(dt > 0)) dt = 0;
    const rt = NETP_now() - NETP_DELAY;

    for(let i=0;i<NETP_list.length;i++){
      const E = NETP_list[i], v = E.v;
      const S = NETP_at(E.r, rt);
      if(!S.ok){ v.m.visible = false; if(E.label) E.label.visible = false; continue; }
      v.x = S.x; v.y = S.y; v.z = S.z;
      v.yaw = S.yaw; v.pitch = S.pitch; v.h = S.h; v.f = S.f;
      v.alive = (S.a === 1);
      E.hp = S.hp;
      NETP_draw(v, dt);

      // Табличка: гаснет с расстоянием и сидит выше макушки, чтобы не
      // перекрывать голову тому, кто целится.
      const lab = E.label;
      if(lab){
        // высоту держим всегда, а не только пока табличка видна: иначе после
        // приседа или смерти она всплывает не там, где её ждут
        lab.position.set(0, v.h + 0.42, 0);
        if(!v.alive) lab.visible = false;
        else {
          const d = NETP_v1.set(v.x, v.y + v.h, v.z).distanceTo(camera.position);
          const o = clamp((48 - d)/14, 0, 1);
          lab.visible = o > 0.02;
          if(lab.visible) lab.material.opacity = o*0.92;
        }
      }
    }

    if(NETP_botsOn()) NETP_updBots(rt, dt);
  },

  /* Попадание пули в удалённого игрока. Габариты — те же, что у segPlayer()
     в 60_weapon.js, и берутся от ТОЙ ЖЕ интерполированной позиции, которую
     видит стреляющий: в этом весь смысл схемы «попадание засчитывает
     стреляющий». Ноль аллокаций: результат кладём в общий объект. */
  segHit(p0, dir, len){
    let bt = len, part = null, id = -1;
    const N = NETP_N();
    const myTeam = (N && N.team !== undefined && N.team !== null) ? NETP_teamId(N.team) : -1;
    const noFF = (this.friendlyFire === false) && (myTeam >= 0);
    for(let i=0;i<NETP_list.length;i++){
      const E = NETP_list[i], v = E.v;
      if(!v.alive) continue;
      if(noFF && E.team === myTeam) continue;
      const h = v.h;
      let t = segSphere(p0, dir, bt, v.x, v.y + h - 0.20, v.z, 0.235);
      let pp = 'head';
      if(t < 0){
        t = segOBB(p0, dir, bt, v.x, v.y + h*0.52, v.z, 0.33, h*0.40, 0.27, v.yaw);
        pp = 'body';
      }
      if(t >= 0 && t < bt){ bt = t; part = pp; id = E.id; }
    }
    if(part === null) return null;
    NETP_hit.t = bt; NETP_hit.part = part; NETP_hit.id = id;
    return NETP_hit;
  },

  /* Выход из сети или рестарт: своих бойцов сносим, ботов возвращаем ИИ
     в нормальном виде — иначе после отключения на карте останутся лежащие
     и невидимые реплики. */
  reset(){
    for(let i=0;i<NETP_list.length;i++) NETP_freeEnt(NETP_list[i]);
    NETP_list.length = 0;
    NETP_map.clear();
    for(let i=0;i<NETP_bots.length;i++){
      const B = NETP_bots[i];
      if(!B) continue;
      const e = enemies[i];
      if(e && e.m){
        e.m.visible = true;
        e.m.rotation.set(0, e.yaw, 0);
        const U = e.m.userData;
        U.laser.visible = false; U.dot.visible = false; U.glint.visible = false;
        NETP_poseRest(U, B.v.R || NETP_rest(U));
      }
      NETP_bots[i] = null;
    }
    NETP_bots.length = 0;
  }
};
