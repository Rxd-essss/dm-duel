/* --------------------------- РЕНДЕР / СЦЕНА --------------------------- */
let renderer, scene, camera, vmScene, vmCamera, world, sun, hemi, skyMesh;
let W = innerWidth, H = innerHeight;
// Контровая: холодный свет «из-за спины сцены». Нужен не для красоты — он
// обводит силуэт бойца прохладной каймой, и цель читается на 100+ м даже
// когда стоит на фоне такого же тёплого песка.
let RND_rim = null, RND_rim2 = null;

/* Номинальная сила солнца и её доля при выключенных тенях.
   Зал закрыт кровлей, и с включёнными тенями прямое солнце внутрь почти не
   попадает — замер это подтвердил в лоб: снижение солнца с 0.62 до 0.50
   меняло среднюю кадра на единицу из 255. Но качество картинки в меню можно
   опустить до setShadows(0), и тогда кровля перестаёт затенять что-либо:
   солнце разом ложится на каждую горизонтальную грань зала, и доля пикселей
   ярче 235 подскакивало с 3.2% до 10.7% при рамке 0.5…4% — на стенде с
   плотной кровлей. На боевой карте перекос мягче, но он есть.
   Поэтому при выключенных тенях солнце гасится: оно светит внутрь только
   потому, что тень не посчитана, — это не свет, а артефакт.
   Итог замера по 24 позициям настоящей карты: тени высокие 124.0 / светов
   3.61%, тени выключены 122.5 / светов 1.60% — обе ступени внутри рамки. */
const RND_SUN_I = 0.55;
const RND_SUN_NOSHADOW = 0.45;

/* Потолок плотности пикселей. Сцена упирается во fill rate: ландшафт с
   receiveShadow, полноэкранное небо и много аддитивной прозрачности без
   depthWrite. На HiDPI-ноутбуке devicePixelRatio=2 — это вчетверо больше
   фрагментов при том же кадре, и именно он, а не тени, решает на слабых
   машинах. 1.5 визуально почти неотличим, но возвращает ~40% кадра. */
let RND_pixCap = 1.5;

/* --------------------------- ТОНМАППИНГ ---------------------------
   Заказчик жалуется на пересветы, и первый заход лечил их одним плечом:
   ниже колена кривая тождественна, выше — экспоненциальный подход к 1.0.
   Клиппинг это убрало, но породило беду ровно противоположного вида, и
   замер её показал в лоб. Взгляд вниз на открытую землю: средняя 162,
   p05..p95 = 145..178, пикселей темнее 60 — 0.04%, светлее 235 — ноль.
   То есть весь кадр сжался в тридцать уровней вокруг светло-серого: земля
   рисовалась плоским полем без света и без тени. Плечо не выбирает, что
   давить, — оно давит ВЕСЬ верх, а верх у нас занимает почти всё.

   Отсюда кривая из двух частей.

   1. КОНТРАСТ. Перед плечом тон возводится в степень C>1. Это растягивает
      сцену по яркости: тень уходит вниз, освещённое остаётся наверху, и
      между ними появляется расстояние. Степень берётся от ЯРКОСТИ, а не
      поканально: поканальная степень разъезжает по цвету и делает песок
      кислотно-жёлтым, а так меняется только тон, палитра PAL цела.
      Заодно это одна операция на фрагмент вместо трёх.
   2. ПЛЕЧО. Прежнее: выше колена K экспоненциальный подход к 1.0, в чистый
      белый не упирается никогда. Оно и ловит то, что контраст задрал вверх.

   Готовые кривые three.js по-прежнему не годятся: ACES и Cineon трогают весь
   диапазон, а купол неба (25_terrain.js) — сырой ShaderMaterial без чанка
   тонмаппинга, он остаётся нетронутым, и любая кривая, давящая середину,
   отрывает небо от гор. Туман мешается уже ПОСЛЕ тонмаппинга (порядок чанков
   в r128: tonemapping → encodings → fog), поэтому его цвет остаётся ровно
   тем, что задан.

   outputEncoding намеренно остаётся LinearEncoding: под него откалибрована
   вся палитра (PAL), вершинные цвета ландшафта (множитель 0.62 в 25_terrain.js)
   и нарисованное небо. Переход на sRGB — это перекраска всей игры, а не
   исправление пересветов.

   Числа подобраны не на глаз, а перебором по снятому кадру: 16 открытых
   точек карты рендерились offscreen 1280×720 во float-таргет БЕЗ тонмаппинга,
   и по этим линейным пикселям искалась тройка (экспозиция, контраст, колено),
   попадающая в рамки приёмки. 1.22 / 1.50 / 0.70 даёт по земле среднюю 138,
   темнее 60 — 9.5%, светлее 235 — 1.5% (рамки: 120..160, ≥6%, 0.5..4%);
   p05..p95 стало 51..224 вместо прежних 145..178.

   Оговорка на будущее: экспозиция тут — рычаг с коротким ходом. Контраст
   растягивает кадр, поэтому 1.20 роняет света ниже 0.5%, а 1.26 выносит
   кадр у жаровни за 4%. Менять её можно, но обязательно с замером. */
