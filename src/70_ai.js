/* =====================================================================
   ПРОТИВНИКИ v3 — командный слой (SQUAD) и боец (Enemy).

   Главная мысль: трое-пятеро RED должны читаться как отделение, а не как
   три одиночки, случайно оказавшихся рядом. Поэтому знание о цели общее
   (SQUAD.lastKnown), роли раздаются сверху, а пеленги подхода разводятся,
   чтобы игрока брали в клещи, а не набегали колонной по одной тропе.

   Честность важнее «умности». Телеграф (луч + блик оптики) обязателен,
   а D.err / D.react / D.lead не срезаются ни при каких обстоятельствах:
   бот, который стреляет без предупреждения, ощущается как читер, даже
   если формально он «умный».
   ===================================================================== */

const enemies = [];
const flyingHats = [];

/* Временные вектора модуля. Свои, а не _t1.._t4 из 60_weapon.js: panOf()
   и volOf() внутри затирают _t3/_t4, и ловить это в кадре — себе дороже. */
const AI_v1 = new THREE.Vector3(), AI_v2 = new THREE.Vector3(), AI_v3 = new THREE.Vector3(),
      AI_v4 = new THREE.Vector3(), AI_v5 = new THREE.Vector3();
const AI_live = [];                       // живые боты текущего тика SQUAD
const AI_bearUsed = [0,0,0,0,0,0,0,0];    // занятые пеленги при охвате
const AI_candP = [null,null,null,null];   // финалисты отбора позиции
const AI_candS = [0,0,0,0];

/* Паркурный API (A) и пул света (E1) доделываются параллельно. Ждать их
   нельзя, а падать из-за отсутствующего имени — тем более: возможности
   проверяем один раз и дальше работаем по флагу. */
let AI_capClimb = -1, AI_capMantle = -1, AI_capLight = -1;

function AI_climbAt(x, z, y){
  if(AI_capClimb < 0) AI_capClimb = (typeof climbAt === 'function' && typeof climbStep === 'function') ? 1 : 0;
  return AI_capClimb ? climbAt(x, z, y) : null;
}
function AI_climbStep(e, dt, up){
  if(AI_capClimb < 0) AI_capClimb = (typeof climbAt === 'function' && typeof climbStep === 'function') ? 1 : 0;
  return AI_capClimb ? climbStep(e, dt, up) : false;
}
function AI_mantleFind(e, dx, dz){
  if(AI_capMantle < 0) AI_capMantle = (typeof mantleFind === 'function') ? 1 : 0;
  return AI_capMantle ? mantleFind(e, dx, dz) : null;
}
function AI_flash(p, col, inten, dist, life){
  if(AI_capLight < 0) AI_capLight = (typeof LIGHTS !== 'undefined' && LIGHTS && typeof LIGHTS.flash === 'function') ? 1 : 0;
  if(AI_capLight) LIGHTS.flash(p, col, inten, dist, life);
}

/* Сектор карты по контракту §3.4 — та же формула, что и у POSTS.sector. */
function AI_sec(x, z){
  const s = Math.floor(((Math.atan2(z, x) + Math.PI) / (Math.PI*2)) * 8);
  return ((s % 8) + 8) % 8;
}
/* Пеленг «откуда смотреть на цель» — сектор вокруг самой цели, а не вокруг
   центра карты. Именно им разводят ботов при окружении. */
function AI_bearSec(px, pz, x, z){
  const s = Math.floor(((Math.atan2(z - pz, x - px) + Math.PI) / (Math.PI*2)) * 8);
  return ((s % 8) + 8) % 8;
}
function AI_secDist(a, b){ const d = Math.abs(a - b) % 8; return d > 4 ? 8 - d : d; }

/* POSTS может ещё не иметь полей v3 (их добавляет B) — читаем с запасом. */
function AI_postY(p){ return (p.y === undefined) ? gh(p.x, p.z) : p.y; }
function AI_postLevel(p){ return (p.level === undefined) ? 0 : p.level; }
function AI_postCover(p){ return (p.cover === undefined) ? 0.5 : p.cover; }
function AI_postSec(p){ return (p.sector === undefined) ? AI_sec(p.x, p.z) : p.sector; }

/* Насколько точка накрыта очагом огня: 0 — чисто, 1 — стоим в центре.
   Читаем FX.pools осторожно: структура принадлежит E3. */
function AI_fireAt(x, z, y, out){
  const P = (typeof FX !== 'undefined' && FX) ? FX.pools : null;
  if(!P || !P.length) return 0;
  let worst = 0;
  for(let i=0;i<P.length;i++){
    const f = P[i];
    if(!f || !f.p) continue;
    const R = (f.r || 3.2) + 1.5;
    const d = Math.hypot(x - f.p.x, z - f.p.z);
    if(d >= R || Math.abs(y - f.p.y) > 3.2) continue;
    const k = 1 - d/R;
    if(k > worst){ worst = k; if(out) out.copy(f.p); }
  }
  return worst;
}

function AI_byRank(a, b){ return a._rank - b._rank; }

/* ================================ ЦЕЛИ ================================
   Раньше боец знал ровно одного противника — локального `player`. В сети это
   значит, что для ИИ существует только хост, а остальные трое просто гуляют
   по карте: половина режима перестаёт работать (NETCONTRACT §9.4).

   Поэтому всё восприятие переведено на «цель» — одинаковый взгляд на игрока,
   откуда бы он ни брался: локальный из 60_weapon.js или удалённый из NETP.
   Офлайн список ровно из одной записи и повторяет прежние поля один в один,
   поэтому при NET.on === false ни одна формула не меняется.

   Команда решает, кто кому враг: боты играют за RED, значит игроки RED для
   них союзники, и стрелять по ним нельзя ни при каких обстоятельствах. */
const AI_TEAM  = 1;              // команда ботов (RED)
const AI_tgts  = [];             // цели текущего кадра
const AI_tpool = [];             // сами записи: заводятся только на новых игроков
const AI_ids   = [];             // id удалённых; пересобираем редко, не каждый кадр
let AI_tgAt = -1e9, AI_idsAt = -1e9;

/* Сеть опциональна: сборки без 92/94 обязаны работать. Проверяем наличие
   имён один раз, дальше читаем дешёвый флаг кадра из 90_game.js. */
let AI_capNet = -1;
function AI_netOn(){
  if(AI_capNet < 0){
    try {
      AI_capNet = (typeof NET_ACTIVE !== 'undefined' && typeof NET !== 'undefined' && NET &&
                   typeof NETP !== 'undefined' && NETP && typeof NETP.get === 'function' &&
                   NET.players && typeof NET.players.forEach === 'function') ? 1 : 0;
    } catch(e){ AI_capNet = 0; }
  }
  return AI_capNet === 1 && NET_ACTIVE === true && NET.on === true;
}
/* Ботов симулирует только хост — значит и сетевые пути ИИ живут только у него. */
function AI_isHost(){ return AI_netOn() && NET.host === true; }

/* Команда по проводу приходит числом или строкой — приводим к 0/1 у себя:
   лезть за нормализацией в чужой модуль нельзя, а число — часть протокола. */
function AI_teamOf(t){
  return (t === 1 || t === '1' || t === 'red' || t === 'RED' || t === 'r') ? 1 : 0;
}
function AI_foe(t){ return t.team !== AI_TEAM; }

/* Запись цели живёт столько же, сколько игрок: ссылку на неё боец держит
   между кадрами, поэтому переиспользовать слот под другого игрока нельзя. */
function AI_tgRec(id){
  for(let i=0;i<AI_tpool.length;i++) if(AI_tpool[i].id === id) return AI_tpool[i];
  const r = { id, pid:-1, kind:0, team:0, alive:true, on:false, n:0, at:-1e9,
              x:0, y:0, z:0, h:CFG.height, yaw:0, scoped:false,
              vx:0, vy:0, vz:0, px:0, py:0, pz:0 };
  AI_tpool.push(r);
  return r;
}
const AI_idPush = function(p){
  if(p && p.id !== undefined && p.id !== NET.id) AI_ids.push(p.id);
};

function AI_syncRemote(){
  // Ростер меняется на порядки реже, чем идут кадры: перебирать Map шестьдесят
  // раз в секунду ради четырёх записей незачем.
  if(game.time - AI_idsAt > 0.5 || AI_idsAt > game.time){
    AI_idsAt = game.time;
    AI_ids.length = 0;
    NET.players.forEach(AI_idPush);
  }
  for(let i=0;i<AI_ids.length;i++){
    const id = AI_ids[i];
    const E = NETP.get(id);
    if(!E || !E.v) continue;
    const v = E.v;
    // До первого снапшота реплика невидима и стоит в нуле координат: такой
    // «игрок» существует только на бумаге, целью ему быть нельзя.
    if(!v.m || v.m.visible !== true) continue;
    if(!isFinite(v.x) || !isFinite(v.y) || !isFinite(v.z)) continue;
    const p = NET.players.get(id);
    const r = AI_tgRec(id);
    const el = game.time - r.at;
    r.kind = 1; r.on = true; r.pid = id;
    r.team = AI_teamOf((E.team === undefined || E.team === null) ? (p ? p.team : 0) : E.team);
    r.alive = (v.alive !== false) && (!p || p.alive !== false);
    r.h = v.h; r.yaw = v.yaw;
    // Скорость по проводу не ходит, а упреждению она нужна. Считаем её по той
    // же отрисованной траектории, по которой цель видно на экране, и сглаживаем:
    // на стыке снапшотов разностная скорость прыгает и врёт сильнее самой цели.
    if(el > 1e-4 && el < 0.35){
      const k = 1/el;
      r.vx += ((v.x - r.px)*k - r.vx)*0.35;
      r.vy += ((v.y - r.py)*k - r.vy)*0.35;
      r.vz += ((v.z - r.pz)*k - r.vz)*0.35;
    } else { r.vx = 0; r.vy = 0; r.vz = 0; }
    r.px = v.x; r.py = v.y; r.pz = v.z;
    r.x = v.x; r.y = v.y; r.z = v.z;
    r.scoped = (v.f & 16) !== 0;      // 16 — «в оптике» из §4: в прицеле цель заметнее
    r.at = game.time;
    AI_tgts.push(r);
  }
}

/* Список целей кадра. Собирается один раз: игрок за кадр никуда не уходит,
   а перебирать сеть на каждого бота — лишняя работа на ровном месте. */
function AI_syncTargets(){
  AI_tgAt = game.time;
  for(let i=0;i<AI_tgts.length;i++) AI_tgts[i].on = false;
  AI_tgts.length = 0;

  const net = AI_netOn();
  const L = AI_tgRec(-1);
  L.kind = 0; L.on = true; L.at = game.time;
  L.pid  = net ? NET.id : -1;
  // В сети хост может играть и за RED — тогда боты его не трогают.
  L.team = net ? AI_teamOf(NET.team) : 0;
  L.alive = player.alive;
  L.x = player.pos.x; L.y = player.pos.y; L.z = player.pos.z;
  L.h = player.h; L.yaw = player.yaw;
  L.vx = player.vel.x; L.vy = player.vel.y; L.vz = player.vel.z;
  L.scoped = (wpn.sT > 0.6);
  AI_tgts.push(L);

  if(net) AI_syncRemote();

  // Сколько бойцов уже смотрит на каждую цель — этим внимание и разводится.
  for(let i=0;i<AI_tgts.length;i++) AI_tgts[i].n = 0;
  for(let i=0;i<enemies.length;i++){
    const e = enemies[i];
    if(e && e.alive && e.tgt && e.tgt.on) e.tgt.n++;
  }
}
function AI_targets(){
  if(AI_tgAt !== game.time) AI_syncTargets();
  return AI_tgts;
}

