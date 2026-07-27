/* =====================================================================
   E3 · ЭФФЕКТЫ: частицы, взрывы, огонь, магия.

   Три подсистемы, потому что у них разная цена и разный смысл:
     1) мешевые частицы (PGEO+PMAT) — обломки, щепа, кровь, комья земли.
        Их видно как твёрдые кусочки, они вращаются и отскакивают от земли.
     2) «мягкие» частицы — огонь, дым, искры, магия. Это THREE.Points с
        собственным шейдером: весь дым — один draw call, а не сотня спрайтов.
        Спрайтами такое количество не потянуть, а без количества огонь
        читается как две картинки на палке.
     3) крупные редкие объекты — очаги огня, кольца, трассы, цифры урона.

   Правила модуля:
     * в кадре не аллоцируем ничего: все вектора и дескрипторы заведены
       на уровне модуля, живые объекты берутся из пулов;
     * взрыв считает урон ТОЛЬКО через splashDamage() из 10_core.js —
       той же формулой пользуются оружие и ИИ, иначе баланс разъедется;
     * крита у фугаса нет ни при каких условиях;
     * всё ставится по terrainH/gh, а не по захардкоженным высотам:
       рельеф правит другой модуль.
   ===================================================================== */

/* ------------------------- временные объекты ------------------------- */
const FX_v1 = new THREE.Vector3();   // центр цели в расчёте урона
const FX_v2 = new THREE.Vector3();   // цель для decal.lookAt
const FX_v3 = new THREE.Vector3();   // нормаль поверхности
const FX_v4 = new THREE.Vector3();   // разное в impact/ring/tracer
const FX_p  = new THREE.Vector3();   // копия эпицентра взрыва (аргумент бывает чужим временным вектором)
const FX_col = new THREE.Color();
const FX_hsl = { h:0, s:0, l:0 };
const FX_dbs = new THREE.Vector2();

/* Ёмкости пулов. Считано из худшего случая: два взрыва + очаг огня в кадре. */
const FX_MAXP  = 360;   // мешевые частицы
const FX_MAXA  = 300;   // мягкие аддитивные (огонь, искры, магия)
const FX_MAXS  = 200;   // мягкие дымовые
const FX_MAXD  = 64;    // декали
const FX_MAXR  = 12;    // кольца
const FX_MAXT  = 20;    // трассы
const FX_MAXN  = 28;    // спрайты цифр урона
const FX_FIRES = 4;     // одновременных очагов огня

/* --------------------- мягкие частицы: шейдер --------------------- */
/* gl_PointSize считаем честно через projectionMatrix[1][1]: у three в
   PointsMaterial размер не зависит от FOV, и в оптике (7.5°) весь огонь
   схлопнулся бы в точки. Для снайперки это неприемлемо. */
const FX_VERT =
  'attribute float aSize;\n' +
  'attribute float aAlpha;\n' +
  'attribute vec3 aColor;\n' +
  'uniform float uH;\n' +
  'varying float vA;\n' +
  'varying vec3 vC;\n' +
  'void main(){\n' +
  '  vA = aAlpha; vC = aColor;\n' +
  '  vec4 mv = modelViewMatrix * vec4(position, 1.0);\n' +
  '  float s = aSize * projectionMatrix[1][1] * uH * 0.5 / max(0.05, -mv.z);\n' +
  '  gl_PointSize = clamp(s, 0.0, 512.0);\n' +
  '  gl_Position = projectionMatrix * mv;\n' +
  '}';
const FX_FRAG =
  'uniform sampler2D uMap;\n' +
  'varying float vA;\n' +
  'varying vec3 vC;\n' +
  'void main(){\n' +
  '  float a = texture2D(uMap, gl_PointCoord).a * vA;\n' +
  '  if(a < 0.012) discard;\n' +
  '  gl_FragColor = vec4(vC, a);\n' +
  '}';

/* Дескриптор эмиссии. Общий на модуль — чтобы не рожать объект на каждую
   частицу: за один взрыв их вылетает под сотню. */
const FX_E = {
  life:0.6, vx:0, vy:0, vz:0, g:0, dr:0, s0:0.3, s1:0.05,
  r0:1, g0:1, b0:1, r1:1, g1:1, b1:1, a0:1, gc:0
};
function FX_E0(){
  const e = FX_E;
  e.life=0.6; e.vx=0; e.vy=0; e.vz=0; e.g=0; e.dr=0; e.s0=0.3; e.s1=0.05;
  e.r0=1; e.g0=1; e.b0=1; e.r1=1; e.g1=1; e.b1=1; e.a0=1; e.gc=0;
  return e;
}
/* Цвет из hex в поля дескриптора: 0 — стартовый, 1 — конечный. */
function FX_c0(hex){ FX_col.setHex(hex); FX_E.r0=FX_col.r; FX_E.g0=FX_col.g; FX_E.b0=FX_col.b; }
function FX_c1(hex){ FX_col.setHex(hex); FX_E.r1=FX_col.r; FX_E.g1=FX_col.g; FX_E.b1=FX_col.b; }

let FX_ADD = null;   // аддитивная система (огонь, искры, магия)
let FX_SMO = null;   // дымовая система (дым, пыль)

function FX_mkSoft(n, map, additive){
  const pos = new Float32Array(n*3), col = new Float32Array(n*3);
  const sz = new Float32Array(n), al = new Float32Array(n);
  const geo = new THREE.BufferGeometry();
  const aP = new THREE.BufferAttribute(pos,3), aC = new THREE.BufferAttribute(col,3);
  const aS = new THREE.BufferAttribute(sz,1), aA = new THREE.BufferAttribute(al,1);
  aP.setUsage(THREE.DynamicDrawUsage); aC.setUsage(THREE.DynamicDrawUsage);
  aS.setUsage(THREE.DynamicDrawUsage); aA.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aP); geo.setAttribute('aColor', aC);
  geo.setAttribute('aSize', aS);    geo.setAttribute('aAlpha', aA);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uMap:{ value:map }, uH:{ value:800 } },
    vertexShader: FX_VERT, fragmentShader: FX_FRAG,
    transparent: true, depthWrite: false, depthTest: true,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = additive ? 4 : 3;
  scene.add(pts);
  const it = [];
  for(let i=0;i<n;i++) it.push({ life:0, max:1, vx:0, vy:0, vz:0, g:0, dr:0,
    s0:0, s1:0, r0:1, g0:1, b0:1, r1:1, g1:1, b1:1, a0:1, gc:0 });
  return { n, pos, col, sz, al, geo, mat, pts, it, i:0, dirty:false };
}

/* Выпустить одну мягкую частицу по текущему FX_E. */
function FX_emit(S, x, y, z){
  const k = S.i; S.i = (S.i+1) % S.n;
  const it = S.it[k], i3 = k*3, e = FX_E;
  S.pos[i3]=x; S.pos[i3+1]=y; S.pos[i3+2]=z;
  it.life = it.max = e.life;
  it.vx=e.vx; it.vy=e.vy; it.vz=e.vz; it.g=e.g; it.dr=e.dr;
  it.s0=e.s0; it.s1=e.s1; it.a0=e.a0; it.gc=e.gc;
  it.r0=e.r0; it.g0=e.g0; it.b0=e.b0;
  it.r1=e.r1; it.g1=e.g1; it.b1=e.b1;
  S.sz[k]=e.s0; S.al[k]=0;
  S.col[i3]=e.r0; S.col[i3+1]=e.g0; S.col[i3+2]=e.b0;
  S.dirty = true;
}

