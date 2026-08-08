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

/* ---------------------- ПОСАДКА ЛУКА В КАДРЕ ----------------------
   Отдельная от винтовки, и это главное по замечанию заказчика. У винтовки
   ствол лежит вдоль взгляда и модель стоит почти по центру — правильно для
   винтовки и смертельно для лука: по центру он читается как «висящий перед
   персонажем предмет», а не как оружие в руках.

   Что здесь сделано осознанно:
     · лук СМЕЩЁН ВЛЕВО — его держит левая рука, и рукоять обязана быть с
       той стороны, откуда приходит предплечье;
     · лук НАКЛОНЁН (rz): 14.9° в покое и 9.5° на полном натяге — настоящий
       стрелок никогда не держит лук вертикально, и без наклона плечи режут
       кадр ровно пополам;
     · доворот корпуса на натяге сделан yaw'ом (ry): в покое лук развёрнут
       поперёк тела (+0.12), на натяге доворачивается к цели (−0.06) и
       проходит через ноль — это и читается как поворот корпуса;
     · лук ПОДТЯНУТ К ЛИЦУ (z −0.095 → −0.055): вместе со scale 0.80 плечи
       уходят за кромки кадра, и оружие перестаёт быть «иконкой в углу».

   Число full.x = −0.045 не подобрано на глаз, а вымерено по кадру: при нём
   остриё наложенной стрелы стоит в 0.4° от марки (то есть практически на
   ней), а рукоять ложится полосой 1.1°…3.9° ПРАВЕЕ марки. Линия прицеливания
   при этом проходит слева от рукояти, через окно лука, — ровно так и целятся
   из лука правши. Сдвиг влево на 2 см уводил марку под саму рукоять, сдвиг
   вправо — отрывал стрелу от марки на два градуса.

   Ни одно число не совпадает с винтовочным (у неё покой 0.16/−0.20/−0.42,
   прицел 0.012/−0.105/−0.30): у лука другая посадка, и это видно по кадру,
   а не только по коду. */
/* Три посадки лука, а не две.

   hip  — от бедра, лук занимает левую треть кадра;
   full — полный натяг без прицеливания, лук подтянут к лицу;
   aim  — ПРИЦЕЛИВАНИЕ по ПКМ.

   Третья появилась по замечанию заказчика: «руки при ПКМ не должны мешать
   прицеливанию». Замер это подтвердил в лоб — при прицеливании модель
   занимала 14.0% центральной зоны кадра, ровно столько же, сколько без него.
   Поза лучника честная, но честность тут работает против игры: кисть с
   тетивой и плечо лука стоят там же, куда смотрит марка и куда уходит дуга.

   Поэтому на прицеливании лук уводится вниз и влево — остаётся читаемым
   силуэтом по краю кадра, но центр отдаёт цели. Наклон при этом РАСТЁТ
   (rz), иначе увод читается как «оружие уронили», а не как прицеливание. */
const WPN_BOWPOSE = {
  hip:  { x:-0.145, y:-0.175, z:-0.095, rx: 0.100, ry: 0.120, rz:-0.260 },
  full: { x:-0.045, y:-0.046, z:-0.055, rx:-0.010, ry:-0.060, rz:-0.165 },
  aim:  { x:-0.320, y:-0.300, z:-0.020, rx: 0.075, ry: 0.175, rz:-0.395 }
};
/* Насколько увести лук к позе прицеливания. Не единица: полный увод выносит
   лук за край кадра, и игрок теряет обратную связь о натяге тетивы. */
const WPN_AIM_CLEAR = 0.88;

