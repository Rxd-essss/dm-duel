/* =====================================================================
   DM_DUEL v3 — HUD. Всё, что рисуется поверх боя.

   Два правила, из которых вырос весь модуль:
   1. Центр экрана — рабочая зона снайпера. Кольца поражения и метки зон
      держим тонкими и полупрозрачными, плотное и яркое уводим на периферию.
   2. DOM трогаем только когда значение реально изменилось. updateAmmoHUD()
      зовётся каждый кадр из цикла, поэтому все подписи закешированы по
      числовому ключу — иначе получаем разбор innerHTML 60 раз в секунду.
   ===================================================================== */

/* ---- служебное состояние; всё внутреннее префиксовано HUD_ ---- */
const HUD_NOCD   = [0,0,0];          // подстраховка, пока wpn.cd не заведён
const HUD_slots  = [null,null,null]; // .slot пояса
const HUD_cdFill = [null,null,null]; // заливка отката внутри слота
const HUD_cdTxt  = [null,null,null]; // секунды до готовности
const HUD_beltNm = [null,null,null]; // подпись типа в слоте: «МАТЧ» / «СТРЕЛА»
const HUD_beltRf = [null,null,null]; // какой элемент AMMO в слоте уже нарисован
const HUD_prevCd = [0,0,0];          // остаток отката в прошлом кадре
const HUD_rdyT   = [0,0,0];          // таймер вспышки «снова готов»
const HUD_pct    = [-1,-1,-1];       // закешированная высота заливки
const HUD_dec    = [-1,-1,-1];       // закешированные десятые доли секунды
let HUD_ready = false;
let HUD_lastT = 0;                   // game.time прошлого кадра — свой dt
let HUD_numKey = -1, HUD_nameTxt = '', HUD_cdDecCur = -1;
let HUD_scKey = -1;
let HUD_xhCls = '';                  // класс цвета типа на марке (обеих марках)
let HUD_windArw = null;              // стрелка ветра: узел кэшируем, пишем раз в градус
let HUD_windDeg = 1e9;

function HUD_bind(){
  if(HUD_ready) return;
  for(let i=0;i<3;i++){
    HUD_slots[i]  = document.querySelector('#ammoBelt .slot[data-a="'+i+'"]');
    HUD_cdFill[i] = $('cdF'+i);
    HUD_cdTxt[i]  = $('cdT'+i);
    HUD_beltNm[i] = HUD_slots[i] ? HUD_slots[i].querySelector('.n') : null;
  }
  HUD_windArw = $('windArw');
  HUD_ready = !!HUD_slots[0];
}

/* Подписи пояса. У лука в тех же трёх слотах лежат стрелы, а не патроны, и
   написано там обязано быть то, что летит. Сравниваем по ссылке на элемент
   AMMO, а не по строке: содержимое AMMO подменяется на месте (setWeapon),
   поэтому смена ствола — это ровно смена трёх ссылок, и склейка ключа из
   строк каждый кадр была бы аллокацией на ровном месте. */
function HUD_paintBelt(){
  HUD_bind();
  for(let i=0;i<3;i++){
    const a = AMMO[i];
    if(a === HUD_beltRf[i]) continue;
    HUD_beltRf[i] = a;
    if(HUD_beltNm[i]) HUD_beltNm[i].textContent = a.short;
  }
}

/* ---------------------------- ТАЙМЕРЫ HUD ----------------------------
   Киллфид, вспышка урона и указатели направления живут на setTimeout.
   Матч можно перезапустить в любой момент, и отложенные колбэки прошлого
   боя иначе продолжают дёргать DOM уже нового. Поэтому все таймеры идут
   через один список, а рестарт гасит его целиком — clearHudTimers(). */
const HUD_timers = [];               // id живых setTimeout
const HUD_rafs   = [];               // id живых requestAnimationFrame
function HUD_after(fn, ms){
  const id = setTimeout(()=>{
    const i = HUD_timers.indexOf(id); if(i>=0) HUD_timers.splice(i,1);
    fn();
  }, ms);
  HUD_timers.push(id);
  return id;
}
function HUD_cancel(id){
  const i = HUD_timers.indexOf(id);
  if(i<0) return;                    // уже отработал или снят рестартом
  HUD_timers.splice(i,1);
  clearTimeout(id);
}
function HUD_nextFrame(fn){
  const id = requestAnimationFrame(()=>{
    const i = HUD_rafs.indexOf(id); if(i>=0) HUD_rafs.splice(i,1);
    fn();
  });
  HUD_rafs.push(id);
}
// зовёт H из startGame(): новый бой начинается с чистым HUD
function clearHudTimers(){
  for(let i=0;i<HUD_timers.length;i++) clearTimeout(HUD_timers[i]);
  HUD_timers.length = 0;
  for(let i=0;i<HUD_rafs.length;i++) cancelAnimationFrame(HUD_rafs[i]);
  HUD_rafs.length = 0;
  const f = $('feed'); if(f) f.textContent = '';
  const d = $('dirs'); if(d) d.textContent = '';
  // вспышка урона могла остаться зажжённой: её гасил как раз снятый таймер
  const v = $('dmgvig'); if(v){ v.style.opacity = 0; }
  HUD_dmgA = -1; HUD_dmgT = 0;
}

/* ============================ СТОРОНА ИГРОКА ============================
   На «Осаде» стороны устроены по-разному — камень против лесов, — поэтому
   выбор стороны это выбор рисунка боя, и он обязан читаться и до боя, и в бою.

   Раньше весь HUD исходил из «игрок всегда BLU, боты всегда RED»: фраги
   ложились в синюю плашку, смерти — в красную, «ВЫ» в ленте красилось синим
   при любом раскладе. Теперь плашки означают именно команды, а куда лечь
   нашим фрагам — решает game.team.

   Единый источник правды — game.team (литерал объявлен в 60_weapon.js).
   Пишут его двое: офлайн — выбор в брифинге, в сети — сервер (NETCONTRACT §6:
   команду назначает комната, пожеланий клиента протокол не несёт). Кто из
   двоих главнее, решается ровно здесь, в playerTeam(). */
const HUD_LS_TEAM = 'dmduel.team';
const HUD_TEAMS = [
  { tag:'BLU', place:'ОСАДНЫЙ ЛАГЕРЬ' },
  { tag:'RED', place:'ЗАМОК' }
];
let HUD_wantTeam  = 0;    // выбор игрока в брифинге; сервер его не затирает
let HUD_teamLock  = -1;   // команда, назначенная сервером; -1 — выбираем сами
let HUD_teamShown = -1;   // что уже нарисовано; -1 — перерисовать
let HUD_goalShown = -1;
let HUD_uiReady   = false;

