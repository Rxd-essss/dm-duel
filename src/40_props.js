/* ------------------------------ КАРТА: ДАННЫЕ ------------------------------ */
const POSTS = [];   // огневые позиции для ботов
const SPAWNS_RED = [], SPAWNS_BLU = [];
const PICKUPS = [];

/* Регистры анимируемых пропов. Конструкторы только наполняют их,
   а крутит/пульсирует всё это updateMapDynamics() в 45_map.js —
   так вся динамика карты стоит один проход по коротким массивам. */
const PROP_CRYSTALS = [];   // {g, glow, y0, ph, spin, lh, base}
const PROP_RUNES    = [];   // {mat, lh, ph, base, op, cap}
const PROP_FIRES    = [];   // {fl:[Sprite], lh, ph, base}
const PROP_BANNERS  = [];   // {m, ph, yaw}
/* Настенные лампы лесопилки. Меш у них неподвижен (склейке не мешают),
   дышит только яркость — поэтому отдельный, самый дешёвый регистр. */
const PROP_LAMPS    = [];   // {lh, ph, base}
/* Завесы баз: мерцающее полотно на месте барьера (см. mkWard). Полотно
   прозрачное, поэтому склейка статики его не трогает (RND_mergeable отсеивает
   transparent) — менять opacity в кадре безопасно. */
const PROP_WARDS    = [];   // {mat, lh, ph, base, op}

function gh(x,z){ return terrainH(x,z); }

/* Локаль -> мир для конструкторов с рысканьем. Ровно та же формула,
   что в Box.wx/wz, иначе меш и коллизия разъедутся. */
function PROP_wx(x,yaw,lx,lz){ return x + lx*Math.cos(yaw) + lz*Math.sin(yaw); }
function PROP_wz(z,yaw,lx,lz){ return z - lx*Math.sin(yaw) + lz*Math.cos(yaw); }

/* Ключ материала в toonT включает повторы карты, поэтому «len*0.3» заводит
   отдельный материал на каждый пролёт. А склейка статики в 20_render.js
   группирует ровно по материалу: сотня почти одинаковых материалов — это
   сотня лишних мешей после склейки. Поэтому все вычисляемые повторы
   загоняем на редкую лесенку. Разница на глаз не видна, в бюджете — видна. */
const PROP_REPS = [0.25,0.4,0.6,1,1.5,2,3,4,6,8,12,16];
function PROP_rep(v){
  let b = PROP_REPS[0], bd = 1e9;
  for(let i=0;i<PROP_REPS.length;i++){
    const d = Math.abs(Math.log(PROP_REPS[i]/Math.max(0.05,v)));
    if(d < bd){ bd = d; b = PROP_REPS[i]; }
  }
  return b;
}

/* Прозрачные/аддитивные материалы toonT не отдаёт, а создавать их на верхнем
   уровне нельзя — GRAD ещё не готов. Поэтому ленивый кэш. */
const PROP_M = {};
function PROP_mat(key, make){ return PROP_M[key] || (PROP_M[key] = make()); }
function PROP_glowMat(col, op){
  return PROP_mat('gl'+col+'|'+op, ()=> new THREE.MeshBasicMaterial({
    color:col, transparent:true, opacity:op, blending:THREE.AdditiveBlending, depthWrite:false }));
}
/* Непрозрачный «горячий» материал: стекло лампы, накал угля. В отличие от
   аддитивного он попадает под склейку статики, а ламп в зале три десятка. */
function PROP_hotMat(col){ return PROP_mat('hot'+col, ()=> new THREE.MeshBasicMaterial({ color:col })); }
function PROP_ropeMat(){ return toonT(0x7d6b4a,'cloth',1,8); }

/* Провис каната/настила: 0 на концах, максимум в середине. t = 0..1 */
function PROP_sag(t, s){ const k = 2*t-1; return -s*(1-k*k); }

/* Трос/канат одним мешем: дешевле, чем цепочка коробок, и линия читается. */
function PROP_cable(pts, r, mat){
  const c = new THREE.CatmullRomCurve3(pts);
  const m = new THREE.Mesh(new THREE.TubeGeometry(c, Math.max(6, pts.length*3), r, 4, false), mat);
  m.frustumCulled = false;
  return m;
}

/* ------------------------------ БАЗОВЫЕ ПРОПЫ ------------------------------ */
function mkCrate(x,z,s,y){
  y = (y===undefined)?gh(x,z):y;
  const yaw = rnd(-0.4,0.4);
  blk(x,y,z,s,s,s, toonT(PAL.wood,'crate',1,1), yaw);
  // окантовка сверху и раскос: два меша на ящик, силуэт всё равно читается
  const t = s*0.11;
  const dk = toonT(PAL.woodDk,'plank',PROP_rep(s*0.4),0.4);
  blk(x,y+s-t,z,s+0.04,t,s+0.04, dk, yaw, false, true);
  blk(x,y+s*0.45,z,s*0.28,s*0.9,s*0.28, dk, yaw+0.7, false, true);
}
function mkBarrel(x,z,col,y){
  y = (y===undefined)?gh(x,z):y;
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.44,0.44,1.1,12), toonT(col||PAL.rust,'rust',2,1));
  m.position.set(x,y+0.55,z); m.castShadow=m.receiveShadow=true; m.userData.shadowy=true; world.add(m);
  const r = new THREE.Mesh(new THREE.TorusGeometry(0.45,0.05,6,14), toonT(PAL.metalDk,'metal',2,1));
  r.position.set(x,y+0.75,z); r.rotation.x=Math.PI/2; world.add(r);
  BOXES.push(new Box(x,y+0.55,z,0.86,1.1,0.86,0));
}
/* Опора под декорацию: САМАЯ низкая земля под подошвой, а не высота в центре.
   На склоне камень, посаженный по центру, повисает краем в воздухе. r — полуразмер подошвы. */