/* Габариты цели — те же, что у segPlayer() в 60_weapon.js: считаем от роста
   самой цели, а не от константы, иначе присед и труп «уезжают». */
function AI_tgEye(t, o){ return o.set(t.x, t.y + t.h - CFG.eye, t.z); }
function AI_tgCenter(t, o){ return o.set(t.x, t.y + t.h*0.55, t.z); }
/* Точка прицеливания в голову — чуть ниже макушки: это не габарит хитбокса,
   а куда бот целит, когда решил бить в голову. */
function AI_tgHeadY(t){ return t.y + t.h - 0.22; }

/* На ком сосредоточено отделение. Офлайн это всегда локальный игрок, поэтому
   все формулы SQUAD ниже совпадают с прежними до последнего знака. */
function AI_focus(){
  const T = AI_targets();
  const f = SQUAD.focus;
  if(f && f.on && f.alive && AI_foe(f)) return f;
  for(let i=0;i<T.length;i++) if(T[i].alive && AI_foe(T[i])) return T[i];
  for(let i=0;i<T.length;i++) if(AI_foe(T[i])) return T[i];
  return null;
}
/* Ближайший противник к точке. live=false берёт и мёртвых: спавниться рядом
   с местом, где только что был бой, всё равно не стоит. */
function AI_nearFoe(x, z, live){
  const T = AI_targets();
  let best = null, bd = 1e18;
  for(let i=0;i<T.length;i++){
    const t = T[i];
    if(!AI_foe(t) || (live && !t.alive)) continue;
    const dx = t.x - x, dz = t.z - z, d = dx*dx + dz*dz;
    if(d < bd){ bd = d; best = t; }
  }
  return best;
}

/* ========================= ПУЛИ БОТОВ В СЕТИ =========================
   60_weapon.js проверяет пулю бота только против ЛОКАЛЬНОГО игрока —
   удалённых там нет и быть не может: их позиции живут у NETP, и знает о них
   только этот модуль. Поэтому попадания по чужим досчитываем сами, теми же
   габаритами и по той же отрисованной позиции, которую видит хост.

   Урон при этом не списывается никому: уходит заявка 'bhit', а решает сервер
   (§9.1 — здоровьем владеет только он). Попадание в локального игрока на
   хосте тоже обязано уйти на сервер, иначе комната не узнает о нём вовсе.
   Всё это работает исключительно у хоста: у остальных ИИ не симулируется. */
const AI_SHOT_MAX = 24;                  // столько пуль ботов разом не бывает
const AI_shots = [];                     // {b, x, y, z} — пуля и её позиция в прошлом кадре
const AI_s1 = new THREE.Vector3(), AI_s2 = new THREE.Vector3(), AI_s3 = new THREE.Vector3();
const AI_bloodFx = { mat:null, speed:4, life:0.5, size:0.08 };   // литерал один на все попадания

function AI_trackShot(b){
  if(!b) return;
  let s = null;
  for(let i=0;i<AI_shots.length;i++) if(!AI_shots[i].b){ s = AI_shots[i]; break; }
  if(!s){
    if(AI_shots.length >= AI_SHOT_MAX) return;
    s = { b:null, x:0, y:0, z:0, at:0 };
    AI_shots.push(s);
  }
  s.b = b; s.x = b.pos.x; s.y = b.pos.y; s.z = b.pos.z; s.at = game.time;
}
function AI_dropShots(){ for(let i=0;i<AI_shots.length;i++) AI_shots[i].b = null; }

/* Заявка на урон игроку. Крит считаем той же формулой, что и 60_weapon.js для
   попадания в игрока (голова ×1.65), иначе сервер увидит два разных урона за
   одно и то же попадание. */
function AI_hitScan(b, o, d, len){
  const T = AI_targets();
  let bt = len, part = null, tg = null;
  for(let i=0;i<T.length;i++){
    const t = T[i];
    if(!t.alive || !AI_foe(t)) continue;
    const h = t.h;
    let p = 'head';
    let tt = segSphere(o, d, bt, t.x, t.y + h - 0.20, t.z, 0.235);
    if(tt < 0){
      tt = segOBB(o, d, bt, t.x, t.y + h*0.52, t.z, 0.33, h*0.40, 0.27, t.yaw);
      p = 'body';
    }
    if(tt >= 0 && tt < bt){ bt = tt; part = p; tg = t; }
  }
  if(!tg) return false;
  // Стена или земля ближе цели — значит пуля ушла туда, а не в игрока.
  if(rayBoxes(o, d, bt)) return false;
  if(rayTerrain(o, d, bt)) return false;

  const dmg = (part === 'head') ? b.dmg*1.65 : b.dmg;
  // Четвёртый аргумент — индекс боеприпаса пули (§9.3). Боты стреляют только
  // матчевым, так что это всегда 0; лишний аргумент трёхпараметровой версии
  // не мешает, а появившейся проверке урона на сервере — пригодится.
  if(typeof NET.reportBotDamage === 'function') NET.reportBotDamage(tg.pid, dmg, part, 0);
  // По удалённому бойцу отклик рисуем сами: без крови непонятно, попал бот
  // или мазал. Локальному его уже нарисовал 60_weapon.js — второй раз не надо.
  if(tg.kind === 1 && typeof FX !== 'undefined' && FX && typeof FX.burst === 'function' &&
     typeof PMAT !== 'undefined' && PMAT){
    AI_s3.copy(o).addScaledVector(d, bt);   // o и d — рабочие вектора вызывающего, их не трогаем
    AI_bloodFx.mat = PMAT.blood;
    FX.burst(AI_s3, 6, AI_bloodFx);
  }
  return true;
}

/* Раз в кадр: отрезок, пройденный пулей с прошлого кадра, проверяем по целям.
   Пуле, которую 60_weapon.js уже погасил, добавляем кадр полёта — она гаснет
   на подшаге, и точки удара нам никто не отдаёт. Ложное срабатывание за стеной
   при этом невозможно: отрезок всё равно упирается в геометрию. */
function AI_updShots(dt){
  for(let i=0;i<AI_shots.length;i++){
    const s = AI_shots[i], b = s.b;
    if(!b) continue;
    // Пропущенные кадры (пауза, смена хоста, рестарт) — записанная позиция
    // устарела, и «последний отрезок» по ней был бы выдумкой.
    if(game.time - s.at > 0.5 || s.at > game.time){ s.b = null; continue; }
    const live = (bullets.indexOf(b) >= 0);
    let dx = b.pos.x - s.x, dy = b.pos.y - s.y, dz = b.pos.z - s.z;
    if(!live){ dx += b.vel.x*dt; dy += b.vel.y*dt; dz += b.vel.z*dt; }
    const len = Math.hypot(dx, dy, dz);
    let hit = false;
    if(len > 1e-5){
      AI_s1.set(s.x, s.y, s.z);
      AI_s2.set(dx/len, dy/len, dz/len);
      hit = AI_hitScan(b, AI_s1, AI_s2, len);
    }
    if(hit || !live) s.b = null;
    else { s.x = b.pos.x; s.y = b.pos.y; s.z = b.pos.z; s.at = game.time; }
  }
}

/* ============================== ОТДЕЛЕНИЕ ==============================
   Тик раз в ~0.4 с: раздать роли, решить, окружаем мы игрока или нет,
   и развести бойцов по пеленгам. Каждый кадр здесь делать нечего —
   решения такого масштаба всё равно «дозревают» секундами. */
const SQUAD = {
  // Контракт требует {x,z,t}; y — добавка сверху: без неё подавляющий огонь
  // по цели на контейнере уходит в землю под ним.
  lastKnown: { x:0, y:0, z:0, t:-999 },
  alert: 0,                          // 0..1 — насколько отделение «на нервах»
  still: 0,                          // сколько секунд цель держится на месте
  // На кого смотрит отделение. Офлайн это всегда локальный игрок; в сети —
  // тот, о ком доложили последним, иначе «окружение» считалось бы по одному
  // игроку, а лезли бы к другому.
  focus: null,
  _at: -1, _acc: 0, _px: 0, _pz: 0, _n: 0, _enc: false,

  reset(){
    this.lastKnown.x = 0; this.lastKnown.y = 0; this.lastKnown.z = 0; this.lastKnown.t = -999;
    this.alert = 0; this.still = 0; this._acc = 0; this._at = -1; this._enc = false;
    this.focus = null;
    AI_dropShots();                  // пули прошлого матча ничего заявлять не должны
    const F = AI_focus();
    this._px = F ? F.x : player.pos.x; this._pz = F ? F.z : player.pos.z;
  },

  roleOf(e){ return (e && e.role) ? e.role : 'anchor'; },

  /* Бот доложил о визуальном контакте — с этого момента позицию цели знает
     вся группа, а не только тот, кто её увидел. */
  onPlayerSeen(e){
    const t = (e && e.tgt) ? e.tgt : AI_focus();
    const k = this.lastKnown;
    if(t){ k.x = t.x; k.y = t.y; k.z = t.z; this.focus = t; }
    else { k.x = player.pos.x; k.y = player.pos.y; k.z = player.pos.z; }
    k.t = game.time;
    this.alert = Math.min(1, this.alert + 0.45);
    if(e) e.reported = game.time;
  },

  /* Доклад «по звуку»: свежий визуальный контакт всегда точнее, поэтому
     не затираем его приблизительной наводкой. */
  report(x, y, z){
    const k = this.lastKnown;
    if(game.time - k.t < 0.7) return;
    k.x = x; k.y = y; k.z = z; k.t = game.time;
    this.alert = Math.min(1, this.alert + 0.22);
  },

  age(){ return game.time - this.lastKnown.t; },

  update(dt){
    // 90_game.js зовёт это из цикла, но и Enemy.update страхуется вызовом:
    // одного тика за кадр достаточно, повторы отсекаем по game.time.
    if(this._at === game.time) return;
    this._at = game.time;
    // Кадровые дела ИИ, которые делаются один раз, а не на каждого бойца:
    // список целей и заявки о попаданиях пуль ботов.
    AI_targets();
    // Хост сменился посреди боя — чужие пули больше не наши, заявлять по ним нечего.
    if(AI_isHost()) AI_updShots(dt);
    else if(AI_shots.length) AI_dropShots();
    this.alert = Math.max(0, this.alert - dt*0.20);
    this._acc += dt;
    if(this._acc < 0.4) return;
    const st = this._acc; this._acc = 0;

    AI_live.length = 0;
    for(let i=0;i<enemies.length;i++) if(enemies[i].alive) AI_live.push(enemies[i]);
    const n = AI_live.length;
    this._n = n;
    if(!n) return;

    // Окружать имеет смысл только «засидевшуюся» цель: за бегущим игроком
    // хоровод по секторам выглядит глупо и всегда опаздывает. Считаем не шаг
    // за тик (его любая скорость проходит), а уход от опорной точки.
    const F = AI_focus();
    const fx = F ? F.x : this._px, fz = F ? F.z : this._pz;
    if(Math.hypot(fx - this._px, fz - this._pz) < 7) this.still += st;
    else { this.still = 0; this._px = fx; this._pz = fz; }

    if(!D.squad){
      // Новобранцы воюют поодиночке: ни общего целеуказания, ни ролей.
      for(let i=0;i<n;i++){ const e = AI_live[i]; e.role = 'anchor'; e.wantBear = -1; e.wantSector = -1; }
      this._enc = false;
      return;
    }

    // Ранжируем по дистанции до цели: ближний давит, дальний работает снайпером.
    const known = this.age() < 9;
    const kx = known ? this.lastKnown.x : fx;
    const kz = known ? this.lastKnown.z : fz;
    for(let i=0;i<n;i++) AI_live[i]._rank = Math.hypot(AI_live[i].pos.x - kx, AI_live[i].pos.z - kz);
    AI_live.sort(AI_byRank);

    let anchors = 0;
    for(let i=0;i<n;i++){
      const e = AI_live[i];
      // Роль держится несколько секунд: если её пересчитывать каждый тик,
      // бот дёргается между «обойти» и «держать» и не делает ни того, ни другого.
      e.roleT -= st;
      if(e.roleT <= 0){ e.roleSeed = Math.random(); e.roleT = rnd(5.5, 9.5); }
      const s = e.roleSeed;
      let r;
      if(n === 1)            r = (this.alert > 0.40 && s < 0.45) ? 'rusher' : 'anchor';
      else if(i === 0)       r = (this.alert > 0.25 && s < 0.30 + D.flank*0.30) ? 'rusher' : 'anchor';
      else if(i === n - 1)   r = (s < D.sup) ? 'suppressor' : 'anchor';
      else if(s < D.flank)   r = 'flanker';
      else if(s < D.flank + D.sup*0.7) r = 'suppressor';
      else                   r = 'anchor';
      e.role = r;
      if(r === 'anchor') anchors++;
    }
    // Без «якоря» отделение превращается в толпу: кто-то обязан держать дистанцию.
    if(anchors === 0 && n >= 2) AI_live[n-1].role = 'anchor';

    // ---- охват ----
    const psec = AI_sec(kx, kz);
    const encircle = (n >= 3 && this.still > 3.5 && this.alert > 0.20);
    this._enc = encircle;
    const gap = (n <= 4) ? 1 : 0;   // при пятерых 90° между всеми не разложить
    for(let k=0;k<8;k++) AI_bearUsed[k] = 0;

    for(let i=0;i<n;i++){
      const e = AI_live[i];
      if(encircle){
        // каждому — свой пеленг вокруг цели, ближайший свободный к текущему,
        // чтобы бот не бежал через полкарты ради «правильного» угла
        const b = AI_bearSec(kx, kz, e.pos.x, e.pos.z);
        let found = -1;
        for(let d=0; d<8 && found<0; d++){
          const c1 = (b + d) & 7, c2 = (b - d + 8) & 7;
          if(!AI_bearUsed[c1]) found = c1;
          else if(!AI_bearUsed[c2]) found = c2;
        }
        if(found < 0) found = b;
        e.wantBear = found;
        AI_bearUsed[found] = 1;
        if(gap){ AI_bearUsed[(found + 1) & 7] = 1; AI_bearUsed[(found + 7) & 7] = 1; }
      } else e.wantBear = -1;

      // Обход: сектор со смещением 2..4 от сектора игрока — это фланг или спина.
      if(e.role === 'flanker'){
        e.secT -= st;
        if(e.wantSector < 0 || e.secT <= 0){
          const sgn = (e.roleSeed < 0.5) ? -1 : 1;
          e.wantSector = (psec + sgn*rint(2,4) + 8) % 8;
          e.secT = rnd(6, 11);
        }
      } else { e.wantSector = -1; e.secT = 0; }
    }
  }
};

