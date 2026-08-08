/* ------------------------ КОЛЛИЗИИ: OBB по рысканью ------------------------ */
class Box {
  constructor(x,y,z,sx,sy,sz,yaw){
    this.c = V(x,y,z);
    this.hx = sx/2; this.hy = sy/2; this.hz = sz/2;
    this.yaw = yaw||0;
    this.co = Math.cos(this.yaw); this.si = Math.sin(this.yaw);
    const ex = Math.abs(this.hx*this.co) + Math.abs(this.hz*this.si);
    const ez = Math.abs(this.hx*this.si) + Math.abs(this.hz*this.co);
    this.aMin = V(x-ex, y-this.hy, z-ez);
    this.aMax = V(x+ex, y+this.hy, z+ez);
    this.top = y+this.hy; this.bot = y-this.hy;
  }
  // мир -> локаль (только XZ)
  lx(px,pz){ const dx=px-this.c.x, dz=pz-this.c.z; return dx*this.co - dz*this.si; }
  lz(px,pz){ const dx=px-this.c.x, dz=pz-this.c.z; return dx*this.si + dz*this.co; }
  wx(lx,lz){ return this.c.x + lx*this.co + lz*this.si; }
  wz(lx,lz){ return this.c.z - lx*this.si + lz*this.co; }
}
const BOXES = [];

/* ------------------------- БАРЬЕРЫ БАЗ -------------------------
   Заказчик просит, чтобы на чужую базу нельзя было зайти. Обычной коробкой
   это не решается: она непроходима для всех, включая хозяев.

   Барьер — та же OBB, но со стороной: сущность своей команды проходит сквозь
   него, чужая упирается. Команда сущности берётся из e.team; у кого поля нет
   (частицы, служебные пробы) — барьер игнорируется, иначе мы бы молча начали
   ловить всё подряд.

   ВАЖНО: барьер держит ТОЛЬКО перемещение. Пули и стрелы сквозь него летят —
   он не входит в BOXES, а значит и в rayBoxes. Иначе защищённая база
   превратилась бы в укрытие, из которого безнаказанно стреляют. */
const BARRIERS = [];
function addBarrier(x, yBottom, z, sx, sy, sz, yaw, team){
  const b = new Box(x, yBottom + sy/2, z, sx, sy, sz, yaw||0);
  b.team = (team|0) === 1 ? 1 : 0;
  BARRIERS.push(b);
  return b;
}
/* Действует ли барьер на эту сущность: только если у неё есть сторона и она
   чужая. Вынесено отдельно, потому что спрашивают в двух местах. */
function barrierBlocks(e, b){
  return e.team !== undefined && e.team !== null && (e.team|0) !== b.team;
}

function addBoxMesh(x,yBottom,z,sx,sy,sz,mat,yaw,solid,noShadow){
  const m = new THREE.Mesh(new THREE.BoxGeometry(sx,sy,sz), mat);
  m.position.set(x, yBottom+sy/2, z);
  if(yaw) m.rotation.y = yaw;
  m.castShadow = !noShadow; m.receiveShadow = true; m.userData.shadowy = !noShadow;
  world.add(m);
  if(solid !== false) BOXES.push(new Box(x, yBottom+sy/2, z, sx,sy,sz, yaw||0));
  return m;
}
const blk = addBoxMesh;

