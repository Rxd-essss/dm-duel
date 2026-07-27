/* =====================================================================
   DM_DUEL v3 — модели: снайперская винтовка и боец RED/BLU.

   Стиль — Team Fortress 2: крупные читаемые объёмы, утрированные
   пропорции, плотный силуэт. Мелкие детали существуют только там, где
   они видны игроку (винтовка перед лицом) либо работают на силуэт
   (шляпа, разгрузка, оптика).

   Почему тут «билдер» вместо десятков отдельных мешей: модель бойца
   рисуется до пяти раз за кадр, винтовка — ещё чаще (пять врагов плюс
   вьюмодель). Деталей нужно много, а вызовов отрисовки — мало, поэтому
   все статические куски одного анимируемого узла сливаются в один меш
   на материал, а готовая геометрия кэшируется по ключу и переиспользуется
   всеми экземплярами. Разбивать модель на узлы приходится ровно по тем
   местам, которые двигает ИИ (см. userData ниже).
   ===================================================================== */

/* --------------------------- ХЕЛПЕРЫ МОДЕЛЕЙ --------------------------- */
function mBox(w,h,d,mat,x,y,z){
  const m = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), mat);
  m.position.set(x||0,y||0,z||0);
  m.castShadow = true; m.receiveShadow = true; m.userData.shadowy = true;
  return m;
}
function mCyl(rt,rb,h,seg,mat,x,y,z){
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt,rb,h,seg), mat);
  m.position.set(x||0,y||0,z||0);
  m.castShadow = true; m.userData.shadowy = true;
  return m;
}

/* ---- исходные формы: одна геометрия на размер, дальше только слияние ---- */
const MDL_SHAPES = new Map();
function MDL_boxG(w,h,d){
  const k = 'b'+w+'_'+h+'_'+d;
  let g = MDL_SHAPES.get(k);
  if(!g){ g = new THREE.BoxGeometry(w,h,d); MDL_SHAPES.set(k,g); }
  return g;
}
function MDL_cylG(rt,rb,h,seg){
  const k = 'c'+rt+'_'+rb+'_'+h+'_'+seg;
  let g = MDL_SHAPES.get(k);
  if(!g){ g = new THREE.CylinderGeometry(rt,rb,h,seg); MDL_SHAPES.set(k,g); }
  return g;
}
function MDL_sphG(r,ws,hs){
  const k = 's'+r+'_'+ws+'_'+hs;
  let g = MDL_SHAPES.get(k);
  if(!g){ g = new THREE.SphereGeometry(r,ws,hs); MDL_SHAPES.set(k,g); }
  return g;
}
function MDL_discG(r,seg){
  const k = 'd'+r+'_'+seg;
  let g = MDL_SHAPES.get(k);
  if(!g){ g = new THREE.CircleGeometry(r,seg); MDL_SHAPES.set(k,g); }
  return g;
}

/* ---- материалы ---- */
const MDL_MATS = new Map();
/* Процедурные текстуры живут в 22_tex.js. Модуль грузится раньше нас, но
   если текстур в сборке ещё нет — не падаем, а работаем на плоском тоне. */
function MDL_mat(color, tex, rx, ry){
  if(typeof toonT === 'function') return toonT(color, tex, rx===undefined?1:rx, ry===undefined?1:ry);
  return toon(color);
}
/* Самосветящийся материал: руны и линзы не должны зависеть от освещения. */
function MDL_glow(color, opacity){
  const k = 'g'+color+'_'+(opacity===undefined?1:opacity);
  let m = MDL_MATS.get(k);
  if(!m){
    m = (opacity===undefined || opacity>=1)
      ? new THREE.MeshBasicMaterial({color})
      : new THREE.MeshBasicMaterial({color, transparent:true, opacity, side:THREE.DoubleSide});
    MDL_MATS.set(k, m);
  }
  return m;
}

/* ---- накопитель кусков одного узла ---- */
const MDL_Q = new THREE.Quaternion();
const MDL_E = new THREE.Euler();
const MDL_P = new THREE.Vector3();
const MDL_S = new THREE.Vector3(1,1,1);

