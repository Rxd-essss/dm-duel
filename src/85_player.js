/* =====================================================================
   ИГРОК: аркадное движение и паркур.
   Идея баланса: инерция читаемая (разгон/трение как в v2), но любая ошибка
   по таймингу прощается — coyote-time, буфер прыжка, доп. прыжок. Скорость
   набирается спринтом, подкатом и рывком, а не случайными багами физики.
   ===================================================================== */

/* временные вектора модуля — в кадре не аллоцируем */
const PLR_p1 = new THREE.Vector3(), PLR_p2 = new THREE.Vector3();
const PLR_mA = new THREE.Vector3(), PLR_mB = new THREE.Vector3();

/* разобранный ввод текущего кадра: wx/wz — нормаль направления движения,
   ax/az — «куда рвусь» (ввод важнее взгляда, но без ввода — взгляд) */
const PLR_in = { wx:0, wz:0, wl:0, mf:0, mr:0, ax:0, az:0 };

let PLR_ready = false;      // поля паркура объявляет 60_weapon.js — подстраховка на случай их отсутствия
let PLR_roll = 0;           // наклон камеры на подкате
let PLR_fovK = 0;           // «панч» поля зрения на рывке
let PLR_fovAdd = 0, PLR_fovSet = -1;   // сколько градусов добавили к FOV в прошлый раз
let PLR_slideCd = 0;        // чтобы подкат нельзя было спамить
let PLR_slideDust = 0;
let PLR_climbLock = 0, PLR_zipLock = 0;
let PLR_zipT = 0, PLR_zipDir = 1, PLR_zipSnd = 0;
let PLR_climbSnd = 0, PLR_prevY = 0;
let PLR_pushT = 0, PLR_mantleTry = 0;
let PLR_lastX = 0, PLR_lastY = 0, PLR_lastZ = 0;   // куда паркур поставил игрока в прошлый кадр
let PLR_qHeld = false;
let PLR_dashX = 0, PLR_dashZ = 0;
let PLR_prevX = 0, PLR_prevZ = 0;
/* экран смерти: узел ищем один раз, а секунды пишем только когда целое
   поменялось — за смерть это 3 записи вместо 180 */
let PLR_deadEl = null, PLR_deadShown = -1, PLR_wasAlive = true;

function PLR_setup(){
  PLR_ready = true;
  const def = { dashCd:0, dashT:0, slideT:0, mantleT:0, airJumps:0, coyote:0, jumpBuf:0, burn:0 };
  for(const k in def) if(player[k] === undefined) player[k] = def[k];
  if(player.climb === undefined)  player.climb = null;
  if(player.zip === undefined)    player.zip = null;
  if(player.burnFx === undefined) player.burnFx = null;
  if(player.noGrav === undefined) player.noGrav = false;
}
// смерть/респаун не должны утаскивать за собой трос или лестницу
function PLR_clearParkour(){
  player.zip = null; player.climb = null;
  player.mantleT = 0; player.slideT = 0; player.dashT = 0;
  player.noGrav = false; player.jumpBuf = 0; player.coyote = 0;
  player.airJumps = 0;
  PLR_pushT = 0; PLR_roll = 0; PLR_fovK = 0;
  // откаты паркура во время смерти не тикают — обнуляем, иначе на респавне
  // полсекунды нельзя схватиться за трос или лестницу
  PLR_slideCd = 0; PLR_climbLock = 0; PLR_zipLock = 0; PLR_mantleTry = 0;
}
// заряд рывка — в конце кадра, чтобы HUD показывал уже случившийся рывок,
// а не состояние до него
function PLR_dashHUD(){
  if(typeof setDashHUD === 'function') setDashHUD(1 - player.dashCd/CFG.dashCd, player.dashCd <= 0);
}
/* Трос и подтягивание сами двигают игрока, поэтому обязаны замечать,
   что его переставили извне (респаун, рестарт матча): иначе следующий кадр
   утащит его обратно на трос. */