const _seg = { p:new THREE.Vector3(), n:new THREE.Vector3() };
// луч (o, dir нормализован) против всех коробок; вернуть {t, nx,ny,nz} или null
function rayBoxes(o, d, maxT){
  let bt = maxT, bn = null;
  for(let i=0;i<BOXES.length;i++){
    const b = BOXES[i];
    // грубая отбраковка по AABB
    if(o.x < b.aMin.x && d.x<=0 && o.x+d.x*maxT < b.aMin.x) continue;
    if(o.x > b.aMax.x && d.x>=0 && o.x+d.x*maxT > b.aMax.x) continue;
    if(o.y < b.aMin.y && d.y<=0) continue;
    if(o.y > b.aMax.y && d.y>=0) continue;
    if(o.z < b.aMin.z && d.z<=0 && o.z+d.z*maxT < b.aMin.z) continue;
    if(o.z > b.aMax.z && d.z>=0 && o.z+d.z*maxT > b.aMax.z) continue;
    const ox = b.lx(o.x,o.z), oz = b.lz(o.x,o.z), oy = o.y-b.c.y;
    const dx = d.x*b.co - d.z*b.si, dz = d.x*b.si + d.z*b.co, dy = d.y;
    let t0=0, t1=bt, axis=-1, sgn=1;
    const O=[ox,oy,oz], D=[dx,dy,dz], Hh=[b.hx,b.hy,b.hz];
    let ok = true;
    for(let a=0;a<3;a++){
      if(Math.abs(D[a]) < 1e-8){ if(Math.abs(O[a]) > Hh[a]){ ok=false; break; } continue; }
      const inv = 1/D[a];
      let ta = (-Hh[a]-O[a])*inv, tb = (Hh[a]-O[a])*inv, s=-1;
      if(ta>tb){ const q=ta; ta=tb; tb=q; s=1; }
      if(ta>t0){ t0=ta; axis=a; sgn=s; }
      if(tb<t1) t1=tb;
      if(t0>t1){ ok=false; break; }
    }
    if(!ok || t0<=0 || t0>=bt) continue;
    bt = t0;
    if(axis===0) bn = [sgn*b.co, 0, -sgn*b.si];
    else if(axis===1) bn = [0,sgn,0];
    else bn = [sgn*b.si, 0, sgn*b.co];
  }
  if(bn===null) return null;
  _seg.n.set(bn[0],bn[1],bn[2]);
  return { t:bt, n:_seg.n };
}
// пересечение луча с ландшафтом (маршевый поиск + бисекция)
function rayTerrain(o, d, maxT){
  const stp = 1.4;
  let prev = 0, prevH = o.y - terrainH(o.x,o.z);
  if(prevH < 0) return { t:0.001 };
  for(let t=stp;t<=maxT;t+=stp){
    const x=o.x+d.x*t, y=o.y+d.y*t, z=o.z+d.z*t;
    const h = y - terrainH(x,z);
    if(h < 0){
      let a=prev,b=t;
      for(let k=0;k<8;k++){
        const m=(a+b)/2;
        const hh=(o.y+d.y*m) - terrainH(o.x+d.x*m, o.z+d.z*m);
        if(hh<0) b=m; else a=m;
      }
      return { t:(a+b)/2 };
    }
    prev=t; prevH=h;
  }
  return null;
}
function losClear(a,b){
  const d = _los.subVectors(b,a);
  const dist = d.length();
  if(dist < 0.001) return true;
  d.multiplyScalar(1/dist);
  if(rayBoxes(a,d,dist)) return false;
  if(rayTerrain(a,d,dist)) return false;
  return true;
}
const _los = new THREE.Vector3();

/* ============================ РАМПЫ (MAPDESIGN §9) ============================
   Наклонная аналитическая поверхность вместо набора ступеней. Ступени марша
   остаются только визуально (solid:false) — коллизию за них держит рампа,
   поэтому упереться в подступёнок физически не во что.

   Соглашение об осях СОВПАДАЕТ с коробками и с mkStairs(x,z,yaw,...):
   подъём идёт вдоль локального +x, то есть в мире по (cos yaw, -sin yaw),
   ширина — вдоль локального +z, то есть по (sin yaw, cos yaw).
   Значит addRamp(x,z,yaw,...) и mkStairs(x,z,yaw,...) с теми же x,z,yaw
   описывают один и тот же марш. */
const RAMPS = [];

/* x,z — центр ОСНОВАНИЯ марша; yaw — направление подъёма; len — длина марша;
   w — ширина; y0 — высота у основания; y1 — высота наверху.
   body (необязательный) — набить под поверхностью коробок-«тело марша»:
   они блокируют пули и взгляд сквозь лестницу, но никогда не мешают шагу,
   потому что верх каждой лежит НЕ ВЫШЕ поверхности рампы над собой. */