function FX_updSoft(S, dt){
  const P=S.pos, C=S.col, Z=S.sz, A=S.al, IT=S.it;
  let any = S.dirty;
  for(let k=0;k<S.n;k++){
    const it = IT[k];
    if(it.life<=0) continue;
    it.life -= dt;
    const i3 = k*3;
    if(it.life<=0){ Z[k]=0; A[k]=0; any=true; continue; }
    any = true;
    it.vy -= it.g*dt;
    if(it.dr>0){ let f = 1 - it.dr*dt; if(f<0) f=0; it.vx*=f; it.vy*=f; it.vz*=f; }
    P[i3]+=it.vx*dt; P[i3+1]+=it.vy*dt; P[i3+2]+=it.vz*dt;
    if(it.gc){
      const gy = terrainH(P[i3], P[i3+2]);
      if(P[i3+1] < gy){ P[i3+1]=gy; it.vy = Math.abs(it.vy)*0.22; it.vx*=0.45; it.vz*=0.45; }
    }
    const u = it.life/it.max;                    // 1 на рождении -> 0 на смерти
    Z[k] = it.s1 + (it.s0-it.s1)*u;
    C[i3]   = it.r1 + (it.r0-it.r1)*u;
    C[i3+1] = it.g1 + (it.g0-it.g1)*u;
    C[i3+2] = it.b1 + (it.b0-it.b1)*u;
    // короткий вход и мягкий выход: без входа искры «моргают» на первом кадре
    let f = 1;
    if(u > 0.93) f = (1-u)/0.07;
    else if(u < 0.32) f = u/0.32;
    A[k] = it.a0 * f;
  }
  if(any){
    S.geo.attributes.position.needsUpdate = true;
    S.geo.attributes.aColor.needsUpdate   = true;
    S.geo.attributes.aSize.needsUpdate    = true;
    S.geo.attributes.aAlpha.needsUpdate   = true;
    S.dirty = false;
  }
}
function FX_clearSoft(S){
  if(!S) return;
  for(let k=0;k<S.n;k++){ S.it[k].life = 0; S.sz[k]=0; S.al[k]=0; }
  S.dirty = true;
}

/* ------------------------ тип поверхности ------------------------ */
/* Пыль с земли, щепа с дерева, искры с металла — иначе все попадания
   выглядят одинаково и по эффекту не понять, во что ты попал.
   Тип определяем по материалу самого мелкого меша карты, накрывшего точку:
   мелкий меш — это и есть та доска/лист, в которую прилетело. */
const FX_TEXKIND = {
  plank:'wood', wood:'wood', crate:'wood', roof:'wood',
  metal:'metal', plate:'metal', rust:'metal',
  conc:'conc', stone:'stone', sand:'sand', dirt:'dirt', grass:'grass',
  cloth:'cloth', rune:'magic'
};
const FX_HEXKIND = {};
function FX_hexKinds(){
  const put = (c,k)=>{ FX_HEXKIND[c] = k; };
  put(PAL.wood,'wood'); put(PAL.woodDk,'wood'); put(PAL.plank,'wood'); put(PAL.leather,'cloth');
  put(PAL.hay,'hay');
  put(PAL.metal,'metal'); put(PAL.metalDk,'metal'); put(PAL.rust,'metal'); put(PAL.dark,'metal');
  put(PAL.conc,'conc'); put(PAL.concDk,'conc');
  put(PAL.rock,'stone'); put(PAL.rockDk,'stone'); put(PAL.sand,'sand');
  put(PAL.grass,'grass'); put(PAL.dirt,'dirt');
  put(PAL.khaki,'cloth'); put(PAL.khakiDk,'cloth'); put(PAL.skin,'flesh');
  put(PAL.glassDk,'glass');
  put(PAL.red,'metal'); put(PAL.redDk,'metal'); put(PAL.blu,'metal'); put(PAL.bluDk,'metal');
  put(PAL.arcane,'magic'); put(PAL.rune,'magic'); put(PAL.violet,'magic'); put(PAL.wisp,'magic');
  // «фирменные» цвета контейнеров из 45_map.js — это крашеное железо
  put(0x5f7a4e,'metal'); put(0x4f6b86,'metal'); put(0x6b6f74,'metal'); put(0x8a5c3a,'metal');
}

let FX_idx = null;                    // индекс мешей карты
const FX_bbx = new THREE.Box3();      // общий короб пересчёта, чтобы не клонировать на каждый меш

/* Индекс строится ОДИН раз на загрузке: его зовёт boot() сразу после
   buildMap(). Обход мира стоит десятки миллисекунд, и делать это лениво,
   на первом же попадании пули, нельзя — фриз приходится ровно на первый
   выстрел, когда игрок к нему меньше всего готов.
   В записи держим шесть чисел вместо Box3: перебор идёт по плоским полям
   без разыменования min/max, а память на пару сотен коробов не уходит. */