/* =============================== БОЕЦ =============================== */
class Enemy {
  constructor(id){
    this.id = id;
    this.m = mkSniper(PAL.red, PAL.redDk);
    scene.add(this.m);
    const U = this.m.userData;

    // Опорные смещения берём из самой модели: 50_models.js живёт своей
    // жизнью, и жёстко зашитые 0.86 / 1.24 однажды разъедутся.
    this.rest = {
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
      eLx: U.armL.E.rotation.x, eRx: U.armR.E.rotation.x
    };
    const bolt = U.rifle.userData ? U.rifle.userData.bolt : null;
    this.boltZ = bolt ? bolt.position.z : 0;

    // тело и физика (контракт сущности из §3.3)
    this.pos = V(0,0,0); this.vel = V(0,0,0);
    this.h = CFG.height; this.grounded = false; this.stepUp = 0; this.landV = 0;
    this.noGrav = false;

    this.yaw = 0; this.pitch = 0; this.aimYaw = 0; this.aimPitch = 0;
    this.gunYaw = 0; this.gunPitch = 0; this.moveYaw = 0; this.climbYaw = 0;
    this.hp = 100; this.hpBefore = 100; this.alive = true;

    // состояние рассудка
    // tgt — та самая «цель»: офлайн всегда локальный игрок, в сети — любой
    // живой противник. Ссылка держится между кадрами, поэтому запись цели
    // живёт столько же, сколько сам игрок в комнате.
    this.tgt = null; this.killer = -1;
    this.state = 'hold'; this.stateT = 0; this.seeT = 0; this.loseT = 0;
    this.los = false; this.behind = false; this.senseT = 0; this.reported = -99;
    this.post = null; this.avoidPost = null;
    this.path = []; this.pi = 0; this.wpT = 0;
    this.wpBuf = [];
    for(let i=0;i<10;i++) this.wpBuf.push({ x:0, z:0, y:0, climb:false });
    this.tmpWP = { x:0, z:0, y:0, climb:false };

    this.role = 'anchor'; this.roleT = 0; this.roleSeed = Math.random();
    this.wantSector = -1; this.wantBear = -1; this.secT = 0;
    this.mem = { x:0, y:0, z:0, t:-999 };
    this.kx = 0; this.ky = 0; this.kz = 0; this.kt = -999; this.kAge = 999;
    this._rank = 0;

    this.charge = 0; this.chargeNeed = 1.2; this.aimGiveUp = 5; this.reload = 0; this.solveT = 0;
    this.reactNeed = 1.0; this.holdNeed = 8; this.settleNeed = 0.7;
    this.postT = 0; this.postMax = 15; this.onPost = false;
    // Дорога до позиции — отдельный бюджет: сколько секунд бот реально шагал
    // (не считая огневых пауз) и сколько ему на это отведено.
    this.travelT = 0; this.postETA = 8; this.breaks = 0; this.breakT = -99; this.failN = 0;
    // Чёрный список позиций: не одна «забытая», а три с временем протухания.
    // С одной ячейкой выбор снова и снова сходится к той же недостижимой точке.
    this.avoidA = [null, null, null];
    this.avoidTs = [0, 0, 0];
    this.avoidI = 0;
    this.laserT = 0; this.flinch = 1; this.settleErr = 0;
    this.supN = 0; this.supCd = 0; this.supA = 0; this.supR = 0; this.supY = 0;

    this.crouch = 0; this.wantCrouch = 0; this.aimBlend = 0; this.recoil = 0;
    this.burn = 0; this.burnLeave = 0; this.danger = 0;
    this.threat = V(0,0,0); this.threatT = -99; this.fireP = V(0,0,0); this.fireK = 0;
    this.stuck = 0; this.stuckN = 0; this.side = 0; this.sideT = 0; this.speed = 0;
    this.climbT = 0; this.climbY0 = 0; this.climbChk = 0; this.climbZone = null;
    this.climbTop = 0; this.climbWill = false;
    this.mantleT = 0; this.mantleFrom = V(0,0,0); this.mantleTo = V(0,0,0);
    this.aimPt = V(0,0,0); this.deadT = 0; this.walkT = 0;
    this.mv = null; this.run = false; this.aiming = false;
    this.fireFx = null;

    this.respawn(true);
  }

  /* ---------------------- геометрия и попадания ---------------------- */
  cy(){ return this.crouch*0.42; }
  center(o){ return o.set(this.pos.x, this.pos.y + 1.12 - this.cy(), this.pos.z); }
  headP(o){ return o.set(this.pos.x, this.pos.y + 1.59 - this.cy(), this.pos.z); }
  eye(o){ return o.set(this.pos.x, this.pos.y + 1.52 - this.cy(), this.pos.z); }
  muzzle(o){
    o.set(this.pos.x, this.pos.y + 1.62 - this.cy() + Math.sin(this.gunPitch)*0.9, this.pos.z);
    const c = Math.cos(this.gunPitch)*0.95;
    o.x -= Math.sin(this.gunYaw)*c; o.z -= Math.cos(this.gunYaw)*c;
    return o;
  }
  segHit(p0, d, len){
    const cy = this.cy();
    const th = segSphere(p0,d,len, this.pos.x, this.pos.y+1.59-cy, this.pos.z, 0.275);
    if(th>=0) return {t:th, part:'head'};
    const tb = segOBB(p0,d,len, this.pos.x, this.pos.y+1.13-cy, this.pos.z, 0.36,0.30,0.24, this.yaw);
    if(tb>=0) return {t:tb, part:'body'};
    const tl = segOBB(p0,d,len, this.pos.x, this.pos.y+0.52-cy*0.6, this.pos.z, 0.30,0.46,0.22, this.yaw);
    if(tl>=0) return {t:tl, part:'legs'};
    return null;
  }
  /* Дистанция до своей цели. Цели нет (все выбиты или ушли) — пляшем от
     последней известной точки: она есть всегда. */
  tgtDist(){
    const t = this.tgt;
    if(t) return Math.hypot(t.x - this.pos.x, t.y - this.pos.y, t.z - this.pos.z);
    return Math.hypot(this.kx - this.pos.x, this.ky - this.pos.y, this.kz - this.pos.z);
  }

  /* ------------------------------ маршрут ------------------------------ */
  setPath(){ this.path.length = 0; this.pi = 0; this.wpT = 0; }
  /* Точки берём из предвыделенного буфера: маршрут перестраивается часто,
     а мусорить объектами в игровом цикле нельзя. */
  pushWP(x, z, y, climb){
    const n = this.path.length;
    if(n >= this.wpBuf.length) return;
    const w = this.wpBuf[n];
    w.x = x; w.z = z; w.y = y; w.climb = !!climb;
    this.path.push(w);
  }
  wp(){
    while(this.pi < this.path.length){
      const w = this.path[this.pi];
      // Подножие лестницы засчитывается не по «подошёл», а по «поднялся»:
      // иначе точка проглатывается на подходе и лезть уже нечем.
      if(w.climb){
        if(this.pos.y > w.y + 0.8){ this.pi++; this.wpT = 0; continue; }
        return w;
      }
      const dx = w.x - this.pos.x, dz = w.z - this.pos.z;
      const near = (this.pi < this.path.length - 1) ? 2.0 : 1.0;
      // вверх точку тоже не «проглатываем»: туда ещё надо залезть
      if(dx*dx + dz*dz < near*near && (w.y - this.pos.y) < 1.0){ this.pi++; this.wpT = 0; continue; }
      return w;
    }
    return null;
  }
  freePost(){ if(this.post && this.post.taken === this) this.post.taken = null; this.post = null; }

