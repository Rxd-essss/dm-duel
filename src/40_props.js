/* ------------------------------ КАРТА: ДАННЫЕ ------------------------------ */
const POSTS = [];   // огневые позиции для ботов
const SPAWNS_RED = [], SPAWNS_BLU = [];
const PICKUPS = [];

/* Регистры анимируемых пропов. Конструкторы только наполняют их,
   а крутит/пульсирует всё это updateMapDynamics() в 45_map.js —
   так вся динамика карты стоит один проход по коротким массивам. */
const PROP_CRYSTALS = [];   // {g, glow, y0, ph, spin, lh, base}
const PROP_RUNES    = [];   // {mat, lh, ph, base, op}
const PROP_FIRES    = [];   // {fl:[Sprite], lh, ph, base}
const PROP_BANNERS  = [];   // {m, ph, yaw}

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
   На склоне камень, посаженный по центру, повисает краем в воздухе — именно
   это и видно на кадрах у пограничной стены. r — полуразмер подошвы. */
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
  // центр опущен так, чтобы нижняя вершина икосаэдра (0.79 радиуса) ушла
  // под землю при любом повороте: камень «врастает», а не стоит на цыпочках
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
    // полка секциями, каждая по СВОЕЙ земле: у длинного забора на склоне общая
    // полка либо уходит под землю, либо задирается выше головы игрока
    PROP_shelf(px, gh(px,pz), pz, 2.3, 0.24, yaw, 1.2, 0.5);
  }
  blk(x,y+1.15,z,len,0.14,0.1, rail, yaw, false, true);
  blk(x,y+0.6,z,len,0.14,0.1, rail, yaw, false, true);
  BOXES.push(new Box(x,y+0.75,z,len,1.5,0.24,yaw));
  // на склоне верх забора уходит выше головы, и автопроверка перестаёт
  // отличать забор от ступеньки — см. PROP_shelf
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
function mkSign(x,z,yaw,txt,col){
  const y = gh(x,z);
  blk(x,y,z,0.2,2.6,0.2, toonT(PAL.woodDk,'wood',0.4,1.6), yaw, false);
  const c = document.createElement('canvas'); c.width=256; c.height=64;
  const g = c.getContext('2d');
  g.fillStyle = '#'+(col||PAL.rust).toString(16).padStart(6,'0'); g.fillRect(0,0,256,64);
  g.strokeStyle='#141210'; g.lineWidth=6; g.strokeRect(3,3,250,58);
  g.fillStyle='#f2e6cf'; g.font='bold 34px Arial'; g.textAlign='center'; g.textBaseline='middle';
  g.fillText(txt,128,34);
  const t = new THREE.CanvasTexture(c);
  const p = new THREE.Mesh(new THREE.PlaneGeometry(2.6,0.65), new THREE.MeshBasicMaterial({map:t, side:THREE.DoubleSide}));
  p.position.set(x,y+2.3,z); p.rotation.y=yaw; world.add(p);
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
  // провис нарочно щадящий: по крутой дуге неудобно бегать и целиться
  const sagMax = Math.min(1.15, L*0.032);

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
  // y — реальная высота пола в середине пролёта: по ней стыкуют лестницы
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

/* Рунный обелиск: ориентир в центре карты, резьба пульсирует.
   hSh — высота ствола: в «Осаде» обелиск прошивает насквозь площадку моста
   этажа 2, поэтому он должен быть выше стандартных 6.4 м. */
function mkObelisk(x,z,y,hSh){
  y = (y===undefined)?gh(x,z):y;
  hSh = hSh || 6.4;
  const st = toonT(PAL.concDk,'stone',1,1.5);
  blk(x, y, z, 2.6, 0.55, 2.6, toonT(PAL.conc,'stone',1.5,0.4), 0);
  blk(x, y+0.55, z, 1.9, 0.4, 1.9, st, 0);
  const sh = new THREE.Mesh(new THREE.CylinderGeometry(0.52,0.88,hSh,4), st);
  sh.position.set(x, y+0.95+hSh/2, z); sh.rotation.y = Math.PI/4;
  sh.castShadow=true; sh.receiveShadow=true; sh.userData.shadowy=true; world.add(sh);
  BOXES.push(new Box(x, y+0.5+hSh/2, z, 1.5, hSh+1.0, 1.5, Math.PI/4));
  // резьба: четыре светящиеся грани на общем материале — пульсируют вместе
  const rm = new THREE.MeshBasicMaterial({ map:TEX.get('rune',1,2), color:PAL.rune,
    transparent:true, opacity:0.75, blending:THREE.AdditiveBlending, depthWrite:false });
  for(let i=0;i<4;i++){
    const a = i*Math.PI/2 + Math.PI/4;
    const p = new THREE.Mesh(new THREE.PlaneGeometry(1.0, hSh*0.72), rm);
    p.position.set(x + Math.sin(a)*0.72, y+0.9+hSh/2, z + Math.cos(a)*0.72);
    p.rotation.y = a; world.add(p);
  }
  const cap = new THREE.Mesh(new THREE.OctahedronGeometry(0.62,0), PROP_glowMat(PAL.rune,0.85));
  cap.position.set(x, y+hSh+1.6, z); cap.scale.y=1.5; world.add(cap);
  const lh = LIGHTS.addStatic(V(x, y+hSh+1.0, z), PAL.rune, 1.7, 26);
  PROP_RUNES.push({ mat:rm, lh, ph:rnd(0,6.283), base:1.7, op:0.75, cap });
  return y+hSh+2.2;
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

/* Обломки арки и колонн — силуэт и укрытие на плато. */
function mkRuin(x,z,scale,yaw){
  scale = scale||1; yaw = (yaw===undefined)?rnd(0,6.283):yaw;
  const st = toonT(PAL.conc,'stone',1,1.4), sd = toonT(PAL.concDk,'stone',1,1);
  const R = 2.6*scale;
  // две колонны, одна обломана — асимметрия читается лучше симметрии
  for(const s of [-1,1]){
    const hgt = (s<0 ? 4.4 : 2.6)*scale;
    const px = PROP_wx(x,yaw,s*R,0), pz = PROP_wz(z,yaw,s*R,0);
    const g0 = gh(px,pz);
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.46*scale,0.56*scale,hgt,8), st);
    c.position.set(px, g0+hgt/2, pz); c.castShadow=c.receiveShadow=true; c.userData.shadowy=true; world.add(c);
    BOXES.push(new Box(px, g0+hgt/2, pz, 1.05*scale, hgt, 1.05*scale, 0));
    blk(px, g0-0.3, pz, 2.0*scale, 1.25*scale, 2.0*scale, sd, yaw, true, true);
  }
  // перемычка арки — только над целой колонной, вторая половина осыпалась
  const y0 = gh(x,z);
  const spanY = y0 + 4.4*scale;
  blk(PROP_wx(x,yaw,-R*0.45,0), spanY, PROP_wz(z,yaw,-R*0.45,0), R*1.5, 0.62*scale, 1.1*scale, sd, yaw);
  const frag = new THREE.Mesh(new THREE.IcosahedronGeometry(0.75*scale,0), st);
  frag.position.set(PROP_wx(x,yaw,R*0.6,0.5), spanY-0.3, PROP_wz(z,yaw,R*0.6,0.5));
  frag.rotation.set(0.6,0.9,0.4); frag.castShadow=true; frag.userData.shadowy=true; world.add(frag);
  // осыпь у подножия. Смещения и размеры фиксированы, а размер нарочно
  // держится ниже 0.9: такие камни не заводят коробку столкновений и не
  // превращаются в случайные препятствия там, где их никто не планировал.
  mkRock(PROP_wx(x,yaw,2.2*scale,-1.4*scale), PROP_wz(z,yaw,2.2*scale,-1.4*scale), 0.75*scale);
  mkRock(PROP_wx(x,yaw,-2.0*scale,2.4*scale), PROP_wz(z,yaw,-2.0*scale,2.4*scale), 0.62*scale);
  return spanY;
}

