/* =====================================================================
   N2 · СЕТЬ: транспорт и протокол (клиентская сторона).

   Здесь живёт весь разговор с сервером и ничего больше: модели чужих
   игроков ведёт 94_netplayers.js, экраны и табло — 96_netui.js.

   Модель авторитета (NETCONTRACT §1) диктует, кто что шлёт:
     · своё движение мы просто транслируем 20 Гц — сервер его не проверяет;
     · попадания заявляем МЫ (бьём по тому, что видим на экране), поэтому
       все report*() — это именно заявки, а не применение урона;
     · здоровье, счёт, респавн и пикапы приходят сверху и применяются как есть.

   Стволов теперь два, и это протокольный факт, а не косметика (§9.6):
   сервер проверяет урон и темп по таблице ТОГО оружия, которым заявитель
   стреляет, а таблицы у винтовки и лука разные. Поэтому свой ствол мы
   объявляем в 'hello' и переобъявляем при смене, а чужой читаем из записи
   снапшота и кладём в NET.players[id].w — оттуда его берут и модель реплики,
   и потолок урона по боту, который применяет хост.

   В одиночной игре NET.on === false, и тогда весь модуль — набор пустых
   вызовов: каждый публичный метод выходит первой же строкой.
   ===================================================================== */

/* ------------------------------ КОНСТАНТЫ ------------------------------ */
const NT_VER      = 'v3';     // версия протокола в hello; сервер сверяет её со своей
const NT_PORT     = 8177;     // порт по умолчанию, если страницу открыли файлом
const NT_TICK     = 0.05;     // 20 Гц: и своё состояние, и реплики ботов
const NT_DIAL_MS  = 10000;    // столько ждём welcome, дальше — «сервер не отвечает»
const NT_SILENCE  = 12000;    // тишина сервера дольше этого = связь мертва
const NT_MSG_MAX  = 90;       // жёсткий потолок исходящих сообщений в секунду
const NT_MSG_SOFT = 34;       // из них на «заявки» (shot/hit/boom/burn/pick)

/* Флаги состояния — NETCONTRACT §4. Их читает 94_netplayers.js, чтобы
   поставить реплику в ту же позу, в какой игрок был у себя на экране. */
const NT_F_CROUCH = 1;
const NT_F_SLIDE  = 2;
const NT_F_CLIMB  = 4;
const NT_F_ZIP    = 8;
const NT_F_SCOPE  = 16;
const NT_F_DASH   = 32;
const NT_F_GROUND = 64;
const NT_F_MANTLE = 128;

/* Коды состояний бота для пакета 'bots'. Таблица общая: NETP получает её
   через NET.BOT_ST и не обязан угадывать порядок. */
const NT_BOT_ST = ['hold','settle','move','aim','shot','suppress','retreat','regroup','climb'];
const NT_BOT_CODE = {};
for(let i=0;i<NT_BOT_ST.length;i++) NT_BOT_CODE[NT_BOT_ST[i]] = i;

/* ------------------------- ВНУТРЕННЕЕ СОСТОЯНИЕ ------------------------- */
let NT_ws     = null;         // текущий сокет (или null)
let NT_gen    = 0;            // поколение подключения: колбэки старого сокета молчат
let NT_dialT  = 0;            // таймер ожидания welcome
let NT_resolve = null, NT_reject = null;
let NT_lastRx = 0;            // performance.now() последнего пакета от сервера
let NT_slots  = 8;            // сколько мест в комнате (из welcome)
let NT_ended  = false;        // итоги матча уже показаны

let NT_acc    = 0;            // накопитель тика отправки
let NT_seq    = 0;            // счётчик пакетов move
let NT_respAcc = 9;           // сколько прошло с прошлой заявки на респавн
/* Ствол, о котором сервер УЖЕ знает (−1 — ещё не говорили). Выбор оружия
   живёт в брифинге, то есть случается ПОСЛЕ hello, а сервер по нему выбирает
   всю таблицу боеприпасов. Значит расхождение обязано жить не дольше кадра. */
let NT_myW    = -1;

/* Кредиты заявок — защита от флуда «снизу», по смыслу игры (см. §6.6):
   попадание нельзя заявить, не выстрелив; площадь — не выстрелив фугасом. */
let NT_cShot = 0, NT_cSplash = 0, NT_cBoom = 0;
let NT_burnAt = -1e9, NT_pickAt = -1e9;

/* Самоурон (NETCONTRACT §9.1). Здоровьем владеет сервер, поэтому свой фугас
   под ногами, падение и горение — это заявки, а не списание hp.
   Горение тикает КАЖДЫЙ кадр по доле единицы: слать по пакету на кадр значит
   съесть весь бюджет отправки и получить шестьдесят вспышек урона в секунду.
   Поэтому копим по причинам и отдаём порциями. Накопленное не теряется:
   из слота вычитается ровно то, что ушло в пакет, и только после успешной
   отправки — не пролезло в бюджет, значит копим дальше. */
const NT_SELF_C   = ['frag','burn','fall'];
const NT_SELF_MS  = 250;      // мс: не реже, чем раз в столько, если что-то накопилось
const NT_SELF_MIN = 60;       // мс: но и не чаще — даже для мгновенных причин
const NT_selfAcc = new Float64Array(3);
const NT_selfAt  = new Float64Array(3);
NT_selfAt.fill(-1e9);

/* Бюджет исходящих: второй, тупой рубеж — на случай ошибки в кредитах. */
let NT_secAt = 0, NT_secN = 0, NT_secClaim = 0;

/* Свои вектора: ничего не аллоцируем ни в кадре, ни на приёме снапшота. */
const NT_v1 = new THREE.Vector3();
const NT_v2 = new THREE.Vector3();
const NT_v3 = new THREE.Vector3();

/* Переиспользуемые исходящие сообщения: JSON.stringify всё равно создаст
   строку, но плодить ещё и объекты 20 раз в секунду незачем. */
const NT_mMove = { t:'move', s:0, x:0, y:0, z:0, yaw:0, pitch:0, h:0, f:0 };
const NT_mShot = { t:'shot', a:0, ox:0, oy:0, oz:0, dx:0, dy:0, dz:0, c:0 };
const NT_mHit  = { t:'hit',  v:0, p:'body', d:0, a:0 };
const NT_mBoom = { t:'boom', x:0, y:0, z:0, a:1, h:[] };
const NT_mBots = { t:'bots', b:[] };
const NT_mSelf = { t:'self', d:0, c:'burn' };
const NT_boomPool = [];       // {v,d} для списка задетых
const NT_botPool  = [];       // {i,x,y,z,yaw,pitch,h,st,a}

/* ======================= ЧАСЫ: ОЦЕНКА ВРЕМЕНИ СЕРВЕРА =======================

   Зачем вообще: NETP рисует чужих с задержкой 120 мс и интерполирует между
   снапшотами по их серверным меткам. Значит клиенту нужна своя шкала того же
   времени, и главное её качество — не точность, а ГЛАДКОСТЬ: скачок оценки
   на 30 мс мгновенно виден как рывок всех чужих моделей разом.

   Как считаем. Каждое сообщение с меткой k (welcome, snap, ping) даёт
   наблюдение

       o = k − performance.now() = смещение_часов − задержка_доставки.

   Задержка неизвестна и всегда положительна, поэтому o — это смещение
   ЗАНИЖЕННОЕ на величину доставки. Но у пакета, которому повезло меньше
   всех застрять, задержка минимальна, а значит max(o) по окну — наилучшая
   доступная оценка. Берём максимум по скользящему окну в 8 секунд
   (восемь посекундных корзин): окно нужно, чтобы одна аномально быстрая
   доставка не «залипла» навсегда, пока часы расходятся дальше.

   Систематическое занижение на минимальную одностороннюю задержку здесь не
   вредит, а помогает: пакеты и так приходят к нам с этой задержкой, и NET.now()
   должно идти по шкале «время сервера, каким мы его уже успели узнать».
   Иначе буфер интерполяции 120 мс всё время оказывался бы на пинг короче.

   Дальше — не прыгаем к цели, а ПОДВОДИМ часы скоростью не больше 80 мс/с
   (NET.now() при этом остаётся строго возрастающей, ведь локальные часы идут
   на порядок быстрее правки). Мгновенно переставляем только при расхождении
   больше 300 мс: это не дрейф, а новая сессия или сон вкладки.

   Побочный продукт — «избыток» задержки текущего пакета над лучшим в окне.
   По нему оцениваем пинг, когда сервер не сообщает измеренный им rtt. */