function buildSurfaceIndex(){
  FX_idx = [];
  if(typeof world === 'undefined' || !world) return;
  world.updateMatrixWorld(true);
  world.traverse(o=>{
    if(!o.isMesh || !o.geometry) return;
    // сам ландшафт пропускаем: его bbox накрывает карту целиком и толку от
    // него нет, а считать его на 30 тысяч вершин — заметный рывок кадра
    const ap = o.geometry.attributes && o.geometry.attributes.position;
    if(ap && ap.count > 4000) return;
    if(!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    FX_bbx.copy(o.geometry.boundingBox);
    FX_bbx.applyMatrix4(o.matrixWorld);
    FX_bbx.expandByScalar(0.14);
    const mn = FX_bbx.min, mx = FX_bbx.max;
    FX_idx.push({ x0:mn.x, y0:mn.y, z0:mn.z, x1:mx.x, y1:mx.y, z1:mx.z,
      v:(mx.x-mn.x)*(mx.y-mn.y)*(mx.z-mn.z), m:o.material });
  });
  // спросили до сборки карты — не запоминаем пустой индекс, попробуем позже
  if(!FX_idx.length) FX_idx = null;
}
function FX_matKind(mat){
  const m = Array.isArray(mat) ? mat[0] : mat;
  if(!m) return 'stone';
  if(m.map && m.map.name && FX_TEXKIND[m.map.name]) return FX_TEXKIND[m.map.name];
  if(!m.color) return 'stone';
  const k = FX_HEXKIND[m.color.getHex()];
  if(k) return k;
  // незнакомый цвет: серое считаем железом/бетоном, тёплое — деревом
  m.color.getHSL(FX_hsl);
  if(FX_hsl.s < 0.14) return FX_hsl.l < 0.55 ? 'metal' : 'conc';
  if(FX_hsl.h > 0.04 && FX_hsl.h < 0.19) return 'wood';
  return 'metal';
}
function FX_surfaceOf(p){
  // страховка на случай, если индекс не построили на загрузке
  if(FX_idx === null) buildSurfaceIndex();
  if(FX_idx === null) return 'stone';
  let best = null;
  const px = p.x, py = p.y, pz = p.z;
  for(let i=0;i<FX_idx.length;i++){
    const e = FX_idx[i];
    if(px<e.x0 || px>e.x1 || py<e.y0 || py>e.y1 || pz<e.z0 || pz>e.z1) continue;
    if(best === null || e.v < best.v) best = e;
  }
  if(!best) return 'stone';
  if(best.v > 4000) return FX_terrainKind(p);   // накрыл только сам ландшафт
  return FX_matKind(best.m);
}
/* Земля меняет характер по уклону и высоте — так же, как её красит 25_terrain.js. */
function FX_terrainKind(p){
  terrainN(p.x, p.z, FX_v3);
  const slope = 1 - FX_v3.y;
  if(slope > 0.30) return 'stone';
  if(terrainH(p.x, p.z) > 6.4) return 'dirt';
  if(slope > 0.13) return 'sand';
  return 'grass';
}

/* Палитра пыли и материал крошки по типу поверхности. */
const FX_DUSTCOL = {
  grass:0x8c9857, dirt:0xa98d63, sand:0xc9b47f, stone:0x9a9084, conc:0xb3ab97,
  wood:0xc39a67, metal:0xb9bec4, flesh:0x8e2c26, hay:0xd8bf68, glass:0xcfe9f2,
  cloth:0xa9997a, magic:0x9be8ff
};

/* ------------------------------ ПУЛЫ ------------------------------ */
const PGEO = new THREE.BoxGeometry(1,1,1);
const PMAT = {};
const FX_EMPTY = {};

let FX_decGeo = null;
const FX_decT = [];                     // возраст/срок жизни декалей, индексы совпадают с FX.decals
let FX_ringGeo = null;
const FX_rings = [];
const FX_tracers = [];
const FX_fireAll = [];                  // все очаги огня (включая спящие)

const FX_numCache = new Map();          // текстуры цифр урона: значения повторяются постоянно
let FX_numCtx = null;
const FX_NUMFONT = 'bold 62px "Arial Black", "Arial Bold", Arial, sans-serif';
const FX_NUMCOL = { crit:0xffd24a, splash:0xffa856, burn:0xff7a3c, heal:0x8fe08a, def:0xf4ece0 };
const FX_numPool = [];                  // спрайты цифр: создаются в init(), дальше только гаснут/зажигаются
let FX_numI = 0;                        // кольцевой индекс, как у FX.pool и FX.decals
let FX_numLive = 0;                     // сколько записей пула сейчас в FX.nums

/* Погасить все цифры разом. Текстуры общие и лежат в FX_numCache — их
   dispose() убил бы их и у следующего матча, поэтому только visible=false. */
function FX_numsHide(){
  for(let i=0;i<FX_numPool.length;i++){
    const r = FX_numPool[i];
    r.on = false; r.life = 0; r.m.visible = false;
  }
  FX_numLive = 0;
  FX.nums.length = 0;
}

/* стабильные адреса под LIGHTS.flash: пул света копирует позицию сразу,
   но полагаться на чужой временный вектор всё равно нельзя */
const FX_lpos = [];
let FX_lpi = 0;
function FX_flash(p, col, inten, dist, life){
  if(!FX_lpos.length) return;
  if(typeof LIGHTS === 'undefined' || !LIGHTS || !LIGHTS.flash) return;
  const v = FX_lpos[FX_lpi]; FX_lpi = (FX_lpi+1) % FX_lpos.length;
  v.copy(p);
  LIGHTS.flash(v, col, inten, dist, life);
}

const FX = {
  pool:[], i:0, decals:[], di:0, pools:[], nums:[],

  init(){
    /* --- материалы мешевых частиц --- */
    PMAT.blood  = toon(0xb02a24);
    PMAT.spark  = basic(0xffd98a);
    PMAT.dust   = toon(0xb2a68c);
    PMAT.smoke  = toon(0x6b6660);
    PMAT.fire   = basic(0xff7a2a);
    PMAT.debris = toon(0x5b5750);
    PMAT.wood   = toon(PAL.wood);
    PMAT.chip   = toon(PAL.woodDk);
    PMAT.metal  = basic(0xc8cdd2);
    PMAT.stone  = toon(PAL.rockDk);
    PMAT.conc   = toon(PAL.concDk);
    PMAT.dirt   = toon(PAL.dirt);
    PMAT.grass  = toon(PAL.grass);
    PMAT.sand   = toon(PAL.sand);
    PMAT.hay    = toon(PAL.hay);
    PMAT.cloth  = toon(PAL.khakiDk);
    PMAT.glass  = basic(0xbfe4ef, { transparent:true, opacity:0.75 });
    PMAT.ember  = basic(0xff9a3c);
    FX_hexKinds();

    /* --- мешевые частицы --- */
    for(let i=0;i<FX_MAXP;i++){
      const m = new THREE.Mesh(PGEO, PMAT.dust);
      m.visible = false; m.frustumCulled = false;
      scene.add(m);
      this.pool.push({ m, life:0, max:1, v:new THREE.Vector3(), g:12,
        rot:new THREE.Vector3(), s0:0.1, s1:0, dr:0, b:0.28, sx:1, sy:1, sz:1 });
    }

    /* --- мягкие частицы --- */
    FX_ADD = FX_mkSoft(FX_MAXA, TEX_GLOW, true);
    FX_SMO = FX_mkSoft(FX_MAXS, TEX_SMOKE, false);

    /* --- декали: у каждой свой материал, чтобы гасли по отдельности --- */
    FX_decGeo = new THREE.CircleGeometry(0.34, 12);
    for(let i=0;i<FX_MAXD;i++){
      const mat = new THREE.MeshBasicMaterial({
        color:0x241c16, transparent:true, opacity:0.72, depthWrite:false,
        polygonOffset:true, polygonOffsetFactor:-4, polygonOffsetUnits:-4
      });
      const m = new THREE.Mesh(FX_decGeo, mat);
      m.visible = false; m.renderOrder = 1;
      scene.add(m);
      this.decals.push(m);
      FX_decT.push({ t:0, life:0, o0:0.72 });
    }

    /* --- кольца ударной волны --- */
    FX_ringGeo = new THREE.RingGeometry(0.74, 1.0, 44);
    FX_ringGeo.rotateX(-Math.PI/2);
    for(let i=0;i<FX_MAXR;i++){
      const mat = new THREE.MeshBasicMaterial({ color:0xffd9a0, transparent:true, opacity:0,
        blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide, fog:false });
      const m = new THREE.Mesh(FX_ringGeo, mat);
      m.visible = false; m.renderOrder = 5;
      scene.add(m);
      FX_rings.push({ m, t:0, life:0, r:1 });
    }

    /* --- трассы --- */
    for(let i=0;i<FX_MAXT;i++){
      const mat = new THREE.MeshBasicMaterial({ color:0xffe9a8, transparent:true, opacity:0,
        blending:THREE.AdditiveBlending, depthWrite:false, fog:false });
      const m = new THREE.Mesh(PGEO, mat);
      m.visible = false; m.frustumCulled = false; m.renderOrder = 5;
      scene.add(m);
      FX_tracers.push({ m, t:0, life:0, w:0.05 });
    }

    /* --- очаги огня: собираем заранее, поджиг не должен ничего создавать --- */
    for(let i=0;i<FX_FIRES;i++) FX_fireAll.push(FX_mkFire());

    for(let i=0;i<10;i++) FX_lpos.push(new THREE.Vector3());
    FX_numCtx = document.createElement('canvas').getContext('2d');

    /* --- цифры урона: пул, добавленный в сцену один раз ---
       Раньше каждая цифра была new Sprite + new SpriteMaterial + scene.add,
       и в замесе их набиралось под полтысячи — столько же лишних draw call
       с depthTest:false поверх всей картинки. Пул держит потолок. */
    for(let i=0;i<FX_MAXN;i++){
      const mat = new THREE.SpriteMaterial({ transparent:true, depthTest:false,
        depthWrite:false, fog:false, color:0xffffff, opacity:1 });
      const sp = new THREE.Sprite(mat);
      sp.visible = false; sp.renderOrder = 20;
      scene.add(sp);
      FX_numPool.push({ m:sp, t:0, life:0, base:1, ar:1, vx:0, vy:0, vz:0, on:false });
    }
  },

  /* Индекс поверхностей карты. Зовётся из boot() ПОСЛЕ buildMap() —
     синоним buildSurfaceIndex() для тех, кому удобнее через FX. */
  buildIndex(){ buildSurfaceIndex(); },

  /* ------------------------- мешевые частицы ------------------------- */
  /* opts: mat, speed, life, size, s1, g, dir, push, drag, bounce, sx/sy/sz,
     surf — тип поверхности ('wood'|'metal'|…) либо false, чтобы отключить
     разбор попадания. */
  burst(p, n, opts){
    opts = opts || FX_EMPTY;
    const mat = opts.mat || PMAT.dust;
    /* Адаптер под попадание пули: 60_weapon.js зовёт burst() с нормалью
       поверхности. Дульная вспышка выглядит так же, но живёт вплотную к
       камере и всегда задаёт s1 — по этим двум признакам и различаем. */
    if(opts.surf !== false && (typeof opts.surf === 'string' ||
       (opts.dir && opts.push && opts.s1 === undefined &&
        (mat === PMAT.dust || mat === PMAT.spark) &&
        p.distanceTo(camera.position) > 2.0))){
      const kind = (typeof opts.surf === 'string') ? opts.surf
                 : (mat === PMAT.dust ? 'terrain' : undefined);
      FX.impact(p, n, kind, 1, opts.dir);
      return;
    }
    const sp = opts.speed === undefined ? 6 : opts.speed;
    const g  = opts.g === undefined ? 14 : opts.g;
    const life = opts.life || 0.7;
    const size = opts.size || 0.11;
    const s1 = opts.s1 === undefined ? 0 : opts.s1;
    const dr = opts.drag || 0;
    const bo = opts.bounce === undefined ? 0.28 : opts.bounce;
    const sx = opts.sx || 1, sy = opts.sy || 1, sz = opts.sz || 1;
    for(let k=0;k<n;k++){
      const it = this.pool[this.i]; this.i = (this.i+1) % this.pool.length;
      it.m.material = mat;
      it.m.visible = true;
      it.m.position.copy(p);
      it.v.set(rnd(-1,1), rnd(-0.1,1.2), rnd(-1,1)).normalize().multiplyScalar(rnd(sp*0.3, sp));
      if(opts.dir) it.v.addScaledVector(opts.dir, opts.push || 0);
      it.g = g; it.dr = dr; it.b = bo;
      it.max = it.life = life*rnd(0.7,1.3);
      it.s0 = size*rnd(0.6,1.4); it.s1 = s1;
      it.sx = sx; it.sy = sy; it.sz = sz;
      it.rot.set(rnd(-9,9), rnd(-9,9), rnd(-9,9));
      it.m.scale.set(it.s0*sx, it.s0*sy, it.s0*sz);
      it.m.rotation.set(rnd(0,3), rnd(0,3), rnd(0,3));
    }
  },

  /* ------------------------- попадание в поверхность ------------------------- */
  /* kind: 'terrain'|'grass'|'dirt'|'sand'|'stone'|'conc'|'wood'|'metal'|
           'hay'|'cloth'|'glass'|'flesh'|'magic'. Не задан — определим сами. */
  impact(p, n, kind, scale, nrm){
    const s = scale || 1;
    let k = kind;
    if(k === 'terrain') k = FX_terrainKind(p);
    else if(k === 'enemy' || k === 'player') k = 'flesh';
    else if(!k || k === 'box') k = FX_surfaceOf(p);
    if(nrm) FX_v3.copy(nrm); else terrainN(p.x, p.z, FX_v3);

    const dust = FX_DUSTCOL[k] || FX_DUSTCOL.stone;
    const nx = FX_v3.x, ny = FX_v3.y, nz = FX_v3.z;
    let e;

    /* --- крошка/щепа/кровь: твёрдые кусочки --- */
    if(k === 'flesh'){
      this.burst(p, n, { mat:PMAT.blood, speed:5.5*s, life:0.6, size:0.085*s, surf:false });
    } else if(k === 'wood'){
      this.burst(p, Math.round(n*0.9), { mat:PMAT.wood, speed:6.0*s, life:0.95, size:0.07*s,
        dir:FX_v3, push:3.2, drag:0.7, sx:0.35, sy:1.0, sz:2.4, surf:false });
      this.burst(p, 2, { mat:PMAT.chip, speed:4.0*s, life:1.1, size:0.06*s,
        dir:FX_v3, push:2.2, sx:0.3, sy:0.9, sz:2.8, surf:false });
    } else if(k === 'metal'){
      this.burst(p, Math.max(2, Math.round(n*0.4)), { mat:PMAT.metal, speed:7.5*s, life:0.5,
        size:0.05*s, dir:FX_v3, push:3.6, sx:0.35, sy:0.35, sz:2.0, surf:false });
    } else if(k === 'glass'){
      this.burst(p, n, { mat:PMAT.glass, speed:6.5*s, life:0.85, size:0.06*s,
        dir:FX_v3, push:3.0, sx:0.25, sy:1.3, sz:1.3, surf:false });
    } else if(k === 'hay'){
      this.burst(p, n, { mat:PMAT.hay, speed:3.4*s, life:1.4, size:0.05*s, g:4.5,
        dir:FX_v3, push:1.6, drag:1.6, sx:0.22, sy:0.22, sz:3.4, surf:false });
    } else if(k === 'cloth'){
      this.burst(p, Math.round(n*0.6), { mat:PMAT.cloth, speed:3.2*s, life:1.0, size:0.06*s,
        g:8, dir:FX_v3, push:1.8, drag:1.2, sx:1.2, sy:0.18, sz:1.2, surf:false });
    } else if(k === 'magic'){
      this.magic(p, Math.max(6, n), PAL.rune);
      return;
    } else {
      const mm = (k==='grass') ? PMAT.grass : (k==='dirt') ? PMAT.dirt :
                 (k==='sand') ? PMAT.sand : (k==='conc') ? PMAT.conc : PMAT.stone;
      const hard = (k==='stone' || k==='conc');
      this.burst(p, Math.round(n*(hard?0.7:0.9)), { mat:mm, speed:(hard?6.5:5.0)*s, life:0.85,
        size:0.075*s, dir:FX_v3, push:2.8, drag:0.4, surf:false });
    }

    /* --- пыль/дым: то, что читается издалека --- */
    if(k !== 'metal' && k !== 'glass'){
      const puffs = k === 'flesh' ? 3 : 4;
      for(let i=0;i<puffs;i++){
        e = FX_E0();
        e.life = rnd(0.5, 1.0) * (k==='flesh' ? 0.55 : 1);
        e.vx = nx*rnd(0.6,2.2) + rnd(-0.9,0.9);
        e.vy = ny*rnd(0.6,2.2) + rnd(0.2,1.3);
        e.vz = nz*rnd(0.6,2.2) + rnd(-0.9,0.9);
        e.g = -0.4; e.dr = 2.2;
        e.s0 = 0.16*s; e.s1 = rnd(0.5,0.95)*s;
        FX_c0(dust); FX_c1(dust);
        e.r1*=0.55; e.g1*=0.55; e.b1*=0.55;
        e.a0 = k==='flesh' ? 0.5 : 0.38;
        FX_emit(FX_SMO, p.x, p.y, p.z);
      }
    }

    /* --- искры: металл, камень и бетон --- */
    if(k === 'metal' || k === 'stone' || k === 'conc' || k === 'glass'){
      const cnt = k === 'metal' ? Math.round(n*1.6) : 3;
      for(let i=0;i<cnt;i++){
        e = FX_E0();
        e.life = rnd(0.16, 0.55);
        const sp = rnd(3.5, 13)*s;
        e.vx = (nx + rnd(-0.75,0.75))*sp;
        e.vy = (ny + rnd(-0.55,0.75))*sp;
        e.vz = (nz + rnd(-0.75,0.75))*sp;
        e.g = 22; e.dr = 1.1; e.gc = 1;
        e.s0 = rnd(0.045,0.075); e.s1 = 0.005;
        FX_c0(0xfff6d8); FX_c1(k==='glass' ? 0x9fd8ff : 0xff7a1e);
        e.a0 = 1;
        FX_emit(FX_ADD, p.x, p.y, p.z);
      }
      // короткая точка света от снопа искр: попадание видно даже боковым зрением
      if(k === 'metal') FX_flash(p, 0xffc070, 1.6, 6.5, 0.09);
    }

    /* --- след на поверхности --- */
    if(k === 'flesh'){
      // кровь на земле под целью — если она рядом
      const gy = terrainH(p.x, p.z);
      if(p.y - gy < 2.4 && Math.random() < 0.55){
        FX_v4.set(p.x + rnd(-0.4,0.4), gy, p.z + rnd(-0.4,0.4));
        terrainN(FX_v4.x, FX_v4.z, FX_v3);
        this.decal(FX_v4, FX_v3, 'blood', rnd(0.7,1.2));
      }
    } else {
      this.decal(p, FX_v3, k==='wood' ? 'hole' : (k==='grass'||k==='dirt'||k==='sand') ? 'dirt' : 'hole',
                 (k==='grass'||k==='dirt'||k==='sand') ? rnd(0.85,1.3) : rnd(0.55,0.95));
    }
  },

  /* ------------------------------ декали ------------------------------ */
  decal(p, n, kind, size){
    const i = this.di; this.di = (this.di+1) % this.decals.length;
    const m = this.decals[i], st = FX_decT[i];
    let col = 0x241c16, op = 0.72, life = 26;
    if(kind === 'scorch'){ col = 0x140f0c; op = 0.85; life = 45; }
    else if(kind === 'blood'){ col = 0x6d1a15; op = 0.6; life = 20; }
    else if(kind === 'dirt'){ col = 0x3a2c1e; op = 0.5; life = 18; }
    m.material.color.setHex(col);
    m.material.opacity = op;
    m.visible = true;
    m.position.copy(p).addScaledVector(n, 0.025);
    m.lookAt(FX_v2.copy(m.position).add(n));
    m.rotateZ(rnd(0, 6.283));
    m.scale.setScalar(size === undefined ? rnd(0.6,1.1) : size);
    st.t = 0; st.life = life; st.o0 = op;
  },

  /* ------------------------------ ОЧАГ ОГНЯ ------------------------------ */
  /* Зона отказа территории: жжёт всех, кто в неё влез, светит округу и
     обязана читаться как опасность — отсюда кольцо границы и высокие языки. */
  firePool(p, r, life, dps, byPlayer){
    r = r || 3.2; life = life || 8;
    dps = (dps === undefined) ? 14 : dps;
    // берём спящий очаг; если все заняты — вытесняем самый старый
    let f = null;
    for(let i=0;i<FX_fireAll.length;i++) if(!FX_fireAll[i].on){ f = FX_fireAll[i]; break; }
    if(!f){
      let old = null;
      for(let i=0;i<this.pools.length;i++) if(!old || this.pools[i].t > old.t) old = this.pools[i];
      // если снаружи почистили FX.pools, очаги могли остаться «включёнными» —
      // тогда просто забираем первый, иначе поджиг молча пропадёт
      f = old || FX_fireAll[0];
      if(!f) return;
      FX_fireStop(f);
      const j = this.pools.indexOf(f);
      if(j >= 0){ this.pools[j] = this.pools[this.pools.length-1]; this.pools.pop(); }
    }
    FX_fireStart(f, p, r, life, dps, !!byPlayer);
    this.pools.push(f);
    SFX.flame(panOf(f.p), 0.75*volOf(f.p));
    FX_flash(f.p, 0xff8a30, 4.5, r*6, 0.28);
  },

  /* ------------------------------ МАГИЯ ------------------------------ */
  /* Эфирные искры: акцент, а не заливка экрана. Мелкие, быстро гаснут,
     ядро белое — чтобы на любом фоне читалась именно вспышка, а не пятно. */
  magic(p, n, color){
    const c = (color === undefined) ? PAL.arcane : color;
    for(let k=0;k<n;k++){
      const a = rnd(0, 6.2832), sp = rnd(1.3, 5.4);
      const e = FX_E0();
      e.life = rnd(0.32, 0.9);
      e.vx = Math.cos(a)*sp; e.vz = Math.sin(a)*sp;
      e.vy = rnd(0.4, 3.2);
      e.g = rnd(-1.6, 2.6);            // часть искр всплывает, часть оседает
      e.dr = 2.6;
      e.s0 = rnd(0.09, 0.22); e.s1 = 0.005;
      FX_c0(0xffffff); FX_c1(c);
      FX_E.r0 = (FX_E.r0 + FX_E.r1)*0.5;
      FX_E.g0 = (FX_E.g0 + FX_E.g1)*0.5;
      FX_E.b0 = (FX_E.b0 + FX_E.b1)*0.5;
      e.a0 = 0.9;
      FX_emit(FX_ADD, p.x + rnd(-0.12,0.12), p.y + rnd(-0.12,0.12), p.z + rnd(-0.12,0.12));
    }
    if(n >= 12) FX_flash(p, c, 1.8, 8, 0.16);
  },

  /* --------------------------- КОЛЬЦО УДАРНОЙ ВОЛНЫ --------------------------- */
  ring(p, r, color){
    let R = null;
    for(let i=0;i<FX_rings.length;i++) if(FX_rings[i].life <= 0){ R = FX_rings[i]; break; }
    if(!R){ R = FX_rings[0]; for(let i=1;i<FX_rings.length;i++) if(FX_rings[i].t > R.t) R = FX_rings[i]; }
    R.m.visible = true;
    R.m.position.copy(p);
    R.m.material.color.setHex(color === undefined ? 0xffd9a0 : color);
    R.m.material.opacity = 0.9;
    R.m.scale.set(r*0.2, 1, r*0.2);
    R.r = r; R.t = 0; R.life = 0.42 + r*0.035;
  },

  /* ------------------------------ ТРАССА ------------------------------ */
  tracer(a, b, color, life){
    let T = null;
    for(let i=0;i<FX_tracers.length;i++) if(FX_tracers[i].life <= 0){ T = FX_tracers[i]; break; }
    if(!T){ T = FX_tracers[0]; for(let i=1;i<FX_tracers.length;i++) if(FX_tracers[i].t > T.t) T = FX_tracers[i]; }
    const len = FX_v4.subVectors(b, a).length();
    if(len < 0.02) return;
    T.m.visible = true;
    T.m.position.copy(a).addScaledVector(FX_v4, 0.5);
    T.m.lookAt(b);
    T.w = clamp(len*0.012, 0.025, 0.09);
    T.m.scale.set(T.w, T.w, len);
    T.m.material.color.setHex(color === undefined ? 0xffe9a8 : color);
    T.m.material.opacity = 0.85;
    T.t = 0; T.life = life || 0.08;
  },

  /* --------------------------- ЦИФРЫ УРОНА --------------------------- */
  /* Размер считаем от дистанции и текущего FOV: цифра обязана занимать
     одну и ту же долю экрана и в оптике, и без неё. */
  num(p, val, kind){
    if(!FX_numPool.length) return;                  // init() ещё не звали
    const txt = String(val);
    const K = (kind === true) ? 'crit' : (typeof kind === 'string' ? kind : 'def');
    const crit = (K === 'crit');
    const e = FX_numTex(txt);
    // самая старая цифра уступает место новой: цифр в замесе больше, чем
    // читаемо на экране, и терять свежую хуже, чем ту, что уже уплыла
    const r = FX_numPool[FX_numI]; FX_numI = (FX_numI+1) % FX_numPool.length;
    const mt = r.m.material;
    if(mt.map !== e.t){
      // пересборка материала нужна только при самой первой карте: дефайны
      // от неё зависят, а дальше все текстуры цифр одного формата
      if(!mt.map) mt.needsUpdate = true;
      mt.map = e.t;
    }
    mt.color.setHex(FX_NUMCOL[K] === undefined ? FX_NUMCOL.def : FX_NUMCOL[K]);
    mt.opacity = 1;
    r.m.position.copy(p);
    const d = Math.max(1.5, FX_v4.copy(p).sub(camera.position).length());
    r.base = clamp(d*Math.tan(camera.fov*Math.PI/360)*0.115, 0.20, 9) * (crit ? 1.45 : 1);
    r.ar = e.ar;
    r.m.scale.set(r.base*r.ar, r.base, 1);
    r.m.visible = true;
    r.t = 0; r.life = crit ? 1.45 : 1.15;
    r.vy = 1.55; r.vx = rnd(-0.45,0.45); r.vz = rnd(-0.45,0.45);
    if(!r.on){ r.on = true; FX_numLive++; this.nums.push(r); }
  },

  /* -------------------- сброс между матчами -------------------- */
  /* 90_game.js чистит FX своими руками (GM_clearFx) — этот метод для тех,
     кто хочет сделать это одним вызовом и ничего не забыть. */
  reset(){
    for(let i=0;i<this.pool.length;i++){ this.pool[i].life = 0; this.pool[i].m.visible = false; }
    FX_clearSoft(FX_ADD); FX_clearSoft(FX_SMO);
    for(let i=0;i<this.decals.length;i++){ this.decals[i].visible = false; FX_decT[i].life = 0; }
    for(let i=0;i<FX_rings.length;i++){ FX_rings[i].m.visible = false; FX_rings[i].life = 0; }
    for(let i=0;i<FX_tracers.length;i++){ FX_tracers[i].m.visible = false; FX_tracers[i].life = 0; }
    for(let i=0;i<FX_fireAll.length;i++) FX_fireStop(FX_fireAll[i]);
    this.pools.length = 0;
    FX_numsHide();   // спрайты цифр остаются в сцене, текстуры — в кэше
  },

  /* ------------------------------ КАДР ------------------------------ */
  update(dt){
    /* --- мешевые частицы --- */
    for(let i=0;i<this.pool.length;i++){
      const it = this.pool[i];
      if(it.life <= 0) continue;
      it.life -= dt;
      if(it.life <= 0){ it.m.visible = false; continue; }
      it.v.y -= it.g*dt;
      if(it.dr > 0){ let f = 1 - it.dr*dt; if(f < 0) f = 0; it.v.multiplyScalar(f); }
      it.m.position.addScaledVector(it.v, dt);
      const gy = terrainH(it.m.position.x, it.m.position.z);
      if(it.m.position.y < gy){
        it.m.position.y = gy;
        it.v.multiplyScalar(it.b);
        it.v.y = Math.abs(it.v.y)*0.42;
        it.rot.multiplyScalar(0.5);
      }
      it.m.rotation.x += it.rot.x*dt; it.m.rotation.y += it.rot.y*dt; it.m.rotation.z += it.rot.z*dt;
      const v = lerp(it.s1, it.s0, it.life/it.max);
      it.m.scale.set(v*it.sx, v*it.sy, v*it.sz);
    }

    /* --- мягкие частицы --- */
    if(FX_ADD){
      renderer.getDrawingBufferSize(FX_dbs);
      FX_ADD.mat.uniforms.uH.value = FX_dbs.y;
      FX_SMO.mat.uniforms.uH.value = FX_dbs.y;
      FX_updSoft(FX_SMO, dt);
      FX_updSoft(FX_ADD, dt);
    }

    /* --- декали --- */
    for(let i=0;i<this.decals.length;i++){
      const st = FX_decT[i];
      if(st.life <= 0) continue;
      const m = this.decals[i];
      if(!m.visible){ st.life = 0; continue; }
      st.t += dt;
      if(st.t >= st.life){ m.visible = false; st.life = 0; continue; }
      const u = st.t/st.life;
      if(u > 0.7) m.material.opacity = st.o0*(1 - (u-0.7)/0.3);
    }

    /* --- кольца --- */
    for(let i=0;i<FX_rings.length;i++){
      const R = FX_rings[i];
      if(R.life <= 0) continue;
      R.t += dt;
      if(R.t >= R.life){ R.m.visible = false; R.life = 0; continue; }
      const u = R.t/R.life;
      const k = 0.2 + 0.95*(1 - (1-u)*(1-u));      // резкий старт, плавный доход
      R.m.scale.set(R.r*k, 1, R.r*k);
      R.m.material.opacity = 0.9*(1-u)*(1-u);
    }

    /* --- трассы --- */
    for(let i=0;i<FX_tracers.length;i++){
      const T = FX_tracers[i];
      if(T.life <= 0) continue;
      T.t += dt;
      if(T.t >= T.life){ T.m.visible = false; T.life = 0; continue; }
      const u = 1 - T.t/T.life;
      T.m.material.opacity = 0.85*u;
      T.m.scale.x = T.w*u; T.m.scale.y = T.w*u;
    }

    /* --- очаги огня --- */
    for(let i=this.pools.length-1;i>=0;i--){
      const f = this.pools[i];
      if(!f || !f.on){ this.pools[i] = this.pools[this.pools.length-1]; this.pools.pop(); continue; }
      if(!FX_fireStep(f, dt)){
        FX_fireStop(f);
        this.pools[i] = this.pools[this.pools.length-1]; this.pools.pop();
      }
    }
    // рестарт матча чистит FX.pools снаружи — гасим осиротевшие очаги сами,
    // иначе их статический свет останется висеть над пустым полем
    for(let i=0;i<FX_fireAll.length;i++){
      const f = FX_fireAll[i];
      if(f.on && this.pools.indexOf(f) < 0) FX_fireStop(f);
    }

    /* --- цифры урона --- */
    // сброс матча снаружи обнуляет FX.nums, не зная про пул — гасим спрайты
    // сами, иначе прошлые цифры зависли бы над новой картой
    if(FX_numLive > 0 && this.nums.length === 0) FX_numsHide();
    for(let i=this.nums.length-1;i>=0;i--){
      const n = this.nums[i];
      if(!n || !n.on || !n.m){ this.nums[i] = this.nums[this.nums.length-1]; this.nums.pop(); continue; }
      n.t += dt;
      if(n.t >= n.life){
        n.on = false; n.life = 0; n.m.visible = false; FX_numLive--;
        this.nums[i] = this.nums[this.nums.length-1]; this.nums.pop();
        continue;
      }
      n.vy -= 1.5*dt;
      n.m.position.x += n.vx*dt; n.m.position.z += n.vz*dt;
      n.m.position.y += n.vy*dt;
      n.vx *= 0.94; n.vz *= 0.94;
      // короткий «выброс» на старте: цифра выпрыгивает, а не проявляется
      const pop = n.t < 0.09 ? lerp(0.35, 1.14, n.t/0.09)
                : n.t < 0.20 ? lerp(1.14, 1.0, (n.t-0.09)/0.11) : 1;
      n.m.scale.set(n.base*n.ar*pop, n.base*pop, 1);
      const u = n.t/n.life;
      n.m.material.opacity = u < 0.62 ? 1 : 1 - (u-0.62)/0.38;
    }
  }
};

/* ===================== ОЧАГ ОГНЯ: внутреннее ===================== */
/* Собирается один раз на старте: поджиг в бою не должен ничего создавать. */
function FX_mkFire(){
  const g = new THREE.Group();
  g.visible = false;
  const licks = [];
  // внутренние языки — основной объём пламени
  for(let i=0;i<7;i++){
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map:TEX_FIRE, color:0xff7a28,
      blending:THREE.AdditiveBlending, depthWrite:false, transparent:true, opacity:0.9, fog:false }));
    s.renderOrder = 4;
    g.add(s);
    licks.push({ s, ph:rnd(0,6.283), k:rnd(0.75,1.3), a:rnd(0,6.283), d:0, base:1, y0:0, edge:false });
  }
  // кромка — по ней читается граница опасной зоны
  for(let i=0;i<6;i++){
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map:TEX_FIRE, color:0xff9440,
      blending:THREE.AdditiveBlending, depthWrite:false, transparent:true, opacity:0.75, fog:false }));
    s.renderOrder = 4;
    g.add(s);
    licks.push({ s, ph:rnd(0,6.283), k:rnd(0.55,0.9), a:(i/6)*6.283, d:0, base:1, y0:0, edge:true });
  }
  const ringMat = new THREE.MeshBasicMaterial({ color:0xff8a30, transparent:true, opacity:0.5,
    blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide, fog:false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.0, 40), ringMat);
  ring.rotation.x = -Math.PI/2;
  ring.renderOrder = 2;
  g.add(ring);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map:TEX_GLOW, color:0xff7020,
    blending:THREE.AdditiveBlending, depthWrite:false, transparent:true, opacity:0.35, fog:false }));
  glow.renderOrder = 3;
  g.add(glow);
  scene.add(g);
  return { g, licks, ring, glow, on:false, t:0, life:0, r:3, dps:14, byPlayer:true,
    conform:true, tick:0, emit:0, sfx:0, lh:null, p:new THREE.Vector3(), lp:new THREE.Vector3() };
}