function addRamp(x, z, yaw, len, w, y0, y1, body){
  yaw = yaw || 0;
  len = Math.max(0.05, len); w = Math.max(0.05, w);
  const co = Math.cos(yaw), si = Math.sin(yaw);
  const r = {
    x, z, yaw, len, w, y0, y1,
    ax: co, az:-si,          // ось подъёма в мире
    bx: si, bz: co,          // ось ширины в мире
    k: (y1-y0)/len,          // уклон
    cx: x + co*len*0.5,      // центр площадки — для отбраковки одним сравнением
    cz: z - si*len*0.5,
    r2: 0
  };
  const rad = Math.hypot(len*0.5, w*0.5) + CFG.radius + 0.05;
  r.r2 = rad*rad;
  RAMPS.push(r);
  // «тело» марша: без него простреливается насквозь, ведь ступени несплошные
  if(body){
    const segs = Math.max(1, Math.round(len/2.2));
    const mat = (typeof toonT === 'function') ? toonT(PAL.concDk,'stone',1,1) : null;
    for(let i=0;i<segs;i++){
      const u0 = i*len/segs, u1 = (i+1)*len/segs;
      // верх секции — высота рампы у её НИЖНЕГО края: выше поверхности не выйдет
      const top = y0 + r.k*(r.k >= 0 ? u0 : u1);
      const bot = Math.min(y0, y1) - 3.0;
      const mx = x + co*(u0+u1)*0.5, mz = z - si*(u0+u1)*0.5;
      if(mat) blk(mx, bot, mz, (u1-u0), top-bot, w, mat, yaw, true, true);
      else BOXES.push(new Box(mx, (bot+top)/2, mz, (u1-u0), top-bot, w, yaw));
    }
  }
  return r;
}
/* Высота опоры рампы в точке (x,z), но не выше yMax; null — рампы здесь нет.
   yMax отсекает то, что висит над головой: под мостом наверх тянуть нельзя.
   Аллокаций ноль — перебор по массиву на голых числах. */
function rampAt(x, z, yMax){
  let best = null;
  for(let i=0;i<RAMPS.length;i++){
    const r = RAMPS[i];
    const gx = x - r.cx, gz = z - r.cz;
    if(gx*gx + gz*gz > r.r2) continue;                 // грубая отбраковка
    const ux = x - r.x, uz = z - r.z;
    const v = ux*r.bx + uz*r.bz;                       // поперёк марша
    const hw = r.w*0.5 + CFG.radius;
    if(v < -hw || v > hw) continue;
    let u = ux*r.ax + uz*r.az;                         // вдоль марша
    if(u < -CFG.radius || u > r.len + CFG.radius) continue;
    if(u < 0) u = 0; else if(u > r.len) u = r.len;     // площадки у краёв ровные
    const h = r.y0 + r.k*u;
    if(h > yMax) continue;
    if(best === null || h > best) best = h;
  }
  return best;
}

/* ------------------- ФИЗИКА ПЕРСОНАЖА (общая для всех) ------------------- */
/* Порог шага один на обе проверки — иначе уступы в зазоре между ними
   держатся только на запасной ветке и рвутся на бегу. Эпсилон нужен, чтобы
   уступ ровно в CFG.step не отсекался ошибкой округления высот. */
const PHYS_STEP = CFG.step + 1e-6;

/* Едет ли сущность ВНУТРЬ коробки: сравниваем скорость с той нормалью,
   по которой коробка её вытолкнет. Нужно, чтобы прощающий шаг не срабатывал,
   когда игрок просто сходит с площадки, — там скорость направлена наружу,
   и подтягивать его обратно на кромку нельзя. */
function PHYS_intoBox(e, b, lx, lz, px, pz){
  let nx, nz;
  if(px < pz){ const s = lx<0?-1:1; nx = s*b.co; nz = -s*b.si; }
  else       { const s = lz<0?-1:1; nx = s*b.si; nz =  s*b.co; }
  return (e.vel.x*nx + e.vel.z*nz) < 0;
}

