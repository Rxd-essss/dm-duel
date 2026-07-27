/* =====================================================================
   DM_DUEL v3 — ядро: конфиг, боекомплект, сложность, утилиты, звук.
   Этот модуль — общий фундамент. Остальные модули только читают отсюда
   значения и не объявляют здесь ничего своего.
   ===================================================================== */

if (typeof THREE === 'undefined') {
  document.getElementById('loadNote').textContent =
    'НЕ УДАЛОСЬ ЗАГРУЗИТЬ THREE.JS С CDN — ПРОВЕРЬТЕ ПОДКЛЮЧЕНИЕ К СЕТИ';
  throw new Error('three.js missing');
}

/* ------------------------------ КОНФИГ ------------------------------ */
const CFG = {
  half: 88,            // половина игровой зоны (за ней скалы)
  gravity: 23,         // гравитация персонажа (аркадная)
  bulletG: 11.0,       // гравитация пули (масштаб «на глаз», но честная дуга)
  radius: 0.42,
  height: 1.80, crouchH: 1.12,
  eye: 0.14,           // насколько глаза ниже макушки
  walk: 5.6, sprint: 8.8, crouch: 2.5, scoped: 2.1,
  accel: 68, airAccel: 26, friction: 9.5,
  jump: 7.5, step: 0.45,
  chargeMax: 2.2,      // секунд до полного заряда выстрела
  killGoal: 20,

  /* --- аркадная подвижность (v3) --- */
  coyote: 0.13,        // сколько ещё можно прыгнуть после схода с края
  jumpBuf: 0.15,       // насколько заранее засчитывается нажатие прыжка
  airJumps: 1,         // дополнительных прыжков в воздухе (магический толчок)
  airJumpV: 6.4,
  mantleMin: 0.50,     // подтягивание: диапазон высоты уступа над ногами
  mantleMax: 2.15,
  mantleReach: 1.05,   // насколько далеко вперёд ищем уступ
  mantleTime: 0.30,    // длительность анимации подтягивания
  slideSpeed: 11.2,    // стартовая скорость подката
  slideTime: 0.85,
  slideFric: 3.4,
  slideH: 0.95,
  dashSpeed: 15.5,     // магический рывок
  dashTime: 0.17,
  dashCd: 3.6,
  climbSpeed: 3.8,     // скорость по лестнице
  zipSpeed: 15.0,      // скорость по тросу
  bridgeSway: 0.055    // амплитуда качания навесных мостиков
};

const PAL = {
  red: 0xb8383b, redDk: 0x76262a, blu: 0x5885a2, bluDk: 0x33566d,
  wood: 0x9b6a3c, woodDk: 0x6a4525, plank: 0xb08350,
  metal: 0x8e8d85, metalDk: 0x585751, rust: 0x9c5430,
  conc: 0xa79c86, concDk: 0x7b7364,
  sand: 0xc0a86c, rock: 0x8d8274, rockDk: 0x6c6357,
  skin: 0xd7a172, khaki: 0xb9a87c, khakiDk: 0x8f8059,
  leather: 0x5b4029, dark: 0x2e2a25, glassDk: 0x16242b,
  grass: 0x7d8b48, dirt: 0x977f56, hay: 0xd0b45a,
  // магическая палитра: руны, кристаллы, эфир
  arcane: 0x62d8ff, arcaneDk: 0x1d6f96, ember: 0xff8a3c,
  rune: 0x9be8ff, wisp: 0xa8ffd8, violet: 0xa878e8, gold: 0xe9c46a
};

/* Три типа боеприпаса. Балансная идея:
     match — надёжность и дальность (эталон), единственный с полным критом;
     frag  — площадь: выкуривает из-за укрытия, крита нет, урон падает от эпицентра;
     fire  — контроль территории отложенным уроном, длинный откат.
   Поле cd — персональный откат типа: тикает всегда, даже если выбран другой тип. */