/* NET_ACTIVE и NET живут в модулях, которых в сборке может не быть вовсе, а на
   верхнем уровне (наш init) NET_ACTIVE ещё во временной мёртвой зоне. Оба
   случая дают ReferenceError, и оба означают одно: сети нет. */
function HUD_netTeam(){
  try{ if(NET_ACTIVE && NET.on) return (NET.team|0) === 1 ? 1 : 0; }catch(e){}
  return -1;
}
function HUD_goal(){
  try{ if(NET_ACTIVE && NET.on && NET.goal > 0) return NET.goal|0; }catch(e){}
  return CFG.killGoal;
}
/* Эффективная сторона игрока, 0 = BLU, 1 = RED. Заодно синхронизирует
   game.team: читателю (респавн, ИИ, счёт) не должно быть важно, сетевой мы
   сейчас или нет — он смотрит одно поле и получает верный ответ. */
function playerTeam(){
  const n = HUD_netTeam();
  const t = n >= 0 ? n : ((game.team|0) === 1 ? 1 : 0);
  if((game.team|0) !== t) game.team = t;
  return t;
}
function foeTeam(){ return playerTeam() ^ 1; }
function teamTag(t){ return (t|0) === 1 ? 'RED' : 'BLU'; }
function teamFeedCls(t){ return (t|0) === 1 ? 'r' : 'b'; }

/* Перекраска HUD под сторону. Зовётся из updateScore и из кадрового
   updateAmmoHUD, поэтому первым делом — дешёвая проверка «ничего не изменилось»:
   сторона меняется раз в бой, цель матча — и того реже. */
function HUD_applyTeam(){
  const t = playerTeam(), g = HUD_goal();
  if(t === HUD_teamShown && g === HUD_goalShown) return t;
  const swapped = (t !== HUD_teamShown);
  HUD_teamShown = t; HUD_goalShown = g;
  const T = HUD_TEAMS[t];
  const h = $('hud');   if(h) h.classList.toggle('tRed', t === 1);
  const b = $('scBlu'); if(b) b.classList.toggle('mine', t === 0);
  const r = $('scRed'); if(r) r.classList.toggle('mine', t === 1);
  const os = $('objSide');
  if(os){ os.textContent = T.tag; os.classList.toggle('red', t === 1); }
  const ot = $('objTxt');
  if(ot) ot.textContent = T.place + '  •  ДО ' + g + ' ФРАГОВ';
  // плашки счёта поменялись ролями — закешированные числа в них больше не про то
  if(swapped){ HUD_scB = -1; HUD_scR = -1; HUD_paintTeamSel(); }
  return t;
}
/* Публичный сеттер: поставить сторону и перекрасить всё разом. */
function setTeamHUD(team){
  const t = (team|0) === 1 ? 1 : 0;
  if((game.team|0) !== t) game.team = t;
  HUD_teamShown = -1;
  HUD_applyTeam();
}
/* Выбор в брифинге. Запоминаем отдельно от game.team: назначенная сервером
   команда не должна стирать то, за кого игрок хочет играть офлайн. */
function teamChoice(){ return HUD_wantTeam; }
function setTeamChoice(team){
  HUD_wantTeam = (team|0) === 1 ? 1 : 0;
  try{ localStorage.setItem(HUD_LS_TEAM, HUD_wantTeam ? '1' : '0'); }catch(e){}
  if(HUD_teamLock < 0) setTeamHUD(HUD_wantTeam);
  HUD_paintTeamSel();
}
/* Сеть: команду выдал сервер. Карточки перестают быть кнопками и работают
   подписью. team < 0 (или null) снимает замок и возвращает выбор игроку. */
function lockTeamChoice(team){
  const t = (team === null || team === undefined || team < 0) ? -1 : ((team|0) === 1 ? 1 : 0);
  if(t === HUD_teamLock && HUD_teamShown >= 0) return;
  HUD_teamLock = t;
  setTeamHUD(t >= 0 ? t : HUD_wantTeam);
  HUD_paintTeamSel();
}

function HUD_paintTeamSel(){
  const sel = $('teamSel');
  const shown = HUD_teamLock >= 0 ? HUD_teamLock : HUD_wantTeam;
  if(sel){
    sel.classList.toggle('locked', HUD_teamLock >= 0);
    const bs = sel.querySelectorAll('.tm');
    for(let i=0;i<bs.length;i++) bs[i].classList.toggle('on', (+bs[i].dataset.t|0) === shown);
  }
  const net = $('teamNet');
  if(net){
    net.classList.toggle('hide', HUD_teamLock < 0);
    if(HUD_teamLock >= 0)
      net.innerHTML = 'КОМАНДУ ВЫДАЛ СЕРВЕР: <b>' + HUD_TEAMS[HUD_teamLock].tag +
                      '</b>. В сетевом бою комната делит стороны сама, и выбор в брифинге не действует.';
  }
  const btn = $('playBtn');
  if(btn) btn.textContent = 'В БОЙ ЗА ' + HUD_TEAMS[shown].tag;
}

function HUD_bindTeamUI(){
  const sel = $('teamSel'); if(!sel) return;
  const bs = sel.querySelectorAll('.tm');
  for(let i=0;i<bs.length;i++){
    const b = bs[i];
    // замок проверяем в обработчике, а не снятием onclick: состояние сети
    // меняется в любой момент, и пересобирать привязки на каждое сообщение глупо
    b.onclick = ()=>{ if(HUD_teamLock < 0) setTeamChoice(+b.dataset.t); };
  }
}

/* ============================== ОРУЖИЕ ==============================
   Стволов два, и они играются по-разному: винтовка бьёт почти прямо и смотрит
   в оптику, лук вынуждает брать выше цели и тянуть тетиву. Значит выбор ствола
   — решение того же веса, что сторона и сложность, и стоит он там же.

   Единственный источник правды — game.weapon (литерал в 60_weapon.js).
   Всё, что зависит от ствола (боекомплект, пояс, марка, раскладка), читается
   из WPNS/AMMO и НИГДЕ не дублируется текстом: рабочий массив AMMO подменяет
   на месте setWeapon() из ядра, и второй экземпляр этих строк в разметке
   однажды разойдётся с оружием. */
const HUD_LS_WPN = 'dmduel.weapon';
/* Проза про каждый тип — по id боеприпаса, а не по индексу слота: у лука в
   тех же трёх слотах лежат стрелы. Цифры не повторяем: их несёт AMMO[i].stat. */
