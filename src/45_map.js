/* =========================== КОМПОНОВКА КАРТЫ ===========================
   «ОСАДА» — карта по MAPDESIGN.md. Замок RED на севере, осадный лагерь BLU
   на юге, спорный посад в центре, фланговые дворы при x = ±52.

   Главное правило (§1): пол любой площадки лежит на канонической высоте.
     этаж 0 — рельеф (1.4…5.4 м в игровой зоне);
     этаж 1 — CFG.floor1 = 7.5 (в посаде 8.2: плато центра выше на 3.2 м,
              и на 7.5 под перекрытием не осталось бы роста — допуск ±1.0);
     этаж 2 — CFG.floor2 = 15.0.
   Разнобой высот — единственное, что делало прошлую карту нечитаемой,
   поэтому все настилы здесь берут высоту из констант, а не «по месту».

   Связность (§4): 8 маршей 0↔1, 5 винтовых 1↔2, 4 троса 2→0. Все марши —
   через mkMarch, то есть через addRamp: ступени видимые, но несплошные.
   ======================================================================= */

const BRIDGES = [];     // качающиеся мостики: {g, ph, amp, x, z}
let MAP_t = 0;          // своё время карты: динамика не зависит от состояния матча

/* --------------------------- ОПОРНЫЕ ЧИСЛА --------------------------- */
const MAP_F1 = CFG.floor1;          // 7.5  — боевой ход, помосты, перекрытия
const MAP_F2 = CFG.floor2;          // 15.0 — верхний ярус
const MAP_FP = CFG.floor1 + 0.7;    // 8.2  — перекрытия посада (плато 5.4)

/* Замок: осевые линии стен. Двор внутри — 32×26 м. */
const CAS_S = 50.5, CAS_N = 79.5, CAS_W = -17.5, CAS_E = 17.5, CAS_TH = 3.0;
/* Лагерь: центр осадной башни и уровень помостов. */
const CMP_Z = -53;
/* Посад: половина площадки моста и вынос опор. */
const PSD_P = 7.0, PSD_T = 16;

/* Реестры переходов — только для отладки и для замеров §7.3.
   Хранить их дёшево, а без них «связность» превращается в обещание. */
const MAP_LINKS = [];   // {a:0|1|2, b:1|2, x, z, kind:'march'|'spiral'|'zip'|'ladder'}
function MAP_link(a,b,x,z,kind){ MAP_LINKS.push({a:a,b:b,x:x,z:z,kind:kind}); }

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

/* ============================== ЗАМОК RED ==============================
   Кольцо боевого хода — ключевая деталь: верх стены и есть пол этажа 1,
   поэтому защитник обходит весь замок, ни разу не спускаясь. */
