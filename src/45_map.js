/* =========================== КОМПОНОВКА КАРТЫ ===========================
   Арена «Руины» в три яруса.

     ярус 0 — земля: плато с руинами, фланговые дворы, подходы к базам;
     ярус 1 — крыши: настилы редутов, крыша форта, ярусы лесов, контейнеры;
     ярус 2 — верх: пилоны, два навесных моста над центром, вышки флангов.

   Читаемость снайперской дуэли держится на трёх длинных линиях:
   ось BLU-RED через центр (z), две поперечные оси через фланговые дворы (x)
   и диагонали двор-база. Всё остальное — укрытия, между которыми есть смысл
   перебегать, и ярусы, ради которых стоит лезть наверх.
   ======================================================================= */

const BRIDGES = [];     // качающиеся мостики: {g, ph, amp, x, z}
let MAP_t = 0;          // своё время карты: динамика не зависит от состояния матча

/* Огневая точка для ИИ. sector считаем здесь, чтобы 70_ai.js не пересчитывал. */
function MAP_post(name, x, z, y, level, cover, via){
  POSTS.push({
    x:x, z:z, y:(y===undefined?gh(x,z):y),
    via: via||null, taken:null,
    level: level||0,
    cover: (cover===undefined?0.5:cover),
    sector: Math.floor(((Math.atan2(z,x)+Math.PI)/(Math.PI*2))*8)%8,
    name: name
  });
}
function MAP_pu(x,z,type,size,y){
  PICKUPS.push({ x:x, z:z, y:(y===undefined?gh(x,z):y), type:type, size:size,
    alive:true, t:0, mesh:null, cd:(type==='hp'? (size==='m'?22:13) : 18) });
}
/* Ящики-ступени: три коробки лесенкой — дешёвый подъём на контейнер/уступ. */
function MAP_crateSteps(x,z,yaw){
  const bx = PROP_wx(x,yaw,1.7,0), bz = PROP_wz(z,yaw,1.7,0);
  mkCrate(x, z, 1.3);
  mkCrate(bx, bz, 1.3);
  mkCrate(bx, bz, 1.15, gh(bx,bz)+1.3);
  return gh(bx,bz)+2.45;
}
/* Где стоит лестница у лесов (mkScaffold вешает её на грань ±X по локали). */
function MAP_scafLad(x,z,w,yaw,side){
  const o = side*(w/2+0.42);
  return { x:PROP_wx(x,yaw,o,0), z:PROP_wz(z,yaw,o,0), climb:true };
}
/* Лестница на бок контейнера: ящики-ступени проходит игрок, а боту нужна зона. */
function MAP_contLadder(cx,cz,cyaw,topY){
  const lx = cx + Math.sin(cyaw)*1.44, lz = cz + Math.cos(cyaw)*1.44;
  mkLadder(lx, lz, gh(lx,lz), topY+0.12, cyaw);
  return { x:lx, z:lz, climb:true };
}