const HUD_AMMO_DESC = {
  match:'Скорость, малое падение и снос. <b>Единственный с полным критом в голову</b>.',
  frag:'Подрыв площадью, <b>крита нет вообще</b>: максимум в эпицентре, за укрытием '+
       'вдвое меньше. Тяжёлая пуля проседает — берите выше.',
  fire:'Прямой урон слабый, но цель <b>горит</b> и за углом. Промах оставляет очаг '+
       'на подходе.',
  arrow:'Самая настильная из трёх — и всё равно втрое медленнее пули. '+
        '<b>Единственная с полным критом в голову</b>. Недотянутый лук бьёт вразброс.',
  bomb:'Летит ниже и медленнее всех, упреждение берите вдвое. <b>Крита нет вообще</b>, '+
       'зато накрывает площадью — ею выкуривают из-за зубцов.',
  flame:'Прямой урон слабый, но цель <b>горит</b> и за углом; промах поджигает подход.'
};
/* Одна строка под карточками — как в этом бою работает ЛКМ. Ровно одна:
   подвал брифинга и так впритык, а подробности лежат в колонке раскладки. */
const HUD_WPN_LMB = [
  '<b>ЛКМ</b> — выстрел, <b>ПКМ</b> — оптика.',
  '<b>ЛКМ</b> — держать и отпустить: тянут тетиву, потом пускают.'
];
let HUD_wantWpn  = 0;    // выбор игрока в брифинге
let HUD_wpnShown = -1;   // какой ствол уже нарисован; -1 — перерисовать

function weaponChoice(){ return HUD_wantWpn; }
/* Выбор в брифинге. Пишем и в game.weapon, и в localStorage, и сразу
   подменяем рабочий AMMO: карточки боекомплекта, пояс и марка обязаны
   показывать выбранный ствол ДО начала боя, а не после startGame(). */
function setWeaponChoice(i){
  HUD_wantWpn = (i|0) === 1 ? 1 : 0;
  try{ localStorage.setItem(HUD_LS_WPN, HUD_wantWpn ? '1' : '0'); }catch(e){}
  game.weapon = HUD_wantWpn;
  if(typeof setWeapon === 'function') setWeapon(HUD_wantWpn);
  HUD_wpnShown = -1;
  HUD_syncWeapon();
}
/* Дешёвая проверка «ствол тот же» — зовётся каждый кадр из updateAmmoHUD:
   game.weapon может смениться и мимо брифинга (рестарт, сеть), а HUD не имеет
   права остаться с чужой маркой и чужими подписями. */
function HUD_syncWeapon(){
  const i = (game.weapon|0) === 1 ? 1 : 0;
  if(i === HUD_wpnShown) return i;
  HUD_wpnShown = i;
  const w = WPNS[i];
  // один класс на body: марка, оптика и шкала натяга переключаются в CSS,
  // а не пятью правками узлов по месту
  if(document.body) document.body.classList.toggle('bow', !!w.bow);
  HUD_paintWpnSel();
  HUD_paintAmmoCards();
  HUD_paintBelt();
  // подписи и заливки закешированы по числам — числа те же, а смысл другой
  HUD_numKey = -1; HUD_nameTxt = ''; HUD_scKey = -1; HUD_cdDecCur = -1; HUD_aimCapK = -1;
  for(let k=0;k<3;k++){ HUD_pct[k] = -1; HUD_dec[k] = -1; }
  if(typeof updateReticle === 'function') updateReticle();
  return i;
}
/* Карточки боекомплекта в брифинге. Имя, откат, статистика — из AMMO
   выбранного ствола; своя здесь только проза про роль типа. */
function HUD_paintAmmoCards(){
  const list = weaponOf(game.weapon).ammo;
  for(let i=0;i<3;i++){
    const a = list[i]; if(!a) continue;
    const n = $('an'+i); if(n) n.textContent = (i+1)+' · '+a.name;
    const e = $('ae'+i);
    if(e) e.textContent = a.cd > 0 ? ('ОТКАТ '+(a.cd.toFixed(1).replace('.0',''))+' С') : 'БЕЗ ОТКАТА';
    const d = $('ad'+i); if(d) d.innerHTML = HUD_AMMO_DESC[a.id] || '';
    // строку stat заполняет и bindUI() из 90_game.js — из того же AMMO, тем же
    // текстом; расходиться им не на чем
    const s = $('s'+(i+1)); if(s) s.textContent = a.stat;
  }
}
/* Карточки выбора ствола и всё, что в брифинге зависит от ствола. */
function HUD_paintWpnSel(){
  const sel = $('wpnSel');
  if(sel){
    const bs = sel.querySelectorAll('.wm');
    for(let i=0;i<bs.length;i++) bs[i].classList.toggle('on', (+bs[i].dataset.w|0) === HUD_wpnShown);
  }
  for(let i=0;i<WPNS.length;i++){
    const w = WPNS[i];
    // короткое имя, а не полное: карточки стоят по две в ряд, и «СНАЙПЕРСКАЯ
    // ВИНТОВКА» ломается на две строки. Полное имя игрок видит в панели патронов
    const n = $('wn'+i); if(n) n.textContent = w.short;
    const d = $('wd'+i); if(d) d.textContent = w.hint;
    const t = $('wt'+i);
    // подпись «чем берёт» собираем из полей ствола: правка drawTime в ядре
    // иначе молча оставит здесь враньё
    if(t) t.textContent = w.scope ? 'ОПТИКА · ПЛОСКО'
                                  : ('ДУГА · НАТЯГ '+(+w.drawTime).toFixed(2)+' С');
  }
  const bow = !!WPNS[HUD_wpnShown < 0 ? 0 : HUD_wpnShown].bow;
  const h = $('wpnHint'); if(h) h.innerHTML = HUD_WPN_LMB[bow ? 1 : 0];
  HUD_txt('ammoSec',   bow ? 'Колчан' : 'Боекомплект');
  HUD_txt('ctlFire',   bow ? 'ЛКМ — держать, отпустить' : 'ЛКМ');
  HUD_txt('ctlScopeV', bow ? 'у лука её нет' : 'ПКМ');
  HUD_txt('ctlAmmoK',  bow ? 'Тип стрелы' : 'Тип патрона');
  HUD_txt('ruleChargeV', bow ? 'растёт с натягом' : 'растёт с зарядом');
  HUD_txt('ruleAimK',    bow ? 'Недотянутая тетива' : 'Стрельба без оптики');
  HUD_txt('ruleAimV',    bow ? 'слабее, медленнее, вразброс' : 'большой разброс');
  HUD_txt('balDropK',    bow ? 'Стрела летит по дуге' : 'Пуля летит по дуге');
  HUD_txt('balDropV',    bow ? 'просадка около 6 м на 100 м' : 'время полёта + падение');
  HUD_txt('balRetK',     bow ? 'Метки дуги у марки' : 'Метки сетки оптики');
  HUD_txt('balRetV',     bow ? HUD_HOLD_R[0]+' · '+HUD_HOLD_R[1]+' · '+HUD_HOLD_R[2]+' м'
                             : '50 … 300 м, шаг 50');
  HUD_txt('balWindV',    bow ? 'сносит стрелу вдвое сильнее' : 'случайный на бой');
  HUD_txt('pauseWpnV',   bow ? 'боевой лук' : 'снайперская винтовка');
  HUD_off('rowScope', bow); HUD_off('rowZoom', bow); HUD_off('rowHold', bow);
  HUD_off('rowRange', bow);
  const rd = $('rowDraw'); if(rd) rd.classList.toggle('hide', !bow);
}
function HUD_txt(id, s){ const e = $(id); if(e && e.textContent !== s) e.textContent = s; }
function HUD_off(id, on){ const e = $(id); if(e) e.classList.toggle('off', on); }