function PROP_seat(x,z,r){
  let y = gh(x,z);
  for(const d of [[r,0],[-r,0],[0,r],[0,-r],[r*0.7,r*0.7],[-r*0.7,-r*0.7]]){
    const g = gh(x+d[0], z+d[1]);
    if(g < y) y = g;
  }
  return y;
}
function mkRock(x,z,s,y){
  // вертикальный масштаб решаем ДО посадки: у плоского камня и подошва, и
  // коробка столкновений обязаны быть ниже, иначе он либо парит, либо
  // цепляется коллизией там, где визуально его нет
  const sy = rnd(0.6,1.05);
  if(y===undefined) y = PROP_seat(x,z,s*0.8);
  const g = new THREE.IcosahedronGeometry(s,0);
  const m = new THREE.Mesh(g, toonT(Math.random()<0.5?PAL.rock:PAL.rockDk,'stone',1,1));
  m.position.set(x, y + s*sy*0.42, z);
  m.scale.set(rnd(0.85,1.35), sy, rnd(0.85,1.35));
  m.rotation.set(rnd(0,3),rnd(0,3),rnd(0,3));
  m.castShadow=m.receiveShadow=true; m.userData.shadowy=true; world.add(m);
  if(s>0.9){
    const yaw = rnd(0,1.5);
    BOXES.push(new Box(x, y+s*sy*0.55, z, s*1.7, s*sy*1.1, s*1.7, yaw));
    PROP_shelf(x,y,z,s*1.7+0.7,s*1.7+0.7,yaw);
  }
}
function mkTree(x,z,dead,y){
  y = (y===undefined)?gh(x,z):y;
  const h = rnd(3.4,5.6);
  const bark = toonT(PAL.woodDk,'wood',0.6,3);
  const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.16,0.28,h,7), bark);
  tr.position.set(x,y+h/2,z); tr.rotation.z = rnd(-0.08,0.08);
  tr.castShadow=true; tr.userData.shadowy=true; world.add(tr);
  BOXES.push(new Box(x,y+h/2,z,0.5,h,0.5,0));
  // комель: и силуэт живее, и опора впереди читается как препятствие, а не
  // как ступенька (см. PROP_shelf и §7.5)
  const rt = new THREE.Mesh(new THREE.CylinderGeometry(0.42,0.62,0.85,7), bark);
  rt.position.set(x,y+0.42,z); rt.castShadow=true; rt.userData.shadowy=true; world.add(rt);
  BOXES.push(new Box(x,y+0.42,z,1.15,0.85,1.15,0));
  PROP_shelf(x,y,z,1.75,1.75,0);
  if(dead){
    for(let i=0;i<3;i++){
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.1,rnd(1,1.9),5), bark);
      b.position.set(x,y+h*rnd(0.5,0.9),z);
      b.rotation.set(rnd(-0.9,0.9), rnd(0,6), rnd(-0.9,0.9));
      b.translateY(0.6); world.add(b);
    }
  } else {
    for(let i=0;i<3;i++){
      const r = 2.1-i*0.5;
      const c = new THREE.Mesh(new THREE.ConeGeometry(r, 2.4, 7), toonT(i%2?0x4d6b34:0x5c7a3c,'grass',2,2));
      c.position.set(x, y+h*0.55+i*1.25, z); c.castShadow=true; c.userData.shadowy=true; world.add(c);
    }
  }
}
function mkSandbags(x,y,z,len,rows,yaw){
  const bagM = toonT(0xa9986a,'cloth',1,1), bagM2 = toonT(0x8f8058,'cloth',1,1);
  const n = Math.floor(len/0.72);
  for(let r=0;r<rows;r++){
    for(let i=0;i<n;i++){
      const off = (i - (n-1)/2)*0.72 + (r%2?0.34:0);
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.42,7,5), (i+r)%2?bagM:bagM2);
      s.scale.set(1,0.62,0.78);
      s.position.set(x + Math.cos(yaw)*off, y+0.26+r*0.44, z - Math.sin(yaw)*off);
      s.rotation.y = yaw + rnd(-0.2,0.2);
      s.castShadow=s.receiveShadow=true; s.userData.shadowy=true; world.add(s);
    }
  }
  // верх коробки поднят к видимому верху мешков: полусферы радиуса 0.42
  // торчат выше rows*0.44, и по заниженной коробке на бруствер не шагалось
  const hh = rows*0.44 + 0.1;
  BOXES.push(new Box(x, y+hh/2, z, len, hh, 0.7, yaw));
}
function mkFence(x,y,z,len,yaw){
  const post = toonT(PAL.woodDk,'wood',0.4,1.4), rail = toonT(PAL.plank,'plank',PROP_rep(len*0.25),0.4);
  const n = Math.floor(len/2.2);
  for(let i=0;i<=n;i++){
    const off=(i-n/2)*2.2;
    const px = x+Math.cos(yaw)*off, pz = z-Math.sin(yaw)*off;
    blk(px, y, pz, 0.18,1.5,0.18, post, yaw, false);
    PROP_shelf(px, gh(px,pz), pz, 2.3, 0.24, yaw, 1.2, 0.5);
  }
  blk(x,y+1.15,z,len,0.14,0.1, rail, yaw, false, true);
  blk(x,y+0.6,z,len,0.14,0.1, rail, yaw, false, true);
  BOXES.push(new Box(x,y+0.75,z,len,1.5,0.24,yaw));
}
function mkHay(x,z,y){
  y=(y===undefined)?gh(x,z):y;
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.85,0.85,1.5,10), toonT(PAL.hay,'grass',2,2));
  m.rotation.z = Math.PI/2; m.position.set(x,y+0.85,z); m.rotation.y = rnd(0,3);
  m.castShadow=m.receiveShadow=true; m.userData.shadowy=true; world.add(m);
  BOXES.push(new Box(x,y+0.85,z,1.7,1.7,1.6,m.rotation.y));
  PROP_shelf(x,y,z,2.4,2.3,m.rotation.y);
}
// стена с произвольным числом проёмов: slits = [{c,w,b,t}] (центр, ширина, низ, верх)
function mkSlitWall(x,y,z,len,h,th,yaw,slits,mat){
  const c=Math.cos(yaw), s=-Math.sin(yaw);
  const list = slits.slice().sort((a,b)=>a.c-b.c);
  let cur = -len/2;
  for(const sl of list){
    const a = sl.c - sl.w/2, b = sl.c + sl.w/2;
    if(a-cur > 0.05){ const L=a-cur, o=cur+L/2; blk(x+c*o,y,z+s*o,L,h,th,mat,yaw); }
    if(sl.b > 0.02) blk(x+c*sl.c, y, z+s*sl.c, sl.w, sl.b, th, mat, yaw);
    if(sl.t < h-0.02) blk(x+c*sl.c, y+sl.t, z+s*sl.c, sl.w, h-sl.t, th, mat, yaw);
    cur = b;
  }
  if(len/2-cur > 0.05){ const L=len/2-cur, o=cur+L/2; blk(x+c*o,y,z+s*o,L,h,th,mat,yaw); }
}
function mkWall(x,y,z,len,h,th,yaw,gapC,gapW,gapB,gapT,mat){
  if(gapW<=0){ blk(x,y,z,len,h,th,mat,yaw); return; }
  mkSlitWall(x,y,z,len,h,th,yaw,[{c:gapC,w:gapW,b:gapB,t:gapT}],mat);
}
/* Указатель. y — низ столба (по умолчанию земля); noPost — только щит
   (командные таблички зала висят на стене, столб им не нужен). */
function mkSign(x,z,yaw,txt,col,y,noPost){
  y = (y===undefined)?gh(x,z):y;
  if(!noPost) blk(x,y,z,0.2,2.6,0.2, toonT(PAL.woodDk,'wood',0.4,1.6), yaw, false);
  const c = document.createElement('canvas'); c.width=256; c.height=64;
  const g = c.getContext('2d');
  g.fillStyle = '#'+(col||PAL.rust).toString(16).padStart(6,'0'); g.fillRect(0,0,256,64);
  g.strokeStyle='#141210'; g.lineWidth=6; g.strokeRect(3,3,250,58);
  g.fillStyle='#f2e6cf'; g.font='bold 34px Arial'; g.textAlign='center'; g.textBaseline='middle';
  g.fillText(txt,128,34);
  const t = new THREE.CanvasTexture(c);
  const p = new THREE.Mesh(new THREE.PlaneGeometry(2.6,0.65), new THREE.MeshBasicMaterial({map:t, side:THREE.DoubleSide}));
  p.position.set(x,y+2.3,z); p.rotation.y=yaw; world.add(p);
  return p;
}

/* ============================ ЯРУСЫ И ПАРКУР ============================ */

/* Лестница. yaw — куда обращена лицевая сторона (оттуда подходят и лезут).
   Обязательно регистрирует зону лазания: без addClimb по ней никто не полезет. */