function MAP_buildCastle(){
  const sand = PROP_mt('sand1'), sandL = PROP_mt('sand2');
  const TW = 9.6, TWH = TW/2;                   // угловые башни

  // --- стены. Обход против часовой стрелки: при side:-1 зубцы всегда снаружи
  // южная стена идёт от башни до башни, в середине — ворота
  mkRampart(CAS_W+TWH-0.6, CAS_S, CAS_E-TWH+0.6, CAS_S, MAP_F1, CAS_TH, {
    gaps:[{c:0, w:4.4, b:0, t:6.8}], side:-1 });
  mkRampart(CAS_E, CAS_S+TWH-0.6, CAS_E, CAS_N, MAP_F1, CAS_TH, {
    gaps:[{c:59-(CAS_S+TWH-0.6+CAS_N)/2, w:2.0, b:0, t:5.2}], side:-1 });
  mkRampart(CAS_E, CAS_N, CAS_W, CAS_N, MAP_F1, CAS_TH, { side:-1 });
  mkRampart(CAS_W, CAS_N, CAS_W, CAS_S+TWH-0.6, MAP_F1, CAS_TH, {
    gaps:[{c:(CAS_S+TWH-0.6+CAS_N)/2-59, w:2.0, b:0, t:5.2}], side:-1 });

  // --- воротная башня: проезд простреливается, но это главный вход
  mkGatehouse(0, CAS_S, 0, MAP_F1, 4.4, CAS_TH, -1);

  // --- угловые башни на южных углах: смотрят на подступ
  mkCornerTower(CAS_W, CAS_S, MAP_F1, MAP_F2, TW, 2, +1, +1);
  mkCornerTower(CAS_E, CAS_S, MAP_F1, MAP_F2, TW, 3, -1, +1);
  MAP_link(1,2, CAS_W-1.7, CAS_S-1.7, 'spiral');
  MAP_link(1,2, CAS_E+1.7, CAS_S-1.7, 'spiral');

  /* Донжон. Пятый переход 1↔2 идёт через лестничную башенку у западной грани,
     поэтому в зубцах кровли по этой грани оставлен дверной проём: без него
     мерлон вставал ровно в створе двери и кровля была отрезана от лестницы. */
  mkKeep(-8, 63, 8, 74, MAP_F2, { gapW:{ c:69.3, w:2.9 } });

  // --- лестничная башенка донжона: с боевого хода западной стены на кровлю
  // 5 маршей -> винтовая кончается в юго-восточном углу колодца, туда же
  // mkStairTurret прижимает верхнюю дверь (створ z 68.25…70.3)
  mkStairTurret(-11.0, 71, MAP_F1, MAP_F2, 2.35, 0, [-1,0], [1,0], sand, 5);
  MAP_link(1,2, -11.0, 71, 'spiral');
  PROP_slab(-16.2, 69.6, -14.1, 72.4, MAP_F1, 0.5, sand, true);      // мостик со стены
  blk(-15.2, gh(-15.2,71)-0.4, 71, 1.1, MAP_F1-0.5-gh(-15.2,71)+0.4, 1.1, PROP_mt('sand0'), 0, true, true);
  // порог от винтовой на кровлю: лежит ровно под дверным створом и сшивает
  // площадку винтовой с кровлей донжона без единой ступеньки
  PROP_slab(-9.35, 67.8, -7.4, 70.6, MAP_F2, 0.45, sandL, true);     // выход на кровлю

  // --- две каменные рампы двор→стена (юго-запад и юго-восток)
  for(const s of [-1,1]){
    // рампа идёт по внутренней грани угловой башни: заедь она хоть на метр
    // в её цоколь — и на марш стало бы не зайти снизу
    mkMarch(s*11.0, 53.5, s*11.0, 64.5, 3.4, gh(s*11.0,53.5), MAP_F1,
            { mat:sand, rail:true, railMat:sandL });
    /* Площадка начинается ТАМ, где марш уже вышел на 7.5 (z = 64.5), а не на
       два метра южнее: её южный торец заезжал в створ марша и вставал поперёк
       него ступенькой в метр — по западной полосе на стену было не подняться. */
    PROP_slab(s>0?12.4:-16.3, 64.2, s>0?16.3:-12.4, 66.4, MAP_F1, 0.5, sand, true);
    for(const q of [-1,1])
      blk(s*14.4, gh(s*14.4,65.3+q*1.0)-0.4, 65.3+q*1.0, 1.1, MAP_F1-0.5-gh(s*14.4,65.3+q*1.0)+0.4,
          1.1, PROP_mt('sand0'), 0, true, true);
    MAP_link(0,1, s*11.0, 64.5, 'march');
  }
  // лаз у западной рампы: дублирующий подъём для ботов и для паники
  mkLadder(-15.6, 57.5, gh(-15.6,57.5), MAP_F1+0.3, Math.PI/2);
  MAP_link(0,1, -15.6, 57.5, 'ladder');

  // --- обжитой двор: колодец, поленница, конюшня, костры
  mkWell(-6.5, 57);
  mkCrate(6.0, 56.4, 1.5); mkCrate(7.6, 57.6, 1.2); mkCrate(6.6, 58.8, 1.3);
  mkHay(-3.6, 58.6); mkHay(-2.4, 59.6);
  mkBarrel(10.5, 60.5, PAL.redDk); mkBarrel(11.4, 61.4, PAL.redDk);
  // конюшня у восточной стены; западную сторону двора занимает башенка донжона
  mkRuinHouse(9.8, 66.5, 15.0, 72.5, { mat:PROP_mt('wood0'), matL:PROP_mt('tile'), open:'w' });
  mkCrate(-13.8, 57.5, 1.5); mkCrate(-14.9, 58.6, 1.2); mkCrate(-14.2, 59.9, 1.3);
  mkBrazier(-4.5, 54.5); mkBrazier(4.5, 54.5);
  mkBanner(-9.9, 52.6, 0, PAL.red, MAP_F1);
  mkBanner( 9.9, 52.6, 0, PAL.red, MAP_F1);
  mkBanner(-11.5, 76.0, Math.PI, PAL.red);
  mkBanner( 11.5, 76.0, Math.PI, PAL.red);

  // --- тросы с угловых башен вниз, на северный подступ
  for(const s of [-1,1]){
    const lx = s*30, lz = 33;
    mkZipline(s*17.5, MAP_F2+0.95, CAS_S-4.0, lx, gh(lx,lz)+1.4, lz);
    MAP_link(2,0, s*17.5, CAS_S-4.0, 'zip');
  }
}

/* ============================== ЛАГЕРЬ BLU ==============================
   Компенсация за отсутствие стены: помосты идут двумя ветками и кольца не
   образуют, зато осадная башня выше зубцов замка. */