function HUD_bindWpnUI(){
  const sel = $('wpnSel'); if(!sel) return;
  const bs = sel.querySelectorAll('.wm');
  for(let i=0;i<bs.length;i++){
    const b = bs[i];
    b.onclick = ()=> setWeaponChoice(+b.dataset.w);
  }
}

/* ---------------------------- ПОЛНЫЙ ЭКРАН ----------------------------
   Механику держит 90_game.js (toggleFullscreen / isFullscreen / клавиша F),
   за нами кнопки. Их две — в брифинге и в паузе, — поэтому общий класс .fsbtn,
   а id 'fsBtn' стоит на главной: по нему подпись синхронизирует GM_fsSync.
   Свой синхронизатор нужен второй кнопке и пишет ровно тот же текст, так что
   два обработчика на одно событие друг другу не мешают. */
function HUD_fsSync(){
  let on = false;
  try{
    on = (typeof isFullscreen === 'function') ? isFullscreen()
       : !!(document.fullscreenElement || document.webkitFullscreenElement);
  }catch(e){}
  const txt = on ? 'ОКНО' : 'ВО ВЕСЬ ЭКРАН';
  const bs = document.querySelectorAll('.fsbtn');
  for(let i=0;i<bs.length;i++) if(bs[i].textContent !== txt) bs[i].textContent = txt;
}
function HUD_bindFsUI(){
  const bs = document.querySelectorAll('.fsbtn');
  if(!bs.length) return;
  for(let i=0;i<bs.length;i++)
    bs[i].onclick = ()=>{ if(typeof toggleFullscreen === 'function') toggleFullscreen(); };
  document.addEventListener('fullscreenchange', HUD_fsSync);
  document.addEventListener('webkitfullscreenchange', HUD_fsSync);
  HUD_fsSync();
}

/* Разметку брифинга поднимаем сами: bindUI() из 90_game.js про выбор стороны
   не знает, а трогать чужой модуль ради одной привязки нельзя. Вызов
   идемпотентен — скрипт стоит в конце body, разметка уже разобрана. */
function hudInit(){
  if(HUD_uiReady) return;
  if(typeof document === 'undefined' || !$('teamSel')) return;
  HUD_uiReady = true;
  let saved = null;
  try{ saved = localStorage.getItem(HUD_LS_TEAM); }catch(e){}   // приватный режим — не повод падать
  HUD_wantTeam = (saved === '1') ? 1 : 0;
  // высоты этажей в брифинге берём из CFG: две цифры, разъехавшиеся с картой,
  // хуже, чем их отсутствие
  const f1 = $('mapF1'); if(f1) f1.textContent = (+CFG.floor1).toFixed(1);
  const f2 = $('mapF2'); if(f2) f2.textContent = String(+CFG.floor2);
  HUD_bindTeamUI();
  setTeamHUD(HUD_wantTeam);
  HUD_paintTeamSel();
  /* Оружие ставим ДО boot(): bindUI() из 90_game.js заполняет строки stat из
     рабочего AMMO, и к этому моменту в нём обязан лежать уже выбранный ствол,
     иначе игрок с сохранённым луком увидит в карточках цифры винтовки. */
  let savedW = null;
  try{ savedW = localStorage.getItem(HUD_LS_WPN); }catch(e){}
  HUD_bindWpnUI();
  HUD_bindFsUI();
  setWeaponChoice((savedW === '1') ? 1 : 0);
}

/* ------------------------------ ЗДОРОВЬЕ ------------------------------ */
function updateHP(){
  const hp = Math.max(0, Math.round(player.hp));
  $('hpNum').textContent = hp;
  $('hpNum').classList.toggle('low', hp<=35);
  $('hpBar').style.width = clamp(hp,0,100)+'%';
  $('lowhp').style.opacity = hp<=35 ? (1-hp/35)*0.9 : 0;
}

/* ------------------------- СТРОКА СТАТУСОВ ------------------------- */
/* Ключ -> строка. Статус живёт HUD_STATUS_TTL секунд с последнего
   setStatus: тот, кто хочет держать его постоянно (откат, горение),
   просто зовёт сеттер каждый кадр — повторный вызов с тем же текстом
   в DOM ничего не пишет. Так забытый статус не виснет на экране навсегда. */
const HUD_STATUS_TTL = 2.6;
const HUD_STATUS_MAX = 5;
const HUD_status = {};
let HUD_statusSeq = 0;
function setStatus(key, text, color){
  const box = $('status'); if(!box) return;
  let s = HUD_status[key];
  if(!s){
    // столбик статусов не должен расти в стену: вытесняем самый старый
    let n = 0, oldK = null, oldS = 1e9;
    for(const k in HUD_status){ n++; if(HUD_status[k].seq < oldS){ oldS = HUD_status[k].seq; oldK = k; } }
    if(n >= HUD_STATUS_MAX && oldK) clearStatus(oldK);
    const el = document.createElement('div');
    el.className = 'st';
    box.appendChild(el);
    s = HUD_status[key] = { el:el, txt:null, col:null, ttl:0, seq:++HUD_statusSeq };
  }
  if(s.txt !== text){ s.txt = text; s.el.textContent = text; }
  const c = color || '#e9c46a';
  if(s.col !== c){ s.col = c; s.el.style.color = c; s.el.style.borderLeftColor = c; }
  s.ttl = HUD_STATUS_TTL;
}
function clearStatus(key){
  const s = HUD_status[key];
  if(!s) return;
  if(s.el.parentNode) s.el.parentNode.removeChild(s.el);
  delete HUD_status[key];
}
function HUD_tickStatus(dt){
  if(dt<=0) return;
  for(const k in HUD_status){
    const s = HUD_status[k];
    s.ttl -= dt;
    if(s.ttl<=0) clearStatus(k);
  }
}

