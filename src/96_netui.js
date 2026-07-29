/* =====================================================================
   N4 · Интерфейс мультиплеера: подключение, лобби, табло, пинг, киллфид.

   Почему весь вывод собирается строкой, а не пулом узлов: сетевые события
   редки (join / leave / score / ping раз в 2 с), а кадровый цикл сюда не
   заходит вообще. Единственное место, где перерисовка могла бы участиться, —
   удержанный Tab на живом матче под потоком снапшотов 20 Гц. Поэтому весь
   вывод идёт через один троттлинг NUI_DRAW_MS: серия вызовов схлопывается
   в одну перерисовку, и в кадре не остаётся ни аллокаций, ни разбора HTML.

   Честность интерфейса — часть задачи, а не украшение. Модель авторитета
   (NETCONTRACT §1) написана и на экране подключения, и в лобби, и на табло
   открытым текстом: попадания засчитывает стреляющий, сервер лишь проверяет
   заявки. Игрок должен узнать это до боя, а не вывести из подозрений.

   Транспорта (92_net.js) в сборке может не быть вовсе — тогда модуль обязан
   молча оставить игру одиночной, а не уронить загрузку. Отсюда все обращения
   к NET через NUI_net().
   ===================================================================== */

const NUI_DRAW_MS  = 150;              // не чаще шести перерисовок в секунду
const NUI_WAIT_MS  = 9000;             // сколько ждём ответа сервера, прежде чем ругаться
const NUI_LS_NAME  = 'dmduel.name';
const NUI_LS_ADDR  = 'dmduel.addr';
const NUI_NAME_MAX = 16;

let NUI_ready   = false;
let NUI_state   = 'off';               // 'off'|'connecting'|'lobby'|'play'|'error'
let NUI_board   = false;               // табло сейчас развёрнуто
let NUI_watch   = 0;                   // таймер «сервер не отвечает»
let NUI_pend    = 0;                   // отложенная перерисовка
let NUI_lastDraw= 0;
let NUI_pingShow= -1;
let NUI_bluShow = -1, NUI_redShow = -1;
let NUI_blu = -1, NUI_red = -1;        // счёт команд с сервера; -1 — считаем сами
let NUI_gotErr  = false;               // транспорт уже показал свою причину отказа
let NUI_msgN    = 0;                   // счётчик сообщений: кто последним говорил с игроком
const NUI_rows = [];                   // буфер строк списка, переиспользуется

/* NET — const из 92_net.js. Если модуля в сборке нет, обращение к имени
   бросит ReferenceError; ловим и живём дальше в одиночном режиме. */
function NUI_net(){ try{ return NET; }catch(e){ return null; } }
function NUI_on(){ const n = NUI_net(); return !!(n && n.on); }

/* ------------------------------ МЕЛОЧИ ------------------------------ */
/* Имена приходят от чужих клиентов и уходят в innerHTML — экранируем всегда. */
function NUI_esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function NUI_short(s){
  const t = String(s == null ? '' : s).trim();
  if(!t) return 'БЕЗ ИМЕНИ';
  return t.length > NUI_NAME_MAX ? t.slice(0, NUI_NAME_MAX-1)+'…' : t;
}
function NUI_teamCls(t){ return (t|0) === 1 ? 'red' : 'blu'; }
function NUI_teamName(t){ return (t|0) === 1 ? 'RED' : 'BLU'; }

/* ------------------------------ КОМАНДА ------------------------------ */
/* Сторону в сети назначает комната (NETCONTRACT §6): в hello пожелания нет, и
   выдумывать его здесь нельзя — интерфейс обязан показывать, что решил сервер,
   а не то, что игрок нажал в брифинге.

   Раньше здесь стояло `n ? n.team|0 : 0` — то есть «без сети мы BLU». С выбором
   стороны это стало враньём: офлайн игрок вполне может играть за RED. */