function MAP_buildCamp(){
  const w1 = PROP_mt('wood1'), w0 = PROP_mt('wood0'), w2 = PROP_mt('wood2');

  // --- осадная башня по центру лагеря
  mkSiegeTower(0, CMP_Z, MAP_F1, MAP_F2, 10, 2, 'w');
  MAP_link(1,2, -1.7, CMP_Z-1.7, 'spiral');

  // --- две ветки помостов: восток и запад, через башню, но без кольца
  for(const s of [-1,1]){
    // перил у ветки нет: с юга на неё въезжает марш, с севера — уходит
    // отвод, и любой сплошной борт запирал бы один из двух стыков
    mkDeck(s<0?-24:4.5, CMP_Z-1.9, s<0?-4.5:24, CMP_Z+1.9, MAP_F1,
           { mat:w1, postStep:6.0 });
    blk(s*14.5, MAP_F1, CMP_Z+1.78, 15, 1.0, 0.16, w0, 0, true, true);   // борт с севера
    mkDeck(Math.min(s*25.9, s*22.1), CMP_Z+1.9, Math.max(s*25.9, s*22.1), CMP_Z+10, MAP_F1,
           { mat:w1, rail:s<0?'w':'e', postStep:5.0 });
    // въезд с земли на помост
    mkMarch(s*13, CMP_Z-12.5, s*13, CMP_Z-1.4, 3.6, gh(s*13, CMP_Z-12.5), MAP_F1,
            { mat:w1, rail:true, railMat:w0, body:false });
    MAP_link(0,1, s*13, CMP_Z-1.9, 'march');
    // лаз стоит ПОД кромкой помоста (его юг — CMP_Z-1.9), а не южнее её:
    // иначе сверху с него сходят не на настил, а на марш на полметра ниже
    mkLadder(s*10.4, CMP_Z-1.6, gh(s*10.4,CMP_Z-1.6), MAP_F1+0.3, s>0?-Math.PI/2:Math.PI/2);
    MAP_link(0,1, s*10.4, CMP_Z-1.6, 'ladder');
    mkBanner(s*22, CMP_Z-1.4, s>0?Math.PI*0.5:-Math.PI*0.5, PAL.blu, MAP_F1);
  }

  /* Вышка корректировщика на западном помосте, связана с башней по верху.
     Стойки разнесены по X шире настила и сдвинуты за створ западного марша
     (x −14.8…−11.2): прежняя западная пара стояла ровно в нём, и въезд на
     помост с запада был перекрыт стойкой от земли до 15 м. */
  const spX = -12.4;
  for(const ax of [-1,1]) for(const az of [-1,1])
    blk(spX+ax*3.5, gh(spX,CMP_Z), CMP_Z+az*2.6, 0.6, MAP_F2-gh(spX,CMP_Z), 0.6, w0, 0, true);
  mkDeck(-16.4, CMP_Z-3, -8.5, CMP_Z+3, MAP_F2, { mat:w2, rail:'nsw', posts:false });
  mkDeck(-8.5, CMP_Z-1.4, -4.6, CMP_Z+1.4, MAP_F2, { mat:w2, rail:'ns', posts:false });
  {
    const r = new THREE.Mesh(new THREE.ConeGeometry(4.6, 1.8, 4), PROP_mt('cloth'));
    r.position.set(spX, MAP_F2+2.6, CMP_Z); r.rotation.y = Math.PI/4;
    r.castShadow = true; r.userData.shadowy = true; world.add(r);
  }

  // --- трос с осадной башни на южный подступ
  mkZipline(0, MAP_F2+0.95, CMP_Z+5.6, -19, gh(-19,-31)+1.4, -31);
  MAP_link(2,0, 0, CMP_Z+5.6, 'zip');

  // --- обозный двор: два ряда складов прикрывают точки появления с севера,
  //     створ въездов на помост (x = ±13) при этом оставлен свободным
  mkPalisade(-6.8, -64.5, 7.6, 0, 4.2, w0);
  mkPalisade( 6.8, -64.5, 7.6, 0, 4.2, w0);
  mkPalisade(-19.5, -64.5, 8.0, 0, 4.2, w0);
  mkPalisade( 19.5, -64.5, 8.0, 0, 4.2, w0);
  // передовые туры на подступе — укрытие для тех, кто пошёл в атаку
  mkPalisade(-20, -45, 16, 0, 3.2, w0);
  mkPalisade( 20, -45, 16, 0, 3.2, w0);

  mkTent(-12.5,-70, 0.30, 0x53708c); mkTent(12.5,-70, -0.30, 0x53708c);
  mkTent(-19,-61.5, 0.50, 0xbfb193); mkTent(19,-61.5, -0.50, 0xbfb193);
  mkTent(-6.5,-77, 0.20, 0x53708c);  mkTent(6.5,-77, -0.20, 0x53708c);
  mkWagon(-20,-69, 0.25); mkWagon(20,-69,-0.25); mkWagon(0,-80.5, 0);
  mkBrazier(-6.5,-67.5); mkBrazier(6.5,-67.5);
  mkBarrel(-14,-73, PAL.bluDk); mkBarrel(-14.75,-73.6, PAL.bluDk);
  mkBarrel( 14,-73, PAL.bluDk); mkBarrel( 14.75,-73.6, PAL.bluDk);
  mkCrate(-17,-76, 1.4); mkCrate(-18.5,-77.1, 1.2); mkCrate(17,-76, 1.4);
  mkHay(-30,-70); mkHay(-31.05,-70.9); mkHay(26,-70); mkHay(27.05,-70.9);
  mkBanner(-4.6, -60.5, 0, PAL.blu); mkBanner(4.6, -60.5, 0, PAL.blu);
}

/* =============================== ПОСАД ===============================
   Сердце карты: улочки внизу, перекрытия на 8.2, крест навесных мостов
   на 15.0 и обелиск, который прошивает всё это насквозь. */