const NT_CK_N = 8;
const NT_ckMax = new Float64Array(NT_CK_N);
const NT_ckSec = new Float64Array(NT_CK_N);
let NT_ckReady = false;
let NT_off = 0, NT_offTarget = 0, NT_exc = 0;
let NT_rtt = -1;                       // измеренный круговой ход, мс (−1 — нет данных)
let NT_pingSm = 0, NT_pingShown = -1;
NT_ckSec.fill(-1);

function NT_ckReset(){
  NT_ckSec.fill(-1);
  NT_ckReady = false; NT_off = 0; NT_offTarget = 0; NT_exc = 0;
  NT_rtt = -1; NT_pingSm = 0; NT_pingShown = -1;
}

function NT_clock(k){
  if(!(k > 0)) return;
  const L = performance.now();
  const o = k - L;
  const sec = Math.floor(L/1000);
  const i = ((sec % NT_CK_N) + NT_CK_N) % NT_CK_N;
  if(NT_ckSec[i] !== sec){ NT_ckSec[i] = sec; NT_ckMax[i] = o; }
  else if(o > NT_ckMax[i]) NT_ckMax[i] = o;

  let best = -Infinity;
  const oldest = sec - (NT_CK_N - 1);
  for(let j=0;j<NT_CK_N;j++) if(NT_ckSec[j] >= oldest && NT_ckMax[j] > best) best = NT_ckMax[j];
  if(best === -Infinity) return;
  NT_offTarget = best;
  // насколько этот пакет опоздал против лучшего в окне
  const exc = best - o;
  NT_exc += ((exc > 0 ? exc : 0) - NT_exc)*0.12;
  if(!NT_ckReady){ NT_ckReady = true; NT_off = best; }
}

/* ------------------------------ УТИЛИТЫ ------------------------------ */
/* Округление до миллиметра и тысячной радиана: на 20 Гц это заметно режет
   размер кадра, а разницы ни в попаданиях, ни в картинке нет. */
function NT_q(v){ return Math.round(v*1000)/1000; }
function NT_q1(v){ return Math.round(v*10)/10; }

/* Имена приходят от других клиентов, а киллфид вставляет их в разметку как HTML.
   Чистим ОДИН раз, на входе: дальше по коду об этом уже не думаем.
   Управляющие символы убираем заодно — они ломают вёрстку строки. */