/* --------------------------- РЫВОК И ГОРЕНИЕ --------------------------- */
let HUD_dashPct = -1, HUD_dashRdy = null, HUD_dashAge = 99;
function HUD_applyDash(ratio, ready){
  const pct = Math.round(clamp(ratio,0,1)*100);
  if(pct !== HUD_dashPct){ HUD_dashPct = pct; $('dashFill').style.width = pct+'%'; }
  if(ready !== HUD_dashRdy){
    HUD_dashRdy = ready;
    const d = $('dash');
    d.classList.toggle('ready', ready);
    d.classList.toggle('charging', !ready);
  }
}
// шкалу зовёт паркур из updatePlayer; ready — можно ли рвануть прямо сейчас
function setDashHUD(ratio, ready){
  HUD_dashAge = 0;
  HUD_applyDash(ratio, ready===undefined ? (ratio>=1) : !!ready);
}

/* ------------------------------ НАТЯГ ЛУКА ------------------------------
   Шкалу и кольцо марки ведёт оружейный модуль: только он знает, сколько уже
   натянуто и с какого момента выстрел идёт в полную силу. HUD рисует ровно
   то, что ему сказали, и гасит шкалу сам, если сеттер перестали звать —
   отпущенная тетива не должна оставлять на экране застывшую полосу.

   Кольцо марки — не украшение: недотянутый лук бьёт вразброс, и радиус
   кольца это и показывает. На полном натяге кольцо замыкается и золотеет. */
let HUD_drawPct = -1, HUD_drawFull = null, HUD_drawOn = null;
let HUD_drawAge = 99, HUD_ringPx = -1;
const HUD_RING_MIN = 9;     // радиус кольца на полном натяге, px
const HUD_RING_MAX = 35;    // и на отпущенной тетиве
function HUD_applyDraw(r, full){
  const pct = Math.round(r*100);
  if(pct !== HUD_drawPct){
    HUD_drawPct = pct;
    const f = $('drawFill'); if(f) f.style.width = pct+'%';
    const c = $('drawCap');  if(c) c.textContent = full ? 'ПОЛНЫЙ НАТЯГ' : 'НАТЯГ '+pct+'%';
    // радиус кольца ведём в целых пикселях: доли на глаз не читаются,
    // а лишняя запись в style — это лишний пересчёт стиля каждый кадр
    const px = Math.round(HUD_RING_MIN + (1-r)*(HUD_RING_MAX-HUD_RING_MIN));
    if(px !== HUD_ringPx){
      HUD_ringPx = px;
      const g = $('xhRing');
      if(g){ const d = px*2; g.style.width = d+'px'; g.style.height = d+'px'; }
    }
  }
  if(full !== HUD_drawFull){
    HUD_drawFull = full;
    const w = $('drawWrap'); if(w) w.classList.toggle('full', full);
    const b = $('xhBow');    if(b) b.classList.toggle('full', full);
  }
  // пока не тянут — полосы нет вовсе: центр экрана это рабочая зона
  const on = r > 0.001;
  if(on !== HUD_drawOn){
    HUD_drawOn = on;
    const w = $('drawWrap'); if(w) w.classList.toggle('on', on);
  }
}
/* Публичный сеттер для оружейного модуля. ratio 0..1 — насколько натянут лук,
   ready — можно ли уже пускать в полную силу (по умолчанию «натянут до конца»). */
function setDrawHUD(ratio, ready){
  HUD_drawAge = 0;
  const r = clamp(+ratio || 0, 0, 1);
  HUD_applyDraw(r, ready===undefined ? (r >= 0.999) : !!ready);
}

let HUD_burnOn = false, HUD_burnExt = false;
function HUD_applyBurn(on){
  if(on === HUD_burnOn) return;
  HUD_burnOn = on;
  $('burnvig').classList.toggle('on', on);
  if(!on) clearStatus('burn');
}
// виньетку зовёт боевой модуль при поджоге и при затухании
function setBurnHUD(on){ HUD_burnExt = !!on; HUD_applyBurn(HUD_burnExt || player.burn>0); }

/* ------------------- ЗОНА ПОРАЖЕНИЯ ВОКРУГ ПРИЦЕЛА ------------------- */
/* Фугас и зажигательный бьют площадью, и без подсказки игрок не понимает,
   накрыл он укрытие или нет. Рисуем радиус в экранных координатах на
   дальности точки прицеливания: r_px = f * R / d. */
let HUD_aimT = 0, HUD_aimD = 60, HUD_aimOut = -1, HUD_aimIn = -1, HUD_aimCapK = -1;
function HUD_updateAim(dt, a, cooling){
  const z = $('aimZone');
  /* Признак берём по полям, а не по id: у лука те же три роли называются
     'bomb' и 'flame', и сравнение с 'frag' молча гасило бы кольцо у взрывной
     стрелы. Площадь есть у того, у кого есть радиус. */
  const frag = a.splashR > 0;
  const R = frag ? a.splashR : (a.poolR > 0 ? a.poolR : 0);
  const show = R>0 && game.state==='play' && player.alive && wpn.rel<=0;
  // прячем целиком: с типом без площади (матчевый) на экране не должно
  // оставаться ни кольца, ни его приглушённого следа
  if(!show){ if(HUD_aimOut!==-2){ HUD_aimOut=-2; z.className=''; HUD_aimCapK=-1; } return; }
  if(HUD_aimOut===-2) HUD_aimOut = -1;

  // Дальность до точки прицеливания берём из общего кэша оружейного модуля:
  // дальномер бьёт тот же луч из камеры, и раньше мы гоняли rayBoxes по всем
  // коробкам дважды. camRayDist сам держит частоту пересчёта (0.06 с).
  HUD_aimT -= dt;
  if(HUD_aimT<=0){
    HUD_aimT = 0.06;
    HUD_aimD = Math.max(2.0, camRayDist(300));
  }
  const f = (H/2)/Math.tan(camera.fov*Math.PI/360);
  const rOut = clamp(f*R/HUD_aimD, 10, Math.min(W,H)*0.34);
  const near = HUD_aimD < R*1.7;                 // сам в зоне подрыва
  const dOut = Math.round(rOut*2);
  // внутреннее кольцо фугаса: там осколки ещё снимают половину максимума
  const dIn  = Math.round(rOut*0.74);

  z.classList.add('on');
  z.classList.toggle('frag', frag);
  z.classList.toggle('fire', !frag);
  z.classList.toggle('cool', !!cooling);
  z.classList.toggle('near', near);
  z.classList.toggle('wide', rOut > Math.min(W,H)*0.22);

  if(dOut !== HUD_aimOut){
    HUD_aimOut = dOut;
    const e = $('aimOut'); e.style.width = dOut+'px'; e.style.height = dOut+'px';
    $('aimCap').style.transform = 'translate(-50%,'+Math.round(rOut+10)+'px)';
  }
  if(dIn !== HUD_aimIn){
    HUD_aimIn = dIn;
    const e = $('aimIn'); e.style.width = dIn+'px'; e.style.height = dIn+'px';
  }
  const capK = (frag?1:2)*4 + (near?2:0) + (cooling?1:0);
  if(capK !== HUD_aimCapK){
    HUD_aimCapK = capK;
    // подпись берёт короткое имя типа: «ФУГАС» у винтовки, «ВЗРЫВ» у лука
    $('aimCap').textContent = cooling ? 'ОТКАТ'
      : near ? 'СЛИШКОМ БЛИЗКО'
      : (frag ? a.short+' · R '+a.splashR.toFixed(1)+' М'
              : 'ОЧАГ ОГНЯ · R '+a.poolR.toFixed(1)+' М');
  }
}