function MAP_buildPosad(){
  const g1 = PROP_mt('gray1'), g2 = PROP_mt('gray2'), gl = PROP_mt('grayL');
  const y0 = gh(0,0);

  // --- обелиск: единственный вертикальный ориентир, виден отовсюду
  mkObelisk(0, 0, y0, 14.0);

  // --- терраса вокруг обелиска: этаж 1 на колоннах, низ проходной насквозь
  // проём в террасе — впритык к обелиску: шире и в его углы проваливаешься
  mkDeckHole(-5.5,-5.5, 5.5,5.5, -1.05,-1.05, 1.05,1.05, MAP_FP, 0.42, g2);
  for(const ax of [-1,0,1]) for(const az of [-1,0,1]){
    if(!ax && !az) continue;
    const px = ax*4.7, pz = az*4.7;
    blk(px, gh(px,pz), pz, 0.8, MAP_FP-0.42-gh(px,pz), 0.8, g1, 0, true, true);
  }
  // два марша с улицы на террасу — оба перехода 0↔1 посада
  for(const s of [-1,1]){
    mkMarch(s*11.5, 0, s*5.7, 0, 3.4, gh(s*11.5,0), MAP_FP, { mat:g2, rail:true, railMat:gl });
    MAP_link(0,1, s*5.7, 0, 'march');
  }
  mkLadder(-4.2, 6.0, gh(-4.2,6.0), MAP_FP+0.3, 0);
  MAP_link(0,1, -4.2, 6.0, 'ladder');

  // --- винтовая вокруг обелиска: единственный переход 1↔2 в посаде,
  //     стоит ровно в геометрическом центре — до любого конца моста ≤20 м
  mkSpiral(0, 0, MAP_FP, MAP_F2, 3.0, 0, gl, -1.15, 4);
  MAP_link(1,2, 0, 0, 'spiral');

  // --- площадка креста мостов на 15.0 с проёмом под обелиск
  mkDeckHole(-PSD_P,-PSD_P, PSD_P,PSD_P, -3.2,-3.2, 3.2,3.2, MAP_F2, 0.45, gl);
  for(const ax of [-1,1]) for(const az of [-1,1]){
    const px = ax*5.6, pz = az*5.6;
    blk(px, gh(px,pz)-0.5, pz, 1.5, MAP_F2-0.45-gh(px,pz)+0.5, 1.5, g1, 0, true);
  }
  /* Парапет площадки с проёмами по осям — там начинаются мосты.
     Северная и южная грани подняты в руинную стену 3.4 м: именно они рвут
     главную ось (ворота замка ↔ лагерь) на этаже 2. Восточная и западная
     остаются низкими — поперечная диагональ обязана простреливаться (§5). */
  for(const a of [0,1]) for(const s of [-1,1]) for(const t of [-1,1]){
    const o = t*(PSD_P/2 + 0.9), L = PSD_P - 1.8, H = a ? 0.95 : 3.4;
    if(a) blk(s*(PSD_P-0.3), MAP_F2, o, 0.5, H, L, gl, 0, true, true);
    else  blk(o, MAP_F2, s*(PSD_P-0.3), L, H, 0.5, gl, 0, true, true);
  }

  // --- четыре опоры и четыре пролёта: запад-восток и север-юг
  for(let i=0;i<4;i++){
    const ax = (i===0?-1:(i===1?1:0)), az = (i===2?-1:(i===3?1:0));
    const px = ax*PSD_T, pz = az*PSD_T;
    mkPier(px, pz, 4.6, MAP_F2, { rail: ax? (ax<0?'nsw':'nse') : (az<0?'wse':'wne') });
    /* Осевые опоры — руины надвратных башен: стены 3.4 м с наружной и боковых
       граней. Без них главная ось простреливается прямо по створу моста. */
    if(az){
      blk(0, MAP_F2, pz + az*2.0, 4.6, 3.4, 0.6, PROP_mt('gray2'), 0, true);
      for(const sx of [-1,1]) blk(sx*2.0, MAP_F2, pz, 0.6, 3.4, 4.6, PROP_mt('gray2'), 0, true, true);
    }
    mkRopeBridge(ax*PSD_P, az*PSD_P, px - ax*2.3, pz - az*2.3, MAP_F2, 2.6);
  }
  // трос с восточной опоры вниз, к восточному подступу
  mkZipline(PSD_T+1.2, MAP_F2+0.95, 0, 34, gh(34,-14)+1.4, -14);
  MAP_link(2,0, PSD_T, 0, 'zip');

  // --- руины: сетка улочек. Внутреннее кольцо несёт перекрытия этажа 1
  mkRuinHouse(-15, 3, -7, 11, { deckY:MAP_FP, mat:g1, matL:g2, open:'se', par:'nw' });
  mkRuinHouse( 7, 3, 15, 11, { deckY:MAP_FP, mat:g1, matL:g2, open:'sw', par:'n' });
  mkRuinHouse(-15,-11, -7,-3, { deckY:MAP_FP, mat:g1, matL:g2, open:'ne', par:'s' });
  mkRuinHouse( 7,-11, 15,-3, { deckY:MAP_FP, mat:g1, matL:g2, open:'nw', par:'se' });
  mkRuinHouse(-27,-8, -19, 2, { deckY:MAP_FP, mat:g1, matL:g2, open:'ns', par:'w' });
  mkRuinHouse( 19,-2, 27, 8, { deckY:MAP_FP, mat:g1, matL:g2, open:'ns', par:'e' });
  // мостки между перекрытиями: этаж 1 посада — связная сеть, а не острова
  // мостки идут в стороне от опор моста (±5.6): иначе опора наполовину
  // перекрывает переход, и по нему приходится протискиваться
  // ВАЖНО про z: марши террасы идут по z = 0 шириной 3.4, рампа работает ещё
  // на CFG.radius в стороны, и в moveHoriz коробка мостка раздувается на тот же
  // радиус. Значит любой мосток обязан начинаться дальше 1.7+0.42+0.42 = 2.54 м
  // от оси марша — иначе его угол перекрывает створ и на марше застреваешь.
  PROP_slab(-7.4, 3.0, -4.6, 5.2, MAP_FP, 0.34, g2, true, true);
  PROP_slab( 4.6, 3.0,  7.4, 5.2, MAP_FP, 0.34, g2, true, true);
  PROP_slab(-7.4,-5.2, -4.6,-3.0, MAP_FP, 0.34, g2, true, true);
  PROP_slab( 4.6,-5.2,  7.4,-3.0, MAP_FP, 0.34, g2, true, true);
  PROP_slab(-19.8,-7.0, -14.2,-5.0, MAP_FP, 0.34, g2, true, true);
  PROP_slab( 14.2, 5.0,  19.8, 7.0, MAP_FP, 0.34, g2, true, true);

  // внешнее кольцо: только этаж 0, зато оно и режет главную ось
  mkRuinHouse(-8, 19, 2, 27, { mat:g1, open:'we' });
  mkRuinHouse(-2,-27, 8,-19, { mat:g1, open:'we' });
  mkRuinHouse(-31, 10, -23, 20, { mat:g1, open:'se' });
  mkRuinHouse( 23,-20, 31,-10, { mat:g1, open:'nw' });
  mkRuinHouse( 10, 16, 20, 25, { mat:g1, open:'sw' });
  mkRuinHouse(-20,-25, -10,-16, { mat:g1, open:'ne' });
  mkRuinHouse(-31,-21, -23,-13, { mat:g1, open:'ne' });
  mkRuinHouse( 23, 13, 31, 21, { mat:g1, open:'sw' });

  // --- магия акцентами: кристаллы у обелиска и жаровни на террасе
  mkCrystal(-6.2,  4.0, MAP_F2+2.6, 0.95, PAL.arcane);
  mkCrystal( 6.2, -4.0, MAP_F2+3.2, 0.85, PAL.violet);
  mkCrystal(-4.4, -6.6, MAP_FP+3.4, 0.70, PAL.wisp);
  mkCrystal( 4.4,  6.6, MAP_FP+3.4, 0.70, PAL.wisp);
  mkBrazier(4.4, 4.4, MAP_FP); mkBrazier(-4.4, -4.4, MAP_FP);
  mkBrazier(-13.6, 3.2);

  // --- обломки на улицах: перебежка есть, прострела насквозь нет
  mkRuin(-19.5, 14.5, 1.05, 0.4); mkRuin(19.5,-14.5, 1.05, -0.4);
  mkRuin(-11.5,-17.5, 0.95, 2.0); mkRuin(11.5, 17.5, 0.95, -2.0);
  mkCrate(-9.5, 14.0, 1.5); mkCrate(9.5,-14.0, 1.5);
  mkCrate(17.5, 11.0, 1.3); mkCrate(-17.5,-11.0, 1.3);
  mkBarrel(-22.5, 6.5); mkBarrel(22.5,-6.5);
}