function PLR_teleported(){
  return Math.abs(player.pos.x-PLR_lastX) + Math.abs(player.pos.y-PLR_lastY) +
         Math.abs(player.pos.z-PLR_lastZ) > 3;
}
function PLR_mark(){ PLR_lastX = player.pos.x; PLR_lastY = player.pos.y; PLR_lastZ = player.pos.z; }
// FX.magic/FX.ring приезжают вместе с 55_fx.js v3; без них паркур обязан работать
function PLR_fx(p, n, col, ring){
  if(FX.magic) FX.magic(p, n, col);
  if(ring && FX.ring) FX.ring(p, ring, col);
}
/* Есть ли место дорасти до высоты h. Смотрим только слой между нынешней
   макушкой и будущей: бордюр под ногами, через который перешагнули, не должен
   мешать разогнуться. */
function PLR_room(h){
  const y0 = player.pos.y + player.h - 0.02, y1 = player.pos.y + h;
  for(let i=0;i<BOXES.length;i++){
    const b = BOXES[i];
    if(b.top <= y0 || b.bot >= y1) continue;
    if(player.pos.x < b.aMin.x-0.6 || player.pos.x > b.aMax.x+0.6 ||
       player.pos.z < b.aMin.z-0.6 || player.pos.z > b.aMax.z+0.6) continue;
    const lx = b.lx(player.pos.x, player.pos.z), lz = b.lz(player.pos.x, player.pos.z);
    if(Math.abs(lx) < b.hx+CFG.radius && Math.abs(lz) < b.hz+CFG.radius) return false;
  }
  return true;
}

function accelerate(wx,wz,maxS,acc,dt){
  const cur = player.vel.x*wx + player.vel.z*wz;
  const add = maxS - cur;
  if(add<=0) return;
  let a = acc*dt;
  if(a>add) a = add;
  player.vel.x += wx*a; player.vel.z += wz*a;
}

/* ---------------------------- ВЫСОТА КОРПУСА ---------------------------- */
function PLR_height(dt){
  const wantCrouch = !!(keys['ControlLeft']||keys['ControlRight']||keys['KeyC']);
  let want = CFG.height;
  if(player.slideT > 0) want = CFG.slideH;
  else if(wantCrouch) want = CFG.crouchH;
  // распрямляться только если над головой есть место; иначе пробуем присед
  if(want > player.h + 0.001 && !PLR_room(want)){
    want = (want > CFG.crouchH && PLR_room(CFG.crouchH)) ? CFG.crouchH : player.h;
  }
  player.h = damp(player.h, want, player.slideT>0 ? 17 : 12, dt);
  player.crouching = player.h < CFG.height - 0.06;
}

/* ------------------------- ПРЫЖКИ И РЫВОК ------------------------- */
function PLR_jump(){
  player.vel.y = CFG.jump;
  player.grounded = false;
  player.coyote = 0;
  player.jumpBuf = 0;
}
function PLR_airJump(){
  player.airJumps--;
  player.vel.y = CFG.airJumpV;
  player.jumpBuf = 0;
  player.coyote = 0;
  // толчок эфиром из-под ног: читается и как звук, и как вспышка под собой
  PLR_p1.set(player.pos.x, player.pos.y + 0.22, player.pos.z);
  PLR_fx(PLR_p1, 10, PAL.arcane, 0.9);
  SFX.dash();
}
function PLR_tryDash(){
  if(!player.alive || player.dashCd > 0 || player.dashT > 0 || player.mantleT > 0) return;
  if(player.climb) PLR_dropClimb(false);
  if(player.zip) PLR_dropZip(0);

  let dx = PLR_in.ax, dz = PLR_in.az;
  const l = Math.hypot(dx,dz);
  if(l < 1e-4){ dx = -Math.sin(player.yaw); dz = -Math.cos(player.yaw); }
  else { dx /= l; dz /= l; }
  PLR_dashX = dx; PLR_dashZ = dz;

  player.dashT = CFG.dashTime;
  player.dashCd = CFG.dashCd;
  player.slideT = 0;
  player.vel.set(dx*CFG.dashSpeed, 0, dz*CFG.dashSpeed);   // рывок и в воздухе гасит вертикаль
  PLR_fovK = 11;
  PLR_fx(playerCenter(PLR_p1), 14, PAL.arcane, 1.1);
  SFX.dash();
  shake(0.10);
}

