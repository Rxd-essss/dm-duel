/* =====================================================================
   ЛАНДШАФТ · НЕБО · АТМОСФЕРА
   Рельеф читаемый: снайпер обязан видеть силуэт на 100+ м, поэтому вся
   «интересность» карты сидит по краям главных линий огня, а не поперёк них.
   ===================================================================== */

/* ------------------------------ ЛАНДШАФТ ------------------------------ */
/* Опорные площадки. Первые пять — неприкосновенны: на них стоит вся карта
   (базы z=±64, центральное плато, фланговые дворы x=±50), их координаты и
   высоты знают 45_map.js и ИИ. Две последние — новые полки на дальних
   флангах: зона выросла до CFG.half=88, и углы за дворами были пустыми. */
const FLATS = [
  {x:0,   z:-64, r:19, R:31, h:2.2},
  {x:0,   z: 64, r:19, R:31, h:2.2},
  {x:0,   z:  0, r:17, R:30, h:5.4},
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
const TER_SEG  = 150;   // 1.33 м на ячейку (было 0.89): 45 тыс. треугольников
                        // вместо 100 тыс. Земля — самая тяжёлая геометрия кадра,
                        // она же receiveShadow, она же с тремя выборками текстур,
                        // и половина её вершин уходила впустую: самая узкая деталь
                        // профиля — гребень полушириной 5.4 м, это 8 ячеек поперёк.
                        // Проверено по формуле: билинейная сетка расходится с
                        // terrainH не больше чем на 7 см, амплитуда промоин и
                        // гребней теряет 0.6% — расширять их не понадобилось.
                        // Периферию отдельной грубой плоскостью не выносим: кольцо
                        // за ±90 — это 19% площади, зато именно оно стоит стеной
                        // на горизонте, и квадратичный подъём барьера на редкой
                        // сетке ломается в видимые грани. Экономия не окупает риск.

function terrainH(x,z){
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
      col[i3] = tmp.r*n; col[i3+1] = tmp.g*n; col[i3+2] = tmp.b*n;

      // веса зерна: круто — камень, сухо и осыпь — грязь, остальное — трава
      const ws = stony;
      const wd = (1-ws)*clamp(dry*0.85 + sandy*0.75, 0, 1);
      spl[i3] = 1-ws-wd; spl[i3+1] = wd; spl[i3+2] = ws;
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

function TER_makeSkyDome(){
  const mat = new THREE.ShaderMaterial({
    uniforms:{
      cTop :{value:new THREE.Color(0x2a6cb4)},
      cMid :{value:new THREE.Color(0x87b8de)},
      cHaze:{value:new THREE.Color(0xc6dae7)},
      cBot :{value:new THREE.Color(0xe9dcbe)},
      cSun :{value:new THREE.Color(0xfff0c8)},
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
      '  c += cSun*(pow(s, 46.0)*0.55 + pow(s, 5.0)*0.12);',
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

/* Один план дальних гор. Планы отличаются дистанцией, высотой и тоном;
   остальное доделывает туман — чем дальше гряда, тем сильнее она уходит
   в дымку. Материал basic: горы не должны реагировать на солнце, их свет
   запечён в вершинный цвет. */
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
  TER_ridgeRing(34, 210, 250, 100, 165, 40,  75, 0x5c7285, 0xa2b9c6);
  TER_ridgeRing(26, 300, 350, 145, 225, 55, 105, 0x748ba0, 0xbacfdb);
  TER_ridgeRing(18, 390, 440, 185, 280, 80, 140, 0x92a8b9, 0xcadbe6);
}

/* Облака-кляксы. Тон берём от нормали: макушка тёплая, подбрюшье холодное —
   тот самый «нарисованный» скайбокс. Всё кольцо — один меш, он же лениво
   вращается, изображая снос. */
function TER_makeClouds(){
  const geos = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(),
        p = new THREE.Vector3(), sc = new THREE.Vector3();
  for(let i=0;i<20;i++){
    const a = rnd(0,Math.PI*2), r = rnd(230,430), y = rnd(105,205);
    const cx = Math.cos(a)*r, cz = Math.sin(a)*r;
    const n = rint(4,7);
    for(let j=0;j<n;j++){
      const s = rnd(11,29);
      const g = new THREE.SphereGeometry(s, 9, 6);
      p.set(cx + rnd(-32,32), y + rnd(-4,7), cz + rnd(-32,32));
      sc.set(1, rnd(0.34,0.55), 1);
      m4.compose(p,q,sc);
      g.applyMatrix4(m4);
      geos.push(g);
    }
  }
  const geo = TER_merge(geos);
  const P = geo.attributes.position, N = geo.attributes.normal;
  const C = new Float32Array(P.count*3);
  const lo = new THREE.Color(0x9db1c8), hi = new THREE.Color(0xfffaef), t = new THREE.Color();
  for(let i=0;i<P.count;i++){
    t.copy(lo).lerp(hi, smoothstep(0.15, 0.80, N.getY(i)*0.5+0.5));
    C[i*3] = t.r; C[i*3+1] = t.g; C[i*3+2] = t.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(C,3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({vertexColors:true, fog:false}));
  mesh.frustumCulled = false;
  mesh.onBeforeRender = function(){ mesh.rotation.y = performance.now()*0.0000045; };
  scene.add(mesh);
}

/* Эфирное свечение у горизонта. Это акцент, а не герой кадра: полоса живёт
   над северной кромкой, аддитивно и слабо, и её перекрывают горы. Анимация —
   одна uniform во времени, ни одного вызова из игрового цикла. */
function TER_makeAurora(){
  /* Полоса начинается выше пиков дальней гряды (~33° над горизонтом на
     радиусе 470) — иначе её просто съедают горы и с земли ничего не видно. */
  const geo = new THREE.CylinderGeometry(470,470,270,48,1,true);
  geo.translate(0,295,0);
  const mat = new THREE.ShaderMaterial({
    uniforms:{
      uT:{value:0},
      cA:{value:new THREE.Color(PAL.wisp)},
      cB:{value:new THREE.Color(PAL.violet)}
    },
    vertexShader: [
      'varying vec2 vU;',
      'void main(){ vU = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }'
    ].join('\n'),
    fragmentShader: [
      'varying vec2 vU;',
      'uniform float uT; uniform vec3 cA; uniform vec3 cB;',
      'void main(){',
      '  float y = vU.y;',
      // мягкое основание и длинный хвост вверх
      '  float band = smoothstep(0.0, 0.24, y)*(1.0 - smoothstep(0.32, 1.0, y));',
      '  float a = vU.x*6.2831;',
      // «шторы»: две волны разной частоты, возведённые в степень. Без степени
      // получается ровная засветка, а нужен рваный вертикальный рисунок
      '  float w = (0.5 + 0.5*sin(a*9.0 + uT*0.11))*(0.62 + 0.38*sin(a*17.0 - uT*0.07));',
      '  w = pow(w, 1.9)*1.25 + 0.10;',
      // дуга: у CylinderGeometry u=0 смотрит на +Z, то есть на север, к RED
      '  float arc = 0.12 + 0.88*pow(max(cos(a), 0.0), 1.4);',
      '  float g = band*w*arc*0.34;',
      '  vec3 c = mix(cA, cB, clamp(y*1.5 + w*0.15, 0.0, 1.0));',
      '  gl_FragColor = vec4(c, g);',
      '}'
    ].join('\n'),
    side:THREE.BackSide, transparent:true, depthWrite:false,
    blending:THREE.AdditiveBlending, fog:false
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.onBeforeRender = function(){ mat.uniforms.uT.value = performance.now()*0.001; };
  scene.add(mesh);
}

/* Пылинки и искры в воздухе. Одна система Points на всю карту: базовые
   позиции лежат в кубе, а в шейдере куб заворачивается вокруг камеры — поле
   всегда окружает игрока, но мировой параллакс сохраняется. В оптике гасим:
   мошкара в прицеле мешает различать цель. */
function TER_makeMotes(){
  const N = 320, BOX = 130;
  const P = new Float32Array(N*3), C = new Float32Array(N*3), S = new Float32Array(N);
  const cw = new THREE.Color(PAL.wisp), ca = new THREE.Color(PAL.arcane),
        ce = new THREE.Color(PAL.ember), t = new THREE.Color();
  for(let i=0;i<N;i++){
    P[i*3] = rnd(-BOX/2, BOX/2); P[i*3+1] = rnd(1.5, 26); P[i*3+2] = rnd(-BOX/2, BOX/2);
    S[i] = Math.random();
    const k = Math.random();
    t.copy(k < 0.52 ? cw : (k < 0.84 ? ca : ce));
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
      '  p.x += sin(uT*0.13 + aSeed*6.283)*2.4 + uT*0.30;',
      '  p.z += cos(uT*0.11 + aSeed*4.712)*2.4 + uT*0.16;',
      '  p.y += sin(uT*0.34 + aSeed*12.566)*0.9;',
      '  p.x = mod(p.x - uCam.x + uBox*0.5, uBox) - uBox*0.5 + uCam.x;',
      '  p.z = mod(p.z - uCam.z + uBox*0.5, uBox) - uBox*0.5 + uCam.z;',
      '  vec4 mv = modelViewMatrix*vec4(p,1.0);',
      '  float d = max(-mv.z, 0.1);',
      // у лица не мельтешит, у границы куба гаснет — перескок не виден
      '  vA = smoothstep(1.5, 6.0, d)*(1.0 - smoothstep(uBox*0.26, uBox*0.44, d))*uFade;',
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
      '  gl_FragColor = vec4(vC, a*0.75);',
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
  TER_makeAurora();
  TER_makeMotes();
}
