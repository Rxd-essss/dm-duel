/* =====================================================================
   DM_DUEL v3 — ОРУЖИЕ: игрок, боеприпасы, баллистика, отдача.
   Тип патрона здесь решает всё: матчевый — единственный с полным критом,
   фугасный работает площадью и крита не имеет вовсе, зажигательный
   почти не бьёт напрямую, зато оставляет горение и очаги огня.
   ===================================================================== */
const ZOOMS = [22, 13, 7.5];
const player = {
  pos:V(0,0,0), vel:V(0,0,0), yaw:0, pitch:0, h:CFG.height,
  grounded:false, stepUp:0, landV:0, crouching:false, sprinting:false,
  hp:100, alive:true, respawnT:0, stam:1, bobT:0, bob:0, dip:0,
  lastHurt:99, lastStep:0,
  /* v3: горение (ведёт H) и аркадная подвижность (ведёт A).
     Оружие эти поля только объявляет — чтобы литерал был один на всех
     и никто не создавал их на горячем пути. */
  burn:0, burnFx:null,
  dashCd:0, dashT:0, slideT:0, mantleT:0, airJumps:0, coyote:0, jumpBuf:0,
  climb:null, zip:null, noGrav:false
};
const wpn = {
  idx:0, loaded:[5,3,4], res:[45,18,28],
  /* Персональный откат каждого типа. Тикает ВСЕГДА, даже когда выбран
     другой тип: пояс патронов — общий ресурс, а не три независимых ствола. */
  cd:[0,0,0],
  bolt:0, rel:0, relTotal:0, relStage:0, scoped:false, sT:0, zoom:0, charge:0,
  bloom:0, rec:0, yawRec:0,
  kick:0, kickV:0, kickX:0, kickXV:0, boltAnim:0, ejected:true,
  swayX:0, swayY:0, hold:false, breathT:0,
  heat:0, flashT:0, flashS:0.5,
  /* ЛУК. draw — натяг 0..1, drawing — ЛКМ зажата (тянем), drawT — сколько
     секунд держим УЖЕ ПОЛНЫЙ натяг: с него начинается дрожь. Поля объявлены
     в общем литерале и на винтовке всегда лежат нулями: заводить их на
     горячем пути значило бы менять форму объекта посреди боя. */
  draw:0, drawing:false, drawT:0, creakT:0,
  /* ЛУК v4. aim — ПКМ (это НЕ оптика: приближение на WPNS[1].aimZoom плюс
     показ дуги), aimK — та же величина, сглаженная по кадрам. volley —
     режим залпа по СКМ. looseK — импульс отпускания: по нему рука с тетивой
     уходит на послед и лук качается. Всё здесь же, в общем литерале, по той
     же причине, что и натяг. */
  aim:false, aimK:0, volley:false, looseK:0
};
const wind = { x:0, z:0, mag:0, dir:0 };
const game = {
  state:'menu', diff:'normal', kills:0, deaths:0, shots:0, hits:0, heads:0,
  best:0, time:0, sens:1.3, fov:80, shadows:2,
  /* Сторона игрока: 0 = BLU (осадный лагерь), 1 = RED (замок).
     Единый источник правды на весь проект: по нему выбираются точки респавна
     игрока, команда ботов (противоположная) и цвета в интерфейсе. В сети его
     назначает сервер и кладёт сюда же — чтобы читателю не приходилось знать,
     сетевой мы сейчас или нет. */
  team:0,
  /* Выбранный ствол: 0 = винтовка, 1 = лук (см. WPNS в 10_core.js).
     Само переключение делает setWeapon() в startGame — он подменяет
     содержимое AMMO на месте, поэтому здесь хранится только выбор. */
  weapon:0
};
let D = DIFFS.normal;

/* ============================ ЛУК: НАТЯГ ============================

   Чем стреляем ПРЯМО СЕЙЧАС — знает сам боекомплект, а не game.weapon.
   setWeapon() подменяет содержимое AMMO на месте, и все стрелы помечены
   полем arrow; game.weapon — это лишь выбор в брифинге, и между матчами
   он может уже смениться, пока в стволе ещё прежний боеприпас. Поэтому
   единственный источник правды здесь — AMMO.

   Числа натяга собраны в одном месте не ради красоты: они связаны между
   собой. Ниже min натяга выстрела нет вовсе (стрела срывается с пальцев
   под ноги), от min до упора линейно растут скорость и урон, а разброс
   падает квадратично — недотянутый лук должен ощущаться не «чуть хуже»,
   а откровенно негодным. holdFree — сколько полный натяг держится даром;
   дальше руки устают ровно той же выносливостью, что и задержка дыхания
   у винтовки, и swayAmp() разводит марку в стороны. */
const BOW = {
  min: 0.20,        // ниже — срыв: стрела просто падает под ноги
  vMin: 0.45,       // доля от a.v на нулевом натяге (реально не ниже 0.56)
  spreadK: 3.6,     // во сколько раз хуже разброс при нулевом натяге
  holdFree: 1.0,    // секунд полного натяга без усталости
  stamDrain: 0.85,  // выносливость на удержании, единиц в секунду
  zoom: 9.0,        // на сколько градусов сужается поле зрения при полном натяге
  dudV: 0.22        // с какой долей скорости уходит сорвавшаяся стрела
};
function curWeapon(){ return (AMMO[0] && AMMO[0].arrow === true) ? WPNS[1] : WPNS[0]; }
function isBow(){ return curWeapon().bow === true; }

const _t1=new THREE.Vector3(), _t2=new THREE.Vector3(), _t3=new THREE.Vector3(), _t4=new THREE.Vector3();
const _hit=new THREE.Vector3(), _nrm=new THREE.Vector3(), _mz=new THREE.Vector3();
const _fwd=new THREE.Vector3();
/* _t1.._t4 нарасхват у ИИ и эффектов, поэтому геометрию выстрела считаем
   в собственных векторах: так вызов FX/explode посреди расчёта ничего не затрёт. */
const WPN_v1=new THREE.Vector3(), WPN_v2=new THREE.Vector3(), WPN_v3=new THREE.Vector3(), WPN_v4=new THREE.Vector3();

let shakeT = 0, shakeA = 0;
function shake(a){ shakeA = Math.max(shakeA, a); shakeT = 0.32; }
function playerEye(o){ return o.set(player.pos.x, player.pos.y + player.h - CFG.eye, player.pos.z); }
function playerCenter(o){ return o.set(player.pos.x, player.pos.y + player.h*0.55, player.pos.z); }
function panOf(p){ const d=_t3.subVectors(p, camera.position); const r=_t4.set(Math.cos(player.yaw),0,-Math.sin(player.yaw)); const l=d.length()||1; return clamp(d.dot(r)/l,-1,1)*0.85; }
function volOf(p){ const d=p.distanceTo(camera.position); return clamp(1-d/120,0.05,1); }

/* Строка статуса живёт в HUD (модуль F). Оборачиваем, чтобы незакрытый
   откат не ронял кадр, если HUD собран другой версии. */
function WPN_status(key, text, col){ if(typeof setStatus === 'function') setStatus(key, text, col); }
function WPN_statusOff(key){ if(typeof clearStatus === 'function') clearStatus(key); }
/* Единственное место, где собирается строка отката. Округляем ВВЕРХ: тем же
   способом HUD рисует число в слоте пояса и в индикаторе отката, а расхождение
   в одну десятую на одном и том же ожидании читается как баг. */
function WPN_cdTxt(a, cd){ return a.short+' · ОТКАТ '+(Math.ceil(cd*10)/10).toFixed(1); }

/* ------------------------ ОБЩИЙ ЛУЧ ИЗ КАМЕРЫ ------------------------
   Дальномер и подсказка зоны поражения смотрят в одну и ту же точку —
   куда направлен прицел. Каждый такой замер это перебор всех коробок плюс
   марш по рельефу, и делать его дважды за кадр незачем: считаем не чаще
   раза в WPN_RAY_DT и отдаём результат всем желающим.
   Луч всегда бьём на WPN_RAY_FAR, а вызывающему обрезаем до его maxT —
   тогда один кэш обслуживает и запрос на 300 м, и запрос на 400 м. */
const WPN_RAY_DT = 0.06;
const WPN_RAY_FAR = 400;
let WPN_rayT = -1;              // game.time последнего расчёта
let WPN_rayFar = 0;             // на какую дальность считали
let WPN_rayD = 0;               // что насчитали
const WPN_rayDir = new THREE.Vector3();
function camRayDist(maxT){
  const R = (maxT > 0) ? maxT : WPN_RAY_FAR;
  const t = game.time;
  // t < WPN_rayT — это рестарт матча (game.time обнулился): кэш протух
  if(WPN_rayFar >= R && t >= WPN_rayT && t - WPN_rayT < WPN_RAY_DT) return Math.min(WPN_rayD, R);
  const far = Math.max(R, WPN_RAY_FAR);
  camera.getWorldDirection(WPN_rayDir);
  let d = far;
  const rb = rayBoxes(camera.position, WPN_rayDir, far);
  if(rb) d = rb.t;
  const rt = rayTerrain(camera.position, WPN_rayDir, d);
  if(rt) d = rt.t;
  WPN_rayT = t; WPN_rayFar = far; WPN_rayD = d;
  return Math.min(d, R);
}

/* --------------------------- ХАРАКТЕР ОТДАЧИ ---------------------------
   Выстрел должен ощущаться по-разному ещё до того, как пуля куда-то прилетит:
   фугас пинает тяжело и мутно, зажигательный плюётся огнём, матчевый — сухой
   и точный. Все цифры — на кадр выстрела, дальше их растаскивает updateWeapon. */
const WPN_RECOIL = {
  match:{ kick:5.2, kickX:1.5, pitch:1.15, yaw:0.30, shake:0.14, bloom:1.50, heat:0.30,
          flash:0.55, smoke:5, spark:3, ember:0 },
  frag: { kick:7.8, kickX:2.8, pitch:1.90, yaw:0.60, shake:0.30, bloom:2.30, heat:0.40,
          flash:0.86, smoke:10, spark:5, ember:0 },
  fire: { kick:6.1, kickX:1.9, pitch:1.45, yaw:0.42, shake:0.19, bloom:1.85, heat:0.62,
          flash:0.70, smoke:4, spark:2, ember:7 },
  /* Лук не бьёт в плечо — он щёлкает тетивой. Отдача здесь нужна только
     чтобы выстрел читался телом: ствол дёргается вчетверо слабее винтовки,
     дульной вспышки и дыма нет вовсе (flash/smoke/spark нули не случайны). */
  arrow:{ kick:2.1, kickX:0.5, pitch:0.40, yaw:0.10, shake:0.05, bloom:0.55, heat:0,
          flash:0, smoke:0, spark:0, ember:0 },
  bomb: { kick:3.0, kickX:0.8, pitch:0.58, yaw:0.16, shake:0.09, bloom:0.80, heat:0,
          flash:0, smoke:0, spark:0, ember:0 },
  flame:{ kick:2.4, kickX:0.6, pitch:0.46, yaw:0.12, shake:0.07, bloom:0.65, heat:0,
          flash:0, smoke:0, spark:0, ember:5 }
};
/* Цвет остаточного дыма у дула: у зажигательного он тёплый и держится дольше. */
const WPN_SMOKE_COL = { match:0x8d8880, frag:0x615c57, fire:0xa8785c };

