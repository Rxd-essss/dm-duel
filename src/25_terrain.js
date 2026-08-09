/* =====================================================================
   ЛАНДШАФТ · НЕБО · АТМОСФЕРА
   «ЛЕСОПИЛКА» (MAPDESIGN §10) — карта закрытая. Игрок весь матч находится
   ВНУТРИ деревянного зала 44×130×22, и наружного пейзажа у него нет: небо
   он видит только в проёмах под крышей. Поэтому здешние обязанности другие,
   чем у прежней долины:
     * пол зала — строго плоская земля, на неё встаёт вся конструкция;
     * атмосфера — не горы с зарёй, а дневные лучи в пыли и тёплые лампы;
     * небо — дешёвое, но красивое: его видно в щель, и оно даёт понять,
       что снаружи полдень.
   Читаемость по-прежнему главнее настроения: силуэт на 100 м обязан
   отличаться от фона, и ради этого здесь заведена дымка глубины (§ ТУМАН).
   ===================================================================== */

/* ------------------------------ ПОЛ ЗАЛА ------------------------------ */
/* Внутри зала рельефа быть не должно. Причина не в эстетике: по gh(x,z)
   встают колонна, галереи яруса 1, рампы и штабеля, и уже перепад в полметра
   ставит соседние опоры вкось — доска ложится винтом, рампа не сходится с
   настилом. Поэтому внутри прямоугольника terrainH возвращает КОНСТАНТУ и
   выходит раньше всех волн, форм и площадок. Побочный выигрыш крупный:
   самая горячая зона карты (пули, лучи видимости, шаги ботов) считается
   теперь в четыре операции вместо полутора десятков с двенадцатью формами.

   Отметка пола ровно 0: ярусы CFG.floor1..floor3 (6/12/18) заданы абсолютными
   числами и проверяются mapcheck'ом как абсолютные, значит земля обязана
   лежать на нуле, иначе весь зал уедет относительно допуска floorTol.

   Снаружи зала рельеф остаётся прежним, но между ним и полом лежит апрон:
   без него на кромке встал бы отвесный уступ, а его видно в проёме. */
const TER_HX  = 27;    // полуширина плоского пола; стены зала — при |x| = 22
const TER_HZ  = 71;    // полудлина плоского пола;  торцы зала — при |z| = 65
const TER_HAP = 13;    // ширина апрона, на которой земля возвращается к рельефу
const TER_HY  = 0;     // отметка земляного пола зала

/* Прямоугольная «дистанция» до зала: <=0 внутри, метры наружу.
   Чебышёвская, а не евклидова, — зал прямоугольный, и по ней кромка апрона
   идёт ровной рамкой, а не скруглённой линзой. */
function TER_out(x,z){
  const ox = (x<0?-x:x) - TER_HX, oz = (z<0?-z:z) - TER_HZ;
  return ox > oz ? ox : oz;
}

/* ------------------------------ ЛАНДШАФТ ------------------------------ */
/* Опорные площадки. Три прежние (базы z=±64 и центральное плато) исчезли не
   по вкусу, а потому что их целиком съел пол зала: они лежали внутри
   прямоугольника и до них дело больше не доходит. Остались только те, что
   работают СНАРУЖИ — они держат землю вокруг зала ровной, чтобы в проёме
   под крышей не торчал случайный горб выше кровли. */
const FLATS = [
  {x:-50, z:  0, r:13, R:25, h:1.4},
  {x: 50, z:  0, r:13, R:25, h:1.4},
  {x: 72, z:-34, r: 8, R:17, h:4.4},
  {x:-72, z: 34, r: 8, R:17, h:4.4}
];
// квадраты радиусов считаем один раз: в terrainH это позволяет отбросить
// дальнюю площадку без вызова sqrt, а зовут её из горячего цикла
for(let i=0;i<FLATS.length;i++){ FLATS[i].r2 = FLATS[i].r*FLATS[i].r; FLATS[i].R2 = FLATS[i].R*FLATS[i].R; }

/* Гребни, промоины и пандусы. Запись: [cx, cz, полудлина, полуширина,
   поворот длинной оси в градусах, амплитуда]. Профиль (1-q)^2 — без корней
   и тригонометрии, потому что terrainH дёргают пули, боты и лучи видимости.
   Всё расставлено симметрично относительно поворота на 180°: у BLU и RED
   должен быть одинаковый рельеф. */