const RND_TONE_KNEE = 0.70;      // выше этого уровня начинается плечо
/* Контраст ровно 1.5 выбран не только по замеру: при нём множитель равен
   pow(l, 0.5), то есть обычному sqrt — одна инструкция вместо exp2+log2.
   Сцена упирается во fill rate, лишний pow на КАЖДЫЙ фрагмент стоил 0.38 мс
   на кадре 1280×720 (1.13 -> 1.51), а sqrt возвращает цену кадра к прежней. */
const RND_TONE_CON  = 1.50;      // показатель контраста по яркости
let RND_exposure = 1.22;         // экспозиция; см. RND_setExposure()
/* Подменяем заглушку CustomToneMapping в общем чанке. Делается на верхнем
   уровне модуля, то есть заведомо до первой компиляции шейдеров: чанк
   разворачивается при сборке программы, а она случается в первом render(). */
const RND_TONE_STUB = 'vec3 CustomToneMapping( vec3 color ) { return color; }';
const RND_TONE_OK = THREE.ShaderChunk.tonemapping_pars_fragment.indexOf(RND_TONE_STUB) >= 0;
if(RND_TONE_OK)
  THREE.ShaderChunk.tonemapping_pars_fragment =
    THREE.ShaderChunk.tonemapping_pars_fragment.replace(RND_TONE_STUB,
      [ 'vec3 CustomToneMapping( vec3 color ) {',
        '  color *= toneMappingExposure;',
        // 1e-5 внизу нужен не для красоты: pow(0, x) на части драйверов даёт NaN
        '  float l = max( dot( color, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-5 );',
        (Math.abs(RND_TONE_CON - 1.5) < 1e-6
          ? '  color *= sqrt( l );'
          : '  color *= pow( l, ' + (RND_TONE_CON - 1).toFixed(3) + ' );'),
        '  const vec3 K = vec3(' + RND_TONE_KNEE.toFixed(3) + ');',
        '  vec3 hi = max( color - K, vec3( 0.0 ) );',
        '  return min( color, K ) + ( vec3( 1.0 ) - K ) * ( vec3( 1.0 ) - exp( -hi / ( vec3( 1.0 ) - K ) ) );',
        '}' ].join('\n'));

/* Экспозиция — единственный «глобальный» рычаг яркости. Менять её после
   старта можно свободно: это uniform, пересборка шейдеров не нужна. */
function RND_setExposure(v){
  RND_exposure = clamp(v, 0.4, 2.0);
  if(renderer) renderer.toneMappingExposure = RND_exposure;
  return RND_exposure;
}

