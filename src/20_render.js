/* --------------------------- РЕНДЕР / СЦЕНА --------------------------- */
let renderer, scene, camera, vmScene, vmCamera, world, sun, hemi, skyMesh;
let W = innerWidth, H = innerHeight;
// Контровая: холодный свет «из-за спины сцены». Нужен не для красоты — он
// обводит силуэт бойца прохладной каймой, и цель читается на 100+ м даже
// когда стоит на фоне такого же тёплого песка.
let RND_rim = null;

/* Потолок плотности пикселей. Сцена упирается во fill rate: ландшафт с
   receiveShadow, полноэкранное небо и много аддитивной прозрачности без
   depthWrite. На HiDPI-ноутбуке devicePixelRatio=2 — это вчетверо больше
   фрагментов при том же кадре, и именно он, а не тени, решает на слабых
   машинах. 1.5 визуально почти неотличим, но возвращает ~40% кадра. */
let RND_pixCap = 1.5;

function initThree(){
  renderer = new THREE.WebGLRenderer({ canvas:document.getElementById('c'), antialias:true, powerPreference:'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, RND_pixCap));
  renderer.setSize(W,H);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Карту тени обновляет цикл (через кадр) — см. loop() в 90_game.js
  renderer.shadowMap.autoUpdate = false;
  renderer.autoClear = false;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9dc0d8);
  // Туман — только воздушная перспектива дальних планов. Ближняя граница
  // вынесена за 130 м намеренно: снайпер обязан различать цель на своей
  // рабочей дистанции без «молочной» пелены поверх неё.
  scene.fog = new THREE.Fog(0xbdd3e0, 130, 520);

  camera = new THREE.PerspectiveCamera(80, W/H, 0.06, 900);

  // отдельная сцена для оружия от первого лица — не режется стенами
  vmScene = new THREE.Scene();
  vmCamera = new THREE.PerspectiveCamera(58, W/H, 0.01, 12);
  vmScene.add(new THREE.HemisphereLight(0xdcefff, 0x53483a, 0.88));
  const vl = new THREE.DirectionalLight(0xfff1d4, 1.02); vl.position.set(1.4,2.2,1.6); vmScene.add(vl);
  const vl2 = new THREE.DirectionalLight(0x7cb4ea, 0.42); vl2.position.set(-1.6,0.6,-1.2); vmScene.add(vl2);

  world = new THREE.Group(); scene.add(world);

  // Тёплое солнце + холодное небо: тот самый контраст, на котором держится
  // палитра TF2. Карты (22_tex.js) чуть темнее чистого цвета, поэтому
  // ключевой свет намеренно горячее, чем был на голых материалах.
  hemi = new THREE.HemisphereLight(0xd2e6ff, 0x6f5d3c, 0.66); scene.add(hemi);
  sun = new THREE.DirectionalLight(0xfff1d2, 1.34);
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
  RND_rim = new THREE.DirectionalLight(0x82b6ee, 0.44);
  RND_rim.position.set(-72,30,-58); scene.add(RND_rim);

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
  cap: 64,         // размер пула логических источников
  reach: 55,       // насколько далеко за своим радиусом источник ещё борется за лампу
  mul: 1,          // общий множитель яркости — запас на слабые машины

  _lamps: [],      // {light, k} — k нужен только для плавного гашения
  _pool: [],       // логические источники (все, включая выключенные)
  _free: [],       // индексы свободных слотов пула
  _top: [], _tsc: [], _tn: 0,
  _frame: 0,

  init(){
    if(this._lamps.length) return;
    for(let i=0;i<this.max;i++){
      const L = new THREE.PointLight(0xffffff, 0, 12, 1);
      L.castShadow = false;          // тени от точечных — не наш бюджет
      L.position.set(0, -1000, 0);
      scene.add(L);
      this._lamps.push({ light:L, src:null });
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
    const s = this._alloc();
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
    const s = this._alloc();
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
      this._lamps[best].src = s; s.lamp = best;
    }
    // применяем
    for(let i=0;i<this.max;i++){
      const L = this._lamps[i], s = L.src;
      if(s){
        L.light.position.copy(s.pos);
        L.light.color.copy(s.col);
        L.light.distance = s.dist;
        L.light.intensity = s.cur * this.mul;
      } else if(L.light.intensity > 0){
        // не гасим рывком: лампа могла светить в полную силу
        L.light.intensity = damp(L.light.intensity, 0, 20, dt);
        if(L.light.intensity < 0.02) L.light.intensity = 0;
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
  _alloc(){
    if(!this._pool.length) this.init();
    let s = null;
    if(this._free.length) s = this._pool[this._free.pop()];
    else {
      // пул исчерпан — вытесняем самую слабую вспышку; постоянные огни карты
      // трогать нельзя, иначе жаровни начнут пропадать
      let wv = Infinity;
      for(let i=0;i<this._pool.length;i++){
        const p = this._pool[i];
        if(p.on && p.life > 0 && p.cur < wv){ wv = p.cur; s = p; }
      }
      if(!s) return null;
    }
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
function gradientMap(){
  const c = document.createElement('canvas'); c.width=4; c.height=1;
  const x = c.getContext('2d');
  const steps = ['#606068','#9c9a96','#d6d3ca','#ffffff'];
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