const TER_SHAPES = [
  // диагональные промоины база↔двор: укрытый маршрут обхода в каждом квадранте
  [-34.00,-32.00, 19.0, 6.2, 130.6, -1.7],
  [ 34.00, 32.00, 19.0, 6.2, 130.6, -1.7],
  [ 34.00,-32.00, 19.0, 6.2,  49.4, -1.7],
  [-34.00, 32.00, 19.0, 6.2,  49.4, -1.7],
  // гребень вдоль каждой промоины со стороны центра — он и делает её укрытием:
  // из бункера на плато дно лощины не простреливается. Центр гребня смещён на
  // 9.5 м по нормали к оси промоины, к середине карты.
  [-26.79,-25.82, 17.0, 5.4, 130.6,  1.9],
  [ 26.79, 25.82, 17.0, 5.4, 130.6,  1.9],
  [ 26.79,-25.82, 17.0, 5.4,  49.4,  1.9],
  [-26.79, 25.82, 17.0, 5.4,  49.4,  1.9],
  // пологие подъёмы к плато с четырёх сторон: на плато забегают, а не карабкаются
  [  0.0,-24.0, 12.0, 8.5,  90.0,  1.9],
  [  0.0, 24.0, 12.0, 8.5,  90.0,  1.9],
  [-24.0,  0.0, 12.0, 8.5,   0.0,  1.9],
  [ 24.0,  0.0, 12.0, 8.5,   0.0,  1.9]
];
// плоский Float64Array вместо массива объектов: горячий цикл не любит
// разыменование полей. 8 чисел на форму, последнее — квадрат габарита.
const TER_F = new Float64Array(TER_SHAPES.length*8);
for(let i=0;i<TER_SHAPES.length;i++){
  const s = TER_SHAPES[i], a = s[4]*Math.PI/180, o = i*8;
  TER_F[o  ] = s[0];        TER_F[o+1] = s[1];
  TER_F[o+2] = 1/s[2];      TER_F[o+3] = 1/s[3];
  TER_F[o+4] = Math.cos(a); TER_F[o+5] = Math.sin(a);
  TER_F[o+6] = s[5];        TER_F[o+7] = s[2]*s[2];
}

const TER_SIZE = 200;   // сторона плоскости: барьер за CFG.half=88 успевает
                        // встать скальным обрывом, а горизонт остаётся низким
                        // и за ним читаются дальние планы гор
/* ПРАВКА ПО ЖАЛОБЕ «сильно стало лагать». 120 → 56, то есть 6.3 тыс.
   треугольников вместо 28.8 тыс. Ландшафт оставался самым тяжёлым мешем кадра
   (больше половины всех треугольников кадра), и при этом из закрытого зала его
   почти не видно: пол цеха — это отдельная плита карты, лежащая поверх, а всё,
   что снаружи, закрыто стенами. Подробность сетки нужна была апрону — полосе
   рельефа по кромке; при 56 сегментах ячейка 3.6 м, апрон в 13 м всё ещё
   держит четыре ячейки и кромку не ломает.
   ВАЖНО: terrainH() считается аналитически и от TER_SEG не зависит — физика,
   пули и шаги ботов правку не замечают вовсе. */
const TER_SEG  = 56;    // 3.6 м на ячейку. Было 150 под открытую долину, где
                        // каждый гребень читался с полукарты. Теперь 92% видимой
                        // земли — плоский пол зала, которому подробность сетки
                        // не нужна вовсе, а рельеф остался только в апроне
                        // (13 м = 8 ячеек, этого хватает на плавную кромку) и
                        // за стенами, куда игрок не попадает. 28.8 тыс.
                        // треугольников вместо 45 тыс. на самой тяжёлой
                        // геометрии кадра — она же единственная с receiveShadow
                        // и тремя выборками текстур.

function terrainH(x,z){
  /* Пол зала. Проверка стоит ПЕРВОЙ и выходит сразу: внутри зала идёт весь
     бой, и здесь terrainH зовут пули, лучи видимости и шаги ботов. */
  const od = TER_out(x,z);
  if(od <= 0) return TER_HY;

  /* Основа — четыре косинусные волны без фазы. Такая сумма строго чётна
     относительно поворота на 180°: h(x,z) === h(-x,-z). Дуэль обязана быть
     честной, у обеих баз одинаковый подход. Знаки чередуются, иначе все
     волны сложились бы горбом ровно в центре карты. */
  let h = 1.45*Math.cos(x*0.0245 + z*0.0196)
        - 1.10*Math.cos(x*0.0160 - z*0.0300)
        + 0.58*Math.cos(x*0.0560 + z*0.0450)
        + 0.30*Math.cos(x*0.1020 - z*0.0820)
        + 3.00;
  const F = TER_F;
  for(let i=0;i<F.length;i+=8){
    const dx = x-F[i], dz = z-F[i+1];
    const d2 = dx*dx + dz*dz;
    if(d2 >= F[i+7]) continue;                 // грубая отсечка по габариту
    const u = (dx*F[i+4] + dz*F[i+5])*F[i+2];
    const v = (dz*F[i+4] - dx*F[i+5])*F[i+3];
    const q = u*u + v*v;
    if(q < 1){ const w = 1-q; h += F[i+6]*w*w; }
  }
  for(let i=0;i<FLATS.length;i++){
    const f = FLATS[i], dx = x-f.x, dz = z-f.z, d2 = dx*dx + dz*dz;
    if(d2 >= f.R2) continue;
    const w = d2 <= f.r2 ? 1 : 1 - smoothstep(f.r, f.R, Math.sqrt(d2));
    h += (f.h - h)*w;
  }
  // барьер: за границей зоны рельеф уходит в скалу отвесно
  const d = Math.abs(x) > Math.abs(z) ? Math.abs(x) : Math.abs(z);
  if(d > CFG.half){ const t = (d-CFG.half)/18; h += t*t*70; }
  // апрон: у самой кромки зала земля обязана совпасть с полом до сантиметра,
  // иначе снаружи в проёме виден уступ, а внутри — щель под стеной
  if(od < TER_HAP) h += (TER_HY - h)*(1 - smoothstep(0, TER_HAP, od));
  return h;
}
function terrainN(x,z,out){
  const e=0.6;
  const hx = terrainH(x+e,z)-terrainH(x-e,z);
  const hz = terrainH(x,z+e)-terrainH(x,z-e);
  return (out||new THREE.Vector3()).set(-hx, 2*e, -hz).normalize();
}