/* ------------------------------ ПОДКАТ ------------------------------ */
function PLR_startSlide(){
  const sp = Math.hypot(player.vel.x, player.vel.z);
  let dx, dz;
  if(sp > 0.1){ dx = player.vel.x/sp; dz = player.vel.z/sp; }
  else { dx = PLR_in.ax; dz = PLR_in.az; }
  const v = Math.max(CFG.slideSpeed, sp*1.05);
  player.vel.x = dx*v; player.vel.z = dz*v;
  player.slideT = CFG.slideTime;
  PLR_slideDust = 0;
  SFX.slide();
  FX.burst(PLR_p1.set(player.pos.x, player.pos.y+0.12, player.pos.z), 7,
           {mat:PMAT.dust, speed:3.2, life:0.55, size:0.10, s1:0.02, g:9});
  shake(0.09);
}

/* --------------------------- ПОДТЯГИВАНИЕ --------------------------- */
function PLR_startMantle(m){
  PLR_mA.copy(player.pos);
  PLR_mB.set(m.x, m.y, m.z);
  player.mantleT = CFG.mantleTime;
  player.noGrav = true;
  player.vel.set(0,0,0);
  player.slideT = 0; player.climb = null; player.zip = null;
  player.dashT = 0; player.jumpBuf = 0;
  player.grounded = false;
  PLR_pushT = 0;
  PLR_mark();
  SFX.mantle();
  shake(0.06);
}
function PLR_mantleStep(dt){
  if(PLR_teleported()){ player.mantleT = 0; player.noGrav = false; return; }
  player.noGrav = true;
  player.mantleT = Math.max(0, player.mantleT - dt);
  const p = 1 - player.mantleT/CFG.mantleTime;
  // сначала руки на кромке (вверх), потом вынос корпуса вперёд — иначе
  // подтягивание выглядит как проезд сквозь угол
  const up = smoothstep(0, 0.70, p), fw = smoothstep(0.30, 1.0, p);
  player.pos.x = lerp(PLR_mA.x, PLR_mB.x, fw);
  player.pos.y = lerp(PLR_mA.y, PLR_mB.y, up);
  player.pos.z = lerp(PLR_mA.z, PLR_mB.z, fw);
  player.vel.set(0,0,0);
  player.grounded = false;
  if(player.mantleT <= 0){
    player.pos.copy(PLR_mB);
    player.noGrav = false;
    player.grounded = true;
    player.coyote = CFG.coyote;
    player.airJumps = CFG.airJumps;
    player.vel.set(PLR_in.ax*2.4, 0, PLR_in.az*2.4);   // не замирать на кромке
    player.dip = 0.07;
    FX.burst(PLR_p1.copy(player.pos), 4, {mat:PMAT.dust, speed:1.8, life:0.4, size:0.075});
  }
  PLR_mark();
}