/* оружие от первого лица */
let vmRoot, vmRifle, vmFlash, vmHandL;
/* Лук живёт рядом с винтовкой отдельным узлом и просто прячется, когда
   выбран не он: пересобирать модель на каждый матч дороже, чем держать
   в памяти полтора десятка коробок. Узлы натяга лежат в userData —
   87_weapon_update.js двигает их каждый кадр и ничего не знает о сборке. */
let vmBow = null;
/* Руки лучника. Левая живёт на рукояти (узел WPN_bowGrip стоит там, где у
   модели сердечник рукояти), правая — ПРЯМО НА УЗЛЕ НАЛОЖЕНИЯ: тогда кисть
   с тетивой отъезжает к лицу сама, без единой строки анимации, потому что
   этот узел двигает draw(t) внутри модели. WPN_bowFore — предплечье правой,
   его отдельно отводит послед после отпускания. */
let WPN_bowGrip = null, WPN_bowArmL = null, WPN_bowHandR = null, WPN_bowFore = null;
let WPN_handRZ0 = 0;          // домашнее Z правой кисти: от него считается послед
const WPN_vmArrows = [];      // наложенная стрела на каждый вид, по индексу пояса
let WPN_flashCore = null;      // яркое ядро вспышки поверх спрайта
let WPN_vmLight = null;        // подсветка модели в момент выстрела
const WPN_smoke = [];          // дым, ползущий из ствола, пока он горячий
function buildViewmodel(){
  vmRoot = new THREE.Group(); vmScene.add(vmRoot);
  vmRifle = mkRifle(PAL.blu, false);
  /* ПОСАДКА ВИНТОВКИ. Была 0.92 при выносе −0.42 — то есть винтовка длиной
     1.72 м в 42 см от глаза. Приклад при такой посадке уходит ЗА камеру и
     режется ближней плоскостью, а в кадре остаётся торец ложи размером с
     бревно. Уменьшенный масштаб и вынос вперёд ставят в кадр то, что и должно
     быть видно: ствольную коробку, оптику и ствол, уходящий вдаль. */
  vmRifle.scale.setScalar(0.72);
  vmRifle.position.set(0.19,-0.22,-0.30);
  vmRifle.rotation.set(0.02,-0.055,0.02);
  vmRoot.add(vmRifle);
  /* РУКИ ИДУТ ВНИЗ-НАЗАД, а не вверх.
     Предплечья стояли на +0.24 и +0.26 по Y, то есть поднимались ОТ кисти
     ВВЕРХ, и рукав размером 13.5 см оказывался в двадцати сантиметрах от
     глаза посреди кадра. Два таких рукава цвета PAL.blu — это и есть «2
     больших синих куба непонятных кривых» из жалобы заказчика; на модель
     винтовки они не имели никакого отношения, и «чистка» модели, которой их
     пытались лечить, вырезала саму винтовку.
     Настоящая рука приходит к оружию СНИЗУ и из-за нижней кромки кадра. */
  /* Перчатка и рукав приглушены: у сцены вида своя экспозиция (3.4), и на ней
     прежние 0x3f6c8c/PAL.blu выходили светло-голубыми плитами. */
  const glove = toon(0x232c34), skin = toon(0x9a7452), sleeve = toon(0x2a3b48);
  const hR = new THREE.Group(); hR.position.set(0.06,-0.12,0.14); vmRifle.add(hR);
  hR.add(mBox(0.10,0.13,0.12, glove, 0,0,0));
  hR.add(mBox(0.115,0.16,0.115, skin, 0,-0.075,0.075));
  hR.add(mBox(0.135,0.16,0.135, sleeve, 0,-0.185,0.16));
  vmHandL = new THREE.Group(); vmHandL.position.set(-0.02,-0.11,-0.40); vmRifle.add(vmHandL);
  vmHandL.add(mBox(0.11,0.12,0.15, glove, 0,0,0));
  vmHandL.add(mBox(0.115,0.20,0.13, skin, 0.02,-0.080,0.10));
  vmHandL.add(mBox(0.14,0.16,0.15, sleeve, 0.04,-0.200,0.22));

  vmFlash = new THREE.Sprite(new THREE.SpriteMaterial({map:TEX_GLOW, color:0xffd48a, blending:THREE.AdditiveBlending, transparent:true, depthWrite:false, depthTest:false}));
  vmFlash.scale.setScalar(0.5); vmFlash.position.set(0,0.02,-1.06); vmFlash.visible=false;
  vmRifle.add(vmFlash);
  // второе, маленькое и очень яркое ядро: даёт «щелчок» вспышки, а не пятно
  WPN_flashCore = new THREE.Sprite(new THREE.SpriteMaterial({map:TEX_GLOW, color:0xfff6dc, blending:THREE.AdditiveBlending, depthWrite:false, depthTest:false}));
  WPN_flashCore.scale.setScalar(0.2); WPN_flashCore.position.set(0,0.02,-1.02); WPN_flashCore.visible=false;
  vmRifle.add(WPN_flashCore);
  // вспышка подсвечивает саму модель — иначе она «не участвует» в выстреле
  WPN_vmLight = new THREE.PointLight(0xffd48a, 0, 2.6);
  WPN_vmLight.position.set(0.12,-0.16,-1.25);
  vmScene.add(WPN_vmLight);

  /* ЗДЕСЬ БЫЛА «ЧИСТКА МОДЕЛИ В РУКАХ», И ЭТО БЫЛА ГРУБАЯ ОШИБКА.
     Она выкидывала из винтовки меши крупнее 0.6 м с белым материалом — по
     догадке, что «деталь такого размера в руках существовать не может».
     Под это описание попала САМА ВИНТОВКА, целиком.

     Почему догадка была неверной. mkRifle собирает модель через MDL_node,
     который сливает сотню коробок в несколько мешей и переносит цвет в
     ВЕРШИНЫ. У слитого меша материал по построению белый (цвет берётся из
     атрибута color), а габарит — это габарит всей винтовки, 1.17…1.72 м.
     То есть оба признака «брака» были признаками нормальной сборки.

     Что оставалось после чистки: два кружка линз прицела и кисти рук. Ровно
     это заказчик и увидел — «снайперка визуально сломалась и превратилась в
     говно». Проверять надо было глазами по кадру вида, а не по габаритам:
     ни один замер размеров этого не показывает.

     Настоящие «2 больших синих куба» на прицеле — это линзы (см. ниже
     WPN_SCOPE_LENS): в оптике камера подходит к ним вплотную, и кружок
     диаметром 8 см закрывает пол-экрана. Лечится там, где причина. */

  /* линзу прицела вида отвязываем от общего материала: ниже мы крутим
     её прозрачность, и это не должно доставать до винтовок противника */
  if(vmRifle.userData && vmRifle.userData.lens && vmRifle.userData.lens.material)
    vmRifle.userData.lens.material = vmRifle.userData.lens.material.clone();

  // ленивый дым из ствола: три спрайта с разной фазой
  for(let i=0;i<3;i++){
    const s = new THREE.Sprite(new THREE.SpriteMaterial({map:TEX_SMOKE, color:0x8d8880, transparent:true, opacity:0, depthWrite:false}));
    s.scale.setScalar(0.12); s.visible = false; s.userData.t = i/3;
    vmScene.add(s); WPN_smoke.push(s);
  }

  vmBow = WPN_buildBow();
  /* Лук держат ближе к лицу и крупнее винтовки: при прежних 0.92 и посадке
     винтовки он целиком помещался в кадр по центру — ровно то «что-то висящее
     перед персонажем», на которое жаловался заказчик. На 0.80 и с посадкой
     WPN_BOWPOSE плечи уходят за верхнюю и нижнюю кромку кадра, как и должно
     быть у оружия ростом с человека. */
  vmBow.scale.setScalar(0.80);
  vmBow.visible = false;
  vmRoot.add(vmBow);
  WPN_buildBowHands(vmBow, glove, skin, sleeve);

  /* Наложенная стрела висит на точке наложения и уезжает назад вместе с
     тетивой сама — узел двигает draw(t). Делаем по одной на вид и просто
     переключаем видимость: пересобирать модель при смене типа было бы
     единственной аллокацией на горячем пути смены пояса. */
  const nk = vmBow.userData ? vmBow.userData.nock : null;
  if(nk) for(let i=0;i<AMMO.length;i++){
    const g = WPN_arrowMesh(BOW_AMMO[i] || AMMO[i]);
    const L = (g.userData && g.userData.len) || WPN_ARROW_LEN;
    g.position.set(0, 0, -L);      // хвостовик ложится ровно на тетиву
    g.visible = false;
    nk.add(g);
    WPN_vmArrows.push(g);
  }

  WPN_arcBuild();          // пулы дуги полёта — один раз, до первого прицеливания
}

/* ------------------------- РУКИ ЛУЧНИКА -------------------------
   Заказчик написал, что лук «выглядит как что-то висящее перед персонажем».
   Причина ровно одна: у винтовки руки были (кисть на цевье и кисть на
   рукояти), а у лука не было ни одной, и держать его было буквально нечем.

   Поза здесь честная, а не декоративная:
     · ЛЕВАЯ кисть сидит на рукояти — узел стоит там же, где у модели
       сердечник рукояти (spec.px / spec.rz), поэтому лук и кисть не могут
       разъехаться ни при каком натяге и ни при каком наклоне;
     · ПРАВАЯ кисть висит на УЗЛЕ НАЛОЖЕНИЯ. Этот узел двигает сама модель
       (userData.draw), значит рука с тетивой уезжает к лицу вместе с ней —
       ни одной строки анимации на это не тратится и рассинхрону взяться
       неоткуда;
     · предплечья — отдельные повёрнутые узлы, уходящие к своим плечам:
       левое вниз-влево-назад, правое назад-вправо с ПОДНЯТЫМ локтем, как
       и тянут настоящий лук.

   Материалы приходят снаружи те же, что у рук на винтовке: две «семьи»
   перчатки-кожи-рукава на один вид от первого лица — это лишние draw call
   ради двух моделей, которые никогда не видны одновременно. */