function MDL_Kit(){ this.parts = []; }
MDL_Kit.prototype.add = function(geo, mat, x,y,z, rx,ry,rz){
  MDL_E.set(rx||0, ry||0, rz||0);
  MDL_Q.setFromEuler(MDL_E);
  MDL_P.set(x||0, y||0, z||0);
  this.parts.push({ geo, mat, m: new THREE.Matrix4().compose(MDL_P, MDL_Q, MDL_S) });
  return this;
};
MDL_Kit.prototype.box = function(w,h,d, mat, x,y,z, rx,ry,rz){ return this.add(MDL_boxG(w,h,d), mat, x,y,z, rx,ry,rz); };
MDL_Kit.prototype.cyl = function(rt,rb,h,seg, mat, x,y,z, rx,ry,rz){ return this.add(MDL_cylG(rt,rb,h,seg), mat, x,y,z, rx,ry,rz); };
MDL_Kit.prototype.sph = function(r,ws,hs, mat, x,y,z){ return this.add(MDL_sphG(r,ws,hs), mat, x,y,z); };
MDL_Kit.prototype.disc = function(r,seg, mat, x,y,z, rx,ry,rz){ return this.add(MDL_discG(r,seg), mat, x,y,z, rx,ry,rz); };
/* Отрезок ремня в плоскости YZ: сам считает наклон, чтобы концы сходились. */
MDL_Kit.prototype.strap = function(mat, x, y0,z0, y1,z1, w, t){
  const dy = y1-y0, dz = z1-z0, len = Math.hypot(dy,dz);
  return this.box(w, t, len, mat, x, (y0+y1)*0.5, (z0+z1)*0.5, Math.atan2(-dy, dz), 0, 0);
};

/* ---- слияние: один меш на материал ---- */
const MDL_NM = new THREE.Matrix3();
const MDL_V = new THREE.Vector3();
function MDL_merge(list){
  let vc = 0, ic = 0;
  for(const it of list){
    vc += it.geo.attributes.position.count;
    ic += it.geo.index ? it.geo.index.count : it.geo.attributes.position.count;
  }
  const pos = new Float32Array(vc*3), nor = new Float32Array(vc*3), uvs = new Float32Array(vc*2);
  const idx = vc > 65535 ? new Uint32Array(ic) : new Uint16Array(ic);
  let vo = 0, io = 0;
  for(const it of list){
    const g = it.geo, p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv;
    MDL_NM.getNormalMatrix(it.m);
    const cnt = p.count;
    for(let i=0;i<cnt;i++){
      MDL_V.set(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(it.m);
      pos[(vo+i)*3] = MDL_V.x; pos[(vo+i)*3+1] = MDL_V.y; pos[(vo+i)*3+2] = MDL_V.z;
      if(n){
        MDL_V.set(n.getX(i), n.getY(i), n.getZ(i)).applyMatrix3(MDL_NM).normalize();
        nor[(vo+i)*3] = MDL_V.x; nor[(vo+i)*3+1] = MDL_V.y; nor[(vo+i)*3+2] = MDL_V.z;
      }
      if(u){ uvs[(vo+i)*2] = u.getX(i); uvs[(vo+i)*2+1] = u.getY(i); }
    }
    if(g.index){ for(let i=0;i<g.index.count;i++) idx[io+i] = vo + g.index.getX(i); io += g.index.count; }
    else { for(let i=0;i<cnt;i++) idx[io+i] = vo+i; io += cnt; }
    vo += cnt;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos,3));
  geo.setAttribute('normal',   new THREE.BufferAttribute(nor,3));
  geo.setAttribute('uv',       new THREE.BufferAttribute(uvs,2));
  geo.setIndex(new THREE.BufferAttribute(idx,1));
  geo.computeBoundingSphere();
  return geo;
}

/* Собрать узел: fill(kit) описывает детали, результат кэшируется по key,
   поэтому пятеро ботов делят одну и ту же геометрию. */