function mkLadder(x,z,y0,y1,yaw){
  const h = y1-y0;
  if(h < 0.7) return y1;
  const rail = toonT(PAL.woodDk,'wood',0.4,PROP_rep(h*0.4));
  const rung = toonT(PAL.plank,'plank',0.4,0.4);
  const C=Math.cos(yaw), S=Math.sin(yaw);
  for(const s of [-1,1]) blk(x + s*0.33*C, y0, z - s*0.33*S, 0.11, h, 0.11, rail, yaw, false, true);
  // шаг перекладин плавает: длинная лестница не должна съедать сотню мешей
  const n = clamp(Math.round(h/0.85), 2, 16), st = h/n;
  for(let i=0;i<n;i++) blk(x, y0+0.14+i*st, z, 0.78, 0.09, 0.10, rung, yaw, false, true);
  // зона на полшага впереди перекладин — там, где реально стоит игрок
  addClimb(x + S*0.26, z + C*0.26, y0, y1, yaw, 1.10);
  return y1;
}

/* Навесной мостик: доски, канаты, провис по дуге.
   Доски — визуал, коллизия склеена в несколько длинных плит (дешевле в BOXES
   и не даёт застревать в щелях). Группа качается через BRIDGES. */
function mkRopeBridge(x1,z1,x2,z2,y,width){
  width = width || 2.4;
  const dx = x2-x1, dz = z2-z1, L = Math.hypot(dx,dz);
  if(L < 2) return null;
  const yaw = Math.atan2(-dz, dx);           // локальный +X вдоль пролёта
  const cx = (x1+x2)/2, cz = (z1+z2)/2;
  // провис нарочно щадящий: по крутой дуге неудобно бегать и целиться, а
  // ещё он не имеет права вывести настил за допуск канонической высоты
  const sagMax = Math.min(0.62, L*0.028);

  const g = new THREE.Group(); g.position.set(cx, y, cz); g.rotation.y = yaw; world.add(g);
  const sw = new THREE.Group(); g.add(sw);   // качается только внутренняя группа

  const plankM = toonT(PAL.plank,'plank',0.9,0.5);
  const n = Math.max(5, Math.round(L/1.7));
  for(let i=0;i<n;i++){
    const t = (i+0.5)/n, u = -L/2 + t*L;
    const m = new THREE.Mesh(new THREE.BoxGeometry(L/n*0.82, 0.12, width), plankM);
    m.position.set(u, PROP_sag(t,sagMax), 0);
    m.rotation.y = rnd(-0.02,0.02);
    // тень отбрасывает каждая третья доска: рисунок «полосами» читается, а
    // гонять весь настил через shadow map незачем
    if(i%3===0){ m.castShadow = true; m.userData.shadowy = true; }
    m.receiveShadow = true;
    sw.add(m);
  }
  // канаты: поручень одним мешем на сторону, вертикальные подвесы — редко
  const rope = PROP_ropeMat();
  const K = 9;
  for(const s of [-1,1]){
    const hi=[];
    for(let i=0;i<=K;i++){
      const t=i/K, u=-L/2+t*L;
      hi.push(new THREE.Vector3(u, PROP_sag(t,sagMax) + 1.02 + PROP_sag(t,-0.18), s*width/2));
    }
    sw.add(PROP_cable(hi, 0.055, rope));
    for(let i=2;i<K;i+=3){
      const t=i/K, u=-L/2+t*L, sg=PROP_sag(t,sagMax);
      const v = new THREE.Mesh(new THREE.BoxGeometry(0.05,1.08,0.05), rope);
      v.position.set(u, sg+0.5, s*width/2); sw.add(v);
    }
  }
  // якорные тумбы стоят на опорах и не качаются
  const post = toonT(PAL.woodDk,'wood',0.6,1.5);
  for(const e of [[x1,z1],[x2,z2]])
    blk(e[0], y-0.5, e[1], 0.4, 1.8, width+0.3, post, yaw, false, true);
  // коллизия: дугу набираем плитами. Шаг мелкий не ради красоты, а чтобы
  // перепад между соседними плитами не превышал CFG.step — иначе по мостику
  // не пробежать, он читается как лестница
  const segs = Math.max(6, Math.round(L/2.2));
  for(let i=0;i<segs;i++){
    const t = (i+0.5)/segs, u = -L/2 + t*L;
    const top = y + PROP_sag(t,sagMax) + 0.06;
    BOXES.push(new Box(PROP_wx(cx,yaw,u,0), top-0.15, PROP_wz(cz,yaw,u,0), L/segs+0.06, 0.30, width, yaw));
  }
  BRIDGES.push({ g:sw, ph:rnd(0,6.283), amp:CFG.bridgeSway, x:cx, z:cz, len:L, y:y });
  return { x:cx, z:cz, y:y - sagMax + 0.06, len:L, yaw:yaw, end:y + 0.06 };
}

/* Трос: визуальный кабель + зона перехвата. */
function mkZipline(x1,y1,z1,x2,y2,z2){
  const rope = PROP_ropeMat();
  const d = Math.hypot(x2-x1, z2-z1);
  const pts = [];
  for(let i=0;i<=6;i++){
    const t=i/6;
    pts.push(new THREE.Vector3(lerp(x1,x2,t), lerp(y1,y2,t) + PROP_sag(t, Math.min(1.1,d*0.02)), lerp(z1,z2,t)));
  }
  world.add(PROP_cable(pts, 0.05, rope));
  // якоря + эфирная метка на старте, чтобы трос было видно издалека
  const met = toonT(PAL.metalDk,'metal',1,1);
  for(const p of [[x1,y1,z1],[x2,y2,z2]]){
    const a = new THREE.Mesh(new THREE.CylinderGeometry(0.16,0.22,0.5,7), met);
    a.position.set(p[0],p[1],p[2]); world.add(a);
  }
  const mark = new THREE.Sprite(new THREE.SpriteMaterial({map:TEX_GLOW, color:PAL.arcane, blending:THREE.AdditiveBlending, depthWrite:false, opacity:0.8}));
  mark.position.set(x1, y1+0.35, z1); mark.scale.setScalar(1.1); world.add(mark);
  return addZip(x1,y1,z1,x2,y2,z2);
}

/* Жаровня: живой огонь + постоянный источник света. */
function mkBrazier(x,z,y){
  y = (y===undefined)?gh(x,z):y;
  const met = toonT(PAL.metalDk,'metal',1,1), rust = toonT(PAL.rust,'rust',1,1);
  for(let i=0;i<3;i++){
    const a = i*2.094;
    const l = new THREE.Mesh(new THREE.CylinderGeometry(0.06,0.09,1.0,5), met);
    l.position.set(x+Math.cos(a)*0.24, y+0.5, z+Math.sin(a)*0.24);
    l.rotation.z = Math.cos(a)*0.22; l.rotation.x = -Math.sin(a)*0.22;
    world.add(l);
  }
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.58,0.34,0.42,10), rust);
  bowl.position.set(x,y+1.15,z); bowl.castShadow=true; bowl.userData.shadowy=true; world.add(bowl);
  const coal = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42,0), PROP_glowMat(PAL.ember,0.95));
  coal.position.set(x,y+1.32,z); coal.scale.y=0.45; world.add(coal);
  const fl = [];
  for(let i=0;i<2;i++){
    const s = new THREE.Sprite(new THREE.SpriteMaterial({map:TEX_FIRE, color:0xff9436, blending:THREE.AdditiveBlending, depthWrite:false, opacity:0.85}));
    s.position.set(x+rnd(-0.14,0.14), y+1.62+i*0.3, z+rnd(-0.14,0.14));
    s.userData.bs = rnd(1.0,1.4) - i*0.2;    // базовый масштаб: мерцание пляшет вокруг него
    s.userData.by = s.position.y;
    s.scale.setScalar(s.userData.bs); world.add(s); fl.push(s);
  }
  const lh = LIGHTS.addStatic(V(x, y+1.7, z), PAL.ember, 1.5, 15);
  PROP_FIRES.push({ fl, lh, ph:rnd(0,6.283), base:1.5 });
  BOXES.push(new Box(x, y+0.6, z, 0.7, 1.2, 0.7, 0));
  return y;
}