function buildMap(){
  buildTerrain();
  buildSky();

  /* ======================= ЦЕНТР: РУИНЫ И МОСТЫ ======================= */
  const y0c   = gh(0,0);
  const roofY = mkBunker();          // крыша форта — ярус 1
  const BRG_Y = y0c + 8.6;           // настил мостов — ярус 2
  mkObelisk(0, 0, roofY);            // ориентир, виден с любой точки карты

  // пилоны мостов: проём бортика смотрит внутрь пролёта, лестница — наружу
  const PX = 16, PZ = 11.5;
  const pyl = [];
  for(const sz of [-1,1]) for(const sx of [-1,1]){
    const px = sx*PX, pz = sz*PZ;
    const yaw = sx<0 ? Math.PI/2 : -Math.PI/2;
    const d = mkTower(px, pz, BRG_Y - 0.28 - gh(px,pz), null, yaw);
    pyl.push({ x:px, z:pz, y:d, sx:sx, sz:sz,
               lx:PROP_wx(px,yaw,0,-MK_TOWER_LAD), lz:PROP_wz(pz,yaw,0,-MK_TOWER_LAD) });
  }
  const pylAt = (sx,sz)=> pyl.find(p=> p.sx===sx && p.sz===sz);

  // два моста поперёк главной оси: пробежка по ним быстрая, но тебя видно с обеих баз
  const brS = mkRopeBridge(-PX, -PZ, PX, -PZ, BRG_Y, 2.6);
  const brN = mkRopeBridge(-PX,  PZ, PX,  PZ, BRG_Y, 2.6);

  // каменные марши с крыши форта прямо на середину мостов: ярус 1 -> ярус 2
  for(const s of [-1,1]){
    const br = (s<0 ? brS : brN);
    const need = br.y - roofY;
    const n = Math.max(3, Math.ceil(need/0.42));
    mkStairs(0, s*6.3, s>0 ? -Math.PI/2 : Math.PI/2, n, need/n, 0.68, roofY);
  }

  // магия — только акцентами: обелиск, четыре кристалла, огни
  mkCrystal(-5.6, -4.4, roofY+3.9, 1.00, PAL.arcane);
  mkCrystal( 5.6,  4.4, roofY+4.5, 0.85, PAL.violet);
  mkCrystal(-8.4,  7.8, y0c+5.8,   0.70, PAL.wisp);
  mkCrystal( 8.4, -7.8, y0c+5.8,   0.70, PAL.wisp);
  mkBrazier(-7.4, -5.2, roofY); mkBrazier(7.4, 5.2, roofY);
  mkBrazier(-11.2, 1.8, y0c);

  // обломки арок — укрытие на плато и силуэт на фоне неба
  mkRuin(-13.2, -6.2, 1.15, 0.5);
  mkRuin( 13.2,  6.2, 1.15, -0.5);
  mkRuin( 12.4, -7.4, 0.95, 2.2);
  mkRuin(-12.4,  7.4, 0.95, -2.2);

  // подступы к плато: контейнеры в два этажа + два разных способа наверх
  mkContainer(0, -18.0, Math.PI/2, 0x6b6f74);
  mkContainer(0,  18.0, Math.PI/2, 0x6b6f74);
  const ctr = [];
  for(const s of [-1,1]){
    const cx = 19.5*s, cz = -3.5*s, cyaw = 0.12*s, cy = gh(cx,cz)+5.24;
    mkContainer(cx, cz, cyaw, s>0?PAL.rust:0x4f6b86);
    mkContainer(cx, cz, cyaw, 0x8a5c3a, gh(cx,cz)+2.62);
    const lad = MAP_contLadder(cx, cz, cyaw, cy);
    MAP_crateSteps(cx + 5.8*s, cz, s>0?Math.PI:0);
    ctr.push({ x:cx, z:cz, y:cy, lad:lad });
  }

  /* ==================== ФЛАНГОВЫЕ ДВОРЫ (x = ±50) ==================== */
  const flank = [];
  for(const sx of [-1,1]){
    const X = 50*sx, fy = gh(X,0);

    // сарай с лазом на крышу — низкий ярус 1 у самой земли
    const shackRoof = mkShack(X, -15*sx, 8, 6.5, 3.2, sx>0?0.3:-0.3, PAL.rust);
    // водонапорная башня: настил под ней — вторая площадка двора
    const wtX = X - 8*sx, wtZ = 17*sx;
    const wtDeck = mkWaterTower(wtX, wtZ);
    // леса: два яруса, лестницы чередуются по сторонам
    const scX = X + 6*sx, scZ = 6*sx;
    const scDeck = mkScaffold(scX, scZ, 6.6, 5.0, 2, 0);
    // мостки к центру + короткий навесной мостик через разрыв
    const cwX = X - 10*sx, cwZ = 6*sx, cwY = scDeck[1];
    mkCatwalk(cwX, cwZ, 9, 0, cwY, true);
    mkRopeBridge(X + 2.4*sx, cwZ, X - 5.6*sx, cwZ, cwY, 2.2);
    mkLadder(X - 14.9*sx, cwZ, gh(X-14.9*sx, cwZ), cwY+0.3, sx>0?-Math.PI/2:Math.PI/2);
    // доминанта двора: с её площадки трос уходит прямо на крышу форта —
    // самая быстрая ротация на карте и самый заметный маршрут
    const twX = X - 4*sx, twZ = -6*sx, twYaw = sx>0?Math.PI:0;
    const twDeck = mkTower(twX, twZ, 14.5, PAL.rust, twYaw);
    mkZipline(twX + 2.4*sx, twDeck + 0.95, twZ, 8.0*sx, roofY + 1.6, -3.0*sx);

    // обжитой двор
    const fcX = X - 3*sx, fcZ = -1, fcYaw = 0.15*sx, fcY = gh(fcX,fcZ)+5.24;
    mkContainer(fcX, fcZ, fcYaw, 0x4f6b86);
    mkContainer(fcX, fcZ, fcYaw, 0x6b6f74, gh(fcX,fcZ)+2.62);
    const fcLad = MAP_contLadder(fcX, fcZ, fcYaw, fcY);
    mkHay(X + 9*sx, 12*sx); mkHay(X + 9.9*sx, 13.6*sx);
    mkFence(X + 13*sx, gh(X+13*sx, -26*sx), -26*sx, 14, Math.PI/2);
    mkBarrel(X - 12.5*sx, -9*sx); mkBarrel(X - 13.4*sx, -9.7*sx);
    mkCrate(X + 11*sx, -3*sx, 1.5); mkCrate(X + 12.4*sx, -4.2*sx, 1.2);
    mkBrazier(X - 12*sx, 2.5*sx);
    mkBanner(X + 1*sx, 11*sx, sx>0?Math.PI*0.5:-Math.PI*0.5, PAL.gold);

    flank.push({ sx:sx, X:X, fy:fy,
                 shackRoof:shackRoof, shackX:X, shackZ:-15*sx,
                 shLx:PROP_wx(X, sx>0?0.3:-0.3, 0, -3.7),
                 shLz:PROP_wz(-15*sx, sx>0?0.3:-0.3, 0, -3.7),
                 wtX:wtX, wtZ:wtZ, wtDeck:wtDeck,
                 scX:scX, scZ:scZ, scDeck:scDeck,
                 cwX:cwX, cwZ:cwZ, cwY:cwY,
                 fcX:fcX, fcZ:fcZ, fcY:fcY, fcLad:fcLad,
                 twX:twX, twZ:twZ, twDeck:twDeck,
                 twLx:PROP_wx(twX, twYaw, 0, -MK_TOWER_LAD),
                 twLz:PROP_wz(twZ, twYaw, 0, -MK_TOWER_LAD) });
  }

  /* ========================== БАЗЫ (z = ±64) ========================== */
  const deckBlu = mkNest(-64, PAL.blu, PAL.bluDk);
  const deckRed = mkNest( 64, PAL.red, PAL.redDk);
  const base = [];
  for(const s of [-1,1]){
    const Z = 64*s, team = s>0?PAL.red:PAL.blu, teamDk = s>0?PAL.redDk:PAL.bluDk;
    const deck = s>0?deckRed:deckBlu;
    // боковая вышка базы: перекрывает подход по своему флангу
    const btX = -26*s, btZ = Z - s*7;
    const btYaw = s>0?Math.PI:0;
    const btDeck = mkTower(btX, btZ, 7.6, team, btYaw);
    // площадка приземления троса с центрального моста
    const lx = 26*s, lz = 42*s;
    const lgy = gh(lx,lz);
    const ly = Math.min(BRG_Y - 3.4, lgy + 4.2);
    mkCatwalk(lx, lz, 8, 0, ly, true);
    mkLadder(lx + 4.3*s, lz, gh(lx+4.3*s, lz), ly + 0.3, s>0?Math.PI/2:-Math.PI/2);
    const py = pylAt(s, s);            // пилон того же квадранта
    // старт троса выносим за бортик пилона, иначе кабель проходит сквозь перила
    mkZipline(py.x + 1.6*s, BRG_Y + 0.95, py.z + 2.7*s, lx, ly + 0.95, lz);

    // предполье базы
    mkSandbags(-13*s, gh(-13*s, Z - s*15), Z - s*15, 5.2, 2, 0.25);
    const bcX = 21*s, bcZ = Z - s*5, bcYaw = 0.2*s;
    mkContainer(bcX, bcZ, bcYaw, teamDk);
    const bcLad = MAP_contLadder(bcX, bcZ, bcYaw, gh(bcX,bcZ)+2.62);
    MAP_crateSteps(26.6*s, bcZ, s>0?Math.PI:0);
    mkBrazier(-6*s, Z - s*13.5);
    base.push({ s:s, Z:Z, deck:deck, btX:btX, btZ:btZ, btDeck:btDeck,
                btLx:PROP_wx(btX,btYaw,0,-MK_TOWER_LAD), btLz:PROP_wz(btZ,btYaw,0,-MK_TOWER_LAD),
                bcX:bcX, bcZ:bcZ, bcY:gh(bcX,bcZ)+2.62, bcLad:bcLad,
                lx:lx, lz:lz, ly:ly });
  }

  /* ====================== СРЕДНЕЕ ПОЛЕ: ПЕРЕБЕЖКИ ====================== */
  // редкие укрытия: линии остаются простреливаемыми, но есть куда нырнуть
  const midCover = [
    [-32,-32,1.7],[32,32,1.7],[-32,32,1.5],[32,-32,1.5],
    [-27,-47,1.4],[27,47,1.4],[27,-47,1.6],[-27,47,1.6],
    [-41,-17,1.8],[41,17,1.8],
    [-10,-37,1.5],[10,37,1.5],[12,-33,1.3],[-12,33,1.3]
  ];
  for(const c of midCover) mkCrate(c[0],c[1],c[2]);
  // передовые посты в чистом поле: одноярусные леса дают высоту там, где её нет
  const mid = [];
  for(const s of [-1,1]){
    const mx = -35*s, mz = 30*s, myaw = 0.4*s;
    const d = mkScaffold(mx, mz, 6.0, 4.6, 1, myaw)[0];
    mid.push({ x:mx, z:mz, y:d, lad:MAP_scafLad(mx, mz, 6.0, myaw, -1) });
  }
  mkRuin(-23,-53,1.0); mkRuin(23,53,1.0);

  /* ============================ ОКРУЖЕНИЕ ============================ */
  for(let i=0;i<16;i++){
    const a=rnd(0,Math.PI*2), r=rnd(22,80);
    const x=Math.cos(a)*r, z=Math.sin(a)*r;
    if(Math.abs(x)<20 && Math.abs(z)<20) continue;
    mkRock(x,z,rnd(0.6,2.4));
  }
  for(let i=0;i<6;i++){
    const a=rnd(0,Math.PI*2), r=rnd(30,80);
    mkTree(Math.cos(a)*r, Math.sin(a)*r, Math.random()<0.55);
  }
  // скалы по периметру: крупные и редкие — граница читается, а мешей мало
  for(let i=0;i<28;i++){
    const a=(i/28)*Math.PI*2;
    const r = CFG.half+rnd(1,8);
    mkRock(Math.cos(a)*r, Math.sin(a)*r, rnd(3.4,5.6));
  }

  mkSign(-7, -54, 0, 'BLU · ЮГ', PAL.blu);
  mkSign( 7,  54, Math.PI, 'RED · СЕВЕР', PAL.red);
  mkSign(-38, 0, -Math.PI/2, 'ЗАПАДНЫЙ ДВОР', PAL.rust);
  mkSign( 38, 0,  Math.PI/2, 'ВОСТОЧНЫЙ ДВОР', PAL.rust);

  /* ========================== ТОЧКИ РЕСПАВНА ========================== */
  SPAWNS_BLU.push({x:-5,y:deckBlu+0.1,z:-64},{x:5,y:deckBlu+0.1,z:-64},{x:0,y:deckBlu+0.1,z:-66});
  SPAWNS_RED.push({x:-5,y:deckRed+0.1,z:64},{x:5,y:deckRed+0.1,z:64},
                  {x:-15,y:gh(-15,58),z:58},{x:15,y:gh(15,58),z:58},{x:0,y:gh(0,74),z:74});

  /* ======================= ОГНЕВЫЕ ПОЗИЦИИ ИИ =======================
     via — маршрут: бот идёт по точкам, climb:true помечает подъём
     (лестница/леса), чтобы 70_ai.js звал climbStep вместо тарана стены. */

  // --- ярус 2: мосты и пилоны ---
  for(const p of pyl){
    const via = [{x:p.lx, z:p.lz, climb:true}];
    MAP_post('ПИЛОН', p.x, p.z, p.y, 2, 0.25, via);
  }
  for(const s of [-1,1]){
    const br = (s<0 ? brS : brN);
    const p = pylAt(-1, s);
    MAP_post('МОСТ', br.x + s*3.5, br.z, br.y, 2, 0.1,
      [{x:p.lx, z:p.lz, climb:true},{x:p.x, z:p.z}]);
  }
  for(const f of flank){
    MAP_post('ВЫШКА ДВОРА', f.twX, f.twZ, f.twDeck, 2, 0.35,
      [{x:f.twLx, z:f.twLz, climb:true}]);
  }
  for(const b of base){
    MAP_post('ВЫШКА БАЗЫ', b.btX, b.btZ, b.btDeck, 2, 0.4,
      [{x:b.btLx, z:b.btLz, climb:true}]);
  }

  // --- ярус 1: крыши, настилы, леса ---
  MAP_post('КРЫША ФОРТА', -4.6,  4.6, roofY, 1, 0.55, [{x:-3.8, z:8.0, climb:true}]);
  MAP_post('КРЫША ФОРТА',  4.6, -4.6, roofY, 1, 0.55, [{x:10.4, z:-3.2, climb:true}]);
  MAP_post('ЗУБЦЫ',        0.0, -5.4, roofY, 1, 0.65, [{x:10.4, z:-3.2, climb:true}]);
  for(const c of ctr) MAP_post('КОНТЕЙНЕРЫ', c.x, c.z, c.y, 1, 0.35, [c.lad]);
  for(const f of flank){
    MAP_post('ЛЕСА', f.scX, f.scZ, f.scDeck[1], 1, 0.4,
      [MAP_scafLad(f.scX, f.scZ, 6.6, 0, -1), MAP_scafLad(f.scX, f.scZ, 6.6, 0, 1)]);
    MAP_post('МОСТКИ', f.cwX, f.cwZ, f.cwY, 1, 0.2,
      [{x:f.X - 15.4*f.sx, z:f.cwZ, climb:true}]);
    MAP_post('ВОДОНАПОРКА', f.wtX, f.wtZ + 2.6, f.wtDeck, 1, 0.3,
      [{x:f.wtX, z:f.wtZ + 4.0, climb:true}]);
    MAP_post('КРЫША САРАЯ', f.shackX, f.shackZ, f.shackRoof, 1, 0.25,
      [{x:f.shLx, z:f.shLz, climb:true}]);
    MAP_post('КОНТЕЙНЕРЫ ДВОРА', f.fcX, f.fcZ, f.fcY, 1, 0.35, [f.fcLad]);
  }
  for(const b of base){
    MAP_post('РЕДУТ', -6*b.s, b.Z - b.s*2.5, b.deck, 1, 0.75, [{x:-7.6*b.s, z:b.Z + b.s*11}]);
    MAP_post('РЕДУТ',  6*b.s, b.Z - b.s*2.5, b.deck, 1, 0.75, [{x: 7.6*b.s, z:b.Z + b.s*11}]);
    MAP_post('КРЫЛО', -15*b.s, b.Z - b.s*0.5, b.deck, 1, 0.45, [{x:-19.9*b.s, z:b.Z - b.s*0.5, climb:true}]);
    MAP_post('КРЫЛО',  15*b.s, b.Z - b.s*0.5, b.deck, 1, 0.45, [{x: 19.9*b.s, z:b.Z - b.s*0.5, climb:true}]);
    MAP_post('ПЛОЩАДКА', b.lx, b.lz, b.ly, 1, 0.3, [{x:b.lx + 4.3*b.s, z:b.lz, climb:true}]);
    MAP_post('КОНТЕЙНЕР БАЗЫ', b.bcX, b.bcZ, b.bcY, 1, 0.3, [b.bcLad]);
  }
  for(const m of mid) MAP_post('ВЫНОС', m.x, m.z, m.y, 1, 0.3, [m.lad]);

  // --- ярус 0: земля ---
  MAP_post('ПЛАТО ЗАПАД', -12.4,  7.4);
  MAP_post('ПЛАТО ВОСТОК', 12.4, -7.4);
  MAP_post('АРКА', -13.2, -6.2, undefined, 0, 0.6);
  MAP_post('АРКА',  13.2,  6.2, undefined, 0, 0.6);
  MAP_post('ПОДСТУП', -21,  10); MAP_post('ПОДСТУП', 21, -10);
  MAP_post('ПОДСТУП', -21, -14); MAP_post('ПОДСТУП', 21,  14);
  MAP_post('ДВОР ЗАПАД', -42, -11, undefined, 0, 0.6);
  MAP_post('ДВОР ВОСТОК', 42,  11, undefined, 0, 0.6);
  MAP_post('ДВОР ЗАПАД', -56,  13, undefined, 0, 0.55);
  MAP_post('ДВОР ВОСТОК', 56, -13, undefined, 0, 0.55);
  MAP_post('ЗАБОР', -60, -22, undefined, 0, 0.5);
  MAP_post('ЗАБОР',  60,  22, undefined, 0, 0.5);
  MAP_post('ПОЛЕ', -32, -32, undefined, 0, 0.65);
  MAP_post('ПОЛЕ',  32,  32, undefined, 0, 0.65);
  MAP_post('ПОЛЕ', -32,  32, undefined, 0, 0.65);
  MAP_post('ПОЛЕ',  32, -32, undefined, 0, 0.65);
  MAP_post('ПОЛЕ', -41, -17, undefined, 0, 0.6);
  MAP_post('ПОЛЕ',  41,  17, undefined, 0, 0.6);
  MAP_post('ПОДХОД', -10, -37, undefined, 0, 0.6);
  MAP_post('ПОДХОД',  10,  37, undefined, 0, 0.6);
  MAP_post('ПОДХОД', -27, -47, undefined, 0, 0.6);
  MAP_post('ПОДХОД',  27,  47, undefined, 0, 0.6);
  MAP_post('ПРЕДПОЛЬЕ', -13, -49, undefined, 0, 0.7);
  MAP_post('ПРЕДПОЛЬЕ',  13,  49, undefined, 0, 0.7);
  MAP_post('ПРЕДПОЛЬЕ',  13, -49, undefined, 0, 0.55);
  MAP_post('ПРЕДПОЛЬЕ', -13,  49, undefined, 0, 0.55);
  MAP_post('ТЫЛ', -33, 44, undefined, 0, 0.5);
  MAP_post('ТЫЛ',  33,-44, undefined, 0, 0.5);

  /* ====================== АПТЕЧКИ И БОЕПРИПАСЫ ====================== */
  MAP_pu(-4.8, 2.2, 'hp', 'm', roofY);          // жирная аптечка на крыше форта
  MAP_pu(0, -PZ, 'ammo', undefined, brS.y);     // патроны прямо на мостах
  MAP_pu(0,  PZ, 'ammo', undefined, brN.y);
  for(const f of flank){
    MAP_pu(f.twX, f.twZ, 'ammo', undefined, f.twDeck);
    MAP_pu(f.X - 12*f.sx, 4*f.sx, 'hp', 'm');
  }
  for(const b of base){
    MAP_pu(-9*b.s, b.Z - b.s*8, 'hp', 's');
    MAP_pu( 9*b.s, b.Z - b.s*8, 'ammo');
    MAP_pu(b.lx, b.lz, 'hp', 's', b.ly);
  }
  MAP_pu(-20, -41, 'hp', 's'); MAP_pu(20, 41, 'hp', 's');
  MAP_pu(-21, 12, 'ammo'); MAP_pu(21, -12, 'ammo');

  buildPickupMeshes();
}