/* ------------------------------ ТРОС ------------------------------ */
function PLR_grabZip(res){
  const z = res.zip;
  // едем к нижнему концу; если трос ровный — туда, куда смотрим
  let dir;
  const dy = z.b.y - z.a.y;
  if(Math.abs(dy) > 0.6) dir = dy < 0 ? 1 : -1;
  else { camera.getWorldDirection(PLR_p2); dir = (PLR_p2.x*z.dx + PLR_p2.z*z.dz) >= 0 ? 1 : -1; }
  const left = (dir > 0 ? 1-res.t : res.t) * z.len;
  if(left < 1.6) return;            // у самого конца хвататься уже незачем

  player.zip = z; PLR_zipT = res.t; PLR_zipDir = dir; PLR_zipSnd = 0;
  player.slideT = 0; player.climb = null; player.dashT = 0; player.jumpBuf = 0;
  player.noGrav = true;
  player.vel.set(0,0,0);
  PLR_mark();
  SFX.zip();
  PLR_fx(res.point, 8, PAL.arcane, 0);
}
function PLR_zipStep(dt){
  const z = player.zip;
  if(PLR_teleported()){ player.zip = null; player.noGrav = false; PLR_zipLock = 0.4; return; }
  player.noGrav = true;
  player.grounded = false;
  player.airJumps = CFG.airJumps;   // с троса всегда есть чем добить в воздухе

  PLR_zipT = clamp(PLR_zipT + PLR_zipDir*CFG.zipSpeed/z.len*dt, 0, 1);
  const px = z.a.x + (z.b.x-z.a.x)*PLR_zipT;
  const py = z.a.y + (z.b.y-z.a.y)*PLR_zipT;
  const pz = z.a.z + (z.b.z-z.a.z)*PLR_zipT;
  player.pos.set(px, py - player.h - 0.16, pz);
  player.vel.set(z.dx*CFG.zipSpeed*PLR_zipDir, 0, z.dz*CFG.zipSpeed*PLR_zipDir);
  PLR_mark();

  PLR_zipSnd -= dt;
  if(PLR_zipSnd <= 0){ PLR_zipSnd = 0.28; SFX.zipRide(0); }

  const end = (PLR_zipDir > 0 && PLR_zipT >= 1) || (PLR_zipDir < 0 && PLR_zipT <= 0);
  if(player.jumpBuf > 0){ player.jumpBuf = 0; PLR_dropZip(3.4); }
  else if(end) PLR_dropZip(1.6);
  else if(player.pos.y <= terrainH(player.pos.x, player.pos.z) + 0.05) PLR_dropZip(0);
}
function PLR_dropZip(up){
  const z = player.zip;
  player.zip = null;
  player.noGrav = false;
  PLR_zipLock = 0.55;
  if(!z) return;
  // сходим с троса, унося набранную скорость: спуск должен читаться как разгон
  player.vel.set(z.dx*CFG.zipSpeed*0.72*PLR_zipDir, 0, z.dz*CFG.zipSpeed*0.72*PLR_zipDir);
  player.vel.y = clamp(up + z.dy*CFG.zipSpeed*0.30*PLR_zipDir, -9, 9);
  player.coyote = 0;
  SFX.zip();
}

/* ---------------------------- ЛЕСТНИЦА ---------------------------- */
function PLR_dropClimb(jump){
  const c = player.climb;
  player.climb = null;
  player.noGrav = false;
  PLR_climbLock = 0.30;
  if(!c || !jump) return;
  // отталкиваемся наружу — с той стороны, с которой висели
  const s = ((player.pos.x-c.x)*c.fx + (player.pos.z-c.z)*c.fz) < 0 ? -1 : 1;
  player.vel.set(c.fx*s*4.2, CFG.jump*0.82, c.fz*s*4.2);
  player.airJumps = CFG.airJumps;
}
function PLR_ladderStep(dt){
  if(player.jumpBuf > 0){ player.jumpBuf = 0; PLR_dropClimb(true); return; }

  const wantUp = !!keys['KeyW'];
  PLR_prevY = player.pos.y;
  const on = climbStep(player, dt, wantUp);
  moveHoriz(player, dt);
  moveVert(player, dt);

  // перехват перекладины — примерно раз в полметра
  PLR_climbSnd += Math.abs(player.pos.y - PLR_prevY);
  if(PLR_climbSnd > 0.55){ PLR_climbSnd = 0; SFX.climb(); }

  if(!on){ player.climb = null; player.noGrav = false; PLR_climbLock = 0.15; }
  else if(player.grounded && !wantUp){ player.climb = null; player.noGrav = false; PLR_climbLock = 0.20; }
}