/* Парящий кристалл: медленное вращение, свечение, свой источник света. */
function mkCrystal(x,z,y,scale,color){
  y = (y===undefined)?gh(x,z)+4:y;
  scale = scale||1; color = color||PAL.arcane;
  const g = new THREE.Group(); g.position.set(x,y,z); world.add(g);
  const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.62*scale,0), toonT(color,'rune',1,1,{emissive:color, emissiveIntensity:0.5}));
  core.scale.y = 1.7; g.add(core);
  const shell = new THREE.Mesh(new THREE.OctahedronGeometry(0.86*scale,0), PROP_glowMat(color,0.28));
  shell.scale.y = 1.7; g.add(shell);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({map:TEX_GLOW, color:color, blending:THREE.AdditiveBlending, depthWrite:false, opacity:0.55}));
  glow.scale.setScalar(3.4*scale); g.add(glow);
  const lh = LIGHTS.addStatic(V(x,y,z), color, 1.1*scale, 13*scale);
  PROP_CRYSTALS.push({ g, glow, lh, y0:y, ph:rnd(0,6.283), spin:rnd(0.25,0.5)*(Math.random()<0.5?-1:1), base:1.1*scale, amp:0.34*scale });
  return g;
}

/* Флаг/растяжка команды. y — низ древка (по умолчанию земля). */
function mkBanner(x,z,yaw,team,y){
  y = (y===undefined)?gh(x,z):y;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07,0.09,3.6,6), toonT(PAL.woodDk,'wood',0.4,2));
  pole.position.set(x,y+1.8,z); world.add(pole);
  const cloth = new THREE.Mesh(new THREE.PlaneGeometry(1.7,2.3),
    new THREE.MeshToonMaterial({ map:TEX.get('cloth',2,2), color:team, gradientMap:GRAD, side:THREE.DoubleSide }));
  cloth.position.set(PROP_wx(x,yaw,0.9,0), y+2.35, PROP_wz(z,yaw,0.9,0));
  cloth.rotation.y = yaw; cloth.castShadow = true; cloth.userData.shadowy = true; world.add(cloth);
  const top = new THREE.Mesh(new THREE.OctahedronGeometry(0.16,0), PROP_glowMat(PAL.gold,0.9));
  top.position.set(x,y+3.75,z); world.add(top);
  PROP_BANNERS.push({ m:cloth, ph:rnd(0,6.283), yaw:yaw });
  return cloth;
}

/* ======================================================================
   «ЛЕСОПИЛКА»: конструкторы деревянного зала (MAPDESIGN §10)

   Три правила, из-за нарушения которых гибли прошлые карты:
     1) пол любой площадки лежит на CFG.floor1/2/3 (§10.2);
     2) любой марш и въезд — это РАМПА (§9), ступени видимые и НЕсплошные,
        иначе возвращается застревание на подступёнке;
     3) материалов мало и они фиксированные: склейка статики группирует по
        материалу, каждый лишний материал — лишний меш в кадре.
   ====================================================================== */

/* ---------------------- ПАЛИТРА МАТЕРИАЛОВ ЗАЛА ----------------------
   Тон тёплый красно-коричневый, как на референсе. Ярусы различаются не
   только высотой, но и светлотой (§10.6): низ тёмный, стропила почти
   выбеленные дневным светом — игрок понимает высоту по тону кадра.

   Повторы у стен подобраны под ДЛИНУ ПАНЕЛИ 22 м: карта 'wood' идёт
   волокном вдоль V, поэтому 20 повторов по U дают ровно вертикальную
   доску шириной 1.1 м. Один материал на все панели зала. */
const PROP_MTC = {};
function PROP_mt(k){
  let m = PROP_MTC[k];
  if(m) return m;
  switch(k){
    /* стены: вертикальная доска, два пояса по высоте */
    /* Четыре тона доски. Три из них (wallE → wallU → wallT) идут поясами по
       ярусам оболочки: шаг светлоты ~15 единиц яркости — этого хватает,
       чтобы высота читалась по стене, и мало, чтобы посадить кадр. Брать в
       низ самый тёмный wallD было заманчиво, но замер показал минус 10
       единиц средней по всему залу, а читаемость силуэта на 100 м дороже
       настроения (§10.6). wallD остался там, где он и уместен, — на низких
       перегородках ворот и в тени под настилами. */
    case 'wallD': m = toonT(0x7c4527,'wood',20,1); break;   // перегородки ворот
    case 'wallE': m = toonT(0x8a5230,'wood',20,1); break;   // пояс яруса 0
    case 'wallU': m = toonT(0x9c6238,'wood',20,1); break;   // пояс яруса 1
    case 'wallT': m = toonT(0xb0764a,'wood',20,1); break;   // пояс ярусов 2–3
    /* несущий брус и стойки */
    case 'beam':  m = toonT(0x5e3820,'wood',0.6,3); break;
    case 'beamL': m = toonT(0x855433,'wood',0.6,3); break;
    /* настилы по ярусам */
    case 'deck1': m = toonT(0x8d5c36,'plank',3,8); break;
    case 'deck2': m = toonT(0xab7a4a,'plank',3,8); break;
    case 'deck3': m = toonT(0xc59d66,'plank',3,8); break;
    case 'plank': m = toonT(PAL.plank,'plank',2,1); break;
    case 'plankD':m = toonT(0x8a6440,'plank',2,1); break;
    /* Ступени маршей — в тон того яруса, КУДА марш ведёт. Это не украшение:
       игрок обязан понимать по картинке, куда его выведет лестница, а зал
       собран так, что тон и есть указатель высоты (§10.6). Повторы мельче,
       чем у настилов: ступень — метровая доска, а не пролёт. */
    case 'step1': m = toonT(0x8d5c36,'plank',1,2); break;
    case 'step2': m = toonT(0xab7a4a,'plank',1,2); break;
    case 'step3': m = toonT(0xc59d66,'plank',1,2); break;
    /* железо, решётка, кровля, земля */
    case 'iron':  m = toonT(PAL.metalDk,'metal',1,1); break;
    case 'rust':  m = toonT(PAL.rust,'rust',1,1); break;
    case 'grate': m = toonT(0x8f887a,'metal',4,4); break;
    case 'roof':  m = toonT(0x6c4530,'roof',8,4); break;
    case 'dirt':  m = toonT(0x6f5335,'dirt',2,2); break;
    case 'cloth': m = toonT(0xbfb193,'cloth',2,2); break;
    case 'stone': m = toonT(0x7a7166,'stone',2,1); break;
    default:      m = toonT(PAL.plank,'plank',2,1);
  }
  PROP_MTC[k] = m;
  return m;
}
/* Материал настила под конкретный размер плиты: доска остаётся доской и на
   мостке 2 м, и на площадке 20 м. Повторы квантованы (PROP_rep), поэтому
   разных материалов набирается единицы, а не сотня. */