/* ======================================================================
   «ОСАДА»: конструкторы замка, лагеря и посада (MAPDESIGN §3, §6, §9)

   Всё новое строится по трём правилам:
     1) пол любой площадки лежит на CFG.floor1 / CFG.floor2 (§1);
     2) любой марш, пандус и въезд — это РАМПА, ступени только визуальные
        и несплошные (§9), иначе возвращается застревание на подступёнке;
     3) материалы берутся из короткого фиксированного набора: склейка
        статики группирует по материалу, и каждый лишний материал —
        это лишний меш в кадре.
   ====================================================================== */

/* ---------------------- ПАЛИТРА МАТЕРИАЛОВ КАРТЫ ----------------------
   Этажи различаются не только высотой, но и тоном (§6): низ тёмный и тёплый,
   боевой ход средний, верх светлый. Замок — песчаник, лагерь — серое дерево,
   посад — нейтральный камень. Повторы карты — константы, см. PROP_rep. */
const PROP_MTC = {};
function PROP_mt(k){
  let m = PROP_MTC[k];
  if(m) return m;
  switch(k){
    /* замок: тёплый песчаник, три тона по этажам */
    case 'sand0': m = toonT(0x9c8757,'stone',2,1); break;
    case 'sand1': m = toonT(PAL.sand,'stone',2,1); break;
    case 'sand2': m = toonT(0xd8c795,'stone',2,1); break;
    case 'sandT': m = toonT(0xb09a63,'stone',1,2); break;
    /* посад: нейтральный серый камень */
    case 'gray0': m = toonT(0x6f6a5f,'stone',2,1); break;
    case 'gray1': m = toonT(PAL.concDk,'stone',2,1); break;
    case 'gray2': m = toonT(PAL.conc,'stone',2,1); break;
    case 'grayL': m = toonT(0xc3b9a2,'stone',2,1); break;
    /* лагерь: серое выветренное дерево */
    case 'wood0': m = toonT(0x6b6157,'wood',1,2); break;
    case 'wood1': m = toonT(0x9b9184,'plank',2,1); break;
    case 'wood2': m = toonT(0xb8ae9c,'plank',2,1); break;
    case 'beam':  m = toonT(PAL.woodDk,'wood',0.6,3); break;
    case 'plank': m = toonT(PAL.plank,'plank',2,1); break;
    /* прочее */
    case 'tile':  m = toonT(0xa85f42,'roof',2,1); break;
    case 'cloth': m = toonT(0xbfb193,'cloth',2,2); break;
    case 'iron':  m = toonT(PAL.metalDk,'metal',1,1); break;
    case 'rust':  m = toonT(PAL.rust,'rust',1,1); break;
    case 'dirt':  m = toonT(PAL.dirt,'dirt',2,2); break;
    default:      m = toonT(PAL.conc,'stone',2,1);
  }
  PROP_MTC[k] = m;
  return m;
}

/* Низкая коллизионная «полка» внутри высокого препятствия. Своего меша не даёт
   и на глаз ничего не меняет: она сидит внутри уже стоящей коробки (или на
   ладонь шире неё). Нужна автопроверке проходимости (§7.5) — та меряет опору
   впереди не выше роста игрока, и без полки высокая стена на склоне
   неотличима от ступеньки, через которую игрок обязан перешагнуть.
   На ровной земле полка не нужна: там уступ впереди и так нулевой, а лишняя
   коробка стоит перебора в rayBoxes на каждой пуле.

   h — высота полки (по умолчанию 1.2), ext — насколько она шире препятствия.
   ext нужен там, где препятствие тонкое (столб, забор) или где игрок упирается
   в него, стоя сбоку от следа: без запаса опоры впереди снова нет. */
function PROP_shelf(x,y,z,sx,sz,yaw,h,ext){
  const g = gh(x,z);
  if(Math.abs(gh(x+0.6,z)-g) < 0.04 && Math.abs(gh(x-0.6,z)-g) < 0.04 &&
     Math.abs(gh(x,z+0.6)-g) < 0.04 && Math.abs(gh(x,z-0.6)-g) < 0.04) return;
  h = h || 1.2; ext = ext || 0;
  BOXES.push(new Box(x, y+h/2, z, sx+ext, h, sz+ext, yaw||0));
}

/* Плита по прямоугольнику: удобнее, чем центр+габарит, когда карта
   выкладывается по осям. yTop — верх плиты, то есть пол, по которому ходят. */