/* ------------------------- ОБЫЧНОЕ ДВИЖЕНИЕ ------------------------- */
function PLR_walkStep(dt){
  player.noGrav = false;
  const wantCrouch = !!(keys['ControlLeft']||keys['ControlRight']||keys['KeyC']);

  /* --- рывок: короткий отрезок с жёстко заданной скоростью --- */
  if(player.dashT > 0){
    player.dashT = Math.max(0, player.dashT - dt);
    player.noGrav = true;
    player.vel.set(PLR_dashX*CFG.dashSpeed, 0, PLR_dashZ*CFG.dashSpeed);
    if(player.dashT <= 0){
      // выходим быстрым, но не «ракетой»: дальше решают трение и воздух
      const cap = CFG.sprint*1.25, sp = Math.hypot(player.vel.x, player.vel.z);
      if(sp > cap){ const k = cap/sp; player.vel.x *= k; player.vel.z *= k; }
      PLR_fx(playerCenter(PLR_p1), 5, PAL.rune, 0);
    }
  }

  /* --- подкат --- */
  let hs = Math.hypot(player.vel.x, player.vel.z);
  if(player.slideT > 0){
    player.slideT = Math.max(0, player.slideT - dt);
    if(player.grounded){
      const drop = Math.max(hs, 3.0)*CFG.slideFric*dt;
      const k = hs > 1e-4 ? Math.max(0, hs-drop)/hs : 0;
      player.vel.x *= k; player.vel.z *= k;
      // лёгкое подруливание: подкат — это коммит, но не рельса
      accelerate(PLR_in.wx, PLR_in.wz, Math.max(CFG.crouch, hs*0.9), CFG.accel*0.22, dt);
      PLR_slideDust -= dt;
      if(PLR_slideDust <= 0){
        PLR_slideDust = 0.07;
        FX.burst(PLR_p1.set(player.pos.x, player.pos.y+0.10, player.pos.z), 2,
                 {mat:PMAT.dust, speed:1.9, life:0.45, size:0.075, s1:0.01, g:8});
      }
    } else {
      accelerate(PLR_in.wx, PLR_in.wz, CFG.sprint*0.95, CFG.airAccel*0.8, dt);
    }
    hs = Math.hypot(player.vel.x, player.vel.z);
    if(player.slideT <= 0 || hs < 2.6){ player.slideT = 0; PLR_slideCd = 0.35; }
  } else if(wantCrouch && player.grounded && player.dashT <= 0 && PLR_slideCd <= 0 && hs > CFG.walk*1.05){
    // подкат заводится только с разгона — на шаге Ctrl остаётся приседанием
    PLR_startSlide();
    hs = Math.hypot(player.vel.x, player.vel.z);
  }

  /* --- земля: coyote-time и перезарядка воздушных прыжков --- */
  if(player.grounded){
    player.coyote = CFG.coyote;
    player.airJumps = CFG.airJumps;
  }

  /* --- прыжок / подтягивание / доп. прыжок --- */
  if(player.jumpBuf > 0 && player.dashT <= 0){
    const canGround = player.grounded || player.coyote > 0;
    // с земли подтягиваемся только когда действительно ломимся вперёд
    const ledge = (!canGround || PLR_in.wl > 0) ? mantleFind(player, PLR_in.ax, PLR_in.az) : null;
    if(ledge && (!canGround || ledge.y - player.pos.y > CFG.step + 0.2)){
      PLR_startMantle(ledge);
      return;
    }
    if(canGround){
      if(player.slideT > 0){ player.slideT = 0; PLR_slideCd = 0.25; }  // прыжок из подката уносит скорость
      PLR_jump();
    } else if(player.airJumps > 0){
      PLR_airJump();
    }
  }

  /* --- разгон и трение --- */
  if(player.dashT <= 0 && player.slideT <= 0){
    hs = Math.hypot(player.vel.x, player.vel.z);   // рывок мог только что обрезать скорость
    let maxS = CFG.walk;
    if(player.crouching) maxS = CFG.crouch;
    else if(wpn.sT > 0.4) maxS = CFG.scoped;
    else if(player.sprinting) maxS = CFG.sprint;
    if(player.grounded){
      if(hs > 0.01){
        const drop = Math.max(hs, 4.5)*CFG.friction*dt;
        const kf = Math.max(0, hs-drop)/hs;
        player.vel.x *= kf; player.vel.z *= kf;
      }
      accelerate(PLR_in.wx, PLR_in.wz, maxS, CFG.accel, dt);
    } else {
      accelerate(PLR_in.wx, PLR_in.wz, maxS*0.95, CFG.airAccel, dt);
    }
  }

  /* --- собственно перемещение --- */
  player.landV = 0;
  PLR_prevX = player.pos.x; PLR_prevZ = player.pos.z;
  moveHoriz(player, dt);
  moveVert(player, dt);
  if(player.landV < -7){ SFX.land(); player.dip = clamp(-player.landV*0.014, 0, 0.22); shake(0.12); }

  /* --- упёрся в уступ на бегу: подтянуться без нажатия ---
     меряем не скорость (её съедает сама коллизия), а сколько прошли
     вдоль того направления, куда жмём */
  const along = (player.pos.x-PLR_prevX)*PLR_in.ax + (player.pos.z-PLR_prevZ)*PLR_in.az;
  if(PLR_in.wl > 0 && along < CFG.walk*0.35*dt) PLR_pushT += dt;
  else PLR_pushT = 0;
  if(PLR_pushT > 0.09 && PLR_mantleTry <= 0 && player.dashT <= 0){
    PLR_mantleTry = 0.09;    // поиск уступа не бесплатный — прореживаем
    const m = mantleFind(player, PLR_in.ax, PLR_in.az);
    if(m && m.y - player.pos.y > CFG.step + 0.2){ PLR_startMantle(m); return; }
  }

  /* --- трос --- */
  if(!player.zip && PLR_zipLock <= 0 && ZIPS.length){
    PLR_p1.set(player.pos.x, player.pos.y + player.h*0.92, player.pos.z);
    const z = zipNear(PLR_p1, 1.9);
    if(z) PLR_grabZip(z);
  }
  /* --- лестница: с земли лезем по W, в падении цепляемся сами --- */
  if(!player.zip && !player.climb && PLR_climbLock <= 0 && CLIMBS.length){
    const c = climbAt(player.pos.x, player.pos.z, player.pos.y);
    if(c && player.pos.y < c.y1 - 0.15 && (PLR_in.mf > 0 || !player.grounded)){
      player.climb = c; player.jumpBuf = 0; player.slideT = 0;
      PLR_climbSnd = 0; SFX.climb();
    }
  }
}

