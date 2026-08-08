'use strict';
/* =====================================================================
   DM_DUEL v3 · net/server.js — авторитетный сервер комнаты.

   Один процесс на чистом Node (http, crypto, fs, path, os) — зависимостей нет
   и не будет: друзьям должно хватать `node net/server.js` на голой машине.

   Модель авторитета — NETCONTRACT.md §1. Коротко: движение и «попал/не попал»
   решает клиент, а здоровье, очки, смерть, респавн и пикапы ведёт сервер.
   Рельефа, коллизий и баллистики здесь нет и быть не должно — сервер только
   проверяет заявки на правдоподобность. Это ловит рассинхрон и небрежное
   жульничество; от подготовленного читера такая схема не защищает, и об этом
   честно сказано в интерфейсе.

   Запуск:  node net/server.js [--port 8177]
   Порт:    --port  >  PORT  >  8177
   ===================================================================== */

const http   = require('http');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

/* ====================== ПРАВИЛА КОМНАТЫ ====================== */
/* Объявлены здесь и только здесь: клиент получает нужные ему числа в welcome. */
const RULES = { slots:8, players:4, goal:20, respawn:3.0, tick:20, timeout:10000 };

const VER = 'v3';                     // версия протокола, приходит в hello

/* Боевые числа продублированы из массива RIFLE_AMMO в src/10_core.js.
   ОНИ ОБЯЗАНЫ СОВПАДАТЬ С НИМ. По ним сервер считает потолок урона и
   минимально возможный интервал между выстрелами; разъедутся — сервер начнёт
   резать честные попадания или пропускать нечестные. Поле headMax повторяет
   WPN_headDamage() из src/60_weapon.js: полный крит только у матчевого,
   у фугаса крита нет вовсе, зажигательный бьёт в голову ×2.2. */
const RIFLE_AMMO = [
  { id:'match', dmgMax:90, headMax:1000,  cd:0.0, bolt:1.10 },
  { id:'frag',  dmgMax:44, headMax:44,    cd:2.5, bolt:1.55, splashR:5.2, splashMax:58 },
  { id:'fire',  dmgMax:38, headMax:83.6,  cd:5.0, bolt:1.30, burnDps:11, burnTime:6 }
];

/* Вторая таблица — стрелы. ОНА ТОЖЕ ОБЯЗАНА СОВПАДАТЬ с BOW_AMMO из
   src/10_core.js: у лука свои цифры, и проверять его заявки по винтовочным
   значит либо резать честные выстрелы, либо пропускать чужие.
   bolt здесь — не затвор, а время наложить стрелу (см. SRV_minInterval).

   headMax у стрелы — 1000, как у матчевого патрона: «обычный» тип у обоих
   стволов по замыслу единственный с ПОЛНЫМ критом (10_core.js), а у нас нет
   способа отличить гарантированное убийство от завышенной заявки, кроме как
   поверить в него. Резать честный крит хуже: заявить 'head' читер может и
   с винтовкой, этот риск в схеме был и раньше. Огненная бьёт в голову ×2.2
   (36 × 2.2 = 79.2), у взрывной крита нет вовсе. */
const BOW_AMMO = [
  { id:'arrow', dmgMax:88, headMax:1000,  cd:0.0, bolt:0.42 },
  { id:'bomb',  dmgMax:42, headMax:42,    cd:2.5, bolt:0.62, splashR:5.0, splashMax:56 },
  { id:'flame', dmgMax:36, headMax:79.2,  cd:5.0, bolt:0.52, burnDps:11, burnTime:6 }
];

/* Стволы — зеркало WPNS из src/10_core.js. Индекс здесь и есть поле w из
   'hello' и из записи игрока в снапшоте: 0 винтовка, 1 лук. drawTime — время
   полного натяга; у винтовки его нет. */
const WEAPONS = [
  { id:'rifle', bow:false, drawTime:0,    ammo:RIFLE_AMMO },
  { id:'bow',   bow:true,  drawTime:1.05, ammo:BOW_AMMO }
];
function SRV_w(w){ return (w | 0) === 1 ? 1 : 0; }
/* Строка боеприпаса ТОГО, ЧЕМ СТРЕЛЯЕТ ЗАЯВИТЕЛЬ (null — такого индекса нет).
   Всё, что проверяет урон и темп, обязано ходить сюда, а не в одну «главную»
   таблицу: у лука и винтовки совпадают только роли типов, но не числа. */
function SRV_ammo(p, a){
  const L = WEAPONS[p.w].ammo;
  return (a >= 0 && a < L.length) ? L[a] : null;
}
function SRV_burnTotal(w){ const a = WEAPONS[SRV_w(w)].ammo[2]; return a.burnDps * a.burnTime; }
/* Весь запас горения с одного попадания. Котёл жертвы наполняет ЧУЖОЕ оружие,
   поэтому его потолок берём по самому щедрому стволу, а темп списания — по
   тому, которым подожгли (v.burnDps). */
const BURN_MAX = Math.max(SRV_burnTotal(0), SRV_burnTotal(1));   // 66

/* Допуски валидации. Сеть врёт временем и позициями, поэтому пороги заведомо
   шире идеала: задача — отсечь бессмыслицу, а не наказать за пинг. */
const V_RATE   = 0.85;    // сколько от расчётного интервала между выстрелами обязано пройти
const V_MUZZLE = 36;      // квадрат допустимого разлёта «ствол vs заявленная позиция», м²
const V_RANGE  = 300;     // потолок дистанции выстрела: диагональ зоны 2*88 м ≈ 249 м плюс запас
const V_HITWIN = 3000;    // мс: попадание обязано опираться на выстрел не старше этого
const V_LATERAL0 = 3.5;   // допуск «мимо луча» у ствола, м
const V_LATERALK = 0.06;  // и его рост с дистанцией (лаг цели: 8.8 м/с × 0.2 с на 20 м — это 5°)
const V_DMG_TOL  = 1.06;  // округления клиента и множители сложности
const BOT_MAX_DMG = 190;  // бот бьёт матчевым: 90 × 1.25 (сложность) × 1.65 (крит) ≈ 186.
                          // Луков у ботов нет: ИИ стреляет винтовкой независимо от того,
                          // что выбрал себе хост, — потолок здесь один и не зависит от w
const BOT_HITS  = 8;      // сколько заявок об уроне ботам засчитываем на один выстрел:
                          // фугас накрывает всех сразу, но не больше, чем их бывает
const V_PICK2   = 36;     // квадрат допустимого расстояния до пикапа, м². Клиент берёт
                          // с 1.7 м, но его позиция у нас отстаёт на пакет и на пинг:
                          // 6 м — это «стоял рядом», а не «взял через полкарты»
const V_PICKY   = 4.0;    // и допуск по вертикали: карта многоярусная, аптечку с моста
                          // нельзя подобрать снизу
const BOTS_TTL  = 1000;   // мс: кадр ботов протухает. Хост ушёл или замолчал — боты
                          // обязаны исчезнуть, а не стоять неподвижными мишенями
const REJ_WIN   = 10000;  // окно наблюдения за отклонёнными заявками, мс
const REJ_MAX   = 100;    // столько отклонений за окно — и соединение закрывается.
                          // Считаем именно ТЕМП, а не сумму: у игрока с плохим каналом
                          // заявок физически не больше нескольких в секунду, и он не
                          // должен вылетать из матча за то, что ему не везёт с сетью
const ROUND_HOLD = 10000; // мс после достижения цели до сброса счёта
const WPN_SWAP  = 3000;   // мс: не чаще этого смена ствола обнуляет отметки выстрелов.
                          // Честному игроку столько и так стоит выход в брифинг, а
                          // «туда-обратно» перестаёт быть способом стрелять без темпа

/* ====================== СЕТЕВЫЕ ЛИМИТЫ ====================== */
const WS_GUID     = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_MAXFRAME = 512 * 1024;   // потолок одного кадра
const WS_MAXMSG   = 1024 * 1024;  // потолок собранного из фрагментов сообщения
const WS_MAXJSON  = 256 * 1024;   // что больше — даже не пытаемся разбирать
const WS_MAXOUT   = 4 * 1024 * 1024;  // исходящая очередь: клиент, который не читает, отваливается
const MAXCONN     = 24;           // сокетов всего (игроки + зеваки на рукопожатии)

/* ====================== ТОЧКИ РЕСПАВНА ====================== */
/* Зеркало SPAWNS_BLU / SPAWNS_RED из src/45_map.js. ОБЯЗАНО совпадать с ним:
   разъехавшись, сеть начнёт высаживать бойцов не туда, где их ждёт карта.

   Гнездо базы — башня в три этажа на канонических высотах 0 / 6 / 12, по три
   точки на этаж. Появление случайное по ярусу — это требование заказчика, а
   не украшение, поэтому и сервер обязан раздавать все девять, а не только
   нижние. Клиент доводит игрока своей физикой; серверу нужна осмысленная
   точка, высота у неё — пол соответствующего яруса плюс 5 см. */