/* ==================== ДУГА ПОЛЁТА СТРЕЛЫ (ПКМ) ====================

   Подсказка обязана считаться ТОЙ ЖЕ математикой, что updateBullets, иначе
   она врёт — а врущая подсказка хуже её отсутствия. Поэтому здесь дословно
   повторён порядок операций подшага: гравитация, ветер, лобовое, и только
   потом перенос. Стартовая точка и скорость тоже берутся как в spawnBullet
   и WPN_loose: камера + полметра вдоль взгляда, v = a.v · множитель натяга.

   Грубее боевого здесь НЕ шаг интегрирования, а поиск столкновений — и это
   осознанный выбор, потому что дорого именно оно. Интегрирование стоит
   десяток арифметических операций на шаг; один rayBoxes — перебор всех
   коробок карты. Поэтому шагов 240 (h = 0.005 с, номинальный шаг боевого
   подшага), а отрезковых проверок всего 40, по числу точек дуги.

   Что даёт замер: при h = 0.010 точка падения уезжала на 37…51 см, при
   0.005 — на 5…7 см. Для сравнения, СОБСТВЕННЫЙ разброс боевого полёта от
   частоты кадров (60 против 30 и 144 к/с) — 3…4 см. То есть подсказка легла
   в шум самой симуляции: точнее её делать уже нечестно, а грубее — значит
   врать игроку на полметра там, где ему обещана точность.

   КОРОБКИ ищем по точкам дуги: отрезок между соседними точками ~3 м, а
   rayBoxes — отрезковый тест, тонкую стену внутри отрезка он не пропустит.
   ЗЕМЛЮ — на каждом подшаге через terrainH: она дешёвая, а трёхметровая
   хорда на пологом снижении срезает угол траектории и промахивается мимо
   точки касания на полметра. rayTerrain здесь не годится ещё и потому, что
   создаёт объект-результат, а нам обещан ноль аллокаций в кадре.

   Про точку касания земли честно: сама игра находит её грубее нас. Её
   rayTerrain на длине подшага не успевает промаршировать ни одного шага
   (шаг марша 1.4 м против 0.4 м подшага) и срабатывает только тогда, когда
   пуля УЖЕ под землёй. Поэтому игра втыкает стрелу на 2…9 см ниже
   поверхности и на 13…45 см дальше по трассе, а маркер дуги стоит ровно на
   поверхности. Сама траектория при этом совпадает с точностью до сантиметра,
   и по коробкам (а пол зала — коробки) маркер сходится до 0.2…1.1 см.

   Пулы (линия, точки, маркер) созданы один раз в buildViewmodel. */
const WPN_ARC_N   = 40;      // точек в дуге (24..40 по заданию — берём максимум)
const WPN_ARC_H   = 0.005;   // шаг интегрирования, с — номинал боевого подшага
const WPN_ARC_SUB = 6;       // шагов на точку -> 0.03 с между точками
const WPN_ARC_DT  = 0.10;    // не чаще раза в столько секунд
const WPN_ARC_DT2 = 0.035;   // …но при быстром довороте марки — вот так часто
let WPN_arcRoot = null, WPN_arcLine = null, WPN_arcMark = null, WPN_arcAttr = null;
let WPN_arcDotMat = null;
const WPN_arcDots = [];
let WPN_arcT = -1;           // game.time последнего расчёта
let WPN_arcD = 1;            // натяг, под который посчитана дуга (сглаженный)
let WPN_arcDshown = -1;      // …и он же на момент последнего расчёта
let WPN_arcCol = -1;         // какой тип уже покрашен в пулах
const WPN_arcP    = new THREE.Vector3();
const WPN_arcV    = new THREE.Vector3();
const WPN_arcPrev = new THREE.Vector3();
const WPN_arcSub  = new THREE.Vector3();
const WPN_arcSeg  = new THREE.Vector3();
const WPN_arcDir  = new THREE.Vector3();
const WPN_arcLast = new THREE.Vector3(0,0,-1);

function WPN_arcBuild(){
  if(WPN_arcRoot || typeof scene === 'undefined' || !scene) return;
  WPN_arcRoot = new THREE.Group();
  WPN_arcRoot.visible = false;
  scene.add(WPN_arcRoot);

  /* Линия и точки — разные роли: линия связывает дугу в одно целое и видна
     даже там, где точки редки, точки дают чувство скорости и дальности. */
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(WPN_ARC_N*3), 3));
  g.setDrawRange(0, 0);
  WPN_arcAttr = g.attributes.position;
  WPN_arcLine = new THREE.Line(g, new THREE.LineBasicMaterial({
    color:0xd8c89a, transparent:true, opacity:0.30, depthWrite:false }));
  WPN_arcLine.frustumCulled = false;      // границы у геометрии меняются каждый расчёт
  WPN_arcRoot.add(WPN_arcLine);

  WPN_arcDotMat = new THREE.SpriteMaterial({ map:TEX_GLOW, color:0xd8c89a,
    blending:THREE.AdditiveBlending, transparent:true, opacity:0.85, depthWrite:false });
  for(let i=0;i<WPN_ARC_N;i++){
    const s = new THREE.Sprite(WPN_arcDotMat);
    s.frustumCulled = false; s.visible = false;
    WPN_arcRoot.add(s); WPN_arcDots.push(s);
  }
  WPN_arcMark = new THREE.Sprite(new THREE.SpriteMaterial({ map:TEX_GLOW, color:0xfff2c8,
    blending:THREE.AdditiveBlending, transparent:true, depthWrite:false }));
  WPN_arcMark.frustumCulled = false; WPN_arcMark.visible = false;
  WPN_arcRoot.add(WPN_arcMark);
}