function PROP_slab(x0,z0,x1,z1,yTop,th,mat,solid,noShadow){
  if(x1-x0 < 0.04 || z1-z0 < 0.04) return;
  blk((x0+x1)/2, yTop-th, (z0+z1)/2, x1-x0, th, z1-z0, mat, 0, solid, noShadow);
}
/* Настил с прямоугольным проёмом — до четырёх плит. Нужен везде, где снизу
   выходит лестница: без проёма марш упирается в потолок. */
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

/* Марш / пандус / въезд. Ступени видимые и НЕсплошные, коллизия — рампа.
   Под рампой при opts.body !== false кладём каменное тело: иначе марш
   становится прозрачным для пуль и линий видимости, а это уже не лестница,
   а дыра в укрытии. Верх тела на 0.55 ниже наклонной поверхности, поэтому
   ходьбе оно не мешает. */
function mkMarch(bx,bz,tx,tz,w,y0,y1,opts){
  opts = opts || {};
  const rise = y1 - y0;
  const dx = tx-bx, dz = tz-bz, len = Math.hypot(dx,dz);
  if(len < 0.4 || rise <= 0.02) return false;
  const thin = opts.thin;                       // парящие ступени (винтовая)
  /* Тело марша строит сам addRamp: его секции гарантированно не выходят выше
     наклонной поверхности. Но у парящих маршей тела быть не должно: в
     винтовой лестнице тело СЛЕДУЮЩЕГО марша встаёт стеной поперёк
     предыдущего ровно на повороте, и лестница перестаёт проходиться. */
  const onRamp = PROP_ramp(bx,bz,tx,tz,w,y0,y1, (opts.body !== false) && !thin);
  const yaw = Math.atan2(-dz, dx);              // локаль модуля: +X вдоль марша
  const mat = opts.mat || PROP_mt('gray1');
  const maxRise = onRamp ? 0.44 : Math.min(CFG.step-0.04, 0.40);
  const n = Math.max(2, Math.ceil(rise/maxRise));
  const st = rise/n, run = len/n;
  for(let i=0;i<n;i++){
    const o = (i+0.5)*run;
    const px = PROP_wx(bx,yaw,o,0), pz = PROP_wz(bz,yaw,o,0);
    if(thin){
      blk(px, y0 + (i+1)*st - 0.16, pz, run+0.04, 0.16, w, mat, yaw, !onRamp, true);
    } else {
      // ступень-колонна от основания: сбоку читается сплошной каменный клин
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

/* Винтовая (поворотная) лестница: четыре марша по сторонам квадратного
   колодца вокруг центрального столба. Вход внизу и выход наверху — над
   ОДНИМ и тем же углом, поэтому вызывающий обязан оставить в перекрытии
   проём на колодец и положить площадку в углу выхода.
   corner — с какого угла начинается подъём (0..3, см. PROP_SPIN). */
const PROP_SPIN = [[-1,-1],[1,-1],[1,1],[-1,1]];
function mkSpiral(cx,cz,y0,y1,R,corner,mat,newel,flights){
  corner = ((corner|0)%4+4)%4;
  mat = mat || PROP_mt('sand1');
  // отрицательный newel — столба не рисуем, но внутренний радиус держим:
  // так лестница обвивает уже стоящий предмет (обелиск)
  newel = (newel===undefined) ? 0.55 : newel;
  flights = flights || 4;                       // 5 маршей — выход на 90° от входа
  const nr = Math.max(0.5, Math.abs(newel));
  const m = (R + nr)/2;                         // осевая линия марша
  const w = Math.max(1.2, R - nr);
  const dy = (y1-y0)/flights;
  for(let k=0;k<flights;k++){
    const a = PROP_SPIN[(corner+k)%4], b = PROP_SPIN[(corner+k+1)%4];
    mkMarch(cx+a[0]*m, cz+a[1]*m, cx+b[0]*m, cz+b[1]*m, w,
            y0 + k*dy, y0 + (k+1)*dy, { mat:mat, thin:true });
  }
  if(newel > 0.05) blk(cx, y0-0.3, cz, newel*2, (y1-y0)+0.6, newel*2, mat, 0, true, true);
  const c = PROP_SPIN[(corner+flights)%4];
  /* Верхняя площадка: последний марш кончается ровно в углу колодца, и без
     этой плиты сойти с него некуда — под ногами дыра в перекрытии.
     Внутрь колодца плита НЕ заходит: её торец оказался бы ступенькой выше
     CFG.step прямо посреди марша, и лестница перестала бы проходиться.
     За углом рампа уже держит ровную площадку на y1, стык получается в ноль. */
  const ax0 = cx + c[0]*(m+0.35), ax1 = cx + c[0]*(R+0.55);
  const az0 = cz + c[1]*(m+0.35), az1 = cz + c[1]*(R+0.55);
  PROP_slab(Math.min(ax0,ax1), Math.min(az0,az1), Math.max(ax0,ax1), Math.max(az0,az1),
            y1, 0.4, mat, true, true);
  return { sx:c[0], sz:c[1], x:cx + c[0]*m, z:cz + c[1]*m };
}

/* Зубцы: чередование мерлонов и бойниц вдоль отрезка. off — вынос от осевой
   линии стены (зубцы стоят по наружному краю боевого хода). */
function mkBattlement(x,z,len,yaw,y,off,th,mat,h){
  h = h || 1.25;
  const per = 3.15, n = Math.max(1, Math.round(len/per)), st = len/n;
  const mw = Math.min(2.05, st-0.95);
  if(mw < 0.4) return;
  for(let i=0;i<n;i++){
    const o = (i+0.5)*st - len/2;
    blk(PROP_wx(x,yaw,o,off), y, PROP_wz(z,yaw,o,off), mw, h, th, mat, yaw, true, i%2===1);
  }
}

/* Крепостная стена с боевым ходом. Верх стены И ЕСТЬ пол этажа 1: отдельного
   настила нет, поэтому кольцо получается сплошным без единого стыка.
   gaps — проёмы: {c (смещение вдоль стены), w, b (низ, мир), t (верх, мир)}. */
function mkRampart(x1,z1,x2,z2,topY,th,opts){
  opts = opts || {};
  const dx = x2-x1, dz = z2-z1, len = Math.hypot(dx,dz);
  if(len < 0.5) return;
  const yaw = Math.atan2(-dz, dx);
  const cx = (x1+x2)/2, cz = (z1+z2)/2;
  const mat  = opts.mat  || PROP_mt('sand1');
  const matL = opts.matL || PROP_mt('sand2');
  const gaps = (opts.gaps || []).slice().sort((a,b)=> a.c-b.c);

  // сплошные участки между проёмами, каждый нарезан на куски по рельефу
  const spans = [];
  let cur = -len/2;
  for(const q of gaps){
    const a = q.c - q.w/2, b = q.c + q.w/2;
    if(a - cur > 0.06) spans.push([cur, a]);
    if(b > cur) cur = b;
  }
  if(len/2 - cur > 0.06) spans.push([cur, len/2]);
  for(const s of spans){
    const L = s[1]-s[0], n = Math.max(1, Math.round(L/5.5)), sl = L/n;
    for(let i=0;i<n;i++){
      const o = s[0] + (i+0.5)*sl;
      const px = PROP_wx(cx,yaw,o,0), pz = PROP_wz(cz,yaw,o,0);
      const g0 = gh(px,pz) - 0.6;
      blk(px, g0, pz, sl+0.03, topY-g0, th, mat, yaw, true, i%2===1);
      PROP_shelf(px, gh(px,pz), pz, sl+0.03, th, yaw, 1.2, 0.5);
    }
  }
  // перемычки над проёмами и парапеты под бойницами
  for(const q of gaps){
    const px = PROP_wx(cx,yaw,q.c,0), pz = PROP_wz(cz,yaw,q.c,0);
    const g0 = gh(px,pz) - 0.6;
    if(topY - q.t > 0.06) blk(px, q.t, pz, q.w, topY-q.t, th, mat, yaw, true, true);
    if(q.b - g0 > 0.06)   blk(px, g0,  pz, q.w, q.b-g0,  th, mat, yaw, true, true);
  }
  // зубцы по наружной стороне, изнутри ход открыт во двор
  if(opts.merlon !== false){
    const off = (opts.side===undefined?1:opts.side) * (th/2 - 0.28);
    mkBattlement(cx, cz, len, yaw, topY, off, 0.56, matL, opts.mh);
  }
  if(opts.kerb){   // низкий внутренний бортик там, где падать особенно глупо
    const off = -(opts.side===undefined?1:opts.side) * (th/2 - 0.16);
    blk(PROP_wx(cx,yaw,0,off), topY, PROP_wz(cz,yaw,0,off), len, 0.42, 0.3, matL, yaw, true, true);
  }
}

/* Воротная башня: проезд насквозь, над ним боевой ход, по бокам — два
   массива с турелями. Стоит на осевой линии стены, yaw вдоль стены. */
function mkGatehouse(x,z,yaw,topY,openW,th,side,mat,matL){
  mat = mat || PROP_mt('sand1'); matL = matL || PROP_mt('sand2');
  side = (side===undefined) ? -1 : side;     // куда смотрит наружная грань
  const D = th + 2.2, out = side*(D/2 - 0.9);
  for(const s of [-1,1]){
    const o = s*(openW/2 + 1.6);
    const px = PROP_wx(x,yaw,o,0), pz = PROP_wz(z,yaw,o,0);
    const g0 = gh(px,pz) - 0.6;
    blk(px, g0, pz, 3.2, topY-g0, D, mat, yaw, true);
    PROP_shelf(px, gh(px,pz), pz, 3.2, D, yaw, 1.2, 0.5);
    /* Турель стоит на НАРУЖНОМ выносе башни. Раньше она садилась на осевую
       линию и перегораживала боевой ход: кольцо (§3.1) рвалось ровно над
       воротами, а это единственная деталь замка, ради которой он и строился. */
    blk(PROP_wx(px,yaw,0,out), topY, PROP_wz(pz,yaw,0,out), 2.0, 2.8, 1.8, matL, yaw, true);
    blk(PROP_wx(px,yaw,0,out), topY+2.8, PROP_wz(pz,yaw,0,out), 2.5, 0.4, 2.3, matL, yaw, true, true);
  }
  // машикули над проездом — козырёк, из-под которого стреляют вниз
  const gx = PROP_wx(x,yaw,0,side*(D/2-0.35)), gz = PROP_wz(z,yaw,0,side*(D/2-0.35));
  blk(gx, topY-0.9, gz, openW+1.0, 0.5, 0.7, matL, yaw, true, true);
  mkBattlement(x, z, openW+0.4, yaw, topY, side*(D/2-0.3), 0.5, matL, 1.15);
}

/* Угловая башня замка. Её пол на этаже 1 — часть кольца боевого хода (входы
   с двух сторон открыты), внутри винтовая лестница на этаж 2. Верх открыт
   сверху: за обзор платишь заметностью (§5).
   openX/openZ — с каких сторон в башню входит боевой ход (знаки по осям). */
function mkCornerTower(cx,cz,yFloor,yTop,size,corner,openX,openZ){
  const mat = PROP_mt('sandT'), matL = PROP_mt('sand2'), mat0 = PROP_mt('sand0');
  const h = size/2, wall = 0.62, ih = h - wall;
  const g0 = gh(cx,cz) - 0.6;
  blk(cx, g0, cz, size, yFloor-g0, size, mat0, 0, true);      // цоколь
  PROP_shelf(cx, gh(cx,cz), cz, size, size, 0, 1.2, 0.5);
  const side = (sx,sz,open)=>{
    const px = cx + sx*(h-wall/2), pz = cz + sz*(h-wall/2);
    const L = size, rest = (L-3.0)/2;
    if(!open){
      blk(px, yFloor, pz, sx?wall:L, yTop-yFloor, sz?wall:L, mat, 0, true, true);
      return;
    }
    for(const s of [-1,1]){
      if(sx) blk(px, yFloor, pz + s*(3.0+rest)/2, wall, yTop-yFloor, rest, mat, 0, true, true);
      else   blk(px + s*(3.0+rest)/2, yFloor, pz, rest, yTop-yFloor, wall, mat, 0, true, true);
    }
    if(sx) blk(px, yFloor+2.7, pz, wall, yTop-yFloor-2.7, 3.0, mat, 0, true, true);
    else   blk(px, yFloor+2.7, pz, 3.0, yTop-yFloor-2.7, wall, mat, 0, true, true);
  };
  side(-1,0, openX<0); side(1,0, openX>0); side(0,-1, openZ<0); side(0,1, openZ>0);

  // винтовая в углу колодца, площадка выхода — четверть колодца
  const R = 2.35;
  const sp = PROP_SPIN[((corner|0)%4+4)%4];
  const wx = cx - sp[0]*(ih - R - 0.1), wz = cz - sp[1]*(ih - R - 0.1);
  mkSpiral(wx, wz, yFloor, yTop, R, corner, mat);
  mkDeckHole(cx-ih, cz-ih, cx+ih, cz+ih, wx-R-0.2, wz-R-0.2, wx+R+0.2, wz+R+0.2, yTop, 0.4, matL);
  for(const s of [-1,1]){
    mkBattlement(cx, cz + s*(h-0.3), size, 0, yTop, 0, 0.55, matL, 1.2);
    mkBattlement(cx + s*(h-0.3), cz, size, Math.PI/2, yTop, 0, 0.55, matL, 1.2);
  }
  return yTop;
}

/* Донжон: массив с плоской кровлей на этаже 2 и угловыми турелями.
   Кровля — пол площадки, поэтому её верх ровно на yTop. */
function mkKeep(x0,z0,x1,z1,yTop,opts){
  opts = opts || {};
  const mat = PROP_mt('sand1'), matL = PROP_mt('sand2'), mat0 = PROP_mt('sand0');
  const cx = (x0+x1)/2, cz = (z0+z1)/2, sx = x1-x0, sz = z1-z0;
  const gy = gh(cx,cz), g0 = gy - 0.8;
  blk(cx, g0, cz, sx, yTop-g0, sz, mat, 0, true);
  blk(cx, g0, cz, sx+0.8, 3.4, sz+0.8, mat0, 0, true, true);          // цоколь
  for(const ax of [-1,1]) PROP_shelf(cx+ax*(sx/2+0.2), gy, cz, 0.6, sz+0.8, 0);
  for(const az of [-1,1]) PROP_shelf(cx, gy, cz+az*(sz/2+0.2), sx+0.8, 0.6, 0);
  blk(cx, yTop-1.6, cz, sx+0.5, 0.35, sz+0.5, matL, 0, false, true);  // поясок
  for(const ax of [-1,1]) for(const az of [-1,1])
    blk(cx+ax*(sx/2-1.1), yTop, cz+az*(sz/2-1.1), 2.2, 3.2, 2.2, matL, 0, true);
  /* Зубцы западной грани умеют разрываться дверным проёмом: сюда выходит
     лестничная башенка, а мерлон вставал ровно в её створе — и кровля
     оказывалась отрезана от единственной ведущей на неё лестницы. */
  const runs = (c, len, gap)=>{
    if(!gap) return [[c, len]];
    const a0 = c-len/2, a1 = c+len/2, q0 = gap.c-gap.w/2, q1 = gap.c+gap.w/2;
    const out = [];
    if(q0-a0 > 0.6) out.push([(a0+q0)/2, q0-a0]);
    if(a1-q1 > 0.6) out.push([(q1+a1)/2, a1-q1]);
    return out;
  };
  mkBattlement(cx, cz-sz/2+0.35, sx-4.6, 0, yTop, 0, 0.55, matL, 1.2);
  mkBattlement(cx, cz+sz/2-0.35, sx-4.6, 0, yTop, 0, 0.55, matL, 1.2);
  for(const r of runs(cz, sz-4.6, opts.gapW))
    mkBattlement(cx-sx/2+0.35, r[0], r[1], Math.PI/2, yTop, 0, 0.55, matL, 1.2);
  mkBattlement(cx+sx/2-0.35, cz, sz-4.6, Math.PI/2, yTop, 0, 0.55, matL, 1.2);
  for(let i=0;i<3;i++){
    const y = gy + 3.4 + i*3.4;
    for(const s of [-1,1]){
      blk(cx + s*2.1, y, cz - sz/2 - 0.05, 0.5, 1.6, 0.12, PROP_mt('iron'), 0, false, true);
      blk(cx + s*2.1, y, cz + sz/2 - 0.07, 0.5, 1.6, 0.12, PROP_mt('iron'), 0, false, true);
    }
  }
  return yTop;
}

/* Лестничная башенка: колодец винтовой лестницы между двумя этажами.
   din/dout — стороны входа внизу и выхода наверху, знаками по осям.

   Верхняя дверь прорезается НЕ по центру грани, а от того самого угла, в
   котором кончается винтовая: её площадка — четверть колодца в углу, и дверь
   посреди грани оказывалась от площадки за стеной. Угол выхода зависит от
   corner и flights, поэтому считаем его здесь же — тогда дверь и выход не
   могут разъехаться при смене числа маршей. */
function mkStairTurret(cx,cz,y0,y1,R,corner,din,dout,mat,flights){
  mat = mat || PROP_mt('sand1');
  const wall = 0.55, ih = R + 0.4;
  const g0 = gh(cx,cz) - 0.6;
  const yW = y1 + 2.4;              // стены поднимаются выше выхода: это башенка
  const ec = PROP_SPIN[((((corner|0)%4+4)%4) + (flights||4))%4];   // угол выхода винтовой
  blk(cx, g0, cz, (ih+wall)*2, y0-g0, (ih+wall)*2, PROP_mt('sand0'), 0, true);
  const face = (sx,sz)=>{
    const px = cx + sx*(ih+wall/2), pz = cz + sz*(ih+wall/2);
    const L = (ih+wall)*2, dw = 2.6;
    // дверные проёмы стоят НА полу своего этажа, а не посреди стены;
    // третье число — к какому концу грани прижат проём (0 — по центру)
    const holes = [];
    if(din  && din[0]===sx  && din[1]===sz)  holes.push([y0-0.1, y0+2.5, 0]);
    if(dout && dout[0]===sx && dout[1]===sz) holes.push([y1-0.1, yW, sx ? ec[1] : ec[0]]);
    holes.sort((a,b)=> a[0]-b[0]);
    const solidSeg = (yA,yB)=>{
      if(yB-yA < 0.05) return;
      if(sx) blk(px, yA, pz, wall, yB-yA, L, mat, 0, true, true);
      else   blk(px, yA, pz, L, yB-yA, wall, mat, 0, true, true);
    };
    let cur = y0;
    for(const q of holes){
      solidSeg(cur, q[0]);
      const dh = q[1]-q[0], o = q[2]*(L/2 - dw/2);
      for(const g of [[-L/2, o-dw/2],[o+dw/2, L/2]]){
        const ln = g[1]-g[0];
        if(ln < 0.05) continue;
        const c = (g[0]+g[1])/2;
        if(sx) blk(px, q[0], pz + c, wall, dh, ln, mat, 0, true, true);
        else   blk(px + c, q[0], pz, ln, dh, wall, mat, 0, true, true);
      }
      cur = q[1];
    }
    solidSeg(cur, yW);
  };
  face(-1,0); face(1,0); face(0,-1); face(0,1);
  // шатёр над колодцем: под ним остаётся полный рост
  const roof = new THREE.Mesh(new THREE.ConeGeometry((ih+wall)*1.5, 2.2, 4), PROP_mt('tile'));
  roof.position.set(cx, yW+1.1, cz); roof.rotation.y = Math.PI/4;
  roof.castShadow = true; roof.userData.shadowy = true; world.add(roof);
  return mkSpiral(cx, cz, y0, y1, R, corner, mat, undefined, flights);
}

/* Помост / перекрытие / настил на стойках. Пол — ровно yTop.
   rail — строка сторон ('n','s','e','w'), где ставить перила. */
function mkDeck(x0,z0,x1,z1,yTop,opts){
  opts = opts || {};
  const mat = opts.mat || PROP_mt('wood1');
  const pm  = opts.post || PROP_mt('beam');
  const th  = opts.th || 0.3;
  PROP_slab(x0,z0,x1,z1,yTop,th,mat,true);
  if(opts.posts !== false){
    const step = opts.postStep || 6.5;
    const nx = Math.max(1, Math.round((x1-x0)/step)), nz = Math.max(1, Math.round((z1-z0)/step));
    for(let i=0;i<=nx;i++) for(let j=0;j<=nz;j++){
      if(i>0 && i<nx && j>0 && j<nz) continue;         // стойки только по контуру
      const px = lerp(x0+0.4, x1-0.4, i/nx), pz = lerp(z0+0.4, z1-0.4, j/nz);
      const g0 = gh(px,pz);
      if(yTop-th-g0 > 0.6){
        blk(px, g0, pz, 0.34, yTop-th-g0, 0.34, pm, 0, true, true);
        PROP_shelf(px, g0, pz, 0.34, 0.34, 0, 1.2, 0.7);
      }
    }
  }
  const r = opts.rail || '';
  const rm = opts.railMat || pm;
  if(r.indexOf('s')>=0) blk((x0+x1)/2, yTop, z0+0.12, x1-x0, 1.0, 0.16, rm, 0, true, true);
  if(r.indexOf('n')>=0) blk((x0+x1)/2, yTop, z1-0.12, x1-x0, 1.0, 0.16, rm, 0, true, true);
  if(r.indexOf('w')>=0) blk(x0+0.12, yTop, (z0+z1)/2, 0.16, 1.0, z1-z0, rm, 0, true, true);
  if(r.indexOf('e')>=0) blk(x1-0.12, yTop, (z0+z1)/2, 0.16, 1.0, z1-z0, rm, 0, true, true);
  return yTop;
}

/* Частокол: заострённые брёвна в ряд. Дёшев по мешам — одна коробка на
   секцию плюс редкие «зубы» сверху. */
function mkPalisade(x,z,len,yaw,h,mat){
  mat = mat || PROP_mt('wood0');
  h = h || 4.0;
  const y = gh(x,z);
  const n = Math.max(1, Math.round(len/5.5)), sl = len/n;
  for(let i=0;i<n;i++){
    const o = (i+0.5)*sl - len/2;
    const px = PROP_wx(x,yaw,o,0), pz = PROP_wz(z,yaw,o,0);
    blk(px, gh(px,pz), pz, sl+0.02, h, 0.5, mat, yaw, false, i%2===1);
    PROP_shelf(px, gh(px,pz), pz, sl+0.02, 0.5, yaw, 1.2, 0.5);
  }
  const tipN = Math.max(2, Math.round(len/2.4));
  for(let i=0;i<tipN;i++){
    const o = (i+0.5)*len/tipN - len/2;
    const px = PROP_wx(x,yaw,o,0), pz = PROP_wz(z,yaw,o,0);
    const c = new THREE.Mesh(new THREE.ConeGeometry(0.3,0.7,4), mat);
    c.position.set(px, gh(px,pz)+h+0.3, pz); c.rotation.y = yaw;
    world.add(c);
  }
  BOXES.push(new Box(x, y+h/2, z, len, h, 0.5, yaw));
  return y+h;
}

/* Палатка: четырёхскатный шатёр с флажком. Один меш плюс коробка коллизии. */
function mkTent(x,z,yaw,col,scale){
  scale = scale || 1;
  const y = gh(x,z);
  const R = 2.6*scale, H = 3.2*scale;
  const m = new THREE.Mesh(new THREE.ConeGeometry(R, H, 4), toonT(col||0xbfb193,'cloth',2,2));
  m.position.set(x, y+H/2, z); m.rotation.y = yaw + Math.PI/4;
  m.castShadow = m.receiveShadow = true; m.userData.shadowy = true; world.add(m);
  const p = new THREE.Mesh(new THREE.CylinderGeometry(0.06,0.06,1.0,5), PROP_mt('beam'));
  p.position.set(x, y+H+0.4, z); world.add(p);
  BOXES.push(new Box(x, y+H*0.34, z, R*1.25, H*0.68, R*1.25, yaw+Math.PI/4));
  PROP_shelf(x, y, z, R*1.25, R*1.25, yaw+Math.PI/4);
  return y+H;
}

/* Обозная телега: кузов, борта, колёса. Укрытие и силуэт лагеря. */
function mkWagon(x,z,yaw){
  const y = gh(x,z);
  const wood = PROP_mt('wood0'), pl = PROP_mt('wood1');
  blk(x, y+0.75, z, 4.2, 0.9, 2.0, pl, yaw, true);
  for(const s of [-1,1])
    blk(PROP_wx(x,yaw,0,s*1.0), y+1.65, PROP_wz(z,yaw,0,s*1.0), 4.2, 0.7, 0.16, wood, yaw, false, true);
  for(const sx of [-1,1]) for(const sz of [-1,1]){
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.72,0.72,0.18,10), wood);
    w.position.set(PROP_wx(x,yaw,sx*1.5,sz*1.05), y+0.72, PROP_wz(z,yaw,sx*1.5,sz*1.05));
    w.rotation.x = Math.PI/2; w.rotation.z = yaw;
    w.castShadow = true; w.userData.shadowy = true; world.add(w);
  }
  blk(PROP_wx(x,yaw,2.9,0), y+1.1, PROP_wz(z,yaw,2.9,0), 1.8, 0.16, 0.16, wood, yaw, false, true);
  return y+1.65;
}

/* Колодец во дворе замка. */
function mkWell(x,z){
  const y = gh(x,z);
  const st = PROP_mt('sand0');
  const r = new THREE.Mesh(new THREE.CylinderGeometry(1.15,1.25,1.1,10), st);
  r.position.set(x,y+0.55,z); r.castShadow=true; r.userData.shadowy=true; world.add(r);
  BOXES.push(new Box(x,y+0.55,z,2.3,1.1,2.3,0));
  for(const s of [-1,1]) blk(x+s*1.0, y+1.1, z, 0.2, 2.0, 0.2, PROP_mt('beam'), 0, false, true);
  blk(x, y+3.0, z, 2.6, 0.24, 1.2, PROP_mt('tile'), 0, false, true);
  return y;
}

/* Осадная башня BLU: деревянный массив с площадкой этажа 2, откидным
   мостом вперёд и винтовой лестницей от помоста (этаж 1) наверх. */
function mkSiegeTower(cx,cz,yFloor,yTop,size,corner,gapSide){
  const wood = PROP_mt('wood0'), pl = PROP_mt('wood1'), pl2 = PROP_mt('wood2');
  const h = size/2, g0 = gh(cx,cz);
  for(const ax of [-1,1]) for(const az of [-1,1])
    blk(cx+ax*(h-0.4), g0, cz+az*(h-0.4), 0.8, yTop-g0, 0.8, wood, 0, true);
  // нижний ярус зашит наглухо со всех сторон: это и щит для лагеря за спиной
  for(const ax of [-1,1])
    blk(cx+ax*(h-0.16), g0, cz, 0.32, yFloor-g0, size, pl, 0, true, true);
  for(const az of [-1,1])
    blk(cx, g0, cz+az*(h-0.16), size, yFloor-g0, 0.32, pl, 0, true, true);
  // пол этажа 1 внутри башни: сюда выходят обе ветки помостов
  PROP_slab(cx-h+0.3, cz-h+0.3, cx+h-0.3, cz+h-0.3, yFloor, 0.32, pl, true, true);
  // верхний ярус: тыл зашит, борта с проёмами под помосты, фронт открыт на замок
  blk(cx, yFloor, cz-(h-0.16), size, yTop-yFloor, 0.32, pl, 0, true, true);
  for(const ax of [-1,1]){
    const rest = (size-3.4)/2;
    for(const s of [-1,1])
      blk(cx+ax*(h-0.16), yFloor, cz + s*(3.4+rest)/2, 0.32, yTop-yFloor, rest, pl, 0, true, true);
    blk(cx+ax*(h-0.16), yFloor+2.8, cz, 0.32, yTop-yFloor-2.8, 3.4, pl, 0, true, true);
  }
  const R = 2.4;
  const sp = PROP_SPIN[((corner|0)%4+4)%4];
  const wx = cx - sp[0]*(h - R - 0.9), wz = cz - sp[1]*(h - R - 0.9);
  mkSpiral(wx, wz, yFloor, yTop, R, corner, pl2);
  const ih = h - 0.32;
  mkDeckHole(cx-ih, cz-ih, cx+ih, cz+ih, wx-R-0.2, wz-R-0.2, wx+R+0.2, wz+R+0.2, yTop, 0.34, pl2);
  // бортик площадки; с той стороны, где gapSide, оставляем проход на мостки
  const rail = (sx,sz)=>{
    const px = cx + sx*(h-0.2), pz = cz + sz*(h-0.2);
    const hi = (sz>0) ? 0.75 : 1.15;             // на север смотрят — там ниже
    const side = sx<0?'w':(sx>0?'e':(sz<0?'s':'n'));
    if(gapSide === side){
      const rest = (size-2.8)/2;
      for(const s of [-1,1]){
        if(sx) blk(px, yTop, pz + s*(2.8+rest)/2, 0.3, hi, rest, pl2, 0, true, true);
        else   blk(px + s*(2.8+rest)/2, yTop, pz, rest, hi, 0.3, pl2, 0, true, true);
      }
      return;
    }
    if(sx) blk(px, yTop, pz, 0.3, hi, size, pl2, 0, true, true);
    else   blk(px, yTop, pz, size, hi, 0.3, pl2, 0, true, true);
  };
  rail(-1,0); rail(1,0); rail(0,-1); rail(0,1);
  blk(cx, yTop+0.9, cz+h+1.4, size-1.6, 0.3, 3.4, pl, 0, false, true);   // откидной мост
  return yTop;
}

/* Руина посада: коробка стен с проломами, при deckY — уцелевшее перекрытие
   (этаж 1) и обломки парапета над ним. Улочки между руинами узкие: прострела
   насквозь нет, а перебежка есть. */
function mkRuinHouse(x0,z0,x1,z1,opts){
  opts = opts || {};
  const mat = opts.mat || PROP_mt('gray1');
  const matL = opts.matL || PROP_mt('gray2');
  const cx = (x0+x1)/2, cz = (z0+z1)/2;
  const wallY = opts.deckY || (gh(cx,cz) + 3.4);
  const th = 0.6;
  const open = opts.open || '';    // с каких сторон стена разрушена (проход)
  /* Низ считаем по земле ПОД КАЖДЫМ куском стены, а не по центру дома:
     на склоне общий низ оставлял стену висеть в полуметре над землёй, и под
     ней открывалась щель — и для взгляда, и для пули. */
  /* Стена собирается из двух коробок: цоколь пошире и сама стена. Цоколь
     нужен не для красоты — он даёт честную опору впереди, и автопроверка
     проходимости (§7.5) отличает стену от ступеньки, на которую надо
     перешагнуть. Заодно на склоне стена перестаёт висеть в воздухе. */
  const piece = (px,pz,sx,sz,yTop,ext)=>{
    // ext — напуск по длине: у глухой стены углы перекрываются, у стены
    // с проломом напуска нет, иначе цоколь съедает сам проход
    if(sx < sz) sz += (ext||0); else sx += (ext||0);
    // земля вдоль куска стены гуляет, поэтому цоколь считаем по САМОЙ высокой
    // её точке, а низ — по самой низкой: иначе на склоне цоколь либо уходит
    // под землю, либо повисает, и стена перестаёт читаться как стена
    let lo = 1e9, hi = -1e9;
    for(let i=0;i<=4;i++){
      const t = i/4 - 0.5;
      const g = gh(px + sx*t, pz + sz*t);
      if(g < lo) lo = g;
      if(g > hi) hi = g;
    }
    const g0 = lo - 0.7;
    const pl = Math.min(hi + 0.72, yTop - 0.3);
    // цоколь шире стены ПОПЕРЁК, но не длиннее её: иначе он лезет в проломы
    // и сужает проходы, ради которых руины и стоят
    const ex = (sx < sz) ? 1.1 : 0, ez = (sz < sx) ? 1.1 : 0;
    blk(px, g0, pz, sx+ex, pl-g0, sz+ez, matL, 0, true, true);
    // на склоне цоколь вырастает выше головы и перестаёт читаться как опора
    // впереди — потому его коллизия продолжена низкой полкой. Запас ей даём
    // только ВДОЛЬ стены: поперёк она сузила бы улочки и створы маршей
    PROP_shelf(px, lo, pz, sx+ex+(sx>sz?0.5:0), sz+ez+(sz>sx?0.5:0), 0, 1.4, 0);
    if(yTop - pl > 0.1) blk(px, pl, pz, sx, yTop-pl, sz, mat, 0, true, true);
  };
  const wall = (L,horiz,pos,side)=>{
    if(open.indexOf(side) >= 0){
      const seg = (L-3.2)/2;
      if(seg > 0.4) for(const s of [-1,1]){
        const o = s*(3.2+seg)/2;
        if(horiz) piece(cx+o, pos, seg, th, wallY, 0);
        else      piece(pos, cz+o, th, seg, wallY, 0);
      }
      // перемычка над проломом остаётся: этаж 1 держится на ней
      if(horiz) blk(cx, wallY-1.0, pos, 3.2, 1.0, th, mat, 0, true, true);
      else      blk(pos, wallY-1.0, cz, th, 1.0, 3.2, mat, 0, true, true);
    } else {
      if(horiz) piece(cx, pos, L, th, wallY, 0.9);
      else      piece(pos, cz, th, L, wallY, 0.9);
    }
  };
  wall(x1-x0, true,  z0+th/2, 's');
  wall(x1-x0, true,  z1-th/2, 'n');
  wall(z1-z0, false, x0+th/2, 'w');
  wall(z1-z0, false, x1-th/2, 'e');
  if(opts.deckY){
    const hole = opts.hole;
    if(hole) mkDeckHole(x0,z0,x1,z1, hole[0],hole[1],hole[2],hole[3], opts.deckY, 0.42, matL);
    else PROP_slab(x0,z0,x1,z1, opts.deckY, 0.42, matL, true);
    const par = opts.par===undefined ? 'nsew' : opts.par;
    if(par.indexOf('s')>=0) blk(cx, opts.deckY, z0+0.35, (x1-x0)*0.62, 1.05, 0.55, matL, 0, true, true);
    if(par.indexOf('n')>=0) blk(cx, opts.deckY, z1-0.35, (x1-x0)*0.62, 1.05, 0.55, matL, 0, true, true);
    if(par.indexOf('w')>=0) blk(x0+0.35, opts.deckY, cz, 0.55, 1.05, (z1-z0)*0.62, matL, 0, true, true);
    if(par.indexOf('e')>=0) blk(x1-0.35, opts.deckY, cz, 0.55, 1.05, (z1-z0)*0.62, matL, 0, true, true);
  }
  return opts.deckY || wallY;
}

/* Каменная опора моста этажа 2: столб от земли до площадки наверху. */
function mkPier(cx,cz,size,yTop,opts){
  opts = opts || {};
  const mat = opts.mat || PROP_mt('gray1'), matL = opts.matL || PROP_mt('grayL');
  const h = size/2, g0 = gh(cx,cz) - 0.6;
  blk(cx, g0, cz, size, yTop-g0-0.42, size, mat, 0, true);
  PROP_shelf(cx, gh(cx,cz), cz, size, size, 0, 1.2, 0.5);
  PROP_slab(cx-h, cz-h, cx+h, cz+h, yTop, 0.42, matL, true, true);
  const r = opts.rail===undefined ? 'nsew' : opts.rail;
  if(r.indexOf('s')>=0) blk(cx, yTop, cz-h+0.25, size, 0.95, 0.5, matL, 0, true, true);
  if(r.indexOf('n')>=0) blk(cx, yTop, cz+h-0.25, size, 0.95, 0.5, matL, 0, true, true);
  if(r.indexOf('w')>=0) blk(cx-h+0.25, yTop, cz, 0.5, 0.95, size, matL, 0, true, true);
  if(r.indexOf('e')>=0) blk(cx+h-0.25, yTop, cz, 0.5, 0.95, size, matL, 0, true, true);
  return yTop;
}