function moveHoriz(e, dt){
  e.pos.x += e.vel.x*dt; e.pos.z += e.vel.z*dt;
  const lim = CFG.half-1.5;
  e.pos.x = clamp(e.pos.x,-lim,lim); e.pos.z = clamp(e.pos.z,-lim,lim);
  const feet = e.pos.y, head = feet + e.h;
  /* Прощающая рамка в духе coyote-time: на бегу «строго на земле» рвётся
     каждый раз, когда под ногами уклон вниз, — а уступ обязан проходиться
     шагом и в этот момент. Условие: падаем (или зависли) и лезем В препятствие. */
  const soft = !e.grounded && e.vel.y <= 0;
  e.stepUp = 0;
  for(let i=0;i<BOXES.length;i++){
    const b = BOXES[i];
    if(b.top <= feet + 0.02 || b.bot >= head) continue;
    if(e.pos.x < b.aMin.x-1 || e.pos.x > b.aMax.x+1 || e.pos.z < b.aMin.z-1 || e.pos.z > b.aMax.z+1) continue;
    let lx = b.lx(e.pos.x, e.pos.z), lz = b.lz(e.pos.x, e.pos.z);
    const ex = b.hx + CFG.radius, ez = b.hz + CFG.radius;
    if(Math.abs(lx) >= ex || Math.abs(lz) >= ez) continue;
    const px = ex - Math.abs(lx), pz = ez - Math.abs(lz);
    const rise = b.top - feet;
    if(rise > 0 && rise <= PHYS_STEP &&
       (e.grounded || (soft && PHYS_intoBox(e, b, lx, lz, px, pz)))){
      if(b.top > e.stepUp) e.stepUp = b.top;
      continue;
    }
    const ox = e.pos.x, oz = e.pos.z;
    if(px < pz) lx += (lx<0?-1:1)*px; else lz += (lz<0?-1:1)*pz;
    e.pos.x = b.wx(lx,lz); e.pos.z = b.wz(lx,lz);
    let nx = e.pos.x-ox, nz = e.pos.z-oz;
    const l = Math.hypot(nx,nz);
    if(l>1e-6){ nx/=l; nz/=l; const dp = e.vel.x*nx + e.vel.z*nz; if(dp<0){ e.vel.x -= nx*dp; e.vel.z -= nz*dp; } }
  }
  /* Барьеры баз — тем же выталкиванием, но только для чужих. Отдельным
     проходом, а не в общем цикле: у барьера нет ступеньки, на него нельзя
     забраться, и уступ он давать не должен ни при каких условиях. */
  for(let i=0;i<BARRIERS.length;i++){
    const b = BARRIERS[i];
    if(!barrierBlocks(e, b)) continue;
    if(b.top <= feet + 0.02 || b.bot >= head) continue;
    if(e.pos.x < b.aMin.x-1 || e.pos.x > b.aMax.x+1 || e.pos.z < b.aMin.z-1 || e.pos.z > b.aMax.z+1) continue;
    let lx = b.lx(e.pos.x, e.pos.z), lz = b.lz(e.pos.x, e.pos.z);
    const ex = b.hx + CFG.radius, ez = b.hz + CFG.radius;
    if(Math.abs(lx) >= ex || Math.abs(lz) >= ez) continue;
    const px = ex - Math.abs(lx), pz = ez - Math.abs(lz);
    const ox = e.pos.x, oz = e.pos.z;
    if(px < pz) lx += (lx<0?-1:1)*px; else lz += (lz<0?-1:1)*pz;
    e.pos.x = b.wx(lx,lz); e.pos.z = b.wz(lx,lz);
    let nx = e.pos.x-ox, nz = e.pos.z-oz;
    const l2 = Math.hypot(nx,nz);
    if(l2>1e-6){ nx/=l2; nz/=l2; const dp = e.vel.x*nx + e.vel.z*nz; if(dp<0){ e.vel.x -= nx*dp; e.vel.z -= nz*dp; } }
  }
}
/* e.noGrav === true — вертикалью рулит вызывающий (лестница, трос, подтягивание):
   гравитация не применяется и e.vel.y не трогается вообще. Опора при этом
   всё равно ищется — иначе можно было бы уехать по тросу сквозь холм. */
function moveVert(e, dt){
  const prevY = e.pos.y;
  const free = !e.noGrav;
  if(free){
    e.vel.y -= CFG.gravity*dt;
    e.pos.y += e.vel.y*dt;
  }
  const rising = free ? e.vel.y > 0 : e.pos.y > prevY;
  // единый потолок подъёма опоры за кадр: и для верхов коробок, и для рамп,
  // и для уступа, найденного moveHoriz. Раньше здесь стояло 0.36 против 0.45
  // в moveHoriz — ровно этот зазор и держал игрока на подступёнке.
  const lift = prevY + PHYS_STEP;
  let ground = terrainH(e.pos.x, e.pos.z);
  if(RAMPS.length){
    const rh = rampAt(e.pos.x, e.pos.z, lift);
    if(rh !== null && rh > ground) ground = rh;
  }
  for(let i=0;i<BOXES.length;i++){
    const b = BOXES[i];
    if(e.pos.x < b.aMin.x-0.6 || e.pos.x > b.aMax.x+0.6 || e.pos.z < b.aMin.z-0.6 || e.pos.z > b.aMax.z+0.6) continue;
    const lx = b.lx(e.pos.x,e.pos.z), lz = b.lz(e.pos.x,e.pos.z);
    if(Math.abs(lx) >= b.hx+CFG.radius*0.75 || Math.abs(lz) >= b.hz+CFG.radius*0.75) continue;
    if(b.top <= lift && b.top > ground && e.pos.y <= b.top + 0.02) ground = b.top;
    if(rising && b.bot > prevY + e.h - 0.05 && b.bot < e.pos.y + e.h){
      e.pos.y = b.bot - e.h - 0.01;
      if(free) e.vel.y = 0;
    }
  }
  if(e.stepUp !== 0 && e.stepUp > ground && e.stepUp <= lift) ground = e.stepUp;
  if(e.pos.y <= ground){
    e.pos.y = ground;
    if(free && e.vel.y<0){ e.landV = e.vel.y; e.vel.y = 0; }
    e.grounded = true;
  }
  else e.grounded = false;
}