const MDL_CACHE = new Map();
function MDL_node(key, parent, fill){
  let baked = MDL_CACHE.get(key);
  if(!baked){
    const kit = new MDL_Kit();
    fill(kit);
    const byMat = new Map();
    for(const it of kit.parts){
      let arr = byMat.get(it.mat);
      if(!arr){ arr = []; byMat.set(it.mat, arr); }
      arr.push(it);
    }
    baked = [];
    byMat.forEach((arr, mat)=> baked.push({ geo: MDL_merge(arr), mat }));
    MDL_CACHE.set(key, baked);
  }
  for(const b of baked){
    const m = new THREE.Mesh(b.geo, b.mat);
    m.castShadow = true; m.receiveShadow = true; m.userData.shadowy = true;
    parent.add(m);
  }
  return parent;
}

/* =====================================================================
   СНАЙПЕРСКАЯ ВИНТОВКА

   Ствол строго вдоль -Z, дуло в z = -1.02 — на это завязаны вспышка
   вьюмодели, телеграф-луч ботов и Enemy.muzzle(). Ось ствола — y = 0.02,
   ось оптики — y = 0.115 (там же сидит блик, который видит игрок).
   userData: bolt — узел затвора (крутит updateWeapon), muzzle — точка
   дула, lens — линза объектива.
   ===================================================================== */