/* --------------------------- ШАГИ И ПОКАЧИВАНИЕ --------------------------- */
function PLR_bob(dt){
  const hs = Math.hypot(player.vel.x, player.vel.z);
  if(player.grounded && hs>0.6 && player.slideT<=0 && !player.climb && !player.zip){
    player.bobT += dt*hs*(player.crouching?1.0:1.45);
    if(Math.floor(player.bobT/2.6) !== player.lastStep){ player.lastStep = Math.floor(player.bobT/2.6); SFX.step(); }
  }
  const bobAmt = (1-wpn.sT*0.85) * clamp(hs/CFG.sprint,0,1) * (player.slideT>0 ? 0.25 : 1);
  player.bob = damp(player.bob, bobAmt, 8, dt);
  player.dip = damp(player.dip, 0, 7, dt);
}

/* ------------------------------ КАДР ИГРОКА ------------------------------ */
function updatePlayer(dt){
  if(!PLR_ready) PLR_setup();

  // откат рывка тикает всегда — HUD обязан жить и в полёте, и в смерти
  if(player.dashCd > 0) player.dashCd = Math.max(0, player.dashCd - dt);

  if(!player.alive){
    PLR_clearParkour();
    if(PLR_wasAlive){ PLR_wasAlive = false; PLR_deadShown = -1; }   // первый кадр смерти: кэш сбрасываем, чтобы «3» точно нарисовалось
    player.respawnT -= dt;
    if(!PLR_deadEl) PLR_deadEl = $('deadSub');
    const left = Math.max(0, Math.ceil(player.respawnT));
    if(left !== PLR_deadShown){
      PLR_deadShown = left;
      // Отсчёт всегда идёт по player.respawnT: его длину в сети назначает сервер
      // (welcome.respawn), офлайн — прежние 3 с. Когда счётчик дошёл до нуля, в
      // сети поднимает только серверный 'resp' — до него честно говорим, чего ждём.
      if(PLR_deadEl) PLR_deadEl.textContent =
        (left>0) ? 'РЕСПАВН ЧЕРЕЗ '+left
                 : (NET_ACTIVE ? 'ОЖИДАНИЕ СЕРВЕРА' : 'РЕСПАВН ЧЕРЕЗ 0');
    }
    /* Локальный таймер поднимает игрока только в одиночной игре. В сети это
       рождало «призрака»: клиент считал себя живым и бегал, а комната держала
       его мёртвым — и попасть в него было нельзя. Возрождает netRespawn(). */
    if(!NET_ACTIVE && player.respawnT<=0 && game.state==='play') respawnPlayer();
    PLR_dashHUD();
    return;
  }
  PLR_wasAlive = true;
  player.lastHurt += dt;
  if(typeof tickPlayerBurn === 'function') tickPlayerBurn(dt);   // горение считает 75_combat.js

  // таймеры паркура
  PLR_slideCd   = Math.max(0, PLR_slideCd - dt);
  PLR_climbLock = Math.max(0, PLR_climbLock - dt);
  PLR_zipLock   = Math.max(0, PLR_zipLock - dt);
  PLR_mantleTry = Math.max(0, PLR_mantleTry - dt);
  if(player.jumpBuf > 0) player.jumpBuf -= dt;
  if(player.coyote  > 0) player.coyote  -= dt;

  /* --- ввод --- */
  const sy=Math.sin(player.yaw), cy=Math.cos(player.yaw);
  const fX=-sy, fZ=-cy, rX=cy, rZ=-sy;
  const mf = (keys['KeyW']?1:0)-(keys['KeyS']?1:0);
  const mr = (keys['KeyD']?1:0)-(keys['KeyA']?1:0);
  let wx = fX*mf + rX*mr, wz = fZ*mf + rZ*mr;
  const wl = Math.hypot(wx,wz); if(wl>0){ wx/=wl; wz/=wl; }
  PLR_in.wx = wx; PLR_in.wz = wz; PLR_in.wl = wl; PLR_in.mf = mf; PLR_in.mr = mr;
  PLR_in.ax = wl>0 ? wx : fX; PLR_in.az = wl>0 ? wz : fZ;

  // нажатие прыжка живёт CFG.jumpBuf секунд: его съест кто угодно —
  // земля, уступ, воздушный толчок, трос или лестница
  if(keys['Space']){ keys['Space'] = false; player.jumpBuf = CFG.jumpBuf; }

  /* --- выносливость и задержка дыхания --- */
  // брифинг обещает просто «Shift» — значит обе клавиши, а не только левая
  const shift = !!(keys['ShiftLeft'] || keys['ShiftRight']);
  const wantSprint = shift && mf>0 && !player.crouching && wpn.sT<0.35 && player.slideT<=0;
  wpn.hold = shift && wpn.sT>0.5;
  player.sprinting = wantSprint && player.stam>0.02;
  if(player.sprinting) player.stam -= dt*0.26;
  else if(wpn.hold) player.stam -= dt*0.34;
  else if(player.lastHurt>0.4) player.stam = Math.min(1, player.stam + dt*0.30);
  player.stam = clamp(player.stam,0,1);

  // рывок — по фронту нажатия, чтобы зажатая Q не срабатывала сама по откату
  if(keys['KeyQ']){ if(!PLR_qHeld){ PLR_qHeld = true; PLR_tryDash(); } }
  else PLR_qHeld = false;

  PLR_height(dt);

  if(player.mantleT > 0)  PLR_mantleStep(dt);
  else if(player.zip)     PLR_zipStep(dt);
  else if(player.climb)   PLR_ladderStep(dt);
  else                    PLR_walkStep(dt);

  PLR_bob(dt);
  PLR_dashHUD();
}