/* Средний цвет процедурной карты. Нужен, чтобы использовать текстуру как
   ЗЕРНО поверх вершинных цветов: делим тексель на среднее — и остаётся
   только рельеф рисунка, без сдвига тона и яркости. Иначе зелёная трава
   перекрасила бы скалы, а общая картинка потемнела бы вдвое. */
function TER_mean(tex, def){
  const v = new THREE.Vector3(def,def,def);
  if(!tex || !tex.image) return v;
  try{
    const S = 16;
    const c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    g.drawImage(tex.image, 0, 0, S, S);
    const d = g.getImageData(0,0,S,S).data;
    let r=0,gg=0,b=0;
    for(let i=0;i<d.length;i+=4){ r+=d[i]; gg+=d[i+1]; b+=d[i+2]; }
    const n = (d.length/4)*255;
    v.set(Math.max(r/n,0.05), Math.max(gg/n,0.05), Math.max(b/n,0.05));
  }catch(e){}
  return v;
}

/* Материал земли: вершинные цвета задают тон (трава/грязь/песок/камень),
   три процедурные карты дают зерно. Смешиваются они не по экрану, а по
   вершинному весу aSplat — то есть ровно по той же логике высоты и уклона,
   что и цвет. Один меш, один проход, три выборки текстуры. */
function TER_groundMat(){
  const m = new THREE.MeshLambertMaterial({ vertexColors:true });
  if(typeof TEX === 'undefined' || !TEX || typeof TEX.get !== 'function') return m;
  const rep = TER_SIZE/5;                       // трава: плитка ~5 м
  const tG = TEX.get('grass', rep, rep);
  const tD = TEX.get('dirt', 1, 1);             // масштаб задаём в шейдере,
  const tS = TEX.get('stone', 1, 1);            // repeat здесь роли не играет
  if(!tG || !tD || !tS) return m;
  // анизотропия земле нужнее, чем кому-либо: снайпер смотрит на неё под
  // скользящим углом и с 22-кратным приближением
  const aniso = Math.min(8, renderer ? renderer.capabilities.getMaxAnisotropy() : 1);
  [tG,tD,tS].forEach(t=>{ if(t.anisotropy < aniso){ t.anisotropy = aniso; t.needsUpdate = true; } });
  m.map = tG;
  const mG = TER_mean(tG,0.5), mD = TER_mean(tD,0.5), mS = TER_mean(tS,0.5);
  m.onBeforeCompile = function(sh){
    // тот же вертикальный градиент непрямого света, что у всех тун-материалов
    // (20_render.js): без него пол зала оказался бы единственной поверхностью
    // с полной полусферой, и по кромке стены пошёл бы шов
    if(typeof RND_ambRamp === 'function') RND_ambRamp(sh);
    sh.uniforms.uMapD  = { value:tD };
    sh.uniforms.uMapS  = { value:tS };
    sh.uniforms.uMeanG = { value:mG };
    sh.uniforms.uMeanD = { value:mD };
    sh.uniforms.uMeanS = { value:mS };
    sh.vertexShader = 'attribute vec3 aSplat;\nvarying vec3 vSplat;\n' +
      sh.vertexShader.replace('#include <begin_vertex>', 'vSplat = aSplat;\n#include <begin_vertex>');
    sh.fragmentShader =
      'uniform sampler2D uMapD;\nuniform sampler2D uMapS;\n' +
      'uniform vec3 uMeanG;\nuniform vec3 uMeanD;\nuniform vec3 uMeanS;\nvarying vec3 vSplat;\n' +
      sh.fragmentShader.replace('#include <map_fragment>', [
        // Трава кроет большую часть поля, и одна плитка на 5 м складывается на
        // открытом месте в отчётливую клетку. Вторая выборка той же карты на
        // втором масштабе (плитка ~17 м) ломает период — сетка исчезает,
        // зерно остаётся.
        '  vec3 dG = texture2D( map, vUv ).rgb / uMeanG;',
        '  dG *= mix( vec3(1.0), texture2D( map, vUv*0.29 + 0.37 ).rgb / uMeanG, 0.55 );',
        '  vec3 dD = texture2D( uMapD, vUv*0.62 ).rgb / uMeanD;',
        '  vec3 dS = texture2D( uMapS, vUv*1.70 ).rgb / uMeanS;',
        '  vec3 det = clamp( dG*vSplat.x + dD*vSplat.y + dS*vSplat.z, 0.38, 1.80 );',
        '  diffuseColor.rgb *= mix( vec3(1.0), det, 0.85 );'
      ].join('\n'));
  };
  return m;
}