const PROP_DECKCOL = [0x8d5c36, 0x8d5c36, 0xab7a4a, 0xc59d66];
function PROP_deckMat(lv, sx, sz){
  return toonT(PROP_DECKCOL[lv|0] || PAL.plank, 'plank', PROP_rep(sx*0.4), PROP_rep(sz*0.7));
}

/* Низкая коллизионная «полка» внутри высокого препятствия. Своего меша не даёт
   и на глаз ничего не меняет. Нужна автопроверке проходимости (§7.5): та меряет
   опору впереди не выше роста игрока, и без полки высокая стена НА СКЛОНЕ
   неотличима от ступеньки. На ровном полу зала полка не нужна вовсе — там
   уступ впереди и так нулевой, а лишняя коробка стоит перебора в rayBoxes. */
function PROP_shelf(x,y,z,sx,sz,yaw,h,ext){
  const g = gh(x,z);
  if(Math.abs(gh(x+0.6,z)-g) < 0.04 && Math.abs(gh(x-0.6,z)-g) < 0.04 &&
     Math.abs(gh(x,z+0.6)-g) < 0.04 && Math.abs(gh(x,z-0.6)-g) < 0.04) return;
  h = h || 1.2; ext = ext || 0;
  BOXES.push(new Box(x, y+h/2, z, sx+ext, h, sz+ext, yaw||0));
}

/* Плита по прямоугольнику: удобнее, чем центр+габарит, когда зал выкладывается
   по осям. yTop — верх плиты, то есть пол, по которому ходят. */
function PROP_slab(x0,z0,x1,z1,yTop,th,mat,solid,noShadow){
  if(x1-x0 < 0.04 || z1-z0 < 0.04) return;
  blk((x0+x1)/2, yTop-th, (z0+z1)/2, x1-x0, th, z1-z0, mat, 0, solid, noShadow);
}
/* Настил с прямоугольным проёмом — до четырёх плит. Нужен везде, где снизу
   выходит лестница или где настил обходит колонну. */
function mkDeckHole(x0,z0,x1,z1, hx0,hz0,hx1,hz1, yTop,th,mat){
  hx0 = clamp(hx0,x0,x1); hx1 = clamp(hx1,x0,x1);
  hz0 = clamp(hz0,z0,z1); hz1 = clamp(hz1,z0,z1);
  PROP_slab(x0,z0,hx0,z1, yTop,th,mat,true,true);
  PROP_slab(hx1,z0,x1,z1, yTop,th,mat,true,true);
  PROP_slab(hx0,z0,hx1,hz0, yTop,th,mat,true,true);
  PROP_slab(hx0,hz1,hx1,z1, yTop,th,mat,true,true);
}

/* ------------------------- РАМПЫ (MAPDESIGN §9) -------------------------
   Наклонную коллизию держит 30_physics.js (addRamp/rampAt). Договорённость
   о знаке yaw — его, не наша, поэтому после регистрации мы спрашиваем
   rampAt в середине марша и при промахе перебираем четыре возможных
   соглашения. Проверка одноразовая, на этапе постройки карты.
   Если рамп в сборке ещё нет — ступени становятся сплошными с подъёмом не
   выше CFG.step, и карта остаётся проходимой. */
let PROP_rampAPI = -1;    // 1 — addRamp/rampAt есть, 0 — нет
let PROP_rampConv = -1;   // найденное соглашение об yaw (индекс в списке)
let PROP_rampN = 0;       // сколько наклонных поверхностей зарегистрировано

function PROP_rampYaw(i, dx, dz){
  switch(i){
    case 0: return Math.atan2(-dz, dx);   // локаль модуля: +X = (cos, -sin)
    case 1: return Math.atan2(dx, dz);    // +Z = (sin, cos)
    case 2: return Math.atan2(dz, dx);
    default: return Math.atan2(-dx, -dz);
  }
}
function PROP_ramp(bx,bz,tx,tz,w,y0,y1,body){
  if(PROP_rampAPI === 0) return false;
  if(PROP_rampAPI < 0){
    PROP_rampAPI = (typeof addRamp === 'function' && typeof rampAt === 'function'
                    && typeof RAMPS !== 'undefined' && RAMPS && RAMPS.push) ? 1 : 0;
    if(!PROP_rampAPI) return false;
  }
  const dx = tx-bx, dz = tz-bz, len = Math.hypot(dx,dz);
  if(len < 0.4 || Math.abs(y1-y0) < 0.05) return false;
  const cx = (bx+tx)/2, cz = (bz+tz)/2, cy = (y0+y1)/2;
  for(let k=0;k<4;k++){
    const i = (PROP_rampConv >= 0) ? ((PROP_rampConv + k) % 4) : k;
    const yaw = PROP_rampYaw(i,dx,dz), n0 = RAMPS.length;
    addRamp(bx, bz, yaw, len, w, y0, y1);          // пробная, без тела
    const h = rampAt(cx, cz, y1 + 2);
    RAMPS.length = n0;                              // пробную всегда снимаем
    if(h !== null && h !== undefined && Math.abs(h - cy) < 0.35){
      PROP_rampConv = i; PROP_rampN++;
      addRamp(bx, bz, yaw, len, w, y0, y1, body);   // и ставим настоящую
      return true;
    }
  }
  return false;
}

/* Марш / пандус / въезд. Ступени видимые и НЕсплошные, коллизия — рампа. */
function mkMarch(bx,bz,tx,tz,w,y0,y1,opts){
  opts = opts || {};
  const rise = y1 - y0;
  const dx = tx-bx, dz = tz-bz, len = Math.hypot(dx,dz);
  if(len < 0.4 || rise <= 0.02) return false;
  const thin = opts.thin;                       // парящие ступени
  const onRamp = PROP_ramp(bx,bz,tx,tz,w,y0,y1, (opts.body !== false) && !thin);
  const yaw = Math.atan2(-dz, dx);              // локаль модуля: +X вдоль марша
  const mat = opts.mat || PROP_mt('plankD');
  const maxRise = onRamp ? 0.44 : Math.min(CFG.step-0.04, 0.40);
  const n = Math.max(2, Math.ceil(rise/maxRise));
  const st = rise/n, run = len/n;
  for(let i=0;i<n;i++){
    const o = (i+0.5)*run;
    const px = PROP_wx(bx,yaw,o,0), pz = PROP_wz(bz,yaw,o,0);
    if(thin){
      blk(px, y0 + (i+1)*st - 0.16, pz, run+0.04, 0.16, w, mat, yaw, !onRamp, true);
    } else {
      // ступень-колонна от основания: сбоку читается сплошной клин
      const bot = Math.min(y0, gh(px,pz)) - 0.5;
      blk(px, bot, pz, run+0.04, y0 + (i+1)*st - bot, w, mat, yaw, !onRamp, i%2===1);
    }
  }
  if(opts.rail){
    // бортик: тонкие столбики вдоль марша, коллизии не создают
    const rm = opts.railMat || PROP_mt('beam');
    const K = Math.max(2, Math.round(len/2.4));
    for(let i=0;i<=K;i++){
      const o = i*len/K, y = y0 + rise*i/K;
      for(const s of [-1,1])
        blk(PROP_wx(bx,yaw,o,s*w/2), y, PROP_wz(bz,yaw,o,s*w/2), 0.16, 1.0, 0.16, rm, yaw, false, true);
    }
  }
  return onRamp;
}