  /* ---------------------------- память о цели ----------------------------
     y передаётся явно: высота берётся у той цели, о которой речь, а не у
     локального игрока — в сети это разные люди на разных ярусах. */
  remember(x, z, y, share){
    this.mem.x = x; this.mem.z = z; this.mem.y = y; this.mem.t = game.time;
    if(share && D.squad) SQUAD.report(x, y, z);
  }
  /* Что боец «знает» прямо сейчас: своё наблюдение или доклад отделения —
     смотря что свежее. При D.squad=false общая память недоступна. */
  refreshKnown(){
    let x = this.mem.x, y = this.mem.y, z = this.mem.z, t = this.mem.t;
    const L = SQUAD.lastKnown;
    if(D.squad && L.t > t){ x = L.x; y = L.y; z = L.z; t = L.t; }
    const T = this.tgt;
    if(this.los && T && T.alive){ x = T.x; y = T.y; z = T.z; t = game.time; }
    this.kx = x; this.ky = y; this.kz = z; this.kt = t;
    this.kAge = game.time - t;
  }

  /* ------------------------- недостижимые позиции -------------------------
     Если бот раз за разом не доходит, виновата не «неудача», а сама точка:
     её надо честно вычеркнуть на время, иначе отбор сходится к ней снова. */
  avoidAdd(p, sec){
    if(!p) return;
    this.avoidA[this.avoidI] = p;
    this.avoidTs[this.avoidI] = game.time + sec;
    this.avoidI = (this.avoidI + 1) % this.avoidA.length;
    this.avoidPost = p;
  }
  isAvoided(p){
    for(let i=0;i<this.avoidA.length;i++)
      if(this.avoidA[i] === p && this.avoidTs[i] > game.time) return true;
    return false;
  }
  /* Сколько метров дороги бот согласен отдать за позицию. У самого боя хопы
     короткие, на подходе с базы — длиннее, иначе отделение просто не доедет. */
  routeBudget(){
    const dT = Math.hypot(this.pos.x - this.kx, this.pos.z - this.kz);
    let b = clamp(dT*0.40, 15, 30);
    if(this.role === 'rusher') b += 6;
    if(this.burn > 0 || this.danger > 0.6) b = Math.min(b, 20);
    return b;
  }
  /* Позиция не сложилась: вычеркнуть и взять заведомо ближнюю. */
  failPost(){
    if(this.post) this.avoidAdd(this.post, rnd(9, 17));
    this.failN++;
    if(this.failN >= 3){
      // Три срыва подряд — дело уже не в точках, а в том, где стоит сам боец.
      // Чистим список и берём ближайшее, до чего дойдём наверняка: бесконечный
      // марш по недостижимым позициям хуже любой посредственной позиции.
      this.failN = 0;
      for(let i=0;i<this.avoidA.length;i++){ this.avoidA[i] = null; this.avoidTs[i] = 0; }
      this.pickPost(false, 10);
      return;
    }
    this.pickPost(false, 15);
  }
  /* Прибытие засчитываем по факту, а не по «точки маршрута кончились»:
     вейпоинт, проглоченный из-за затыка, не должен выглядеть как позиция. */
  arrive(){
    const p = this.post;
    if(p && Math.hypot(p.x - this.pos.x, p.z - this.pos.z) > 2.6){ this.failPost(); return; }
    this.breaks = 0; this.failN = 0;
    this.go('settle');
  }
  /* Куда возвращаться после огневого контакта: недошедший боец идёт дальше
     по маршруту, а не выбирает новую точку с полпути. */
  resume(){
    if(this.onPost || !this.post) return false;
    // Бюджет дороги давно перебран — значит и возвращаться некуда: берём
    // ближнюю точку, а не остаёмся воевать посреди поля.
    if(this.travelT > this.postETA*1.6){ this.failPost(); return true; }
    this.go('move');
    return true;
  }
  /* Рвать марш ради выстрела можно, но не в двух шагах от позиции и не каждую
     секунду — иначе бот всю жизнь «почти дошёл». */
  canBreak(){
    const p = this.post;
    if(!p) return true;
    if(this.hp < 55 || this.tgtDist() < 14) return true;
    if(Math.hypot(p.x - this.pos.x, p.z - this.pos.z) < 10) return false;
    if(this.breaks >= 2) return false;      // дважды уже отвлекались — теперь дойди
    return (game.time - this.breakT) > 3.2;
  }

  /* ---------------------------- выбор позиции ---------------------------- */
  pickPost(far, maxD){
    if(!POSTS.length){ this.go('hold'); return; }
    const tx = this.kx, tz = this.kz;
    const role = this.role;
    // Снайперу нужна дистанция, штурмовику — наоборот. Дальности умеренные:
    // с 60 м ошибка прицела вдвое больше, чем с 30, и «занял позицию» легко
    // превращается в «сидит и не попадает».
    const want = role === 'rusher' ? 15 : role === 'flanker' ? 28 : role === 'suppressor' ? 38 : 48;
    const climbOK = Math.random() < 0.25 + D.climb*0.75;
    const budget = maxD || this.routeBudget();

    for(let i=0;i<4;i++){ AI_candP[i] = null; AI_candS[i] = -1e9; }
    for(let i=0;i<POSTS.length;i++){
      const p = POSTS[i];
      if(p.taken && p.taken !== this) continue;
      if(this.isAvoided(p)) continue;
      const dPl = Math.hypot(p.x - tx, p.z - tz);
      const dMe = Math.hypot(p.x - this.pos.x, p.z - this.pos.z);
      const lvl = AI_postLevel(p);
      // Цена позиции — это прежде всего дорога к ней. Подъём на ярус считаем
      // лишними метрами, за выход из бюджета маршрута штрафуем резко: точка,
      // до которой десять секунд бежать, не позиция, а обещание позиции.
      const travel = dMe + lvl*5;
      // Ближе желаемой дистанции — почти бесплатно, дальше — дорого: с 80 м
      // бот честно мажет, и «занятая позиция» перестаёт быть угрозой.
      const off = dPl - want;
      let s = (off > 0 ? -off*0.72 : off*0.28) + AI_postCover(p)*26 + rnd(0, 10) - travel*0.90;
      if(travel > budget) s -= (travel - budget)*2.6;
      // Ярус ценен, когда он рядом: лезть имеет смысл ради близкой высоты,
      // а не ради самой высоты на другом конце карты. Зато близкую высоту
      // берём охотно — иначе верхние площадки карты просто выпадают из боя.
      if(lvl > 0){
        if(!climbOK) s -= 30*lvl;                        // этот боец лезть не настроен
        else if(dMe < budget) s += lvl*(9 + D.climb*8);
        else s -= 11*lvl;
      }
      if(far && dPl < 26) s -= 45;
      if(p === this.post) s -= 22;                 // менять позицию, а не топтаться
      // Пеленг и сектор задают, с какой стороны заходить, но не оправдывают
      // марш через полкарты: их вес держим ниже цены дороги.
      if(this.wantSector >= 0){
        const sd = AI_secDist(AI_postSec(p), this.wantSector);
        s += (sd === 0) ? 20 : (sd === 1 ? 9 : -5*sd);
      }
      if(this.wantBear >= 0){
        const sd = AI_secDist(AI_bearSec(tx, tz, p.x, p.z), this.wantBear);
        s += (sd === 0) ? 18 : (sd === 1 ? 8 : -6*sd);
      }
      for(let k=0;k<4;k++){
        if(s > AI_candS[k]){
          for(let j=3;j>k;j--){ AI_candS[j] = AI_candS[j-1]; AI_candP[j] = AI_candP[j-1]; }
          AI_candS[k] = s; AI_candP[k] = p;
          break;
        }
      }
    }

    // Линия огня решает, но считать её на все POSTS дорого — только финалистам.
    let best = null, bs = -1e9;
    AI_v2.set(tx, Math.max(gh(tx, tz), this.ky) + 1.15, tz);
    for(let k=0;k<4;k++){
      const p = AI_candP[k];
      if(!p) continue;
      AI_v1.set(p.x, AI_postY(p) + 1.5, p.z);
      const clear = losClear(AI_v1, AI_v2);
      let s = AI_candS[k];
      // Обходящему прострел не обязателен — ему нужно зайти незамеченным.
      // Но и совсем слепая точка ему не нужна: с неё он просто не воюет.
      if(role === 'flanker') s += clear ? 6 : 12;
      else s += clear ? 26 : -14;
      if(s > bs){ bs = s; best = p; }
    }
    if(!best) best = AI_candP[0] || pick(POSTS);

    this.freePost();
    this.post = best; best.taken = this;
    this.setPath();
    if(best.via){
      for(let i=0;i<best.via.length;i++){
        const v = best.via[i];
        this.pushWP(v.x, v.z, (v.y === undefined) ? gh(v.x, v.z) : v.y, v.climb);
      }
    }
    this.pushWP(best.x, best.z, AI_postY(best), false);
    this.climbWill = climbOK;
    this.stuckN = 0;
    // Срок на дорогу выдаём сразу и считаем только шагающие кадры: не уложился —
    // значит позиция недостижима, а не «ещё немного осталось». Меряем длину
    // самого маршрута, а не прямую: обход через via и подъём — тоже время.
    let est = 0, ex = this.pos.x, ez = this.pos.z;
    for(let i=0;i<this.path.length;i++){
      const w = this.path[i];
      est += Math.hypot(w.x - ex, w.z - ez); ex = w.x; ez = w.z;
    }
    est += AI_postLevel(best)*6;
    // 3.6 м/с — реальная скорость с обходами и расталкиванием, а не паспортные 6.2
    this.postETA = clamp(est/3.6 + 2.5, 4, 14);
    this.travelT = 0; this.breaks = 0;
    // отсчёт «сижу тут» начинается заново; на прибытии его перезапустит settle
    this.postT = 0; this.postMax = rnd(18, 30); this.onPost = false;
    this.go('move');
  }

  /* ------------------------------ переходы ------------------------------ */
  go(s){
    this.state = s; this.stateT = 0;
    if(s === 'aim'){
      this.charge = 0; this.solveT = 0;
      // Живая цель отменяет остаток подавляющей серии: иначе счётчик серии
      // никогда не обнуляется и бот навсегда залипает в цикле «прицел—выстрел».
      this.supN = 0;
      this.chargeNeed = rnd(D.charge[0], D.charge[1]);
      // Сколько терпим, если чистый выстрел так и не складывается: цель,
      // которая мелькает в укрытии, не должна намертво приковывать бота.
      // На полпути к позиции терпение короче: стоять столбом посреди поля
      // хуже, чем добежать до укрытия и работать оттуда.
      this.aimGiveUp = this.chargeNeed + (this.onPost ? rnd(2.2, 4.2) : rnd(1.0, 2.0));
      this.aimSolution();
    } else if(s === 'suppress'){
      if(this.supN <= 0) this.supN = rint(2,3);
      this.charge = 0; this.solveT = 0;
      this.chargeNeed = rnd(D.charge[0], D.charge[1]);
      this.rollSup(); this.supSolution();
    } else if(s === 'settle'){
      this.settleNeed = rnd(0.45, 1.15);
      this.settleErr = 1;                       // с ходу бот стреляет заметно хуже
      this.reactNeed = rnd(D.react[0], D.react[1]);
      // Отсчёт «сколько сижу на точке» начинается с прибытия, а не с выбора:
      // иначе долгий марш съедал бы весь лимит и позиция бросалась сразу.
      this.postT = 0; this.postMax = rnd(18, 30); this.onPost = true;
    } else if(s === 'hold'){
      this.holdNeed = rnd(5.5, 11);
      this.reactNeed = rnd(D.react[0], D.react[1]);
    } else if(s === 'move'){
      this.reactNeed = rnd(D.react[0], D.react[1]);
      this.charge = 0;
    } else if(s === 'climb'){
      this.climbT = 0; this.climbY0 = this.pos.y; this.climbChk = 1;
      this.climbYaw = this.moveYaw;
    }
  }