function buildTerrain(){
  const geo = new THREE.PlaneGeometry(TER_SIZE, TER_SIZE, TER_SEG, TER_SEG);
  geo.rotateX(-Math.PI/2);
  const pos = geo.attributes.position;
  // работаем с типизированными массивами напрямую: 23 тыс. вершин × десяток
  // вызовов аксессора — это лишние сотни миллисекунд загрузки
  const pa = pos.array;
  for(let i=0, n=pos.count*3; i<n; i+=3) pa[i+1] = terrainH(pa[i], pa[i+2]);
  geo.computeVertexNormals();
  const na = geo.attributes.normal.array;

  const col = new Float32Array(pos.count*3);
  const spl = new Float32Array(pos.count*3);
  const cGrass = new THREE.Color(PAL.grass), cDirt = new THREE.Color(PAL.dirt),
        cRock  = new THREE.Color(PAL.rock),  cSand = new THREE.Color(PAL.sand),
        cMoss  = new THREE.Color(0x5f7139);
  const tmp = new THREE.Color();
  const ST = TER_SEG+1, K = 2;   // сосед через 2 ячейки ≈ 2.7 м: ячейка выросла,
                                 // и K пришлось уменьшить — кривизну надо мерить на
                                 // том же масштабе, иначе лощины перекрасятся

  for(let iy=0; iy<ST; iy++){
    for(let ix=0; ix<ST; ix++){
      const i = iy*ST + ix, i3 = i*3;
      const x = pa[i3], y = pa[i3+1], z = pa[i3+2];
      /* Кривизна прямо по сетке: соседей мы уже посчитали, повторно звать
         terrainH незачем. Положительная — вогнутость (дно лощины): там
         темнее, влажнее и гуще трава. Это то, что читает лощину как лощину. */
      const avg = ( pa[(ix>=K   ? i-K    : i)*3+1] + pa[(ix<ST-K ? i+K    : i)*3+1]
                  + pa[(iy>=K   ? i-K*ST : i)*3+1] + pa[(iy<ST-K ? i+K*ST : i)*3+1] )*0.25;
      const cv  = clamp((avg-y)*0.5, -0.55, 0.95);
      const cvp = cv > 0 ? cv : 0;

      /* Пороги уклона подобраны под реальный рельеф: в игровой зоне градиент
         не превышает ~0.7 (35°), поэтому «камень» начинается уже с 0.06 —
         иначе скалой был бы только барьер, а борта промоин остались бы
         зелёными и нечитаемыми. */
      const slope = 1 - na[i3+1];
      // крупные пятна выгоревшей и сырой земли — чтобы поле не было однотонным
      const patch = 0.5 + 0.5*Math.sin(x*0.048 + Math.cos(z*0.037)*1.9);
      const dry   = clamp(smoothstep(2.2, 6.6, y)*(0.55 + patch*0.6) - cvp*0.6, 0, 1);
      const stony = smoothstep(0.06, 0.20, slope);
      const sandy = smoothstep(0.04, 0.14, slope)*0.42*(0.25 + dry*1.0);

      tmp.copy(cGrass).lerp(cMoss, cvp*0.65);
      tmp.lerp(cDirt, dry);
      tmp.lerp(cSand, sandy);
      tmp.lerp(cRock, stony);
      /* Общий множитель 0.62 — калибровка под свет 20_render.js: суммарная
         освещённость горизонтальной грани там около 1.6, и без этого деления
         трава выбилась бы в кислотный лайм вместо оливкового PAL.grass.
         (Карты 22_tex.js темнят материалы примерно вдвое, под это и подняты
         солнце с полусферой; наше зерно нормировано по среднему и не темнит,
         поэтому компенсируем здесь.)
         Множитель bounce возвращает свет отвесным граням: солнце стоит высоко,
         вертикальную скалу оно почти не задевает, и барьер без этой добавки
         читается чёрной дырой на горизонте. */
      const bounce = 1 + stony*0.55;
      /* Три волны под разными углами, а не произведение синусов: произведение
         даёт правильную клетку, и на открытом поле она бросается в глаза
         сильнее любой текстуры. */
      const nv = 0.055*Math.sin(x*0.29 + z*0.13)
               + 0.045*Math.sin(z*0.31 - x*0.17)
               + 0.035*Math.sin(x*0.11 - z*0.47);
      const n = (0.62 + nv - cvp*0.12)*bounce;
      let cr = tmp.r*n, cg = tmp.g*n, cb = tmp.b*n;

      // веса зерна: круто — камень, сухо и осыпь — грязь, остальное — трава
      const ws = stony;
      const wd = (1-ws)*clamp(dry*0.85 + sandy*0.75, 0, 1);
      let sg = 1-ws-wd, sd = wd, ss = ws;

      /* ---- земляной пол зала ----
         Внутри зала трава и камень не имеют смысла: это утоптанная земля
         под крышей. Красим её отдельно и по трём соображениям.
         1. ТОН. Пол — ярус 0, и по MAPDESIGN §6 он обязан быть самым тёмным
            и самым тёплым: игрок должен понимать высоту по яркости. Тёмный,
            но не чёрный — по нему бегают и в него стреляют.
         2. ПЯТНА. Плоскость без вариаций читается линолеумом, поэтому по полу
            идут крупные пятна опилок и сырой земли — крупнее бойца, чтобы на
            100 м они не спорили с силуэтом (то же правило, что у травы).
         3. ПРИТЕНЕНИЕ У СТЕН. Полоса в 7 м вдоль стены темнеет: свет ламп
            туда почти не достаёт, а запечённая в вершины тень — единственное,
            что тут стоит ноль в кадре и при этом сажает зал на землю. */
      const wall = TER_out(x,z);            // <=0 внутри, отрицательное — глубина
      if(wall < TER_HAP){
        const inH = wall <= 0 ? 1 : 1 - smoothstep(0, TER_HAP, wall);
        // опилки: две волны разного масштаба, обе крупнее человека
        const saw = 0.5 + 0.5*Math.sin(x*0.085 + Math.cos(z*0.052)*2.1);
        const wet = 0.5 + 0.5*Math.sin(z*0.041 - x*0.031 + 1.7);
        /* Притенение у стен. Кромка пола лежит на 5 м дальше стены, поэтому
           «у стены» — это wall ≈ -5, а через 8 м вглубь зала тень сходит. */
        const edge = 1 - 0.45*clamp((wall + 13)/8, 0, 1);
        /* Три числа ниже — итог двух замеров, а не вкус.
           УРОВЕНЬ. Первый заход дал 0.60/0.48/0.35, и пол вышел кремовым: в
           освещённых пятнах за 200 из 255, светлее дощатых стен. Земляной пол
           под крышей так выглядеть не может, а приёмка требует обратного:
           «нижний ярус тёмный, но проходимый». После снижения в полтора раза
           замер по настилу под ногами даёт 93 против 190 на галерее яруса 1 —
           низ читается низом.
           ТЕПЛОТА. Соотношение каналов приходится брать теплее, чем выглядит
           земля: пол смотрит нормалью вверх и получает небесную, холодную
           половину полусферы (0xbcd8f6 при 1.8), а она сама синит в полтора
           раза. С «честным» коричневым 0.40/0.31/0.22 пол рисовался серым
           бетоном; 0.46/0.30/0.17 после умножения на этот свет даёт тёплый
           суглинок при той же яркости. */
        /* ПЕРЕСМОТР. Числа подняты (0.46/0.30/0.17 -> 0.58/0.39/0.23) под
           новую тон-кривую (20_render.js): она сжимает верх и приподнимает
           середину, и на прежнем альбедо апрон у кромки зала уходил в грязь.
           Оговорка: это земля СНАРУЖИ и под апроном. Сам пол зала — отдельная
           плита с картой 'dirt' (45_map.js), её уровень держится в 22_tex.js. */
        const lv = (0.62 + 0.30*saw - 0.16*wet)*edge;
        cr = lerp(cr, 0.58*lv, inH);
        cg = lerp(cg, 0.39*lv, inH);
        cb = lerp(cb, 0.23*lv, inH);
        sg = lerp(sg, 0, inH); sd = lerp(sd, 1, inH); ss = lerp(ss, 0, inH);
      }

      col[i3] = cr; col[i3+1] = cg; col[i3+2] = cb;
      spl[i3] = sg; spl[i3+1] = sd; spl[i3+2] = ss;
    }
  }
  geo.setAttribute('color',  new THREE.BufferAttribute(col,3));
  geo.setAttribute('aSplat', new THREE.BufferAttribute(spl,3));

  const mesh = new THREE.Mesh(geo, TER_groundMat());
  mesh.receiveShadow = true;    // тень бросают пропы, сама земля — нет
  world.add(mesh);
}