/* ---------------------- ПОЯС, ОТКАТЫ, СЧЁТЧИКИ ---------------------- */
function updateAmmoHUD(){
  HUD_bind();
  // сторона могла смениться между кадрами (сервер прислал команду) — проверка
  // стоит одно сравнение, зато HUD не остаётся покрашенным в чужой цвет
  HUD_applyTeam();
  // то же и про ствол: смена оружия — это смена подписей пояса и марки
  HUD_syncWeapon();
  HUD_paintBelt();
  const a = A();
  const cds = wpn.cd || HUD_NOCD;

  // свой dt: updateAmmoHUD зовётся из цикла каждый кадр, а на паузе game.time стоит
  let dt = 0;
  if(game.state==='play') dt = clamp(game.time - HUD_lastT, 0, 0.1);
  HUD_lastT = game.time;

  // счётчик патронов: innerHTML только при смене чисел
  const numKey = (wpn.idx*64 + wpn.loaded[wpn.idx])*64 + wpn.res[wpn.idx];
  if(numKey !== HUD_numKey){
    HUD_numKey = numKey;
    $('ammoNum').innerHTML = wpn.loaded[wpn.idx] + '<small>/'+wpn.res[wpn.idx]+'</small>';
  }
  if(HUD_nameTxt !== a.name){ HUD_nameTxt = a.name; $('ammoName').textContent = a.name; }

  // слоты пояса: заливка отката, секунды, гашение
  for(let i=0;i<3;i++){
    const s = HUD_slots[i]; if(!s) continue;
    const total = AMMO[i].cd || 0;
    const left  = cds[i] > 0 ? cds[i] : 0;
    s.classList.toggle('act', i===wpn.idx);
    s.classList.toggle('empty', wpn.loaded[i]===0 && wpn.res[i]===0);
    s.classList.toggle('cool', left>0);
    const pct = total>0 ? Math.round(clamp(left/total,0,1)*100) : 0;
    if(pct !== HUD_pct[i]){ HUD_pct[i] = pct; HUD_cdFill[i].style.height = pct+'%'; }
    const dec = left>0 ? Math.ceil(left*10) : 0;
    if(dec !== HUD_dec[i]){
      HUD_dec[i] = dec;
      HUD_cdTxt[i].textContent = dec>99 ? Math.ceil(dec/10)+'' : (dec>0 ? (dec/10).toFixed(1) : '');
    }
    // тип снова готов — короткая вспышка слота. dt>0 отсекает сброс на
    // старте матча: там откаты обнуляют разом, и это не «готовность»
    if(dt>0 && HUD_prevCd[i]>0 && left<=0){ HUD_rdyT[i] = 0.5; s.classList.add('rdy'); }
    HUD_prevCd[i] = left;
    if(HUD_rdyT[i]>0){ HUD_rdyT[i] -= dt; if(HUD_rdyT[i]<=0) s.classList.remove('rdy'); }
  }

  // Откат выбранного типа: за нами только строка #ammoCd у счётчика патронов.
  // Статус слева по ключу 'cd' ведёт оружейный модуль — он округляет остаток
  // иначе, и два владельца одного ключа переписывали строку дважды за кадр,
  // да ещё и разными цифрами. Ровно так же делегирован ключ 'burn'.
  const cdNow = cds[wpn.idx] > 0 ? cds[wpn.idx] : 0;
  const cdDec = cdNow>0 ? Math.ceil(cdNow*10) : 0;
  if(cdDec !== HUD_cdDecCur){
    HUD_cdDecCur = cdDec;
    const el = $('ammoCd');
    el.classList.toggle('on', cdDec>0);
    if(cdDec>0) el.textContent = 'ОТКАТ '+(cdDec/10).toFixed(1)+' С';
  }

  // Горение: за нами только виньетка. Текст статуса с остатком секунд ведёт
  // боевой модуль по тому же ключу 'burn' — вторая надпись отсюда дралась бы
  // с ним за DOM каждый кадр.
  HUD_applyBurn(HUD_burnExt || player.burn>0);

  // шкала рывка: если паркур ещё не дёргал сеттер, ведём её сами
  HUD_dashAge += dt;
  if(HUD_dashAge>0.4 && typeof player.dashCd === 'number'){
    const full = CFG.dashCd || 1;
    HUD_applyDash(1 - player.dashCd/full, player.dashCd<=0);
  }

  /* Натяг. Пока оружейный модуль зовёт setDrawHUD, шкалу ведёт он. Если не
     зовёт — ведём сами по wpn.draw, ровно как шкалу рывка по player.dashCd:
     HUD не имеет права остаться пустым только потому, что чужой модуль пока
     не знает про сеттер. И отпущенная тетива не должна оставлять на экране
     застывшую полосу. */
  HUD_drawAge += dt;
  if(HUD_drawAge > 0.25){
    const d = (HUD_wpnShown === 1 && typeof wpn.draw === 'number') ? clamp(wpn.draw, 0, 1) : 0;
    HUD_applyDraw(d, d >= 0.999);
  }

  // подпись в оптике: тип, боезапас или остаток отката
  if(wpn.sT>0.6){
    const scKey = ((wpn.idx*512 + cdDec)*64 + wpn.loaded[wpn.idx])*64 + wpn.res[wpn.idx];
    if(scKey !== HUD_scKey){
      HUD_scKey = scKey;
      const el = $('scopeInfo');
      el.textContent = cdDec>0 ? a.short+' · ОТКАТ '+(cdDec/10).toFixed(1)
                               : a.short+' · '+wpn.loaded[wpn.idx]+' / '+wpn.res[wpn.idx];
      el.classList.toggle('cool', cdDec>0);
    }
  }

  // марка: точка красится в цвет типа. Марки две — крест винтовки и кольцо
  // лука; кольцу класс кладём через classList, иначе им же смахнём .full
  const cls = 'a'+(wpn.idx+1);
  if(cls !== HUD_xhCls){
    const prev = HUD_xhCls; HUD_xhCls = cls;
    const xh = $('xh'); if(xh) xh.className = cls;
    const xb = $('xhBow');
    if(xb){ if(prev) xb.classList.remove(prev); xb.classList.add(cls); }
  }

  HUD_updateAim(dt, a, cdNow>0);
  HUD_tickStatus(dt);
}