  /* Откуда именно уходить: очаг огня важнее, чем «кто-то стрелял минуту
     назад»; если свежей угрозы нет — пляшем от последней известной цели. */
  threatPt(){
    if(this.fireK > 0) return this.fireP;
    if(game.time - this.threatT < 6) return this.threat;
    return null;
  }

  /* Отход: горим, стоим в очаге или получили фугас — позицию надо бросать. */
  goRetreat(from){
    let dx = this.pos.x - (from ? from.x : this.kx);
    let dz = this.pos.z - (from ? from.z : this.kz);
    let l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    // не в чистое поле, а с уклоном к своей половине (RED — север, z>0)
    dz = dz*0.75 + 0.25;
    l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    const lim = CFG.half - 6;
    const tx = clamp(this.pos.x + dx*rnd(9, 17), -lim, lim);
    const tz = clamp(this.pos.z + dz*rnd(9, 17), -lim, lim);
    this.freePost();
    this.setPath();
    this.pushWP(tx, tz, gh(tx, tz), false);
    this.danger = Math.min(this.danger, 1.0);
    this.onPost = false;
    this.go('retreat');
  }

  /* Перегруппировка: подранок откатывается к своим, а не умирает в одиночку. */
  goRegroup(){
    let rx = 0, rz = 0, n = 0;
    for(let i=0;i<enemies.length;i++){
      const o = enemies[i];
      if(o === this || !o.alive) continue;
      rx += o.pos.x; rz += o.pos.z; n++;
    }
    if(n){ rx /= n; rz /= n; }
    else { rx = this.pos.x*0.4; rz = 50; }
    rx += rnd(-7, 7); rz += rnd(-7, 7);
    // точка сбора обязана быть дальше от игрока, чем текущая
    const dNow = Math.hypot(this.pos.x - this.kx, this.pos.z - this.kz);
    if(Math.hypot(rx - this.kx, rz - this.kz) < dNow*0.8){
      rx = this.pos.x + (this.pos.x - this.kx)*0.35;
      rz = this.pos.z + (this.pos.z - this.kz)*0.35;
    }
    const lim = CFG.half - 6;
    rx = clamp(rx, -lim, lim); rz = clamp(rz, -lim, lim);
    this.freePost();
    this.setPath();
    this.pushWP(rx, rz, gh(rx, rz), false);
    this.onPost = false;
    this.go('regroup');
  }

  /* ------------------------------ восприятие ------------------------------
     Кого держим на прицеле. Офлайн кандидат ровно один — локальный игрок, и
     проверки идут в том же порядке, что и раньше: тот же единственный
     losClear, те же условия слуха, тот же расход случайных чисел. */
  acquire(){
    const T = AI_targets();
    let best = null, bs = -1e9, bLos = false, bD = 0;
    for(let i=0;i<T.length;i++){
      const t = T[i];
      if(!t.alive || !AI_foe(t)) continue;               // по своим не работаем
      const d = Math.hypot(t.x - this.pos.x, t.y - this.pos.y, t.z - this.pos.z);
      // Ближняя цель — своя работа, видимая важнее слышимой, а за уже занятую
      // другими доплачиваем: отделение должно расходиться по комнате, а не
      // всем составом висеть на одном игроке.
      let s = -d;
      const sticky = (t === this.tgt) ? 18 : 0;          // прилипание: не дёргаться каждый тик
      // Дальняя цель не отобьёт ближнюю даже с прямой видимостью — на неё не
      // стоит тратить losClear, это самый дорогой вызов во всём восприятии.
      if(s + 55 + sticky <= bs) continue;
      const los = d < D.see && losClear(this.eye(AI_v1), AI_tgEye(t, AI_v2));
      if(los) s += 55;
      s += sticky;
      if(!sticky) s -= t.n*9;
      if(s > bs){ bs = s; best = t; bLos = los; bD = d; }
    }
    if(best) this.tgt = best;
    else if(!this.tgt || !this.tgt.on) this.tgt = AI_nearFoe(this.pos.x, this.pos.z, false);
    this.los = bLos;

    if(this.los){
      // за спиной замечает медленнее — иначе обход противника не имеет смысла
      AI_v3.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      AI_v4.set(best.x - this.pos.x, best.y - this.pos.y, best.z - this.pos.z).normalize();
      this.behind = AI_v3.dot(AI_v4) < -0.1;
    } else if(best){
      // слух: спринт рядом слышно и без прямой видимости
      const psp = Math.hypot(best.vx, best.vz);
      const hearR = 6 + psp*2.2;
      if(bD < hearR && Math.abs(this.pos.y - best.y) < 6)
        this.remember(best.x + rnd(-2,2), best.z + rnd(-2,2), best.y, true);
    }
  }

  sense(dt){
    this.senseT -= dt;
    if(this.senseT <= 0){
      // рассинхронизируем ботов, чтобы все losClear не падали в один кадр
      this.senseT = 0.09 + Math.random()*0.05;
      this.acquire();
    }

    const T = this.tgt;
    if(this.los && T){
      this.seeT += dt * (this.behind ? 0.45 : 1) * (T.scoped ? 1.25 : 1);
      this.loseT = 0;
      this.remember(T.x, T.z, T.y, false);
      if(this.seeT > D.react[0]*0.6 && game.time - this.reported > 0.35) SQUAD.onPlayerSeen(this);
    } else {
      this.seeT = Math.max(0, this.seeT - dt*0.7);
      this.loseT += dt;
    }
    this.refreshKnown();

    // огонь под ногами — повод уходить, а не «дожимать» позицию
    this.fireK = AI_fireAt(this.pos.x, this.pos.z, this.pos.y, this.fireP);
    if(this.fireK > 0) this.danger += dt*(0.8 + this.fireK);
    if(this.burn > 0) this.danger += dt*0.75;
    this.danger = Math.max(0, this.danger - dt*0.28);
  }

  /* -------------------------------- рассудок -------------------------------- */
  brain(dt){
    this.mv = null; this.run = false;
    this.stateT += dt;

    // Безусловные прерывания. Горящий бот обязан сорваться с позиции —
    // стоять в огне и продолжать целиться выглядит как поломка.
    if(this.state !== 'retreat' && this.state !== 'climb'){
      if(this.burn > 0 && this.burnLeave <= 0){ this.burnLeave = 1; this.goRetreat(this.threatPt()); return; }
      if(this.fireK > 0.15){ this.goRetreat(this.fireP); return; }
      if(this.danger > 1.15){ this.goRetreat(this.threatPt()); return; }
    }
    if(this.burn <= 0) this.burnLeave = 0;

    switch(this.state){
      case 'move': {
        this.run = true;
        this.travelT += dt;
        const w = this.wp();
        if(!w){ this.arrive(); break; }
        const up = w.y - this.pos.y;
        if((w.climb || up > 1.2) && this.climbWill){
          const near = Math.hypot(w.x - this.pos.x, w.z - this.pos.z);
          const here = (near < 1.8) ? AI_climbAt(this.pos.x, this.pos.z, this.pos.y + 0.4) : null;
          if(here){
            this.climbZone = here;
            // Куда лезем — это верх лестницы или следующая точка маршрута,
            // но не высота подножия: иначе подъём кончается, не начавшись.
            const nz = this.path[this.pi + 1];
            let top = (here.y1 === undefined) ? this.pos.y + 3 : here.y1;
            if(nz && nz.y > top) top = nz.y;
            if(!w.climb && w.y > top) top = w.y;
            this.climbTop = top;
            this.go('climb');
            break;
          }
          const zw = AI_climbAt(w.x, w.z, this.pos.y + 0.4) || AI_climbAt(w.x, w.z, w.y - 0.6);
          if(zw){
            // сначала к подножию лестницы, лезть будем уже оттуда
            this.tmpWP.x = zw.x; this.tmpWP.z = zw.z; this.tmpWP.y = this.pos.y;
            this.mv = this.tmpWP;
          } else this.mv = w;
        } else this.mv = w;
        if(this.los && this.stateT > 0.25 && this.seeT > this.reactNeed*1.3 && this.canBreak()){
          this.breaks++; this.breakT = game.time; this.go('aim'); break;
        }
        // Срок вышел — это и есть «маршрут не сложился». Но у самой точки
        // добиваем последние метры, а не бросаем позицию в двух шагах.
        if(this.travelT > this.postETA){
          const p = this.post;
          const dp = p ? Math.hypot(p.x - this.pos.x, p.z - this.pos.z) : 99;
          // …но продлевать бесконечно нельзя: боец, топчущийся в трёх метрах
          // от точки, — это та же недостижимость, только медленная.
          if(dp > 4 || this.postETA > 16) this.failPost();
          else this.postETA += 2;
        }
        break;
      }

      case 'climb': {
        this.climbT += dt;
        this.travelT += dt;
        const on = AI_climbStep(this, dt, true);
        // страховка от «залипания»: если за секунду не поднялись — слезаем
        this.climbChk -= dt;
        let stalled = false;
        if(this.climbChk <= 0){
          stalled = (this.pos.y - this.climbY0) < 0.35;
          this.climbY0 = this.pos.y; this.climbChk = 1;
        }
        if(!on || stalled || this.climbT > 6 || this.pos.y > this.climbTop - 0.15){
          this.noGrav = false; this.climbZone = null;
          if(stalled) this.climbWill = false;   // второй раз в ту же лестницу не полезем
          this.go('move');
        }
        break;
      }

      case 'settle': {
        const p = this.post;
        if(p){
          const d = Math.hypot(p.x - this.pos.x, p.z - this.pos.z);
          if(d > 0.7){
            this.tmpWP.x = p.x; this.tmpWP.z = p.z; this.tmpWP.y = AI_postY(p);
            this.mv = this.tmpWP;
          }
        }
        this.wantCrouch = 0.35 + (p ? AI_postCover(p) : 0.5)*0.65;
        if(this.los && this.seeT > this.reactNeed*0.9){ this.go('aim'); break; }
        if(this.stateT > this.settleNeed) this.go('hold');
        break;
      }

      case 'hold': {
        // выглядывание: то присел, то приподнялся — силуэт живой и читается
        this.wantCrouch = (Math.floor(this.stateT*0.55) % 3 === 0) ? 0.15 : 1;
        if(this.los && this.seeT > this.reactNeed){ this.go('aim'); break; }
        // подавление: не ждём чистой линии, а выгоняем игрока с точки
        if(!this.los && this.kAge < 5 && this.stateT > 0.8 && this.supCd <= 0 &&
           Math.random() < D.sup*dt*1.8){ this.go('suppress'); break; }
        // Бой ушёл за горизонт позиции: с 80 м бот только демаскируется, а
        // попасть не может. Такую точку меняем, не дожидаясь её срока.
        if(this.onPost && this.post && this.kAge < 6 && this.postT > 4 &&
           Math.hypot(this.post.x - this.kx, this.post.z - this.kz) > 58){ this.pickPost(false); break; }
        // Занятую позицию держим до её собственного срока: дошёл — работай,
        // а не «постоял восемь секунд и пошёл искать лучшую».
        if(this.stateT > this.holdNeed && (!this.onPost || this.postT > this.postMax)) this.pickPost(false);
        break;
      }

      case 'aim': {
        this.wantCrouch = 0.85;
        this.charge += dt;
        this.solveT -= dt;
        if(this.solveT <= 0){ this.solveT = 0.28; this.aimSolution(); }
        const aimed = Math.abs(angDiff(this.yaw, this.aimYaw)) < 0.055 &&
                      Math.abs(this.pitch - this.aimPitch) < 0.09;
        // laserT — гарантия, что луч успел побыть на экране: без него выстрел нечестен
        if(this.charge > this.chargeNeed && aimed && this.laserT > 0.34){ this.shoot(); break; }
        if(this.loseT > 0.9){
          if(this.resume()) break;
          if(this.kAge < 4 && this.supCd <= 0 && Math.random() < D.sup) this.go('suppress');
          else this.go('hold');
          break;
        }
        // цель мелькает, чистой линии нет — давить огнём или менять точку,
        // но не примерзать к прицелу на полминуты
        if(this.stateT > this.aimGiveUp){
          if(this.resume()) break;
          if(this.kAge < 5 && this.supCd <= 0 && Math.random() < 0.6) this.go('suppress');
          else this.pickPost(false);
          break;
        }
        // в упор снайпер бесполезен — разрывать дистанцию
        if(this.stateT > 1.2 && this.tgtDist() < 9 && Math.random() < 0.02) this.goRegroup();
        break;
      }

      case 'suppress': {
        this.wantCrouch = 0.55;
        if(this.los && this.seeT > this.reactNeed*0.7){ this.go('aim'); break; }
        if(this.kAge > 6 || this.stateT > 6.5){
          this.supN = 0; this.supCd = rnd(4, 8);
          if(!this.resume()) this.go('hold');
          break;
        }
        this.charge += dt;
        this.solveT -= dt;
        if(this.solveT <= 0){ this.solveT = 0.32; this.supSolution(); }
        const aimed = Math.abs(angDiff(this.yaw, this.aimYaw)) < 0.09;
        if(this.charge > this.chargeNeed*0.75 && aimed && this.laserT > 0.30){
          this.shoot();
          this.supN--;
          if(this.supN <= 0) this.supCd = rnd(4.5, 9);
        }
        break;
      }

      case 'shot': {
        this.reload -= dt;
        this.wantCrouch = 0.9;
        if(this.reload <= 0){
          const close = this.tgtDist() < 20;
          // «выстрелил — смени точку»: засидевшегося снайпера игрок вычисляет
          // по вспышке и снимает вслепую, это скучно для обеих сторон.
          // Тому, кто до позиции ещё не дошёл, даём запас — иначе маршрут
          // рвётся на каждом выстреле и бот только и делает, что выбирает точки.
          const stale = this.postT > (this.onPost ? this.postMax : this.postMax*1.6);
          if(stale) this.pickPost(close);
          // Отстрелялся по дороге — возвращаемся на маршрут. Именно здесь
          // раньше рвалась связь «выбрал точку — дошёл — работаю с неё».
          else if(this.resume()) {}
          else if(this.supN > 0 && this.kAge < 6) this.go('suppress');
          else if(this.los && !close && Math.random() < 0.58 + (this.role === 'anchor' ? 0.18 : 0)) this.go('aim');
          else if(!this.los && this.kAge < 4 && this.supCd <= 0 && Math.random() < D.sup*0.8) this.go('suppress');
          // Смена точки после выстрела — приём против «вычислили по вспышке»,
          // но свежую позицию сначала надо отработать: иначе снайпер только
          // и делает, что переезжает, и не успевает быть опасным.
          else if(this.onPost && this.postT < this.postMax*0.55 && Math.random() < 0.72) this.go('hold');
          else this.pickPost(close);
        }
        break;
      }

      case 'retreat': {
        this.run = true;
        const w = this.wp();
        if(w) this.mv = w;
        const safe = (this.burn <= 0 && this.fireK <= 0 && this.danger < 0.5);
        if(!w || (safe && this.stateT > 1.2) || this.stateT > 5.5) this.pickPost(true);
        break;
      }

      case 'regroup': {
        this.run = true;
        const w = this.wp();
        if(w) this.mv = w;
        // на отходе всё равно огрызаемся, если цель сама подставилась
        if(this.los && this.seeT > this.reactNeed*1.6 && this.stateT > 0.6){ this.go('aim'); break; }
        if(!w || this.stateT > 6.5) this.pickPost(true);
        break;
      }

      default: this.go('hold');
    }
  }