/* ------------------------------ НЕБО ------------------------------ */
/* Слияние геометрий вручную: BufferGeometryUtils в ядре r128 нет, а восемь
   десятков отдельных конусов — это восемь десятков вызовов отрисовки на
   каждый кадр ради статичного задника. */
function TER_merge(geos){
  const list = [];
  let vc = 0;
  for(let i=0;i<geos.length;i++){
    const g = geos[i].index ? geos[i].toNonIndexed() : geos[i];
    list.push(g); vc += g.attributes.position.count;
  }
  const P = new Float32Array(vc*3), N = new Float32Array(vc*3);
  let o = 0;
  for(let i=0;i<list.length;i++){
    const g = list[i];
    P.set(g.attributes.position.array, o*3);
    if(g.attributes.normal) N.set(g.attributes.normal.array, o*3);
    o += g.attributes.position.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(P,3));
  out.setAttribute('normal',   new THREE.BufferAttribute(N,3));
  return out;
}

const TER_SUN = new THREE.Vector3(60,90,40).normalize();

/* Дневное небо. Видно его только в проёмах под крышей и в световых щелях,
   поэтому дорогого неба тут быть не должно — но то, что видно, обязано
   читаться как полдень снаружи, иначе лучи света непонятно откуда берутся.

   Купол аналитический: он рисуется ПЕРВЫМ и покрывает весь кадр (глубину он
   не пишет), то есть его шейдер платится за каждый пиксель экрана. Поэтому
   никакого процедурного шума в нём нет — только градиент и ореол солнца, а
   облака сделаны геометрией: она растеризуется ровно там, где облака есть. */