function mkRifle(team, big){
  const G = new THREE.Group();

  const wood  = MDL_mat(0x7d4c27, 'wood',  1, 2);
  const woodD = MDL_mat(0x593317, 'wood',  1, 1);
  const met   = MDL_mat(0x555a60, 'metal', 1, 1);
  const metD  = MDL_mat(0x2e3135, 'metal', 1, 1);
  const steel = MDL_mat(0x8d939b, 'metal', 1, 1);
  const leath = MDL_mat(PAL.leather, 'cloth', 1, 1);
  const teamM = MDL_mat(team, 'cloth', 1, 1);
  const rune  = MDL_glow(PAL.rune);
  const bore  = MDL_glow(0x0a0b0c);

  MDL_node('rf|'+team+'|'+(big?1:0), G, k=>{
    /* --- приклад: тело, гребень под щёку, затыльник --- */
    k.box(0.088,0.180,0.30, wood,  0,-0.020,0.60);
    k.box(0.086,0.155,0.36, wood,  0,-0.005,0.29);
    k.box(0.104,0.062,0.34, wood,  0, 0.078,0.46);          // щека
    k.box(0.106,0.030,0.10, woodD, 0, 0.096,0.30, 0.28,0,0); // скос гребня
    k.box(0.098,0.196,0.036, metD, 0,-0.020,0.752);          // затыльник
    k.box(0.102,0.048,0.055, metD, 0, 0.078,0.742);          // пятка затыльника
    k.box(0.090,0.030,0.055, woodD,0,-0.112,0.700);          // носок приклада
    k.cyl(0.016,0.016,0.05,6, metD, 0,-0.118,0.62, 0,0,Math.PI/2); // антабка

    /* --- шейка и пистолетная рукоять --- */
    k.box(0.076,0.140,0.28, wood,  0,-0.082,0.125);
    k.box(0.078,0.200,0.115, wood, 0,-0.170,0.155, 0.18,0,0);
    k.box(0.086,0.130,0.078, woodD,0,-0.192,0.150, 0.18,0,0); // насечка под ладонь
    k.box(0.088,0.036,0.10, woodD, 0,-0.052,0.245);           // гребешок за коробкой

    /* --- спусковая скоба --- */
    k.box(0.050,0.022,0.170, met, 0,-0.118,0.020);
    k.box(0.050,0.060,0.022, met, 0,-0.100,0.098);
    k.box(0.050,0.050,0.022, met, 0,-0.095,-0.058);
    k.box(0.018,0.058,0.024, steel, 0,-0.092,0.042, -0.22,0,0);

    /* --- ствольная коробка --- */
    k.box(0.090,0.126,0.46, met,  0, 0.012,-0.10);
    k.box(0.058,0.038,0.42, metD, 0, 0.084,-0.10);           // основание колец
    k.box(0.100,0.030,0.14, met,  0,-0.048,-0.02);           // спусковая коробка снизу
    // окно выброса — справа, где ходит затвор; слева гладкая плоскость под гравировку
    k.box(0.011,0.092,0.215, steel, 0.046,0.038,-0.160);     // рамка окна выброса
    k.box(0.013,0.064,0.175, metD,  0.049,0.038,-0.160);     // само окно
    k.box(0.030,0.030,0.030, steel, -0.050,-0.010,0.070, 0,0,0.5); // флажок предохранителя

    /* --- рунная гравировка на левой щеке коробки: слабо светится, «вайб» --- */
    k.box(0.006,0.080,0.013, rune, -0.047, 0.020,-0.165);
    k.box(0.006,0.013,0.058, rune, -0.047, 0.050,-0.165);
    k.box(0.006,0.013,0.046, rune, -0.047,-0.008,-0.165);
    k.box(0.006,0.032,0.032, rune, -0.047, 0.020,-0.240, 0.78,0,0);
    k.box(0.006,0.058,0.012, rune, -0.047, 0.020,-0.060);
    k.box(0.006,0.013,0.050, rune, -0.047, 0.040,-0.060);

    /* --- магазин --- */
    k.box(0.090,0.160,0.140, metD, 0,-0.118,-0.025, 0.08,0,0);
    k.box(0.104,0.028,0.160, met,  0,-0.198,-0.031, 0.08,0,0);
    k.box(0.032,0.052,0.032, steel,0,-0.058, 0.058);         // защёлка

    /* --- цевьё с накладками --- */
    k.box(0.082,0.092,0.50, wood,  0,-0.032,-0.45);
    k.box(0.096,0.058,0.44, woodD, 0,-0.012,-0.45);          // боковые накладки
    for(const zz of [-0.30,-0.44,-0.58]) k.box(0.102,0.034,0.052, woodD, 0,-0.012,zz);
    k.box(0.074,0.036,0.36, wood,  0, 0.058,-0.44);          // верхняя накладка
    k.box(0.088,0.098,0.030, woodD,0,-0.032,-0.706);         // наконечник цевья
    k.box(0.104,0.116,0.038, met,  0,-0.006,-0.694);         // ложевое кольцо
    k.cyl(0.015,0.015,0.05,6, metD, 0,-0.088,-0.640, 0,0,Math.PI/2); // передняя антабка

    /* --- ствол и дульный тормоз --- */
    k.cyl(0.030,0.033,0.92,8, metD, 0, 0.020,-0.50, Math.PI/2);
    k.cyl(0.036,0.036,0.06,8, met,  0, 0.020,-0.74, Math.PI/2);
    k.cyl(0.033,0.033,0.020,8, rune, 0,0.020,-0.855, Math.PI/2);  // рунное кольцо
    k.cyl(0.046,0.042,0.16,8, met,  0, 0.020,-0.965, Math.PI/2);
    for(const zz of [-0.915,-0.965,-1.015]) k.box(0.098,0.015,0.028, metD, 0,0.020,zz);
    k.cyl(0.050,0.050,0.024,8, metD, 0,0.020,-1.052, Math.PI/2);
    k.cyl(0.026,0.026,0.014,8, bore, 0,0.020,-1.058, Math.PI/2);  // срез канала ствола
    k.box(0.018,0.078,0.022, metD, 0, 0.078,-0.800);              // мушка
    k.box(0.048,0.022,0.055, metD, 0, 0.046,-0.800);

    /* --- оптика: тело, кольца, барабанчики с биговкой --- */
    k.cyl(0.040,0.040,0.46,10, metD, 0,0.115,-0.10, Math.PI/2);
    k.cyl(0.053,0.045,0.11,10, metD, 0,0.115,-0.29, Math.PI/2);   // раструб объектива
    k.cyl(0.055,0.055,0.020,10, met, 0,0.115,-0.348, Math.PI/2);
    k.cyl(0.050,0.045,0.10,10, metD, 0,0.115, 0.09, Math.PI/2);   // окуляр
    k.cyl(0.054,0.054,0.055,10, leath, 0,0.115,0.158, Math.PI/2); // наглазник
    for(const zz of [-0.22, 0.02]){
      k.box(0.054,0.090,0.038, met,   0,0.074,zz);
      k.box(0.064,0.020,0.030, steel, 0,0.040,zz);
    }
    // барабанчик вертикальных поправок: шестигранник читается как биговка
    k.cyl(0.030,0.035,0.052,10, met,  0,0.166,-0.10);
    k.cyl(0.037,0.037,0.032,6,  metD, 0,0.192,-0.10);
    k.cyl(0.022,0.022,0.016,8,  steel,0,0.214,-0.10);
    k.box(0.008,0.030,0.008, rune, 0,0.192,-0.138);               // светящаяся метка
    // горизонтальные поправки и параллакс
    k.cyl(0.029,0.033,0.050,10, met,  0.053,0.115,-0.10, 0,0,Math.PI/2);
    k.cyl(0.035,0.035,0.030,6,  metD, 0.078,0.115,-0.10, 0,0,Math.PI/2);
    k.cyl(0.028,0.031,0.042,10, met, -0.051,0.115,-0.055, 0,0,Math.PI/2);
    k.cyl(0.034,0.034,0.026,6,  metD,-0.073,0.115,-0.055, 0,0,Math.PI/2);

    /* --- ремень: провисает под винтовкой, читается на силуэте --- */
    k.strap(leath, 0, -0.105,-0.640, -0.250,-0.330, 0.052, 0.014);
    k.strap(leath, 0, -0.250,-0.330, -0.262, 0.300, 0.052, 0.014);
    k.strap(leath, 0, -0.262, 0.300, -0.130, 0.615, 0.052, 0.014);

    /* --- командная лента на прикладе --- */
    k.box(0.100,0.190,0.070, teamM, 0,-0.010,0.200);
    k.box(0.014,0.150,0.055, teamM, -0.052,-0.100,0.205, 0.22,0,0.12);

    /* --- сошки: только у ботов, добавляют массы силуэту --- */
    if(big){
      k.box(0.058,0.062,0.080, metD, 0,-0.095,-0.745);       // узел крепления под цевьём
      for(const sx of [-1,1]){
        k.cyl(0.013,0.010,0.36,5, metD, sx*0.078,-0.222,-0.731, 0.18,0,sx*0.42);
        k.box(0.034,0.024,0.072, metD, sx*0.150,-0.393,-0.700);
      }
    }
  });

  /* Затвор — отдельный узел: updateWeapon крутит его rotation.z и тянет
     position.z, поэтому база обязана остаться (0.05, 0.03, 0.05). */
  const bolt = new THREE.Group();
  bolt.position.set(0.05,0.03,0.05);
  G.add(bolt);
  MDL_node('rf.bolt', bolt, k=>{
    k.cyl(0.024,0.024,0.24,8, steel, 0,0,0, Math.PI/2);
    k.cyl(0.031,0.031,0.05,8, metD,  0,0,0.135, Math.PI/2);   // хвостовик
    k.box(0.100,0.026,0.030, steel, 0.043,-0.025,0.055, 0,0,-0.52); // рукоять
    k.sph(0.029,8,6, steel, 0.087,-0.050,0.055);              // шарик
  });

  /* Линзы отдельными мешами: userData.lens по контракту — меш. */
  const lensM = MDL_glow(0x9fd8ff, 0.85);
  const lens = new THREE.Mesh(MDL_discG(0.042,12), lensM);
  lens.position.set(0,0.115,-0.356); lens.rotation.y = Math.PI;
  G.add(lens);
  const ocular = new THREE.Mesh(MDL_discG(0.040,12), lensM);
  ocular.position.set(0,0.115,0.188);
  G.add(ocular);

  /* Пустышка в точке дула — эффектам удобнее брать её, чем считать смещение. */
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0,0.02,-1.02);
  G.add(muzzle);

  G.userData = { bolt, muzzle, lens, ocular };
  return G;
}