  /* ------------------------------ перемещение ------------------------------ */
  locomote(dt){
    // подтягивание на уступ: короткая дуга, а не телепорт
    if(this.mantleT > 0){
      this.mantleT -= dt;
      const k = 1 - clamp(this.mantleT/CFG.mantleTime, 0, 1);
      this.pos.x = lerp(this.mantleFrom.x, this.mantleTo.x, k);
      this.pos.z = lerp(this.mantleFrom.z, this.mantleTo.z, k);
      this.pos.y = lerp(this.mantleFrom.y, this.mantleTo.y, smoothstep(0, 1, k));
      this.vel.set(0, 0, 0);
      this.grounded = true; this.speed = 0;
      if(this.mantleT <= 0) this.pos.copy(this.mantleTo);
      return;
    }

    if(this.state === 'climb'){
      const z = this.climbZone;
      if(z){
        // держимся оси лестницы, иначе бота стаскивает с неё коллизиями
        this.vel.x = damp(this.vel.x, (z.x - this.pos.x)*3.2, 10, dt);
        this.vel.z = damp(this.vel.z, (z.z - this.pos.z)*3.2, 10, dt);
      } else { this.vel.x = damp(this.vel.x, 0, 12, dt); this.vel.z = damp(this.vel.z, 0, 12, dt); }
      moveHoriz(this, dt); moveVert(this, dt);
      this.speed = 0;
      this.walkT += CFG.climbSpeed*dt*2.2;
      return;
    }

    const mv = this.mv;
    let spd = 0;
    if(mv){
      spd = this.run ? (this.role === 'rusher' ? 7.0 : 6.2) : 2.6;
      if(this.burn > 0 || this.danger > 0.8) spd *= 1.12;
      let dx = mv.x - this.pos.x, dz = mv.z - this.pos.z;
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      this.moveYaw = Math.atan2(-dx, -dz);
      if(this.sideT > 0){
        // обход препятствия боком: чистый «в лоб» упирается в угол ящика
        this.sideT -= dt;
        const s = this.side, tx = -dz*s, tz = dx*s;
        dx = dx*0.42 + tx*0.9; dz = dz*0.42 + tz*0.9;
        const l2 = Math.hypot(dx, dz) || 1; dx /= l2; dz /= l2;
      }
      this.vel.x = damp(this.vel.x, dx*spd, 9, dt);
      this.vel.z = damp(this.vel.z, dz*spd, 9, dt);
    } else {
      this.vel.x = damp(this.vel.x, 0, 12, dt);
      this.vel.z = damp(this.vel.z, 0, 12, dt);
    }

    // расталкивание: отделение не должно слипаться в один силуэт
    for(let i=0;i<enemies.length;i++){
      const o = enemies[i];
      if(o === this || !o.alive) continue;
      const dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z;
      const d = Math.hypot(dx, dz);
      if(d > 1e-3 && d < 1.75 && Math.abs(this.pos.y - o.pos.y) < 1.7){
        const k = (1.75 - d)/1.75 * 7.0 * dt;
        this.vel.x += dx/d*k; this.vel.z += dz/d*k;
      }
    }

    const px = this.pos.x, pz = this.pos.z;
    this.landV = 0;
    moveHoriz(this, dt); moveVert(this, dt);
    const moved = Math.hypot(this.pos.x - px, this.pos.z - pz);
    this.speed = moved/Math.max(dt, 1e-4);

    if(mv){
      this.wpT += dt;
      if(moved < spd*dt*0.35){
        this.stuck += dt;
        if(this.stuck > 0.35){
          this.stuck = 0; this.stuckN++;
          this.side = Math.random() < 0.5 ? -1 : 1;
          this.sideT = rnd(0.6, 1.1);
          // невысокий уступ разумнее перелезть, чем обходить его кругом
          const mm = AI_mantleFind(this, -Math.sin(this.moveYaw), -Math.cos(this.moveYaw));
          if(mm){
            this.mantleFrom.copy(this.pos);
            this.mantleTo.set(mm.x, mm.y, mm.z);
            this.mantleT = CFG.mantleTime;
            this.stuckN = 0; this.sideT = 0;
          } else if(this.stuckN > 3){ this.stuckN = 0; this.failPost(); }
        }
      } else this.stuck = Math.max(0, this.stuck - dt*1.5);
      if(this.wpT > 7.5){ this.wpT = 0; this.pi++; }   // точка недостижима — дальше по маршруту
    }
    this.walkT += moved*3.4;
  }

  /* ------------------------------ ориентация ------------------------------ */
  orient(dt){
    const aiming = this.aiming;
    if(this.state === 'climb'){
      this.aimYaw = this.climbYaw; this.aimPitch = 0.30;
    } else if(aiming){
      AI_v1.copy(this.aimPt).sub(this.eye(AI_v2));
      this.aimYaw = Math.atan2(-AI_v1.x, -AI_v1.z);
      this.aimPitch = Math.atan2(AI_v1.y, Math.hypot(AI_v1.x, AI_v1.z));
    } else if(this.los && this.tgt && this.tgt.alive){
      AI_v1.subVectors(AI_tgCenter(this.tgt, AI_v2), this.eye(AI_v3));
      this.aimYaw = Math.atan2(-AI_v1.x, -AI_v1.z);
      this.aimPitch = Math.atan2(AI_v1.y, Math.hypot(AI_v1.x, AI_v1.z));
    } else if(this.mv){
      this.aimYaw = Math.atan2(-(this.mv.x - this.pos.x), -(this.mv.z - this.pos.z));
      this.aimPitch = 0;
    } else if(this.kAge < 6){
      // контакта нет — смотрим туда, где цель была в последний раз
      this.aimYaw = Math.atan2(-(this.kx - this.pos.x), -(this.kz - this.pos.z));
      this.aimPitch = 0;
    }
    const turn = aiming ? 6.5 : (this.mv ? 7.5 : 4.0);
    this.yaw += angDiff(this.aimYaw, this.yaw)*clamp(turn*dt, 0, 1);
    this.pitch = damp(this.pitch, this.aimPitch, 8, dt);
  }