function WPN_buildBowHands(bow, glove, skin, sleeve){
  const u = bow.userData || {};
  const sp = u.spec || null;
  const nk = u.nock || null;
  const ax = (typeof u.axis === 'number') ? u.axis : 0.02;   // ось стрелы по Y
  /* Рукоять у лука правши стоит ПРАВЕЕ оси стрелы (стрела идёт слева от
     окна) — это spec.px. У заглушки без spec колонна на оси, и тогда кисть
     садится туда же: числа берём у модели, а не из головы. */
  const gx = sp ? sp.px : 0;
  const gz = (sp ? sp.rz : -1.005) + 0.012;
  const leather = toon(PAL.leather);

  /* --- левая: кисть на рукояти --- */
  WPN_bowGrip = new THREE.Group();
  WPN_bowGrip.position.set(gx, ax - 0.105, gz);
  bow.add(WPN_bowGrip);
  WPN_bowGrip.add(mBox(0.088,0.140,0.118, glove,  0,     0,     0.004));  // кулак вокруг рукояти
  WPN_bowGrip.add(mBox(0.096,0.040,0.058, glove,  0,     0.058,-0.032));  // костяшки поверх спинки
  WPN_bowGrip.add(mBox(0.036,0.032,0.090, skin,  -0.042, 0.042, 0.020));  // большой палец вдоль окна
  WPN_bowGrip.add(mBox(0.080,0.088,0.104, skin,   0.008,-0.088, 0.040));  // запястье
  WPN_bowArmL = new THREE.Group();
  WPN_bowArmL.position.set(0.012,-0.104, 0.052);
  // вниз, влево и назад — к своему плечу; +Z у узла смотрит на стрелка
  WPN_bowArmL.rotation.set(0.60,-0.42, 0.10);
  WPN_bowGrip.add(WPN_bowArmL);
  WPN_bowArmL.add(mBox(0.112,0.112,0.100, leather, 0,0, 0.062));          // наруч
  WPN_bowArmL.add(mBox(0.104,0.104,0.190, skin,    0,0, 0.190));
  WPN_bowArmL.add(mBox(0.126,0.126,0.230, sleeve,  0,0, 0.380));

  /* --- правая: кисть на тетиве --- */
  if(!nk) return;
  WPN_bowHandR = new THREE.Group();
  WPN_bowHandR.position.set(0, 0, 0);
  WPN_handRZ0 = 0;
  nk.add(WPN_bowHandR);
  /* Пальцы держим НА ОСИ ТЕТИВЫ (x = 0) — иначе кисть отъедет от струны и
     весь смысл пропадёт. А вот масса кисти, запястье и предплечье уходят
     ВПРАВО: на полном натяге рука приходит к правой скуле, и если оставить
     её на оси, она встаёт ровно перед носом и закрывает цель. */
  WPN_bowHandR.add(mBox(0.048,0.082,0.044, glove,  0,    -0.014, 0.014));
  WPN_bowHandR.add(mBox(0.092,0.124,0.108, glove,  0.030,-0.034, 0.074));  // кулак
  WPN_bowHandR.add(mBox(0.036,0.044,0.078, skin,   0.064,-0.024, 0.064));  // большой палец
  WPN_bowHandR.add(mBox(0.084,0.096,0.098, skin,   0.056,-0.056, 0.140));  // запястье
  WPN_bowFore = new THREE.Group();
  WPN_bowFore.position.set(0.058,-0.058, 0.146);
  /* Локоть ПОДНЯТ: наклон вниз всего 0.16 рад, зато разворот вправо большой —
     так предплечье уходит вдоль линии плеч, а не свисает под тетивой. */
  WPN_bowFore.rotation.set(0.16, 0.62, 0);
  WPN_bowHandR.add(WPN_bowFore);
  WPN_bowFore.add(mBox(0.108,0.108,0.190, skin,   0,0, 0.100));
  WPN_bowFore.add(mBox(0.130,0.130,0.240, sleeve, 0,0, 0.300));
}

/* Лук от первого лица. Модель отдаёт 50_models.js: у неё те же локальные
   оси, что у винтовки (ствол/стрела уходят в -Z), и вся тригонометрия
   натяга спрятана в userData.draw(t). Если модуля моделей в сборке нет —
   собираем заглушку с тем же контрактом, чтобы механика осталась играбельной
   и её можно было проверить в одиночку. */
function WPN_buildBow(){
  if(typeof mkBow === 'function'){
    try{
      const g = mkBow(PAL.blu, false);
      if(g && g.isObject3D && g.userData && typeof g.userData.draw === 'function') return g;
    }catch(err){}
  }
  const G = new THREE.Group();
  const wood = toon(PAL.wood), horn = toon(PAL.leather), strM = basic(0xd9d3c1);
  const limbU = new THREE.Group(); limbU.position.set(0, 0.185,-1.0); G.add(limbU);
  limbU.add(mBox(0.040,0.44,0.05, wood, 0, 0.22, 0.10));
  const limbD = new THREE.Group(); limbD.position.set(0,-0.185,-1.0); G.add(limbD);
  limbD.add(mBox(0.040,0.44,0.05, wood, 0,-0.22, 0.10));
  G.add(mBox(0.052,0.44,0.086, horn, 0, 0.02,-1.005));
  const string = new THREE.Group(); G.add(string);
  const sU = new THREE.Group(); sU.add(mBox(0.008,1,0.008, strM, 0,-0.5,0)); string.add(sU);
  const sD = new THREE.Group(); sD.add(mBox(0.008,1,0.008, strM, 0,-0.5,0)); string.add(sD);
  const nock = new THREE.Object3D(); nock.position.set(0,0.02,-0.80); G.add(nock);
  const muzzle = new THREE.Object3D(); muzzle.position.set(0,0.02,-1.02); G.add(muzzle);
  function draw(t){
    t = clamp(t,0,1);
    const a = 0.16*t*t;
    limbU.rotation.x = a; limbD.rotation.x = -a;
    const ty = 0.02+0.185+0.435*Math.cos(a), tz = -1.0+0.435*Math.sin(a)+0.20;
    const nz = -0.80 + 0.34*t;
    nock.position.z = nz;
    const dy = 0.02-ty, dz = nz-tz, l = Math.hypot(dy,dz);
    sU.position.set(0,ty,tz);      sU.rotation.x = Math.atan2(-dz,-dy); sU.scale.y = l;
    sD.position.set(0,0.04-ty,tz); sD.rotation.x = Math.atan2(-dz, dy); sD.scale.y = l;
    return t;
  }
  draw(0);
  G.userData = { string, stringU:sU, stringD:sD, nock, muzzle, limbU, limbD, draw,
                 pull:0.34, brace:-0.80, axis:0.02, arrowLen:WPN_ARROW_LEN };
  return G;
}

function A(){ return AMMO[wpn.idx]; }

/* --------------------- РАЗБРОС ЛУКА: ОБЕЩАНИЕ НУЛЯ ---------------------
   Заказчик просил «100% точности при выстрелах», и это не оговорка про
   «поменьше разброса»: с натяга WPNS[1].drawTrue разброс обязан быть РОВНО
   нулём, чтобы стрела уходила в марку, а не рядом с ней. Поэтому у лука
   своя формула, а не поправка к винтовочной.

   Слагаемых ровно два и они РАЗНОЙ природы.

   1. Недотяг. Раньше он был множителем к постоянному a.spread — то есть
      «налог», который не снимался никогда. Теперь это отдельный член,
      привязанный к drawTrue: u = (drawTrue − draw)/drawTrue, и при u = 0 он
      честно равен нулю. Рост сохранён прежний: на нулевом натяге получается
      те же a.spread·(1+spreadK) градусов, что и в старой формуле.

   2. Стойка. Бег, прыжок, подкат и уступ разброс дают — лук в этом ничем не
      отличается от винтовки, и убирать это значило бы разрешить стрельбу в
      прыжке без промаха. Но СТОЯ этот член равен нулю сам собой, и тогда при
      полном натяге сумма обнуляется целиком — обещание выполнено.

   Чего здесь нет намеренно: wpn.bloom и wpn.heat. Разброс от прошлого
   выстрела затухает экспонентой и не достигает нуля никогда, а между двумя
   выстрелами из лука проходит наложение стрелы плюс полный натяг — почти
   полторы секунды. Держать хвост в одну сотую градуса только ради формулы
   значило бы соврать в главном обещании оружия. */
function WPN_bowSpreadDeg(a){
  const W = WPNS[1];
  const dTrue = clamp(W.drawTrue > 0 ? W.drawTrue : 1, 0.05, 1);
  /* В покое показываем разброс ПОЛНОГО натяга: марка — это обещание «куда
     уйдёт стрела, если дотянуть», и она сходится по мере натяга. */
  const d = (wpn.drawing || wpn.draw > 0) ? wpn.draw : 1;
  const u = clamp((dTrue - d)/dTrue, 0, 1);
  // u·(1+K·u): у самого упора почти линейно (тонкая доводка), внизу квадратично
  let s = (u > 0) ? a.spread * u * (1 + BOW.spreadK*u) : 0;

  let env = 0;
  const sp = Math.hypot(player.vel.x, player.vel.z);
  if(sp > 0.15) env += Math.min(1.7, sp*0.17);
  if(!player.grounded) env += 2.0;
  if(player.slideT > 0) env += 1.2;      // из подката прицельно не постреляешь
  if(player.mantleT > 0) env += 2.5;     // на уступе руки заняты
  if(player.crouching) env *= 0.5;
  return s + env;
}