function initThree(){
  renderer = new THREE.WebGLRenderer({ canvas:document.getElementById('c'), antialias:true, powerPreference:'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, RND_pixCap));
  renderer.setSize(W,H);
  // Ставим ДО создания материалов: тип тонмаппинга вшит в ключ программы, и
  // смена его на живой сцене потребовала бы пересборки всех шейдеров.
  // Если заглушку в чанке подменить не удалось (чужая сборка three.js), молча
  // остаться без тонмаппинга нельзя — это ровно та картинка, которую чиним.
  // Тогда берём ACES: он темнее задуманного, но света не слипаются.
  renderer.toneMapping = RND_TONE_OK ? THREE.CustomToneMapping : THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = RND_exposure;
  // ACES-запасной вариант темнее задуманного; экспозицию под него поднимаем,
  // иначе при чужой сборке three.js игра выйдет мрачной.
  if(!RND_TONE_OK) renderer.toneMappingExposure = RND_exposure * 1.35;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Карту тени обновляет цикл (через кадр) — см. loop() в 90_game.js
  renderer.shadowMap.autoUpdate = false;
  renderer.autoClear = false;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9dc0d8);
  /* ДЫМКА ГЛУБИНЫ.
     На открытой карте туман начинался за 130 м и работал только на дальние
     планы: между целью и фоном воздуха почти не было, а разделял их горизонт.
     В закрытом зале горизонта нет. Замер это показал в лоб: боец на ярусе 1
     в 100 м давал среднюю яркость 59.1 при фоне 58.8 — силуэт совпадал со
     стеной за ним до трёх десятых единицы, то есть был невидим.

     Причина простая и геометрическая: и грудь бойца, и торцевая стена
     смотрят в камеру одной и той же нормалью, значит и света получают
     поровну. Единственное, чем они отличаются, — расстояние. Отсюда дымка
     с ближней границей в десяток метров: она разводит по яркости всё, что
     стоит на разной глубине, и превращает «дистанцию» в видимую величину.
     Цвет тёплый и светлый — это подсвеченная лучами древесная пыль, а не
     молоко: он поднимает дальний план, а не глушит его.

     Цвет тоже выбран замером, и он контринтуитивен: чем СВЕТЛЕЕ дымка, тем
     лучше читается цель. Перебор пяти оттенков по восьми створам настоящей
     карты: тёмная тёплая (0x5e4a36) даёт средний отрыв 10.1, средняя
     (0xb8a082) — 14.5, светлая пыльная (0xdcc8ac) — 18.4, при одной и той же
     средней яркости кадра 123. Причина простая: боец в этом зале ТЕМНЕЕ фона,
     и светлая дымка поднимает дальний план сильнее, чем цель, — разрыв растёт.
     Тёмная дымка, наоборот, тянет фон к яркости цели и силуэт съедает.

     Сила подобрана перебором по замеру силуэта, а не на глаз. 12/180 даёт
     на пяти створах средний отрыв цели от фона 19.7 единицы против 5.8 на
     прежнем тумане — при том, что общая яркость кадра не изменилась (126.3
     против 125.9). Дальше уводить нельзя: на 130 м, то есть от торца до
     торца, подмешивание доходит до 78%, и пелена начнёт съедать уже саму
     цель, а это снайперская карта. */
  scene.fog = new THREE.Fog(0xdcc8ac, 12, 180);

  camera = new THREE.PerspectiveCamera(80, W/H, 0.06, 900);

  // Отдельная сцена для оружия от первого лица — не режется стенами.
  // Схема света та же, что в мире: один ключевой источник и слабое заполнение.
  // Уровень поднят на 21% (0.58/1.22/0.26 -> 0.70/1.48/0.31): контрастная
  // кривая тонмаппинга давит середину, и на прежнем свете винтовка уходила со
  // средней яркости 122 на 87 — оружие висит в кадре всегда, темнеть ему
  // сильнее мира нельзя. Замер: 174 тыс. пикселей модели в кадре 1280×720.
  vmScene = new THREE.Scene();
  vmCamera = new THREE.PerspectiveCamera(58, W/H, 0.01, 12);
  vmScene.add(new THREE.HemisphereLight(0xdcefff, 0x53483a, 0.70));
  const vl = new THREE.DirectionalLight(0xfff1d4, 1.48); vl.position.set(1.4,2.2,1.6); vmScene.add(vl);
  const vl2 = new THREE.DirectionalLight(0x7cb4ea, 0.31); vl2.position.set(-1.6,0.6,-1.2); vmScene.add(vl2);

  world = new THREE.Group(); scene.add(world);

  /* ------------------------- СХЕМА СВЕТА ЗАЛА -------------------------
     MAPDESIGN §10.6 требует ровно три вещи, и все три видны на референсе:
     тёплые настенные лампы внизу, дневные лучи из-под крыши сверху и общий
     контраст «холодное сверху против тёплого снизу». Риг под это перебран
     целиком — прежний собирался под открытую долину в полдень и в закрытом
     помещении давал среднюю яркости кадра 86 при норме 120…160.

     ПОЛУСФЕРА — главный носитель контраста «верх/низ», и она же тут почти
     даром: небесная половина холодная (дневной свет, попадающий через фонарь
     под крышей), земляная — тёплая и насыщенная (отражённый от земляного пола
     свет ламп). Грань, повёрнутая вверх, получает синеву; повёрнутая вниз —
     охру. Один источник, а зал сразу читается как помещение с двумя разными
     светами, а не как предмет под лампочкой.

     СОЛНЦЕ — это не солнце в кадре, а тот же дневной свет из фонаря: с той
     же стороны, что и лучи (TER_SUN в 25_terrain.js), и той же температуры.
     Его доля намеренно сдержанная: кровлю ставит агент карты, она бросает
     тень, и полагаться на прямой свет внутри зала нельзя — при включённых
     тенях его может не быть вовсе. Всё, что обязано быть видно всегда,
     держат полусфера, лампы и лучи.

     КОНТРОВЫЕ — две, с обоих боков, низкие и холодные. Это не украшение, а
     инструмент читаемости, и ради него они и разведены по бокам: длинные
     стены зала и торцы смотрят нормалями вдоль осей, боец же — тело круглое,
     и боковой свет ложится ему на кромку, а плоской стене за ним почти не
     достаётся. Именно эта разница и вытаскивает силуэт из фона: до правки
     боец на 100 м отличался от стены на 0.3 единицы яркости из 255. */
  hemi = new THREE.HemisphereLight(0xbcd8f6, 0xe0a05c, 1.80); scene.add(hemi);
  sun = new THREE.DirectionalLight(0xfff0cc, RND_SUN_I);
  sun.position.set(60,90,40); sun.castShadow = true;
  sun.shadow.mapSize.set(2048,2048);
  // Рамка тени сужена с ±46 до ±30 м. Солнце едет за игроком, поэтому карта
  // тени всё равно пересчитывается каждый кадр — платить за неё имеет смысл
  // только в ближней зоне: на 40+ м тень от ящика уже не читается, а плотность
  // текселей внутри рамки вырастает вдвое.
  sun.shadow.camera.left=-30; sun.shadow.camera.right=30;
  sun.shadow.camera.top=30; sun.shadow.camera.bottom=-30;
  sun.shadow.camera.near=1; sun.shadow.camera.far=230;
  sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.03;
  scene.add(sun); scene.add(sun.target);
  RND_rim = new THREE.DirectionalLight(0x8fc2ff, 0.52);
  RND_rim.position.set(-90,22,-34); scene.add(RND_rim);
  RND_rim2 = new THREE.DirectionalLight(0x7fb0ea, 0.38);
  RND_rim2.position.set(90,18,40); scene.add(RND_rim2);

  LIGHTS.init();

  addEventListener('resize', onResize);
}
function onResize(){
  W = innerWidth; H = innerHeight;
  renderer.setPixelRatio(Math.min(devicePixelRatio, RND_pixCap));
  renderer.setSize(W,H);
  camera.aspect = W/H; camera.updateProjectionMatrix();
  vmCamera.aspect = W/H; vmCamera.updateProjectionMatrix();
  if (typeof updateReticle === 'function') updateReticle();
}
// качество картинки из меню: 0.75 / 1.0 / 1.5
function setPixelCap(v){
  RND_pixCap = clamp(v, 0.5, 2);
  renderer.setPixelRatio(Math.min(devicePixelRatio, RND_pixCap));
  renderer.setSize(W,H);
}
function setShadows(level){
  renderer.shadowMap.enabled = level>0;
  // см. RND_SUN_NOSHADOW: без теней кровля перестаёт держать солнце
  sun.intensity = level>0 ? RND_SUN_I : RND_SUN_NOSHADOW;
  const s = level>=2 ? 2048 : 1024;
  if(sun.shadow.mapSize.x !== s){
    sun.shadow.mapSize.set(s,s);
    if(sun.shadow.map){ sun.shadow.map.dispose(); sun.shadow.map = null; }
  }
  scene.traverse(o=>{ if(o.isMesh && o.userData.shadowy){ o.castShadow = level>0; } });
  // Динамические лампы теней не бросают ни на каком уровне: восемь теневых
  // кубмап-источников — это гарантированный провал по кадрам.
}

/* ------------------ СЛИЯНИЕ СТАТИЧЕСКОЙ ГЕОМЕТРИИ ------------------ */
/* Карта собирается из ~1400 отдельных мешей, у которых на всех всего ~130
   материалов. С момента buildMap() они не двигаются, но кадр платит за них
   дважды: обходом графа сцены с отсевом по пирамиде и построчной отправкой
   draw call'ов. Замер до слияния: ~3 мс на обход world и ~1.6 мс на
   updateMatrixWorld — при том, что вся игровая логика укладывается в 2 мс.

   Поэтому после сборки карты статика склеивается в общие меши по ключу
   «материал × ячейка карты». Ячейка нужна, чтобы не терять отсев целиком:
   один меш на весь материал рисовался бы всегда, даже когда его половина за
   спиной. THREE.BufferGeometryUtils в CDN-сборке r128 отсутствует, поэтому
   склейка своя.

   Что НЕ сливается: всё, что анимируется (мостики, кристаллы, руны, огни,
   знамёна, пикапы), прозрачные материалы (у них важен порядок отрисовки),
   мультиматериальные меши и крупная геометрия вроде ландшафта — она и так
   один draw call. */

const RND_MERGE_CELL = 60;   // размер ячейки отсева, м
let RND_merged = [];         // получившиеся меши — чтобы можно было пересобрать

// Пометить поддеревья, которые анимируются и потому не подлежат склейке.
function RND_markDynamic(set){
  const add = o => {
    if(!o) return;
    set.add(o);
    if(o.children) for(let i=0;i<o.children.length;i++) add(o.children[i]);
  };
  // Реестры живут в чужих модулях и могут отсутствовать — берём мягко.
  const regs = [];
  try { if(typeof BRIDGES        !== 'undefined') regs.push(BRIDGES.map(b => b && (b.g || b.mesh || b))); } catch(e){}
  try { if(typeof PROP_CRYSTALS  !== 'undefined') regs.push(PROP_CRYSTALS); } catch(e){}
  try { if(typeof PROP_RUNES     !== 'undefined') regs.push(PROP_RUNES); } catch(e){}
  try { if(typeof PROP_FIRES     !== 'undefined') regs.push(PROP_FIRES); } catch(e){}
  try { if(typeof PROP_BANNERS   !== 'undefined') regs.push(PROP_BANNERS); } catch(e){}
  try { if(typeof PICKUPS        !== 'undefined') regs.push(PICKUPS.map(p => p && p.mesh)); } catch(e){}
  for(const r of regs){
    if(!r || !r.length) continue;
    for(let i=0;i<r.length;i++){
      const it = r[i];
      if(!it) continue;
      // элемент реестра может быть как самим объектом, так и записью с полями
      add(it.isObject3D ? it : (it.g || it.mesh || it.obj || it.group || null));
    }
  }
  return set;
}

function RND_mergeable(m){
  if(!m.isMesh || !m.visible) return false;
  if(m.userData && (m.userData.dyn || m.userData.noMerge)) return false;
  if(Array.isArray(m.material)) return false;
  const mat = m.material;
  if(!mat || mat.transparent) return false;
  const g = m.geometry;
  if(!g || !g.attributes || !g.attributes.position) return false;
  if(g.morphAttributes && Object.keys(g.morphAttributes).length) return false;
  // крупная геометрия (ландшафт, небо) — уже один вызов, склейка только навредит
  if(g.attributes.position.count > 4000) return false;
  return true;
}

function RND_collectStatic(node, dyn, out){
  const ch = node.children;
  for(let i=0;i<ch.length;i++){
    const o = ch[i];
    if(dyn.has(o)) continue;
    if(o.isMesh){ if(RND_mergeable(o)) out.push(o); continue; }
    if(o.isSprite || o.isPoints || o.isLine || o.isLight || o.isCamera) continue;
    if(o.children && o.children.length) RND_collectStatic(o, dyn, out);
  }
}

/* Склейка одной группы мешей с общим материалом в один BufferGeometry.
   Индексированную геометрию разворачиваем в неиндексированную: примитивы тут
   мелкие, экономия индекса не окупает возню со сдвигом смещений. */
function RND_mergeGroup(list){
  const parts = [];
  let total = 0, hasN = true, hasUV = true, hasC = true;
  for(let i=0;i<list.length;i++){
    const m = list[i];
    let g = m.geometry;
    g = g.index ? g.toNonIndexed() : g.clone();
    m.updateWorldMatrix(true, false);
    g.applyMatrix4(m.matrixWorld);          // позиции и нормали сразу в мире
    const a = g.attributes;
    if(!a.normal) hasN = false;
    if(!a.uv) hasUV = false;
    if(!a.color) hasC = false;
    total += a.position.count;
    parts.push(g);
  }
  const pos = new Float32Array(total*3);
  const nrm = hasN ? new Float32Array(total*3) : null;
  const uvs = hasUV ? new Float32Array(total*2) : null;
  const col = hasC ? new Float32Array(total*3) : null;
  let o3 = 0, o2 = 0;
  for(let i=0;i<parts.length;i++){
    const a = parts[i].attributes, n = a.position.count;
    pos.set(a.position.array.subarray(0, n*3), o3);
    if(nrm) nrm.set(a.normal.array.subarray(0, n*3), o3);
    if(uvs) uvs.set(a.uv.array.subarray(0, n*2), o2);
    if(col) col.set(a.color.array.subarray(0, n*3), o3);
    o3 += n*3; o2 += n*2;
    parts[i].dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if(nrm) g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  else g.computeVertexNormals();
  if(uvs) g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if(col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

/* Главный вход. Зовётся из boot() ПОСЛЕ buildMap() и ПОСЛЕ построения
   индекса поверхностей в 55_fx.js — тому нужны исходные меши поштучно. */
function mergeStaticWorld(){
  if(!world) return null;
  const dyn = RND_markDynamic(new Set());
  const src = [];
  RND_collectStatic(world, dyn, src);
  if(src.length < 2) return null;

  // ключ: материал × ячейка. Ячейку берём по центру ограничивающей сферы,
  // чтобы длинные объекты не рвались между соседними ячейками.
  const buckets = new Map();
  const c = new THREE.Vector3();
  for(let i=0;i<src.length;i++){
    const m = src[i];
    if(!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
    m.updateWorldMatrix(true, false);
    c.copy(m.geometry.boundingSphere.center).applyMatrix4(m.matrixWorld);
    const cx = Math.floor(c.x/RND_MERGE_CELL), cz = Math.floor(c.z/RND_MERGE_CELL);
    const key = m.material.uuid + '|' + cx + '|' + cz;
    let b = buckets.get(key);
    if(!b){ b = { mat:m.material, list:[] }; buckets.set(key, b); }
    b.list.push(m);
  }

  let made = 0, killed = 0;
  buckets.forEach(b => {
    if(b.list.length < 2) return;              // одиночку склеивать незачем
    let cast = false, recv = false, shadowy = false;
    for(const m of b.list){
      if(m.castShadow) cast = true;
      if(m.receiveShadow) recv = true;
      if(m.userData && m.userData.shadowy) shadowy = true;
    }
    const g = RND_mergeGroup(b.list);
    const mesh = new THREE.Mesh(g, b.mat);
    mesh.castShadow = cast; mesh.receiveShadow = recv;
    mesh.userData.shadowy = shadowy;
    mesh.userData.merged = true;
    mesh.matrixAutoUpdate = false;             // геометрия уже в мировых координатах
    mesh.updateMatrix();
    world.add(mesh);
    RND_merged.push(mesh);
    made++;
    for(const m of b.list){
      if(m.parent) m.parent.remove(m);
      m.geometry.dispose();
      killed++;
    }
  });
  return { merged: made, removed: killed, buckets: buckets.size };
}

/* --------------------------- ДИНАМИЧЕСКИЙ СВЕТ --------------------------- */
/* Форвардный рендер three.js вшивает количество источников прямо в шейдер:
   каждый лишний PointLight — это ALU в каждом фрагменте, а изменение их числа
   (в том числе visible=false и remove) роняет кадр на пересборке всех программ.
   Поэтому реальных ламп ровно LIGHTS.max, они создаются один раз и живут до
   конца сессии; неиспользуемая лампа просто гасится (intensity = 0).
   Логических источников может быть сколько угодно — каждый кадр лампы
   переезжают на самые важные: ближе к камере, ярче, свежее. */
const LIGHTS = {
  max: 8,          // реальных PointLight в сцене (см. §0.7 контракта)
  /* Размер пула логических источников. Было 64 — и это оказалось прямой
     поломкой на «Лесопилке». Настенные лампы теперь ОСНОВНОЙ свет зала
     (§10.6), а зал длиной 130 м: только их набирается несколько десятков,
     плюс жаровни, руны и холодные огни у шкафов снабжения. Замер по макету
     показал ровно то, что и должно было случиться: пул забился под завязку
     (64 из 64), после чего `flash` перестал получать слот — то есть у игрока
     ПРОПАЛА дульная вспышка и подсветка от взрыва. Логический источник — это
     обычный объект, он не стоит ни одного ALU в шейдере (реальных ламп всё
     равно max=8), поэтому потолок поднят с запасом.
     `reserve` — слоты, которые постоянным огням не отдаются НИКОГДА: вспышка
     обязана светить всегда, даже если карта раздала всё остальное. */
  cap: 192,
  reserve: 16,
  reach: 55,       // насколько далеко за своим радиусом источник ещё борется за лампу
  /* ЯРКОСТЬ ОГНЕЙ — ПЕРЕСМОТРЕНА ПОД ЗАКРЫТЫЙ ЗАЛ.

     Прежние 0.26 / 3.2 подбирались против ровно одной беды: жаровня в полдень
     на открытом поле светила ярче солнца (освещённость 1.9 против 1.74 у
     солнца с небом) и выбивала пятую часть кадра в белое. Лекарством был
     крутой спад и малый множитель — лампа превращалась в горячее ядро без
     лужи света.

     В «Лесопилке» этой беды нет и быть не может: конкурента в виде полуденного
     солнца больше нет, сверху кровля. Зато есть обратное требование — §10.6
     прямо назначает настенные лампы ОСНОВНЫМ светом нижних ярусов, а приёмка
     запрещает «чёрную коробку». С прежними числами замер по настоящей карте
     давал по нижнему ярусу среднюю 85 при рамке кадра 120…160.

     Спад 2.0 при радиусе ~18 м даёт на пяти метрах половину силы, на десяти —
     шестую часть, на четырнадцати — три сотых: соседние лампы по галерее
     смыкаются лужами, но каждая всё равно читается отдельным огнём. (Спад тут —
     показатель степени у линейной рампы pow(1-d/R, decay), это не физическая
     обратная квадратичная: three.js в нефизическом режиме считает именно так.)

     ВАЖНО ПРО КАЛИБРОВКУ. mul откалиброван по фактической расстановке ламп в
     45_map.js: настенный огонь intensity ≈ 1.1…1.4 при distance 17…19, 32 огня
     на зал. Замер по 24 позициям POSTS: средняя кадра 123, темнее 60 — 16.6%,
     светлее 235 — 3.5%. Множитель и сила лампы перемножаются, поэтому если
     карта поменяет силу своих огней, mul надо перемерить — иначе кадр уедет
     за рамку в ту же сторону, в какую поменяли лампы.
     Постоянные огни и разовые вспышки живут на РАЗНЫХ множителях намеренно:
     выбитый на 60 мс кадр от дульной вспышки — это удар выстрела, он нужен;
     постоянно выбитая лампа — брак. */
  mul: 1.50,        // постоянные источники карты
  mulFlash: 1.50,   // разовые вспышки: дуло, взрыв, искра
  decay: 2.0,       // степень спада постоянных
  decayFlash: 2.0,  // у вспышки спад мягче — иначе удар не читается по сцене
  /* Скорость наплыва при переезде лампы на другой источник. Ламп восемь, а
     настенных огней в зале несколько десятков, поэтому переназначения идут
     постоянно — на каждый шаг игрока вдоль галереи. Без наплыва это видно
     как щелчок света в углу кадра. Полсотни миллисекунд хватает, чтобы
     переключение перестало читаться, и мало, чтобы огонь «опаздывал». */
  fadeIn: 22,

  _lamps: [],      // {light, k} — k нужен только для плавного гашения
  _pool: [],       // логические источники (все, включая выключенные)
  _free: [],       // индексы свободных слотов пула
  _top: [], _tsc: [], _tn: 0,
  _frame: 0,

  init(){
    if(this._lamps.length) return;
    for(let i=0;i<this.max;i++){
      const L = new THREE.PointLight(0xffffff, 0, 12, this.decay);
      L.castShadow = false;          // тени от точечных — не наш бюджет
      L.position.set(0, -1000, 0);
      scene.add(L);
      this._lamps.push({ light:L, src:null, fade:0 });
    }
    for(let i=0;i<this.cap;i++){
      this._pool.push({
        idx:i, on:false, lamp:-1, i0:0, cur:0, dist:10, life:0, age:0, prio:0,
        pos:new THREE.Vector3(), col:new THREE.Color(1,1,1), _sel:-1
      });
      this._free.push(i);
    }
    for(let i=0;i<this.max;i++){ this._top.push(null); this._tsc.push(0); }
  },

  /* разовая вспышка: дуло, взрыв, искра руны. life — в секундах */
  flash(pos, color, intensity, distance, life){
    const s = this._alloc(true);
    if(!s) return null;
    s.on = true;
    s.pos.set(pos.x, pos.y, pos.z);   // адрес вызывающего может быть временным вектором
    this._col(s.col, color, 0xffd9a0);
    s.i0 = (intensity===undefined) ? 4 : intensity;
    s.dist = (distance===undefined) ? 16 : distance;
    s.life = (life===undefined) ? 0.08 : life;
    s.age = 0; s.cur = s.i0; s.prio = 2.4; s._sel = -1;
    return s;
  },

  /* постоянный источник: жаровня, кристалл, руна. Возвращённый handle можно
     двигать через handle.pos — это тот же вектор, что читает лампа. */
  addStatic(pos, color, intensity, distance){
    const s = this._alloc(false);
    if(!s) return null;
    s.on = true;
    s.pos.set(pos.x, pos.y, pos.z);
    this._col(s.col, color, 0xffb060);
    s.i0 = (intensity===undefined) ? 2 : intensity;
    s.dist = (distance===undefined) ? 14 : distance;
    s.life = 0; s.age = 0; s.cur = s.i0; s.prio = 0; s._sel = -1;
    return s;
  },
  removeStatic(handle){
    if(handle && handle.on) this._release(handle);
  },
  setStatic(handle, intensity){
    if(!handle || !handle.on) return;
    handle.i0 = intensity;
    if(handle.life <= 0) handle.cur = intensity;
  },

  /* сброс между матчами: вспышки гасим, постоянные огни карты оставляем */
  reset(){
    for(let i=0;i<this._pool.length;i++){
      const s = this._pool[i];
      if(s.on && s.life > 0) this._release(s);
    }
  },

  update(dt, camPos){
    if(!this._lamps.length) this.init();
    const c = camPos || camera.position;
    const cx = c.x, cy = c.y, cz = c.z;
    const F = ++this._frame;
    this._tn = 0;

    for(let i=0;i<this._pool.length;i++){
      const s = this._pool[i];
      if(!s.on) continue;
      if(s.life > 0){
        s.age += dt;
        if(s.age >= s.life){ this._release(s); continue; }
        // резкий пик и быстрый спад: так вспышка выстрела читается как удар,
        // а не как медленно гаснущая лампочка
        const k = 1 - s.age/s.life;
        s.cur = s.i0*k*k;
        s.prio = 2.4*k;               // свежая вспышка важнее старой жаровни
      } else {
        s.cur = s.i0; s.prio = 0;
      }
      if(s.cur <= 0.01) continue;

      const dx = s.pos.x-cx, dy = s.pos.y-cy, dz = s.pos.z-cz;
      const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
      const over = d - s.dist;        // насколько камера снаружи радиуса
      if(over > this.reach) continue; // такой источник в кадре ничего не осветит
      // Эвристика важности: яркость × близость × охват, со штрафом за то, что
      // камера ушла за радиус, и с форой свежей вспышке.
      const sc = s.cur * (1 + 12/(6+d)) * (1 + s.dist*0.015) * (1 + s.prio)
               / (1 + (over>0?over:0)*0.06);
      this._insert(s, sc);
    }

    const T = this._top, n = this._tn;
    for(let i=0;i<n;i++) T[i]._sel = F;

    // освобождаем лампы, чей источник выбыл из топа
    for(let i=0;i<this.max;i++){
      const L = this._lamps[i];
      if(L.src && (!L.src.on || L.src._sel !== F)){ L.src.lamp = -1; L.src = null; }
    }
    // раздаём освободившиеся лампы новым источникам; берём самую тусклую
    // свободную — переключение на ней меньше всего заметно
    for(let i=0;i<n;i++){
      const s = T[i];
      if(s.lamp >= 0) continue;
      let best = -1, bv = Infinity;
      for(let j=0;j<this.max;j++){
        const L = this._lamps[j];
        if(L.src) continue;
        if(L.light.intensity < bv){ bv = L.light.intensity; best = j; }
      }
      if(best < 0) break;
      const L = this._lamps[best];
      L.src = s; s.lamp = best;
      // лампа переехала на другой огонь: гасим и вводим заново, иначе смена
      // позиции читается щелчком. Вспышке наплыв не нужен — она и есть удар.
      L.fade = (s.life > 0) ? 1 : 0;
    }
    // применяем
    for(let i=0;i<this.max;i++){
      const L = this._lamps[i], s = L.src;
      if(s){
        const fl = s.life > 0;
        L.light.position.copy(s.pos);
        L.light.color.copy(s.col);
        L.light.distance = s.dist;
        L.light.decay = fl ? this.decayFlash : this.decay;
        if(L.fade < 1) L.fade = damp(L.fade, 1, this.fadeIn, dt);
        L.light.intensity = s.cur * (fl ? this.mulFlash : this.mul) * L.fade;
      } else if(L.light.intensity > 0){
        // не гасим рывком: лампа могла светить в полную силу
        L.light.intensity = damp(L.light.intensity, 0, 20, dt);
        if(L.light.intensity < 0.02) L.light.intensity = 0;
        L.fade = 0;
      }
    }
  },

  /* ---- внутреннее ---- */
  _col(target, color, def){
    if(typeof color === 'number') target.setHex(color);
    else if(color && color.isColor) target.copy(color);
    else if(typeof color === 'string') target.set(color);
    else target.setHex(def);
  },
  /* forFlash === true — заявка от разовой вспышки: ей отдаются и резервные
     слоты. Постоянному огню карты в резерв заходить нельзя (см. cap/reserve):
     иначе достаточно щедрой расстановки ламп, чтобы у игрока пропала
     дульная вспышка, а это уже не оформление, а обратная связь выстрела. */
  _alloc(forFlash){
    if(!this._pool.length) this.init();
    let s = null;
    if(this._free.length > (forFlash ? 0 : this.reserve)) s = this._pool[this._free.pop()];
    else if(forFlash){
      // пул исчерпан — вытесняем самую слабую вспышку; постоянные огни карты
      // трогать нельзя, иначе жаровни начнут пропадать
      let wv = Infinity;
      for(let i=0;i<this._pool.length;i++){
        const p = this._pool[i];
        if(p.on && p.life > 0 && p.cur < wv){ wv = p.cur; s = p; }
      }
      if(!s) return null;
    }
    // Постоянному огню отказываем молча. Занять чужой слот он не может: и
    // резерв, и вытеснение вспышек — только для самих вспышек, иначе карта
    // рано или поздно съест обратную связь выстрела.
    else return null;
    if(s.lamp >= 0){ this._lamps[s.lamp].src = null; s.lamp = -1; }
    return s;
  },
  _release(s){
    if(s.lamp >= 0){ this._lamps[s.lamp].src = null; s.lamp = -1; }
    if(s.on){
      s.on = false; s.cur = 0; s._sel = -1;
      this._free.push(s.idx);
    }
  },
  // вставка в отсортированный по убыванию топ длиной max, без аллокаций
  _insert(s, sc){
    const T = this._top, S = this._tsc;
    let n = this._tn;
    if(n < this.max){
      let i = n++;
      while(i > 0 && S[i-1] < sc){ T[i] = T[i-1]; S[i] = S[i-1]; i--; }
      T[i] = s; S[i] = sc; this._tn = n;
    } else if(sc > S[n-1]){
      let i = n-1;
      while(i > 0 && S[i-1] < sc){ T[i] = T[i-1]; S[i] = S[i-1]; i--; }
      T[i] = s; S[i] = sc;
    }
  }
};

/* --------------------------- МАТЕРИАЛЫ (тун) --------------------------- */
/* Ступени тона. MeshToonMaterial берёт из этой картинки множитель освещённости
   по dot(N,L): текселю i соответствует dot из [-1+i/2, -0.5+i/2], то есть
   граница между вторым и третьим текселем — это и есть терминатор.

   Было ['#606068','#9c9a96','#d6d3ca','#ffffff'] = 0.38 / 0.61 / 0.84 / 1.0.
   Нижняя ступень 0.38 значила, что грань, ОТВЕРНУТАЯ от солнца, всё равно
   получает 38% его яркости — и это на КАЖДЫЙ источник. Три источника, и
   неосвещённая сторона выходила светлее, чем освещённая сторона тёмного
   материала. Отсюда и ощущение, что объём пропал.

   Было 0.18 / 0.34 / 0.68 / 1.0 (нижние две ступени уведены в холод — тени под
   тёплым солнцем обязаны быть синеватыми, это и даёт «нарисованность»).

   ПЕРЕСМОТР ПОД ЗАКРЫТЫЙ ЗАЛ. 0.18 на нижней ступени сочинялось для открытого
   поля, где отвернувшаяся от солнца грань всё равно тонет в свете неба со всех
   сторон. В помещении неба нет: изнанка кровли и нижние плоскости настилов не
   получают НИЧЕГО, кроме этой ступени, и замер показал результат — 16 из 255,
   то есть чёрная дыра в половину кадра на верхнем ярусе. Приёмка это прямо и
   запрещает: «интерьер не должен стать чёрной коробкой».

   Стало 0.27 / 0.42 / 0.70 / 1.0. Это не «поднять всё»: верхние две ступени
   почти не тронуты, поднято только дно. Терминатор остался читаемым скачком
   (0.42 -> 0.70), а отвернувшаяся грань перестала пропадать. Замер: изнанка
   кровли выросла с 16 до 40, средняя верхнего яруса — с 81 до 100+.
   Полусфера сюда не входит: HemisphereLight в three.js идёт мимо gradientMap,
   прямо в indirectDiffuse. Через эту таблицу проходят только солнце и две
   контровых — то есть ровно те источники, у которых есть направление. */
function gradientMap(){
  const c = document.createElement('canvas'); c.width=4; c.height=1;
  const x = c.getContext('2d');
  const steps = ['#42495a','#696b6e','#b3b0a6','#ffffff'];
  steps.forEach((s,i)=>{ x.fillStyle=s; x.fillRect(i,0,1,1); });
  const t = new THREE.CanvasTexture(c);
  t.minFilter = THREE.NearestFilter; t.magFilter = THREE.NearestFilter; t.generateMipmaps = false;
  return t;
}
let GRAD = null;
const MATCACHE = new Map();
// Ступени тона создаются лениво: материал могут попросить раньше, чем boot()
// доберётся до присваивания GRAD, и тогда вся карта соберётся без градиента.
function toonGrad(){ return GRAD || (GRAD = gradientMap()); }
function toon(color, opts){
  const key = color+'|'+JSON.stringify(opts||{});
  if(MATCACHE.has(key)) return MATCACHE.get(key);
  const m = new THREE.MeshToonMaterial(Object.assign({ color, gradientMap:toonGrad() }, opts||{}));
  MATCACHE.set(key,m); return m;
}
function basic(color,opts){ return new THREE.MeshBasicMaterial(Object.assign({color},opts||{})); }

function sprTex(inner, outer){
  const c = document.createElement('canvas'); c.width=c.height=64;
  const g = c.getContext('2d').createRadialGradient(32,32,0,32,32,32);
  g.addColorStop(0, inner); g.addColorStop(0.45, outer); g.addColorStop(1,'rgba(0,0,0,0)');
  const x = c.getContext('2d'); x.fillStyle=g; x.fillRect(0,0,64,64);
  return new THREE.CanvasTexture(c);
}
let TEX_GLOW, TEX_FIRE, TEX_SMOKE;