const AMMO = [
  { id:'match', name:'МАТЧЕВЫЙ', short:'МАТЧ', col:0xf0d47a, trail:0xffe9a8,
    v:300, drag:0.020, gMul:0.85, windMul:0.85,
    dmgMin:34, dmgMax:90, mag:5, res:45, resMax:45, reload:2.3, bolt:1.10,
    spread:2.6, crit:true, cd:0,
    stat:'V0 300 м/с · урон 34→90 · крит в голову · магазин 5 · затвор 1.1 с' },

  { id:'frag', name:'ФУГАСНЫЙ', short:'ФУГАС', col:0xe08a4a, trail:0xffb072,
    v:212, drag:0.045, gMul:1.45, windMul:1.30,
    dmgMin:20, dmgMax:44, mag:3, res:18, resMax:18, reload:3.1, bolt:1.55,
    spread:3.4, crit:false, cd:2.5,
    splashR:5.2, splashMax:58, splashFall:1.5, splashCover:0.45,
    stat:'V0 212 м/с · прямой 20→44 · фугас до 58 в R 5.2 м · без крита · откат 2.5 с' },

  { id:'fire', name:'ЗАЖИГАТЕЛЬНЫЙ', short:'ЗАЖИГ', col:0xe2593f, trail:0xff8b4a,
    v:256, drag:0.030, gMul:1.10, windMul:1.05,
    dmgMin:18, dmgMax:38, mag:4, res:28, resMax:28, reload:2.7, bolt:1.30,
    spread:3.0, crit:true, cd:5.0,
    burnDps:11, burnTime:6, poolR:3.2, poolTime:8, poolDps:14,
    stat:'V0 256 м/с · прямой 18→38 + горение 11/с × 6 с · очаг огня 8 с · откат 5 с' }
];

/* Сложность. Поля v3: flank — склонность к обходу, squad — командная
   координация, climb — готовность лезть на ярусы, sup — подавляющий огонь. */
const DIFFS = {
  easy:   { name:'НОВОБРАНЕЦ', react:[1.05,1.7], err:2.4, hs:0.05, charge:[1.7,2.5], bots:3, respawn:9.0, dmg:0.75, see:110, lead:0.55,
            flank:0.20, squad:false, climb:0.25, sup:0.10,
            hint:'Противник долго целится, часто мажет и почти не бьёт в голову.' },
  normal: { name:'СНАЙПЕР',    react:[0.6,1.05], err:1.25, hs:0.15, charge:[1.15,1.8], bots:4, respawn:7.0, dmg:1.0, see:135, lead:0.8,
            flank:0.55, squad:true,  climb:0.60, sup:0.35,
            hint:'Четверо RED держат ярусы, обходят по мосткам и берут упреждение.' },
  hard:   { name:'ЛЕГЕНДА',    react:[0.32,0.6], err:0.62, hs:0.28, charge:[0.8,1.2], bots:5, respawn:5.5, dmg:1.2, see:170, lead:1.0,
            flank:0.85, squad:true,  climb:0.90, sup:0.60,
            hint:'Пятеро ветеранов: лезут наверх, окружают, давят подавляющим огнём.' }
};

/* ------------------------------ УТИЛИТЫ ------------------------------ */
const clamp = (v,a,b)=> v<a?a:(v>b?b:v);
const lerp  = (a,b,t)=> a+(b-a)*t;
const rnd   = (a,b)=> a+Math.random()*(b-a);
const rint  = (a,b)=> Math.floor(rnd(a,b+1));
const pick  = a => a[Math.floor(Math.random()*a.length)];
const smoothstep = (e0,e1,x)=>{ const t=clamp((x-e0)/(e1-e0),0,1); return t*t*(3-2*t); };
const damp  = (a,b,l,dt)=> lerp(a,b,1-Math.exp(-l*dt));
const fmtTime = s => Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');
const V = (x,y,z)=> new THREE.Vector3(x,y,z);
const $ = id => document.getElementById(id);
const keys = {};

/* Единая формула фугасного урона — ею пользуются и оружие, и эффекты,
   и ИИ при оценке опасности. d — расстояние до эпицентра, R — радиус.
   covered=true, если между эпицентром и целью нет прямой видимости. */