function currentSpreadDeg(){
  const a = A();
  // у лука точность живёт в натяге, а не в стойке — формула своя
  if(a.arrow === true) return WPN_bowSpreadDeg(a);
  const sp = Math.hypot(player.vel.x, player.vel.z);
  let s = a.spread * (1-wpn.sT);
  s += Math.min(1.7, sp*0.17) * (0.30 + 0.70*(1-wpn.sT));
  if(player.crouching) s *= 0.5;
  if(!player.grounded) s += 2.0;
  if(player.slideT > 0) s += 1.2;      // из подката прицельно не постреляешь
  if(player.mantleT > 0) s += 2.5;     // на уступе руки заняты
  s += wpn.bloom + wpn.heat*0.12;      // разогретый ствол «дышит»
  return Math.max(0, s);
}
function swayAmp(){
  /* Лук ведёт марку сам, без оптики: чем дольше держишь полный натяг, тем
     сильнее ходят руки. Считаем по той же выносливости, что тратит задержка
     дыхания, — усталость в игре одна на все стволы. */
  if(A().arrow === true){
    if(wpn.draw <= 0.01) return 0;
    const tired = 1 - player.stam;
    const held = clamp((wpn.drawT - BOW.holdFree)/2.0, 0, 1);
    let a = (0.12 + tired*0.38 + held*0.50) * wpn.draw;
    /* ПКМ у лука — не оптика, а стойка: локоть встаёт на место, дыхание
       ложится под выстрел. Марку уводит ровно во столько раз меньше, сколько
       обещает WPNS[1].aimSteady, и ровно настолько, насколько прицеливание
       уже вошло (aimK) — иначе марка дёргалась бы на самом нажатии. */
    if(wpn.aimK > 0) a *= lerp(1, WPNS[1].aimSteady, clamp(wpn.aimK, 0, 1));
    return a;
  }
  if(wpn.sT < 0.5) return 0;
  const tired = 1 - player.stam;
  let a = 0.10 + tired*0.42;
  if(wpn.hold && player.stam > 0.02) a *= 0.10;   // задержка дыхания на Shift
  else if(player.stam <= 0.02) a *= 1.35;         // выдохся — марка гуляет
  return a * (0.55 + 0.45*(ZOOMS[wpn.zoom]/22));
}

/* ------------------------------ ВЫСТРЕЛ ------------------------------ */
let WPN_blockT = 0;        // антиспам «щелчка» при попытке стрелять на откате
/* Что уже нарисовано в строке статуса залпа. Значения: −1 «строки нет»,
   любое неотрицательное — номер тика подновления, −2 «перерисовать».
   Отдельное значение для «перерисовать» нужно именно потому, что −1 занято
   выключенным режимом: если пометить обновление тем же −1, то выключение
   залпа совпадёт с уже нарисованным состоянием и строка останется висеть.
   Объявлено здесь: пишут и отсюда (toggleVolley), и из покадрового модуля. */
let WPN_volShown = -2;
/* Гильзу заряжает только настоящий выстрел. Флаг внутренний и ставится
   ровно здесь: снаружи иногда обнуляют wpn.ejected на старте матча, и одного
   этого поля мало, чтобы отличить «есть что выбрасывать» от чужого сброса. */
let WPN_ejectArm = false;

function WPN_muzzleWorld(out){
  // точка дула в мире: вид от первого лица живёт в своей сцене, поэтому
  // свет и дым ставим от камеры вдоль ствола
  camera.getWorldDirection(WPN_v2);
  WPN_v3.set(0,1,0);
  WPN_v4.crossVectors(WPN_v2, WPN_v3).normalize();
  WPN_v3.crossVectors(WPN_v4, WPN_v2).normalize();
  /* Насколько оружие уведено от оси взгляда. У винтовки это уход в оптику,
     у лука — натяг: и там, и там оружие идёт к лицу и точка схода сходится
     к центру экрана. Иначе угли огненной стрелы сыпались бы сбоку от неё. */
  const off = 1 - (A().arrow === true ? wpn.draw : wpn.sT);
  return out.copy(camera.position)
            .addScaledVector(WPN_v2, 1.05)
            .addScaledVector(WPN_v4, 0.15*off)
            .addScaledVector(WPN_v3, -0.10*off);
}

function WPN_shotFx(a, chg){
  const R = WPN_RECOIL[a.id] || WPN_RECOIL.match;

  // отдача: ствол вверх-назад, камера уходит и потом сама сводится обратно
  wpn.kickV += R.kick*(1 + chg*0.35);
  wpn.kickXV += rnd(-R.kickX, R.kickX);
  wpn.bloom += R.bloom;
  wpn.rec += R.pitch*Math.PI/180 * (1 + chg*0.55) * (wpn.sT>0.5 ? 0.55 : 1);
  const yk = rnd(-R.yaw, R.yaw)*Math.PI/180 * (wpn.sT>0.5 ? 0.6 : 1);
  player.yaw += yk; wpn.yawRec += yk;      // увод; сведение — в updateWeapon
  shake(R.shake + chg*0.10);
  wpn.heat = Math.min(1.7, wpn.heat + R.heat);

  // дульная вспышка: спрайт в виде оружия + импульс света в мире
  wpn.flashT = 0.06;
  wpn.flashS = R.flash*rnd(0.85,1.20);
  if(vmFlash){
    vmFlash.visible = true;
    vmFlash.material.color.setHex(a.col);
    vmFlash.material.rotation = rnd(0, 6.283);
    vmFlash.scale.setScalar(wpn.flashS);
  }
  if(WPN_flashCore){
    WPN_flashCore.visible = true;
    WPN_flashCore.scale.setScalar(wpn.flashS*0.42);
  }
  if(WPN_vmLight){ WPN_vmLight.color.setHex(a.col); WPN_vmLight.intensity = 7; }
  for(const s of WPN_smoke) s.material.color.setHex(WPN_SMOKE_COL[a.id] || 0x8d8880);

  const mz = WPN_muzzleWorld(WPN_v1);
  camera.getWorldDirection(WPN_v2);
  if(typeof LIGHTS !== 'undefined' && LIGHTS.flash) LIGHTS.flash(mz, a.col, 6, 14, 0.06);

  // дым и искры — свои для каждого типа
  FX.burst(mz, R.smoke, {mat:PMAT.smoke, speed:2.6, life:a.id==='frag'?0.95:0.55,
                         size:a.id==='frag'?0.16:0.10, s1:a.id==='frag'?0.5:0.22,
                         g:-0.9, dir:WPN_v2, push:3.2});
  if(R.spark) FX.burst(mz, R.spark, {mat:PMAT.spark, speed:6, life:0.22, size:0.05, s1:0.01, g:6, dir:WPN_v2, push:5});
  if(R.ember){
    // зажигательный сыплет углями прямо с дула
    if(FX.magic) FX.magic(mz, R.ember, PAL.ember);
    else FX.burst(mz, R.ember, {mat:PMAT.fire, speed:3.5, life:0.5, size:0.07, s1:0.01, g:-1.5});
  }
  if(a.id==='frag' && FX.ring) FX.ring(mz, 1.0, 0xffb072);   // ударная волна из ствола

  SFX.shot(a.id, 0, 1);
  SFX.noise({dur:0.05, f:1700, q:4, g:0.09, delay:0.03});     // лязг механики поверх выстрела
}

/* Конус разброса вокруг направления. Вынесен из tryFire() только затем,
   чтобы лук и винтовка расходились в цифрах, а не в математике: порядок
   обращений к генератору здесь ровно прежний. */
function WPN_spreadDir(dir, sd){
  if(!(sd > 0)) return dir;
  const ang = rnd(0,Math.PI*2), rad = Math.sqrt(Math.random())*sd;
  const up = _t1.set(0,1,0), rt = _t2.crossVectors(dir, up).normalize();
  const u2 = _t3.crossVectors(rt, dir).normalize();
  return dir.addScaledVector(rt, Math.tan(rad)*Math.cos(ang))
            .addScaledVector(u2, Math.tan(rad)*Math.sin(ang)).normalize();
}

/* -------------------------- ВЫСТРЕЛ ИЗ ЛУКА --------------------------
   Отдача у лука не «выстрел», а щелчок тетивы: ни вспышки, ни дыма, ни
   гильзы. Огненная стрела — исключение: угли с наконечника видно, и они
   на секунду подсвечивают руки. */
function WPN_bowFx(a, d, dud, n){
  const R = WPN_RECOIL[a.id] || WPN_RECOIL.arrow;
  // залп бьёт по руке ощутимо тяжелее одиночного — но не втрое: тетива одна
  const vk = 1 + (Math.max(1, n|0) - 1)*0.22;
  const k = (dud ? 0.25 : (0.45 + 0.55*d)) * vk;
  wpn.kickV += R.kick*k;
  wpn.kickXV += rnd(-R.kickX, R.kickX)*k;
  wpn.bloom += R.bloom*k;
  wpn.rec += R.pitch*Math.PI/180*k;
  const yk = rnd(-R.yaw, R.yaw)*Math.PI/180*k;
  player.yaw += yk; wpn.yawRec += yk;      // увод; сведение — в updateWeapon
  shake(R.shake*k);

  // тетива бьёт по наручу, оперение шелестит о полку
  SFX.tone({f: dud?140:250, f2:64, dur:0.17, type:'triangle', g:0.26*k});
  SFX.noise({dur:0.10, f:1750, f2:520, q:1.2, g:0.20*k});
  SFX.noise({dur:0.34, f:820, f2:280, q:0.8, g:0.07*k, delay:0.03});
  if(!dud) SFX.tone({f:560, f2:190, dur:0.22, type:'sine', g:0.07*k, delay:0.02});

  if(!dud && R.ember){
    const mz = WPN_muzzleWorld(WPN_v1);
    if(FX.magic) FX.magic(mz, R.ember, PAL.ember);
    else FX.burst(mz, R.ember, {mat:PMAT.fire, speed:3.0, life:0.45, size:0.06, s1:0.01, g:-1.4});
    if(typeof LIGHTS !== 'undefined' && LIGHTS.flash) LIGHTS.flash(mz, a.col, 3, 8, 0.10);
  }
  // залп слышно отдельно: три оперения сходят с полки почти одновременно
  if((n|0) > 1) SFX.noise({dur:0.16, f:1150, f2:420, q:1.0, g:0.13, delay:0.02});
}

/* Отклонить направление на ang радиан В ГОРИЗОНТАЛИ ЭКРАНА. Веер строим
   через готовый вектор «вправо», а не поворотом вокруг мировой вертикали:
   вокруг Y угол между стрелами схлопывался бы как cos(наклона), и залп с
   яруса вниз ложился бы в одну точку — ровно там, где он и нужен веером. */
function WPN_fanDir(dir, ang, rt){
  return dir.multiplyScalar(Math.cos(ang)).addScaledVector(rt, Math.sin(ang)).normalize();
}

/* Спустить тетиву. Отдельная функция, потому что путей сюда три: отпускание
   ЛКМ (обычная игра), прямой вызов tryFire() (тесты и скрипты) и смерть с
   зажатой кнопкой — а списание стрелы, откат и заявка в сеть должны быть
   ровно одни и те же. */