const SPAWNS = [
  // 0 = BLU, гнездо южного сруба
  [ {x:0,y:0.05,z:-63.2}, {x:-6.6,y:0.05,z:-61.6}, {x:6.6,y:0.05,z:-61.6},
    {x:0,y:6.05,z:-63.2}, {x:-6.6,y:6.05,z:-61.6}, {x:6.6,y:6.05,z:-61.6},
    {x:0,y:12.05,z:-63.2}, {x:-6.6,y:12.05,z:-61.6}, {x:6.6,y:12.05,z:-61.6} ],
  // 1 = RED, гнездо северного сруба
  [ {x:0,y:0.05,z:63.2}, {x:-6.6,y:0.05,z:61.6}, {x:6.6,y:0.05,z:61.6},
    {x:0,y:6.05,z:63.2}, {x:-6.6,y:6.05,z:61.6}, {x:6.6,y:6.05,z:61.6},
    {x:0,y:12.05,z:63.2}, {x:-6.6,y:12.05,z:61.6}, {x:6.6,y:12.05,z:61.6} ]
];

/* ====================== ПИКАПЫ ====================== */
/* Зеркало массива PICKUPS из src/45_map.js. ТИП, КООРДИНАТЫ И ПОРЯДОК ОБЯЗАНЫ
   СОВПАДАТЬ С НИМ — так же, как таблицы боеприпасов и точки респавна. Клиент шлёт индекс в
   этом массиве, и разъехавшийся порядок означает, что заявка на аптечку у базы
   вылечит того, кто стоит на крыше форта.

   heal повторяет 75_combat.js: большая аптечка 50 hp, малая 25, ящик патронов
   здоровья не даёт (боеприпасы клиент считает сам — они не спорны).
   cd повторяет MAP_pu(): аптечка большая 22 с, малая 13 с, патроны 18 с.
   y — высота площадки под предметом; в 45_map.js это gh(x,z) либо настил,
   который вернул конструктор. Сервер рельефа не знает, поэтому числа посчитаны
   один раз по terrainH() и служат только для проверки яруса. */
const PICKS = [
  { x:  0,   z:-38, y: 0.00, heal:50, cd:22 },   //  0 пролёт, юг
  { x: 16,   z:  8, y: 0.00, heal:25, cd:13 },   //  1 пол, восток
  { x:  0,   z: 56, y: 0.00, heal: 0, cd:18 },   //  2 сруб RED, пол
  { x: 19.5, z: 40, y: 6.00, heal: 0, cd:18 },   //  3 галерея, СВ
  { x:-19.5, z: 40, y: 6.00, heal: 0, cd:18 },   //  4 галерея, СЗ
  { x:  9.2, z: 30, y:12.00, heal:25, cd:13 },   //  5 мостки, север
  { x: -9.2, z:-30, y:12.00, heal: 0, cd:18 },   //  6 мостки, юг
  { x:  3.4, z: 52, y:18.00, heal:50, cd:22 },   //  7 чердак RED
  { x:  5.2, z: -5.2, y:18.00, heal: 0, cd:18 }, //  8 стропила, центр
  { x:  0,   z: 38, y: 0.00, heal:50, cd:22 },   //  9 пролёт, север
  { x:-16,   z: -8, y: 0.00, heal:25, cd:13 },   // 10 пол, запад
  { x:  0,   z:-56, y: 0.00, heal: 0, cd:18 },   // 11 сруб BLU, пол
  { x:-19.5, z:-40, y: 6.00, heal: 0, cd:18 },   // 12 галерея, ЮЗ
  { x: 19.5, z:-40, y: 6.00, heal: 0, cd:18 },   // 13 галерея, ЮВ
  { x: -9.2, z:-30, y:12.00, heal:25, cd:13 },   // 14 мостки, юг
  { x:  9.2, z: 30, y:12.00, heal: 0, cd:18 },   // 15 мостки, север
  { x: -3.4, z:-52, y:18.00, heal:50, cd:22 },   // 16 чердак BLU
  { x: -5.2, z:  5.2, y:18.00, heal: 0, cd:18 }  // 17 стропила, центр
];

/* ====================== САМОУРОН ====================== */
/* §9.1: здоровьем владеет только сервер, поэтому фугас под ногами, горение и
   падение приходят заявкой {t:'self', d, c}. Величину решаем мы: иначе «сам
   себе нанёс» — это дырка, через которую клиент обнуляет чужие расчёты.
   max — потолок одной заявки, dps — темп: разрешённый урон копится в ведре
   и вытекает со скоростью dps, так что залп из ста заявок подряд сработает
   как один. Таблица без прототипа: причина приходит от клиента строкой, и
   'constructor' не должен превращаться в правило (см. §9.5).

   Таблиц две — по одной на ствол: под ногами у лучника рвётся взрывная стрела,
   а не фугас, и её площадь слабее. Клиент выводит свою порцию из тех же чисел
   (NT_selfCap в 92_net.js), так что разъехавшиеся потолки означают отклонённый
   честный самоурон. */
function SRV_selfTable(w){
  const A = WEAPONS[SRV_w(w)].ammo;
  const t = Object.create(null);
  t.frag = { i:0, n:'frag', max:(A[1].splashMax || A[1].dmgMax) * V_DMG_TOL, dps:70 };
  t.burn = { i:1, n:'burn', max:A[2].burnDps * 0.75, dps:A[2].burnDps * 1.6 };
  t.fall = { i:2, n:'fall', max:100, dps:100 };   // падение с высоты убивает разом
  return t;
}
const SELF_CAUSE = [ SRV_selfTable(0), SRV_selfTable(1) ];

/* ====================== УТИЛИТЫ ====================== */
const SRV_T0 = Date.now();
function SRV_now(){ return Date.now() - SRV_T0; }
function SRV_num(v){ return (typeof v === 'number' && Number.isFinite(v)); }
/* Позиции режем до сантиметра, а углы и направления — до четвёртого знака:
   0.01 рад — это полградуса, и на дистанции снайперского выстрела трассер
   уходит от цели на пару метров. Экономия в пакете того не стоит. */
function SRV_r2(v){ return Math.round(v*100)/100; }
function SRV_r4(v){ return Math.round(v*10000)/10000; }
function SRV_clamp(v,a,b){ return v<a?a:(v>b?b:v); }
/* Любая пришедшая по сети строка, которую мы потом печатаем или отправляем
   дальше: управляющие символы ломают и лог, и чужой интерфейс. */
function SRV_clean(s, n){
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().substr(0, n || 16);
}
function SRV_log(){
  const s = new Date().toISOString().substr(11,8);
  const a = Array.prototype.slice.call(arguments);
  a.unshift('[' + s + ']');
  console.log.apply(console, a);
}

/* ====================== HTTP ====================== */
const ROOT  = path.resolve(__dirname, '..');
const INDEX = 'dm_duel_v3.html';
const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8',   '.json':'application/json; charset=utf-8',
  '.md':'text/plain; charset=utf-8',  '.png':'image/png', '.jpg':'image/jpeg',
  '.svg':'image/svg+xml',             '.ico':'image/x-icon', '.txt':'text/plain; charset=utf-8'
};