/* Открытый деревянный марш лесопилки: парящие ступени на двух косоурах.
   Ступени и косоуры НЕсплошные — держит рампа (§9). Тела под маршем нет
   нарочно: сквозь открытую лестницу и видно, и стреляется, а главное — под
   ней остаётся проход, ради которого зал и строился. */
function mkStair(bx,bz,tx,tz,w,y0,y1,opts){
  opts = opts || {};
  const o = { thin:true, body:false, mat:opts.mat || PROP_mt('plankD') };
  const ok = mkMarch(bx,bz,tx,tz,w,y0,y1,o);
  const dx = tx-bx, dz = tz-bz, len = Math.hypot(dx,dz);
  const yaw = Math.atan2(-dz, dx);
  const bm = opts.beamMat || PROP_mt('beam');
  // косоуры: по одному вдоль каждой кромки, наклон изображаем ступенчато —
  // три звена на марш, глазу этого хватает, а мешей в разы меньше
  const K = 3;
  for(const s of [-1,1]) for(let i=0;i<K;i++){
    const u0 = i*len/K, u1 = (i+1)*len/K;
    const yy = y0 + (y1-y0)*(u0+u1)*0.5/len;
    blk(PROP_wx(bx,yaw,(u0+u1)/2, s*(w/2+0.14)), yy-0.55,
        PROP_wz(bz,yaw,(u0+u1)/2, s*(w/2+0.14)), len/K+0.05, 0.45, 0.22, bm, yaw, false, true);
  }
  if(opts.rail !== false){
    const R = Math.max(2, Math.round(len/2.6));
    for(let i=0;i<=R;i++){
      const u = i*len/R, yy = y0 + (y1-y0)*u/len;
      for(const s of [-1,1])
        blk(PROP_wx(bx,yaw,u,s*(w/2+0.14)), yy, PROP_wz(bz,yaw,u,s*(w/2+0.14)), 0.13, 1.0, 0.13, bm, yaw, false, true);
    }
  }
  return ok;
}

/* Помост / настил на стойках. Пол — ровно yTop.
   rail — строка сторон ('n','s','e','w'), где ставить перила. */
function mkDeck(x0,z0,x1,z1,yTop,opts){
  opts = opts || {};
  const th  = opts.th || 0.3;
  const mat = opts.mat || PROP_deckMat(opts.lv===undefined?1:opts.lv, x1-x0, z1-z0);
  const pm  = opts.post || PROP_mt('beam');
  PROP_slab(x0,z0,x1,z1,yTop,th,mat,true,opts.noShadow);
  if(opts.posts){
    const step = opts.postStep || 11.0;
    const nx = Math.max(1, Math.round((x1-x0)/step)), nz = Math.max(1, Math.round((z1-z0)/step));
    for(let i=0;i<=nx;i++) for(let j=0;j<=nz;j++){
      if(i>0 && i<nx && j>0 && j<nz) continue;         // стойки только по контуру
      const px = lerp(x0+0.4, x1-0.4, i/nx), pz = lerp(z0+0.4, z1-0.4, j/nz);
      const g0 = gh(px,pz);
      if(yTop-th-g0 > 0.6){
        blk(px, g0, pz, 0.42, yTop-th-g0, 0.42, pm, 0, true, true);
        PROP_shelf(px, g0, pz, 0.42, 0.42, 0, 1.2, 0.7);
      }
    }
  }
  const r = opts.rail || '';
  const rm = opts.railMat || pm;
  const rh = opts.railH || 1.0;
  if(r.indexOf('s')>=0) blk((x0+x1)/2, yTop, z0+0.12, x1-x0, rh, 0.16, rm, 0, true, true);
  if(r.indexOf('n')>=0) blk((x0+x1)/2, yTop, z1-0.12, x1-x0, rh, 0.16, rm, 0, true, true);
  if(r.indexOf('w')>=0) blk(x0+0.12, yTop, (z0+z1)/2, 0.16, rh, z1-z0, rm, 0, true, true);
  if(r.indexOf('e')>=0) blk(x1-0.12, yTop, (z0+z1)/2, 0.16, rh, z1-z0, rm, 0, true, true);
  return yTop;
}

/* Перило отрезком. Отдельно от mkDeck, потому что кромка настила почти всегда
   разорвана: там, где приходит марш или лаз, борт обязан кончаться — иначе
   переход есть на бумаге и нет в игре. */
function mkRail(x0,z0,x1,z1,y,mat,h){
  h = h || 1.0;
  const sx = Math.max(0.16, x1-x0), sz = Math.max(0.16, z1-z0);
  if(sx < 0.2 && sz < 0.2) return;
  blk((x0+x1)/2, y, (z0+z1)/2, sx, h, sz, mat || PROP_mt('beam'), 0, true, true);
}

/* Решётчатая площадка: сквозь неё видно нижний ярус — на референсе такая
   есть, и она честно меняет бой (снизу читается силуэт над головой). */
function mkGrate(x0,z0,x1,z1,yTop){
  const g = PROP_mt('grate'), b = PROP_mt('iron');
  PROP_slab(x0,z0,x1,z1,yTop,0.16,g,true,true);
  for(const s of [0,1]){
    blk((x0+x1)/2, yTop-0.42, s?z1-0.12:z0+0.12, x1-x0, 0.28, 0.16, b, 0, false, true);
    blk(s?x1-0.12:x0+0.12, yTop-0.42, (z0+z1)/2, 0.16, 0.28, z1-z0, b, 0, false, true);
  }
  return yTop;
}

/* Массивная квадратная колонна через все ярусы — главный ориентир зала.
   Одна коробка коллизии на всю высоту: она же рвёт осевой прострел. */
function mkColumn(cx,cz,y0,y1,size,mat){
  mat = mat || PROP_mt('beam');
  const h = y1-y0;
  blk(cx, y0, cz, size, h, size, mat, 0, true);
  // обвязки на каждом ярусе: колонна перестаёт быть гладким брусом, и по ним
  // на глаз считается высота
  const lm = PROP_mt('beamL');
  for(const y of [CFG.floor1, CFG.floor2, CFG.floor3]){
    if(y <= y0+0.5 || y >= y1-0.5) continue;
    blk(cx, y-0.55, cz, size+0.5, 0.4, size+0.5, lm, 0, false, true);
  }
  blk(cx, y1-0.6, cz, size+0.7, 0.6, size+0.7, lm, 0, false, true);   // капитель
  blk(cx, y0, cz, size+0.6, 0.5, size+0.6, lm, 0, false, true);       // база
  return y1;
}

/* Стена вертикальными досками с видимым каркасом. Панели одной длины —
   один материал на весь зал (см. PROP_mt). gaps — проёмы {c,w,b,t}. */