function FX_fireStart(f, p, r, life, dps, byPlayer){
  f.p.copy(p);
  /* Очаг на земле стелется по рельефу, очаг на крыше или мостике — нет:
     иначе языки пламени провалятся сквозь настил к земле под ним. */
  const gy = terrainH(p.x, p.z);
  f.conform = (p.y - gy) < 0.7;
  f.p.y = f.conform ? gy : p.y;
  f.r = r; f.life = life; f.dps = dps; f.byPlayer = byPlayer;
  f.t = 0; f.tick = 0; f.emit = 0; f.sfx = 0; f.on = true;
  f.g.position.copy(f.p);
  f.g.visible = true;
  scene.add(f.g);                          // GM_clearFx мог выдернуть группу из сцены
  for(let i=0;i<f.licks.length;i++){
    const L = f.licks[i];
    L.a = L.edge ? L.a + rnd(-0.25,0.25) : rnd(0,6.283);
    L.d = L.edge ? r*rnd(0.86,0.98) : r*rnd(0,0.62);
    const x = Math.cos(L.a)*L.d, z = Math.sin(L.a)*L.d;
    L.base = (L.edge ? 0.75 : 1.5) * clamp(r/3.2, 0.55, 2.2);
    // язык стоит на своей точке рельефа, иначе на склоне пламя висит в воздухе
    L.y0 = (f.conform ? terrainH(f.p.x + x, f.p.z + z) - f.p.y : 0) + L.base*0.32;
    L.s.position.set(x, L.y0, z);
    L.s.scale.setScalar(L.base);
  }
  f.ring.scale.set(r, 1, r);
  f.ring.position.y = 0.07;
  f.glow.position.set(0, r*0.32, 0);
  f.glow.scale.setScalar(r*2.1);
  f.lp.set(f.p.x, f.p.y + 0.75, f.p.z);
  if(typeof LIGHTS !== 'undefined' && LIGHTS && LIGHTS.addStatic)
    f.lh = LIGHTS.addStatic(f.lp, 0xff7a2c, 2.6, Math.max(10, r*6.5));
}