  /* ------------------------------- анимация -------------------------------
     Поза обязана читаться со 100 м: стоит / бежит / целится / лезет. */
  animate(dt){
    const U = this.m.userData, R = this.rest;
    this.m.position.set(this.pos.x, this.pos.y, this.pos.z);
    this.m.rotation.y = this.yaw;

    this.aimBlend = damp(this.aimBlend, this.aiming ? 1 : 0, 7, dt);
    this.recoil = Math.max(0, this.recoil - dt*4.2);

    if(this.state === 'climb'){ this.poseClimb(dt); return; }

    const ab = this.aimBlend, carry = 1 - ab, cr = this.crouch;
    const gait = clamp(this.speed/6.2, 0, 1);
    const sw = Math.sin(this.walkT), sw2 = Math.cos(this.walkT);
    const amp = 0.16 + 0.78*gait;

    // ноги
    U.legL.L.rotation.x = sw*amp - cr*0.95;
    U.legR.L.rotation.x = -sw*amp - cr*0.95;
    U.legL.K.rotation.x = Math.max(0, -sw*0.55)*amp + cr*1.65;
    U.legR.K.rotation.x = Math.max(0, sw*0.55)*amp + cr*1.65;

    // Таз развёрнут по движению, корпус — по прицелу: бот, бегущий боком
    // и смотрящий на игрока, сразу читается как «меня заметили».
    const twist = (gait > 0.05) ? clamp(angDiff(this.moveYaw, this.yaw), -0.95, 0.95) : 0;
    U.hips.rotation.y = damp(U.hips.rotation.y, twist, 8, dt);
    U.hips.position.y = R.hip - cr*0.42 + gait*Math.abs(sw2)*0.05;
    U.torso.position.y = U.hips.position.y;

    const yerr = clamp(angDiff(this.aimYaw, this.yaw), -0.4, 0.4);
    const rp = this.aiming ? this.aimPitch : this.pitch;

    U.torso.rotation.y = yerr*0.7;
    U.torso.rotation.x = rp*0.32 + cr*0.22 + gait*0.16 - this.recoil*0.14;
    U.torso.rotation.z = -twist*0.10;

    U.head.position.y = U.hips.position.y + R.head;
    U.head.rotation.y = yerr*0.35;
    U.head.rotation.x = rp*0.5 + ab*0.12 - gait*0.10;

    const aY = U.hips.position.y;
    U.armL.A.position.y = aY + R.armLY;
    U.armR.A.position.y = aY + R.armRY;

    // Винтовка: на изготовку при прицеливании, у бедра — на бегу.
    U.rifle.position.set(R.rifleX - carry*0.05, aY + R.rifleY - carry*0.15, R.rifleZ + carry*0.10);
    U.rifle.rotation.set(R.rifRx + rp*ab - carry*0.42 - this.recoil*0.30, yerr*ab, carry*0.30);

    const swing = sw*0.32*gait*carry;
    U.armR.A.rotation.set(R.aRx + carry*0.55 + swing + rp*0.6*ab, R.aRy + yerr*0.30*ab, R.aRz);
    U.armL.A.rotation.set(R.aLx + carry*0.72 - swing + rp*0.6*ab, R.aLy + yerr*0.30*ab, R.aLz);
    U.armR.E.rotation.x = R.eRx - carry*0.35;
    U.armL.E.rotation.x = R.eLx - carry*0.25;

    // затвор передёргивается ровно тогда, когда бот перезаряжается
    const bolt = U.rifle.userData ? U.rifle.userData.bolt : null;
    if(bolt){
      const total = AMMO[0].bolt;
      const k = (this.state === 'shot') ? clamp(1 - this.reload/Math.max(0.01, total), 0, 1) : 0;
      bolt.position.z = this.boltZ + Math.sin(k*Math.PI)*0.16;
    }

    // огонь на бойце жмётся к телу, а не висит в воздухе
    if(this.fireFx) this.fireFx.position.y = -cr*0.42;
  }

  poseClimb(dt){
    const U = this.m.userData, R = this.rest;
    // фаза перехвата берётся от высоты: руки идут в такт реальному подъёму
    const s = Math.sin(this.pos.y*3.2);
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
    // винтовка уходит за спину — обе руки заняты
    U.rifle.position.set(R.rifleX, aY + R.rifleY - 0.18, R.rifleZ + 0.34);
    U.rifle.rotation.set(0.5, 0, 1.25);
    if(this.fireFx) this.fireFx.position.y = 0;
  }

  /* -------------------------- телеграф выстрела --------------------------
     Луч и блик оптики — единственное, что даёт игроку шанс среагировать.
     Никакой выстрел не проходит, пока луч не побыл на экране (laserT). */
  telegraph(dt){
    const U = this.m.userData;
    const show = (this.state === 'aim' && this.los) || this.state === 'suppress';
    U.laser.visible = show; U.dot.visible = show;
    U.glint.visible = (this.state === 'aim' || this.state === 'suppress');
    if(show){
      this.laserT += dt;
      const mz = this.muzzle(AI_v1);
      const d = clamp(mz.distanceTo(this.aimPt), 0.5, 400);
      U.laser.scale.y = d;
      U.laser.position.set(0, 0.02, -1.02 - d/2);
      const k = clamp(this.charge/Math.max(0.2, this.chargeNeed), 0, 1);
      if(U.laser.material) U.laser.material.opacity = 0.22 + 0.42*k;
      U.dot.position.copy(this.aimPt);
      U.dot.scale.setScalar(0.26 + 0.20*Math.sin(game.time*22) + k*0.18);
    } else {
      // Мигание цели за редкой листвой не должно обнулять телеграф навсегда,
      // но убывает счётчик вдвое быстрее, чем набирается — луч всё равно
      // обязан быть на экране перед выстрелом.
      this.laserT = Math.max(0, this.laserT - dt*2);
    }
    if(U.glint.visible){
      // блик виден, только когда оптика смотрит примерно на камеру
      AI_v1.subVectors(camera.position, this.pos).normalize();
      AI_v2.set(-Math.sin(this.gunYaw), 0, -Math.cos(this.gunYaw));
      const f = clamp((AI_v1.dot(AI_v2) - 0.88)*9, 0, 1);
      U.glint.material.opacity = f*(0.55 + 0.45*Math.sin(game.time*9));
    }
  }

  /* ------------------------------ прицеливание ------------------------------ */
  aimSolution(){
    const T = this.tgt;
    // Цели нет вовсе (сеть, все противники вышли) — бьём по последней
    // известной точке: состояние 'aim' без цели всё равно долго не живёт.
    if(!T){ this.supSolution(); return; }
    const EV = AMMO[0].v*0.94;
    const from = this.eye(AI_v3);
    AI_tgCenter(T, AI_v1);
    if(Math.random() < D.hs) AI_v1.y = AI_tgHeadY(T);
    const dist = from.distanceTo(AI_v1);
    const t = dist/EV;
    const lead = t*D.lead;                                // упреждение
    AI_v1.x += T.vx*lead; AI_v1.y += T.vy*lead; AI_v1.z += T.vz*lead;
    AI_v1.y += 0.5*CFG.bulletG*0.9*t*t;                   // поправка на падение пули
    const psp = Math.hypot(T.vx, T.vz);
    const selfSp = Math.min(1.0, this.speed*0.10);
    // ошибка растёт от дистанции, скорости цели, собственного бега и «свежести» позиции
    const errDeg = D.err*(0.55 + dist/95)*(1 + Math.min(1.1, psp*0.075))*this.flinch*
                   (1 + this.settleErr*0.9 + selfSp);
    const errM = Math.tan(errDeg*Math.PI/180)*dist;
    const ang = rnd(0, 6.283);
    AI_v2.subVectors(AI_v1, from).normalize();
    AI_v4.set(0, 1, 0);
    const rt = AI_v5.crossVectors(AI_v2, AI_v4).normalize();
    AI_v1.addScaledVector(rt, Math.cos(ang)*errM);
    AI_v1.y += Math.sin(ang)*errM*0.7;
    this.aimPt.copy(AI_v1);
  }

  rollSup(){
    // куда именно бить «по краю укрытия» — решаем один раз на выстрел
    this.supA = rnd(0, 6.283);
    this.supR = rnd(0.4, 1.9);
    this.supY = rnd(-0.25, 1.0);
  }
  supSolution(){
    // Стреляем не в игрока, а рядом с последней известной точкой: задача
    // не убить наверняка, а сделать сидение за ящиком некомфортным.
    const gy = Math.max(gh(this.kx, this.kz), this.ky);
    this.aimPt.set(this.kx + Math.cos(this.supA)*this.supR,
                   gy + 1.05 + this.supY,
                   this.kz + Math.sin(this.supA)*this.supR);
  }

  shoot(){
    const EV = AMMO[0].v*0.94;
    const mz = this.muzzle(AI_v1);
    AI_v2.copy(this.aimPt).sub(mz).normalize();
    const a = AMMO[0];
    const b = spawnBullet(mz, AI_v2, {v:EV, drag:a.drag, gMul:0.9, windMul:a.windMul, col:0xffd0a0, trail:0xffe0b0, id:'ai'},
                38*D.dmg, 'enemy', 0);
    // Пулю бота 60_weapon.js сверяет только с локальным игроком: удалённых
    // там нет. Берём её на карандаш и досчитываем попадания сами.
    if(AI_isHost()) AI_trackShot(b);
    const d = this.pos.distanceTo(camera.position);
    SFX.shot('match', panOf(this.pos), volOf(this.pos)*0.9, Math.min(0.9, d/340));
    FX.burst(mz, 4, {mat:PMAT.smoke, speed:2.2, life:0.5, size:0.09, s1:0.2, g:-0.7});
    AI_flash(mz, 0xffcf8a, 2.6, 13, 0.07);
    this.charge = 0;
    this.recoil = 1;
    this.laserT = 0;
    this.reload = AMMO[0].bolt*rnd(0.9, 1.15);
    this.state = 'shot'; this.stateT = 0;
  }

  /* ------------------------------- урон и смерть ------------------------------- */
  applyBurn(total, fresh){
    // Урон копится: стоять в очаге и «пережидать» его нельзя.
    this.burn = Math.min(66, this.burn + total);
    this.danger += 0.45;
    if(!this.fireFx){
      this.fireFx = new THREE.Group();
      for(let i=0;i<3;i++){
        const s = new THREE.Sprite(new THREE.SpriteMaterial({map:TEX_FIRE, color:0xff8030, blending:THREE.AdditiveBlending, depthWrite:false}));
        s.position.set(rnd(-0.25,0.25), 0.5 + i*0.45, rnd(-0.2,0.2));
        s.scale.setScalar(0.9);
        this.fireFx.add(s);
      }
      this.m.add(this.fireFx);
    }
    this.fireFx.visible = true;
    if(fresh) this.flinch = Math.max(this.flinch, 1.8);
  }

  /* Кто в нас попал. Точно бот этого не знает: заявка приходит от чужого
     клиента и без обратного адреса. Ставим на свою цель, а если её нет —
     на ближайшего живого противника. Офлайн это всегда локальный игрок. */
  shooter(){
    const t = this.tgt;
    if(t && t.on && t.alive) return t;
    return AI_nearFoe(this.pos.x, this.pos.z, true);
  }

  hurt(dmg, part, at, by){
    if(!this.alive) return;
    this.hpBefore = this.hp;
    this.hp -= dmg;
    this.flinch = Math.min(3.4, this.flinch + 1.2 + dmg*0.018);
    this.loseT = 0;
    this.danger += dmg*0.014 + (part === 'splash' ? 0.60 : 0.16);
    if(at){ this.threat.copy(at); this.threatT = game.time; }

    // Откуда прилетело — бот не знает точно, но направление угадывает.
    // Ошибка растёт с дистанцией: дальнего снайпера так просто не вычислить.
    const S = this.shooter();
    if(S){
      const dp = Math.hypot(S.x - this.pos.x, S.z - this.pos.z);
      const err = clamp(dp*0.07, 1.5, 13);
      this.remember(S.x + rnd(-err, err), S.z + rnd(-err, err), S.y, true);
    }
    if(this.hp <= 0){ this.die(part, at, by); return; }

    SQUAD.alert = Math.min(1, SQUAD.alert + 0.35);
    if(this.state === 'hold' || this.state === 'settle' || this.state === 'suppress')
      this.seeT = Math.max(this.seeT, D.react[0]*0.5);

    if(this.hp < 45 && Math.random() < 0.5) this.goRegroup();
    else if(this.danger > 1.0) this.goRetreat(this.threatPt());
    // С занятой позиции из-за одной пули не срываемся: это дуэль снайперов,
    // а не игра в догонялки. По дороге же смена точки — нормальная реакция.
    else if(this.state !== 'aim' && Math.random() < (this.onPost ? 0.12 : 0.30)) this.pickPost(false);
  }