function TER_makeSkyDome(){
  const mat = new THREE.ShaderMaterial({
    uniforms:{
      /* Небо подсвечено у горизонта сильнее прежнего (0xd2e2ec -> 0xeaf3fb).
         Это не «сделать красивее»: купол — единственная поверхность кадра,
         которая НЕ проходит через тонмаппинг, то есть её яркость попадает на
         экран как есть. В закрытом зале небо видно только в подкровельном
         поясе и в щелях, и именно оно обязано быть самым ярким пятном —
         иначе приёмочная доля пикселей ярче 235 брать её неоткуда. Полоса
         узкая, поэтому доля остаётся в рамке 0.5…4%. */
      cTop :{value:new THREE.Color(0x4a86cb)},
      cMid :{value:new THREE.Color(0xa4c9ea)},
      cHaze:{value:new THREE.Color(0xeaf3fb)},
      cBot :{value:new THREE.Color(0xf4ecd8)},
      cSun :{value:new THREE.Color(0xfff2cc)},
      uSun :{value:TER_SUN}
    },
    vertexShader: [
      'varying vec3 vP;',
      'void main(){ vP = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }'
    ].join('\n'),
    fragmentShader: [
      'varying vec3 vP;',
      'uniform vec3 cTop; uniform vec3 cMid; uniform vec3 cHaze; uniform vec3 cBot;',
      'uniform vec3 cSun; uniform vec3 uSun;',
      'void main(){',
      '  vec3 dir = normalize(vP);',
      '  float h = dir.y;',
      '  vec3 c;',
      '  if(h > 0.0){',
      '    c = mix(cHaze, cMid, clamp(pow(h/0.30, 0.7), 0.0, 1.0));',
      '    c = mix(c, cTop, clamp((h-0.26)/0.74, 0.0, 1.0));',
      '  } else {',
      '    c = mix(cHaze, cBot, clamp(-h/0.14, 0.0, 1.0));',
      '  }',
      // солнце нарисовано, а не светит: ореол даёт направление света в кадре
      '  float s = max(dot(dir, uSun), 0.0);',
      '  c += cSun*(pow(s, 46.0)*0.62 + pow(s, 5.0)*0.15);',
      // дизер: без него на таком пологом градиенте видны полосы
      '  c += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898,78.233)))*43758.5453) - 0.5)*0.008;',
      '  gl_FragColor = vec4(c, 1.0);',
      '}'
    ].join('\n'),
    side:THREE.BackSide, depthWrite:false, fog:false
  });
  skyMesh = new THREE.Mesh(new THREE.SphereGeometry(600,32,20), mat);
  skyMesh.renderOrder = -10;     // купол первым: глубину он всё равно не пишет
  scene.add(skyMesh);
}

/* Одна дальняя гряда. Раньше их было три, и они честно работали на долину;
   в закрытом зале горизонта нет вовсе, и платить за три плана нечем. Одна
   остаётся страховкой: если карта где-то откроется наружу (дверной проём,
   пролом в торце), кадр не должен упереться в голую землю и пустой купол.
   Материал basic: гряда не реагирует на свет, её объём запечён в вершины. */