function FX_fireStop(f){
  if(!f.on) return;
  f.on = false;
  f.g.visible = false;
  if(f.lh && typeof LIGHTS !== 'undefined' && LIGHTS && LIGHTS.removeStatic) LIGHTS.removeStatic(f.lh);
  f.lh = null;
}

/* Кадр очага. Возвращает false, когда очаг догорел. */
function FX_fireStep(f, dt){
  f.t += dt;
  if(f.t >= f.life) return false;
  const fade = clamp((f.life - f.t)/1.6, 0, 1);      // последние полторы секунды догорает
  const grow = clamp(f.t/0.35, 0, 1);                // и столько же разгорается
  const amp = fade*grow;

  /* --- языки пламени --- */
  for(let i=0;i<f.licks.length;i++){
    const L = f.licks[i];
    const w = 0.72 + 0.34*Math.sin(f.t*8.5 + L.ph) + 0.14*Math.sin(f.t*17 + L.ph*2);
    L.s.scale.setScalar(L.base*w*L.k*amp);
    L.s.position.y = L.y0 + 0.13*Math.sin(f.t*6 + L.ph);
    L.s.material.rotation = 0.22*Math.sin(f.t*3 + L.ph);
    L.s.material.opacity = (L.edge ? 0.7 : 0.9) * amp;
  }
  /* --- граница зоны: пульсирует, чтобы её было видно и краем глаза --- */
  f.ring.material.opacity = (0.28 + 0.20*Math.sin(f.t*4.2)) * amp;
  f.ring.scale.x = f.ring.scale.z = f.r*(1 + 0.02*Math.sin(f.t*4.2));
  f.glow.material.opacity = (0.22 + 0.12*Math.sin(f.t*5.1)) * amp;

  /* --- угли и дым: непрерывная эмиссия с ограничением по частоте --- */
  f.emit += dt*(11 + f.r*3.5)*amp;
  while(f.emit >= 1){
    f.emit -= 1;
    const a = rnd(0, 6.283), d = Math.sqrt(Math.random())*f.r*0.92;
    const x = f.p.x + Math.cos(a)*d, z = f.p.z + Math.sin(a)*d;
    const y = f.conform ? terrainH(x, z) : f.p.y;
    if(Math.random() < 0.62){
      // уголёк
      const e = FX_E0();
      e.life = rnd(0.7, 1.8);
      e.vx = rnd(-0.5,0.5); e.vz = rnd(-0.5,0.5); e.vy = rnd(1.6, 4.2);
      e.g = -1.2; e.dr = 0.55;
      e.s0 = rnd(0.10, 0.26); e.s1 = 0.01;
      FX_c0(0xfff0c0); FX_c1(0xff4a10);
      e.a0 = 0.95;
      FX_emit(FX_ADD, x, y + 0.15, z);
    } else {
      // дым
      const e = FX_E0();
      e.life = rnd(1.5, 3.0);
      e.vx = rnd(-0.6,0.6) + wind.x*0.9; e.vz = rnd(-0.6,0.6) + wind.z*0.9;
      e.vy = rnd(1.4, 2.8);
      e.g = -0.9; e.dr = 0.5;
      e.s0 = 0.35; e.s1 = rnd(1.5, 2.9);
      FX_c0(0x4a4038); FX_c1(0x8b8177);
      e.a0 = 0.30;
      FX_emit(FX_SMO, x, y + 0.35, z);
    }
  }

  /* --- свет: живой, с двойным мерцанием --- */
  if(f.lh && typeof LIGHTS !== 'undefined' && LIGHTS && LIGHTS.setStatic){
    const flick = 0.78 + 0.26*Math.sin(f.t*13.3) + 0.14*Math.sin(f.t*7.1 + 1.3);
    LIGHTS.setStatic(f.lh, 2.6*flick*amp*clamp(f.r/3.2, 0.6, 2.0));
  }

  /* --- звук: редко и негромко, иначе очаг забивает выстрелы --- */
  f.sfx -= dt;
  if(f.sfx <= 0){ f.sfx = rnd(0.55, 1.0); SFX.flame(panOf(f.p), 0.22*volOf(f.p)*amp); }

  /* --- урон: тиками по 0.4 с, а не каждый кадр ---
     И applyBurn(total) у бота, и burnPlayer(total) у игрока НАКОПИТЕЛЬНЫЕ:
     запас «с головой» тут превращается в потолок горения за пару секунд и
     в шлейф на несколько секунд после выхода из огня. Поэтому обе цели
     получают ровно dps × интервал — тик очага равен одному тику горения. */
  f.tick -= dt;
  if(f.tick <= 0){
    f.tick = 0.4;
    const rr = f.r*f.r;
    for(let i=0;i<enemies.length;i++){
      const e = enemies[i];
      if(!e.alive) continue;
      const dx = e.pos.x - f.p.x, dz = e.pos.z - f.p.z;
      if(dx*dx + dz*dz > rr) continue;
      if(e.pos.y < f.p.y - 1.6 || e.pos.y > f.p.y + 2.6) continue;
      /* Как и с прямым поджогом: у не-хоста боты — реплики без update(),
         накопленный burn с них не стечёт. Заявляем порцию хосту. */
      if(!NET_ACTIVE || NET.host) e.applyBurn(f.dps*0.4, true);
      else if(f.byPlayer) NET.reportBotHit(e.id, f.dps*0.4, 'burn', 2);
    }
    if(player.alive && game.state === 'play'){
      const dx = player.pos.x - f.p.x, dz = player.pos.z - f.p.z;
      if(dx*dx + dz*dz <= rr && player.pos.y > f.p.y - 1.6 && player.pos.y < f.p.y + 2.6){
        if(typeof burnPlayer === 'function') burnPlayer(f.dps*0.4);
        else hurtPlayer(f.dps*0.4, f.p, 'ОГОНЬ');
      }
    }
  }
  return true;
}