function mkPlankWall(x,y0,z,len,h,yaw,mat,opts){
  opts = opts || {};
  const th = opts.th || 0.5;
  if(opts.gaps && opts.gaps.length) mkSlitWall(x,y0,z,len,h,th,yaw,opts.gaps,mat);
  else blk(x,y0,z,len,h,th,mat,yaw,opts.solid!==false,true);
  if(opts.frame === false) return;
  const bm = PROP_mt('beam');
  const off = th/2 + 0.1;                       // каркас с внутренней стороны
  const n = Math.max(1, Math.round(len/5.5));
  for(let i=0;i<=n;i++){
    const o = -len/2 + i*len/n;
    blk(PROP_wx(x,yaw,o,-off), y0, PROP_wz(z,yaw,o,-off), 0.34, h, 0.28, bm, yaw, false, true);
  }
  /* Пояса — с тем же выносом внутрь, что и стойки. На осевой линии стены они
     оказывались ЦЕЛИКОМ внутри её толщины: геометрия есть, в кадре её нет. */
  for(const y of (opts.belts || [])){
    if(y <= y0 || y >= y0+h) continue;
    blk(PROP_wx(x,yaw,0,-off), y, PROP_wz(z,yaw,0,-off), len, 0.34, 0.26, bm, yaw, false, true);
  }
}

/* Штабель досок: главное укрытие нижнего яруса. Одна коробка коллизии,
   доски сверху — визуал. Высота 1.15…1.7: за ним приседают, из-за него
   стреляют, и он НИКОГДА не попадает в диапазон «уступ, через который надо
   перешагнуть» — там рождаются застревания (§7.5). */
function mkStack(x,z,yaw,len,wid,h,y){
  y = (y===undefined)?gh(x,z):y;
  const m = PROP_mt('plank'), md = PROP_mt('plankD');
  const rows = Math.max(2, Math.round(h/0.34));
  for(let i=0;i<rows;i++)
    blk(x, y+i*(h/rows), z, len - (i%2?0.18:0), h/rows*0.86, wid - (i%2?0.14:0),
        i%2?m:md, yaw + (i%3===0?0.012:-0.008), false, i%2===1);
  // прокладки-бруски по торцам: штабель не выглядит монолитом
  const bm = PROP_mt('beam');
  for(const s of [-1,1])
    blk(PROP_wx(x,yaw,s*(len/2-0.5),0), y+h, PROP_wz(z,yaw,s*(len/2-0.5),0), 0.7, 0.16, wid+0.1, bm, yaw, false, true);
  BOXES.push(new Box(x, y+h/2, z, len, h, wid, yaw));
  return y+h;
}

/* Брёвна в накат: круглый силуэт против прямоугольного штабеля. */
function mkLogPile(x,z,yaw,n,y){
  y = (y===undefined)?gh(x,z):y;
  n = n || 5;
  const bark = toonT(0x6b452a,'wood',0.6,3);
  const R = 0.46;
  let k = 0;
  for(let row=0; row<2 && k<n; row++){
    const cnt = row===0 ? Math.ceil(n/2)+1 : n - Math.ceil(n/2)-1;
    for(let i=0;i<cnt && k<n;i++,k++){
      const off = (i-(cnt-1)/2)*(R*2+0.04) + (row?R:0);
      const px = PROP_wx(x,yaw,0,off), pz = PROP_wz(z,yaw,0,off);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(R,R*0.94,4.4,8), bark);
      m.position.set(px, y+R+row*R*1.72, pz);
      m.rotation.z = Math.PI/2; m.rotation.y = yaw;
      m.castShadow = m.receiveShadow = true; m.userData.shadowy = true;
      world.add(m);
    }
  }
  const hh = R*2 + R*1.72;
  BOXES.push(new Box(x, y+hh/2, z, 4.4, hh, (Math.ceil(n/2)+1)*(R*2+0.04), yaw));
  // упоры по торцам
  const bm = PROP_mt('beam');
  for(const s of [-1,1]) blk(PROP_wx(x,yaw,s*2.3,0), y, PROP_wz(z,yaw,s*2.3,0), 0.24, hh+0.5, 0.24, bm, yaw, false, true);
  return y+hh;
}

/* Тележка лесопилки: кузов, борта, четыре колеса. Укрытие и силуэт цеха. */
function mkCart(x,z,yaw,y){
  y = (y===undefined)?gh(x,z):y;
  const w = PROP_mt('plankD'), i = PROP_mt('iron'), r = PROP_mt('rust');
  blk(x, y+0.52, z, 2.9, 0.32, 1.6, w, yaw, true);
  for(const s of [-1,1])
    blk(PROP_wx(x,yaw,0,s*0.78), y+0.84, PROP_wz(z,yaw,0,s*0.78), 2.9, 0.62, 0.14, w, yaw, false, true);
  blk(PROP_wx(x,yaw,-1.42,0), y+0.84, PROP_wz(z,yaw,-1.42,0), 0.14, 0.62, 1.6, w, yaw, false, true);
  for(const sx of [-1,1]) for(const sz of [-1,1]){
    const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.34,0.34,0.14,10), i);
    wh.position.set(PROP_wx(x,yaw,sx*1.0,sz*0.86), y+0.34, PROP_wz(z,yaw,sx*1.0,sz*0.86));
    wh.rotation.x = Math.PI/2; wh.rotation.z = yaw;
    wh.castShadow = true; wh.userData.shadowy = true; world.add(wh);
  }
  blk(PROP_wx(x,yaw,1.9,0), y+0.62, PROP_wz(z,yaw,1.9,0), 1.1, 0.12, 0.12, r, yaw, false, true);
  BOXES.push(new Box(x, y+0.73, z, 2.9, 1.46, 1.72, yaw));
  return y+1.46;
}

/* Пильная рама с диском: сердце цеха. Диск крутится через PROP_SAWS. */
const PROP_SAWS = [];
function mkSawRig(x,z,yaw,y){
  y = (y===undefined)?gh(x,z):y;
  const i = PROP_mt('iron'), r = PROP_mt('rust'), w = PROP_mt('plankD');
  blk(x, y, z, 4.6, 0.9, 2.4, r, yaw, true);                       // станина
  blk(x, y+0.9, z, 4.6, 0.22, 2.4, w, yaw, false, true);           // стол
  for(const s of [-1,1])
    blk(PROP_wx(x,yaw,s*2.0,0), y+1.12, PROP_wz(z,yaw,s*2.0,0), 0.3, 2.2, 0.3, i, yaw, true, true);
  blk(x, y+3.1, z, 4.6, 0.34, 0.5, i, yaw, false, true);
  const d = new THREE.Mesh(new THREE.CylinderGeometry(1.05,1.05,0.06,16), toonT(0xb9b2a4,'metal',1,1));
  d.position.set(x, y+1.75, z); d.rotation.z = Math.PI/2; d.rotation.y = yaw;
  d.castShadow = true; d.userData.shadowy = true; world.add(d);
  PROP_SAWS.push({ m:d, sp:rnd(0.5,0.9) });
  BOXES.push(new Box(x, y+1.05, z, 4.6, 2.1, 2.4, yaw));
  return y+2.1;
}

/* Тёплая настенная лампа — основной свет нижних ярусов (§10.6).
   Меш неподвижен и попадает под склейку; дышит только яркость (PROP_LAMPS). */
function mkWallLamp(x,y,z,yaw,inten,dist){
  const i = PROP_mt('iron');
  const arm = PROP_wx(x,yaw,0,0.42), armz = PROP_wz(z,yaw,0,0.42);
  blk(x, y, z, 0.16, 0.5, 0.16, i, yaw, false, true);                    // кронштейн
  blk(arm, y+0.42, armz, 0.16, 0.14, 0.9, i, yaw, false, true);
  const hood = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.36, 8), i);
  hood.position.set(arm, y+0.5, armz); world.add(hood);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.19, 7, 5), PROP_hotMat(0xffca7a));
  bulb.position.set(arm, y+0.24, armz); world.add(bulb);
  const lh = LIGHTS.addStatic(V(arm, y+0.2, armz), 0xffb15e, inten||1.35, dist||18);
  PROP_LAMPS.push({ lh, ph:rnd(0,6.283), base:inten||1.35 });
  return lh;
}

