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
  const dk = toonT(PAL.woodDk,'plank',s*0.4,0.3);
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
function mkContainer(x,z,yaw,col,y){
  y = (y===undefined)?gh(x,z):y;
  const m = toonT(col,'plate',3,1.4);
  const dk = toonT(PAL.metalDk,'metal',3,1.4);
  blk(x,y,z,6.1,2.62,2.5,m,yaw);
  for(let i=-1;i<=1;i++){
    blk(x + Math.cos(yaw)*i*2.0, y+0.1, z - Math.sin(yaw)*i*2.0, 0.16,2.4,2.58, dk, yaw, false, true);
  }
  blk(x,y+2.55,z,6.2,0.14,2.6, dk, yaw, false, true);
  const dx = Math.sin(yaw)*1.28, dz = Math.cos(yaw)*1.28;
  blk(x+dx,y+0.15,z+dz,5.6,2.2,0.08, dk, yaw, false, true);
}
function mkRock(x,z,s,y){
  y = (y===undefined)?gh(x,z):y;
  const g = new THREE.IcosahedronGeometry(s,0);
  const m = new THREE.Mesh(g, toonT(Math.random()<0.5?PAL.rock:PAL.rockDk,'stone',1,1));
  m.position.set(x,y+s*0.55,z);
  m.scale.set(rnd(0.85,1.35), rnd(0.6,1.05), rnd(0.85,1.35));
  m.rotation.set(rnd(0,3),rnd(0,3),rnd(0,3));
  m.castShadow=m.receiveShadow=true; m.userData.shadowy=true; world.add(m);
  if(s>0.9) BOXES.push(new Box(x,y+s*0.5,z,s*1.7,s*1.1,s*1.7,rnd(0,1.5)));
}
function mkTree(x,z,dead,y){
  y = (y===undefined)?gh(x,z):y;
  const h = rnd(3.4,5.6);
  const bark = toonT(PAL.woodDk,'wood',0.6,3);
  const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.16,0.28,h,7), bark);
  tr.position.set(x,y+h/2,z); tr.rotation.z = rnd(-0.08,0.08);
  tr.castShadow=true; tr.userData.shadowy=true; world.add(tr);
  BOXES.push(new Box(x,y+h/2,z,0.5,h,0.5,0));
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
  BOXES.push(new Box(x, y+rows*0.44/2, z, len, rows*0.44, 0.7, yaw));
}
function mkFence(x,y,z,len,yaw){
  const post = toonT(PAL.woodDk,'wood',0.4,1.4), rail = toonT(PAL.plank,'plank',len*0.25,0.3);
  const n = Math.floor(len/2.2);
  for(let i=0;i<=n;i++){
    const off=(i-n/2)*2.2;
    blk(x+Math.cos(yaw)*off, y, z-Math.sin(yaw)*off, 0.18,1.5,0.18, post, yaw, false);
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
}
function mkWaterTower(x,z){
  const y = gh(x,z);
  const wood = toonT(PAL.woodDk,'wood',0.5,3);
  for(let i=0;i<4;i++){
    const a = i*Math.PI/2 + Math.PI/4;
    blk(x+Math.cos(a)*1.7, y, z+Math.sin(a)*1.7, 0.28, 5.2, 0.28, wood, a);
  }
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(2.5,2.5,3,12), toonT(PAL.metal,'plate',3,1.5));
  tank.position.set(x,y+6.7,z); tank.castShadow=true; tank.userData.shadowy=true; world.add(tank);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(2.8,1.3,12), toonT(PAL.rust,'roof',3,1));
  roof.position.set(x,y+8.85,z); roof.castShadow=true; roof.userData.shadowy=true; world.add(roof);
  // настил шире бака: вокруг него остаётся обход шириной больше метра,
  // иначе залезший наверх упирается в коллизию бака и стоять негде
  blk(x,y+5.1,z,7.0,0.2,7.0, toonT(PAL.plank,'plank',3,3), 0);
  BOXES.push(new Box(x,y+6.7,z,4.6,3,4.6,0));
  mkLadder(x, z+3.75, y, y+5.35, 0);
  return y+5.3;
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
function mkShack(x,z,w,d,h,yaw,team){
  const y = gh(x,z);
  const wall = toonT(PAL.plank,'plank',w*0.3,h*0.3), post = toonT(PAL.woodDk,'wood',0.5,1.5);
  const c=Math.cos(yaw), s=Math.sin(yaw);
  // фронт с дверью, тыл с окном, борта с бойницами
  mkWall(x + s*d/2, y, z + c*d/2, w, h, 0.24, yaw, 0, 1.3, 0, h, wall);         // дверь
  mkWall(x - s*d/2, y, z - c*d/2, w, h, 0.24, yaw, 0, 2.2, 1.0, 2.0, wall);     // окно
  mkWall(x + c*w/2, y, z - s*w/2, d, h, 0.24, yaw+Math.PI/2, 0, 1.8, 1.0, 1.9, wall);
  mkWall(x - c*w/2, y, z + s*w/2, d, h, 0.24, yaw+Math.PI/2, 0, 1.8, 1.0, 1.9, wall);
  blk(x,y+h,z,w+0.5,0.3,d+0.5, toonT(team||PAL.rust,'roof',w*0.3,d*0.3), yaw);
  blk(x,y+h+0.3,z,w*0.4,0.24,d+0.7, post, yaw, false, true);
  // крыша сарая — законный ярус: лестница с тыла
  mkLadder(PROP_wx(x,yaw,0,-(d/2+0.45)), PROP_wz(z,yaw,0,-(d/2+0.45)), y, y+h+0.32, yaw+Math.PI);
  return y+h+0.3;
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
  const rail = toonT(PAL.woodDk,'wood',0.4,Math.max(1,h*0.4));
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

/* Каменная лестница настоящими ступенями: подъём зажат по CFG.step,
   чтобы её проходили и игрок, и боты обычным шагом.
   y0 задают, когда лестница стартует не с земли (например, с крыши форта). */
function mkStairs(x,z,yaw,steps,rise,run,y0){
  rise = Math.min(rise===undefined?0.42:rise, CFG.step-0.02);
  run  = run===undefined?0.62:run;
  y0 = (y0===undefined)?gh(x,z):y0;
  const st = toonT(PAL.conc,'stone',1.2,0.5), sd = toonT(PAL.concDk,'stone',0.6,1.4);
  const W = 3.2;
  for(let i=0;i<steps;i++){
    const o = (i+0.5)*run;
    // ступень — колонна от основания: сбоку выходит сплошной каменный клин,
    // а не парящие плиты, и коллизия остаётся ровно на верхней грани
    blk(PROP_wx(x,yaw,o,0), y0-0.7, PROP_wz(z,yaw,o,0), run+0.05, (i+1)*rise+0.7, W, st, yaw, true, i%2===1);
  }
  // быки-опоры там, где марш уходит от земли (переход между ярусами)
  const L = steps*run;
  for(const f of [0.4,0.8]){
    const px = PROP_wx(x,yaw,L*f,0), pz = PROP_wz(z,yaw,L*f,0);
    const g0 = gh(px,pz), bot = y0-0.7;
    if(bot-g0 > 1.2) blk(px, g0, pz, 0.8, bot-g0+0.15, W*0.8, sd, yaw, false);
  }
  return y0 + steps*rise;
}

/* Мостки с перилами. y — высота пола (верх настила). */
function mkCatwalk(x,z,len,yaw,y,railed){
  const deck = toonT(PAL.plank,'plank',len*0.3,0.7);
  const post = toonT(PAL.woodDk,'wood',0.4,2);
  const W = 1.9;
  blk(x, y-0.22, z, len, 0.22, W, deck, yaw);
  // опоры до земли — там, где земля ниже настила; одна стойка на пролёт,
  // мостки и так висят на конструкциях, а лишние столбы только едят меши
  const n = Math.max(2, Math.round(len/4.2));
  for(let i=0;i<=n;i++){
    const o = (i/n-0.5)*(len-0.6);
    const px = PROP_wx(x,yaw,o,0), pz = PROP_wz(z,yaw,o,0);
    const g0 = gh(px,pz);
    if(y-0.22-g0 > 0.5) blk(px, g0, pz, 0.3, y-0.22-g0, 0.3, post, yaw, false, true);
  }
  if(railed!==false){
    // поручень делаем твёрдым: с мостков не должно смахивать случайным шагом
    const rail = toonT(PAL.rust,'metal',len*0.3,0.3);
    for(const s of [-1,1]){
      blk(PROP_wx(x,yaw,0,s*W/2), y+0.85, PROP_wz(z,yaw,0,s*W/2), len, 0.12, 0.1, rail, yaw, true, true);
      for(let i=0;i<=n;i+=2){
        const o=(i/n-0.5)*(len-0.4);
        blk(PROP_wx(x,yaw,o,s*W/2), y, PROP_wz(z,yaw,o,s*W/2), 0.1, 0.9, 0.1, post, yaw, false, true);
      }
    }
  }
  return y;
}

/* Строительные леса: несколько ярусов + лестницы между ними.
   Возвращает массив высот пола по ярусам (снизу вверх). */
function mkScaffold(x,z,w,d,levels,yaw){
  const y0 = gh(x,z);
  const pipe = toonT(PAL.metal,'metal',0.5,2.4);
  const deckM = toonT(PAL.plank,'plank',w*0.35,d*0.35);
  const step = 3.05, H = levels*step + 0.7;
  const hw=w/2, hd=d/2, decks=[];
  for(const ax of [-1,1]) for(const az of [-1,1])
    blk(PROP_wx(x,yaw,ax*hw,az*hd), y0, PROP_wz(z,yaw,ax*hw,az*hd), 0.24, H, 0.24, pipe, yaw, true, true);
  for(let i=1;i<=levels;i++){
    const y = y0 + i*step;
    blk(x, y, z, w, 0.22, d, deckM, yaw);
    decks.push(y+0.22);
    // обвязка яруса — и жёсткость каркаса, и бортик под mantle
    for(const az of [-1,1])
      blk(PROP_wx(x,yaw,0,az*hd), y+0.55, PROP_wz(z,yaw,0,az*hd), w+0.3, 0.12, 0.12, pipe, yaw, false, true);
    // лестницы чередуются по сторонам: заставляет бегать по ярусу, а не стоять
    const s = (i%2) ? -1 : 1;
    const lx = PROP_wx(x,yaw,s*(hw+0.42),0), lz = PROP_wz(z,yaw,s*(hw+0.42),0);
    mkLadder(lx, lz, y0 + (i-1)*step + (i>1?0.22:0), y+0.32, yaw + s*Math.PI/2);
  }
  // перила только на верхнем ярусе — ниже они бы забили силуэт
  const topY = decks[decks.length-1];
  for(const az of [-1,1])
    blk(PROP_wx(x,yaw,0,az*hd), topY+0.85, PROP_wz(z,yaw,0,az*hd), w, 0.12, 0.1, pipe, yaw, true, true);
  return decks;
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
  const post = toonT(PAL.woodDk,'wood',0.5,1.2);
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

/* Вышка с площадкой наверху и подъёмом. Возвращает высоту пола площадки.
   yaw поворачивает всю вышку: проёмы в бортике смотрят вдоль локального Z
   (-Z — лестница, +Z — стык с мостиком), поэтому вышка годится и как пилон. */
const MK_TOWER_R = 1.75;          // полурасстояние между стойками
const MK_TOWER_LAD = 2.48;        // вынос лестницы по локальному -Z
function mkTower(x,z,h,team,yaw){
  yaw = yaw||0;
  const y0 = gh(x,z);
  const under = y0 + h;              // низ настила
  const deck = under + 0.28;         // пол
  const wood = toonT(PAL.woodDk,'wood',0.5,Math.max(1,h*0.3));
  const plank = toonT(PAL.plank,'plank',1.8,1.8);
  const R = MK_TOWER_R;
  const W = (lx,lz)=> PROP_wx(x,yaw,lx,lz), Z = (lx,lz)=> PROP_wz(z,yaw,lx,lz);
  // стойки тени не отбрасывают: четыре тонкие полосы на земле ничего не читают
  for(const ax of [-1,1]) for(const az of [-1,1])
    blk(W(ax*R,az*R), y0, Z(ax*R,az*R), 0.3, h, 0.3, wood, yaw, true, true);
  const yy = y0 + h*0.52;
  for(const az of [-1,1]) blk(W(0,az*R), yy, Z(0,az*R), R*2+0.3, 0.16, 0.16, wood, yaw, false, true);
  for(const ax of [-1,1]) blk(W(ax*R,0), yy, Z(ax*R,0), 0.16, 0.16, R*2+0.3, wood, yaw, false, true);
  blk(x, under, z, R*2+0.9, 0.28, R*2+0.9, plank, yaw);
  // бортик: борта по X глухие, по Z — с проёмами (лестница и стык мостика)
  const E = R+0.45, rail = toonT(team||PAL.rust,'plate',2,0.5);
  for(const ax of [-1,1]) blk(W(ax*E,0), deck, Z(ax*E,0), 0.14, 0.95, E*2, rail, yaw);
  // +Z — стык с мостиком: там бортик с проёмом; -Z полностью открыт под лестницу
  for(const s of [-1,1])
    blk(W(s*(E-0.62), E), deck, Z(s*(E-0.62), E), 1.24, 0.95, 0.14, rail, yaw);
  // навес ставим только именным вышкам; безымянные пилоны остаются
  // голым каркасом — так они не забивают силуэт центра и экономят меши
  if(team){
    for(const ax of [-1,1])
      blk(W(ax*(R+0.2),0), deck, Z(ax*(R+0.2),0), 0.18, 2.0, 0.18, wood, yaw, false, true);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(R*2.05, 1.3, 4), toonT(team,'roof',2,1));
    roof.position.set(x, deck+2.65, z); roof.rotation.y = yaw+Math.PI/4;
    roof.castShadow = true; roof.userData.shadowy = true; world.add(roof);
    mkBanner(W(R+0.6,-R-0.6), Z(R+0.6,-R-0.6), yaw+Math.PI*0.25, team, deck);
  }
  mkLadder(W(0,-MK_TOWER_LAD), Z(0,-MK_TOWER_LAD), y0, deck+0.25, yaw+Math.PI);
  return deck;
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

/* Рунный обелиск: ориентир в центре карты, резьба пульсирует. */
function mkObelisk(x,z,y){
  y = (y===undefined)?gh(x,z):y;
  const st = toonT(PAL.concDk,'stone',1,1.2);
  blk(x, y, z, 2.6, 0.55, 2.6, toonT(PAL.conc,'stone',1.4,0.4), 0);
  blk(x, y+0.55, z, 1.9, 0.4, 1.9, st, 0);
  const sh = new THREE.Mesh(new THREE.CylinderGeometry(0.52,0.88,6.4,4), st);
  sh.position.set(x, y+4.15, z); sh.rotation.y = Math.PI/4;
  sh.castShadow=true; sh.receiveShadow=true; sh.userData.shadowy=true; world.add(sh);
  BOXES.push(new Box(x, y+3.7, z, 1.5, 7.4, 1.5, Math.PI/4));
  // резьба: четыре светящиеся грани на общем материале — пульсируют вместе
  const rm = new THREE.MeshBasicMaterial({ map:TEX.get('rune',1,2), color:PAL.rune,
    transparent:true, opacity:0.75, blending:THREE.AdditiveBlending, depthWrite:false });
  for(let i=0;i<4;i++){
    const a = i*Math.PI/2 + Math.PI/4;
    const p = new THREE.Mesh(new THREE.PlaneGeometry(1.0,4.6), rm);
    p.position.set(x + Math.sin(a)*0.72, y+4.1, z + Math.cos(a)*0.72);
    p.rotation.y = a; world.add(p);
  }
  const cap = new THREE.Mesh(new THREE.OctahedronGeometry(0.62,0), PROP_glowMat(PAL.rune,0.85));
  cap.position.set(x, y+8.0, z); cap.scale.y=1.5; world.add(cap);
  const lh = LIGHTS.addStatic(V(x, y+7.4, z), PAL.rune, 1.7, 26);
  PROP_RUNES.push({ mat:rm, lh, ph:rnd(0,6.283), base:1.7, op:0.75, cap });
  return y+8.6;
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
    blk(px-0.4*scale, g0, pz-0.4*scale, 1.5*scale, 0.35*scale, 1.5*scale, sd, yaw, false, true);
  }
  // перемычка арки — только над целой колонной, вторая половина осыпалась
  const y0 = gh(x,z);
  const spanY = y0 + 4.4*scale;
  blk(PROP_wx(x,yaw,-R*0.45,0), spanY, PROP_wz(z,yaw,-R*0.45,0), R*1.5, 0.62*scale, 1.1*scale, sd, yaw);
  const frag = new THREE.Mesh(new THREE.IcosahedronGeometry(0.75*scale,0), st);
  frag.position.set(PROP_wx(x,yaw,R*0.6,0.5), spanY-0.3, PROP_wz(z,yaw,R*0.6,0.5));
  frag.rotation.set(0.6,0.9,0.4); frag.castShadow=true; frag.userData.shadowy=true; world.add(frag);
  // осыпь у подножия: заодно ступени под mantle
  for(let i=0;i<2;i++){
    const a = rnd(0,6.283), r = rnd(1.6,3.2)*scale;
    mkRock(x+Math.cos(a)*r, z+Math.sin(a)*r, rnd(0.6,1.1)*scale);
  }
  return spanY;
}

/* Снайперский редут базы: настил, бруствер, два пандуса, боковые лестницы
   и вынесенные крылья-мостки — чтобы с базы был не один выход, а четыре. */
function mkNest(sideZ, team, teamDk){
  const s = Math.sign(sideZ);
  const y0 = gh(0,sideZ);
  const deckY = y0 + 4.3;      // низ настила
  const top = deckY + 0.5;     // пол, по которому ходят
  const wood = toonT(PAL.woodDk,'wood',0.5,2.4);
  const plank = toonT(PAL.plank,'plank',6,3);
  const teamM = toonT(team,'plate',6,1.2), teamD = toonT(teamDk,'roof',6,2.4);
  for(let ix=-8;ix<=8;ix+=8) for(let iz=-3;iz<=3;iz+=3)
    blk(ix, y0, sideZ+iz, 0.55, 4.3, 0.55, wood, 0, true, true);
  blk(0, deckY, sideZ, 19, 0.5, 9.5, plank, 0);
  blk(0, top, sideZ + s*4.4, 19, 3.4, 0.6, teamM, 0);
  blk(0, top+3.4, sideZ + s*1.0, 19.6, 0.4, 7.4, teamD, 0);
  for(const ix of [-9,-3,3,9]) blk(ix, top, sideZ - s*2.2, 0.4, 3.4, 0.4, wood, 0);
  // бруствер с двумя амбразурами
  mkSandbags(-6.0, top, sideZ - s*4.3, 4.4, 2, 0);
  mkSandbags( 6.0, top, sideZ - s*4.3, 4.4, 2, 0);
  mkSandbags( 0,   top, sideZ - s*4.3, 2.2, 1, 0);
  // борта: сплошная стенка спереди, проём сзади — оттуда уходят мостки-крылья
  for(const sx of [-1,1]){
    blk(sx*9.4, top, sideZ - s*2.9, 0.4, 1.3, 3.7, wood, 0);
    blk(sx*9.4, top, sideZ + s*3.9, 0.4, 1.3, 1.7, wood, 0);
  }
  // два пандуса с тыла: нижняя ступень дальше от центра, верхняя — у настила
  const steps = 12, rise = (top-y0)/steps, run = 0.7;
  for(const sx of [-1,1]){
    for(let i=0;i<steps;i++){
      // низ ступени опущен на нахлёст, чтобы верх лёг ровно на y0+(i+1)*rise:
      // иначе первая ступень выходит выше CFG.step и на пандус не зайти
      const zz = sideZ + s*(4.9 + (steps-1-i)*run);
      blk(sx*7.6, y0 + i*rise - 0.14, zz, 3.0, rise+0.14, run+0.06, wood, 0, true, i%3!==0);
    }
  }
  // крылья: мостки уводят с настила на фланги, база перестаёт быть тупиком
  for(const sx of [-1,1]){
    mkCatwalk(sx*14.3, sideZ - s*0.5, 9.8, 0, top, true);
    mkLadder(sx*19.5, sideZ - s*0.5, gh(sx*19.5, sideZ-s*0.5), top+0.3, sx*Math.PI/2);
  }
  mkBarrel(-11.5, sideZ + s*3.4, teamDk); mkBarrel(11.5, sideZ + s*3.4, teamDk);
  mkCrate(-12.6, sideZ + s*6.0, 1.2); mkCrate(12.6, sideZ + s*6.0, 1.2);
  mkBrazier(0, sideZ - s*2.4, top);
  mkBanner(-9.9, sideZ + s*4.4, s>0?0:Math.PI, team, top);
  mkBanner( 9.9, sideZ + s*4.4, s>0?0:Math.PI, team, top);
  return top;
}

/* Центр карты: разрушенный форт-святилище на плато.
   Первый ярус — проходной зал с бойницами, второй — крыша с обелиском. */
function mkBunker(){
  const y = gh(0,0);
  const wall = toonT(PAL.conc,'stone',2.4,1.2), wallD = toonT(PAL.concDk,'stone',3,1);
  const W2=8.5, D2=6.0, HH=4.2;
  const slit = [{c:-3.0,w:2.6,b:1.2,t:2.3},{c:3.0,w:2.6,b:1.2,t:2.3}];
  mkSlitWall(0, y, -D2, W2*2, HH, 0.7, 0, slit, wall);
  mkSlitWall(0, y,  D2, W2*2, HH, 0.7, 0, slit, wall);
  // запад/восток: сквозные проходы — центр остаётся простреливаемым насквозь
  mkWall(-W2, y, 0, D2*2, HH, 0.7, Math.PI/2, 0, 2.6, 0, 2.6, wall);
  mkWall( W2, y, 0, D2*2, HH, 0.7, Math.PI/2, 0, 2.6, 0, 2.6, wall);
  const roof = y+HH+0.55;
  blk(0, y+HH, 0, W2*2+1.2, 0.55, D2*2+1.2, wallD, 0);
  // зубцы вместо мешков: дешевле по мешам и держит вайб разрушенной крепости —
  // между зубцами есть щели, значит с крыши можно стрелять, но и тебя видно
  for(let i=-3;i<=3;i++){
    if(i===0) continue;                       // центральный проём — вход с лестницы
    for(const sz of [-1,1]) blk(i*2.55, roof, sz*(D2+0.35), 1.7, 1.15, 0.55, wall, 0);
  }
  for(const sz of [-1,1]) blk(W2+0.55, roof, sz*3.0, 0.55, 1.15, 3.4, wall, 0);
  blk(-W2-0.55, roof, 3.0, 0.55, 1.15, 3.4, wall, 0);
  // подъёмы: каменная лестница с запада и лестница с востока — два разных темпа
  const st = 13, rise = (HH+0.55)/st;
  for(let i=0;i<st;i++) blk(-W2-1.7, y+i*rise-0.12, -3.4+i*0.8, 2.6, rise+0.12, 0.86, wallD, 0, true, i%3!==0);
  mkLadder(W2+1.05, -3.2, y, roof+0.3, Math.PI/2);   // восток — быстрый лаз
  mkLadder(-3.8, D2+1.05, y, roof+0.3, 0);           // север — лаз в щель между зубцами
  mkCrate(-4.5, 3.0, 1.1, y); mkCrate(4.5, -3.0, 1.1, y);
  return roof;
}