/* ========================= ФЛАНГОВЫЕ ДВОРЫ (x = ±52) =========================
   Только этажи 0 и 1: верх принадлежит базам и центру, иначе карта расползается. */
function MAP_buildFlanks(){
  const w0 = PROP_mt('wood0'), w1 = PROP_mt('wood1');
  for(const s of [-1,1]){
    const X = 52*s, Z = -2*s;
    // амбар с настилом на крыше: единственный этаж 1 на фланге.
    // Парапет БЕЗ южной стороны: марш въезжает на настил ровно с юга, и
    // сплошной борт 1.05 м вставал поперёк его створа — переход не работал
    mkRuinHouse(X-6, Z-5.5, X+6, Z+5.5, { deckY:MAP_F1, mat:w0, matL:w1, open:'we', par:'new' });
    // въезд на настил
    // верх въезда обрывается ЧУТЬ НЕ ДОХОДЯ до стены амбара: дальше рампа
    // держит ровную площадку, и стык с настилом получается без ступеньки
    mkMarch(X, Z-15.5, X, Z-5.95, 3.6, gh(X,Z-15.5), MAP_F1, { mat:w1, rail:true, railMat:w0 });
    MAP_link(0,1, X, Z-5.8, 'march');
    // лаз прислонён к северной стене амбара: сверху с него сходят НА настил,
    // а не мимо него
    mkLadder(X-4.6*s, Z+5.9, gh(X-4.6*s,Z+5.9), MAP_F1+0.3, Math.PI);
    MAP_link(0,1, X-4.6*s, Z+5.9, 'ladder');

    // двор: частокол, сено, ящики, костёр
    mkPalisade(X, Z+14, 18, 0, 3.2, w0);
    mkPalisade(X-9*s, Z-20, 14, Math.PI/2, 3.2, w0);
    mkHay(X+9*s, Z+8); mkHay(X+10.05*s, Z+9.2);
    mkCrate(X-9*s, Z+10, 1.6); mkCrate(X-10.5*s, Z+11.2, 1.3);
    mkBarrel(X+8*s, Z-9); mkBarrel(X+8.75*s, Z-9.6);
    mkFence(X+12*s, gh(X+12*s, Z-24), Z-24, 13, Math.PI/2);
    mkBrazier(X-11*s, Z-11);
    mkSandbags(X+4*s, gh(X+4*s,Z+18), Z+18, 5.0, 2, 0.2);
    mkRuin(X-13*s, Z+22, 0.95, 1.1);
    mkBanner(X+2*s, Z-4.5, s>0?Math.PI*0.5:-Math.PI*0.5, PAL.gold, MAP_F1);
  }
}