/* -------------------------- ОПТИКА И КАМЕРА -------------------------- */
let swayT = 0;
function updateCamera(dt){
  swayT += dt;
  const amp = swayAmp()*Math.PI/180;
  const sx = (Math.sin(swayT*0.9)*0.6 + Math.sin(swayT*2.3)*0.3)*amp;
  const sy2 = (Math.cos(swayT*1.3)*0.55 + Math.sin(swayT*3.1)*0.25)*amp;
  let sh = 0, shp = 0;
  if(shakeT>0){ shakeT -= dt; const k = shakeA*(shakeT/0.32); sh = rnd(-k,k)*0.05; shp = rnd(-k,k)*0.05; shakeA = damp(shakeA,0,6,dt); }
  // наклон корпуса: подкат кладёт камеру набок, трос — чуть-чуть
  const rollWant = player.slideT>0 ? 0.115 : (player.zip ? 0.05 : 0);
  PLR_roll = damp(PLR_roll, rollWant, 9, dt);
  PLR_fovK = damp(PLR_fovK, 0, 6.5, dt);

  const bobY = Math.sin(player.bobT*2)*0.035*player.bob;
  const bobX = Math.sin(player.bobT)*0.028*player.bob;
  camera.position.set(
    player.pos.x + bobX*Math.cos(player.yaw),
    player.pos.y + player.h - CFG.eye + bobY - player.dip,
    player.pos.z - bobX*Math.sin(player.yaw)
  );
  camera.rotation.order = 'YXZ';
  camera.rotation.y = player.yaw + sx + sh;
  camera.rotation.x = clamp(player.pitch + wpn.rec + sy2 + shp, -1.55, 1.55);
  camera.rotation.z = Math.sin(player.bobT)*0.006*player.bob + (wpn.kick*0.05) + PLR_roll;
  vmCamera.rotation.z = camera.rotation.z*0.5;

  // «панч» поля зрения на рывке и подкате. FOV каждый кадр заново ставит
  // updateWeapon (он идёт раньше в цикле), поэтому здесь только добавка.
  // Если FOV с прошлого раза не переписали — сначала снимаем свою старую
  // добавку, иначе при двух вызовах подряд поле зрения уползло бы.
  // В оптике панча нет — он сбивал бы прицеливание.
  if(PLR_fovAdd !== 0 && camera.fov === PLR_fovSet) camera.fov -= PLR_fovAdd;
  const punch = (PLR_fovK + (player.slideT>0 ? 3.0 : 0)) * (1-wpn.sT);
  const add = punch > 0.05 ? punch : 0;
  if(add !== 0 || PLR_fovAdd !== 0){ camera.fov += add; camera.updateProjectionMatrix(); }
  PLR_fovAdd = add; PLR_fovSet = camera.fov;

  // солнце ходит за игроком, чтобы тени были чёткими
  sun.position.set(player.pos.x+55, player.pos.y+82, player.pos.z+38);
  sun.target.position.copy(player.pos); sun.target.updateMatrixWorld();
  if(skyMesh) skyMesh.position.copy(camera.position);
}