/* ========================= ПАРКУР: ЛЕСТНИЦЫ, ТРОСЫ, УСТУПЫ =========================
   Реестры заполняет карта (45_map.js) при постройке, пользуются ими и игрок,
   и боты. Всё, что возвращают запросы, — либо элемент реестра, либо общий
   объект-буфер: в кадре здесь ничего не аллоцируется.                        */

const CLIMBS = [];   // зоны вертикального лазания
const ZIPS = [];     // натянутые тросы

// Насколько щедро засчитывается «я на лестнице». Глубина проверяется по модулю:
// какой стороной к стене развёрнут yaw у автора карты — не наше дело.
const PHYS_CLIMB_DEPTH = 0.85;              // от плоскости лестницы
const PHYS_CLIMB_LOW   = 0.95;              // можно зацепиться, стоя у подножия
const PHYS_CLIMB_TOP   = 0.60;              // и не отваливаться у самой верхушки
const PHYS_CLIMB_HOLD  = CFG.radius + 0.06; // на таком удалении висим от перекладин
const PHYS_CLIMB_OUT   = 0.85;              // куда щупаем пол, слезая наверху

function addClimb(x, z, y0, y1, yaw, w){
  yaw = yaw || 0; w = (w===undefined || w<=0) ? 1.1 : w;
  const si = Math.sin(yaw), co = Math.cos(yaw);
  const zone = {
    x, z, y0, y1, yaw, w,
    fx:-si, fz:-co,   // «лицом» от стены
    rx: co, rz:-si    // вдоль перекладин
  };
  CLIMBS.push(zone);
  return zone;
}
// оси зоны: восстанавливаем, если элемент CLIMBS пришёл мимо addClimb
function PHYS_climbAxes(c){
  const si = Math.sin(c.yaw||0), co = Math.cos(c.yaw||0);
  c.fx = -si; c.fz = -co; c.rx = co; c.rz = -si;
  if(!(c.w > 0)) c.w = 1.1;
  return c;
}
function climbAt(x, z, y){
  let best = null, bd = 1e9;
  for(let i=0;i<CLIMBS.length;i++){
    const c = CLIMBS[i];
    if(c.fx === undefined) PHYS_climbAxes(c);
    if(y < c.y0 - PHYS_CLIMB_LOW || y > c.y1 + PHYS_CLIMB_TOP) continue;
    const dx = x - c.x, dz = z - c.z;
    const al = dx*c.rx + dz*c.rz;
    if(Math.abs(al) > c.w*0.5 + CFG.radius*0.6) continue;
    const dp = dx*c.fx + dz*c.fz;
    if(Math.abs(dp) > PHYS_CLIMB_DEPTH) continue;
    const d = Math.abs(dp) + Math.abs(al)*0.5;
    if(d < bd){ bd = d; best = c; }
  }
  return best;
}