/* Дневные лучи из проёмов под крышей строит 25_terrain.js (TER_makeShafts):
   они завязаны на направление солнца, и второй комплект от карты просто
   удвоил бы засветку. Наше дело — оставить под кровлей световой пояс, в
   который эти лучи входят. */

/* Шкаф-раздатчик комнаты снабжения: как на референсе — высокий железный
   ящик с окном и лампой. Холодное свечение — тот самый «магический акцент»,
   который не спорит с деревом. */
function mkSupplyCabinet(x,z,yaw,team,y){
  y = (y===undefined)?gh(x,z):y;
  const i = PROP_mt('iron'), r = PROP_mt('rust');
  blk(x, y, z, 1.5, 2.3, 0.85, i, yaw, true);
  blk(x, y+2.3, z, 1.7, 0.22, 1.0, r, yaw, false, true);
  blk(x, y, z, 1.7, 0.2, 1.0, r, yaw, false, true);
  const face = new THREE.Mesh(new THREE.BoxGeometry(1.05, 1.15, 0.1), PROP_hotMat(team===1?0xff9a86:0x8fd4ff));
  face.position.set(PROP_wx(x,yaw,0,0.46), y+1.45, PROP_wz(z,yaw,0,0.46));
  face.rotation.y = yaw; world.add(face);
  const lh = LIGHTS.addStatic(V(PROP_wx(x,yaw,0,0.9), y+1.5, PROP_wz(z,yaw,0,0.9)),
                              team===1?0xff8a6a:0x76c8ff, 1.0, 11);
  PROP_LAMPS.push({ lh, ph:rnd(0,6.283), base:1.0 });
  return y+2.3;
}
/* Шкафчики бойцов: ряд узких дверец. Один меш на секцию, коробка одна. */
function mkLockers(x,z,yaw,n,y){
  y = (y===undefined)?gh(x,z):y;
  n = n||4;
  const i = PROP_mt('iron'), r = PROP_mt('rust');
  const W = 0.62;
  blk(x, y, z, n*W, 2.0, 0.6, i, yaw, true);
  for(let k=0;k<n;k++){
    const o = (k-(n-1)/2)*W;
    blk(PROP_wx(x,yaw,o,0.31), y+0.1, PROP_wz(z,yaw,o,0.31), W-0.08, 1.8, 0.06, r, yaw, false, true);
  }
  return y+2.0;
}

/* ===================== ЗАВЕСА БАЗЫ: ВИДИМЫЙ БАРЬЕР =====================
   Физику держит addBarrier() из 30_physics.js: свой проходит сквозь, чужой
   упирается. Но барьер, которого не видно, — это стена из воздуха: игрок
   бьётся в пустоту и считает игру сломанной. Поэтому на месте барьера стоит
   читаемая вещь — рунная решётка в раме ворот и мерцающее полотно за ней.

   ВСЁ здесь НЕсплошное (solid:false) и в BOXES не попадает. Так задумано:
   пуля и стрела обязаны лететь сквозь барьер, иначе защищённая база
   превращается в укрытие, из которого стреляют безнаказанно.

   Полотну нужен СВОЙ материал, а не общий из PROP_glowMat: тот кэшируется по
   цвету, и пульсация одной завесы потащила бы за собой все прочие аддитивные
   пропы того же цвета. */
function mkWard(x, y0, z, len, h, yaw, col){
  yaw = yaw || 0; col = col || PAL.arcane;
  const bm = PROP_mt('beam'), hl = len/2;
  // рама: стойки по краям створа
  for(const s of [-1,1])
    blk(PROP_wx(x,yaw,s*hl,0), y0, PROP_wz(z,yaw,s*hl,0), 0.5, h, 0.5, bm, yaw, false, true);
  // ригели на канонических высотах ярусов: завеса читается частью постройки,
  // а не эффектом поверх неё, и заодно показывает, что перекрыты ВСЕ ярусы
  for(let y = y0; y < y0 + h - 0.3; y += 6)
    blk(x, y, z, len, 0.3, 0.36, bm, yaw, false, true);
  // вертикальные рёбра решётки
  const n = Math.max(2, Math.round(len/3.6));
  for(let i=1;i<n;i++){
    const o = -hl + len*i/n;
    blk(PROP_wx(x,yaw,o,0), y0, PROP_wz(z,yaw,o,0), 0.24, h, 0.24, bm, yaw, false, true);
  }
  // полотно: маска 'runeglow' — тёмная везде, кроме резьбы, поэтому в
  // аддитивном режиме светятся только руны, а вид сквозь створ не мутнеет
  /* Полотно намеренно ЕЛЕ ЗАМЕТНОЕ. Первая версия светила в треть силы, и на
     полотне 47 x 20 м это давало ровно то, на что пожаловался заказчик: в
     оптику с полем зрения 22° завеса занимает пол-экрана и читается «большим
     синим кубом», а не полем. Барьер обязан обозначать себя вблизи, когда в
     него упираешься, а не закрывать полкарты в прицеле. */
  const vm = new THREE.MeshBasicMaterial({
    map: TEX.get('runeglow', PROP_rep(len/5.5), PROP_rep(h/5.5)), color: col,
    transparent:true, opacity:0.085, blending:THREE.AdditiveBlending,
    depthWrite:false, side:THREE.DoubleSide });
  const v = new THREE.Mesh(new THREE.PlaneGeometry(len-0.6, h-0.4), vm);
  v.position.set(x, y0 + h/2, z); v.rotation.y = yaw;
  v.frustumCulled = false;
  world.add(v);
  // и светит она тоже вполсилы: это метка створа, а не источник освещения зала
  const lh = LIGHTS.addStatic(V(x, y0 + h*0.22, z), col, 0.34, 11);
  PROP_WARDS.push({ mat:vm, lh, ph:rnd(0,6.283), base:0.34, op:0.085 });
  return v;
}

/* Светящаяся руна на несущей балке: магия как ПОДСВЕТКА дерева, а не второй
   стиль (§10.6). Пульсацию ведёт updateMapDynamics через PROP_RUNES. */
function mkRuneBeam(x,y,z,yaw,scale,col){
  scale = scale||1; col = col||PAL.rune;
  const rm = new THREE.MeshBasicMaterial({ map:TEX.get('rune',1,1), color:col,
    transparent:true, opacity:0.7, blending:THREE.AdditiveBlending, depthWrite:false });
  for(const s of [-1,1]){
    const p = new THREE.Mesh(new THREE.PlaneGeometry(0.9*scale, 1.9*scale), rm);
    p.position.set(PROP_wx(x,yaw,0,s*0.32), y, PROP_wz(z,yaw,0,s*0.32));
    p.rotation.y = yaw + (s<0?Math.PI:0);
    world.add(p);
  }
  const cap = new THREE.Mesh(new THREE.OctahedronGeometry(0.2*scale,0), PROP_glowMat(col,0.8));
  cap.position.set(x, y+1.3*scale, z); world.add(cap);
  const lh = LIGHTS.addStatic(V(x, y, z), col, 0.6*scale, 9*scale);
  PROP_RUNES.push({ mat:rm, lh, ph:rnd(0,6.283), base:0.6*scale, op:0.7, cap });
  return lh;
}