function WPN_loose(){
  const a = A();
  if(wpn.rel>0 || wpn.bolt>0) return;          // стрела ещё не на тетиве
  if(wpn.cd[wpn.idx] > 0) return;
  if(wpn.loaded[wpn.idx] <= 0){ SFX.dry(); startReload(); return; }

  const W = WPNS[1];
  const vol = volleyActive() ? W.volley : null;
  /* Залп тратит СТОЛЬКО ЖЕ стрел, сколько пускает. Если в колчане осталось
     меньше — уходит столько, сколько есть: отменять выстрел на последней
     стреле значило бы наказывать за режим, а не за просчёт игрока. */
  const n = vol ? Math.max(1, Math.min(vol.n|0, wpn.loaded[wpn.idx])) : 1;

  const d = clamp(wpn.draw, 0, 1);
  /* СРЫВ. Ниже порога тетива уходит из пальцев сама: стрела теряется, но
     ни взрыва, ни поджога не будет — это промах игрока, а не мина под ноги.
     Стрелу всё равно списываем и откат ставим: правило одно на все выстрелы,
     иначе «щёлкать вхолостую» стало бы выгоднее, чем целиться. */
  const dud = d < BOW.min;

  wpn.loaded[wpn.idx] -= n;
  game.shots += n;
  const dmg = dud ? a.dmgMin*0.15 : lerp(a.dmgMin, a.dmgMax, d);
  // натяг решает скорость: недотянутая стрела и летит медленнее, и падает раньше
  const vMul = dud ? BOW.dudV : lerp(BOW.vMin, 1, d);

  /* ЦЕНТРАЛЬНОЕ направление — ровно то, куда смотрит марка. Веер отсчитываем
     от него в обе стороны, поэтому центральная стрела залпа идёт В МАРКУ:
     веер — это свойство залпа, а не промах. */
  camera.getWorldDirection(WPN_v2);
  if(dud){ WPN_v2.y -= 1.25; WPN_v2.normalize(); }   // уходит под ноги
  WPN_v4.set(0,1,0);
  WPN_v3.crossVectors(WPN_v2, WPN_v4);
  if(WPN_v3.lengthSq() < 1e-8) WPN_v3.set(1,0,0);    // взгляд строго в зенит
  WPN_v3.normalize();

  /* Заявка в сеть — ОДНА и по центральному лучу. Сервер держит минимальный
     интервал между выстрелами одного типа (SRV_minInterval) и отклонил бы
     вторую и третью заявки залпа как «темп», а вместе с ними и попадания.
     Допуск «мимо луча» у него растёт с дистанцией (3.5 м + 0.06/м), а крайняя
     стрела веера уходит от центра всего на tan(1.7°) ≈ 0.03 м на метр —
     то есть все три попадания честно ложатся на этот один выстрел. */
  if(NET_ACTIVE) NET.reportShot(wpn.idx, camera.position, WPN_v2, d);

  const sd = currentSpreadDeg()*Math.PI/180;
  const fan = vol ? vol.fan*Math.PI/180 : 0;
  for(let i=0;i<n;i++){
    _fwd.copy(WPN_v2);
    if(fan !== 0){
      const k = i - (n-1)*0.5;
      if(k !== 0) WPN_fanDir(_fwd, k*fan, WPN_v3);
    }
    WPN_spreadDir(_fwd, sd);
    const b = spawnBullet(camera.position, _fwd, a, dmg, 'player', d);
    b.vel.multiplyScalar(vMul);
    b.dud = dud;
  }

  /* Откат площадных типов залп умножает: тремя взрывными иначе закрывался бы
     весь ярус разом. У обычной стрелы cd = 0, и множить там нечего. */
  wpn.cd[wpn.idx] = (vol && a.cd > 0) ? a.cd*vol.cdMul : a.cd;
  wpn.charge = 0;
  wpn.bolt = a.bolt;                        // время наложить следующую стрелу
  wpn.boltAnim = 0;
  wpn.ejected = true; WPN_ejectArm = false; // у лука гильз не бывает
  wpn.looseK = 1;                           // послед: рука с тетивой уходит за ухо
  WPN_bowFx(a, d, dud, n);
  if(wpn.cd[wpn.idx] > 0) WPN_status('cd', WPN_cdTxt(a, wpn.cd[wpn.idx]), '#e08a4a');
}

/* ---------------------------- ВВОД ОГНЯ ----------------------------
   Ввод живёт в 90_game.js, а знание «как оружие реагирует на кнопку» —
   здесь. Наружу торчат ровно две функции: fireDown() на mousedown и
   fireUp() на mouseup (а заодно на blur и потерю захвата мыши).
   У винтовки fireDown() — это прежний tryFire(), а fireUp() пустой. */
function fireDown(){
  if(game.state!=='play' || !player.alive){ wpn.drawing = false; return; }
  if(!isBow()){ tryFire(); return; }
  const a = A();
  if(wpn.cd[wpn.idx] > 0){                  // тип на откате — тянуть нечего
    if(WPN_blockT <= 0){ SFX.blocked(); WPN_blockT = 0.22; }
    WPN_status('cd', WPN_cdTxt(a, wpn.cd[wpn.idx]), '#e08a4a');
    return;
  }
  if(wpn.loaded[wpn.idx] <= 0){ SFX.dry(); startReload(); return; }
  /* Тянуть разрешаем и пока стрела ложится на тетиву: игрок держит кнопку,
     натяг начнётся сам, как только оружие будет готово. Иначе нажатие в
     конце наложения пропадало бы, и это читалось бы как потерянный клик. */
  wpn.drawing = true;
}
function fireUp(){
  if(!wpn.drawing) return;
  wpn.drawing = false;
  if(isBow() && game.state==='play' && player.alive) WPN_loose();
  wpn.draw = 0; wpn.drawT = 0;
}
/* ПКМ. У винтовки это оптика и ничего в ней не меняется — она принята.
   У лука оптики нет и быть не может, но прицеливание есть: приближение на
   WPNS[1].aimZoom, спокойная марка (aimSteady, см. swayAmp) и показ дуги
   полёта стрелы (WPN_updateBowArc).

   wpn.scoped при этом обязан ОСТАТЬСЯ ложным: на него завязаны туман
   рельефа (25_terrain), флаг «в оптике» в сети (92_net) и оценка заметности
   у ИИ (70_ai) — лук ни к чему из этого отношения не имеет. Поэтому у лука
   свой флаг wpn.aim, и он живёт отдельно.

   Ввод шлёт только mousedown правой кнопки, поэтому это переключатель, а не
   удержание: «пока держим ПКМ» для игрока читается так же, а обработчик
   ввода в 90_game.js трогать не пришлось. */
function toggleScope(){
  if(game.state!=='play') return;
  if(isBow()){
    wpn.scoped = false;
    wpn.aim = !wpn.aim;
    // не «щелчок оптики»: короткий выдох, чтобы не искали несуществующий прицел
    SFX.noise({dur:0.07, f: wpn.aim?1500:900, f2: wpn.aim?900:1500, q:2.2, g:0.07});
    return;
  }
  wpn.aim = false;
  wpn.scoped = !wpn.scoped;
  SFX[wpn.scoped ? 'scopeIn' : 'scopeOut']();
}

/* ------------------------- СКМ: РЕЖИМ ЗАЛПА -------------------------
   Публичная: её уже зовёт ввод в 90_game.js. Переключает режим, в котором
   одно отпускание тетивы пускает WPNS[1].volley.n стрел веером.

   ПРИЗНАК ДЛЯ HUD (модуль F): булево `wpn.volley` — «режим включён» и
   функция `volleyActive()` — «включён И в руках лук» (на винтовке залпов
   не бывает, и показывать там нечего). Количество стрел в залпе брать из
   WPNS[1].volley.n, а не из константы у себя. */
function toggleVolley(){
  if(game.state!=='play') return;
  if(!isBow()){ wpn.volley = false; return; }   // винтовка залпов не знает
  wpn.volley = !wpn.volley;
  if(wpn.volley){
    SFX.tone({f:520, f2:900, dur:0.10, type:'square', g:0.09});
    SFX.noise({dur:0.09, f:1400, q:3, g:0.07, delay:0.05});
  } else {
    SFX.tone({f:900, f2:520, dur:0.09, type:'square', g:0.08});
  }
  WPN_volShown = -2;                            // строка статуса перерисуется сразу
  if(typeof updateAmmoHUD === 'function') updateAmmoHUD();
  if(typeof updateReticle === 'function') updateReticle();
}
/* Режим считается работающим только когда в руках лук: смена оружия обязана
   его снимать, но проверка «а что сейчас в руках» всё равно нужна отдельно —
   между setWeapon() и первым кадром updateWeapon состояние ещё старое. */
function volleyActive(){ return wpn.volley === true && isBow(); }

function tryFire(){
  if(game.state!=='play' || !player.alive) return;
  /* Лук стреляет отпусканием, а не нажатием. Сюда он попадает только прямым
     вызовом (тесты, отладка, чужой код) — пускаем стрелу с тем натягом,
     который есть на этот момент, вплоть до срыва. */
  if(isBow()){ WPN_loose(); wpn.drawing = false; wpn.draw = 0; wpn.drawT = 0; return; }
  const a = A();
  /* Откат типа — главный ограничитель темпа: он проверяется раньше всего,
     чтобы игрок всегда понимал, что мешает именно выбранный боеприпас. */
  if(wpn.cd[wpn.idx] > 0){
    if(WPN_blockT <= 0){ SFX.blocked(); WPN_blockT = 0.22; }
    WPN_status('cd', WPN_cdTxt(a, wpn.cd[wpn.idx]), '#e08a4a');
    wpn.kickV += 0.6;                     // сухой щелчок в модели, без вспышки
    return;
  }
  if(wpn.rel>0 || wpn.bolt>0) return;
  if(wpn.loaded[wpn.idx] <= 0){ SFX.dry(); startReload(); return; }

  wpn.loaded[wpn.idx]--;
  game.shots++;
  const chg = wpn.sT>0.6 ? wpn.charge : 0;
  const dmg = lerp(a.dmgMin, a.dmgMax, chg);

  camera.getWorldDirection(_fwd);
  WPN_spreadDir(_fwd, currentSpreadDeg()*Math.PI/180);
  spawnBullet(camera.position, _fwd, a, dmg, 'player', chg);
  // остальным нужен наш выстрел для трассера и звука — попадание считаем мы сами
  if(NET_ACTIVE) NET.reportShot(wpn.idx, camera.position, _fwd, chg);

  wpn.cd[wpn.idx] = a.cd;                 // персональный откат типа пошёл
  wpn.charge = 0;
  wpn.bolt = a.bolt;
  wpn.boltAnim = 0; wpn.ejected = false; WPN_ejectArm = true;
  WPN_shotFx(a, chg);
  if(a.cd > 0) WPN_status('cd', WPN_cdTxt(a, a.cd), '#e08a4a');
}
function startReload(){
  const a = A();
  if(wpn.rel>0 || wpn.loaded[wpn.idx] >= a.mag || wpn.res[wpn.idx] <= 0) return;
  wpn.rel = wpn.relTotal = a.reload;
  wpn.relStage = 0;
  wpn.charge = 0;
  // тетиву при этом отпускают: держать натяг, набивая колчан, невозможно
  wpn.draw = 0; wpn.drawT = 0;
  if(a.arrow === true) SFX.noise({dur:0.11, f:700, f2:380, q:1.4, g:0.15});
  else SFX.reloadS();
}
function finishReload(){
  const a = A();
  const need = a.mag - wpn.loaded[wpn.idx];
  const take = Math.min(need, wpn.res[wpn.idx]);
  wpn.loaded[wpn.idx] += take; wpn.res[wpn.idx] -= take;
  wpn.relStage = 0;
}
function switchAmmo(i){
  if(i===wpn.idx || wpn.rel>0) return;
  wpn.idx = i; wpn.charge = 0; wpn.bolt = Math.max(wpn.bolt, 0.45);
  wpn.boltAnim = 0; wpn.ejected = true; WPN_ejectArm = false;   // смена пояса — не выстрел, гильзе взяться неоткуда
  // натяг снимается: другую стрелу на уже натянутую тетиву не положишь
  wpn.draw = 0; wpn.drawT = 0;
  if(AMMO[i] && AMMO[i].arrow === true) SFX.noise({dur:0.07, f:1500, q:3, g:0.11});
  else SFX.bolt();
  // сразу показать, готов ли новый тип: пояс общий, откаты у типов свои
  const a = AMMO[i];
  if(wpn.cd[i] > 0) WPN_status('cd', WPN_cdTxt(a, wpn.cd[i]), '#e08a4a');
  else WPN_statusOff('cd');
  updateAmmoHUD(); updateReticle();
}

