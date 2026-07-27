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
const HUD_prevCd = [0,0,0];          // остаток отката в прошлом кадре
const HUD_rdyT   = [0,0,0];          // таймер вспышки «снова готов»
const HUD_pct    = [-1,-1,-1];       // закешированная высота заливки
const HUD_dec    = [-1,-1,-1];       // закешированные десятые доли секунды
let HUD_ready = false;
let HUD_lastT = 0;                   // game.time прошлого кадра — свой dt
let HUD_numKey = -1, HUD_nameTxt = '', HUD_cdDecCur = -1;
let HUD_scKey = -1;
let HUD_windArw = null;              // стрелка ветра: узел кэшируем, пишем раз в градус
let HUD_windDeg = 1e9;

function HUD_bind(){
  if(HUD_ready) return;
  for(let i=0;i<3;i++){
    HUD_slots[i]  = document.querySelector('#ammoBelt .slot[data-a="'+i+'"]');
    HUD_cdFill[i] = $('cdF'+i);
    HUD_cdTxt[i]  = $('cdT'+i);
  }
  HUD_windArw = $('windArw');
  HUD_ready = !!HUD_slots[0];
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
  const R = a.id==='frag' ? a.splashR : (a.id==='fire' ? a.poolR : 0);
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
  z.classList.toggle('frag', a.id==='frag');
  z.classList.toggle('fire', a.id==='fire');
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
  const capK = (a.id==='frag'?1:2)*4 + (near?2:0) + (cooling?1:0);
  if(capK !== HUD_aimCapK){
    HUD_aimCapK = capK;
    $('aimCap').textContent = cooling ? 'ОТКАТ'
      : near ? 'СЛИШКОМ БЛИЗКО'
      : (a.id==='frag' ? 'ФУГАС · R '+a.splashR.toFixed(1)+' М'
                       : 'ОЧАГ ОГНЯ · R '+a.poolR.toFixed(1)+' М');
  }
}

/* ---------------------- ПОЯС, ОТКАТЫ, СЧЁТЧИКИ ---------------------- */
function updateAmmoHUD(){
  HUD_bind();
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

  // марка: точка красится в цвет типа
  const xh = $('xh');
  const cls = 'a'+(wpn.idx+1);
  if(xh.className !== cls) xh.className = cls;

  HUD_updateAim(dt, a, cdNow>0);
  HUD_tickStatus(dt);
}

/* ------------------------------ СЧЁТ ------------------------------ */
function updateScore(){
  $('scBlu').textContent = game.kills; $('scRed').textContent = game.deaths;
}
function addFeed(html){
  const f = $('feed');
  const d = document.createElement('div'); d.className='fe'; d.innerHTML=html;
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
function updateReticle(){
  const a = A();
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
  const ranges = [50,100,150,200,250,300];
  for(const r of ranges){
    let t = r/a.v; t = r/(a.v*(1-a.drag*t*0.5));
    const drop = 0.5*CFG.bulletG*a.gMul*t*t;
    const y = 50 + f*Math.tan(Math.atan(drop/r))*k;
    if(y>96.5) break;
    if(y<52.5) continue;
    const half = (r%100===0) ? 4.2 : 2.6;
    s += HUD_ln(50-half,y,50+half,y, 0.55, col);
    if(r%50===0) s += HUD_tx(50+half+1.4, y+0.9, 2.6, tint, r);
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