function SRV_httpReq(req, res){
  try{
    if(req.method !== 'GET' && req.method !== 'HEAD'){
      res.writeHead(405, {'Allow':'GET, HEAD'}); res.end('method not allowed'); return;
    }
    let rel;
    try { rel = decodeURIComponent(String(req.url||'/').split('?')[0].split('#')[0]); }
    catch(e){ res.writeHead(400).end('bad url'); return; }
    if(rel.indexOf('\0') >= 0){ res.writeHead(400).end('bad url'); return; }

    /* Диагностика комнаты: удобно ткнуть из браузера, не отвлекая консоль. */
    if(rel === '/__status'){
      const body = JSON.stringify(SRV_status(), null, 1);
      res.writeHead(200, {'Content-Type':MIME['.json'], 'Cache-Control':'no-store'});
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    rel = rel.replace(/^\/+/, '');
    if(rel === '' || rel.endsWith('/')) rel += INDEX;

    /* Защита от выхода за корень: resolve схлопывает '..', после чего путь
       обязан лежать внутри ROOT. Сравнение с разделителем — иначе каталог
       «..\Sniper-secret» рядом с проектом прошёл бы по startsWith. */
    const file = path.resolve(ROOT, rel);
    if(file !== ROOT && !file.startsWith(ROOT + path.sep)){
      res.writeHead(403, {'Content-Type':MIME['.txt']}).end('forbidden'); return;
    }
    fs.readFile(file, (err, buf) => {
      if(err){
        res.writeHead(404, {'Content-Type':MIME['.txt'], 'Cache-Control':'no-store'});
        res.end('not found: ' + rel);
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': buf.length,
        'Cache-Control': 'no-store'
      });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
  }catch(e){
    try { res.writeHead(500).end('server error'); } catch(_){}
    SRV_log('HTTP исключение:', e && e.message);
  }
}

/* ====================== WEBSOCKET (RFC 6455 вручную) ====================== */
/* Маска снимается на месте, поэтому четыре её байта держим в общем буфере —
   в горячем пути приёма ничего не аллоцируется. */
const WS_MASK = new Uint8Array(4);

class WSConn {
  constructor(sock){
    this.sock    = sock;
    this.rbuf    = Buffer.allocUnsafe(4096);
    this.rlen    = 0;
    this.fragOp  = 0;        // 0 = сборки нет
    this.fragParts = null;
    this.fragLen = 0;
    this.closing = false;
    this.dead    = false;
    this.p       = null;     // игрок, появляется после hello
    this.onmessage = null;
    this.onclose   = null;
    this.killT   = null;

    sock.setNoDelay(true);
    sock.setTimeout(0);
    sock.on('data',  d => this.onData(d));
    sock.on('error', e => this.destroy('сокет: ' + (e && e.code || 'error')));
    sock.on('end',   () => this.destroy('сокет закрыт клиентом'));
    sock.on('close', () => this.destroy('сокет закрыт'));
  }

  /* ---------- приём ---------- */
  onData(d){
    if(this.dead || this.closing) return;   // после close всё пришедшее уже неинтересно
    try{
      /* Копим только то, что обязано влезть: заявленный лимит кадра плюс
         недособранное сообщение. Всё сверх — попытка утопить сервер памятью. */
      if(this.rlen + d.length > WS_MAXFRAME + 4096){ this.close(1009, 'buffer overflow'); return; }
      this._need(this.rlen + d.length);
      d.copy(this.rbuf, this.rlen);
      this.rlen += d.length;
      this._parse();
    }catch(e){
      SRV_log('разбор кадра:', e && e.message);
      this.close(1002, 'frame error');
    }
  }

  _need(n){
    if(this.rbuf.length >= n) return;
    let cap = this.rbuf.length;
    while(cap < n) cap *= 2;
    const nb = Buffer.allocUnsafe(cap);
    this.rbuf.copy(nb, 0, 0, this.rlen);
    this.rbuf = nb;
  }

  _parse(){
    let off = 0;
    for(;;){
      if(this.dead || this.closing) return;
      const B = this.rbuf;
      const avail = this.rlen - off;
      if(avail < 2) break;

      const b0 = B[off], b1 = B[off+1];
      if(b0 & 0x70){ this.close(1002, 'RSV set'); return; }       // расширений не согласовывали
      const fin    = (b0 & 0x80) !== 0;
      const op     =  b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let hdr = 2;

      if(len === 126){
        if(avail < 4) break;
        len = B.readUInt16BE(off+2); hdr = 4;
      } else if(len === 127){
        if(avail < 10) break;
        const hi = B.readUInt32BE(off+2), lo = B.readUInt32BE(off+6);
        /* Старшие 32 бита обязаны быть нулём: всё остальное — либо ошибка,
           либо попытка заставить нас поверить в кадр на терабайт. */
        if(hi !== 0){ this.close(1009, 'length too big'); return; }
        len = lo; hdr = 10;
      }
      /* Кадр от клиента ОБЯЗАН быть маскирован — прямое требование RFC 6455 §5.1. */
      if(!masked){ this.close(1002, 'unmasked client frame'); return; }
      hdr += 4;
      /* Отсекаем по ЗАЯВЛЕННОЙ длине, не дожидаясь тела: иначе гигантская
         длина заставит нас копить память до самого разрыва. */
      if(len > WS_MAXFRAME){ this.close(1009, 'frame too big'); return; }
      if(avail < hdr + len) break;

      const mOff = off + hdr - 4, pOff = off + hdr;
      if(len > 0){
        WS_MASK[0]=B[mOff]; WS_MASK[1]=B[mOff+1]; WS_MASK[2]=B[mOff+2]; WS_MASK[3]=B[mOff+3];
        for(let i=0;i<len;i++) B[pOff+i] ^= WS_MASK[i & 3];
      }
      off += hdr + len;
      if(!this._frame(fin, op, B, pOff, len)) return;
    }
    if(off > 0){
      if(off < this.rlen) this.rbuf.copy(this.rbuf, 0, off, this.rlen);
      this.rlen -= off;
    }
  }

  _frame(fin, op, B, pOff, len){
    /* Управляющие кадры: не фрагментируются и не длиннее 125 байт. */
    if(op >= 0x8){
      if(!fin || len > 125){ this.close(1002, 'bad control frame'); return false; }
      if(op === 0x8){
        let code = 1000;
        if(len >= 2){
          code = B.readUInt16BE(pOff);
          // 1005/1006 по RFC в сеть не отправляют; 0..999 и >4999 — мусор
          if(code === 1005 || code === 1006 || code < 1000 || code > 4999) code = 1002;
        }
        this._closeFrame(code === 1002 ? 1002 : 1000, '');
        this.closing = true;
        try { this.sock.end(); } catch(e){}
        this._armKill();
        return false;
      }
      if(op === 0x9){ this._send(0x0A, B, pOff, len); return true; }   // ping -> pong тем же телом
      if(op === 0x0A){ this.lastPong = Date.now(); return true; }
      this.close(1002, 'bad opcode'); return false;
    }

    if(op === 0x1 || op === 0x2){
      if(this.fragOp){ this.close(1002, 'interleaved fragment'); return false; }
      if(fin){ this._deliver(op, B, pOff, len); return !this.dead && !this.closing; }
      if(len > WS_MAXMSG){ this.close(1009, 'message too big'); return false; }
      this.fragOp = op;
      this.fragParts = [ SRV_copy(B, pOff, len) ];
      this.fragLen = len;
      return true;
    }
    if(op === 0x0){
      if(!this.fragOp){ this.close(1002, 'continuation without start'); return false; }
      this.fragLen += len;
      if(this.fragLen > WS_MAXMSG){ this.close(1009, 'message too big'); return false; }
      this.fragParts.push(SRV_copy(B, pOff, len));
      if(fin){
        const all = Buffer.concat(this.fragParts, this.fragLen);
        const o = this.fragOp;
        this.fragOp = 0; this.fragParts = null; this.fragLen = 0;
        this._deliver(o, all, 0, all.length);
        return !this.dead && !this.closing;
      }
      return true;
    }
    this.close(1002, 'bad opcode'); return false;
  }

  _deliver(op, B, pOff, len){
    if(op !== 0x1) return;                 // двоичных кадров в протоколе нет — молча роняем
    if(len > WS_MAXJSON){
      SRV_log('сообщение', len, 'байт — слишком велико, игнор');
      return;
    }
    let s;
    try { s = B.toString('utf8', pOff, pOff + len); } catch(e){ return; }
    if(this.onmessage) this.onmessage(s);
  }

  /* ---------- отправка ---------- */
  send(str){
    if(this.dead || this.closing) return;
    const p = Buffer.from(str, 'utf8');
    this._send(0x1, p, 0, p.length);
  }

  /* Серверные кадры уходят БЕЗ маски (RFC 6455 §5.1). Заголовок и тело
     склеиваем в один буфер: две записи в сокет дают лишний TCP-сегмент. */
  _send(op, src, sOff, n){
    if(this.dead) return;
    let hl = 2;
    if(n >= 65536) hl = 10; else if(n >= 126) hl = 4;
    const out = Buffer.allocUnsafe(hl + n);
    out[0] = 0x80 | op;
    if(hl === 2) out[1] = n;
    else if(hl === 4){ out[1] = 126; out.writeUInt16BE(n, 2); }
    else { out[1] = 127; out.writeUInt32BE(0, 2); out.writeUInt32BE(n >>> 0, 6); }
    if(n > 0) src.copy(out, hl, sOff, sOff + n);
    try{
      this.sock.write(out);
      /* Клиент, который не разгребает снапшоты, не имеет права съесть память
         сервера: очередь выросла — соединение прекращаем. */
      if(this.sock.writableLength > WS_MAXOUT) this.close(1009, 'slow client');
    }catch(e){ this.destroy('запись в сокет'); }
  }

  _closeFrame(code, reason){
    const r = Buffer.from(String(reason || ''), 'utf8');
    const n = Math.min(r.length, 123);
    const p = Buffer.allocUnsafe(2 + n);
    p.writeUInt16BE(code, 0);
    if(n) r.copy(p, 2, 0, n);
    this._send(0x8, p, 0, p.length);
  }

  close(code, reason){
    if(this.dead || this.closing) return;
    this.closing = true;
    this._closeFrame(code || 1000, reason || '');
    try { this.sock.end(); } catch(e){}
    this._armKill();
    if(reason) SRV_log('разрыв (' + code + '):', reason, this.p ? ('· ' + this.p.name) : '');
  }

  /* Клиент может не ответить на close — добиваем сокет по таймеру. */
  _armKill(){
    if(this.killT) return;
    this.killT = setTimeout(() => this.destroy('close timeout'), 1000);
    if(this.killT.unref) this.killT.unref();
  }

  destroy(why){
    if(this.dead) return;
    this.dead = true;
    if(this.killT){ clearTimeout(this.killT); this.killT = null; }
    this.rbuf = null; this.fragParts = null;
    try { this.sock.destroy(); } catch(e){}
    if(this.onclose) { const f = this.onclose; this.onclose = null; f(why); }
  }
}

function SRV_copy(B, off, len){
  const b = Buffer.allocUnsafe(len);
  if(len) B.copy(b, 0, off, off + len);
  return b;
}

/* ====================== СОСТОЯНИЕ КОМНАТЫ ====================== */
const SRV_players = new Map();     // id -> игрок
const SRV_conns   = new Set();     // все живые соединения, включая безымянные
let   SRV_nextId  = 1;
let   SRV_hostId  = -1;
const SRV_score   = [0, 0];        // 0 = BLU, 1 = RED
const SRV_picks   = new Map();     // индекс пикапа -> {at, by}
let   SRV_bots    = [];            // последний кадр ботов от хоста
let   SRV_botsAt  = 0;             // когда он пришёл: несвежий кадр рассылать нельзя
let   SRV_overAt  = 0;             // когда сбрасывать счёт после достижения цели
let   SRV_pingAt  = 0;

function SRV_botCount(){ return Math.max(0, RULES.slots - SRV_players.size); }

function SRV_status(){
  const ps = [];
  for(const p of SRV_players.values())
    ps.push({ id:p.id, name:p.name, team:p.team?'RED':'BLU', wpn:WEAPONS[p.w].id,
              hp:Math.round(p.hp), alive:p.alive, kills:p.kills, deaths:p.deaths,
              ping:p.ping, rejects:p.rejTotal });
  return { ver:VER, up:Math.round(SRV_now()/1000), rules:RULES,
           blu:SRV_score[0], red:SRV_score[1], host:SRV_hostId,
           bots:SRV_botCount(), players:ps };
}

/* ---------- рассылка ---------- */
function SRV_sendTo(p, obj){ p.c.send(JSON.stringify(obj)); }
function SRV_bcast(obj, exceptId){
  const s = JSON.stringify(obj);
  for(const p of SRV_players.values()) if(p.id !== exceptId) p.c.send(s);
}

/* ---------- лог отклонённых заявок ---------- */
/* Каждая отклонённая заявка обязана быть видна в консоли, но рассинхрон умеет
   сыпать сотнями одинаковых заявок в секунду. Поэтому глушим только ПОВТОР
   того же вида нарушения, и то со счётчиком: новый вид печатается всегда,
   а накопленное «скрыто» досчитывается и выводится в SRV_tick. */
function SRV_rejKind(why){ return why.substr(0, 12); }
function SRV_rejFlush(p){
  if(!p.rejSkip) return;
  SRV_log('ОТКЛОНЕНО [' + p.id + ' ' + p.name + ']: ещё ' + p.rejSkip + ' × «' + p.rejKind + '…»');
  p.rejSkip = 0;
}
function SRV_reject(p, why){
  p.rejTotal++;
  const now = SRV_now();
  const kind = SRV_rejKind(why);
  if(kind === p.rejKind && now - p.rejLogAt < 500){
    p.rejSkip++;
  } else {
    SRV_rejFlush(p);
    SRV_log('ОТКЛОНЕНО [' + p.id + ' ' + p.name + ']: ' + why);
    p.rejKind = kind; p.rejLogAt = now;
  }

  if(now - p.rejWinAt > REJ_WIN){ p.rejWinAt = now; p.rejWin = 0; }
  if(++p.rejWin > REJ_MAX){
    SRV_rejFlush(p);
    SRV_sendTo(p, { t:'err', m:'СЛИШКОМ МНОГО ОТКЛОНЁННЫХ ЗАЯВОК — РАССИНХРОН ИЛИ ВЕРСИЯ НЕ ТА' });
    p.c.close(4003, 'too many rejects');
  }
}

/* ====================== ПОДКЛЮЧЕНИЕ ====================== */
function SRV_attach(c){
  SRV_conns.add(c);
  c.onmessage = s => SRV_text(c, s);
  c.onclose   = why => SRV_gone(c, why);
  /* Соединение без hello — не игрок. Даём 10 секунд и закрываем: иначе
     любой сканер портов будет держать слоты. */
  c.helloT = setTimeout(() => { if(!c.p) c.close(4001, 'no hello'); }, 10000);
  if(c.helloT.unref) c.helloT.unref();
}

function SRV_gone(c, why){
  SRV_conns.delete(c);
  if(c.helloT){ clearTimeout(c.helloT); c.helloT = null; }
  const p = c.p;
  if(!p) return;
  c.p = null;
  SRV_rejFlush(p);
  SRV_players.delete(p.id);
  SRV_log('ушёл [' + p.id + '] ' + p.name + ' (' + why + ') · в комнате ' + SRV_players.size);
  SRV_bcast({ t:'leave', id:p.id });
  SRV_elect();
  SRV_sendScore();
}

function SRV_hello(c, m){
  if(c.helloT){ clearTimeout(c.helloT); c.helloT = null; }
  if(SRV_players.size >= RULES.players){
    SRV_log('отказ: комната заполнена (' + RULES.players + ')');
    c.send(JSON.stringify({ t:'err', m:'КОМНАТА ЗАПОЛНЕНА: ' + RULES.players + ' ИГРОКОВ' }));
    c.close(4002, 'room full');
    return;
  }
  const name = SRV_clean(m.name, 16) || ('СНАЙПЕР-' + SRV_nextId);

  /* Команды делим поровну; при равенстве новичок идёт в BLU. */
  let blu = 0, red = 0;
  for(const q of SRV_players.values()) (q.team ? red++ : blu++);
  const team = (blu <= red) ? 0 : 1;

  const p = {
    id: SRV_nextId++, c: c, name: name, team: team,
    hp: 100, alive: true, kills: 0, deaths: 0,
    x:0, y:0, z:0, yaw:0, pitch:0, h:1.8, f:0, s:0,
    /* Ствол: 0 винтовка, 1 лук. По нему выбирается ВСЯ таблица боеприпасов,
       поэтому поле обязано быть у игрока с первой же секунды, ещё до боя.
       wAt — когда ствол меняли в последний раз (см. SRV_onHello2). */
    w: SRV_w(m.w), wAt: -1e9,
    lastMsg: SRV_now(), ping: 0, pingSent: 0,
    respawnAt: 0,
    burnLeft: 0, burnAcc: 0, burnBy: -1, burnDps: RIFLE_AMMO[2].burnDps,
    shotAt: [-1e9, -1e9, -1e9],
    shots: [], shotN: 0,
    /* Самоурон: по ведру на причину (frag/burn/fall), см. SELF_CAUSE. */
    selfBank: [0, 0, 0], selfAt: [0, 0, 0],
    bhitN: 0, bhitAt: -1e9,       // счётчик заявок об уроне ботам на один выстрел
    rejTotal: 0, rejLogAt: -1e9, rejSkip: 0, rejKind: '', rejWin: 0, rejWinAt: 0
  };
  /* Кольцо последних выстрелов: по нему проверяется, что заявленное попадание
     вообще опирается на выстрел и лежит примерно вдоль его луча. */
  for(let i=0;i<8;i++) p.shots.push({ t:-1e9, a:0, ox:0, oy:0, oz:0, dx:0, dy:0, dz:0 });

  c.p = p;
  SRV_players.set(p.id, p);
  const sp = SRV_pickSpawn(p);
  p.x = sp.x; p.y = sp.y; p.z = sp.z;

  SRV_elect();

  const list = [];
  for(const q of SRV_players.values())
    list.push({ id:q.id, name:q.name, team:q.team, hp:Math.round(q.hp),
                alive:q.alive, kills:q.kills, deaths:q.deaths, w:q.w });

  SRV_sendTo(p, {
    t:'welcome', id:p.id, team:p.team, k:SRV_now(), goal:RULES.goal,
    slots:SRV_botCount(),          // свободные слоты = сколько ботов держит комната
    respawn:RULES.respawn,         // секунды: клиент не имеет права дублировать константу
    host:SRV_hostId, players:list
  });
  SRV_bcast({ t:'join', id:p.id, name:p.name, team:p.team, w:p.w }, p.id);
  /* Стартовую точку рассылаем ВСЕМ, КРОМЕ новичка: он ещё в лобби, боя не
     начинал, и применить respawn ему некуда — координаты уедут в физику
     вхолостую. Свою точку он получит первым же resp после старта. */
  SRV_bcast({ t:'resp', i:p.id, x:p.x, y:p.y, z:p.z }, p.id);

  /* Версию чистим так же, как имя: это чужая строка, а она уходит в текст
     ошибки и в лог, где управляющие символы ломают вывод. */
  if(typeof m.ver === 'string'){
    const ver = SRV_clean(m.ver, 16);
    if(ver && ver !== VER){
      SRV_log('внимание: у [' + p.id + '] ' + p.name + ' версия «' + ver + '», у сервера «' + VER + '»');
      SRV_sendTo(p, { t:'err', m:'ВЕРСИЯ КЛИЕНТА ' + ver + ' ≠ СЕРВЕРА ' + VER + ' — ВОЗМОЖЕН РАССИНХРОН' });
    }
  }
  SRV_log('вошёл [' + p.id + '] ' + p.name + ' · ' + (team ? 'RED' : 'BLU') +
          ' · ' + WEAPONS[p.w].id + ' · в комнате ' + SRV_players.size + ', ботов ' + SRV_botCount());
  SRV_sendScore();
}

/* Хост ботов — игрок с наименьшим id; ушёл — переизбираем. */
function SRV_elect(){
  let best = -1;
  for(const p of SRV_players.values()) if(best < 0 || p.id < best) best = p.id;
  if(best === SRV_hostId) return;
  SRV_hostId = best;
  SRV_bots.length = 0;              // прежний хост больше ботов не шлёт
  if(best >= 0){
    SRV_bcast({ t:'host', i:best });
    SRV_log('хост ботов теперь [' + best + ']');
  } else SRV_log('комната пуста');
}

/* ====================== ПРИЁМ СООБЩЕНИЙ ====================== */
function SRV_text(c, s){
  let m;
  try { m = JSON.parse(s); }
  catch(e){
    if(c.p) SRV_reject(c.p, 'битый JSON (' + s.length + ' Б)');
    else SRV_log('битый JSON от безымянного соединения, ' + s.length + ' Б');
    return;
  }
  if(!m || typeof m !== 'object' || typeof m.t !== 'string') return;

  if(!c.p){ if(m.t === 'hello') SRV_hello(c, m); return; }   // до hello слушаем только hello
  const p = c.p;
  p.lastMsg = SRV_now();
  const h = SRV_H[m.t];
  if(h) h(p, m);            // неизвестный тип — молча игнорируем, это точка роста протокола
}

/* ---------- своё состояние ---------- */
function SRV_onMove(p, m){
  const s = m.s | 0;
  // TCP порядок не рвёт, но клиент может перезапуститься и сбросить счётчик
  if(s < p.s && p.s - s < 4096) return;
  if(!SRV_num(m.x) || !SRV_num(m.y) || !SRV_num(m.z)) return;
  if(Math.abs(m.x) > 400 || Math.abs(m.z) > 400 || m.y < -200 || m.y > 400) return;
  /* Счётчик двигаем ТОЛЬКО после всех проверок (§9.5): иначе один битый пакет
     съедает номер, и следующий за ним честный отбрасывается как «старый» —
     игрок замирает на месте на пустом месте. */
  p.s = s;
  p.x = m.x; p.y = m.y; p.z = m.z;
  if(SRV_num(m.yaw))   p.yaw   = m.yaw;
  if(SRV_num(m.pitch)) p.pitch = m.pitch;
  if(SRV_num(m.h))     p.h     = SRV_clamp(m.h, 0.4, 2.6);
  p.f = (m.f | 0) & 255;
}

/* ---------- выстрел ---------- */
/* Минимальный интервал между выстрелами ОДНОГО типа.

   Винтовка: темп ограничен и откатом типа, и затвором — что больше, то и правит.

   Лук: затвора в этом смысле у него нет. Чтобы выстрелить снова, лучник
   накладывает стрелу (bolt) и только потом тянет тетиву (drawTime; тянуть
   раньше, чем стрела легла, оружие не даёт). Значит минимум складывается из
   наложения и того натяга, который стрелок ЗАЯВИЛ сам полем c: полный натяг
   стоит всё положенное время, слабый — меньше.

   Нижнего порога у натяга сознательно НЕТ. Срыв — законный выстрел: тетива
   уходит из пальцев почти сразу, стрела падает под ноги и почти не бьёт, но
   это игрок, а не читер. Заложи мы «минимальный осмысленный натяг», и такая
   стрельба отклонялась бы как невозможная, хотя оружие её разрешает. */
function SRV_minInterval(p, a, chg){
  const W = WEAPONS[p.w], A = W.ammo[a];
  if(!W.bow) return Math.max(A.cd, A.bolt);
  const c = SRV_num(chg) ? SRV_clamp(chg, 0, 1) : 0;
  return Math.max(A.cd, A.bolt + W.drawTime * c);
}
function SRV_onShot(p, m){
  const now = SRV_now();
  if(!p.alive){ SRV_reject(p, 'выстрел мёртвого'); return; }
  const a = m.a | 0;
  const A = SRV_ammo(p, a);
  if(!A){ SRV_reject(p, 'неизвестный боеприпас ' + SRV_clean(m.a, 8)); return; }
  if(!SRV_num(m.ox) || !SRV_num(m.oy) || !SRV_num(m.oz) ||
     !SRV_num(m.dx) || !SRV_num(m.dy) || !SRV_num(m.dz)){
    SRV_reject(p, 'нечисловой выстрел'); return;
  }
  const need = SRV_minInterval(p, a, m.c) * 1000 * V_RATE;
  const gap  = now - p.shotAt[a];
  if(gap < need){
    SRV_reject(p, 'темп ' + A.id + ': ' + Math.round(gap) + ' мс при минимуме ' + Math.round(need));
    return;
  }
  const ex = m.ox - p.x, ey = m.oy - p.y, ez = m.oz - p.z;
  if(ex*ex + ey*ey + ez*ez > V_MUZZLE){
    SRV_reject(p, 'ствол в ' + Math.round(Math.sqrt(ex*ex+ey*ey+ez*ez)) + ' м от заявленной позиции');
    return;
  }
  const L = Math.sqrt(m.dx*m.dx + m.dy*m.dy + m.dz*m.dz);
  if(!(L > 1e-4)){ SRV_reject(p, 'нулевое направление выстрела'); return; }

  p.shotAt[a] = now;
  const r = p.shots[(p.shotN++) & 7];
  r.t = now; r.a = a;
  r.ox = m.ox; r.oy = m.oy; r.oz = m.oz;
  r.dx = m.dx/L; r.dy = m.dy/L; r.dz = m.dz/L;

  /* Ретрансляция: трассер и звук чужого выстрела остальные рисуют сами. */
  SRV_bcast({ t:'shot', i:p.id, a:a, ox:SRV_r2(m.ox), oy:SRV_r2(m.oy), oz:SRV_r2(m.oz),
              dx:SRV_r4(r.dx), dy:SRV_r4(r.dy), dz:SRV_r4(r.dz),
              c:SRV_num(m.c) ? SRV_r2(SRV_clamp(m.c,0,1)) : 0 }, p.id);
}

/* Ищем выстрел, на который опирается заявка: тот же тип, свежий, и цель
   лежит примерно вдоль луча. Допуск «мимо луча» растёт с дистанцией — на
   двадцати метрах 200 мс лага цели это уже пять градусов. */
function SRV_matchShot(p, a, tx, ty, tz){
  const now = SRV_now();
  let best = null, bestOff = 1e9;
  for(let i=0;i<8;i++){
    const r = p.shots[i];
    if(r.a !== a || now - r.t > V_HITWIN || r.t <= 0) continue;
    const vx = tx - r.ox, vy = ty - r.oy, vz = tz - r.oz;
    const t = vx*r.dx + vy*r.dy + vz*r.dz;
    if(t < -1.5) continue;                       // цель позади ствола
    const px = vx - r.dx*t, py = vy - r.dy*t, pz = vz - r.dz*t;
    const off = Math.sqrt(px*px + py*py + pz*pz);
    const allow = V_LATERAL0 + V_LATERALK * Math.max(t, 0);
    if(off <= allow && off < bestOff){ bestOff = off; best = r; }
  }
  return best;
}

/* ---------- заявка на попадание ---------- */
function SRV_onHit(p, m){
  /* Проверки, общие для игрока и бота, идут ПЕРВЫМИ (§9.5). Раньше ветка
     «урон боту» стояла до всего, и заявка от мёртвого с уроном 9000 не
     считалась отклонением вообще — просто уезжала хосту. */
  if(!p.alive){ SRV_reject(p, 'попадание от мёртвого'); return; }
  const a = m.a | 0;
  /* Таблица — ТОГО ствола, которым заявитель стреляет: стрела и пуля с одним
     индексом бьют по-разному, и потолок обязан быть от своей строки. */
  const A = SRV_ammo(p, a);
  if(!A){ SRV_reject(p, 'неизвестный боеприпас ' + SRV_clean(m.a, 8)); return; }
  const d = SRV_num(m.d) ? m.d : -1;
  if(!(d > 0)){ SRV_reject(p, 'нечисловой урон'); return; }

  /* splash приходит от накрытия своим же фугасом — у него свой потолок;
     всё остальное считаем прямым попаданием в корпус. */
  /* 'burn' — заявка о поджоге бота от не-хоста: она приходит одной суммой
     за всё время горения, поэтому потолок у неё свой, а не как у удара. */
  const part = (m.p === 'head' || m.p === 'legs' || m.p === 'splash' || m.p === 'burn') ? m.p : 'body';
  const cap  = (part === 'head'   ? A.headMax :
                part === 'splash' ? (A.splashMax || A.dmgMax) :
                part === 'burn'   ? ((A.burnTime*A.burnDps) || A.dmgMax) :
                A.dmgMax) * V_DMG_TOL;
  if(d > cap){
    SRV_reject(p, 'урон ' + Math.round(d) + ' > потолка ' + Math.round(cap) + ' для ' + A.id + '/' + part);
    return;
  }

  /* Урон боту считает стрелявший клиент, применяет хост — мы курьер, но
     курьер с проверками: жив, боеприпас известен, потолок не пробит, и
     заявка опирается на реальный выстрел. Луч не сверяем: позиции ботов у
     нас чужие, свежие только у хоста, и строгость тут стоила бы честных
     попаданий. */
  if(typeof m.v === 'string' && m.v.charAt(0) === 'b'){
    /* Пересылаем чужую строку хосту, поэтому форму проверяем: 'b12', и не
       двести килобайт, которые мы честно переправим ему в сокет. */
    if(!/^b\d{1,3}$/.test(m.v)){ SRV_reject(p, 'бот ' + SRV_clean(m.v, 8) + ' не индекс'); return; }
    const now = SRV_now();
    if(now - p.shotAt[a] > V_HITWIN){
      SRV_reject(p, 'урон боту без выстрела ' + A.id); return;
    }
    /* Темп: одна очередь = один выстрел. Фугас накрывает нескольких сразу,
       поэтому считаем заявки на выстрел, а не на секунду. */
    if(p.bhitAt !== p.shotAt[a]){ p.bhitAt = p.shotAt[a]; p.bhitN = 0; }
    if(++p.bhitN > BOT_HITS){
      SRV_reject(p, 'заявок об уроне ботам больше ' + BOT_HITS + ' на один выстрел'); return;
    }
    const h = SRV_players.get(SRV_hostId);
    if(h && h.id !== p.id)
      SRV_sendTo(h, { t:'hit', i:p.id, v:m.v, p:part, d:d, a:a });
    return;
  }

  const v = SRV_players.get(m.v | 0);
  if(!v){ SRV_reject(p, 'жертва ' + SRV_clean(m.v, 8) + ' не в комнате'); return; }
  if(v.id === p.id){ SRV_reject(p, 'попадание в себя'); return; }
  if(!v.alive){ SRV_reject(p, 'попадание в мёртвого [' + v.id + ']'); return; }
  if(v.team === p.team){ SRV_reject(p, 'огонь по своим [' + v.id + ']'); return; }

  const dx = v.x - p.x, dy = v.y - p.y, dz = v.z - p.z;
  const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
  if(dist > V_RANGE){ SRV_reject(p, 'дистанция ' + Math.round(dist) + ' м'); return; }

  const cy = v.y + v.h * 0.5;
  if(!SRV_matchShot(p, a, v.x, cy, v.z)){
    SRV_reject(p, 'попадание без подходящего выстрела ' + A.id + ' (' + Math.round(dist) + ' м)');
    return;
  }
  SRV_damage(v, d, p.id, part);
}

/* ---------- фугас ---------- */
function SRV_onBoom(p, m){
  if(!SRV_num(m.x) || !SRV_num(m.y) || !SRV_num(m.z)) return;
  const a = m.a | 0;
  /* Радиус и потолок площади — из таблицы стрелка: взрывная стрела рвёт слабее
     фугаса и в меньшем круге. */
  const A = SRV_ammo(p, a);
  if(!A) return;
  /* Ретрансляцию эффекта тоже держим за проверками: иначе чужой экран можно
     засыпать взрывами, ничего не стреляя. Луч при этом не сверяем — эффект
     важнее строгости, а урон ниже проверяется отдельно. */
  if(!p.alive){ SRV_reject(p, 'фугас от мёртвого'); return; }
  const ex = m.x - p.x, ey = m.y - p.y, ez = m.z - p.z;
  if(ex*ex + ey*ey + ez*ez > V_RANGE*V_RANGE){ SRV_reject(p, 'эпицентр за пределами карты'); return; }
  SRV_bcast({ t:'boom', x:SRV_r2(m.x), y:SRV_r2(m.y), z:SRV_r2(m.z), a:a }, p.id);

  const R = A.splashR;
  if(!R) return;                               // не фугас — только эффект
  if(!SRV_matchShot(p, a, m.x, m.y, m.z)){ SRV_reject(p, 'фугас без выстрела'); return; }

  const h = m.h;
  if(!Array.isArray(h)) return;
  const n = Math.min(h.length, RULES.slots);
  const cap = A.splashMax * V_DMG_TOL;
  const lim = R * 1.25;                        // накрытие считал клиент по своим позициям — даём запас
  for(let i=0;i<n;i++){
    const e = h[i];
    if(!e || typeof e !== 'object') continue;
    const v = SRV_players.get(e.v | 0);
    if(!v || !v.alive || v.team === p.team) continue;
    const d = SRV_num(e.d) ? e.d : 0;
    if(!(d > 0)) continue;
    if(d > cap){ SRV_reject(p, 'фугасный урон ' + Math.round(d) + ' > ' + Math.round(cap)); continue; }
    const vx = v.x - m.x, vy = (v.y + v.h*0.5) - m.y, vz = v.z - m.z;
    const dd = Math.sqrt(vx*vx + vy*vy + vz*vz);
    if(dd > lim){ SRV_reject(p, 'накрытие [' + v.id + '] на ' + Math.round(dd) + ' м при R ' + R); continue; }
    SRV_damage(v, d, p.id, 'splash');
  }
}

/* ---------- поджог ---------- */
function SRV_onBurn(p, m){
  if(!p.alive){ SRV_reject(p, 'поджог от мёртвого'); return; }
  const v = SRV_players.get(m.v | 0);
  if(!v || !v.alive || v.team === p.team || v.id === p.id) return;
  const d = SRV_num(m.d) ? m.d : 0;
  if(!(d > 0)) return;
  /* Запас горения — из таблицы ПОДЖЁГШЕГО: у зажигательного патрона и у
     огненной стрелы он свой, и мерить чужой заявкой нельзя. */
  const total = SRV_burnTotal(p.w);
  if(d > total * V_DMG_TOL){
    SRV_reject(p, 'горение ' + Math.round(d) + ' > запаса ' + Math.round(total)); return;
  }
  /* Горение не перезаписывается, а складывается — как и на клиенте. Темп
     списания запоминаем от поджёгшего: гореть жертва обязана с той скоростью,
     с какой её подожгли, а не с какой она сама носит оружие. */
  v.burnLeft = Math.min(v.burnLeft + d, BURN_MAX * 2);
  v.burnDps = WEAPONS[p.w].ammo[2].burnDps;
  v.burnBy = p.id;
}

/* ---------- пикапы ---------- */
/* §9.2: лечение авторитетное. Клиент прячет предмет сразу (иначе подбор
   ощущается вязким) и ждёт ответа; hp накладывается только если by === его id.
   Мы решаем три вещи: свободен ли предмет, стоял ли заявитель рядом и сколько
   здоровья он получил. */
function SRV_onPick(p, m){
  const i = m.i | 0;
  const it = (i >= 0 && i < PICKS.length) ? PICKS[i] : null;
  if(!it){ SRV_reject(p, 'пикап ' + i + ' вне таблицы'); return; }
  if(!p.alive){ SRV_reject(p, 'пикап мёртвого'); return; }

  const dx = p.x - it.x, dz = p.z - it.z;
  if(dx*dx + dz*dz > V_PICK2 || Math.abs(it.y - p.y) > V_PICKY){
    SRV_reject(p, 'пикап ' + i + ' в ' + Math.round(Math.sqrt(dx*dx+dz*dz)) + ' м от заявителя');
    return;
  }

  const now = SRV_now();
  const cur = SRV_picks.get(i);
  if(cur && now < cur.at){
    /* Опоздал: возвращаем предмет ровно тем же сообщением — клиент увидит
       чужой by и вернёт его себе на карту. hp тут не шлём: лечится только
       тот, кому предмет достался, а ему уже ушла своя рассылка. */
    SRV_sendTo(p, { t:'pick', i:i, by:cur.by, at:cur.at });
    return;
  }

  /* Откат берём по типу предмета — те же числа, что в MAP_pu(): комната
     обязана возвращать аптечку тогда же, когда её вернёт одиночная игра. */
  const at = now + it.cd * 1000;
  SRV_picks.set(i, { at:at, by:p.id });
  if(it.heal > 0 && p.hp < 100){
    p.hp = Math.min(100, p.hp + it.heal);
    /* Аптечка сбивает пламя — ровно как в 75_combat.js: лечиться, продолжая
       гореть, бессмысленно, а горение у нас списывает сервер. */
    if(p.burnLeft > 0){
      p.burnLeft = Math.max(0, p.burnLeft - it.heal*0.8);
      if(p.burnLeft <= 0) p.burnAcc = 0;
    }
  }
  SRV_bcast({ t:'pick', i:i, by:p.id, at:at, hp:Math.max(0, Math.round(p.hp)) });
}

/* ---------- самоурон ---------- */
/* §9.1: клиент не имеет права трогать своё hp даже от собственного фугаса.
   Он присылает заявку, а величину и темп решаем мы. */
function SRV_onSelf(p, m){
  if(!p.alive) return;                 // умер до того, как долетела заявка — не нарушение
  const c = SELF_CAUSE[p.w][m.c];      // таблица без прототипа: '__proto__' сюда не пролезет
  if(!c){ SRV_reject(p, 'самоурон с причиной ' + SRV_clean(m.c, 12)); return; }
  let d = SRV_num(m.d) ? m.d : 0;
  if(!(d > 0)) return;

  const now = SRV_now(), i = c.i;
  /* Протекающее ведро: разрешённый урон вытекает со скоростью c.dps, поэтому
     сто заявок подряд дадут не больше, чем одна честная. */
  p.selfBank[i] = Math.max(0, p.selfBank[i] - c.dps * (now - p.selfAt[i]) / 1000);
  p.selfAt[i] = now;
  if(d > c.max){
    SRV_reject(p, 'самоурон ' + Math.round(d) + ' > потолка ' + Math.round(c.max) + ' для ' + c.n);
    d = c.max;
  }
  const room = c.max - p.selfBank[i];
  if(room <= 0.05){ SRV_reject(p, 'темп самоурона ' + c.n); return; }
  if(d > room) d = room;
  p.selfBank[i] += d;
  SRV_damage(p, d, -1, c.n);           // from = -1; смерть от него — kill с k = -1
}

/* ---------- боты ---------- */
const SRV_botPool = [];
function SRV_onBots(p, m){
  if(p.id !== SRV_hostId){ SRV_reject(p, 'bots не от хоста'); return; }
  const b = m.b;
  if(!Array.isArray(b)) return;
  const n = Math.min(b.length, RULES.slots);
  SRV_bots.length = 0;
  for(let i=0;i<n;i++){
    const s = b[i];
    if(!s || typeof s !== 'object') continue;
    let d = SRV_botPool[i];
    if(!d) d = SRV_botPool[i] = { i:0, x:0, y:0, z:0, yaw:0, pitch:0, h:0, st:0, a:1 };
    if(!SRV_num(s.x) || !SRV_num(s.y) || !SRV_num(s.z)) continue;
    d.i = s.i | 0;
    d.x = SRV_r2(s.x); d.y = SRV_r2(s.y); d.z = SRV_r2(s.z);
    d.yaw   = SRV_num(s.yaw)   ? SRV_r4(s.yaw)   : 0;
    d.pitch = SRV_num(s.pitch) ? SRV_r4(s.pitch) : 0;
    d.h     = SRV_num(s.h)     ? SRV_r2(s.h)     : 1.8;
    d.st    = s.st | 0;
    d.a     = s.a ? 1 : 0;
    SRV_bots.push(d);
  }
  SRV_botsAt = SRV_now();      // отметка свежести: кадр протухает за BOTS_TTL
}

/* Урон игроку от бота заявляет хост: боты живут у него. */
function SRV_onBotHit(p, m){
  if(p.id !== SRV_hostId){ SRV_reject(p, 'bhit не от хоста'); return; }
  const v = SRV_players.get(m.v | 0);
  if(!v || !v.alive) return;
  const d = SRV_num(m.d) ? m.d : 0;
  if(!(d > 0)) return;
  if(d > BOT_MAX_DMG){ SRV_reject(p, 'урон бота ' + Math.round(d) + ' > ' + BOT_MAX_DMG); return; }
  const part = (m.p === 'head' || m.p === 'legs') ? m.p : 'body';
  SRV_damage(v, d, -1, part);
}

/* ---------- прочее ---------- */
/* Второй 'hello' сессию не пересоздаёт: имя, команда и id у игрока уже есть.
   А вот СТВОЛ он меняет — и это единственная причина, по которой повторный
   hello вообще осмыслен. Ствол выбирают в брифинге, то есть УЖЕ ПОСЛЕ входа
   в комнату, и сервер обязан узнать о выборе до первого выстрела: иначе он
   проверит заявки лучника по винтовочной таблице и отклонит честные. */
function SRV_onHello2(p, m){
  if(m.w === undefined) return;
  const w = SRV_w(m.w);
  if(w === p.w) return;
  /* Ствол принимаем ВСЕГДА и без условий: если наша таблица разойдётся с той,
     из которой клиент считает урон, отклонены будут честные заявки. */
  p.w = w;
  /* А вот отметки прошлых выстрелов — вопрос отдельный. Сменилась вся таблица,
     и держать в них чужие затворы значит отклонить первый честный выстрел
     нового ствола. Но обнулять их на каждый чих нельзя: «hello туда — hello
     обратно» стало бы способом стрелять вообще без темпа. Поэтому обнуляем не
     чаще раза в WPN_SWAP: смена оружия — это выход в брифинг, а не приём боя. */
  const now = SRV_now();
  if(now - p.wAt >= WPN_SWAP) p.shotAt[0] = p.shotAt[1] = p.shotAt[2] = -1e9;
  p.wAt = now;
  SRV_log('ствол [' + p.id + '] ' + p.name + ' → ' + WEAPONS[w].id);
}

function SRV_onResp(p){
  if(p.alive) return;
  if(SRV_now() < p.respawnAt) return;       // рано: время смерти ведёт сервер
  SRV_respawn(p);
}
function SRV_onPong(p, m){
  if(!SRV_num(m.k)) return;
  const dt = SRV_now() - m.k;
  if(dt >= 0 && dt < 60000) p.ping = Math.round(dt);
}

/* Таблица обработчиков — БЕЗ ПРОТОТИПА (§9.5). Ключом служит m.t, то есть
   строка из сети: у обычного литерала «__proto__», «constructor», «valueOf»
   и «toString» вернули бы кусок Object.prototype, и диспетчер либо вызвал бы
   чужую функцию, либо упал на не-функции и порвал соединение. */
const SRV_H = Object.create(null);
SRV_H.move  = SRV_onMove;
SRV_H.shot  = SRV_onShot;
SRV_H.hit   = SRV_onHit;
SRV_H.boom  = SRV_onBoom;
SRV_H.burn  = SRV_onBurn;
SRV_H.self  = SRV_onSelf;
SRV_H.pick  = SRV_onPick;
SRV_H.bots  = SRV_onBots;
SRV_H.bhit  = SRV_onBotHit;
SRV_H.resp  = SRV_onResp;
SRV_H.pong  = SRV_onPong;
SRV_H.hello = SRV_onHello2;               // второй hello — не повод ломать сессию

/* ====================== АВТОРИТЕТ: УРОН, СМЕРТЬ, РЕСПАВН ====================== */
function SRV_damage(v, dmg, byId, part){
  if(!v.alive || !(dmg > 0)) return;
  v.hp -= dmg;
  const hp = Math.max(0, Math.round(v.hp));
  SRV_sendTo(v, { t:'dmg', from:byId, d:Math.round(dmg), hp:hp, p:part });
  if(v.hp > 0) return;

  v.hp = 0; v.alive = false; v.deaths++;
  v.burnLeft = 0; v.burnAcc = 0;
  v.respawnAt = SRV_now() + RULES.respawn * 1000;

  const k = SRV_players.get(byId);
  if(k && k.id !== v.id && k.team !== v.team){
    k.kills++;
    SRV_score[k.team]++;
  }
  SRV_bcast({ t:'kill', v:v.id, k:(k && k.id !== v.id) ? k.id : -1, p:part });
  SRV_log('убит [' + v.id + '] ' + v.name + ' ← ' +
          (k ? '[' + k.id + '] ' + k.name : 'бот/огонь') + ' · ' + part +
          ' · счёт BLU ' + SRV_score[0] + ' : RED ' + SRV_score[1]);
  SRV_sendScore();

  if(!SRV_overAt && (SRV_score[0] >= RULES.goal || SRV_score[1] >= RULES.goal)){
    SRV_overAt = SRV_now() + ROUND_HOLD;
    SRV_log('ЦЕЛЬ ' + RULES.goal + ' ВЗЯТА: ' + (SRV_score[0] >= RULES.goal ? 'BLU' : 'RED') +
            ' · счёт обнулится через ' + (ROUND_HOLD/1000) + ' с');
  }
}

function SRV_sendScore(){
  const s = [];
  for(const p of SRV_players.values()) s.push({ i:p.id, k:p.kills, d:p.deaths });
  SRV_bcast({ t:'score', blu:SRV_score[0], red:SRV_score[1], s:s });
}

/* Появляться в упор под чужой прицел — лотерея, а не бой: берём точку,
   максимально удалённую от живых противников. */
function SRV_pickSpawn(p){
  const list = SPAWNS[p.team] || SPAWNS[0];
  let best = list[0], bs = -1e9;
  for(let i=0;i<list.length;i++){
    const s = list[i];
    let score = Math.random() * 4;
    for(const q of SRV_players.values()){
      if(q.id === p.id || !q.alive || q.team === p.team) continue;
      const dx = q.x - s.x, dz = q.z - s.z;
      score += Math.sqrt(dx*dx + dz*dz);
    }
    if(score > bs){ bs = score; best = s; }
  }
  return best;
}

function SRV_respawn(p){
  const s = SRV_pickSpawn(p);
  p.alive = true; p.hp = 100;
  p.burnLeft = 0; p.burnAcc = 0; p.burnBy = -1;
  p.respawnAt = 0;
  p.x = s.x; p.y = s.y; p.z = s.z;
  p.shotAt[0] = p.shotAt[1] = p.shotAt[2] = -1e9;
  // вёдра самоурона гасим вместе с жизнью: прошлое падение не должно
  // съедать лимит у нового
  p.selfBank[0] = p.selfBank[1] = p.selfBank[2] = 0;
  SRV_bcast({ t:'resp', i:p.id, x:s.x, y:s.y, z:s.z });
}

/* ====================== ТИК: СНАПШОТ, ГОРЕНИЕ, ТАЙМАУТЫ ====================== */
/* Снапшот собирается в переиспользуемые объекты и сериализуется ОДИН раз на
   всю комнату: свой id клиент знает и просто пропускает собственную запись. */
const SRV_snap = { t:'snap', k:0, p:[], b:null };
const SRV_snapPool = [];
function SRV_entry(i){
  let e = SRV_snapPool[i];
  /* tm — команда (§9.5). Без неё клиент, впервые увидевший игрока в снапшоте
     (join потерялся или пришёл позже), молча зачисляет его в BLU: свой цвет,
     свой — значит непростреливаемый. */
  if(!e) e = SRV_snapPool[i] = { i:0, tm:0, w:0, x:0, y:0, z:0, yaw:0, pitch:0, h:0, f:0, hp:0, a:1 };
  return e;
}

const SRV_DT = 1 / RULES.tick;
function SRV_tick(){
  const now = SRV_now();

  /* --- горение: сервер списывает его сам, иначе поджёгший решал бы, когда
         жертва умрёт. Урон отправляем порциями, а не 20 раз в секунду, —
         клиенту на каждое сообщение прилетает вспышка и тряска. --- */
  for(const p of SRV_players.values()){
    if(!p.alive || p.burnLeft <= 0) continue;
    const step = Math.min(p.burnDps * SRV_DT, p.burnLeft);
    p.burnLeft -= step;
    p.burnAcc  += step;
    if(p.burnAcc >= 4 || p.burnLeft <= 0 || p.hp - p.burnAcc <= 0){
      const d = p.burnAcc; p.burnAcc = 0;
      SRV_damage(p, d, p.burnBy, 'burn');
    }
  }

  /* --- респавн: клиент просит через resp, но и молчащего мы поднимем сами --- */
  for(const p of SRV_players.values()){
    if(!p.alive && p.respawnAt && now >= p.respawnAt + 2000) SRV_respawn(p);
  }

  /* --- сброс счёта после взятия цели: комната живёт дальше --- */
  if(SRV_overAt && now >= SRV_overAt){
    SRV_overAt = 0;
    SRV_score[0] = SRV_score[1] = 0;
    for(const p of SRV_players.values()){ p.kills = 0; p.deaths = 0; SRV_respawn(p); }
    SRV_sendScore();
    SRV_log('новый раунд: счёт обнулён');
  }

  /* --- пинг и таймауты --- */
  if(now - SRV_pingAt >= 2000){
    SRV_pingAt = now;
    /* rtt (§9.5) у каждого свой, поэтому и сериализуем каждому своё: раз в две
       секунды это четыре строки, а клиенту не приходится оценивать то, что мы
       и так измерили в pong. */
    for(const p of SRV_players.values()){
      SRV_sendTo(p, { t:'ping', k:now, rtt:p.ping });
      SRV_rejFlush(p);
    }
  }
  for(const p of SRV_players.values()){
    if(now - p.lastMsg > RULES.timeout){
      SRV_log('таймаут [' + p.id + '] ' + p.name + ': молчит ' + Math.round((now - p.lastMsg)/1000) + ' с');
      p.c.close(4004, 'timeout');
    }
  }

  /* --- кадр ботов протухает (§9.5): хост ушёл или замолчал — боты обязаны
         исчезнуть, а не стоять неподвижными мишенями сколько угодно долго --- */
  if(SRV_bots.length && now - SRV_botsAt > BOTS_TTL){
    SRV_bots.length = 0;
    SRV_log('кадр ботов протух (' + BOTS_TTL + ' мс без bots) — комната без ботов');
  }

  if(SRV_players.size === 0) return;

  /* --- снапшот --- */
  SRV_snap.k = now;
  const arr = SRV_snap.p;
  arr.length = 0;
  let n = 0;
  for(const p of SRV_players.values()){
    const e = SRV_entry(n++);
    /* w — ствол бойца (§9.6). Без него остальные покажут лучника с винтовкой
       в руках, а стрелок с луком выглядит и звучит иначе, чем снайпер. */
    e.i = p.id; e.tm = p.team; e.w = p.w;
    e.x = SRV_r2(p.x); e.y = SRV_r2(p.y); e.z = SRV_r2(p.z);
    e.yaw = SRV_r4(p.yaw); e.pitch = SRV_r4(p.pitch);
    e.h = SRV_r2(p.h); e.f = p.f;
    e.hp = Math.max(0, Math.round(p.hp));
    e.a = p.alive ? 1 : 0;
    arr.push(e);
  }
  SRV_snap.b = SRV_bots.length ? SRV_bots : null;
  const s = JSON.stringify(SRV_snap);
  for(const p of SRV_players.values()) p.c.send(s);
}

/* ====================== ПОДЪЁМ СЕРВЕРА ====================== */
function SRV_port(){
  const a = process.argv;
  for(let i=2;i<a.length;i++){
    if(a[i] === '--port' && a[i+1]){ const v = parseInt(a[i+1], 10); if(v > 0 && v < 65536) return v; }
    const m = /^--port=(\d+)$/.exec(a[i]);
    if(m){ const v = parseInt(m[1], 10); if(v > 0 && v < 65536) return v; }
  }
  const e = parseInt(process.env.PORT, 10);
  if(e > 0 && e < 65536) return e;
  return 8177;
}
const PORT = SRV_port();

const server = http.createServer(SRV_httpReq);

/* Мусор до заголовков не должен ронять процесс. */
server.on('clientError', (err, sock) => { try { sock.destroy(); } catch(e){} });

server.on('upgrade', (req, sock, head) => {
  try{
    const key = req.headers['sec-websocket-key'];
    const up  = String(req.headers['upgrade'] || '').toLowerCase();
    const ver = String(req.headers['sec-websocket-version'] || '');
    if(up !== 'websocket' || !key || ver !== '13'){
      sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    if(SRV_conns.size >= MAXCONN){
      sock.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    /* Рукопожатие RFC 6455 §4.2.2: accept = base64(sha1(key + GUID)).
       Расширения (permessage-deflate) не подтверждаем — значит их нет,
       и RSV-биты во входящих кадрах обязаны быть нулевыми. */
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\n' +
               'Upgrade: websocket\r\n' +
               'Connection: Upgrade\r\n' +
               'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const c = new WSConn(sock);
    SRV_attach(c);
    if(head && head.length) c.onData(head);      // остаток уже пришедших байт
  }catch(e){
    SRV_log('upgrade:', e && e.message);
    try { sock.destroy(); } catch(_){}
  }
});

/* Последний рубеж. Всё, что приходит по сети, обёрнуто в try/catch и в разрыв
   одного соединения; этот обработчик — страховка от того, чего мы не учли:
   комната из четверых не должна разваливаться из-за одного кривого пакета. */
process.on('uncaughtException', e => {
  SRV_log('НЕПЕРЕХВАЧЕННОЕ ИСКЛЮЧЕНИЕ (сервер продолжает работу):', e && e.stack || e);
});
process.on('unhandledRejection', e => {
  SRV_log('НЕОБРАБОТАННЫЙ REJECT:', e && e.stack || e);
});

server.on('error', e => {
  if(e && e.code === 'EADDRINUSE'){
    console.error('\n  Порт ' + PORT + ' занят. Запусти с другим: node net/server.js --port 8178\n');
    process.exit(1);
  }
  SRV_log('сервер:', e && e.message);
});

server.listen(PORT, () => {
  const L = [];
  const ifs = os.networkInterfaces();
  for(const name of Object.keys(ifs)){
    for(const a of ifs[name] || []){
      if(a.family !== 'IPv4' && a.family !== 4) continue;
      if(a.internal) continue;
      L.push({ name:name, addr:a.address });
    }
  }
  console.log('');
  console.log('  DM_DUEL v3 · сервер комнаты');
  console.log('  ────────────────────────────────────────────────');
  console.log('  игроков до ' + RULES.players + ', слотов ' + RULES.slots +
              ' (остальное — боты), до ' + RULES.goal + ' убийств, тик ' + RULES.tick + ' Гц');
  console.log('');
  console.log('  на этой машине:');
  console.log('    http://localhost:' + PORT + '/');
  if(L.length){
    console.log('');
    console.log('  друзьям в локальной сети:');
    for(const it of L) console.log('    http://' + it.addr + ':' + PORT + '/    (' + it.name + ')');
  } else {
    console.log('');
    console.log('  сетевых интерфейсов не видно — только локальный доступ');
  }
  console.log('');
  console.log('  через интернет — туннелем (адрес из туннеля вставляется в поле сервера):');
  console.log('    cloudflared tunnel --url http://localhost:' + PORT);
  console.log('    ngrok http ' + PORT);
  console.log('');
  console.log('  состояние комнаты: http://localhost:' + PORT + '/__status');
  console.log('  остановить: Ctrl+C');
  console.log('');
});

/* unref сознательно НЕ зовём: тик — это и есть жизнь комнаты. */
const SRV_timer = setInterval(SRV_tick, Math.round(1000 / RULES.tick));

process.on('SIGINT', () => {
  SRV_log('останов');
  for(const c of SRV_conns) { try { c.close(1001, 'server shutdown'); } catch(e){} }
  clearInterval(SRV_timer);
  setTimeout(() => process.exit(0), 200).unref();
  try { server.close(); } catch(e){}
});