function splashDamage(d, R, maxDmg, fall, covered, coverMul){
  if(d >= R) return 0;
  let v = maxDmg * Math.pow(1 - d/R, fall===undefined ? 1.5 : fall);
  if(covered) v *= (coverMul===undefined ? 0.45 : coverMul);
  return v;
}

/* ------------------------------ ЗВУК ------------------------------ */
const SFX = {
  ctx:null, master:null, vol:0.7, buf:null,
  init(){
    if(this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.vol;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 8;
    this.master.connect(comp); comp.connect(this.ctx.destination);
    const n = this.ctx.sampleRate*2;
    this.buf = this.ctx.createBuffer(1,n,this.ctx.sampleRate);
    const d = this.buf.getChannelData(0);
    for(let i=0;i<n;i++) d[i] = Math.random()*2-1;
  },
  setVol(v){ this.vol=v; if(this.master) this.master.gain.value=v; },
  resume(){ if(this.ctx && this.ctx.state==='suspended') this.ctx.resume(); },
  _out(delay,pan){
    const g = this.ctx.createGain();
    if(this.ctx.createStereoPanner){ const p=this.ctx.createStereoPanner(); p.pan.value=clamp(pan||0,-1,1); g.connect(p); p.connect(this.master); }
    else g.connect(this.master);
    return g;
  },
  noise(o){
    if(!this.ctx) return;
    const t0=this.ctx.currentTime+(o.delay||0), dur=o.dur||0.2;
    const s=this.ctx.createBufferSource(); s.buffer=this.buf; s.loop=true;
    const f=this.ctx.createBiquadFilter(); f.type=o.type||'bandpass';
    f.frequency.setValueAtTime(o.f||900,t0); f.Q.value=o.q||1;
    if(o.f2) f.frequency.exponentialRampToValueAtTime(Math.max(40,o.f2), t0+dur);
    const g=this.ctx.createGain();
    g.gain.setValueAtTime(0.0001,t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002,o.g||0.3), t0+(o.atk||0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t0+dur);
    s.connect(f); f.connect(g); g.connect(this._out(0,o.pan));
    s.start(t0); s.stop(t0+dur+0.05);
  },
  tone(o){
    if(!this.ctx) return;
    const t0=this.ctx.currentTime+(o.delay||0), dur=o.dur||0.2;
    const s=this.ctx.createOscillator(); s.type=o.type||'sine';
    s.frequency.setValueAtTime(o.f||440,t0);
    if(o.f2) s.frequency.exponentialRampToValueAtTime(Math.max(20,o.f2), t0+dur);
    const g=this.ctx.createGain();
    g.gain.setValueAtTime(0.0001,t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002,o.g||0.2), t0+(o.atk||0.006));
    g.gain.exponentialRampToValueAtTime(0.0001, t0+dur);
    s.connect(g); g.connect(this._out(0,o.pan));
    s.start(t0); s.stop(t0+dur+0.05);
  },
  // выстрел: резкий щелчок + низкий удар + «хвост» эха над долиной
  shot(k,pan,vol,delay){
    vol=vol===undefined?1:vol; delay=delay||0; pan=pan||0;
    this.noise({dur:0.10,f:2600,f2:700,q:0.7,g:0.55*vol,pan,delay});
    this.tone({f:170,f2:52,dur:0.20,type:'triangle',g:0.42*vol,pan,delay});
    if(k==='frag') this.tone({f:95,f2:40,dur:0.26,type:'sawtooth',g:0.28*vol,pan,delay});
    if(k==='fire') this.noise({dur:0.22,f:1500,f2:420,q:2,g:0.22*vol,pan,delay});
    this.noise({dur:0.55,f:600,f2:180,q:0.5,g:0.14*vol,pan,delay:delay+0.09});
    this.noise({dur:0.9,f:340,f2:120,q:0.4,g:0.07*vol,pan,delay:delay+0.26});
  },
  bolt(){ this.noise({dur:0.05,f:3200,q:3,g:0.20}); this.noise({dur:0.07,f:1500,q:4,g:0.16,delay:0.16}); },
  reloadS(){ this.noise({dur:0.06,f:1200,q:3,g:0.16}); this.noise({dur:0.05,f:2600,q:4,g:0.14,delay:0.3}); },
  hit(){ this.tone({f:1500,f2:900,dur:0.06,type:'square',g:0.16}); },
  crit(){ [0,0.06,0.12].forEach((d,i)=> this.tone({f:900+i*420,dur:0.16,type:'square',g:0.16,delay:d})); },
  boom(pan,vol,delay){ vol=vol===undefined?1:vol;
    this.noise({dur:0.55,f:900,f2:70,q:0.6,g:0.6*vol,pan,delay});
    this.tone({f:110,f2:28,dur:0.7,type:'sine',g:0.5*vol,pan,delay}); },
  flame(pan,vol){ this.noise({dur:0.5,f:700,f2:260,q:1.2,g:0.16*(vol||1),pan}); },
  hurt(){ this.noise({dur:0.16,f:420,f2:150,q:1,g:0.4}); this.tone({f:160,f2:70,dur:0.25,type:'sawtooth',g:0.18}); },
  whiz(pan){ this.tone({f:2200,f2:600,dur:0.14,type:'sine',g:0.14,pan}); },
  step(){ this.noise({dur:0.07,f:260,q:1.4,g:0.10}); },
  land(){ this.noise({dur:0.13,f:180,q:1,g:0.22}); },
  scopeIn(){ this.tone({f:640,f2:1250,dur:0.09,type:'square',g:0.10}); },
  scopeOut(){ this.tone({f:1250,f2:640,dur:0.09,type:'square',g:0.09}); },
  dry(){ this.noise({dur:0.04,f:2400,q:5,g:0.14}); },
  pickup(){ this.tone({f:520,f2:1040,dur:0.16,type:'square',g:0.16}); },
  spawn(){ this.tone({f:300,f2:700,dur:0.3,type:'triangle',g:0.2}); },

  /* ---- v3: подвижность и магия ---- */
  // подтягивание на уступ: скрип ткани + короткий удар ладонями
  mantle(){ this.noise({dur:0.14,f:520,f2:220,q:1.2,g:0.20}); this.noise({dur:0.07,f:1600,q:2,g:0.13,delay:0.12}); },
  // подкат по гравию
  slide(){ this.noise({dur:0.55,f:1100,f2:300,q:0.8,g:0.24}); },
  // магический рывок: восходящий свип + звон
  dash(){ this.tone({f:280,f2:1150,dur:0.20,type:'sawtooth',g:0.18});
          this.tone({f:1750,f2:2600,dur:0.26,type:'sine',g:0.11,delay:0.02});
          this.noise({dur:0.24,f:2400,f2:900,q:1.4,g:0.13}); },
  // перехват троса и скольжение по нему
  zip(){ this.noise({dur:0.10,f:2800,q:4,g:0.18}); this.tone({f:420,f2:900,dur:0.2,type:'square',g:0.10}); },
  zipRide(pan){ this.noise({dur:0.30,f:3200,f2:2200,q:6,g:0.07,pan}); },
  // перехват перекладины лестницы
  climb(){ this.noise({dur:0.06,f:900,q:3,g:0.10}); },
  // доска навесного мостика под ногой
  plank(pan){ this.noise({dur:0.09,f:340,f2:180,q:1.6,g:0.13,pan}); this.tone({f:150,f2:90,dur:0.12,type:'triangle',g:0.07,pan}); },
  // руны/кристаллы: чистый переливающийся звон
  chime(pan,vol){ vol=vol===undefined?1:vol;
    [0,0.05,0.11].forEach((d,i)=> this.tone({f:1200+i*380,f2:1400+i*380,dur:0.5,type:'sine',g:0.055*vol,pan,delay:d})); },
  // тип патрона снова готов к выстрелу
  ready(){ this.tone({f:880,f2:1320,dur:0.11,type:'square',g:0.10}); this.tone({f:1320,dur:0.09,type:'sine',g:0.07,delay:0.09}); },
  // попытка выстрелить типом, который на откате
  blocked(){ this.tone({f:220,f2:150,dur:0.10,type:'square',g:0.10}); },
  // игрок горит
  burn(){ this.noise({dur:0.35,f:800,f2:300,q:1.5,g:0.13}); }
};