/* ------------------------------ ГИЛЬЗЫ ------------------------------
   Гильза вылетает не в момент выстрела, а когда игрок передёргивает
   затвор — это болтовка. Живёт в сцене вида, физика — тоже в ней. */
const WPN_SHELL_GEO = new THREE.CylinderGeometry(0.011,0.013,0.052,6);
const WPN_SHELL_COL = { match:0xd8b464, frag:0x9aa2a6, fire:0xc07a44 };
const WPN_shells = [];
function WPN_shellMat(a){ return toon(WPN_SHELL_COL[a.id] || 0xd8b464); }
function WPN_ejectShell(a){
  if(!vmRifle) return;
  let s = null;
  for(let i=0;i<WPN_shells.length;i++) if(WPN_shells[i].life<=0){ s = WPN_shells[i]; break; }
  if(!s){
    if(WPN_shells.length >= 8) return;
    s = { m:new THREE.Mesh(WPN_SHELL_GEO, WPN_shellMat(a)), v:new THREE.Vector3(), w:new THREE.Vector3(), life:0, tink:false };
    s.m.castShadow = false; s.m.frustumCulled = false;
    vmScene.add(s.m);
    WPN_shells.push(s);
  }
  s.m.material = WPN_shellMat(a);
  s.m.visible = true;
  // окно выброса — справа от ствольной коробки
  vmRifle.localToWorld(WPN_v1.set(0.08, 0.04, 0.02));
  s.m.position.copy(WPN_v1);
  s.m.rotation.set(rnd(0,3), rnd(0,3), rnd(0,3));
  s.v.set(rnd(1.1,2.0), rnd(0.9,1.7), rnd(0.1,0.8));
  s.w.set(rnd(-14,14), rnd(-14,14), rnd(-14,14));
  s.life = 1.15; s.tink = false;
  s.m.scale.setScalar(1);
  SFX.noise({dur:0.04, f:3400, q:6, g:0.05});
}
function WPN_updateShells(dt){
  for(let i=0;i<WPN_shells.length;i++){
    const s = WPN_shells[i];
    if(s.life<=0) continue;
    s.life -= dt;
    if(s.life<=0){ s.m.visible = false; continue; }
    s.v.y -= 4.6*dt;
    s.m.position.addScaledVector(s.v, dt);
    s.m.rotation.x += s.w.x*dt; s.m.rotation.y += s.w.y*dt; s.m.rotation.z += s.w.z*dt;
    if(s.m.position.y < -0.60){          // условный «пол» кадра
      s.m.position.y = -0.60;
      s.v.y = Math.abs(s.v.y)*0.34; s.v.x *= 0.55; s.v.z *= 0.55;
      s.w.multiplyScalar(0.5);
      if(!s.tink){ s.tink = true; SFX.noise({dur:0.05, f:2800, q:7, g:0.05}); }
    }
    // общий материал — гасим размером, а не прозрачностью
    s.m.scale.setScalar(clamp(s.life/0.35, 0, 1));
  }
}
/* Дым из ствола, пока он горячий: тем гуще, чем чаще стреляли. */
function WPN_updateBarrelSmoke(dt){
  wpn.heat = Math.max(0, wpn.heat - dt*0.34);
  const on = wpn.heat > 0.05 && vmRoot && vmRoot.visible;
  if(!on){ for(const s of WPN_smoke) s.visible = false; return; }
  vmRifle.localToWorld(WPN_v1.set(0, 0.02, -1.02));
  for(let i=0;i<WPN_smoke.length;i++){
    const s = WPN_smoke[i];
    s.userData.t += dt*(0.55 + i*0.11);
    if(s.userData.t > 1) s.userData.t -= 1;
    const t = s.userData.t;
    s.visible = true;
    s.position.set(WPN_v1.x + Math.sin(t*6.0 + i)*0.03*t,
                   WPN_v1.y + t*0.34,
                   WPN_v1.z + t*0.06);
    s.scale.setScalar(0.10 + t*0.30);
    s.material.opacity = clamp(wpn.heat, 0, 1)*0.42*Math.sin(t*Math.PI);
  }
}

/* ------------------------------ ПУЛИ ------------------------------ */
const bullets = [];
const WPN_BGEO = new THREE.BoxGeometry(0.05,0.05,0.75);
/* СТРЕЛА КАК ОБЪЕКТ. Остриё лежит в НАЧАЛЕ КООРДИНАТ и смотрит в −Z:
   именно туда Object3D.lookAt() разворачивает объект (его матрица кладёт
   +Z в «от цели к глазу»). Соглашение не наше, а модуля моделей, и оно
   удобно вдвойне: позиция пули и есть остриё, поэтому и наведение по
   вектору скорости, и «воткнуть в стену» пишутся без поправок на длину. */
const WPN_ARROW_LEN = 0.56;
let WPN_AGEO = null;                 // геометрия запасной стрелы, если моделей нет
function WPN_arrowFallbackGeo(){
  if(WPN_AGEO) return WPN_AGEO;
  const shaft = new THREE.CylinderGeometry(0.009,0.008,0.44,6);
  shaft.rotateX(Math.PI/2); shaft.translate(0,0,0.28);
  const head = new THREE.ConeGeometry(0.014,0.058,4);
  head.rotateX(Math.PI/2); head.translate(0,0,0.029);
  const vane = new THREE.BoxGeometry(0.0035,0.052,0.085);
  vane.translate(0,0.028,0.458);
  WPN_AGEO = { shaft, head, vane };
  return WPN_AGEO;
}
/* Визуал одной стрелы. Просим модель у 50_models.js: там она склеена в
   один-два меша и знает про свой вид (бодкин, горшок, пакля). Заглушка
   нужна только чтобы модуль оружия можно было проверить в одиночку. */
function WPN_arrowMesh(a){
  if(typeof mkArrow === 'function'){
    try{
      const g = mkArrow(a.id);
      if(g && g.isObject3D) return g;
    }catch(err){}
  }
  const G = WPN_arrowFallbackGeo();
  const g = new THREE.Group();
  g.add(new THREE.Mesh(G.shaft, toon(0x8a6236)));
  g.add(new THREE.Mesh(G.head,  basic(a.col)));
  for(let i=0;i<3;i++){
    const v = new THREE.Mesh(G.vane, toon(a.trail));
    v.rotation.z = i*2.0944;
    g.add(v);
  }
  g.userData = { kind:a.id, len:WPN_ARROW_LEN, glow:null };
  return g;
}

const WPN_MATS = {};        // материалы следа, по одному на тип патрона
const WPN_visAll = [];      // все созданные визуалы пуль
const WPN_visPool = [];     // из них свободные (пули)
/* Стрелы держим по пулу НА ВИД: у бодкина, глиняного горшка и пакли разная
   геометрия, и подменить её на готовом меше нельзя — только материал. */
const WPN_arrowPools = {};
let WPN_visBusy = 0;
function WPN_poolOf(v){
  if(!v.arrow) return WPN_visPool;
  let p = WPN_arrowPools[v.kind];
  if(!p) p = WPN_arrowPools[v.kind] = [];
  return p;
}
function WPN_matFor(a){
  let m = WPN_MATS[a.id];
  if(!m){
    m = WPN_MATS[a.id] = {
      body: basic(a.trail, {transparent:true, opacity:0.9, depthWrite:false}),
      glow: new THREE.SpriteMaterial({map:TEX_GLOW, color:a.col, blending:THREE.AdditiveBlending, depthWrite:false})
    };
  }
  return m;
}
function WPN_visGet(a){
  const mm = WPN_matFor(a);
  const arrow = (a.arrow === true);
  let pool = WPN_visPool;
  if(arrow){ pool = WPN_arrowPools[a.id]; if(!pool) pool = WPN_arrowPools[a.id] = []; }
  let v = pool.pop();
  if(!v){
    const mesh = arrow ? WPN_arrowMesh(a) : new THREE.Mesh(WPN_BGEO, mm.body);
    mesh.frustumCulled = false;
    const glow = new THREE.Sprite(mm.glow); glow.frustumCulled = false;
    v = { mesh, glow, arrow, kind:a.id };
    WPN_visAll.push(v);
  }
  if(!arrow) v.mesh.material = mm.body;
  v.glow.material = mm.glow;
  // 90_game.js при рестарте вынимает меши из сцены — возвращаем на место
  if(!v.mesh.parent) scene.add(v.mesh);
  if(!v.glow.parent) scene.add(v.glow);
  v.mesh.visible = true; v.glow.visible = true;
  v.mesh.scale.setScalar(1);
  WPN_visBusy++;
  return v;
}
function WPN_visFree(v){
  if(!v) return;
  v.mesh.visible = false; v.glow.visible = false;
  WPN_poolOf(v).push(v);
  if(WPN_visBusy>0) WPN_visBusy--;
}
function WPN_visReclaim(){
  WPN_visPool.length = 0;
  for(const k in WPN_arrowPools) WPN_arrowPools[k].length = 0;
  for(let i=0;i<WPN_visAll.length;i++){
    const v = WPN_visAll[i];
    v.mesh.visible = false; v.glow.visible = false;
    WPN_poolOf(v).push(v);
  }
  WPN_visBusy = 0;
}