/* ------------------------------ СЧЁТ ------------------------------ */
/* Плашки счёта означают команды, а не «мои фраги / мои смерти»: раньше фраги
   игрока безусловно шли в синюю, и за RED панель врала в обе стороны. Офлайн
   смерти игрока — это и есть фраги противоположной стороны, других источников
   очков у неё нет; в сети командный счёт живёт отдельно (#netTeams), а здесь
   остаётся личная дуэль — но уже в правильных цветах. */
let HUD_scB = -1, HUD_scR = -1;
function updateScore(){
  const my = HUD_applyTeam();
  const mine = game.kills|0, theirs = game.deaths|0;
  const blu = my === 1 ? theirs : mine;
  const red = my === 1 ? mine   : theirs;
  if(blu !== HUD_scB){ HUD_scB = blu; $('scBlu').textContent = blu; }
  if(red !== HUD_scR){ HUD_scR = red; $('scRed').textContent = red; }
}
/* Единственная правка, которую addFeed имеет право вносить, — нейтрализация
   МИРОВЫХ причин смерти. Огонь, фугас, падение — не команда, но авторы строк
   обязаны хоть как-то их покрасить: 75_combat.js берёт цвет чужой стороны
   (для него это просто «не мы»), 92_net.js пишет их красным всегда. В ленте
   это читается как чужой фраг — «меня кто-то застрелил», хотя убил очаг или
   собственный фугас. Сводим такие строки к нейтральному золоту.

   ЦВЕТА КОМАНД НЕ ТРОГАЕМ И ТРОГАТЬ НЕЛЬЗЯ. Здесь стоял переворот классов
   b<->r и подписи «RED СНАЙПЕР» для игры за RED. Он был нужен ровно до тех
   пор, пока лента собиралась намертво под «игрок — BLU, боты — RED». Сейчас
   AI_meTag/AI_botTag (70_ai.js) и CMB_meTag/CMB_botTag (75_combat.js) сами
   выдают класс по команде игрока и по команде ботов, а сетевые строки несут
   настоящие команды игроков. Любая перекраска здесь переворачивает уже верные
   цвета: при игре за RED «ВЫ» уезжало в синий, а BLU-бот — в красный, то есть
   подпись говорила «BLU СНАЙПЕР» красными буквами. Лента обязана оставаться
   прозрачной для цвета — цвет назначает автор строки. */
const HUD_FEED_WORLD = /<span class="[br]">(ОГОНЬ|ФУГАС|ПАДЕНИЕ|МИР)<\/span>/g;
function HUD_feedFix(html){
  return String(html).replace(HUD_FEED_WORLD, '<span class="w">$1</span>');
}
function addFeed(html){
  const f = $('feed');
  const d = document.createElement('div'); d.className='fe'; d.innerHTML=HUD_feedFix(html);
  f.appendChild(d);
  while(f.children.length>5) f.removeChild(f.firstChild);
  HUD_after(()=>{ if(d.parentNode) d.parentNode.removeChild(d); }, 5200);
}
let toastT=0;
function toast(t, sub){
  const el = $('toast');
  el.innerHTML = t + (sub? '<span class="sub">'+sub+'</span>' : '');
  el.style.opacity = 1; toastT = 1.6;
}
let hitT=0;
function hitMarker(crit){
  const h = $('hitmark');
  h.classList.toggle('crit', !!crit);
  h.style.opacity = 1; hitT = crit?0.45:0.28;
}
/* Вспышка урона. Тень нарисована в CSS раз и навсегда, здесь меняется одна
   opacity: слой уже растеризован и композится на GPU. Перекраска box-shadow
   на весь экран стоила полной перерисовки — а при горении она прилетала
   каждые полсекунды. */
let HUD_dmgA = -1, HUD_dmgT = 0;
function dmgFlash(d){
  const v = $('dmgvig');
  const a = clamp(d/60,0.25,1);
  if(a !== HUD_dmgA){ HUD_dmgA = a; v.style.opacity = a; }
  // попадание подряд продлевает вспышку, а не гасит её чужим таймером
  if(HUD_dmgT) HUD_cancel(HUD_dmgT);
  HUD_dmgT = HUD_after(()=>{ HUD_dmgT = 0; HUD_dmgA = 0; v.style.opacity = 0; }, 260);
}
function dirIndicator(from){
  const d = $('dirs');
  const el = document.createElement('div'); el.className='dind';
  const dx=from.x-player.pos.x, dz=from.z-player.pos.z;
  const fw = -dx*Math.sin(player.yaw) - dz*Math.cos(player.yaw);
  const rt =  dx*Math.cos(player.yaw) - dz*Math.sin(player.yaw);
  el.style.transform = 'rotate('+(Math.atan2(rt,fw)*180/Math.PI)+'deg)';
  d.appendChild(el);
  HUD_nextFrame(()=>{ el.style.transition='opacity 1.1s'; el.style.opacity=1;
    HUD_after(()=>{ el.style.opacity=0; HUD_after(()=>el.remove(), 1200); }, 500); });
}

/* ------------------------------ ОПТИКА ------------------------------ */
/* Сетка чёрная, как у настоящей оптики, но на тёмном рельефе чёрное
   пропадает. Поэтому каждая линия рисуется дважды: сначала широкий
   светлый подбой, поверх — тонкая тёмная жила. Читается и на небе,
   и на скале. */
const HUD_RET_DK = '#0d1a0d', HUD_RET_MD = '#16240f', HUD_RET_HL = 'rgba(238,246,222,0.34)';
function HUD_ln(x1,y1,x2,y2,w,col){
  const p = ' x1="'+x1.toFixed(2)+'" y1="'+y1.toFixed(2)+'" x2="'+x2.toFixed(2)+'" y2="'+y2.toFixed(2)+'"';
  return '<line'+p+' stroke="'+HUD_RET_HL+'" stroke-width="'+(w+0.55).toFixed(2)+'"/>'
       + '<line'+p+' stroke="'+col+'" stroke-width="'+w.toFixed(2)+'"/>';
}
function HUD_tx(x,y,size,col,txt,anchor){
  return '<text x="'+x.toFixed(2)+'" y="'+y.toFixed(2)+'" font-size="'+size+'" fill="'+col+'"'
       + ' font-family="Arial,Helvetica,sans-serif" text-anchor="'+(anchor||'start')+'"'
       + ' stroke="rgba(238,246,222,0.40)" stroke-width="0.45" paint-order="stroke fill">'+txt+'</text>';
}
/* Падение снаряда на дальности r, в метрах. Модель та же, что у баллистики
   оружейного модуля: скорость съедает сопротивление, время полёта уточняем
   одной итерацией. Считают по ней и метки оптики, и метки дуги лука —
   разъехаться этим двум сеткам нельзя. */