/* =====================================================================
   БОЕЦ

   Скелет менять нельзя: ИИ каждый кадр правит userData-узлы и их
   базовые высоты (hips 0.86, torso 0.86, head 1.40, плечи 1.20,
   винтовка 1.24). Всё остальное — начинка узлов.
   ===================================================================== */
function mkSniper(team, teamDk){
  const G = new THREE.Group();

  const skin   = toon(PAL.skin);
  const glass  = toon(PAL.glassDk);
  const dark   = toon(PAL.dark);
  const shirt  = MDL_mat(PAL.khaki,   'cloth', 2, 2);
  const shirtD = MDL_mat(PAL.khakiDk, 'cloth', 2, 2);
  const vest   = MDL_mat(team,   'cloth', 1, 1);
  const vestD  = MDL_mat(teamDk, 'cloth', 1, 1);
  const pants  = MDL_mat(0x6e6a58, 'cloth', 2, 2);
  const boot   = MDL_mat(0x3d3025, 'cloth', 1, 1);
  const leath  = MDL_mat(PAL.leather, 'cloth', 1, 1);
  const glove  = MDL_mat(0x46341f, 'cloth', 1, 1);
  const hatM   = MDL_mat(0x5d472f, 'cloth', 1, 1);
  const brass  = MDL_mat(PAL.gold, 'metal', 2, 2);
  const linen  = MDL_mat(0xdcd2b6, 'cloth', 1, 1);
  const tag = team+'|'+teamDk;

  /* ---- таз и ноги ---- */
  const hips = new THREE.Group(); hips.position.y = 0.86; G.add(hips);
  MDL_node('sn.hips', hips, k=>{
    k.box(0.44,0.26,0.31, pants, 0,-0.10,0);
  });

  function leg(sx, side){
    const L = new THREE.Group(); L.position.set(sx*0.155,0,0); hips.add(L);
    MDL_node('sn.leg'+side, L, k=>{
      k.box(0.25,0.44,0.26, pants, 0,-0.22,0);
      k.box(0.105,0.16,0.19, pants, sx*0.152,-0.27,0.01);      // накладной карман
      k.box(0.118,0.046,0.20, leath, sx*0.152,-0.185,0.01);    // клапан кармана
      k.box(0.266,0.052,0.276, leath, 0,-0.380,0);             // бедренный ремешок
    });
    const K = new THREE.Group(); K.position.y = -0.44; L.add(K);
    MDL_node('sn.shin', K, k=>{
      k.box(0.215,0.42,0.235, pants, 0,-0.21,0);
      k.box(0.238,0.170,0.100, leath, 0,-0.055,-0.098);        // наколенник
      k.box(0.246,0.050,0.252, leath, 0,-0.055,0.006);         // ремешок наколенника
      k.box(0.248,0.055,0.262, leath, 0,-0.300,0.005);         // ремешок над ботинком
      k.box(0.246,0.200,0.260, boot, 0,-0.330,0);              // берец
      k.box(0.236,0.130,0.170, boot, 0,-0.372,-0.160);         // носок
      // низ подошвы держим на -0.47 в системе узла: ровно столько, сколько
      // было раньше, иначе бот начнёт «тонуть» в рельефе на пару сантиметров
      k.box(0.262,0.062,0.430, dark, 0,-0.439,0.045);          // подошва
      k.box(0.248,0.050,0.140, dark, 0,-0.404,0.165);          // каблук
    });
    return { L, K };
  }
  const legL = leg(1,'L'), legR = leg(-1,'R');

  /* ---- корпус: разгрузка, патронташ, ремень винтовки, шарф ---- */
  const torso = new THREE.Group(); torso.position.y = 0.86; G.add(torso);
  MDL_node('sn.torso|'+tag, torso, k=>{
    k.box(0.60,0.55,0.34, shirt, 0,0.27,0);                    // рубаха
    k.box(0.635,0.38,0.385, vest, 0,0.31,0);                   // разгрузка
    k.box(0.666,0.12,0.362, vestD, 0,0.455,0);                 // кокетка/плечи
    for(let i=-1;i<=1;i++) k.box(0.146,0.17,0.072, vestD, i*0.176,0.30,-0.214);  // подсумки груди
    for(const sx of [-1,1]) k.box(0.172,0.132,0.078, vestD, sx*0.20,0.135,-0.203); // нижние подсумки

    // патронташ через левое плечо + латунь: главный «читаемый» акцент вблизи
    const ba = 0.62;
    k.box(0.100,0.58,0.055, leath, 0,0.30,-0.196, 0,0,ba);
    k.box(0.100,0.10,0.34, leath, -0.185,0.492,-0.02);          // через плечо
    for(let i=-2;i<=2;i++){
      const t = i*0.105;
      k.box(0.056,0.078,0.036, brass, -Math.sin(ba)*t, 0.30+Math.cos(ba)*t, -0.228, 0,0,ba);
    }
    // ремень винтовки через правое плечо — крест на груди держит силуэт
    k.box(0.086,0.56,0.05, leath, 0,0.30,-0.186, 0,0,-0.60);
    k.box(0.092,0.10,0.38, leath, 0.205,0.492,0);

    // поясной ремень
    k.box(0.666,0.11,0.366, leath, 0,0.040,0);
    k.box(0.112,0.092,0.032, brass, 0,0.040,-0.196);
    for(const sx of [-1,1]) k.box(0.132,0.132,0.092, leath, sx*0.118,0.020,-0.200);

    // шарф на шее и хвост за спиной
    k.box(0.362,0.132,0.322, vestD, 0,0.500,0);
    k.box(0.145,0.105,0.085, vestD, 0,0.462,-0.172);
    k.box(0.150,0.250,0.060, vestD, 0.055,0.400,0.175, 0.25,0,0.16);

    // кукри на бедре
    k.box(0.092,0.300,0.062, dark,  0.310,-0.020,0.070, 0.20,0,0.12);
    k.box(0.056,0.120,0.056, shirtD,0.318, 0.170,0.078);

    // ранец, скатка, фляга
    k.box(0.320,0.300,0.170, shirtD, 0,0.300,0.250);
    k.cyl(0.078,0.078,0.36,8, shirt, 0,0.470,0.242, 0,0,Math.PI/2);
    for(const sx of [-1,1]) k.box(0.026,0.300,0.180, leath, sx*0.166,0.300,0.250); // стяжки ранца
    k.cyl(0.062,0.062,0.145,8, dark, -0.262,0.020,0.120);
    k.box(0.052,0.042,0.052, brass, -0.262,0.106,0.120);
  });

  /* ---- руки ---- */
  function arm(sx, side){
    const A = new THREE.Group(); A.position.set(sx*0.36,1.20,0); G.add(A);
    MDL_node('sn.armA|'+tag, A, k=>{
      k.box(0.218,0.152,0.228, vest, 0,0.005,0);               // наплечник
      k.box(0.17,0.34,0.19, shirt, 0,-0.17,0);
      k.box(0.186,0.078,0.202, vestD, 0,-0.30,0);              // нарукавная лента
    });
    const E = new THREE.Group(); E.position.y = -0.34; A.add(E);
    MDL_node('sn.armE'+side, E, k=>{
      k.box(0.162,0.082,0.178, shirtD, 0,-0.020,0);            // закатанный рукав
      k.box(0.145,0.30,0.16, skin, 0,-0.160,0);
      k.box(0.158,0.056,0.172, glove, 0,-0.288,0);             // напульсник
      k.box(0.168,0.150,0.182, glove, 0,-0.376,0);             // перчатка
      k.box(0.162,0.072,0.102, glove, 0,-0.438,-0.052);        // пальцы
      k.box(0.052,0.062,0.092, glove, -sx*0.072,-0.402,-0.070); // большой палец
    });
    return { A, E };
  }
  const armR = arm(-1,'R'), armL = arm(1,'L');

  /* ---- голова ---- */
  const head = new THREE.Group(); head.position.y = 1.40; G.add(head);
  MDL_node('sn.head|'+tag, head, k=>{
    k.box(0.175,0.130,0.175, skin, 0,-0.020,0);                // шея
    k.box(0.34,0.36,0.34, skin, 0,0.19,0);
    k.box(0.302,0.112,0.332, shirtD, 0,0.055,-0.006);          // щетина/челюсть
    k.box(0.096,0.092,0.092, skin, 0,0.165,-0.192);            // нос
    for(const sx of [-1,1]) k.box(0.036,0.100,0.086, skin, sx*0.176,0.185,0.010); // уши
    k.box(0.346,0.052,0.062, shirtD, 0,0.292,-0.156);          // бровь
    k.box(0.352,0.058,0.352, dark, 0,0.228,0.004);             // ремешок очков
    k.box(0.356,0.098,0.056, glass, 0,0.226,-0.170);           // авиаторы
    k.box(0.366,0.036,0.066, dark, 0,0.280,-0.168);
    k.box(0.366,0.030,0.066, dark, 0,0.174,-0.168);
    k.box(0.052,0.112,0.104, dark, 0.186,0.190,0.020);         // наушник
    k.box(0.022,0.022,0.170, dark, 0.183,0.100,-0.100);        // стрела микрофона
    k.box(0.034,0.034,0.034, dark, 0.183,0.100,-0.186);
  });

  /* Шляпа — фирменная деталь: слетает при хедшоте, поэтому это отдельный
     узел с базой (0, 0.34, 0), которую ИИ восстанавливает при респауне. */
  const hat = new THREE.Group(); hat.position.y = 0.34; head.add(hat);
  MDL_node('sn.hat|'+tag, hat, k=>{
    k.cyl(0.345,0.368,0.056,12, hatM, 0,0.005,-0.02);          // поля
    k.box(0.105,0.062,0.360, hatM, -0.300,0.048,-0.02, 0,0,0.45); // подогнутый край
    k.cyl(0.190,0.208,0.250,12, hatM, 0,0.150,0);              // тулья
    k.box(0.072,0.062,0.348, dark, 0,0.268,0);                 // залом тульи
    k.cyl(0.214,0.214,0.062,12, vestD, 0,0.055,0);             // командная лента
    k.box(0.058,0.058,0.032, brass, 0,0.055,-0.208);           // пряжка
    for(const i of [-1,0,1]){
      k.box(0.009,0.105,0.009, dark,  i*0.112,-0.040,-0.300);  // нитка
      k.box(0.052,0.062,0.052, linen, i*0.112,-0.108,-0.300);  // пробка
    }
  });

  /* ---- винтовка и поза «на изготовку» ---- */
  const rifle = mkRifle(team, true);
  rifle.position.set(-0.16,1.24,-0.16);
  G.add(rifle);
  armR.A.rotation.set(-1.15,0,0.12); armR.E.rotation.set(-0.55,0,0);
  armL.A.rotation.set(-1.35,0,-0.32); armL.E.rotation.set(-0.35,0,0);

  /* Телеграф выстрела: луч и точка на цели — игрок обязан успевать
     реагировать, поэтому они намеренно яркие. Материалы — свои у каждого
     бойца: ИИ гасит и зажигает их индивидуально. */
  const laser = mCyl(0.014,0.014,1,4, basic(0xff4433,{transparent:true,opacity:0.55}), 0,0,0);
  laser.rotation.x = -Math.PI/2; laser.castShadow = false; laser.userData.shadowy = false;
  laser.visible = false; rifle.add(laser);
  const dot = new THREE.Sprite(new THREE.SpriteMaterial({map:TEX_GLOW, color:0xff5540, blending:THREE.AdditiveBlending, depthWrite:false}));
  dot.scale.setScalar(0.5); dot.visible = false; scene.add(dot);
  const glint = new THREE.Sprite(new THREE.SpriteMaterial({map:TEX_GLOW, color:0xdfefff, blending:THREE.AdditiveBlending, depthWrite:false}));
  glint.scale.setScalar(1.1); glint.visible = false; rifle.add(glint);
  glint.position.set(0,0.115,-0.34);

  G.userData = { hips, legL, legR, torso, head, hat, armL, armR, rifle, laser, dot, glint, crouch:0 };
  return G;
}