/* ---------------------- ВОТКНУВШИЕСЯ СТРЕЛЫ ----------------------
   Стрела в стене — не украшение, а память о выстреле: по частоколу стрел
   вокруг амбразуры видно, откуда по тебе работают. Пул фиксированный,
   в кадре не создаётся ничего; когда все заняты, забираем самую старую. */
const WPN_STICK_MAX = 12;
const WPN_STICK_LIFE = 6.0;
const WPN_stuck = [];
const WPN_AX_X = new THREE.Vector3(1,0,0);
function WPN_stickArrow(a, p, dir){
  if(typeof scene === 'undefined' || !scene) return;
  let s = null;
  // сначала свободный слот НУЖНОГО вида: геометрия у видов разная
  for(let i=0;i<WPN_stuck.length;i++)
    if(WPN_stuck[i].life<=0 && WPN_stuck[i].kind===a.id){ s = WPN_stuck[i]; break; }
  if(!s && WPN_stuck.length < WPN_STICK_MAX){
    s = { g:WPN_arrowMesh(a), kind:a.id, q0:new THREE.Quaternion(), life:0 };
    s.g.frustumCulled = false;
    scene.add(s.g);
    WPN_stuck.push(s);
  }
  if(!s){
    // пул забит — забираем самую старую стрелу того же вида, иначе любую
    for(let i=0;i<WPN_stuck.length;i++){
      const c = WPN_stuck[i];
      if(c.kind !== a.id) continue;
      if(!s || c.life < s.life) s = c;
    }
    if(!s) return;
  }
  if(!s.g.parent) scene.add(s.g);
  /* Остриё стрелы лежит в начале координат её модели, поэтому точка касания
     и есть позиция: ни поправок на длину, ни «утопить в стену» не нужно —
     древко само окажется снаружи, а наконечник в поверхности. */
  s.g.position.copy(p);
  WPN_v1.copy(p).add(dir);
  s.g.lookAt(WPN_v1);
  s.q0.copy(s.g.quaternion);
  s.g.scale.setScalar(1);
  s.g.visible = true;
  s.life = WPN_STICK_LIFE;
}
function WPN_updateStuck(dt){
  for(let i=0;i<WPN_stuck.length;i++){
    const s = WPN_stuck[i];
    if(s.life<=0) continue;
    s.life -= dt;
    if(s.life<=0){ s.g.visible = false; continue; }
    // первые полсекунды древко дрожит — удар был сильный
    const t = WPN_STICK_LIFE - s.life;
    if(t < 0.5){
      s.g.quaternion.copy(s.q0);
      s.g.rotateOnAxis(WPN_AX_X, Math.sin(t*62)*0.055*(1-t/0.5));
    }
    // материал общий, поэтому гасим размером, как гильзы
    if(s.life < 0.45) s.g.scale.setScalar(clamp(s.life/0.45, 0, 1));
  }
}
function WPN_clearStuck(){
  for(let i=0;i<WPN_stuck.length;i++){ WPN_stuck[i].life = 0; WPN_stuck[i].g.visible = false; }
}

/* Индекс типа боеприпаса по его дескриптору. Ищем в самом AMMO, а не по
   wpn.idx и не по порядковому номеру из головы: пояс объявлен в 10_core.js,
   и перестановка типов там не должна молча ломать сетевые заявки.
   Пуля бота приходит с самодельным дескриптором ('ai'), которого в AMMO нет:
   такие пули заявок не порождают, им хватит нуля. */
function WPN_ammoIdx(a){
  const i = AMMO.indexOf(a);
  return i < 0 ? 0 : i;
}

function spawnBullet(from, dir, a, dmg, owner, chg){
  const v = WPN_visGet(a);
  const heavy = a.id==='frag';
  const arrow = (a.arrow === true);
  const b = {
    pos: from.clone().addScaledVector(dir, 0.5),
    vel: dir.clone().multiplyScalar(a.v),
    a, dmg, owner, chg: chg||0, life:0,
    /* Тип запоминаем НА ПУЛЕ (§9.3): wpn.idx переключается мгновенно, а пуля
       летит до полусекунды. Если в заявку уйдёт текущий выбор, сервер не найдёт
       под неё выстрела — урон потеряется, а нам капнет отказ. */
    ai: WPN_ammoIdx(a),
    vis: v, mesh: v.mesh, glow: v.glow,
    g: CFG.bulletG*a.gMul, drag:a.drag, wm:a.windMul,
    start: from.clone(), trP: from.clone(), trT:0, roll: rnd(0,6.283),
    whiz:false,
    /* Стрела — не трассер: у неё есть настоящая длина, и вытягивать её по
       скорости нельзя, иначе по дуге не будет видно наклона древка.
       arrow/dud заведены прямо в литерале, чтобы форма объекта у всех пуль
       была одна: пуля рождается на горячем пути десятками. */
    arrow, dud:false,
    // толстый медленный снаряд читается на трассе, тонкий матчевый — нет
    w: arrow ? 1 : (heavy ? 2.4 : (a.id==='fire' ? 1.5 : 0.85)),
    gs: arrow ? (a.id==='flame' ? 0.40 : (a.id==='bomb' ? 0.26 : 0))
              : (heavy ? 0.62 : (a.id==='fire' ? 0.52 : 0.34))
  };
  if(arrow) v.mesh.scale.setScalar(0.5);
  else v.mesh.scale.set(b.w, b.w, 1);
  v.glow.scale.setScalar(b.gs);
  v.glow.visible = b.gs > 0.001;      // у простой стрелы свечения нет вовсе
  v.mesh.position.copy(b.pos); v.glow.position.copy(b.pos);
  bullets.push(b);
  return b;
}

/* След пули: у каждого типа свой почерк. Ближние 3.5 м не трогаем —
   иначе трасса засвечивает центр экрана и цель не читается. */
function WPN_trail(b, dt){
  const a = b.a;
  b.trT -= dt;
  if(b.trT > 0) return;
  if(b.pos.distanceToSquared(b.start) < 12.25) return;
  /* Почерк следа выбираем по СВОЙСТВАМ боеприпаса, а не по его имени:
     зажигательный патрон и огненная стрела делают в воздухе одно и то же,
     и держать для этого две одинаковые ветки по id — верный способ забыть
     одну из них при следующем стволе. */
  if(a.burnDps > 0){
    b.trT = 0.055;
    if(FX.magic) FX.magic(b.pos, 1, 0xff8b4a);
    else FX.burst(b.pos, 1, {mat:PMAT.fire, speed:0.8, life:0.45, size:0.06, s1:0.01, g:-1.4});
    if(FX.tracer) FX.tracer(b.trP, b.pos, a.trail, 0.09);
  } else if(a.splashR > 0){
    b.trT = 0.075;
    FX.burst(b.pos, 1, {mat:PMAT.smoke, speed:0.7, life:0.85, size:0.09, s1:0.30, g:-0.8});
  } else if(b.arrow){
    // обычная стрела следа не оставляет: её и должно быть трудно заметить
    b.trT = 0.25;
  } else {
    b.trT = (b.owner==='player') ? 0.045 : 0.065;
    if(FX.tracer) FX.tracer(b.trP, b.pos, a.trail, 0.06);
  }
  b.trP.copy(b.pos);
}

function updateBullets(dt){
  // внешний сброс (рестарт матча) — вернуть визуалы в пул
  if(bullets.length===0 && WPN_visBusy>0) WPN_visReclaim();
  for(let i=bullets.length-1;i>=0;i--){
    const b = bullets[i];
    const sub = clamp(Math.ceil(dt/0.005), 1, 8);
    const h = dt/sub;
    let dead = false;
    for(let s=0;s<sub && !dead;s++){
      b.vel.y -= b.g*h;
      b.vel.x += wind.x*b.wm*3.0*h;
      b.vel.z += wind.z*b.wm*3.0*h;
      b.vel.multiplyScalar(Math.max(0.2, 1 - b.drag*h));
      const seg = b.vel.length()*h;
      _t1.copy(b.vel).normalize();
      let bt = seg+0.001, hitKind = null, hitObj = null, hitPart = null;
      if(b.owner==='player'){
        for(const e of enemies){
          if(!e.alive) continue;
          const r = e.segHit(b.pos, _t1, bt);
          if(r && r.t < bt){ bt = r.t; hitKind='enemy'; hitObj=e; hitPart=r.part; }
        }
        // Сетевые противники. Попадание засчитывает стреляющий: он бьёт по той
        // позиции, которую видит у себя на экране, — так пропадают «призрачные»
        // промахи по цели, до которой пуля летит полсекунды.
        if(NET_ACTIVE){
          const rn = NETP.segHit(b.pos, _t1, bt);
          if(rn && rn.t < bt){ bt = rn.t; hitKind='netplayer'; hitObj=rn; hitPart=rn.part; }
        }
      } else if(player.alive){
        const r = segPlayer(b.pos, _t1, bt);
        if(r && r.t < bt){ bt = r.t; hitKind='player'; hitPart=r.part; }
      }
      const rb = rayBoxes(b.pos, _t1, bt);
      if(rb){ bt = rb.t; hitKind='box'; hitObj=null; _t4.copy(rb.n); }
      const rt = rayTerrain(b.pos, _t1, bt);
      if(rt){ bt = rt.t; hitKind='terrain'; }

      if(hitKind){
        _t2.copy(b.pos).addScaledVector(_t1, bt);
        onBulletHit(b, hitKind, hitObj, hitPart, _t2, hitKind==='box'?_t4:null);
        dead = true; break;
      }
      b.pos.addScaledVector(b.vel, h);
      b.life += h;
      if(b.life>6 || b.pos.y < -30 || Math.abs(b.pos.x)>140 || Math.abs(b.pos.z)>140) dead = true;
    }
    // свист рядом с ухом
    if(!dead && b.owner==='enemy' && !b.whiz){
      const d = b.pos.distanceTo(camera.position);
      if(d < 3.2){ b.whiz = true; SFX.whiz(panOf(b.pos)); }
    }
    if(dead){ WPN_visFree(b.vis); b.vis = null; bullets.splice(i,1); continue; }

    const m = b.mesh, gl = b.glow;
    m.position.copy(b.pos); gl.position.copy(b.pos);
    /* Разворот по вектору скорости — каждый кадр и для всех. У пули это
       мелочь, а у стрелы весь смысл: на дуге видно, как она задирает нос
       на подъёме и клюёт вниз на нисходящей ветви. */
    m.lookAt(_t1.copy(b.pos).add(b.vel));
    if(b.a.id==='frag'){ b.roll += dt*9; m.rotateZ(b.roll); }   // тяжёлый снаряд кувыркается на трассе
    // на вылете пуля «разгоняется» визуально: у дула она почти не видна
    const fade = clamp(b.pos.distanceTo(b.start)/6, 0, 1);
    if(b.arrow){
      // длина у стрелы своя, растягивать её по скорости нечестно
      m.scale.setScalar(0.5 + 0.5*fade);
    } else {
      const len = clamp(b.vel.length()*0.045, 0.6, 3.2);
      m.scale.set(b.w*(0.35+0.65*fade), b.w*(0.35+0.65*fade), len);
    }
    gl.scale.setScalar(b.gs*(0.35+0.65*fade)*(b.a.burnDps > 0 ? (0.85+0.25*Math.sin(b.life*40)) : 1));
    WPN_trail(b, dt);
  }
}