function addZip(ax, ay, az, bx, by, bz){
  const dx = bx-ax, dy = by-ay, dz = bz-az;
  const len = Math.max(0.001, Math.hypot(dx,dy,dz));
  const zip = { a:V(ax,ay,az), b:V(bx,by,bz), len, dx:dx/len, dy:dy/len, dz:dz/len };
  ZIPS.push(zip);
  return zip;
}
const PHYS_zipRes = { zip:null, t:0, point:new THREE.Vector3() };
// ближайший трос к точке; t — параметр 0..1 вдоль него. Результат — общий буфер,
// вызывающий обязан сразу переписать нужное себе.
function zipNear(pos, maxD){
  const lim = (maxD===undefined) ? 2.0 : maxD;
  let best = null, bt = 0, bd = lim;
  for(let i=0;i<ZIPS.length;i++){
    const z = ZIPS[i];
    const vx = pos.x-z.a.x, vy = pos.y-z.a.y, vz = pos.z-z.a.z;
    const t = clamp((vx*z.dx + vy*z.dy + vz*z.dz)/z.len, 0, 1);
    const px = z.a.x + (z.b.x-z.a.x)*t;
    const py = z.a.y + (z.b.y-z.a.y)*t;
    const pz = z.a.z + (z.b.z-z.a.z)*t;
    const d = Math.hypot(pos.x-px, pos.y-py, pos.z-pz);
    if(d < bd){ bd = d; best = z; bt = t; PHYS_zipRes.point.set(px,py,pz); }
  }
  if(!best) return null;
  PHYS_zipRes.zip = best; PHYS_zipRes.t = bt;
  return PHYS_zipRes;
}

/* Верх опоры в точке (x,z), но не выше yMax. null — значит встать некуда:
   либо земля выше потолка поиска, либо путь перекрыт слишком высокой стеной. */
function PHYS_surfaceAt(x, z, yMax){
  let top = terrainH(x,z);
  if(top > yMax) return null;
  // рампа — такая же опора, как верх коробки: на неё можно и подтянуться,
  // и сойти с лестницы
  if(RAMPS.length){
    const rh = rampAt(x, z, yMax);
    if(rh !== null && rh > top) top = rh;
  }
  for(let i=0;i<BOXES.length;i++){
    const b = BOXES[i];
    if(x < b.aMin.x-0.1 || x > b.aMax.x+0.1 || z < b.aMin.z-0.1 || z > b.aMax.z+0.1) continue;
    const lx = b.lx(x,z), lz = b.lz(x,z);
    if(Math.abs(lx) >= b.hx+0.05 || Math.abs(lz) >= b.hz+0.05) continue;
    if(b.top > yMax){
      if(b.bot <= yMax) return null;   // это стена, а не уступ
      continue;                        // это козырёк над головой — разберётся PHYS_roomAbove
    }
    if(b.top > top) top = b.top;
  }
  return top;
}
// хватит ли места встать в полный рост на площадке top в точке (x,z)
function PHYS_roomAbove(x, z, top, h){
  const y0 = top + 0.06, y1 = top + h;
  for(let i=0;i<BOXES.length;i++){
    const b = BOXES[i];
    if(b.top <= y0 || b.bot >= y1) continue;
    if(x < b.aMin.x-0.6 || x > b.aMax.x+0.6 || z < b.aMin.z-0.6 || z > b.aMax.z+0.6) continue;
    const lx = b.lx(x,z), lz = b.lz(x,z);
    if(Math.abs(lx) < b.hx+CFG.radius*0.85 && Math.abs(lz) < b.hz+CFG.radius*0.85) return false;
  }
  return true;
}

const PHYS_mo = new THREE.Vector3(), PHYS_md = new THREE.Vector3();
const PHYS_mantlePt = { x:0, y:0, z:0 };
// Смещения проб от найденной стены. Первая — почти вплотную: у тонких кромок
// (забор, перила, край мостика) верх иначе просто перепрыгивается пробой.
const PHYS_MPROBE = [0.08, 0.30, 0.62, 0.95];
const PHYS_MDEEP = [0.62, 0.34];
/* Честный поиск уступа: луч от груди вперёд ищет препятствие, затем щупаем
   верх этого препятствия и место над ним. Возвращаем точку, куда встать
   (общий буфер), или null. Дороговато для каждого кадра — зовущий обязан
   прореживать вызовы. */