/* ===================== ЦИФРЫ УРОНА: текстуры ===================== */
/* Значения урона повторяются десятками, поэтому холст рисуем один раз на
   строку. Кэш переживает даже чужой dispose(): three заново зальёт текстуру
   из холста, который никуда не делся. */
function FX_numTex(txt){
  let e = FX_numCache.get(txt);
  if(e) return e;
  let F = 62;
  FX_numCtx.font = FX_NUMFONT;
  let tw = FX_numCtx.measureText(txt).width;
  if(tw > 300){ F = Math.max(22, Math.floor(62*300/tw)); }
  const font = 'bold ' + F + 'px "Arial Black", "Arial Bold", Arial, sans-serif';
  FX_numCtx.font = font;
  tw = FX_numCtx.measureText(txt).width;
  const c = document.createElement('canvas');
  c.width = clamp(Math.ceil(tw) + 36, 80, 384); c.height = 96;
  const x = c.getContext('2d');
  x.font = font; x.textAlign = 'center'; x.textBaseline = 'middle';
  // тень + толстая обводка: на светлом песке белая цифра иначе исчезает
  x.shadowColor = 'rgba(0,0,0,0.55)'; x.shadowBlur = 12; x.shadowOffsetY = 4;
  x.lineJoin = 'round'; x.lineWidth = 11; x.strokeStyle = '#100e0b';
  x.strokeText(txt, c.width/2, 50);
  x.shadowColor = 'rgba(0,0,0,0)'; x.shadowBlur = 0; x.shadowOffsetY = 0;
  x.lineWidth = 4; x.strokeStyle = 'rgba(24,20,15,0.95)';
  x.strokeText(txt, c.width/2, 50);
  x.fillStyle = '#ffffff';
  x.fillText(txt, c.width/2, 50);
  const t = new THREE.CanvasTexture(c);
  t.minFilter = THREE.LinearFilter; t.generateMipmaps = false;
  e = { t, ar: c.width/c.height };
  FX_numCache.set(txt, e);
  if(FX_numCache.size > 96){
    const k = FX_numCache.keys().next().value;
    const old = FX_numCache.get(k);
    FX_numCache.delete(k);
    if(old) old.t.dispose();
  }
  return e;
}