/* ===================== ПОДСТУПЫ: СЕВЕРНЫЙ И ЮЖНЫЙ ===================== */
function MAP_buildApproach(){
  for(const s of [-1,1]){
    // s>0 — северный подступ (к замку), s<0 — южный (к лагерю)
    mkSandbags(-13*s, gh(-13*s, 40*s), 40*s, 5.4, 2, 0.25);
    mkSandbags( 13*s, gh( 13*s, 40*s), 40*s, 5.4, 2, 0.25);
    mkSandbags(  0,   gh(0, 34*s),     34*s, 4.6, 2, Math.PI/2);
    mkRuin(-33*s, 30*s, 1.15, 0.6); mkRuin(33*s, 30*s, 1.05, -0.6);
    mkRuin(-7*s, 44*s, 0.9, 1.8);
    mkCrate(-25*s, 36*s, 1.6); mkCrate(-26.6*s, 37.4*s, 1.4);
    mkCrate( 25*s, 36*s, 1.6); mkCrate( 26.6*s, 37.4*s, 1.3);
    mkBarrel(-19*s, 28*s); mkBarrel(-19.55*s, 28.45*s);
    mkHay(20*s, 26*s); mkHay(21.05*s, 27.05*s);
    mkFence(-40*s, gh(-40*s, 22*s), 22*s, 12, Math.PI/2);
    mkFence( 40*s, gh( 40*s, 22*s), 22*s, 12, Math.PI/2);
    mkBrazier(-30*s, 33*s);
  }
}