/* Роль боеприпаса — в его полях, а не в имени. Фугасный снаряд и взрывная
   стрела ведут себя одинаково, зажигательный патрон и огненная стрела тоже;
   разводить их по id значило бы дублировать каждую ветку на каждый ствол.
   У самодельного дескриптора пули бота этих полей нет — и он честно
   оказывается «обычным». */
function WPN_isBlast(a){ return a.splashR > 0; }
function WPN_isFire(a){ return a.burnDps > 0; }

/* Крит есть только у типа с AMMO[i].crit === true и никогда у фугаса.
   Полный крит (гарантированное убийство) — ровно один, у матчевого:
   зажигательный бьёт сильнее обычного, но добивает уже горением, а стрела
   в голову удваивает свой и без того зависящий от натяга урон. */
function WPN_headDamage(a, dmg){
  if(WPN_isBlast(a) || a.crit !== true) return -1;
  return a.id === 'match' ? 999 : dmg*2.2;
}

function onBulletHit(b, kind, obj, part, pIn, n){
  const a = b.a;
  const P = _hit.copy(pIn);
  if(n) _nrm.copy(n); else _nrm.set(0,1,0);
  const byPlayer = (b.owner === 'player');
  /* Сорвавшаяся с пальцев стрела остаётся стрелой по типу, но НИЧЕГО не
     поджигает и не взрывает: наказание за плохой выстрел — потерянная
     стрела, а не фугас под собственными ногами. */
  const dud = (b.dud === true);
  const isFrag = WPN_isBlast(a) && !dud;
  const isFire = WPN_isFire(a) && !dud;

  if(kind==='enemy'){
    const hd = (part==='head') ? WPN_headDamage(a, b.dmg) : -1;
    const crit = hd >= 0;
    const dmg = crit ? hd : b.dmg;
    const hpWas = obj.hp;
    // здоровье ботов в сети ведёт хост — см. пояснение в explode()
    if(!NET_ACTIVE || NET.host) obj.hurt(dmg, crit ? 'head' : 'body', P);
    else if(byPlayer) NET.reportBotHit(obj.id, dmg, crit ? 'head' : 'body', b.ai);
    if(byPlayer){
      game.hits++;
      const dist = b.start.distanceTo(P);
      hitMarker(crit);
      WPN_v1.copy(P); WPN_v1.y += 0.45;
      FX.num(WPN_v1, (crit && a.id==='match') ? 'КРИТ' : Math.round(Math.min(dmg, hpWas)), crit);
      if(crit){ game.heads++; SFX.crit(); } else SFX.hit();
      if(!obj.alive) game.best = Math.max(game.best, dist);
    }
    FX.burst(P, crit?16:9, {mat:PMAT.blood, speed:crit?9:5.5, life:0.6, size:0.09});
    if(isFire && obj.alive){
      /* Горение бота ведёт хост: у остальных боты — реплики, их update() не
         зовётся, поэтому накопленный burn никогда не стечёт и реплика будет
         гореть вечно, а урон до хоста не дойдёт. */
      if(!NET_ACTIVE || NET.host) obj.applyBurn(a.burnTime*a.burnDps, true);
      else NET.reportBotHit(obj.id, a.burnTime*a.burnDps, 'burn', b.ai);
      if(FX.magic) FX.magic(P, 6, PAL.ember);
    }
  } else if(kind==='netplayer'){
    /* Урон себе не применяем: здоровье чужого игрока ведёт сервер. Мы только
       показываем отклик и отправляем заявку — сервер её проверит и разошлёт. */
    const hd = (part==='head') ? WPN_headDamage(a, b.dmg) : -1;
    const crit = hd >= 0;
    const dmg = crit ? hd : b.dmg;
    game.hits++;
    hitMarker(crit);
    if(crit){ game.heads++; SFX.crit(); } else SFX.hit();
    WPN_v1.copy(P); WPN_v1.y += 0.45;
    FX.num(WPN_v1, (crit && a.id==='match') ? 'КРИТ' : Math.round(dmg), crit);
    FX.burst(P, crit?16:9, {mat:PMAT.blood, speed:crit?9:5.5, life:0.6, size:0.09});
    game.best = Math.max(game.best, b.start.distanceTo(P));
    /* Тип берём у пули, а не из wpn.idx: игрок мог переключить пояс, пока
       пуля летела, и сервер сопоставляет заявку именно с тем выстрелом. */
    NET.reportHit(obj.id, part, dmg, b.ai);
    if(isFire) NET.reportBurn(obj.id, a.burnTime*a.burnDps);
  } else if(kind==='player'){
    // по игроку стреляют боты матчевым — крит у него полноценный
    const crit = (part==='head') && !isFrag;
    /* Здоровье в сети принадлежит серверу (§9.1), поэтому player.hp здесь не
       трогаем ни при каких условиях: и приём урона, и превращение его в заявку
       живут в одном месте — hurtPlayer()/burnPlayer() из 75_combat.js. Свой
       сетевой путь в обход них означал бы второй источник правды. */
    hurtPlayer(crit ? b.dmg*1.65 : b.dmg, b.start, crit ? 'В ГОЛОВУ' : null);
    FX.burst(P, 6, {mat:PMAT.blood, speed:4, life:0.5, size:0.08});
    if(isFire && typeof burnPlayer === 'function') burnPlayer(a.burnTime*a.burnDps);
  } else {
    if(!n) terrainN(P.x,P.z,_nrm);
    /* Стрела втыкается и торчит: направление берём у самой пули ДО любых
       вызовов FX — общие временные векторы там затираются без предупреждения. */
    if(b.arrow){
      WPN_v3.copy(b.vel);
      if(WPN_v3.lengthSq() > 1e-6){
        WPN_v3.normalize();
        WPN_stickArrow(a, P, WPN_v3);
        SFX.noise({dur:0.09, f:kind==='terrain'?340:900, f2:200, q:2.4, g:0.20*volOf(P), pan:panOf(P)});
      }
    }
    /* burst() с нормалью и push сам распознаёт попадание пули и уводит его в
       FX.impact(), а та кладёт след по типу поверхности. Свой FX.decal здесь
       не нужен: он давал вторую метку в той же точке и жёг пул декалей вдвое. */
    FX.burst(P, 8, {mat: kind==='terrain'?PMAT.dust:PMAT.spark, speed:5.5, life:0.55, size:0.075, dir:_nrm, push:3});
    if(isFire){
      // промах зажигательным — это не промах, а очаг на земле
      FX.firePool(P, a.poolR, a.poolTime, a.poolDps, byPlayer);
      // очаг соперника обязан быть виден и опасен и остальным
      if(NET_ACTIVE && byPlayer) NET.reportPool(P);
      if(FX.magic) FX.magic(P, 8, PAL.ember);
    }
    SFX.noise({dur:0.12, f:kind==='terrain'?520:2200, q:2, g:0.16*volOf(P), pan:panOf(P)});
    if(byPlayer && typeof LIGHTS !== 'undefined' && LIGHTS.flash && isFire)
      LIGHTS.flash(P, 0xff7a30, 4, 10, 0.12);
  }

  /* Фугас считает урон площадью и делает это последним: splashDamage()
     сама срежет урон за укрытием, а крита у фугаса нет ни при каком попадании.
     Тип отдаём взрыву явно — заявки об уроне ботам он шлёт сам, и индекс там
     нужен тот же самый, от пули (§9.3). */
  if(isFrag) explode(P, a.splashR, a.splashMax, byPlayer, a.splashFall, a.splashCover, b.ai);
}

function segPlayer(p0, dir, len){
  const hh = player.h;
  const t1 = segSphere(p0,dir,len, player.pos.x, player.pos.y+hh-0.20, player.pos.z, 0.235);
  if(t1>=0) return {t:t1, part:'head'};
  const t2 = segOBB(p0,dir,len, player.pos.x, player.pos.y+hh*0.52, player.pos.z, 0.33, hh*0.40, 0.27, player.yaw);
  if(t2>=0) return {t:t2, part:'body'};
  return null;
}
function segSphere(p0, d, len, cx,cy,cz, r){
  const ox=p0.x-cx, oy=p0.y-cy, oz=p0.z-cz;
  const b = ox*d.x+oy*d.y+oz*d.z;
  const c = ox*ox+oy*oy+oz*oz - r*r;
  const disc = b*b-c;
  if(disc<0) return -1;
  const sq = Math.sqrt(disc);
  let t = -b-sq;
  if(t<0) t = -b+sq;
  if(t<0 || t>len) return -1;
  return Math.max(t,0);
}
function segOBB(p0, d, len, cx,cy,cz, hx,hy,hz, yaw){
  const co=Math.cos(yaw), si=Math.sin(yaw);
  const dx=p0.x-cx, dz=p0.z-cz;
  const O=[dx*co-dz*si, p0.y-cy, dx*si+dz*co];
  const Dv=[d.x*co-d.z*si, d.y, d.x*si+d.z*co];
  const Hh=[hx,hy,hz];
  let t0=0, t1=len;
  for(let a=0;a<3;a++){
    if(Math.abs(Dv[a])<1e-8){ if(Math.abs(O[a])>Hh[a]) return -1; continue; }
    const inv=1/Dv[a];
    let ta=(-Hh[a]-O[a])*inv, tb=(Hh[a]-O[a])*inv;
    if(ta>tb){ const q=ta; ta=tb; tb=q; }
    if(ta>t0) t0=ta;
    if(tb<t1) t1=tb;
    if(t0>t1) return -1;
  }
  return t0<=0 ? 0 : t0;
}