/* ============================== ВЗРЫВ ============================== */
/* Индекс фугаса в поясе. Взрыв бывает только от него, но единицу здесь
   хардкодить нельзя: порядок AMMO задаёт 10_core.js, и перестановка типов
   молча разошлась бы с сетевыми заявками. Ищем один раз — AMMO не меняется. */
let FX_fragIdx = -1;
/* Тип боеприпаса для заявки: если вызывающий передал его от пули (§9.3) —
   берём его, иначе честно достаём фугас из AMMO. */
function FX_ammoIdx(a){
  if(a >= 0) return a|0;
  if(FX_fragIdx < 0){
    for(let i=0;i<AMMO.length;i++) if(AMMO[i].id === 'frag'){ FX_fragIdx = i; break; }
    if(FX_fragIdx < 0) FX_fragIdx = 0;      // пояса без фугаса не бывает, но падать не станем
  }
  return FX_fragIdx;
}

/* Урон — строго splashDamage(): covered берём по losClear() от эпицентра к
   центру цели. Крита у фугаса нет ни при каких условиях, поэтому e.hurt()
   зовём с частью 'splash', а не 'head'.
   Достаётся всем, включая стрелка: выстрел себе под ноги обязан наказывать.
   ammoIdx — необязательный: индекс боеприпаса ПУЛИ, породившей разрыв. Нужен
   только сетевым заявкам; чужой разрыв (92_net.js) зовёт нас без него и без
   урона вовсе. */