function buildMap(){
  buildTerrain();
  buildSky();

  MAP_buildCastle();
  MAP_buildCamp();
  MAP_buildPosad();
  MAP_buildFlanks();
  MAP_buildApproach();

  /* ============================ ОКРУЖЕНИЕ ============================
     Камни и деревья расставлены руками, а не случайно. Причина не в красоте:
     карта соревновательная, и она обязана быть одинаковой в каждом запуске —
     иначе укрытие, за которым игрок прятался вчера, сегодня стоит на два
     метра левее. Заодно координаты выбраны серединами клеток автопроверки
     проходимости (кратно 8 со сдвигом 2), чтобы декор не подменял собой
     результат замера. */
  const MAP_ROCKS = [[-38,-30,2.1],[42,26,2.1],[-30,42,1.7],[34,-38,1.7],
                     [-54,-38,2.3],[58,34,2.3],[-62,-62,1.9],[34,66,1.9],
                     [-70,-14,1.5],[74,10,1.5],[-46,58,1.3],[50,-54,1.3]];
  for(const r of MAP_ROCKS) mkRock(r[0], r[1], r[2]);
  const MAP_TREES = [[-62,42,0],[66,-46,1],[-70,-30,0],[74,26,1],[-38,74,0],[42,-74,1]];
  for(const t of MAP_TREES) mkTree(t[0], t[1], !!t[2]);
  // скалы по периметру: крупные и редкие — граница читается, а мешей мало.
  // Кладём их по КВАДРАТУ границы, а не по окружности: по окружности на
  // диагоналях они заезжали внутрь поля и стояли препятствием посреди игры.
  /* Вынос наружу держим МАЛЫМ. За CFG.half рельеф уходит в чашу и набирает
     по два с лишним метра на каждый метр: камень, вынесенный на 4…9 м,
     садился серединой на обрыв, краем висел в воздухе (это и видно на
     кадрах), а в углу оказывался на отметке 20 м — выше этажа 2. У самой
     подошвы обрыва земля ещё ровная, и гряда читается как гряда. */
  for(let i=0;i<26;i++){
    const a=(i/26)*Math.PI*2, ca=Math.cos(a), sa=Math.sin(a);
    const m = Math.max(Math.abs(ca), Math.abs(sa));   // 1 на грани, 0.71 в углу
    const r = (CFG.half+rnd(0.5,2.5)) / m;
    // размер режем тем же множителем, каким растянут радиус квадрата:
    // в углу камень стоит дальше от поля, и та же величина читалась бы башней
    mkRock(ca*r, sa*r, rnd(3.0,4.4)*m);
  }

  mkSign(-7, -46, 0, 'BLU · ЛАГЕРЬ', PAL.blu);
  mkSign( 7,  46, Math.PI, 'RED · ЗАМОК', PAL.red);
  mkSign(-40, 0, -Math.PI/2, 'ЗАПАДНЫЙ ДВОР', PAL.rust);
  mkSign( 40, 0,  Math.PI/2, 'ВОСТОЧНЫЙ ДВОР', PAL.rust);

  /* ========================== ТОЧКИ РЕСПАВНА ==========================
     RED появляется в кармане за донжоном, BLU — за рядами обоза и осадной
     башней. Оба кармана закрыты от всех точек этажа 2 (§5, проверено). */
  const ry = gh(0,76.4)+0.1, by = gh(0,-71)+0.1;
  SPAWNS_RED.push({x:-5,y:ry,z:76.4},{x:-1.7,y:ry,z:76.4},{x:1.7,y:ry,z:76.4},{x:5,y:ry,z:76.4});
  SPAWNS_BLU.push({x:-4,y:by,z:-71},{x:4,y:by,z:-71},{x:0,y:gh(0,-74)+0.1,z:-74},
                  {x:-8.5,y:gh(-8.5,-73)+0.1,z:-73},{x:8.5,y:gh(8.5,-73)+0.1,z:-73});

  /* ======================= ОГНЕВЫЕ ПОЗИЦИИ ИИ =======================
     via — маршрут: бот идёт по точкам, climb:true помечает подъём.
     Высоту у поднятых точек задаём явно: gh() вернул бы землю, и бот
     считал бы, что уже пришёл. */

  // --- этаж 2 ---
  // первая точка маршрута — ПЕРЕД основанием рампы: встав на саму рампу,
  // бот считал бы её высоту по земле и думал, что уже пришёл
  const viaWallW = [{x:-11.0, z:52.2}, {x:-11.0, z:64.0, y:MAP_F1}, {x:-15.6, z:65.0, y:MAP_F1}];
  const viaWallE = [{x: 11.0, z:52.2}, {x: 11.0, z:64.0, y:MAP_F1}, {x: 15.6, z:65.0, y:MAP_F1}];
  MAP_post('БАШНЯ ЗАПАД', -14.6, 47.6, MAP_F2, 2, 0.55, viaWallW.concat([{x:-17.5,z:53.6,y:MAP_F1}]));
  MAP_post('БАШНЯ ЗАПАД', -14.6, 53.4, MAP_F2, 2, 0.5,  viaWallW.concat([{x:-17.5,z:53.6,y:MAP_F1}]));
  MAP_post('БАШНЯ ВОСТОК', 14.6, 47.6, MAP_F2, 2, 0.55, viaWallE.concat([{x: 17.5,z:53.6,y:MAP_F1}]));
  MAP_post('БАШНЯ ВОСТОК', 14.6, 53.4, MAP_F2, 2, 0.5,  viaWallE.concat([{x: 17.5,z:53.6,y:MAP_F1}]));
  MAP_post('ДОНЖОН',  0.0, 68.5, MAP_F2, 2, 0.5, viaWallW.concat([{x:-15.6,z:71,y:MAP_F1}]));
  MAP_post('ДОНЖОН', -4.6, 72.4, MAP_F2, 2, 0.55, viaWallW.concat([{x:-15.6,z:71,y:MAP_F1}]));
  MAP_post('ДОНЖОН',  4.6, 65.4, MAP_F2, 2, 0.45, viaWallW.concat([{x:-15.6,z:71,y:MAP_F1}]));
  const viaPosad = [{x:-12.6, z:0}, {x:-4.0, z:0, y:MAP_FP}];
  MAP_post('МОСТ ЦЕНТР',  4.8,  4.8, MAP_F2, 2, 0.45, viaPosad);
  MAP_post('МОСТ ЦЕНТР', -4.8, -4.8, MAP_F2, 2, 0.45, viaPosad);
  MAP_post('ОПОРА СЕВЕР',  0, PSD_T, MAP_F2, 2, 0.4, viaPosad);
  MAP_post('ОПОРА ЮГ',     0,-PSD_T, MAP_F2, 2, 0.4, viaPosad);
  MAP_post('ОПОРА ВОСТОК', PSD_T, 0, MAP_F2, 2, 0.4, viaPosad);
  MAP_post('ОПОРА ЗАПАД', -PSD_T, 0, MAP_F2, 2, 0.4, viaPosad);
  const viaSiege = [{x:-13, z:CMP_Z-10}, {x:-8, z:CMP_Z, y:MAP_F1}];
  MAP_post('ОСАДНАЯ БАШНЯ',  1.4, CMP_Z+1.4, MAP_F2, 2, 0.45, viaSiege);
  MAP_post('ОСАДНАЯ БАШНЯ',  2.6, CMP_Z-2.6, MAP_F2, 2, 0.5,  viaSiege);
  MAP_post('КОРРЕКТИРОВЩИК', -11.5, CMP_Z, MAP_F2, 2, 0.4, viaSiege);

  // --- этаж 1 ---
  MAP_post('БОЕВОЙ ХОД ЗАПАД', -17.5, 60, MAP_F1, 1, 0.6, viaWallW);
  MAP_post('БОЕВОЙ ХОД ЗАПАД', -17.5, 72, MAP_F1, 1, 0.6, viaWallW);
  MAP_post('БОЕВОЙ ХОД ВОСТОК', 17.5, 60, MAP_F1, 1, 0.6, viaWallE);
  MAP_post('БОЕВОЙ ХОД ВОСТОК', 17.5, 72, MAP_F1, 1, 0.6, viaWallE);
  MAP_post('БОЕВОЙ ХОД СЕВЕР',   0.0, 79.5, MAP_F1, 1, 0.55, viaWallW);
  MAP_post('НАД ВОРОТАМИ', -7.5, 50.5, MAP_F1, 1, 0.7, viaWallW);
  MAP_post('НАД ВОРОТАМИ',  7.5, 50.5, MAP_F1, 1, 0.7, viaWallE);
  MAP_post('ТЕРРАСА', -4.4,  4.4, MAP_FP, 1, 0.45, viaPosad);
  MAP_post('ТЕРРАСА',  4.4, -4.4, MAP_FP, 1, 0.45, viaPosad);
  MAP_post('ПЕРЕКРЫТИЕ', -11, 7, MAP_FP, 1, 0.5, viaPosad);
  MAP_post('ПЕРЕКРЫТИЕ',  11, 7, MAP_FP, 1, 0.5, viaPosad);
  MAP_post('ПЕРЕКРЫТИЕ', -11,-7, MAP_FP, 1, 0.5, viaPosad);
  MAP_post('ПЕРЕКРЫТИЕ',  11,-7, MAP_FP, 1, 0.5, viaPosad);
  MAP_post('СКЛАД ЗАПАД', -23, -3, MAP_FP, 1, 0.55, viaPosad);
  MAP_post('СКЛАД ВОСТОК', 23,  3, MAP_FP, 1, 0.55, viaPosad);
  for(const s of [-1,1]){
    const via = [{x:s*13, z:CMP_Z-12}, {x:s*13, z:CMP_Z-3, y:MAP_F1}];
    MAP_post('ПОМОСТ', s*17, CMP_Z, MAP_F1, 1, 0.35, via);
    MAP_post('ПОМОСТ', s*24, CMP_Z+7, MAP_F1, 1, 0.4, via);
    MAP_post('АМБАР', 52*s, -2*s, MAP_F1, 1, 0.45,
      [{x:52*s, z:-2*s-14}, {x:52*s, z:-2*s-7, y:MAP_F1}]);
  }

  // --- этаж 0 ---
  MAP_post('ДВОР ЗАМКА', -8.6, 60.5, undefined, 0, 0.6);
  MAP_post('ДВОР ЗАМКА',  8.6, 60.5, undefined, 0, 0.6);
  // отодвинута от стога (-2.4, 59.6): в прежней точке боту не хватало роста
  MAP_post('ДВОР ЗАМКА',  -0.4, 61.4, undefined, 0, 0.45);
  MAP_post('ПРЕДПОЛЬЕ', -13, 37.4, undefined, 0, 0.7);
  MAP_post('ПРЕДПОЛЬЕ',  13, 37.4, undefined, 0, 0.7);
  MAP_post('ПРЕДПОЛЬЕ',  2.0, 34, undefined, 0, 0.65);
  MAP_post('РОВ', -33, 30, undefined, 0, 0.6);
  MAP_post('РОВ',  33, 30, undefined, 0, 0.6);
  MAP_post('УЛИЦА', -19, 14, undefined, 0, 0.65);
  MAP_post('УЛИЦА',  19,-14, undefined, 0, 0.65);
  // отодвинута от обломка (-11.5, -17.5): цоколь его колонны накрывал точку
  MAP_post('УЛИЦА', -7.8,-13.8, undefined, 0, 0.6);
  MAP_post('УЛИЦА',   9, 15, undefined, 0, 0.6);
  MAP_post('УЛИЦА', -24,-12, undefined, 0, 0.6);
  MAP_post('УЛИЦА',  24, 12, undefined, 0, 0.6);
  MAP_post('ПЛОЩАДЬ',  0, 12, undefined, 0, 0.45);
  MAP_post('ПЛОЩАДЬ',  0,-12, undefined, 0, 0.45);
  MAP_post('ТРАНШЕЯ', -13,-37.4, undefined, 0, 0.7);
  MAP_post('ТРАНШЕЯ',  13,-37.4, undefined, 0, 0.7);
  MAP_post('ТРАНШЕЯ', -2.0,-34, undefined, 0, 0.65);
  MAP_post('ТУРЫ', -33,-30, undefined, 0, 0.6);
  MAP_post('ТУРЫ',  33,-30, undefined, 0, 0.6);
  MAP_post('ЛАГЕРЬ', -14,-66, undefined, 0, 0.6);
  MAP_post('ЛАГЕРЬ',  14,-66, undefined, 0, 0.6);
  MAP_post('ЛАГЕРЬ',   0,-62, undefined, 0, 0.5);
  MAP_post('ДВОР ЗАПАД', -52,-20, undefined, 0, 0.6);
  MAP_post('ДВОР ЗАПАД', -52, 14, undefined, 0, 0.55);
  MAP_post('ДВОР ВОСТОК', 52, 20, undefined, 0, 0.6);
  MAP_post('ДВОР ВОСТОК', 56.5,-13, undefined, 0, 0.55);
  MAP_post('ОБХОД ЗАПАД', -43, -31, undefined, 0, 0.5);
  MAP_post('ОБХОД ВОСТОК', 43,  31, undefined, 0, 0.5);

  /* ====================== АПТЕЧКИ И БОЕПРИПАСЫ ====================== */
  MAP_pu(0, 70, 'hp', 'm', MAP_F2);                  //  0 кровля донжона
  MAP_pu(2.6, CMP_Z-3.4, 'hp', 'm', MAP_F2);         //  1 осадная башня
  MAP_pu(5.0, 0, 'ammo', undefined, MAP_F2);         //  2 крест мостов
  MAP_pu(-PSD_T, 0, 'ammo', undefined, MAP_F2);      //  3 западная опора
  MAP_pu(PSD_T, 0, 'ammo', undefined, MAP_F2);       //  4 восточная опора
  MAP_pu(-52, -2, 'hp', 'm', MAP_F1);                //  5 амбар западного двора
  MAP_pu( 52,  2, 'hp', 'm', MAP_F1);                //  6 амбар восточного двора
  MAP_pu(-11, 7, 'ammo', undefined, MAP_FP);         //  7 перекрытие северо-запад
  MAP_pu( 11,-7, 'ammo', undefined, MAP_FP);         //  8 перекрытие юго-восток
  MAP_pu(2.0, 34, 'hp', 's');                        //  9 северный подступ
  MAP_pu(-2.0,-34, 'hp', 's');                       // 10 южный подступ
  MAP_pu(-27, 34, 'ammo');                           // 11
  MAP_pu( 27,-34, 'ammo');                           // 12
  MAP_pu(-8.6, 60.5, 'hp', 's');                     // 13 двор замка
  MAP_pu( 14, -66, 'hp', 's');                       // 14 лагерь
  MAP_pu(-52,-20, 'ammo');                           // 15 западный двор
  MAP_pu( 52, 20, 'ammo');                           // 16 восточный двор

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