function TER_ridgeRing(count, rMin, rMax, hMin, hMax, wMin, wMax, colLo, colHi){
  const geos = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(),
        e  = new THREE.Euler(), p = new THREE.Vector3(), sc = new THREE.Vector3();
  for(let i=0;i<count;i++){
    const a = (i + rnd(-0.34,0.34))/count*Math.PI*2;
    const r = rnd(rMin,rMax), h = rnd(hMin,hMax), w = rnd(wMin,wMax);
    const g = new THREE.ConeGeometry(w, h, rint(5,7), 1);
    e.set(0, rnd(0,6.283), rnd(-0.07,0.07)); q.setFromEuler(e);
    p.set(Math.cos(a)*r, h*0.42, Math.sin(a)*r);   // основание чуть утоплено
    sc.set(1, 1, rnd(0.7,1.4));
    m4.compose(p,q,sc);
    g.applyMatrix4(m4);
    geos.push(g);
  }
  const geo = TER_merge(geos);
  const P = geo.attributes.position, N = geo.attributes.normal;
  const C = new Float32Array(P.count*3);
  const lo = new THREE.Color(colLo), hi = new THREE.Color(colHi), t = new THREE.Color();
  for(let i=0;i<P.count;i++){
    t.copy(lo).lerp(hi, smoothstep(hMin*0.30, hMax*0.90, P.getY(i)));
    const d = N.getX(i)*TER_SUN.x + N.getY(i)*TER_SUN.y + N.getZ(i)*TER_SUN.z;
    const k = 0.80 + 0.32*(d>0?d:0);
    C[i*3] = t.r*k; C[i*3+1] = t.g*k; C[i*3+2] = t.b*k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(C,3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({vertexColors:true}));
  mesh.frustumCulled = false;   // кольцо всегда частью в кадре, проверка зря
  scene.add(mesh);
  return mesh;
}
function TER_makeMountains(){
  TER_ridgeRing(22, 330, 400, 150, 235, 60, 115, 0x87a0b4, 0xc4d8e4);
}

/* Облака. Раньше они висели кольцом у горизонта на 105…205 м — ровно там,
   где их теперь не видно вовсе: из зала небо доступно взгляду только вверх,
   через щели под крышей. Поэтому облачная гряда переехала НАД картой и
   раздалась вширь: смотришь в проём — видишь плывущее небо, а не пустую синь.
   Тон берём от нормали, но подбрюшье теперь не серо-синее, а тёплое: снизу
   освещённое облако отражает землю, и холодная изнанка читалась бы грозой.
   Всё кольцо — один меш, он же лениво вращается, изображая снос. */
function TER_makeClouds(){
  const geos = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(),
        p = new THREE.Vector3(), sc = new THREE.Vector3();
  /* ПРАВКА ПО ЖАЛОБЕ «сильно стало лагать». Облаков было 22 кучи по 4–7 шаров
     с сеткой 9 × 6 — 9.9 тыс. треугольников, и все они рисовались КАЖДЫЙ кадр:
     у меша стоял frustumCulled = false, потому что он ездит за камерой.
     Из закрытого зала небо видно только полоской под кровлей, и разглядеть
     там отдельный шар невозможно. Куч меньше, шары грубее — 2.2 тыс.
     треугольников вместо 9.9 тыс. при том же силуэте на полоске неба. */
  for(let i=0;i<13;i++){
    const a = rnd(0,Math.PI*2), r = rnd(30,300), y = rnd(215,330);
    const cx = Math.cos(a)*r, cz = Math.sin(a)*r;
    const n = rint(3,5);
    for(let j=0;j<n;j++){
      const s = rnd(18,44);
      const g = new THREE.SphereGeometry(s, 7, 4);
      p.set(cx + rnd(-46,46), y + rnd(-6,10), cz + rnd(-46,46));
      sc.set(1, rnd(0.30,0.48), 1);
      m4.compose(p,q,sc);
      g.applyMatrix4(m4);
      geos.push(g);
    }
  }
  const geo = TER_merge(geos);
  const P = geo.attributes.position, N = geo.attributes.normal;
  const C = new Float32Array(P.count*3);
  const lo = new THREE.Color(0xb4aca0), hi = new THREE.Color(0xf4ecdc), t = new THREE.Color();
  for(let i=0;i<P.count;i++){
    t.copy(lo).lerp(hi, smoothstep(0.05, 0.85, N.getY(i)*0.5+0.5));
    C[i*3] = t.r; C[i*3+1] = t.g; C[i*3+2] = t.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(C,3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({vertexColors:true, fog:false}));
  mesh.frustumCulled = false;
  mesh.onBeforeRender = function(){ mesh.rotation.y = performance.now()*0.0000045; };
  scene.add(mesh);
}

/* ------------------ ДНЕВНЫЕ ЛУЧИ: УДАЛЕНЫ ПО ТРЕБОВАНИЮ ЗАКАЗЧИКА ------------------
   Здесь стояла TER_makeShafts() — 29 наклонных конусов из подкровельных проёмов
   плюс широкие нимбы вокруг срединных. Заказчик забраковал их дважды подряд:
   «какие то стрёмные лучи из неоткуда падают вниз», «лучше вообще лучи убери».

   Правки помогали ненадолго, и теперь понятно почему: у объёмного луча в
   закрытом зале нет источника, который игрок видит. Снаружи луч читается,
   потому что видно окно и солнце; здесь проём под кровлей в кадр почти не
   попадает, и конус повисает в воздухе ниоткуда. Это не настройка силы —
   это отсутствующая причинно-следственная связь, и приглушением она не лечится.

   Убраны они целиком, а не спрятаны за флаг: конусы были ещё и самой дорогой
   вещью в кадре по заполнению. Двадцать девять полупрозрачных объёмов длиной
   29 м, каждый DoubleSide, без depthWrite и без отсечения по пирамиде — это
   десятки полных перерисовок экрана поверх готовой картинки. Отсюда и «сильно
   стало лагать».

   Роль лучей в схеме света забрали те, кто изображает свет честно:
   подкровельная полусфера (20_render.js), настенные лампы (LIGHTS) и
   направленное солнце, которому здесь же вернули силу.
   Пыль в воздухе (TER_makeMotes) осталась: она стоит одну систему точек и
   не притворяется светом.                                                     */

/* Пыль в воздухе зала. Одна система Points на всю карту: базовые позиции
   лежат в кубе, а в шейдере куб заворачивается вокруг камеры — поле всегда
   окружает игрока, но мировой параллакс сохраняется.
   Отличия от прежнего «поля мошкары под открытым небом»: куб сжат до размера
   зала, пыль в основном тёплая (опилки, а не светлячки), и её яркость растёт
   с высотой — та же подсказка о ярусе, что дают лучи. В оптике гасим:
   мошкара в прицеле мешает различать цель. */
function TER_makeMotes(){
  const N = 340, BOX = 78;
  const P = new Float32Array(N*3), C = new Float32Array(N*3), S = new Float32Array(N);
  const cDust = new THREE.Color(0xe4cea2), cWarm = new THREE.Color(PAL.ember),
        ca = new THREE.Color(PAL.arcane), cw = new THREE.Color(PAL.wisp), t = new THREE.Color();
  for(let i=0;i<N;i++){
    P[i*3] = rnd(-BOX/2, BOX/2); P[i*3+1] = rnd(0.8, 21.0); P[i*3+2] = rnd(-BOX/2, BOX/2);
    S[i] = Math.random();
    const k = Math.random();
    // 78% — обычная древесная пыль, остальное магический акцент
    t.copy(k < 0.62 ? cDust : (k < 0.78 ? cWarm : (k < 0.92 ? ca : cw)));
    C[i*3] = t.r; C[i*3+1] = t.g; C[i*3+2] = t.b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(P,3));
  geo.setAttribute('aCol',     new THREE.BufferAttribute(C,3));
  geo.setAttribute('aSeed',    new THREE.BufferAttribute(S,1));

  const mat = new THREE.ShaderMaterial({
    uniforms:{
      uT:{value:0}, uCam:{value:new THREE.Vector3()},
      uBox:{value:BOX}, uScale:{value:600}, uFade:{value:1},
      uMap:{value:TEX_GLOW || sprTex('rgba(255,255,255,1)','rgba(200,240,255,0.5)')}
    },
    vertexShader: [
      'attribute vec3 aCol; attribute float aSeed;',
      'uniform float uT; uniform vec3 uCam; uniform float uBox; uniform float uScale; uniform float uFade;',
      'varying vec3 vC; varying float vA;',
      'void main(){',
      '  vec3 p = position;',
      '  p.x += sin(uT*0.13 + aSeed*6.283)*2.0 + uT*0.22;',
      '  p.z += cos(uT*0.11 + aSeed*4.712)*2.0 + uT*0.12;',
      '  p.y += sin(uT*0.34 + aSeed*12.566)*0.8;',
      '  p.x = mod(p.x - uCam.x + uBox*0.5, uBox) - uBox*0.5 + uCam.x;',
      '  p.z = mod(p.z - uCam.z + uBox*0.5, uBox) - uBox*0.5 + uCam.z;',
      '  vec4 mv = modelViewMatrix*vec4(p,1.0);',
      '  float d = max(-mv.z, 0.1);',
      // у лица не мельтешит, у границы куба гаснет — перескок не виден
      '  vA = smoothstep(1.5, 6.0, d)*(1.0 - smoothstep(uBox*0.26, uBox*0.44, d))*uFade;',
      // выше — светлее: пыль подсвечена дневными лучами, а не лампами
      '  vA *= 0.40 + 0.60*smoothstep(2.0, 15.0, p.y);',
      '  vC = aCol;',
      '  gl_PointSize = min(0.085*(0.6 + aSeed*0.9)*uScale/d, 12.0);',
      '  gl_Position = projectionMatrix*mv;',
      '}'
    ].join('\n'),
    fragmentShader: [
      'uniform sampler2D uMap;',
      'varying vec3 vC; varying float vA;',
      'void main(){',
      '  float a = texture2D(uMap, gl_PointCoord).a*vA;',
      '  if(a < 0.01) discard;',
      '  gl_FragColor = vec4(vC, a*0.70);',
      '}'
    ].join('\n'),
    transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, fog:false
  });

  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;    // куб ездит за камерой, границы объекта врут
  pts.onBeforeRender = function(r, s, cam){
    const u = mat.uniforms;
    u.uT.value = performance.now()*0.001;
    u.uCam.value.copy(cam.position);
    // размер точки в пикселях: следим за кратностью оптики, иначе в прицеле
    // пылинки раздуваются в кляксы
    u.uScale.value = r.domElement.height/(2*Math.tan(cam.fov*Math.PI/360));
    u.uFade.value = (typeof wpn !== 'undefined' && wpn && wpn.scoped) ? 0.2 : 1;
  };
  scene.add(pts);
}

function buildSky(){
  TER_makeSkyDome();
  TER_makeMountains();
  TER_makeClouds();
  TER_makeMotes();
}