function explode(p, R, maxDmg, byPlayer, fall, coverMul, ammoIdx){
  FX_p.copy(p);
  const s = clamp(R/5.2, 0.45, 2.2);
  const gy = terrainH(FX_p.x, FX_p.z);
  const lowAir = (FX_p.y - gy) < R*0.75;

  /* ---------------------------- ВИЗУАЛ ---------------------------- */
  FX_flash(FX_p, 0xffbe6a, 8.5*s, 28*s, 0.30);
  FX.ring(FX_p, R*1.15, 0xffd39a);

  // ядро: белая вспышка, живёт полтора десятка кадров
  let e;
  for(let i=0;i<5;i++){
    e = FX_E0();
    e.life = rnd(0.10, 0.20);
    e.vx = rnd(-2,2)*s; e.vy = rnd(-1,2)*s; e.vz = rnd(-2,2)*s;
    e.s0 = rnd(1.5, 2.6)*s; e.s1 = 0.4*s;
    FX_c0(0xfffdf0); FX_c1(0xffc061);
    e.a0 = 1;
    FX_emit(FX_ADD, FX_p.x, FX_p.y, FX_p.z);
  }
  // огненные языки: летят наружу и гаснут из белого в тёмно-красный
  for(let i=0;i<26;i++){
    e = FX_E0();
    e.life = rnd(0.30, 0.75);
    const a = rnd(0,6.283), el = rnd(-0.45, 1.0), sp = rnd(5, 17)*s;
    const ch = Math.cos(el);
    e.vx = Math.cos(a)*ch*sp; e.vz = Math.sin(a)*ch*sp; e.vy = Math.sin(el)*sp + rnd(1,4);
    e.g = 3.5; e.dr = 2.3;
    e.s0 = rnd(0.5,1.1)*s; e.s1 = rnd(0.05,0.3)*s;
    FX_c0(0xfff2c0); FX_c1(0x8e2205);
    e.a0 = 1;
    FX_emit(FX_ADD, FX_p.x, FX_p.y, FX_p.z);
  }
  // искры-осколки: мелкие, быстрые, бьются о землю
  for(let i=0;i<22;i++){
    e = FX_E0();
    e.life = rnd(0.4, 1.1);
    const a = rnd(0,6.283), el = rnd(-0.2, 1.1), sp = rnd(9, 26)*s;
    const ch = Math.cos(el);
    e.vx = Math.cos(a)*ch*sp; e.vz = Math.sin(a)*ch*sp; e.vy = Math.sin(el)*sp;
    e.g = 20; e.dr = 0.6; e.gc = 1;
    e.s0 = rnd(0.05,0.10); e.s1 = 0.005;
    FX_c0(0xfff4cc); FX_c1(0xff5a12);
    e.a0 = 1;
    FX_emit(FX_ADD, FX_p.x, FX_p.y, FX_p.z);
  }
  // дым: медленный, растущий, сносится ветром — по нему видно место разрыва
  for(let i=0;i<16;i++){
    e = FX_E0();
    e.life = rnd(1.6, 3.2);
    const a = rnd(0,6.283), sp = rnd(0.8, 4.5)*s;
    e.vx = Math.cos(a)*sp + wind.x*1.2; e.vz = Math.sin(a)*sp + wind.z*1.2;
    e.vy = rnd(1.2, 3.6);
    e.g = -0.7; e.dr = 0.8;
    // клубы не раздуваем сверх меры: точечный спрайт отсекается по центру,
    // и слишком большой клуб мигал бы на краю экрана
    e.s0 = 0.5*s; e.s1 = rnd(1.8, 3.4)*s;
    FX_c0(0x322b25); FX_c1(0x8f867c);
    e.a0 = 0.42;
    FX_emit(FX_SMO, FX_p.x, FX_p.y + 0.2, FX_p.z);
  }
  // обломки и выброс грунта
  FX.burst(FX_p, 16, { mat:PMAT.debris, speed:13*s, life:1.3, size:0.13*s, drag:0.3, bounce:0.32, surf:false });
  if(lowAir){
    FX_v4.set(FX_p.x, gy + 0.05, FX_p.z);
    const k = FX_terrainKind(FX_v4);
    const mm = (k==='grass') ? PMAT.grass : (k==='dirt') ? PMAT.dirt : (k==='sand') ? PMAT.sand : PMAT.stone;
    FX.burst(FX_v4, 18, { mat:mm, speed:11*s, life:1.1, size:0.11*s, g:16, surf:false });
    // приземный «воротник» пыли — читается даже когда сам разрыв за укрытием
    const dc = FX_DUSTCOL[k] || FX_DUSTCOL.dirt;
    for(let i=0;i<12;i++){
      e = FX_E0();
      e.life = rnd(0.9, 1.9);
      const a = (i/12)*6.283 + rnd(-0.2,0.2), sp = rnd(4, 9)*s;
      e.vx = Math.cos(a)*sp; e.vz = Math.sin(a)*sp; e.vy = rnd(0.4, 1.8);
      e.g = -0.2; e.dr = 1.7;
      e.s0 = 0.4*s; e.s1 = rnd(1.6, 2.8)*s;
      FX_c0(dc); FX_c1(dc);
      FX_E.r1 *= 0.6; FX_E.g1 *= 0.6; FX_E.b1 *= 0.6;
      e.a0 = 0.34;
      FX_emit(FX_SMO, FX_p.x, gy + 0.15, FX_p.z);
    }
    terrainN(FX_p.x, FX_p.z, FX_v3);
    FX_v4.set(FX_p.x, gy, FX_p.z);
    FX.decal(FX_v4, FX_v3, 'scorch', clamp(R*0.42, 0.8, 3.2));
    for(let i=0;i<3;i++){
      const a = rnd(0,6.283), d = rnd(R*0.25, R*0.7);
      const x = FX_p.x + Math.cos(a)*d, z = FX_p.z + Math.sin(a)*d;
      terrainN(x, z, FX_v3);
      FX_v4.set(x, terrainH(x,z), z);
      FX.decal(FX_v4, FX_v3, 'scorch', rnd(0.4, 0.9)*s);
    }
  }

  SFX.boom(panOf(FX_p), volOf(FX_p));
  // тряска затухает с расстоянием: разрыв на другом конце карты не должен
  // сбивать прицел, а под ногами — обязан
  const dc2 = FX_p.distanceTo(camera.position);
  const kk = clamp(1 - dc2/(12 + R*5.5), 0, 1);
  shake(0.10 + 0.80*kk*kk);

  /* ---------------------------- УРОН ---------------------------- */
  // В сети здоровье ботов ведёт хост: реплики трогать нельзя, иначе у каждого
  // клиента получится своя версия боя. Не-хост только заявляет попадание.
  const botsLocal = !NET_ACTIVE || NET.host;
  // считаем один раз на взрыв, а не на каждого задетого бота
  const ai = (NET_ACTIVE && byPlayer && !botsLocal) ? FX_ammoIdx(ammoIdx === undefined ? -1 : ammoIdx) : 0;
  for(let i=0;i<enemies.length;i++){
    const en = enemies[i];
    if(!en.alive) continue;
    const c = en.center(FX_v1);
    const d = c.distanceTo(FX_p);
    if(d >= R) continue;
    const dmg = splashDamage(d, R, maxDmg, fall, !losClear(FX_p, c), coverMul);
    if(dmg <= 0.5) continue;
    if(botsLocal) en.hurt(dmg, 'splash', c);
    else if(byPlayer) NET.reportBotHit(en.id, dmg, 'splash', ai);
  }
  /* Самоподрыв: выстрел себе под ноги обязан наказывать и в сети. Но hp там
     принадлежит серверу (§9.1), поэтому идём тем же путём, что и любой другой
     урон игроку, — через hurtPlayer() из 75_combat.js, который сам решает,
     списать локально или отправить заявку. Своего сетевого пути тут нет
     намеренно: иначе самоподрыв учтётся дважды. */
  if(player.alive && game.state === 'play'){
    const c = playerCenter(FX_v1);
    const d = c.distanceTo(FX_p);
    if(d < R){
      const dmg = splashDamage(d, R, maxDmg, fall, !losClear(FX_p, c), coverMul);
      if(dmg > 0.5) hurtPlayer(dmg, FX_p, 'ФУГАС');
    }
  }
  // Чужие игроки: их накрытие считает тот, кто стрелял, — той же формулой
  if(NET_ACTIVE && byPlayer) NET.reportBoom(FX_p, R, maxDmg, fall, coverMul);
}