/* Один пересчёт дуги. Возвращает число точек; маркер ставит сам. */
function WPN_arcCalc(){
  const a = A();
  const arr = WPN_arcAttr.array;
  const d = clamp(WPN_arcD, 0, 1);
  const vMul = (d < BOW.min) ? BOW.dudV : lerp(BOW.vMin, 1, d);

  /* Направление — как в WPN_loose, вплоть до наклона сорвавшейся стрелы:
     подсказка обязана показывать и то, что недотянутая уйдёт под ноги. */
  WPN_arcSeg.copy(WPN_arcDir);
  if(d < BOW.min){ WPN_arcSeg.y -= 1.25; WPN_arcSeg.normalize(); }

  WPN_arcP.copy(camera.position).addScaledVector(WPN_arcSeg, 0.5);
  WPN_arcV.copy(WPN_arcSeg).multiplyScalar(a.v*vMul);

  const gr = CFG.bulletG*a.gMul, drag = a.drag, wm = a.windMul;
  const dmp = Math.max(0.2, 1 - drag*WPN_ARC_H);
  const wx = wind.x*wm*3.0*WPN_ARC_H, wz = wind.z*wm*3.0*WPN_ARC_H;
  const gy = gr*WPN_ARC_H;

  arr[0] = WPN_arcP.x; arr[1] = WPN_arcP.y; arr[2] = WPN_arcP.z;
  let n = 1, hit = false;
  for(let i=1;i<WPN_ARC_N;i++){
    WPN_arcPrev.copy(WPN_arcP);
    /* Землю ищем НА КАЖДОМ ПОДШАГЕ, а не на хорде между точками дуги. Хорда
       длиной три метра срезает угол траектории и на пологом снижении даёт
       полметра ошибки; полуметровый подшаг ложится на кривую почти точно.
       Стоит это одного вызова terrainH на подшаг — против перебора всех
       коробок, который мы по-прежнему делаем раз на точку. */
    let ground = false;
    for(let s=0;s<WPN_ARC_SUB;s++){
      WPN_arcSub.copy(WPN_arcP);
      // порядок ровно как в updateBullets: тяжесть, ветер, лобовое, перенос
      WPN_arcV.y -= gy;
      WPN_arcV.x += wx; WPN_arcV.z += wz;
      WPN_arcV.multiplyScalar(dmp);
      WPN_arcP.addScaledVector(WPN_arcV, WPN_ARC_H);
      if(WPN_arcP.y < terrainH(WPN_arcP.x, WPN_arcP.z)){
        let lo = 0, hi = 1;
        for(let k=0;k<8;k++){
          const m = (lo+hi)*0.5;
          if(WPN_arcSub.y + (WPN_arcP.y-WPN_arcSub.y)*m <
             terrainH(WPN_arcSub.x + (WPN_arcP.x-WPN_arcSub.x)*m,
                      WPN_arcSub.z + (WPN_arcP.z-WPN_arcSub.z)*m)) hi = m;
          else lo = m;
        }
        const m = (lo+hi)*0.5;
        WPN_arcP.set(WPN_arcSub.x + (WPN_arcP.x-WPN_arcSub.x)*m,
                     WPN_arcSub.y + (WPN_arcP.y-WPN_arcSub.y)*m,
                     WPN_arcSub.z + (WPN_arcP.z-WPN_arcSub.z)*m);
        ground = true; break;
      }
    }
    WPN_arcSeg.subVectors(WPN_arcP, WPN_arcPrev);
    const L = WPN_arcSeg.length();
    if(L > 1e-5){
      WPN_arcSeg.multiplyScalar(1/L);
      /* Коробка ближе земли — значит попали в неё: тот же приоритет, что у
         пули, где rayBoxes отрабатывает раньше rayTerrain. */
      const rb = rayBoxes(WPN_arcPrev, WPN_arcSeg, L);
      if(rb){ WPN_arcP.copy(WPN_arcPrev).addScaledVector(WPN_arcSeg, rb.t); hit = true; }
      else if(ground) hit = true;
    } else if(ground) hit = true;
    arr[i*3] = WPN_arcP.x; arr[i*3+1] = WPN_arcP.y; arr[i*3+2] = WPN_arcP.z;
    n = i+1;
    if(hit) break;
    // те же границы жизни, что у пули: за ними подсказывать нечего
    if(WPN_arcP.y < -30 || Math.abs(WPN_arcP.x) > 140 || Math.abs(WPN_arcP.z) > 140) break;
  }

  // цвет — по типу стрелы, и только когда он реально сменился
  if(WPN_arcCol !== a.col){
    WPN_arcCol = a.col;
    WPN_arcDotMat.color.setHex(a.col);
    WPN_arcLine.material.color.setHex(a.trail);
    WPN_arcMark.material.color.setHex(a.col);
  }

  /* Точки держим одного размера НА ЭКРАНЕ: спрайт живёт в мире, поэтому
     масштабируем его расстоянием до камеры — иначе дальний конец дуги
     превращается в невидимую нитку, а ближний закрывает пол-экрана. */
  for(let i=0;i<WPN_ARC_N;i++){
    const s = WPN_arcDots[i];
    if(i >= n){ if(s.visible) s.visible = false; continue; }
    s.visible = true;
    s.position.set(arr[i*3], arr[i*3+1], arr[i*3+2]);
    s.scale.setScalar(clamp(s.position.distanceTo(camera.position)*0.011, 0.05, 0.60));
  }
  WPN_arcAttr.needsUpdate = true;
  WPN_arcLine.geometry.setDrawRange(0, n);

  // маркер ставим только если дуга во что-то УПЁРЛАСЬ: иначе точки падения нет
  WPN_arcMark.visible = hit;
  if(hit){
    WPN_arcMark.position.set(arr[(n-1)*3], arr[(n-1)*3+1], arr[(n-1)*3+2]);
    WPN_arcMark.scale.setScalar(clamp(WPN_arcMark.position.distanceTo(camera.position)*0.032, 0.16, 1.6));
  }
  return n;
}