/* ---------------------- ДИНАМИКА КАРТЫ (каждый кадр) ---------------------- */
function updateMapDynamics(dt){
  MAP_t += dt;
  const t = MAP_t;

  // мостики качает только визуально: коллизия остаётся ровной, иначе
  // на середине пролёта игрок ловил бы фантомные ступеньки
  for(let i=0;i<BRIDGES.length;i++){
    const b = BRIDGES[i];
    b.g.rotation.x = Math.sin(t*1.15 + b.ph) * b.amp;
    b.g.position.y = Math.sin(t*0.86 + b.ph*1.7) * b.amp * 0.55;
  }
  for(let i=0;i<PROP_CRYSTALS.length;i++){
    const c = PROP_CRYSTALS[i];
    c.g.rotation.y += dt*c.spin;
    c.g.position.y = c.y0 + Math.sin(t*0.8 + c.ph)*c.amp;
    const k = 0.72 + 0.28*Math.sin(t*1.9 + c.ph);
    c.glow.material.opacity = 0.34 + 0.24*k;
    LIGHTS.setStatic(c.lh, c.base*k);
  }
  for(let i=0;i<PROP_RUNES.length;i++){
    const r = PROP_RUNES[i];
    const k = 0.62 + 0.38*Math.sin(t*1.3 + r.ph);
    r.mat.opacity = clamp(r.op*(0.45 + 0.75*k), 0, 1);
    r.cap.rotation.y += dt*0.42;
    LIGHTS.setStatic(r.lh, r.base*(0.7 + 0.45*k));
  }
  for(let i=0;i<PROP_FIRES.length;i++){
    const f = PROP_FIRES[i];
    // две частоты: медленное дыхание пламени плюс быстрый треск
    const k = 0.80 + 0.20*Math.sin(t*10.5 + f.ph) + 0.10*Math.sin(t*23.7 + f.ph*3);
    for(let j=0;j<f.fl.length;j++){
      const s = f.fl[j];
      s.scale.setScalar(s.userData.bs * k);
      s.position.y = s.userData.by + 0.06*Math.sin(t*7 + f.ph + j);
    }
    LIGHTS.setStatic(f.lh, f.base*k);
  }
  for(let i=0;i<PROP_BANNERS.length;i++){
    const b = PROP_BANNERS[i];
    b.m.rotation.y = b.yaw + Math.sin(t*0.9 + b.ph)*0.10;
    b.m.rotation.z = Math.sin(t*1.4 + b.ph)*0.045;
  }
}