  /* by — необязательная атрибуция убийцы. Локально её знать неоткуда: в сети
     бота может снять кто угодно, и заявка приходит через сервер. Поэтому в
     сети (§5-бис) здесь не начисляется ни фраг, ни лента от первого лица, и
     тем более не зовётся endGame: конец матча определяет только серверный
     счёт, иначе хост «побеждает» посреди боя за чужие попадания.
     Офлайн всё ровно как было. */
  die(part, at, by){
    this.alive = false; this.deadT = 0;
    this.killer = (by === undefined || by === null) ? -1 : by;
    const net = AI_netOn();
    const U = this.m.userData;
    U.laser.visible = false; U.dot.visible = false; U.glint.visible = false;
    if(this.fireFx) this.fireFx.visible = false;
    this.burn = 0; this.noGrav = false; this.mantleT = 0; this.supN = 0;
    const pn = (this.post && this.post.name) ? this.post.name : '';
    this.avoidAdd(this.post, 20);   // на той же точке второй раз умирать не хочется
    this.freePost();
    if(!net) game.kills++;

    // Товарищи видят, что бойца выбило: ближние нервничают и меняют позиции.
    if(D.squad){
      SQUAD.alert = Math.min(1, SQUAD.alert + 0.4);
      for(let i=0;i<enemies.length;i++){
        const o = enemies[i];
        if(o === this || !o.alive) continue;
        if(Math.hypot(o.pos.x - this.pos.x, o.pos.z - this.pos.z) < 26) o.danger += 0.45;
      }
    }

    FX.burst(at || this.center(AI_v1), part === 'head' ? 22 : 12, {mat:PMAT.blood, speed:7, life:0.8, size:0.11});
    if(part === 'head'){
      // шляпа слетает — фирменный жест; он не про счёт, поэтому есть и в сети
      const hat = U.hat;
      this.m.updateMatrixWorld(true);
      const wp = hat.getWorldPosition(new THREE.Vector3());
      const fly = hat.clone(true);
      fly.position.copy(wp); fly.rotation.set(0, this.yaw, 0);
      scene.add(fly); hat.visible = false;
      flyingHats.push({m:fly, v:V(rnd(-2,2), rnd(4.5,7), rnd(-2,2)), w:V(rnd(-6,6), rnd(-6,6), rnd(-6,6)), t:0});
    }
    if(net) return;                 // счёт, лента и конец матча в сети — дело сервера

    if(part === 'head'){
      addFeed('<span class="b">ВЫ</span> ✖ <span class="r">RED СНАЙПЕР</span> <span class="w">· ХЕДШОТ</span>');
      toast('КРИТИЧЕСКОЕ ПОПАДАНИЕ', Math.round((at || this.pos).distanceTo(player.pos)) + ' М · В ГОЛОВУ');
    } else {
      let tag = '';
      if(part === 'splash') tag = ' <span class="w">· ФУГАС</span>';
      else if(part === 'burn') tag = ' <span class="w">· ОГОНЬ</span>';
      else if(pn) tag = ' <span class="w">· ' + pn + '</span>';
      addFeed('<span class="b">ВЫ</span> ✖ <span class="r">RED СНАЙПЕР</span>' + tag);
    }
    updateScore();
    if(game.kills >= CFG.killGoal) endGame(true);
  }

  respawn(first){
    if(first) SQUAD.reset();
    // Спавн подальше от противника: появиться прямо под прицел — не бой, а
    // лотерея. В сети «противник» не один, поэтому меряем до ближайшего.
    this.tgt = null;
    const T = AI_targets();
    let best = null, bd = -1e9;
    for(let i=0;i<SPAWNS_RED.length;i++){
      const s = SPAWNS_RED[i];
      let near = 1e9;
      for(let j=0;j<T.length;j++){
        const q = T[j];
        if(!AI_foe(q)) continue;
        const dq = Math.hypot(s.x - q.x, s.z - q.z);
        if(dq < near) near = dq;
      }
      if(near > 1e8) near = 0;
      const d = near + rnd(0, 25);
      if(d > bd){ bd = d; best = s; }
    }
    if(!best) best = {x:0, z:60, y:gh(0,60)};
    // высоту берём по рельефу: площадки баз могут уехать при правках террейна
    const gy = gh(best.x, best.z);
    this.pos.set(best.x, Math.max(best.y === undefined ? gy : best.y, gy) + 0.2, best.z);
    this.vel.set(0, 0, 0);

    this.hp = 100; this.hpBefore = 100; this.alive = true; this.deadT = 0;
    this.burn = 0; this.burnLeave = 0; this.danger = 0; this.fireK = 0; this.threatT = -99;
    this.crouch = 0; this.wantCrouch = 0; this.aimBlend = 0; this.recoil = 0;
    this.h = CFG.height; this.grounded = false; this.stepUp = 0; this.landV = 0;
    this.noGrav = false; this.mantleT = 0; this.climbZone = null; this.climbT = 0;
    this.seeT = 0; this.loseT = 0; this.los = false; this.behind = false;
    this.charge = 0; this.reload = 0; this.flinch = 1; this.settleErr = 0;
    this.laserT = 0; this.stuck = 0; this.stuckN = 0; this.sideT = 0; this.speed = 0;
    this.supN = 0; this.supCd = rnd(0, 3); this.reported = -99;
    this.postT = 0; this.postMax = rnd(18, 30); this.onPost = false;
    this.travelT = 0; this.breaks = 0; this.breakT = -99; this.failN = 0;
    this.mem.t = -999; this.roleT = 0; this.roleSeed = Math.random();
    this.wantSector = -1; this.wantBear = -1; this.secT = 0;
    this.walkT = 0; this.pitch = 0; this.aimPitch = 0;
    // лицом к ближайшему противнику, а не в чистое поле
    const F = AI_nearFoe(this.pos.x, this.pos.z, false);
    this.yaw = F ? Math.atan2(-(F.x - this.pos.x), -(F.z - this.pos.z)) : this.yaw;
    this.aimYaw = this.yaw; this.gunYaw = this.yaw; this.gunPitch = 0; this.moveYaw = this.yaw;
    this.refreshKnown();

    // Чёрный список позиций чистим на каждом появлении: его метки привязаны
    // к game.time, а на новом матче он начинается с нуля — иначе боец выходит
    // в бой с вечно вычеркнутыми точками из прошлой жизни. Точку, на которой
    // его убили, возвращаем в список: второй раз туда лезть незачем.
    const diedAt = first ? null : this.avoidPost;
    for(let i=0;i<this.avoidA.length;i++){ this.avoidA[i] = null; this.avoidTs[i] = 0; }
    this.avoidI = 0; this.avoidPost = null;
    if(diedAt) this.avoidAdd(diedAt, 14);

    this.m.visible = true;
    this.m.rotation.set(0, this.yaw, 0);
    this.m.userData.hat.visible = true;
    this.m.userData.hat.position.set(0, 0.34, 0);
    this.m.userData.hat.rotation.set(0, 0, 0);
    if(this.fireFx) this.fireFx.visible = false;
    this.poseRest();
    this.pickPost(true);
    if(!first) SFX.spawn();
  }

  /* Сброс позы: после смерти конечности остаются вывернутыми, и свежий
     боец появляется в позе трупа, если этого не сделать. */
  poseRest(){
    const U = this.m.userData, R = this.rest;
    U.hips.position.y = R.hip; U.hips.rotation.set(0, 0, 0);
    U.torso.position.y = R.torso; U.torso.rotation.set(0, 0, 0);
    U.head.position.y = R.hip + R.head; U.head.rotation.set(0, 0, 0);
    U.legL.L.rotation.set(0, 0, 0); U.legR.L.rotation.set(0, 0, 0);
    U.legL.K.rotation.set(0, 0, 0); U.legR.K.rotation.set(0, 0, 0);
    U.armL.A.position.y = R.hip + R.armLY; U.armR.A.position.y = R.hip + R.armRY;
    U.armL.A.rotation.set(R.aLx, R.aLy, R.aLz);
    U.armR.A.rotation.set(R.aRx, R.aRy, R.aRz);
    U.armL.E.rotation.x = R.eLx; U.armR.E.rotation.x = R.eRx;
    U.rifle.position.set(R.rifleX, R.hip + R.rifleY, R.rifleZ);
    U.rifle.rotation.set(R.rifRx, 0, 0);
    if(this.fireFx) this.fireFx.position.y = 0;
  }

  /* -------------------------------- кадр -------------------------------- */
  update(dt){
    // страховка: если 90_game.js почему-то не позвал SQUAD, отделение всё
    // равно думает — повторный вызов за кадр отсекается внутри
    SQUAD.update(dt);

    if(!this.alive){
      this.deadT += dt;
      const k = clamp(this.deadT/0.5, 0, 1);
      this.m.rotation.set(-k*Math.PI/2*0.92, this.yaw, 0);
      this.m.position.set(this.pos.x, this.pos.y + Math.sin(k*3.14)*0.12, this.pos.z);
      if(this.deadT > D.respawn*0.55) this.m.visible = (Math.floor(this.deadT*8) % 2 === 0);
      if(this.deadT > D.respawn) this.respawn(false);
      return;
    }

    if(this.burn > 0){
      const tick = Math.min(this.burn, AMMO[2].burnDps*dt);
      this.burn -= tick; this.hp -= tick;
      if(this.burn <= 0 && this.fireFx) this.fireFx.visible = false;
      if(this.hp <= 0){ this.die('burn', this.center(AI_v1)); return; }
    }
    if(this.fireFx && this.fireFx.visible){
      const ch = this.fireFx.children;
      for(let i=0;i<ch.length;i++) ch[i].scale.setScalar(0.7 + 0.35*Math.sin(game.time*11 + i*2));
    }

    this.flinch = damp(this.flinch, 1, 2.2, dt);
    this.settleErr = damp(this.settleErr, 0, 1.15, dt);
    this.postT += dt;
    if(this.supCd > 0) this.supCd -= dt;

    this.sense(dt);
    this.brain(dt);
    this.aiming = (this.state === 'aim' || this.state === 'shot' || this.state === 'suppress');
    this.locomote(dt);

    const upright = (this.state === 'move' || this.state === 'retreat' ||
                     this.state === 'regroup' || this.state === 'climb');
    this.crouch = damp(this.crouch, upright ? 0 : this.wantCrouch, 7, dt);
    this.h = CFG.height - this.crouch*0.42;

    this.orient(dt);
    // ствол смотрит точно в решение — иначе луч телеграфа врёт игроку
    this.gunPitch = this.aiming ? this.aimPitch : this.pitch;
    this.gunYaw = this.yaw + (this.aiming ? clamp(angDiff(this.aimYaw, this.yaw), -0.4, 0.4) : 0);

    this.animate(dt);
    this.telegraph(dt);
  }
}

function angDiff(a, b){
  let d = (a - b) % (Math.PI*2);
  if(d > Math.PI) d -= Math.PI*2;
  if(d < -Math.PI) d += Math.PI*2;
  return d;
}