function mantleFind(e, dx, dz){
  const l = Math.hypot(dx, dz);
  if(l < 1e-4) return null;
  const nx = dx/l, nz = dz/l;
  const feet = e.pos.y;
  const hi = feet + CFG.mantleMax;
  const reach = CFG.radius + CFG.mantleReach;

  // 1) есть ли вообще во что упереться на уровне груди
  PHYS_mo.set(e.pos.x, feet + Math.min(e.h*0.55, CFG.mantleMax - 0.2), e.pos.z);
  PHYS_md.set(nx, 0, nz);
  const wall = rayBoxes(PHYS_mo, PHYS_md, reach);
  // луч по груди пролетает над низкими уступами — их ловит сам перебор дистанций
  const d0 = wall ? wall.t : CFG.radius + 0.12;

  for(let k=0; k<PHYS_MPROBE.length; k++){
    const d = d0 + PHYS_MPROBE[k];
    if(d > reach + 0.45) break;
    const qx = e.pos.x + nx*d, qz = e.pos.z + nz*d;
    const top = PHYS_surfaceAt(qx, qz, hi);
    if(top === null) continue;
    const rise = top - feet;
    if(rise < CFG.mantleMin || rise > CFG.mantleMax) continue;
    if(!PHYS_roomAbove(qx, qz, top, e.h)) continue;
    // не подтягиваемся сквозь стену: над кромкой должно быть чисто
    PHYS_mo.set(e.pos.x, top + e.h*0.5, e.pos.z);
    PHYS_md.set(nx, 0, nz);
    if(rayBoxes(PHYS_mo, PHYS_md, d + 0.1)) continue;
    // сойти поглубже на площадку, чтобы не оказаться ровно на кромке
    let ex = qx, ez = qz;
    for(let j=0;j<PHYS_MDEEP.length;j++){
      const px = qx + nx*PHYS_MDEEP[j], pz = qz + nz*PHYS_MDEEP[j];
      const t2 = PHYS_surfaceAt(px, pz, hi);
      if(t2 !== null && Math.abs(t2 - top) < 0.30 && PHYS_roomAbove(px, pz, top, e.h)){ ex = px; ez = pz; break; }
    }
    PHYS_mantlePt.x = ex; PHYS_mantlePt.y = top + 0.02; PHYS_mantlePt.z = ez;
    return PHYS_mantlePt;
  }
  return null;
}

/* С какой стороны от лестницы наверху есть пол: +1 / -1 по оси «лицом», 0 — нет пола.
   Так не приходится гадать, каким знаком yaw автор карты развернул лестницу. */
function PHYS_climbExit(c){
  for(let s=-1; s<=1; s+=2){
    const qx = c.x + c.fx*s*PHYS_CLIMB_OUT, qz = c.z + c.fz*s*PHYS_CLIMB_OUT;
    const t = PHYS_surfaceAt(qx, qz, c.y1 + 0.45);
    if(t !== null && t > c.y1 - 1.1 && PHYS_roomAbove(qx, qz, t, 1.7)) return s;
  }
  return 0;
}
/* Общий примитив лазания: держит сущность на полотне лестницы и тянет вверх
   (или спускает, если вверх не просят). Возвращает false, когда лестница
   кончилась — сверху при этом сущность переваливается на площадку. */
function climbStep(e, dt, wantUp){
  const c = climbAt(e.pos.x, e.pos.z, e.pos.y);
  if(!c){ e.noGrav = false; return false; }

  e.noGrav = true;
  e.vel.x = 0; e.vel.z = 0; e.vel.y = 0;
  e.grounded = false;

  // прижаться к перекладинам, оставаясь с той стороны, с которой подошли
  const dx = e.pos.x - c.x, dz = e.pos.z - c.z;
  const al = clamp(dx*c.rx + dz*c.rz, -c.w*0.5, c.w*0.5);
  let dp = dx*c.fx + dz*c.fz;
  dp = damp(dp, (dp < 0 ? -PHYS_CLIMB_HOLD : PHYS_CLIMB_HOLD), 14, dt);
  e.pos.x = c.x + c.rx*al + c.fx*dp;
  e.pos.z = c.z + c.rz*al + c.fz*dp;

  e.pos.y += (wantUp ? CFG.climbSpeed : -CFG.climbSpeed*0.62)*dt;

  if(e.pos.y >= c.y1 - 0.03){
    // верхняя кромка: шагнуть на площадку, дальше работает обычная физика
    e.pos.y = c.y1 + 0.05;
    const s = PHYS_climbExit(c);
    if(s !== 0){
      e.pos.x += c.fx*s*0.35; e.pos.z += c.fz*s*0.35;
      e.vel.x = c.fx*s*3.0;   e.vel.z = c.fz*s*3.0;
    }
    e.vel.y = 0.8;
    e.noGrav = false;
    return false;
  }
  if(!wantUp && e.pos.y <= c.y0 + 0.02){
    e.pos.y = Math.max(e.pos.y, c.y0);
    e.noGrav = false;
    return false;
  }
  return true;
}