function buildPickupMeshes(){
  for(const p of PICKUPS){
    const g = new THREE.Group();
    if(p.type==='hp'){
      const s = p.size==='m'?0.62:0.42;
      const b = new THREE.Mesh(new THREE.BoxGeometry(s*1.5,s,s), toonT(0xf2ece0,'plate',1,1));
      b.castShadow=true; b.userData.shadowy=true; g.add(b);
      const cm = toon(0x3f9d4a);
      const a = new THREE.Mesh(new THREE.BoxGeometry(s*0.75,s*0.24,s*1.03), cm); g.add(a);
      const c2 = new THREE.Mesh(new THREE.BoxGeometry(s*0.24,s*0.75,s*1.03), cm); g.add(c2);
      const st = new THREE.Mesh(new THREE.BoxGeometry(s*1.53,s*0.16,s*1.02), toon(0xb8383b));
      st.position.y = -s*0.3; g.add(st);
    } else {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.75,0.45,0.55), toonT(PAL.wood,'crate',1,1));
      b.castShadow=true; b.userData.shadowy=true; g.add(b);
      const lid = new THREE.Mesh(new THREE.BoxGeometry(0.79,0.09,0.59), toon(PAL.woodDk));
      lid.position.y=0.25; g.add(lid);
      for(let i=-1;i<=1;i+=2){
        const bl = new THREE.Mesh(new THREE.CylinderGeometry(0.055,0.055,0.3,6), toon(0xd9b24a));
        bl.position.set(i*0.15,0.42,0); g.add(bl);
      }
    }
    g.position.set(p.x, p.y+0.55, p.z);
    world.add(g); p.mesh = g;
  }
}