function WPN_updateBowArc(dt, bow){
  if(!WPN_arcRoot) return;
  const on = bow && wpn.aim === true && game.state === 'play' && player.alive && wpn.rel <= 0;
  if(!on){
    if(WPN_arcRoot.visible){
      WPN_arcRoot.visible = false;
      WPN_arcT = -1; WPN_arcD = 1; WPN_arcDshown = -1;
    }
    return;
  }
  WPN_arcRoot.visible = true;
  /* Под какой натяг считать. Пока тянем — под ТЕКУЩИЙ (дуга вытягивается
     вместе с тетивой, и это лучшая подсказка, какая бывает); когда не тянем —
     под полный, потому что именно его лук и обещает. Переход сглажен, иначе
     на нажатии ЛКМ дуга схлопывалась бы рывком. */
  WPN_arcD = damp(WPN_arcD, wpn.drawing ? Math.max(wpn.draw, 0.02) : 1, 14, dt);

  camera.getWorldDirection(WPN_arcDir);
  const age = game.time - WPN_arcT;
  const moved = WPN_arcDir.dot(WPN_arcLast) < 0.99997;      // ~0.44°: доворот марки
  const grew = Math.abs(WPN_arcD - WPN_arcDshown) > 0.02;
  if(WPN_arcT < 0 || age < 0 || age >= WPN_ARC_DT ||
     (age >= WPN_ARC_DT2 && (moved || grew))){
    WPN_arcCalc();
    WPN_arcT = game.time; WPN_arcDshown = WPN_arcD; WPN_arcLast.copy(WPN_arcDir);
  }
}

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
  /* Режим залпа и прицеливание — свойства ЛУКА, а не игрока: взяв винтовку,
     игрок не должен обнаружить у неё «залп ×3» и включённое приближение. */
  wpn.volley = false; wpn.aim = false; wpn.aimK = 0; wpn.looseK = 0;
  WPN_volShown = -2; WPN_statusOff('volley');
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
    /* startGame() про режим залпа и прицеливание лука знать не обязан —
       снимаем их здесь же, где и остальное переходное состояние ствола.
       Иначе новый матч начинался бы с залпом, включённым в прошлом бою. */
    wpn.volley = false; wpn.aim = false; wpn.aimK = 0; wpn.looseK = 0;
    WPN_volShown = -2; WPN_statusOff('volley');
    if(WPN_arcRoot){ WPN_arcRoot.visible = false; WPN_arcT = -1; WPN_arcD = 1; WPN_arcDshown = -1; }
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
    /* Залп тянется дольше одиночного: тремя стрелами разом бьют не «просто
       так», а вместо прицельного выстрела — цена в секундах, а не в точности
       (точность залпа остаётся полной, веер к ней отношения не имеет). */
    const dMul = (volleyActive() && W.volley) ? Math.max(1, W.volley.drawMul || 1) : 1;
    const dTime = Math.max(0.05, W.drawTime*dMul);
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
  /* ПКМ у лука. Прицеливание — своё состояние (wpn.aim), и в wpn.sT оно НЕ
     переливается намеренно: на sT завязаны исчезновение вида от первого лица,
     скорость ходьбы, флаг «в оптике» в сети и заметность у ИИ. Лук ничего из
     этого не меняет — он только приближает картинку и успокаивает руку. */
  if(!bow && (wpn.aim || wpn.aimK !== 0)){ wpn.aim = false; wpn.aimK = 0; }
  const wantAim = bow && wpn.aim === true && player.alive && wpn.rel<=0;
  wpn.aimK = damp(wpn.aimK, wantAim ? 1 : 0, 11, dt);
  if(wpn.aimK < 0.0015 && !wantAim) wpn.aimK = 0;
  wpn.looseK = damp(wpn.looseK, 0, 9, dt);
  if(wpn.looseK < 0.002) wpn.looseK = 0;

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
  let fov = lerp(game.fov, ZOOMS[wpn.zoom], wpn.sT) + WPN_scopeSnap*1.6 - WPN_bowZoomK*BOW.zoom;
  /* Приближение по ПКМ задаём КРАТНОСТЬЮ, а не вычитанием градусов: «на 30%
     ближе» — это во столько раз крупнее цель, и через тангенс половины угла
     оно остаётся тридцатью процентами при любом game.fov и поверх сужения от
     натяга. Вычитание градусов дало бы разное приближение на разных настройках
     обзора — и обещание заказчику перестало бы быть числом. */
  if(wpn.aimK > 0 && W.aimZoom > 0){
    const m = 1 + W.aimZoom*wpn.aimK;
    fov = Math.atan(Math.tan(fov*0.5*Math.PI/180)/m)*2*180/Math.PI;
  }
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
  /* Режим залпа обязан быть виден: строка статуса — то же место, где игрок
     уже привык читать откат. Полноценный индикатор в поясе рисует модуль F
     по тем же признакам (wpn.volley / volleyActive()); дублирования нет —
     здесь одна строка, там слот боеприпаса. Строка живёт по TTL, поэтому её
     надо подновлять, но не чаще, чем видно глазу. */
  const volOn = bow && wpn.volley === true;
  const volTick = volOn ? Math.floor(game.time*3) : -1;
  if(volTick !== WPN_volShown){
    WPN_volShown = volTick;
    if(volOn) WPN_status('volley', 'ЗАЛП ×'+(W.volley ? W.volley.n : 3), '#9be8ff');
    else WPN_statusOff('volley');
  }
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

  /* Ход «от бедра → к лицу» у стволов общий: у винтовки его ведёт уход в
     оптику, у лука — натяг. А вот ОПОРНЫЕ ТОЧКИ у них разные, и это не
     косметика. Раньше числа были одни на двоих, и лук вставал ровно туда,
     где стоит винтовка: по центру кадра, вертикально, целиком в поле зрения.
     Именно это заказчик и назвал «чем-то висящим перед персонажем». */
  const aim = bow ? wpn.draw : wpn.sT;
  const s = smoothstep(0, 1, aim);              // 0 — от бедра, 1 — приклад у щеки
  const idle = 1 - aim*0.75;                    // в оптике болтанка модели гасится
  const bobX = Math.sin(t*7)*0.012*player.bob*idle;
  const bobY = Math.abs(Math.cos(t*7))*0.016*player.bob*idle;
  const vm = (bow && vmBow) ? vmBow : vmRifle;
  if(bow){
    /* Лук: своя посадка (WPN_BOWPOSE) — влево, с наклоном, ближе к лицу.
       Довесок от бега/подката/уступа общий с винтовкой: это состояние ИГРОКА,
       а не оружия, и разводить его по стволам значило бы, что один и тот же
       подкат кладёт руки по-разному. Отдача у лука мягче (щелчок тетивы, а не
       удар в плечо), поэтому коэффициенты kick тут меньше винтовочных. */
    const P0 = WPN_BOWPOSE.hip, P1 = WPN_BOWPOSE.full, PA = WPN_BOWPOSE.aim;
    /* Сначала обычная посадка по натягу, потом увод к прицельной по aimK.
       Порядок важен: увод обязан работать на ЛЮБОМ натяге, иначе прицелившись
       без натяга игрок всё равно получает лук поперёк марки. */
    const ak = clamp((wpn.aimK || 0) * WPN_AIM_CLEAR, 0, 1);
    const bx = lerp(lerp(P0.x, P1.x, s), PA.x, ak);
    const by = lerp(lerp(P0.y, P1.y, s), PA.y, ak);
    const bz = lerp(lerp(P0.z, P1.z, s), PA.z, ak);
    const brx = lerp(lerp(P0.rx, P1.rx, s), PA.rx, ak);
    const bry = lerp(lerp(P0.ry, P1.ry, s), PA.ry, ak);
    const brz = lerp(lerp(P0.rz, P1.rz, s), PA.rz, ak);
    /* Дыхание, покачивание и отдачу на прицеливании тоже приглушаем: их
       задача — оживлять оружие в кадре, а у края кадра они только дёргают
       силуэт и отвлекают от цели. */
    const q = 1 - ak*0.65;
    vm.position.x = bx + (bobX + wpn.swayX*0.8 + wpn.kickX*0.05 + WPN_sprintK*0.06)*q;
    vm.position.y = by + (bobY + wpn.swayY*0.8
                  - wpn.kick*0.18 - player.dip*0.3
                  + breath*0.006*idle - WPN_sprintK*0.06 - WPN_mantleK*0.30 - WPN_slideK*0.10)*q;
    // отпускание толкает лук к себе и вверх: это отдача, а не «дёрнулась модель»
    vm.position.z = bz + (wpn.kick*0.40 + WPN_dashK*0.06 + wpn.looseK*0.055)*q;
    vm.rotation.x = brx + (wpn.kick*0.9 + wpn.swayY*0.9
                  + breath*0.004*idle + WPN_mantleK*0.75 + WPN_sprintK*0.12 - wpn.looseK*0.10)*q;
    vm.rotation.y = bry + (-wpn.swayX*1.1 + wpn.kickX*0.03 - WPN_sprintK*0.38)*q;
    vm.rotation.z = brz + (-wpn.swayX*1.2 + Math.sin(t*3.5)*0.006*idle
                  + wpn.kick*0.18 + WPN_sprintK*0.52 + WPN_slideK*0.35 + wpn.looseK*0.06)*q;
  } else {
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
  }
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
    /* ПОСЛЕД. Узел наложения при отпускании прыгает вперёд вместе с тетивой,
       а кисть по-настоящему уходит НАЗАД, за ухо, — так работает любой чистый
       выпуск. Кисть живёт на этом узле, поэтому послед добавляем ей отдельно:
       +Z у лука смотрит на стрелка. */
    if(WPN_bowHandR) WPN_bowHandR.position.z = WPN_handRZ0 + wpn.looseK*0.105;
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
  WPN_updateBowArc(dt, bow);   // дуга полёта по ПКМ — она в мире, а не в руках

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