function HUD_drop(a, r){
  let t = r/a.v; t = r/(a.v*(1-a.drag*t*0.5));
  return 0.5*CFG.bulletG*a.gMul*t*t;
}
/* Дальности меток. У лука стрела на трёхстах метрах уже не боеприпас, а
   навесной подарок — шкалу сжимаем под реальные дистанции боя из лука. */
const HUD_HOLD_R    = [40, 70, 100];                 // метки под маркой лука
const HUD_RNG_RIFLE = [50,100,150,200,250,300];
const HUD_RNG_BOW   = [20, 40, 60, 80, 100, 120];

/* Метки просадки под маркой лука. Оптики у лука нет, а держать поправку в
   голове невозможно: на сотне метров стрела проседает метров на шесть, и без
   опорных штрихов «выше цели» превращается в гадание. Пересчитываем при смене
   типа стрелы, обзора и размера окна — updateReticle зовут ровно тогда. */
function HUD_bowMarks(a){
  const hold = $('xhHold'); if(!hold) return;
  /* До первого onResize (и у скрытой вкладки) H равен нулю, и все три метки
     сложились бы в одну точку под центром — а перерисовать их некому до
     следующей смены типа. Берём запасную высоту: она всё равно уточнится
     первым же onResize, который зовёт updateReticle. */
  const vh = H > 1 ? H : (window.innerHeight || 720);
  const f = (vh/2)/Math.tan(game.fov*Math.PI/360);  // пикселей на радиан у центра
  const kids = hold.children;
  for(let i=0;i<kids.length && i<HUD_HOLD_R.length;i++){
    const r = HUD_HOLD_R[i];
    const el = kids[i];
    el.style.top = Math.round(f*HUD_drop(a, r)/r)+'px';
    const b = el.firstChild;
    if(b) b.textContent = String(r);
  }
}

function updateReticle(){
  const a = A();
  const bow = !!weaponOf(game.weapon).bow;
  if(bow) HUD_bowMarks(a);
  const fov = ZOOMS[wpn.zoom];
  const f = (H/2)/Math.tan(fov*Math.PI/360);
  const lensPx = 0.80*Math.min(W,H);
  const k = 100/lensPx;                      // экранные пиксели -> единицы viewBox
  const col = HUD_RET_DK, col2 = HUD_RET_MD;
  const tint = '#'+a.col.toString(16).padStart(6,'0');
  let s = '';

  // обод и толстые сектора по краю — глаз сразу ловит центр линзы
  s += '<circle cx="50" cy="50" r="49.4" fill="none" stroke="'+col+'" stroke-width="0.7" opacity="0.55"/>';
  s += HUD_ln(50,1.2,50,44, 0.62, col);
  s += HUD_ln(50,56,50,98.8, 0.62, col);
  s += HUD_ln(1.2,50,44,50, 0.62, col);
  s += HUD_ln(56,50,98.8,50, 0.62, col);

  // мил-метки сноса: каждая третья длиннее и подписана
  for(let i=1;i<=6;i++){
    const x = 50 + i*3.2, h = (i%3===0) ? 1.5 : 0.85;
    s += HUD_ln(x,50-h,x,50+h, 0.42, col2);
    s += HUD_ln(100-x,50-h,100-x,50+h, 0.42, col2);
    if(i%3===0){
      s += HUD_tx(x, 50+3.6, 2.3, col2, i, 'middle');
      s += HUD_tx(100-x, 50+3.6, 2.3, col2, i, 'middle');
    }
  }

  // метки падения пули под текущий боеприпас и кратность — в цвет типа
  const ranges = bow ? HUD_RNG_BOW : HUD_RNG_RIFLE;
  for(const r of ranges){
    const drop = HUD_drop(a, r);
    const y = 50 + f*Math.tan(Math.atan(drop/r))*k;
    if(y>96.5) break;
    if(y<52.5) continue;
    const half = (r%100===0) ? 4.2 : 2.6;
    s += HUD_ln(50-half,y,50+half,y, 0.55, col);
    // у лука шкала вдвое короче, и подписана каждая метка: неподписанных
    // ориентиров на такой дуге не хватает
    if(bow || r%50===0) s += HUD_tx(50+half+1.4, y+0.9, 2.6, tint, r);
  }

  // центральная точка: цвет заряженного типа, чтобы не искать глазами пояс
  s += '<circle cx="50" cy="50" r="1.15" fill="rgba(10,14,8,0.55)"/>';
  s += '<circle cx="50" cy="50" r="0.62" fill="'+tint+'" stroke="'+col+'" stroke-width="0.22"/>';

  $('retSvg').innerHTML = s;
  HUD_scKey = -1;                    // подпись в оптике пересобрать на следующем кадре
}

/* ------------------------------ ВЕТЕР ------------------------------ */
function updateWind(){
  wind.dir = rnd(0,Math.PI*2);
  wind.mag = rnd(0.2,1.8);
  wind.x = Math.cos(wind.dir)*wind.mag; wind.z = Math.sin(wind.dir)*wind.mag;
  $('windTxt').textContent = 'ВЕТЕР '+wind.mag.toFixed(1);
}
/* Зовётся каждый кадр. Стрелка поворачивается вслед за взглядом, но глаз
   не различает доли градуса: держим узел под рукой и пишем transform только
   при смене целого градуса — иначе это сборка строки и инвалидация стиля
   шестьдесят раз в секунду впустую. */
function updateWindHUD(){
  if(!HUD_windArw){ HUD_bind(); if(!HUD_windArw) return; }
  const fw = -wind.x*Math.sin(player.yaw) - wind.z*Math.cos(player.yaw);
  const rt =  wind.x*Math.cos(player.yaw) - wind.z*Math.sin(player.yaw);
  const deg = Math.round(Math.atan2(rt,fw)*180/Math.PI - 90);
  if(deg === HUD_windDeg) return;
  HUD_windDeg = deg;
  HUD_windArw.style.transform = 'rotate('+deg+'deg)';
}

/* ------------------------------ ИГРОК: ЦИКЛ ------------------------------ */

/* Свой кусок брифинга (выбор стороны) поднимаем на месте: скрипт стоит в конце
   body, разметка уже разобрана, а bindUI() из 90_game.js про него не знает.
   Падать здесь нельзя ни при каких условиях — это верхний уровень модуля,
   и исключение унесло бы с собой всё, что грузится после. */
try{ hudInit(); }catch(e){}