function NUI_myTeam(){
  const n = NUI_net();
  if(NUI_on() && n) return (n.team|0) === 1 ? 1 : 0;
  if(typeof playerTeam === 'function') return playerTeam();
  return (game.team|0) === 1 ? 1 : 0;
}
/* Кладём команду сервера в game.team (единый источник правды для респавнов,
   счёта и цвета HUD) и переводим выбор стороны в брифинге в режим подписи.
   Отключились — замок снимаем, игрок снова выбирает сам. */
function NUI_syncTeam(){
  const t = NUI_on() ? NUI_myTeam() : -1;
  if(typeof lockTeamChoice === 'function') lockTeamChoice(t);
  else if(t >= 0) game.team = t;
  return t;
}
function NUI_now(){
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}
function NUI_defName(){ return 'СНАЙПЕР-' + (10 + Math.floor(Math.random()*90)); }

/* Адрес игрок вводит как «host:port» — схему достраиваем от страницы, иначе
   игра, открытая через https-туннель, попробует незащищённый ws и получит
   отказ браузера ещё до сервера. */
function NUI_url(addr){
  let a = String(addr || '').trim();
  if(!a) a = location.host || 'localhost:8177';
  if(/^wss?:\/\//i.test(a)) return a;
  if(/^https?:\/\//i.test(a)) return a.replace(/^http/i, 'ws');
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + a.replace(/^\/+/, '');
}

/* Причина отказа. Браузер и сервер говорят разными словами и по-английски —
   игроку нужна одна внятная строка и понятное действие. Если распознать не
   удалось, возвращаем null: транспорт к этому моменту обычно уже написал
   что-то более конкретное, и затирать его текст «ERROR» было бы вредительством. */
function NUI_reason(err){
  const raw = err && (err.message || err.reason || err.m) ? String(err.message || err.reason || err.m)
                                                          : String(err == null ? '' : err);
  const s = raw.toLowerCase();
  // коды закрытия сервера комнаты (net/server.js): 4001 нет hello, 4002 комната
  // полна, 4003 слишком много отклонённых заявок, 4004 молчание дольше таймаута.
  // Транспорт до нас доносит только код, поэтому разбираем и его.
  if(/full|полн|нет мест|no slots|мест нет|4002/.test(s)) return 'КОМНАТА ПОЛНА — все слоты заняты, попробуйте позже';
  if(/\bversion\b|верси/.test(s))                        return 'ВЕРСИЯ ИГРЫ НЕ СОВПАДАЕТ С СЕРВЕРОМ';
  if(/timeout|timed out|таймаут|не отвеч|4001|4004/.test(s))
    return 'СЕРВЕР НЕ ОТВЕЧАЕТ — проверьте адрес и что сервер запущен';
  if(/kick|ban|\bбан\b|отклон|reject|4003/.test(s))      return 'СЕРВЕР ОТКЛОНИЛ ПОДКЛЮЧЕНИЕ';
  if(/refus|unreach|econn|1006/.test(s))                 return 'НЕ УДАЛОСЬ ПОДКЛЮЧИТЬСЯ — по этому адресу сервер не отвечает';
  return null;
}

/* ------------------------- ЧТЕНИЕ СОСТОЯНИЯ ------------------------- */
/* NET.players — Map(id -> запись). Себя там может и не быть (сервер шлёт
   welcome со списком «остальных»), поэтому недостающую строку достраиваем
   в одном и том же объекте: список перерисовывается часто. */
const NUI_selfRow = { id:-1, name:'', team:0, hp:100, alive:true, kills:0, deaths:0 };

function NUI_collect(){
  NUI_rows.length = 0;
  const n = NUI_net();
  if(!n) return -1;
  const me = (n.id === undefined || n.id === null) ? -1 : (n.id|0);
  let haveMe = false;
  if(n.players && typeof n.players.forEach === 'function'){
    n.players.forEach(p=>{
      if(!p) return;
      if((p.id|0) === me) haveMe = true;
      NUI_rows.push(p);
    });
  }
  if(!haveMe && me >= 0){
    const r = NUI_selfRow;
    r.id = me; r.team = NUI_myTeam();
    r.name = NUI_myName();
    // офлайновые счётчики матча — единственное, что есть про себя без сервера
    r.kills = game.kills|0; r.deaths = game.deaths|0;
    r.alive = player.alive !== false;
    NUI_rows.push(r);
  }
  NUI_rows.sort(NUI_cmp);
  return me;
}
function NUI_cmp(a, b){
  if((a.team|0) !== (b.team|0)) return (a.team|0) - (b.team|0);
  const k = (b.kills|0) - (a.kills|0);
  if(k) return k;
  return (a.deaths|0) - (b.deaths|0);
}
/* Своё имя. Сервер мог его подрезать или расподобить с чужим, поэтому
   спрашиваем сперва комнату, и только потом поле ввода. */
function NUI_myName(){
  const n = NUI_net();
  if(n && n.players && typeof n.players.get === 'function' && n.id !== undefined && n.id !== null){
    const p = n.players.get(n.id);
    if(p && p.name) return p.name;
  }
  const el = $('netName');
  const v = el ? String(el.value||'').trim() : '';
  return v || 'СНАЙПЕР';
}
/* Хост ботов: сервер может прислать явный id, иначе по правилу §5 — младший id.
   Собственный флаг NET.host главнее всего: его сервер подтвердил сообщением host. */
function NUI_hostId(me){
  const n = NUI_net();
  if(!n) return -1;
  if(n.host === true && me >= 0) return me;
  // hostId ещё может быть не назначен (-1) — тогда правило §5 «младший id»
  if(n.hostId !== undefined && n.hostId !== null && (n.hostId|0) >= 0) return n.hostId|0;
  let h = -1;
  for(let i=0;i<NUI_rows.length;i++){
    const id = NUI_rows[i].id|0;
    if(h < 0 || id < h) h = id;
  }
  return h;
}
function NUI_ping(p, me){
  if(typeof p.ping === 'number') return Math.round(p.ping);
  const n = NUI_net();
  if(n && (p.id|0) === me && typeof n.ping === 'number') return Math.round(n.ping);
  return -1;
}

/* ------------------------------ ОТРИСОВКА ------------------------------ */
/* Публичный вход. Дёргать его можно хоть на каждый снапшот — перерисовка
   всё равно случится не чаще NUI_DRAW_MS. */
function netUIPlayers(){
  if(!NUI_ready) return;
  const t = NUI_now();
  if(t - NUI_lastDraw >= NUI_DRAW_MS){ NUI_lastDraw = t; NUI_draw(); return; }
  if(NUI_pend) return;
  NUI_pend = setTimeout(()=>{ NUI_pend = 0; NUI_lastDraw = NUI_now(); NUI_draw(); }, NUI_DRAW_MS);
}

function NUI_draw(){
  const n  = NUI_net();
  NUI_syncTeam();                      // ростер мог принести смену команды
  const me = NUI_collect();
  const host = NUI_hostId(me);
  const bots = n ? (n.botCount|0) : 0;

  // Счёт команд. Порядок доверия: то, что явно толкнули через netUIScore, —
  // затем NET.score, который транспорт держит по сообщению 'score'. Сумма
  // фрагов игроков — последняя подпорка: она не учитывает ботов и потому врёт
  // в меньшую сторону, но лучше показать её, чем пустое место.
  let blu = NUI_blu, red = NUI_red;
  if((blu < 0 || red < 0) && n && n.score){ blu = n.score.blu|0; red = n.score.red|0; }
  if(blu < 0 || red < 0){
    blu = 0; red = 0;
    for(let i=0;i<NUI_rows.length;i++){
      const p = NUI_rows[i];
      if((p.team|0) === 1) red += p.kills|0; else blu += p.kills|0;
    }
  }

  if(NUI_state === 'play'){
    if(blu !== NUI_bluShow){ NUI_bluShow = blu; const e = $('netScBlu'); if(e) e.textContent = blu; }
    if(red !== NUI_redShow){ NUI_redShow = red; const e = $('netScRed'); if(e) e.textContent = red; }
    const mine = NUI_myTeam();
    const tb = document.querySelector('#netTeams .nt.blu'), tr = document.querySelector('#netTeams .nt.red');
    if(tb) tb.classList.toggle('mine', mine !== 1);
    if(tr) tr.classList.toggle('mine', mine === 1);
  }

  if(NUI_state === 'lobby') NUI_drawLobby(me, host, bots);
  if(NUI_board)             NUI_drawBoard(me, host, bots, blu, red);
}

function NUI_drawLobby(me, host, bots){
  const list = $('netLobbyList');
  if(list){
    let h = '';
    for(let i=0;i<NUI_rows.length;i++){
      const p = NUI_rows[i];
      const isMe = (p.id|0) === me;
      h += '<div class="nplr '+NUI_teamCls(p.team)+(isMe?' me':'')+'">'
         +   '<span class="tag">'+NUI_teamName(p.team)+'</span>'
         +   '<span class="nm">'+NUI_esc(NUI_short(p.name))+'</span>'
         +   (isMe ? '<span class="you">ВЫ</span>' : '')
         +   ((p.id|0) === host ? '<span class="hostm">ХОСТ БОТОВ</span>' : '')
         +   '<span class="kd">'+(p.kills|0)+' / '+(p.deaths|0)+'</span>'
         + '</div>';
    }
    if(!h) h = '<div class="nplr empty">В КОМНАТЕ ПОКА НИКОГО</div>';
    list.innerHTML = h;
  }
  const bs = $('netLobbyBots');
  if(bs) bs.innerHTML = 'СВОБОДНЫЕ СЛОТЫ ЗАЙМУТ БОТЫ: <b>'+bots+'</b>';
  // Игрок только что выбирал сторону в брифинге и вправе не понять, почему он
  // оказался не там: говорим прямо, что команду выдала комната.
  const mt = $('netLobbyTeam');
  if(mt){
    const t = NUI_myTeam();
    mt.innerHTML = 'ВАША СТОРОНА: <span class="tside '+(t === 1 ? 'red' : 'blu')+'">'+
                   NUI_teamName(t)+'</span> — НАЗНАЧИЛ СЕРВЕР';
  }
}

function NUI_drawBoard(me, host, bots, blu, red){
  const n = NUI_net();
  const goal = n && n.goal ? (n.goal|0) : CFG.killGoal;
  const t = $('netBoardTitle');
  if(t) t.textContent = 'ТАБЛО · ДО '+goal+' ФРАГОВ';
  const b = $('netBoardBots');
  if(b) b.textContent = 'БОТОВ В КОМНАТЕ: '+bots;

  const body = $('netBoardBody');
  if(!body) return;
  let h = '', team = -1;
  for(let i=0;i<NUI_rows.length;i++){
    const p = NUI_rows[i], tm = p.team|0;
    if(tm !== team){
      team = tm;
      h += '<div class="nbTeam '+NUI_teamCls(tm)+'"><span>'+NUI_teamName(tm)+'</span><b>'
         + (tm === 1 ? red : blu)+'</b></div>';
    }
    const pg = NUI_ping(p, me);
    h += '<div class="nbRow '+NUI_teamCls(tm)+((p.id|0)===me?' me':'')+(p.alive===false?' dead':'')+'">'
       +   '<span class="nm">'+NUI_esc(NUI_short(p.name))+((p.id|0)===host?'<i class="hb">ХОСТ БОТОВ</i>':'')+'</span>'
       +   '<span>'+NUI_teamName(tm)+'</span>'
       +   '<span>'+(p.kills|0)+'</span>'
       +   '<span>'+(p.deaths|0)+'</span>'
       +   '<span>'+(pg >= 0 ? pg : '—')+'</span>'
       + '</div>';
  }
  if(!h) h = '<div class="nbEmpty">НЕТ ДАННЫХ О КОМНАТЕ</div>';
  body.innerHTML = h;
}

/* ------------------------------ ПИНГ ------------------------------ */
function netUIPing(ms){
  const v = Math.round(ms || 0);
  if(v === NUI_pingShow) return;       // приходит раз в 2 с, но DOM всё равно бережём
  NUI_pingShow = v;
  const el = $('netPing');
  if(!el) return;
  el.textContent = 'ПИНГ ' + v + ' МС';
  el.className = 'panel ' + (v < 80 ? 'good' : (v < 160 ? 'mid' : 'bad'));
}

/* Счёт команд с сервера (сообщение score). Отдельный вход, потому что в
   §6 у NET нет поля со счётом, а складывать фраги игроков нечестно: боты
   тоже приносят очки команде. */
function netUIScore(blu, red){
  NUI_blu = blu|0; NUI_red = red|0;
  netUIPlayers();
}

/* ------------------------------ СООБЩЕНИЯ ------------------------------ */
function netUIMessage(text, kind){
  const err = kind === 'error';
  const t = String(text == null ? '' : text);
  if(t) NUI_msgN++;
  if(err && t) NUI_gotErr = true;      // транспорт уже объяснился — не затираем его текст
  const m = $('netMsg');
  if(m){ m.textContent = t; m.classList.toggle('err', err); }
  const lm = $('netLobbyMsg');
  if(lm) lm.textContent = t;
  // в бою экран подключения не виден — говорим строкой статусов HUD
  if(t && game.state === 'play') setStatus('net', t.toUpperCase(), err ? '#d1493f' : '#e9c46a');
}

/* ------------------------------ СОСТОЯНИЕ ------------------------------ */
const NUI_STATE_TXT = {
  off:'НЕ ПОДКЛЮЧЕНО', connecting:'ПОДКЛЮЧЕНИЕ', lobby:'В КОМНАТЕ', play:'В БОЮ', error:'ОШИБКА СВЯЗИ'
};
const NUI_STATE_CLS = { off:'', connecting:'wait', lobby:'ok', play:'ok', error:'err' };

function netUISetState(s){
  if(!NUI_ready){ netUIInit(); if(!NUI_ready) return; }
  // строго свой ключ: чужая строка из транспорта не должна вытащить сюда
  // что-нибудь из прототипа Object и превратиться в подпись состояния
  const st = (typeof s === 'string' && NUI_STATE_TXT.hasOwnProperty(s)) ? s : 'off';
  NUI_state = st;
  if(NUI_watch){ clearTimeout(NUI_watch); NUI_watch = 0; }

  const line = $('netState');
  if(line){ line.textContent = NUI_STATE_TXT[st]; line.className = 'nstate ' + NUI_STATE_CLS[st]; }
  const btn = $('netPlayBtn');
  if(btn) btn.disabled = (st === 'connecting');

  const lobby = $('netLobby');
  if(lobby) lobby.classList.toggle('hide', st !== 'lobby');
  const hud = $('netHud');
  if(hud) hud.classList.toggle('hide', st !== 'play');
  if(st !== 'play') NUI_showBoard(false);

  // Лобби — полноэкранный экран поверх брифинга: два открытых экрана сразу
  // читаются как залипший интерфейс. Обратно брифинг возвращаем только если
  // бой не идёт — иначе накроем живой матч.
  const menu = $('menu');
  if(menu){
    if(st === 'lobby' || st === 'play') menu.classList.add('hide');
    else if(game.state !== 'play') menu.classList.remove('hide');
  }

  if(st === 'connecting'){
    NUI_watch = setTimeout(()=>{
      NUI_watch = 0;
      if(NUI_state !== 'connecting') return;
      netUISetState('error');
      netUIMessage('СЕРВЕР НЕ ОТВЕЧАЕТ — проверьте адрес и что сервер запущен', 'error');
    }, NUI_WAIT_MS);
  }
  if(st === 'off' || st === 'error'){
    NUI_pingShow = -1; NUI_bluShow = -1; NUI_redShow = -1;
    NUI_blu = -1; NUI_red = -1;
  }
  if(st === 'off') NUI_gotErr = false;
  if(st === 'play') clearStatus('net');
  // сторона: в комнате её держит сервер, вне комнаты возвращаем выбор игроку
  NUI_syncTeam();
  if(st === 'lobby' || st === 'play') netUIPlayers();
}

/* ------------------------------ ТАБЛО ------------------------------ */
function NUI_showBoard(on){
  if(on === NUI_board) return;
  NUI_board = on;
  const b = $('netBoard');
  if(b) b.classList.toggle('hide', !on);
  if(on) NUI_draw();
}
function NUI_canBoard(){ return NUI_on() && game.state === 'play'; }

/* ------------------------------ КИЛЛФИД ------------------------------ */
/* В сети в ленте обязаны стоять имена игроков: «RED СНАЙПЕР» из офлайна
   в комнате на четверых не говорит ничего. Цвет строки означает команду —
   тот же blu/red, что и везде; своё имя выделяем свечением, а не цветом. */
function netUIFeed(killerName, victimName, part, killerTeam, victimTeam){
  if(typeof addFeed !== 'function') return;
  const my = NUI_myName();
  const cls = t => (t === 1 || t === '1') ? 'r' : ((t === 0 || t === '0') ? 'b' : 'w');

  let k;
  if(killerName){
    const kn = NUI_short(killerName);
    k = '<span class="'+cls(killerTeam)+(kn === NUI_short(my) ? ' nfme' : '')+'">'+NUI_esc(kn)+'</span>';
  } else {
    // убийцы нет: смерть от огня, фугаса или падения
    k = '<span class="w">'+(part === 'burn' ? 'ОГОНЬ' : part === 'splash' ? 'ФУГАС'
        : part === 'fall' ? 'ПАДЕНИЕ' : 'МИР')+'</span>';
  }
  const vn = NUI_short(victimName);
  const v = '<span class="'+cls(victimTeam)+(vn === NUI_short(my) ? ' nfme' : '')+'">'+NUI_esc(vn)+'</span>';

  let tag = '';
  if(part === 'head')        tag = ' <span class="w">· ХЕДШОТ</span>';
  else if(part === 'splash') tag = ' <span class="w">· ФУГАС</span>';
  else if(part === 'burn')   tag = ' <span class="w">· ОГОНЬ</span>';
  else if(part === 'legs')   tag = ' <span class="w">· ПО НОГАМ</span>';
  addFeed(k + ' ✖ ' + v + tag);
}

/* ------------------------------ ДЕЙСТВИЯ ------------------------------ */
function NUI_connect(){
  const addrEl = $('netAddr'), nameEl = $('netName');
  const addr = addrEl ? String(addrEl.value||'').trim() : '';
  let name = nameEl ? String(nameEl.value||'').trim().slice(0, NUI_NAME_MAX) : '';
  if(!name) name = NUI_defName();
  if(nameEl) nameEl.value = name;
  try{
    localStorage.setItem(NUI_LS_NAME, name);
    localStorage.setItem(NUI_LS_ADDR, addr);
  }catch(e){}                                   // приватный режим — не повод падать

  const url = NUI_url(addr);
  NUI_gotErr = false;
  const said = NUI_msgN;               // транспорт обычно говорит подробнее — не перебиваем
  let p = null;
  try{
    if(typeof netConnect === 'function') p = netConnect(url, name);
    else { const n = NUI_net(); if(n && typeof n.connect === 'function') p = n.connect(url, name); }
  }catch(err){ p = Promise.reject(err); }

  if(!p){
    netUISetState('error');
    netUIMessage('СЕТЕВОЙ МОДУЛЬ НЕ СОБРАН — доступен только одиночный бой', 'error');
    return;
  }
  // транспорт мог уже успеть отказать синхронно и написать свою причину
  if(NUI_state !== 'error') netUISetState('connecting');
  if(NUI_msgN === said) netUIMessage('СОЕДИНЕНИЕ С ' + url, 'info');
  if(typeof p.then === 'function'){
    p.then(()=>{
      if(NUI_state === 'connecting') netUISetState('lobby');
    }, err=>{
      const why = NUI_reason(err);
      netUISetState('error');
      if(why) netUIMessage(why, 'error');
      else if(!NUI_gotErr) netUIMessage('НЕ УДАЛОСЬ ПОДКЛЮЧИТЬСЯ — сервер по этому адресу не отвечает', 'error');
    });
  }
}

function NUI_leave(){
  try{
    if(typeof netDisconnect === 'function') netDisconnect();
    else { const n = NUI_net(); if(n && typeof n.disconnect === 'function') n.disconnect('выход игрока'); }
  }catch(e){}
  // бой мог идти: возвращаем игрока в брифинг ровно так же, как кнопка «к брифингу»
  if(game.state === 'play'){
    game.state = 'menu';
    if(document.pointerLockElement) document.exitPointerLock();
    const h = $('hud'); if(h) h.classList.add('hide');
  }
  netUISetState('off');
  netUIMessage('ВЫ ВЫШЛИ ИЗ КОМНАТЫ', 'info');
}

/* ------------------------------ ЗАПУСК ------------------------------ */
function netUIInit(){
  if(NUI_ready) return;
  if(typeof document === 'undefined' || !$('netPlayBtn')) return;   // разметки нет — молчим
  NUI_ready = true;

  let savedA = '', savedN = '';
  try{
    savedA = localStorage.getItem(NUI_LS_ADDR) || '';
    savedN = localStorage.getItem(NUI_LS_NAME) || '';
  }catch(e){}

  // Адрес по умолчанию — тот, с которого открыта страница: сервер отдаёт и
  // игру, и сокет на одном порту, так что вводить обычно нечего вообще.
  // Пустой host бывает только при открытии файла с диска — там выручает
  // прошлый адрес, а если и его нет, localhost с портом по умолчанию.
  const addr = $('netAddr');
  if(addr) addr.value = location.host || savedA || 'localhost:8177';
  const name = $('netName');
  if(name) name.value = savedN || NUI_defName();

  const go = $('netPlayBtn');
  if(go) go.onclick = NUI_connect;
  const enter = e=>{ if(e.key === 'Enter'){ e.preventDefault(); NUI_connect(); } };
  if(addr) addr.addEventListener('keydown', enter);
  if(name) name.addEventListener('keydown', enter);

  const leave = $('netLeaveBtn');
  if(leave) leave.onclick = NUI_leave;
  const start = $('netStartBtn');
  // команду фиксируем ДО startGame(): по game.team выбираются точки респавна,
  // и подняться в чужой базе из-за порядка вызовов было бы обидно
  if(start) start.onclick = ()=>{ netUISetState('play'); NUI_syncTeam(); startGame(); };

  /* Табло на удержании Tab. Свой слушатель, а не хук в 90_game.js: там Tab
     уже гасится preventDefault, но состояние табло — наше дело.
     Отпускание клавиши можно и не получить (Alt+Tab уводит фокус вместе с
     нажатой клавишей), поэтому гасим табло на blur и на скрытии вкладки. */
  addEventListener('keydown', e=>{
    if(e.code !== 'Tab' || !NUI_canBoard()) return;
    e.preventDefault();
    if(!e.repeat) NUI_showBoard(true);
  });
  addEventListener('keyup', e=>{ if(e.code === 'Tab') NUI_showBoard(false); });
  addEventListener('blur', ()=> NUI_showBoard(false));
  document.addEventListener('visibilitychange', ()=>{ if(document.hidden) NUI_showBoard(false); });

  netUISetState('off');
}

/* bindUI() зовёт netUIInit() сам, но модуль обязан работать и без этого хука:
   разметка уже разобрана (скрипт стоит в конце body), а повторный вызов
   идемпотентен. Так экран подключения жив даже в сборке без сетевых хуков. */
try{ netUIInit(); }catch(e){}