const NT_DIRTY = /[\u0000-\u001F\u007F<>&"'`\\]/g;
function NT_nick(s){
  const t = ((typeof s === 'string') ? s : '').replace(NT_DIRTY, '').trim().slice(0, 16);
  return t || 'БОЕЦ';
}
/* То же для служебных строк (адрес, причина закрытия): их печатает интерфейс. */
function NT_txt(s){
  return ((typeof s === 'string') ? s : String(s)).replace(NT_DIRTY, '').slice(0, 72);
}

/* Модуль интерфейса пишет другой агент и может отсутствовать в сборке —
   тогда сообщения уходят в консоль, а игра продолжает работать. */
function NT_msg(text, kind){
  if(typeof netUIMessage === 'function'){ try{ netUIMessage(text, kind || 'info'); return; }catch(e){} }
  if(kind === 'error') console.error('[СЕТЬ] ' + text); else console.log('[СЕТЬ] ' + text);
}
function NT_uiState(s){ if(typeof netUISetState === 'function'){ try{ netUISetState(s); }catch(e){} } }
function NT_uiPlayers(){ if(typeof netUIPlayers === 'function'){ try{ netUIPlayers(); }catch(e){} } }
function NT_uiPing(ms){ if(typeof netUIPing === 'function'){ try{ netUIPing(ms); }catch(e){} } }

function NT_hasNETP(){
  return (typeof NETP !== 'undefined') && NETP && typeof NETP.applySnap === 'function';
}
function NT_netp(){ return NT_hasNETP() ? NETP : null; }

/* Адрес: принимаем и «ws://host:port», и «host:port», и пустую строку. */
function NT_dst(url){
  let u = (typeof url === 'string') ? url.trim() : '';
  if(!u) return NET.defaultUrl();
  if(/^https:\/\//i.test(u)) return 'wss://' + u.slice(8);
  if(/^http:\/\//i.test(u))  return 'ws://'  + u.slice(7);
  if(/^wss?:\/\//i.test(u))  return u;
  return ((location.protocol === 'https:') ? 'wss://' : 'ws://') + u;
}

/* Кто в какой команде: 0 — BLU, 1 — RED (тот же порядок, что у PAL). */
function NT_teamCls(t){ return (t|0) === 1 ? 'r' : 'b'; }

/* Флаги позы — NETCONTRACT §4. Читаем ровно те поля, которые ведут A и C. */
function NT_flags(){
  let f = 0;
  if(player.crouching)   f |= NT_F_CROUCH;
  if(player.slideT  > 0) f |= NT_F_SLIDE;
  if(player.climb)       f |= NT_F_CLIMB;
  if(player.zip)         f |= NT_F_ZIP;
  if(wpn.sT > 0.5)       f |= NT_F_SCOPE;
  if(player.dashT   > 0) f |= NT_F_DASH;
  if(player.grounded)    f |= NT_F_GROUND;
  if(player.mantleT > 0) f |= NT_F_MANTLE;
  return f;
}

/* Центр корпуса чужого игрока для расчёта накрытия.
   Приоритет — та точка, которую игрок ВИДИТ у себя на экране (интерполяция
   NETP с задержкой 120 мс): заявка стрелка обязана совпадать с картинкой, по
   которой он целился, иначе фугас «мажет» по тому, что уже уехало.
   Сырой снапшот — запасной вариант, если реплики ещё нет. */
function NT_center(p, out){
  let h = (p.h > 0) ? p.h : CFG.height;
  const NP = NT_netp();
  if(NP){
    // отрисованное состояние реплики: у NETP оно лежит в E.v
    const E = (typeof NP.get === 'function') ? NP.get(p.id) : null;
    const v = E && E.v;
    if(v && v.alive && isFinite(v.y)){
      if(v.h > 0) h = v.h;
      return out.set(v.x, v.y + h*0.55, v.z);
    }
    if(typeof NP.posOf === 'function' && NP.posOf(p.id, out)){ out.y += h*0.55; return out; }
  }
  const e = p.ent;
  if(e && e.position && isFinite(e.position.y)){
    out.copy(e.position); out.y += h*0.55; return out;
  }
  return out.set(p.x, p.y + h*0.55, p.z);
}

/* Огонь по своим сервер отклоняет, а отклонённые заявки копятся до
   отключения. Значит союзника надо отсеивать здесь, а не надеяться на отказ. */
function NT_foe(id){
  const p = NET.players.get(id);
  return !p || p.team !== NET.team;
}

/* Ствол в протоколе — число 0/1 (§9.6). Мусор и отсутствие поля разводим:
   −1 значит «не сказали», и тогда прежнее значение трогать нельзя. */
function NT_wOf(rec){
  if(!rec || rec.w === undefined || rec.w === null) return -1;
  return ((rec.w | 0) === 1) ? 1 : 0;
}
/* Таблица боеприпасов ТОГО, КТО СТРЕЛЯЛ. Своя AMMO здесь не годится: у лука
   и винтовки под одним индексом лежат разные строки, и чужую заявку (урон
   боту у хоста) или чужой трассер надо мерить его оружием, а не своим. */
function NT_ammoOf(id, ai){
  const p = NET.players.get(id);
  const w = p ? (p.w | 0) : -1;
  const list = (w === 0 || w === 1) ? WPNS[w].ammo : AMMO;
  const i = (ai | 0) % list.length;
  return list[i < 0 ? 0 : i] || list[0];
}

/* Модель чужого бойца ведёт 94_netplayers.js — ствол в ней рисует его агент,
   наше дело доставить факт. Зовём его метод, если он есть; если сборка ещё
   без него, ствол всё равно лежит в NET.players[id].w (его кладёт вызывающий)
   и в userData реплики — оттуда его прочтёт любая реализация, а лишнее поле
   в userData никому не мешает. Молчим при любой ошибке: картинка не повод
   ронять сеть. */
function NT_netpW(id, w){
  if(id === NET.id) return;
  const NP = NT_netp();
  if(!NP) return;
  try{
    if(typeof NP.setWeapon === 'function'){ NP.setWeapon(id, w); return; }
    if(typeof NP.weapon === 'function'){ NP.weapon(id, w); return; }
    const E = (typeof NP.get === 'function') ? NP.get(id) : null;
    if(!E) return;
    E.w = w;
    const m = E.v && E.v.m;
    if(m && m.userData) m.userData.wpn = w;
  }catch(e){}
}

/* Индекс боеприпаса ЗАЯВКИ (§9.3). Он приходит от пули, а не из wpn.idx:
   пояс переключается мгновенно, а пуля летит до полусекунды, и сервер ищет
   под заявку тот самый выстрел. Здесь только защита от мусора: если индекс не
   передали вовсе (сборка со старым вызывающим модулем), для накрытия он
   выводится однозначно — площадь бывает только у фугаса. */
function NT_ammo(a, splash){
  const i = a|0;
  if(typeof a === 'number' && isFinite(a) && i >= 0 && i <= 2) return i;
  return splash ? 1 : 0;
}

/* Причина самоурона -> слот накопителя. Порядок — NT_SELF_C. */
function NT_selfIdx(cause){
  if(cause === 'burn') return 1;
  if(cause === 'fall') return 2;
  return 0;                              // всё прочее — прямой урон своим фугасом
}
/* Потолок ОДНОЙ порции по причине. Сервер ограничивает самоурон за тик, и
   заявка сверх потолка не просто обрезается — она идёт в счёт отклонённых, а
   их сотня подряд рвёт соединение. Числа берём не с потолка, а из тех же
   AMMO, из которых их выводит и сервер:
     горение — треть секунды тика (реальный темп — burnDps в секунду, так что
               порция всегда уходит быстрее, чем набегает новая);
     фугас   — больше splashMax своя же граната не даст физически;
     падение — сразу насмерть, потолок здесь только от мусора в вызове. */
function NT_selfCap(i){
  if(i === 1) return AMMO[2].burnDps*0.35;
  if(i === 2) return 100;
  return AMMO[1].splashMax;
}
/* Отдать накопленный самоурон. force — для мгновенных причин (фугас, падение):
   там задержка в четверть секунды означает опоздавшую на четверть секунды
   смерть, и это видно. Горение уходит порциями: как только набралась целая
   порция или истёк NT_SELF_MS. Остаток всегда остаётся в накопителе. */
function NT_selfFlush(now, force){
  for(let i=0;i<3;i++){
    const d = NT_selfAcc[i];
    if(!(d > 0)) continue;
    const gap = now - NT_selfAt[i];
    if(gap < NT_SELF_MIN) continue;                  // не частим даже по срочным
    const cap = NT_selfCap(i);
    if(!force && d < cap && gap < NT_SELF_MS) continue;
    const q = NT_q1((d > cap) ? cap : d);
    if(!(q > 0)) continue;               // меньше 0.05 HP: не шлём, но и не теряем
    NT_mSelf.d = q; NT_mSelf.c = NT_SELF_C[i];
    if(!NET.send(NT_mSelf)) continue;    // бюджет исчерпан — остаток копится дальше
    NT_selfAcc[i] = (d > q) ? (d - q) : 0;
    NT_selfAt[i] = now;
  }
}

/* Запасная точка возрождения — только на случай битых координат от сервера
   (§9.5). База СВОЕЙ команды: появиться в чужом тылу хуже, чем не появиться. */
function NT_spawnFallback(out){
  const list = (NET.team === 1 && SPAWNS_RED && SPAWNS_RED.length) ? SPAWNS_RED : SPAWNS_BLU;
  const s = (list && list.length) ? pick(list) : null;
  if(!s) return out.set(player.pos.x, player.pos.y, player.pos.z);
  return out.set(s.x, s.y, s.z);
}

/* Согласовать состояние пикапа с сервером. Предмет мы прячем оптимистично ещё
   в момент касания (иначе подбор ощущается вязким), а сервер называет точное
   время возврата. left <= 0 значит «предмет уже должен лежать на карте» —
   сами его не оживляем, обнуляем таймер и отдаём это updatePickups():
   там же вспышка, звон и «выскакивание», дублировать их незачем. */
function NT_pickHide(p, left){
  p.alive = false;
  if(p.mesh) p.mesh.visible = false;
  p.cmbGlow = 0;
  p.t = (left > 0) ? left : 0;
}

/* Пул слотов для списков — чтобы 'boom' и 'bots' не мусорили объектами. */
function NT_boomSlot(i){
  let s = NT_boomPool[i];
  if(!s){ s = { v:0, d:0 }; NT_boomPool[i] = s; }
  return s;
}
function NT_botSlot(i){
  let s = NT_botPool[i];
  if(!s){ s = { i:0, x:0, y:0, z:0, yaw:0, pitch:0, h:0, st:0, a:1 }; NT_botPool[i] = s; }
  return s;
}

/* --------------------------- УЧЁТ ИГРОКОВ --------------------------- */
function NT_ensure(id, name, team, rec){
  let p = NET.players.get(id);
  if(!p){
    const w0 = NT_wOf(rec);
    p = { id:id, name:NT_nick(name), team:team|0,
          hp:100, alive:true, kills:0, deaths:0,
          /* Ствол бойца: 0 винтовка, 1 лук (§9.6). Пока не сказали — винтовка:
             ошибка в эту сторону всего лишь рисует не ту модель, а вот
             отсутствие поля пришлось бы проверять во всех читателях. */
          w:(w0 < 0) ? 0 : w0,
          buf:[], ent:null,                       // буфер и модель наполняет NETP
          x:0, y:0, z:0, yaw:0, pitch:0, h:CFG.height, f:0 };
    NET.players.set(id, p);
    const NP = NT_netp();
    /* Четвёртым аргументом отдаём ствол: сборка без его поддержки лишний
       аргумент просто не заметит, а с поддержкой — соберёт сразу нужную
       модель, без пересборки на первом же снапшоте. */
    if(NP && id !== NET.id){ NP.ensure(id, p.team, p.name, p.w); NT_netpW(id, p.w); }
  } else {
    if(name !== undefined && name !== null) p.name = NT_nick(name);
    /* Команду сервер может уточнить позже (запись snap несёт tm, §9.5), и это
       не косметика: по команде решается, можно ли вообще заявить попадание.
       Реплике смена команды тоже важна — у неё цвет и метка. */
    if(team !== undefined && team !== null){
      const t = team|0;
      if(t !== p.team){
        p.team = t;
        const NP = NT_netp();
        // модель пересобирается под цвет команды — ствол ей назовём заново
        if(NP && id !== NET.id){ NP.ensure(id, t, p.name, p.w); NT_netpW(id, p.w); }
      }
    }
    /* Смена ствола посреди сессии — это новый матч у того клиента: он вышел
       в брифинг и выбрал другое оружие. Реплике об этом надо сказать. */
    const w1 = NT_wOf(rec);
    if(w1 >= 0 && w1 !== p.w){ p.w = w1; NT_netpW(id, w1); }
  }
  if(rec){
    if(typeof rec.hp === 'number') p.hp = rec.hp;
    if(rec.alive !== undefined) p.alive = !!rec.alive;
    if(typeof rec.kills === 'number') p.kills = rec.kills;
    if(typeof rec.deaths === 'number') p.deaths = rec.deaths;
  }
  return p;
}
/* Свободные слоты комнаты добивают боты — их и создаст startGame().
   Сервер шлёт число ботов только в welcome (поле slots), а join/leave его
   не повторяют. Поэтому из welcome восстанавливаем ПОЛНЫЙ размер комнаты
   (боты + люди) и дальше считаем сами тем же правилом, что и сервер.

   Пересматривать обязательно на каждом join/leave (§9.5): иначе после входа
   четвёртого игрока у одного клиента в бою пять ботов, у другого три, и
   снапшоты хоста ссылаются на индексы, которых у остальных нет. О смене
   состава игру надо предупредить — сама она число не перечитывает. */
function NT_recount(){
  const was = NET.botCount;
  NET.botCount = Math.max(0, NT_slots - NET.players.size);
  if(NET.botCount === was) return;
  NET.botsDirty = true;
  /* Хук необязателен: 90_game.js может его и не объявлять (а объявить через
     const — тогда до его строки обращение по имени бросает). Обе беды ловит
     один try. */
  try{ if(typeof netBotsChanged === 'function') netBotsChanged(NET.botCount); }catch(e){}
}

/* --------------------------- БЮДЖЕТ ОТПРАВКИ --------------------------- */
/* Своё состояние, ответ на ping и заявка на респавн уходят всегда: без них
   сервер решит, что мы отвалились. Всё остальное живёт в мягкой квоте. */
function NT_critical(t){
  return t === 'move' || t === 'pong' || t === 'hello' || t === 'bots' || t === 'resp';
}
function NT_budget(crit){
  const t = performance.now();
  if(t - NT_secAt >= 1000){ NT_secAt = t; NT_secN = 0; NT_secClaim = 0; }
  if(NT_secN >= NT_MSG_MAX) return false;
  if(!crit && NT_secClaim >= NT_MSG_SOFT) return false;
  NT_secN++;
  if(!crit) NT_secClaim++;
  return true;
}

/* ------------------------ ОБРЫВ И СБРОС СОСТОЯНИЯ ------------------------ */
function NT_dropSocket(){
  const ws = NT_ws;
  NT_ws = null;
  if(!ws) return;
  ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
  try{ if(ws.readyState === 0 || ws.readyState === 1) ws.close(1000, 'bye'); }catch(e){}
}
function NT_clearState(){
  const NP = NT_netp();
  if(NP && typeof NP.reset === 'function'){ try{ NP.reset(); }catch(e){} }
  NET.players.clear();
  NET.id = -1; NET.team = 0; NET.host = false; NET.hostId = -1; NET.ping = 0; NET.botCount = 0;
  NET.score.blu = 0; NET.score.red = 0;
  NET.respawnTime = 3.0; NET.botsDirty = false;
  NT_ended = false;
  NT_acc = 0; NT_seq = 0; NT_respAcc = 9;
  NT_cShot = 0; NT_cSplash = 0; NT_cBoom = 0;
  NT_myW = -1;                  // новому серверу свой ствол называем заново
  NT_secN = 0; NT_secClaim = 0;
  NT_selfAcc.fill(0); NT_selfAt.fill(-1e9);
  NT_ckReset();
}
/* Связь оборвалась посреди боя. Игру не роняем: NET.on = false возвращает
   всё в одиночный режим (боты снова оживают локально), но бой обязан встать
   на паузу — иначе игрок узнает о разрыве, уже умерев. */
function NT_lost(reason){
  if(!NT_ws && NET.on !== true) return;
  NT_dropSocket();
  const was = NET.on;
  NET.on = false;
  NT_clearState();
  NT_msg(reason, 'error');
  NT_uiState('error');
  if(was && typeof pauseGame === 'function' && game.state === 'play') pauseGame();
}
/* Завершение попытки подключения: ровно один раз на поколение. */
function NT_settle(ok, arg){
  const res = NT_resolve, rej = NT_reject;
  NT_resolve = null; NT_reject = null;
  if(NT_dialT){ clearTimeout(NT_dialT); NT_dialT = 0; }
  if(ok){ if(res) res(arg); }
  else if(rej) rej(arg);
}

/* ============================== ПРИЁМ ============================== */
function NT_onMessage(ev){
  let m;
  try{ m = JSON.parse(ev.data); }catch(e){ return; }
  if(!m || typeof m !== 'object') return;
  NT_lastRx = performance.now();
  const NP = NT_netp();

  switch(m.t){

  case 'welcome': {
    NET.id   = m.id|0;
    NET.team = m.team|0;
    NET.goal = (m.goal > 0) ? (m.goal|0) : CFG.killGoal;
    // slots в welcome — это СВОБОДНЫЕ слоты, то есть боты. Полный размер
    // комнаты собираем сами: боты + те, кто уже внутри.
    const humans = Array.isArray(m.players) ? m.players.length : 1;
    NT_slots = ((m.slots|0) > 0 || m.slots === 0) ? ((m.slots|0) + humans) : NT_slots;
    if(NT_slots < humans) NT_slots = humans;
    if(NT_slots > 32) NT_slots = 32;
    // host в welcome может быть и флагом, и id назначенного хоста
    NET.hostId = (typeof m.host === 'number') ? (m.host|0) : -1;
    NET.host = (typeof m.host === 'boolean') ? m.host : (m.host === NET.id);
    /* Время возрождения назначает сервер (§9.5) — константу RULES.respawn
       клиенту дублировать нельзя, иначе она разъедется с комнатой молча. */
    if(typeof m.respawn === 'number' && isFinite(m.respawn) && m.respawn >= 0)
      NET.respawnTime = m.respawn;
    NET.players.clear();
    if(NP && typeof NP.reset === 'function'){ try{ NP.reset(); }catch(e){} }
    if(Array.isArray(m.players))
      for(let i=0;i<m.players.length;i++){
        const it = m.players[i];
        if(it) NT_ensure(it.id, it.name, it.team, it);
      }
    if(!NET.players.has(NET.id)) NT_ensure(NET.id, NET.name, NET.team);
    /* Свой ствол сервер уже знает из hello, но в списке welcome нас может не
       быть (комната собрала его до нашей записи). Держим значение и у себя:
       интерфейс и киллфид не должны гадать, кто чем играет. */
    const me0 = NET.players.get(NET.id);
    if(me0) me0.w = (NT_myW >= 0) ? NT_myW : (game.weapon|0);
    NT_recount();
    NT_ckReset(); NT_clock(m.k);
    NET.on = true;
    NT_uiState('lobby');
    NT_uiPlayers();
    NT_msg('ПОДКЛЮЧЕНО · КОМАНДА ' + (NET.team === 1 ? 'RED' : 'BLU') +
           ' · БОТОВ ' + NET.botCount + (NET.host ? ' · ВЫ ВЕДЁТЕ БОТОВ' : ''), 'info');
    NT_settle(true, m);
    break;
  }

  case 'snap': {
    NT_clock(m.k);
    const list = m.p;
    if(Array.isArray(list)){
      for(let i=0;i<list.length;i++){
        const e = list[i];
        if(!e) continue;
        /* tm — команда бойца (§9.5). Без неё незнакомый игрок молча становился
           BLU, то есть «своим», и NT_foe() глушил по нему любую заявку: он
           стоял на карте непростреливаемым. Команду из snap применяем и к уже
           известному игроку — сервер тут авторитет. */
        const tm = (typeof e.tm === 'number') ? (e.tm|0) : -1;
        let p = NET.players.get(e.i);
        // о ком-то не слышали (join потерялся) — заводим сразу, но команду при
        // молчащем сервере считаем ЧУЖОЙ: ошибка в эту сторону всего лишь
        // стоит отклонённой заявки, а в обратную делает бойца бессмертным
        if(!p) p = NT_ensure(e.i, null, (tm >= 0) ? tm : (NET.team ^ 1));
        else if(tm >= 0 && tm !== p.team) NT_ensure(e.i, null, tm);
        p.x = e.x; p.y = e.y; p.z = e.z;
        p.yaw = e.yaw; p.pitch = e.pitch;
        p.h = (e.h > 0) ? e.h : CFG.height;
        p.f = e.f|0;
        /* w — ствол бойца (§9.6). Приходит каждым снапшотом, но реплике
           говорим только про СМЕНУ: пересобирать модель 20 раз в секунду
           значит выбрасывать её же обратно. */
        const w = NT_wOf(e);
        if(w >= 0 && w !== p.w){ p.w = w; NT_netpW(e.i, w); }
        if(typeof e.hp === 'number') p.hp = e.hp;
        if(e.a !== undefined) p.alive = !!e.a;
      }
      if(NP) NP.applySnap(list, m.k);
    }
    // Хост ботов симулирует их сам — своё же эхо применять нельзя
    if(NP && Array.isArray(m.b) && !NET.host) NP.applyBots(m.b, m.k);
    break;
  }

  case 'shot': NT_remoteShot(m); break;
  case 'boom': NT_remoteBoom(m); break;

  /* Заявка на урон боту, пересланная нам как хосту: боты живут у нас, и
     применить её больше некому. Формат тот же, что клиент шлёт наверх,
     плюс i — кто стрелял. */
  case 'hit': {
    if(!NET.host || typeof m.v !== 'string' || m.v.charAt(0) !== 'b') break;
    const idx = parseInt(m.v.slice(1), 10);
    const e = enemies[idx];
    if(!e || !e.alive) break;
    const d = +m.d;
    if(!(d > 0)) break;
    /* Единственная точка, где урон по боту реально применяется, — значит и
       единственная, где его можно обрезать. Сервер эту заявку только пересылает
       (позиции ботов у него чужие), поэтому потолок по типу боеприпаса
       проверяем здесь: иначе один пакет выносит бота с любого расстояния. */
    const ai = NT_ammo(m.a);
    const part = (m.p === 'head' || m.p === 'splash' || m.p === 'burn') ? m.p : 'body';
    /* Потолок берём из таблицы СТРЕЛЯВШЕГО, а не из своей: хост может держать
       винтовку, а заявка прилететь от лучника — и наоборот. Оружие стрелка мы
       знаем из его записи в NET.players (§9.6). */
    const A = NT_ammoOf(m.i, ai);
    /* Голову считаем ТОЙ ЖЕ WPN_headDamage(), которой считал стрелок. Своя
       формула здесь была ошибкой: полный крит матчевого (и «обычного» типа
       вообще) равен 999, а потолок dmgMax×2.2 давал 198 — и честный хедшот
       по боту от не-хоста молча пропадал. */
    const hd = (typeof WPN_headDamage === 'function') ? WPN_headDamage(A, A.dmgMax) : A.dmgMax*2.2;
    const cap = (part === 'splash' ? (A.splashMax || A.dmgMax)
               : part === 'burn'   ? ((A.burnTime*A.burnDps) || A.dmgMax)
               : part === 'head'   ? ((hd > 0) ? hd : A.dmgMax)
               : A.dmgMax) * 1.06;
    if(d > cap) break;
    /* Поджог — не удар: его надо копить, а не снимать разом. Ветка нужна тем,
       кто не хост: у них реплики ботов не тикают, и гореть заочно некому. */
    if(part === 'burn'){ e.applyBurn(d, true); break; }
    const from = NET.players.get(m.i);
    let at = null;
    if(from){ NT_center(from, NT_v1); at = NT_v1; }
    // by нужен атрибуции убийства: без него this.killer у бота остаётся -1
    e.hurt(d, part, at, (m.i | 0));
    break;
  }

  case 'dmg': {
    // Пустой dmg (битый пакет) не должен давать ни вспышки, ни звука
    if(!(+m.d > 0) && typeof m.hp !== 'number') break;
    // hp авторитетное: локально его не уменьшаем, только показываем отклик
    const from = NET.players.get(m.from);
    let src = null;
    if(from && from.id !== NET.id){ NT_center(from, NT_v1); src = NT_v1; }
    const hp = (typeof m.hp === 'number') ? m.hp : Math.max(0, player.hp - (+m.d || 0));
    const me = NET.players.get(NET.id);
    if(me) me.hp = hp;
    netDamage(src, +m.d || 0, hp, m.p);
    break;
  }

  case 'kill': {
    const vp = (typeof m.v === 'number') ? NET.players.get(m.v) : null;
    const kp = (typeof m.k === 'number' && m.k >= 0) ? NET.players.get(m.k) : null;
    if(vp){ vp.alive = false; vp.hp = 0; vp.deaths++; }
    if(kp && kp !== vp) kp.kills++;
    // k = -1 значит «не игрок»: это либо бот, либо огонь. Различаем по части
    // тела — иначе смерть от бота выглядит в киллфиде как самовозгорание.
    if(m.v === NET.id) netKill(kp ? kp.name : (m.p === 'burn' ? null : 'RED СНАЙПЕР'), m.p);
    else{
      if(m.k === NET.id) game.kills++;      // счёт ведёт сервер, но итоги читают game
      NT_feedKill(kp, vp, m.p);
    }
    updateScore();
    NT_uiPlayers();
    break;
  }

  case 'resp': {
    const p = NET.players.get(m.i);
    if(p){ p.alive = true; p.hp = 100; }
    if(m.i === NET.id){
      NT_respAcc = 9;
      NT_probeDone();                  // ответ на нашу заявку — заодно замер связи
      NT_selfAcc.fill(0);              // недосланный самоурон принадлежал прошлой жизни
      /* Координаты проверяем ОБЯЗАТЕЛЬНО (§9.5). NaN в позиции игрока не
         бросает исключения: он молча растекается по скорости, матрицам и
         кадру коллизий, и игра «зависает» без единой строчки в консоли —
         искать такое потом почти невозможно. */
      const x = +m.x, y = +m.y, z = +m.z;
      if(isFinite(x) && isFinite(y) && isFinite(z)) netRespawn(x, y, z);
      else{
        // не подняться нельзя: мёртвый навсегда хуже, чем поднятый не там
        NT_spawnFallback(NT_v1);
        netRespawn(NT_v1.x, NT_v1.y, NT_v1.z);
        NT_msg('СЕРВЕР ПРИСЛАЛ БИТУЮ ТОЧКУ ВОЗРОЖДЕНИЯ', 'error');
      }
    }
    NT_uiPlayers();
    break;
  }

  case 'score': {
    NET.score.blu = m.blu|0;
    NET.score.red = m.red|0;
    if(Array.isArray(m.s))
      for(let i=0;i<m.s.length;i++){
        const it = m.s[i];
        if(!it) continue;
        const p = NET.players.get(it.i);
        if(p){ p.kills = it.k|0; p.deaths = it.d|0; }
      }
    const me = NET.players.get(NET.id);
    if(me){ game.kills = me.kills; game.deaths = me.deaths; }
    updateScore();
    NT_uiPlayers();
    // Сервер после взятия цели обнуляет счёт и запускает новый раунд —
    // значит защёлку «итоги показаны» надо снимать, а не держать до выхода.
    if(NT_ended && NET.score.blu < NET.goal && NET.score.red < NET.goal) NT_ended = false;
    // конца матча отдельным сообщением в протоколе нет — читаем его из счёта
    if(NET.goal > 0 && !NT_ended && (NET.score.blu >= NET.goal || NET.score.red >= NET.goal)){
      NT_ended = true;
      const win = (NET.team === 1) ? (NET.score.red >= NET.goal) : (NET.score.blu >= NET.goal);
      if(typeof endGame === 'function' && game.state === 'play') endGame(win);
    }
    break;
  }

  case 'join': {
    /* Само сообщение и есть запись о бойце: из него берётся ствол (§9.6),
       а полей здоровья и счёта в нём нет — NT_ensure их просто не увидит. */
    const p = NT_ensure(m.id, m.name, m.team, m);
    NT_recount();
    NT_uiPlayers();
    addFeed('<span class="' + NT_teamCls(p.team) + '">' + p.name + '</span> <span class="w">ПОДКЛЮЧИЛСЯ</span>');
    break;
  }

  case 'leave': {
    const p = NET.players.get(m.id);
    if(p){
      if(NP && typeof NP.drop === 'function') NP.drop(m.id);
      NET.players.delete(m.id);
      addFeed('<span class="' + NT_teamCls(p.team) + '">' + p.name + '</span> <span class="w">ВЫШЕЛ</span>');
    }
    NT_recount();
    NT_uiPlayers();
    break;
  }

  case 'pick': {
    const i = m.i|0;
    const mine = (m.by === NET.id);
    /* Право на предмет арбитрирует сервер (§9.2): касание только прячет его и
       шлёт заявку, а лечение и патроны выдаёт вот этот ответ. */
    netPickResult(i, mine, (typeof m.hp === 'number') ? m.hp : -1);
    /* Откат назначает сервер: у него одна таблица на комнату. Своё p.cd
       трогать не надо — при потерянном at оно и так уже проставлено касанием. */
    const p = PICKUPS[i];
    if(p && typeof m.at === 'number' && isFinite(m.at))
      NT_pickHide(p, (m.at - NET.now())/1000);
    if(mine) NT_probeDone();
    break;
  }

  case 'host': {
    const was = NET.host;
    NET.hostId = m.i|0;
    NET.host = (m.i === NET.id);
    if(NET.host !== was)
      NT_msg(NET.host ? 'ВЫ ТЕПЕРЬ ВЕДЁТЕ БОТОВ' : 'БОТОВ ВЕДЁТ ДРУГОЙ ИГРОК', 'info');
    break;
  }

  case 'ping': {
    NT_clock(m.k);
    // отвечаем немедленно — по этому ответу сервер и считает круговой ход
    NET.send({ t:'pong', k:m.k });
    /* rtt — измеренный сервером пинг (§9.5). Это настоящее значение, а не
       наша оценка снизу по избытку задержки; своего замера у клиента нет. */
    if(typeof m.rtt === 'number' && isFinite(m.rtt) && m.rtt >= 0) NT_rtt = m.rtt;
    break;
  }

  /* Текст ошибки пришёл извне и попадёт в разметку интерфейса — чистим его
     ровно так же, как имена: одна дверь для всех внешних строк. */
  case 'err': NT_msg(NT_txt(m.m || 'ОШИБКА СЕРВЕРА') || 'ОШИБКА СЕРВЕРА', 'error'); break;

  /* Неизвестный тип молча игнорируем — это точка роста протокола. */
  }
}

/* Киллфид по чужой смерти. Имена уже вычищены на входе. */
function NT_feedKill(kp, vp, part){
  const vn = vp ? vp.name : 'БОЕЦ';
  const vc = NT_teamCls(vp ? vp.team : 1);
  const head = (part === 'head') ? ' <span class="w">· ХЕДШОТ</span>' : '';
  if(!kp){
    const who = (part === 'burn') ? 'ОГОНЬ' : 'БОТ';
    addFeed('<span class="r">' + who + '</span> ✖ <span class="' + vc + '">' + vn + '</span>' + head);
  }
  else addFeed('<span class="' + NT_teamCls(kp.team) + '">' + kp.name + '</span> ✖ <span class="' +
               vc + '">' + vn + '</span>' + head);
}

/* ------------------------------ ПИКАПЫ ------------------------------ */
/* Итог спора за предмет (NETCONTRACT §9.2).

   Зовётся из обработчика 'pick' — и только оттуда: пока сервер не ответил,
   эффекта нет вообще. updatePickups() при NET.on лишь прячет предмет и шлёт
   заявку, поэтому лечение и патроны выдаются здесь.

     i    — индекс в PICKUPS,
     mine — досталось ли нам (by === NET.id),
     hp   — авторитетное здоровье после аптечки, −1 если сервер его не прислал.

   Возвращает true, если эффект применён. Время возврата предмета ставит
   вызывающий по полю at: оно протокольное, а не игровое. */
function netPickResult(i, mine, hp){
  if(NET.on !== true) return false;
  const p = PICKUPS[i|0];
  if(!p) return false;
  /* Предмет в любом случае остаётся спрятанным: мы либо забрали его сами,
     либо забрал другой. Откат — штатный, дальше его уточнит at с сервера. */
  NT_pickHide(p, (p.t > 0) ? p.t : p.cd);
  if(!mine) return false;
  if(!player.alive || game.state !== 'play') return false;

  if(p.type === 'hp'){
    /* Лечение тоже авторитетное: величину считает сервер и присылает готовое
       здоровье. Своё число здесь выдумывать нельзя — комната и клиент
       разъедутся ровно так же, как это было с уроном. */
    if(!(hp >= 0)) return false;
    const heal = hp - player.hp;
    player.hp = hp;
    /* Аптечка сбивает пламя, как и в одиночной игре. Топливо горения ведёт
       клиент (сервер получает его порциями через 'self'), поэтому уменьшаем
       именно player.burn — hp тут уже сказан сервером. */
    if(heal > 0 && player.burn > 0) player.burn = Math.max(0, player.burn - heal*0.8);
    updateHP();
    return true;
  }

  // Патроны сервер не ведёт — выдаём ровно тем же правилом, что и офлайн
  let got = 0;
  for(let k=0;k<3;k++){
    if(wpn.res[k] >= AMMO[k].resMax) continue;
    const add = Math.min(AMMO[k].resMax - wpn.res[k], Math.ceil(AMMO[k].resMax*0.4));
    wpn.res[k] += add; got += add;
  }
  if(got > 0) updateAmmoHUD();
  return got > 0;
}

/* ------------------------ ЧУЖОЙ ВЫСТРЕЛ И ВЗРЫВ ------------------------ */
/* Пулю НЕ создаём: попадание по нам считает стрелявший, а сервер присылает
   готовый урон. Локальная пуля владельца 'enemy' ударила бы вторым уроном.
   Саму картинку выстрела отдаём NETP — там же живёт модель стрелка, и она
   обязана дёрнуться отдачей и передёрнуть затвор. Свой рисунок оставлен
   запасным на случай сборки без этого метода. */
function NT_remoteShot(m){
  const NP = NT_netp();
  if(NP && typeof NP.shot === 'function'){
    NP.shot(m.i, m.a|0, +m.ox || 0, +m.oy || 0, +m.oz || 0,
            +m.dx || 0, +m.dy || 0, +m.dz || 0, +m.c || 0);
    return;
  }
  // трассер и звук — по таблице СТРЕЛЯВШЕГО: стрела летит иначе, чем пуля
  const a = NT_ammoOf(m.i, m.a);
  NT_v1.set(+m.ox || 0, +m.oy || 0, +m.oz || 0);
  NT_v2.set(+m.dx || 0, +m.dy || 0, +m.dz || 0);
  if(NT_v2.lengthSq() < 1e-8) return;
  NT_v2.normalize();
  // трасса обязана упереться в препятствие, иначе она прошивает скалу насквозь
  let far = 250;
  const rb = rayBoxes(NT_v1, NT_v2, far); if(rb) far = rb.t;
  const rt = rayTerrain(NT_v1, NT_v2, far); if(rt) far = rt.t;
  NT_v3.copy(NT_v1).addScaledVector(NT_v2, far);
  if(FX.tracer) FX.tracer(NT_v1, NT_v3, a.trail, 0.10);
  FX.burst(NT_v1, 4, { mat:PMAT.smoke, speed:2.2, life:0.5, size:0.09, s1:0.2, g:-0.7 });
  if(typeof LIGHTS !== 'undefined' && LIGHTS && LIGHTS.flash) LIGHTS.flash(NT_v1, 0xffcf8a, 2.6, 13, 0.07);
  const d = NT_v1.distanceTo(camera.position);
  SFX.shot(a.id, panOf(NT_v1), volOf(NT_v1)*0.9, Math.min(0.9, d/340));
}

/* Чужой разрыв — только картинка. Зовём тот же explode(), но с maxDmg = 0:
   splashDamage() тогда возвращает ноль для всех, и ни бот, ни игрок урона не
   получают, а вспышка, дым, воронка, звук и тряска остаются ровно теми же,
   что у своего фугаса. Свой урон нам всё равно пришлёт сервер отдельным dmg. */
/* Стрелка в 'boom' протокол не называет (§3): пакет ретранслируется ради
   картинки, и радиус берётся из СВОЕЙ таблицы. Разница между фугасом и
   взрывной стрелой тут в четверть метра, а урон этот вызов всё равно не
   наносит — заводить ради этого лишнее поле в кадре незачем. */
function NT_remoteBoom(m){
  const ai = (m.a|0);
  const a = AMMO[ai % AMMO.length] || AMMO[1];
  NT_v1.set(+m.x || 0, +m.y || 0, +m.z || 0);
  /* Зажигательный площадью не бьёт, но оставляет очаг, и очаг соперника обязан
     быть виден и опасен: иначе половина смысла типа теряется в сети. Урон он
     нанесёт по общим правилам — ботам только у хоста, себе через заявку. */
  if(ai === 2){
    FX.firePool(NT_v1, a.poolR, a.poolTime, a.poolDps, false);
    return;
  }
  const R = a.splashR || AMMO[1].splashR;
  explode(NT_v1, R, 0, false, a.splashFall, a.splashCover);
}

/* ------------------------------ ПИНГ ------------------------------ */
let NT_probeAt = -1;          // локальное время заявки, на которую ждём эхо
function NT_probeDone(){
  if(NT_probeAt < 0) return false;
  const r = performance.now() - NT_probeAt;
  NT_probeAt = -1;
  if(r >= 0 && r < 3000){ NT_rtt = r; return true; }
  return false;
}
function NT_pingUpdate(dt){
  /* Точное значение — только когда сервер сам сообщил rtt (или вернул наш
     штамп из pong). Иначе показываем оценку снизу: удвоенный избыток
     задержки над лучшей в окне. В локальной сети это честный «около нуля»,
     через туннель — заниженная, но не выдуманная величина. */
  const target = (NT_rtt >= 0) ? NT_rtt : NT_exc*2;
  const k = dt*3; NT_pingSm += (target - NT_pingSm)*(k > 1 ? 1 : k);
  const v = Math.round(NT_pingSm);
  if(v !== NT_pingShown){ NT_pingShown = v; NET.ping = v; NT_uiPing(v); }
}

/* ============================ ОТПРАВКА ============================ */
function NT_sendMove(){
  // мёртвые и стоящие на паузе не двигаются: пакет только сбил бы интерполяцию
  if(!player.alive || game.state !== 'play') return;
  const m = NT_mMove;
  NT_seq = (NT_seq + 1) & 0xffff;
  m.s = NT_seq;
  m.x = NT_q(player.pos.x); m.y = NT_q(player.pos.y); m.z = NT_q(player.pos.z);
  m.yaw = NT_q(player.yaw); m.pitch = NT_q(player.pitch);
  m.h = NT_q(player.h);
  m.f = NT_flags();
  NET.send(m);
}

/* Хост ботов раздаёт их состояние — остальные клиенты ИИ не считают вовсе. */
let NT_botsPrevN = -1;
function NT_sendBots(){
  const list = NT_mBots.b;
  let n = 0;
  for(let i=0;i<enemies.length;i++){
    const e = enemies[i];
    if(!e) continue;
    const s = NT_botSlot(n);
    s.i = (e.id === undefined) ? i : e.id;
    s.x = NT_q(e.pos.x); s.y = NT_q(e.pos.y); s.z = NT_q(e.pos.z);
    s.yaw = NT_q(e.yaw); s.pitch = NT_q(e.pitch || 0);
    s.h = NT_q(e.h);
    const c = NT_BOT_CODE[e.state];
    s.st = (c === undefined) ? 0 : c;
    s.a = e.alive ? 1 : 0;
    list[n++] = s;
  }
  list.length = n;
  // пустой список шлём один раз (комната ещё в брифинге), дальше молчим
  if(n === 0 && NT_botsPrevN === 0) return;
  NT_botsPrevN = n;
  NET.send(NT_mBots);
}

/* ============================== NET ============================== */
const NET = {
  on:false, id:-1, team:0, host:false, hostId:-1, ping:0, goal:CFG.killGoal,
  botCount:0,
  /* Сколько секунд лежать до возрождения — приходит в welcome (§9.5).
     Значение до подключения — офлайновое, чтобы поле всегда было числом. */
  respawnTime:3.0,
  /* Взводится, когда join/leave изменили botCount: 90_game.js по нему
     пересобирает enemies. Снимать флаг обязан тот, кто его прочитал. */
  botsDirty:false,
  players:new Map(),
  score:{ blu:0, red:0 },
  name:'БОЕЦ',
  url:'',
  BOT_ST:NT_BOT_ST,

  /* Адрес по умолчанию — тот, с которого открыта страница: сервер отдаёт и
     игру, и сокет на одном порту. file:// адреса не имеет — там localhost. */
  defaultUrl(){
    const l = location;
    const proto = (l.protocol === 'https:') ? 'wss://' : 'ws://';
    const host = l.host || ('localhost:' + NT_PORT);
    return proto + host;
  },
  botState(code){ return NT_BOT_ST[code|0] || 'hold'; },
  /* Ствол бойца по id: 0 винтовка, 1 лук (§9.6). Отдельная дверь для тех,
     кому оружие нужно для картинки (модель реплики, табло): лазить в записи
     players руками ради одного поля незачем. Неизвестный боец — винтовка. */
  wpnOf(id){ const p = NET.players.get(id); return p ? (p.w|0) : 0; },

  /* -------------------------- ПОДКЛЮЧЕНИЕ -------------------------- */
  connect(url, name){
    const dst = NT_dst(url);
    const nick = NT_nick(name);
    /* Без модуля реплик сеть бессмысленна: loop() зовёт NETP.update каждый
       кадр, и первый же кадр в сети уронил бы игру. Лучше честный отказ. */
    if(!NT_hasNETP()){
      NT_msg('СБОРКА БЕЗ МОДУЛЯ СЕТЕВЫХ ИГРОКОВ — ДОСТУПЕН ТОЛЬКО ОДИНОЧНЫЙ БОЙ', 'error');
      NT_uiState('error');
      return Promise.reject(new Error('нет NETP'));
    }
    if(typeof WebSocket === 'undefined'){
      NT_msg('БРАУЗЕР НЕ ПОДДЕРЖИВАЕТ WEBSOCKET', 'error');
      NT_uiState('error');
      return Promise.reject(new Error('нет WebSocket'));
    }

    // повторное подключение: старый сокет и его колбэки должны умереть молча
    NT_settle(false, new Error('переподключение'));
    NT_dropSocket();
    NET.on = false;
    NT_clearState();

    const gen = ++NT_gen;
    NET.name = nick;
    NET.url = dst;
    NT_uiState('connecting');
    NT_msg('ПОДКЛЮЧЕНИЕ К ' + NT_txt(dst) + '…', 'info');

    return new Promise((resolve, reject)=>{
      let ws = null;
      try{ ws = new WebSocket(dst); }
      catch(err){
        NT_uiState('error');
        NT_msg('НЕВЕРНЫЙ АДРЕС: ' + NT_txt(dst), 'error');
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      NT_ws = ws;
      NT_resolve = resolve; NT_reject = reject;
      NT_lastRx = performance.now();

      // общий выход по неудаче: сообщение игроку и один reject на поколение
      const fail = (text)=>{
        if(gen !== NT_gen) return;
        NT_dropSocket();
        NET.on = false;
        NT_clearState();
        NT_uiState('error');
        NT_msg(text, 'error');
        NT_settle(false, new Error(text));
      };

      NT_dialT = setTimeout(()=> fail('СЕРВЕР НЕ ОТВЕЧАЕТ: ' + NT_txt(dst)), NT_DIAL_MS);

      ws.onopen = ()=>{
        if(gen !== NT_gen) return;
        NT_lastRx = performance.now();
        /* Ствол называем сразу: по нему сервер выбирает таблицу боеприпасов,
           а первый выстрел может случиться раньше, чем мы успеем передумать. */
        NT_myW = game.weapon|0;
        NET.send({ t:'hello', name:nick, ver:NT_VER, w:NT_myW });
      };
      ws.onmessage = ev=>{ if(gen === NT_gen) NT_onMessage(ev); };
      // onerror в браузере намеренно не раскрывает причину — говорим общее
      ws.onerror = ()=>{ if(gen === NT_gen && NET.on !== true) fail('НЕ УДАЛОСЬ СОЕДИНИТЬСЯ: ' + NT_txt(dst)); };
      ws.onclose = ev=>{
        if(gen !== NT_gen) return;
        if(NET.on === true){
          const why = (ev && ev.reason) ? NT_txt(ev.reason) : '';
          NT_lost('СВЯЗЬ С СЕРВЕРОМ ПОТЕРЯНА' + (why ? ' · ' + why : ''));
        } else {
          fail('СОЕДИНЕНИЕ ЗАКРЫТО СЕРВЕРОМ' + (ev && ev.code ? ' (' + ev.code + ')' : ''));
        }
      };
    });
  },

  disconnect(reason){
    const was = NET.on;
    NT_settle(false, new Error(reason || 'отключено'));
    NT_gen++;                       // колбэки уходящего сокета больше не наши
    NT_dropSocket();
    NET.on = false;
    NT_clearState();
    NT_uiState('off');
    if(was) NT_msg(reason ? ('ОТКЛЮЧЕНО · ' + reason) : 'ОТКЛЮЧЕНО', 'info');
  },

  send(obj){
    const ws = NT_ws;
    if(!ws || ws.readyState !== 1) return false;
    if(!NT_budget(NT_critical(obj.t))) return false;
    try{ ws.send(JSON.stringify(obj)); }
    catch(e){ return false; }
    return true;
  },

  /* -------------------------- КАДР -------------------------- */
  update(dt){
    if(NET.on !== true) return;

    /* Смена ствола (§9.6). Оружие выбирают в брифинге — то есть уже после
       hello, — а сервер по нему выбирает таблицу, по которой судит урон и
       темп. Пока он не знает про лук, честные заявки лучника будут ломиться
       в винтовочные потолки. Повторный hello сессию не пересоздаёт; если
       пакет не пролез в бюджет, попробуем в следующем кадре. */
    const w = game.weapon|0;
    if(w !== NT_myW && NET.send({ t:'hello', name:NET.name, ver:NT_VER, w:w })){
      NT_myW = w;
      const me = NET.players.get(NET.id);
      if(me) me.w = w;
    }

    // часы: подводим оценку серверного времени, не дёргая её рывками
    if(NT_ckReady){
      const err = NT_offTarget - NT_off;
      if(err > 300 || err < -300) NT_off = NT_offTarget;
      else{ const step = 80*dt; NT_off += (err > step) ? step : (err < -step ? -step : err); }
    }
    NT_pingUpdate(dt);

    // сервер замолчал — дальше играть вслепую хуже, чем честно оборваться
    if(performance.now() - NT_lastRx > NT_SILENCE){ NT_lost('СЕРВЕР НЕ ОТВЕЧАЕТ'); return; }

    NT_acc += dt;
    if(NT_acc >= NT_TICK){
      NT_acc -= NT_TICK;
      if(NT_acc > NT_TICK) NT_acc = 0;       // после длинного кадра не догоняем очередью
      NT_sendMove();
      // накопленный самоурон (горение) уходит здесь же: 20 Гц — верхняя
      // граница, реальный темп задают NT_SELF_STEP и NT_SELF_MS
      NT_selfFlush(performance.now(), false);
      // ботов симулирует только идущий бой: на паузе и в брифинге у хоста
      // они замерли, и слать их кадр по двадцать раз в секунду незачем
      if(NET.host && game.state === 'play') NT_sendBots();
    }

    /* Респавн назначает сервер. Локальный таймер в 85_player.js всё равно
       поднимет нас через свои 3 с, поэтому заявку шлём заранее и повторяем:
       потерянный в дороге 'resp' иначе оставил бы игрока призраком. */
    if(!player.alive && game.state === 'play'){
      NT_respAcc += dt;
      if(player.respawnT <= 0.25 && NT_respAcc > 0.5){
        NT_respAcc = 0;
        NT_probeAt = performance.now();
        NET.send({ t:'resp' });
      }
    } else NT_respAcc = 9;
  },

  now(){ return performance.now() + NT_off; },

  /* ------------------------- ЗАЯВКИ -------------------------
     Всё ниже — «я видел вот это», а не «применить вот это». Проверяет и
     применяет сервер; наша задача — не завалить его мусором. */

  /* chg — заряд выстрела 0..1. У винтовки это выцеливание, у лука — НАТЯГ, и
     для лука число перестало быть косметикой: сервер считает по нему
     минимальный интервал между выстрелами (наложить стрелу + натянуть на
     столько, на сколько заявлено). Недотянутый выстрел уходит раньше — и
     обязан стоить меньше времени, иначе честная скорая стрельба отклонялась
     бы как невозможная. */
  reportShot(ammoIdx, origin, dir, chg){
    if(NET.on !== true) return;
    const a = ammoIdx|0;
    // выстрел открывает право на заявки: без него ни одно попадание не пройдёт
    if(NT_cShot < 4) NT_cShot++;
    if(a === 1){
      if(NT_cSplash < 20) NT_cSplash = Math.min(20, NT_cSplash + 10);
      if(NT_cBoom < 3) NT_cBoom++;
    }
    const m = NT_mShot;
    m.a = a;
    m.ox = NT_q(origin.x); m.oy = NT_q(origin.y); m.oz = NT_q(origin.z);
    m.dx = NT_q(dir.x); m.dy = NT_q(dir.y); m.dz = NT_q(dir.z);
    m.c = Math.round((chg || 0)*100)/100;
    NET.send(m);
  },

  /* Самоурон (§9.1): свой фугас под ногами, падение, горение. Здоровье не
     трогаем — сервер посчитает его сам и вернёт авторитетным в 'dmg'.
     cause: 'frag' | 'burn' | 'fall'. */
  reportSelf(dmg, cause){
    if(NET.on !== true) return;
    const d = +dmg;
    if(!(d > 0) || !isFinite(d)) return;
    const i = NT_selfIdx(cause);
    NT_selfAcc[i] += d;
    /* Фугас и падение — разовые события, их шлём сразу: задержка в четверть
       секунды здесь означает опоздавшую на четверть секунды смерть.
       Горение копится и уходит порцией — из update() или по порогу. */
    NT_selfFlush(performance.now(), i !== 1);
  },

  /* ammoIdx — индекс боеприпаса ПУЛИ, а не текущего выбора (§9.3): пояс
     переключается мгновенно, а пуля летит до полусекунды, и сервер сверяет
     заявку с кольцом наших выстрелов. */
  reportHit(victim, part, dmg, ammoIdx){
    if(NET.on !== true) return;
    if(!NT_foe(victim)) return;            // по своим сервер всё равно откажет
    if(NT_cShot <= 0) return;              // попаданий не больше, чем выстрелов
    NT_cShot--;
    const m = NT_mHit;
    m.v = victim; m.p = part || 'body';
    m.d = NT_q1(dmg); m.a = NT_ammo(ammoIdx, part === 'splash');
    NET.send(m);
  },

  /* Накрытие чужих считаем ТОЙ ЖЕ splashDamage(), что и всё остальное:
     covered = нет прямой видимости от эпицентра к центру цели. Позиции
     берём отрисованные (NETP) — по ним игрок и наводил.
     Пакет уходит даже с пустым списком: сервер ретранслирует его остальным
     ради эффекта разрыва. */
  reportBoom(pos, R, maxDmg, fall, coverMul){
    if(NET.on !== true) return;
    if(NT_cBoom <= 0) return;
    NT_cBoom--;
    NT_v2.copy(pos);                       // pos у E3 — общий временный вектор
    const h = NT_mBoom.h;
    let n = 0;
    for(const p of NET.players.values()){
      if(p.id === NET.id || !p.alive || p.team === NET.team) continue;
      NT_center(p, NT_v1);
      const d = NT_v1.distanceTo(NT_v2);
      if(d >= R) continue;
      const dmg = splashDamage(d, R, maxDmg, fall, !losClear(NT_v2, NT_v1), coverMul);
      if(dmg <= 0.5) continue;
      const s = NT_boomSlot(n);
      s.v = p.id; s.d = NT_q1(dmg);
      h[n++] = s;
    }
    h.length = n;
    const m = NT_mBoom;
    m.x = NT_q(NT_v2.x); m.y = NT_q(NT_v2.y); m.z = NT_q(NT_v2.z);
    m.a = 1;                               // площадь у игрока бывает только от фугаса
    NET.send(m);
  },

  /* Очаг огня. Урон в заявке не передаём — каждый клиент посчитает его сам по
     своему очагу: себе через 'self', ботам только у хоста. Сервер увидит тип
     без splashR и просто ретранслирует эффект. */
  reportPool(pos){
    if(NET.on !== true) return;
    if(NT_cBoom <= 0) return;
    NT_cBoom--;
    NT_v2.copy(pos);
    NET.send({ t:'boom', x:NT_q(NT_v2.x), y:NT_q(NT_v2.y), z:NT_q(NT_v2.z), a:2 });
  },

  reportBurn(victim, total){
    if(NET.on !== true) return;
    if(!NT_foe(victim)) return;
    const t = performance.now();
    if(t - NT_burnAt < 100) return;
    NT_burnAt = t;
    NET.send({ t:'burn', v:victim, d:NT_q1(total) });
  },

  reportPick(i){
    if(NET.on !== true) return;
    const t = performance.now();
    if(t - NT_pickAt < 200) return;
    NT_pickAt = t;
    NT_probeAt = t;                        // ответ сервера даст честный круговой ход
    NET.send({ t:'pick', i:i|0 });
  },

  /* Урон боту заявляем хосту: 'hit' с victim вида 'b'+индекс, сервер
     перешлёт его тому клиенту, который этих ботов считает.
     ammoIdx — снова от ПУЛИ (§9.3), не из wpn.idx. */
  reportBotHit(botId, dmg, part, ammoIdx){
    if(NET.on !== true || NET.host) return;
    const splash = (part === 'splash');
    if(splash){ if(NT_cSplash <= 0) return; NT_cSplash--; }
    else{ if(NT_cShot <= 0) return; NT_cShot--; }
    const m = NT_mHit;
    m.v = 'b' + (botId|0);
    m.p = part || 'body';
    m.d = NT_q1(dmg);
    m.a = NT_ammo(ammoIdx, splash);
    NET.send(m);
  },

  /* Обратная сторона: урон ИГРОКУ от бота заявляет хост ('bhit' в §3).
     Зовётся из 70_ai.js (AI_hitScan) — пули ботов существуют только у хоста,
     и он же сканирует их по всем целям, включая удалённых игроков.
     ammoIdx передаётся для будущей проверки потолка на сервере; боты стреляют
     только матчевым, поэтому сегодня это всегда 0. */
  reportBotDamage(victim, dmg, part, ammoIdx){
    if(NET.on !== true || !NET.host) return;
    NET.send({ t:'bhit', v:victim, d:NT_q1(dmg), p:part || 'body', a:NT_ammo(ammoIdx) });
  }
};

/* ----------------------- ОБЁРТКИ ДЛЯ ИНТЕРФЕЙСА ----------------------- */
function netConnect(url, name){ return NET.connect(url, name); }
function netDisconnect(){ NET.disconnect('вы вышли из комнаты'); }
function netIsOn(){ return NET.on === true; }
