/* =====================================================================
   DM_DUEL v3 — ОРУЖИЕ: игрок, боеприпасы, баллистика, отдача.
   Тип патрона здесь решает всё: матчевый — единственный с полным критом,
   фугасный работает площадью и крита не имеет вовсе, зажигательный
   почти не бьёт напрямую, зато оставляет горение и очаги огня.
   ===================================================================== */
const ZOOMS = [22, 13, 7.5];
const player = {
  pos:V(0,0,0), vel:V(0,0,0), yaw:0, pitch:0, h:CFG.height,
  grounded:false, stepUp:0, landV:0, crouching:false, sprinting:false,
  hp:100, alive:true, respawnT:0, stam:1, bobT:0, bob:0, dip:0,
  lastHurt:99, lastStep:0,
  /* v3: горение (ведёт H) и аркадная подвижность (ведёт A).
     Оружие эти поля только объявляет — чтобы литерал был один на всех
     и никто не создавал их на горячем пути. */
  burn:0, burnFx:null,
  dashCd:0, dashT:0, slideT:0, mantleT:0, airJumps:0, coyote:0, jumpBuf:0,
  climb:null, zip:null, noGrav:false
};
const wpn = {
  idx:0, loaded:[5,3,4], res:[45,18,28],
  /* Персональный откат каждого типа. Тикает ВСЕГДА, даже когда выбран
     другой тип: пояс патронов — общий ресурс, а не три независимых ствола. */
  cd:[0,0,0],
  bolt:0, rel:0, relTotal:0, relStage:0, scoped:false, sT:0, zoom:0, charge:0,
  bloom:0, rec:0, yawRec:0,
  kick:0, kickV:0, kickX:0, kickXV:0, boltAnim:0, ejected:true,
  swayX:0, swayY:0, hold:false, breathT:0,
  heat:0, flashT:0, flashS:0.5
};
const wind = { x:0, z:0, mag:0, dir:0 };
const game = {
  state:'menu', diff:'normal', kills:0, deaths:0, shots:0, hits:0, heads:0,
  best:0, time:0, sens:1.3, fov:80, shadows:2,
  /* Сторона игрока: 0 = BLU (осадный лагерь), 1 = RED (замок).
     Единый источник правды на весь проект: по нему выбираются точки респавна
     игрока, команда ботов (противоположная) и цвета в интерфейсе. В сети его
     назначает сервер и кладёт сюда же — чтобы читателю не приходилось знать,
     сетевой мы сейчас или нет. */
  team:0
};
let D = DIFFS.normal;

const _t1=new THREE.Vector3(), _t2=new THREE.Vector3(), _t3=new THREE.Vector3(), _t4=new THREE.Vector3();
const _hit=new THREE.Vector3(), _nrm=new THREE.Vector3(), _mz=new THREE.Vector3();
const _fwd=new THREE.Vector3();
/* _t1.._t4 нарасхват у ИИ и эффектов, поэтому геометрию выстрела считаем
   в собственных векторах: так вызов FX/explode посреди расчёта ничего не затрёт. */
const WPN_v1=new THREE.Vector3(), WPN_v2=new THREE.Vector3(), WPN_v3=new THREE.Vector3(), WPN_v4=new THREE.Vector3();

let shakeT = 0, shakeA = 0;
function shake(a){ shakeA = Math.max(shakeA, a); shakeT = 0.32; }
function playerEye(o){ return o.set(player.pos.x, player.pos.y + player.h - CFG.eye, player.pos.z); }
function playerCenter(o){ return o.set(player.pos.x, player.pos.y + player.h*0.55, player.pos.z); }
function panOf(p){ const d=_t3.subVectors(p, camera.position); const r=_t4.set(Math.cos(player.yaw),0,-Math.sin(player.yaw)); const l=d.length()||1; return clamp(d.dot(r)/l,-1,1)*0.85; }
function volOf(p){ const d=p.distanceTo(camera.position); return clamp(1-d/120,0.05,1); }

/* Строка статуса живёт в HUD (модуль F). Оборачиваем, чтобы незакрытый
   откат не ронял кадр, если HUD собран другой версии. */
function WPN_status(key, text, col){ if(typeof setStatus === 'function') setStatus(key, text, col); }
function WPN_statusOff(key){ if(typeof clearStatus === 'function') clearStatus(key); }
/* Единственное место, где собирается строка отката. Округляем ВВЕРХ: тем же
   способом HUD рисует число в слоте пояса и в индикаторе отката, а расхождение
   в одну десятую на одном и том же ожидании читается как баг. */
function WPN_cdTxt(a, cd){ return a.short+' · ОТКАТ '+(Math.ceil(cd*10)/10).toFixed(1); }

/* ------------------------ ОБЩИЙ ЛУЧ ИЗ КАМЕРЫ ------------------------
   Дальномер и подсказка зоны поражения смотрят в одну и ту же точку —
   куда направлен прицел. Каждый такой замер это перебор всех коробок плюс
   марш по рельефу, и делать его дважды за кадр незачем: считаем не чаще
   раза в WPN_RAY_DT и отдаём результат всем желающим.
   Луч всегда бьём на WPN_RAY_FAR, а вызывающему обрезаем до его maxT —
   тогда один кэш обслуживает и запрос на 300 м, и запрос на 400 м. */
const WPN_RAY_DT = 0.06;
const WPN_RAY_FAR = 400;
let WPN_rayT = -1;              // game.time последнего расчёта
let WPN_rayFar = 0;             // на какую дальность считали
let WPN_rayD = 0;               // что насчитали
const WPN_rayDir = new THREE.Vector3();
function camRayDist(maxT){
  const R = (maxT > 0) ? maxT : WPN_RAY_FAR;
  const t = game.time;
  // t < WPN_rayT — это рестарт матча (game.time обнулился): кэш протух
  if(WPN_rayFar >= R && t >= WPN_rayT && t - WPN_rayT < WPN_RAY_DT) return Math.min(WPN_rayD, R);
  const far = Math.max(R, WPN_RAY_FAR);
  camera.getWorldDirection(WPN_rayDir);
  let d = far;
  const rb = rayBoxes(camera.position, WPN_rayDir, far);
  if(rb) d = rb.t;
  const rt = rayTerrain(camera.position, WPN_rayDir, d);
  if(rt) d = rt.t;
  WPN_rayT = t; WPN_rayFar = far; WPN_rayD = d;
  return Math.min(d, R);
}

/* --------------------------- ХАРАКТЕР ОТДАЧИ ---------------------------
   Выстрел должен ощущаться по-разному ещё до того, как пуля куда-то прилетит:
   фугас пинает тяжело и мутно, зажигательный плюётся огнём, матчевый — сухой
   и точный. Все цифры — на кадр выстрела, дальше их растаскивает updateWeapon. */
const WPN_RECOIL = {
  match:{ kick:5.2, kickX:1.5, pitch:1.15, yaw:0.30, shake:0.14, bloom:1.50, heat:0.30,
          flash:0.55, smoke:5, spark:3, ember:0 },
  frag: { kick:7.8, kickX:2.8, pitch:1.90, yaw:0.60, shake:0.30, bloom:2.30, heat:0.40,
          flash:0.86, smoke:10, spark:5, ember:0 },
  fire: { kick:6.1, kickX:1.9, pitch:1.45, yaw:0.42, shake:0.19, bloom:1.85, heat:0.62,
          flash:0.70, smoke:4, spark:2, ember:7 }
};
/* Цвет остаточного дыма у дула: у зажигательного он тёплый и держится дольше. */
const WPN_SMOKE_COL = { match:0x8d8880, frag:0x615c57, fire:0xa8785c };

/* оружие от первого лица */
let vmRoot, vmRifle, vmFlash, vmHandL;
let WPN_flashCore = null;      // яркое ядро вспышки поверх спрайта
let WPN_vmLight = null;        // подсветка модели в момент выстрела
const WPN_smoke = [];          // дым, ползущий из ствола, пока он горячий
function buildViewmodel(){
  vmRoot = new THREE.Group(); vmScene.add(vmRoot);
  vmRifle = mkRifle(PAL.blu, false);
  vmRifle.scale.setScalar(0.92);
  vmRifle.position.set(0.16,-0.20,-0.42);
  vmRifle.rotation.set(0.02,-0.055,0.02);
  vmRoot.add(vmRifle);
  const glove = toon(0x3f6c8c), skin = toon(PAL.skin), sleeve = toon(PAL.blu);
  const hR = new THREE.Group(); hR.position.set(0.06,-0.12,0.14); vmRifle.add(hR);
  hR.add(mBox(0.10,0.13,0.12, glove, 0,0,0));
  hR.add(mBox(0.115,0.16,0.115, skin, 0,0.10,0.05));
  hR.add(mBox(0.135,0.16,0.135, sleeve, 0,0.24,0.10));
  vmHandL = new THREE.Group(); vmHandL.position.set(-0.02,-0.11,-0.40); vmRifle.add(vmHandL);
  vmHandL.add(mBox(0.11,0.12,0.15, glove, 0,0,0));
  vmHandL.add(mBox(0.115,0.20,0.13, skin, 0.02,0.11,0.10));
  vmHandL.add(mBox(0.14,0.16,0.15, sleeve, 0.04,0.26,0.18));

  vmFlash = new THREE.Sprite(new THREE.SpriteMaterial({map:TEX_GLOW, color:0xffd48a, blending:THREE.AdditiveBlending, transparent:true, depthWrite:false, depthTest:false}));
  vmFlash.scale.setScalar(0.5); vmFlash.position.set(0,0.02,-1.06); vmFlash.visible=false;
  vmRifle.add(vmFlash);
  // второе, маленькое и очень яркое ядро: даёт «щелчок» вспышки, а не пятно
  WPN_flashCore = new THREE.Sprite(new THREE.SpriteMaterial({map:TEX_GLOW, color:0xfff6dc, blending:THREE.AdditiveBlending, depthWrite:false, depthTest:false}));
  WPN_flashCore.scale.setScalar(0.2); WPN_flashCore.position.set(0,0.02,-1.02); WPN_flashCore.visible=false;
  vmRifle.add(WPN_flashCore);
  // вспышка подсвечивает саму модель — иначе она «не участвует» в выстреле
  WPN_vmLight = new THREE.PointLight(0xffd48a, 0, 2.6);
  WPN_vmLight.position.set(0.12,-0.16,-1.25);
  vmScene.add(WPN_vmLight);

  /* линзу прицела вида отвязываем от общего материала: ниже мы крутим
     её прозрачность, и это не должно доставать до винтовок противника */
  if(vmRifle.userData && vmRifle.userData.lens && vmRifle.userData.lens.material)
    vmRifle.userData.lens.material = vmRifle.userData.lens.material.clone();

  // ленивый дым из ствола: три спрайта с разной фазой
  for(let i=0;i<3;i++){
    const s = new THREE.Sprite(new THREE.SpriteMaterial({map:TEX_SMOKE, color:0x8d8880, transparent:true, opacity:0, depthWrite:false}));
    s.scale.setScalar(0.12); s.visible = false; s.userData.t = i/3;
    vmScene.add(s); WPN_smoke.push(s);
  }
}

function A(){ return AMMO[wpn.idx]; }
function currentSpreadDeg(){
  const a = A();
  const sp = Math.hypot(player.vel.x, player.vel.z);
  let s = a.spread * (1-wpn.sT);
  s += Math.min(1.7, sp*0.17) * (0.30 + 0.70*(1-wpn.sT));
  if(player.crouching) s *= 0.5;
  if(!player.grounded) s += 2.0;
  if(player.slideT > 0) s += 1.2;      // из подката прицельно не постреляешь
  if(player.mantleT > 0) s += 2.5;     // на уступе руки заняты
  s += wpn.bloom + wpn.heat*0.12;      // разогретый ствол «дышит»
  return Math.max(0, s);
}
function swayAmp(){
  if(wpn.sT < 0.5) return 0;
  const tired = 1 - player.stam;
  let a = 0.10 + tired*0.42;
  if(wpn.hold && player.stam > 0.02) a *= 0.10;   // задержка дыхания на Shift
  else if(player.stam <= 0.02) a *= 1.35;         // выдохся — марка гуляет
  return a * (0.55 + 0.45*(ZOOMS[wpn.zoom]/22));
}

/* ------------------------------ ВЫСТРЕЛ ------------------------------ */
let WPN_blockT = 0;        // антиспам «щелчка» при попытке стрелять на откате
/* Гильзу заряжает только настоящий выстрел. Флаг внутренний и ставится
   ровно здесь: снаружи иногда обнуляют wpn.ejected на старте матча, и одного
   этого поля мало, чтобы отличить «есть что выбрасывать» от чужого сброса. */
let WPN_ejectArm = false;

function WPN_muzzleWorld(out){
  // точка дула в мире: вид от первого лица живёт в своей сцене, поэтому
  // свет и дым ставим от камеры вдоль ствола
  camera.getWorldDirection(WPN_v2);
  WPN_v3.set(0,1,0);
  WPN_v4.crossVectors(WPN_v2, WPN_v3).normalize();
  WPN_v3.crossVectors(WPN_v4, WPN_v2).normalize();
  return out.copy(camera.position)
            .addScaledVector(WPN_v2, 1.05)
            .addScaledVector(WPN_v4, 0.15*(1-wpn.sT))
            .addScaledVector(WPN_v3, -0.10*(1-wpn.sT));
}

function WPN_shotFx(a, chg){
  const R = WPN_RECOIL[a.id] || WPN_RECOIL.match;

  // отдача: ствол вверх-назад, камера уходит и потом сама сводится обратно
  wpn.kickV += R.kick*(1 + chg*0.35);
  wpn.kickXV += rnd(-R.kickX, R.kickX);
  wpn.bloom += R.bloom;
  wpn.rec += R.pitch*Math.PI/180 * (1 + chg*0.55) * (wpn.sT>0.5 ? 0.55 : 1);
  const yk = rnd(-R.yaw, R.yaw)*Math.PI/180 * (wpn.sT>0.5 ? 0.6 : 1);
  player.yaw += yk; wpn.yawRec += yk;      // увод; сведение — в updateWeapon
  shake(R.shake + chg*0.10);
  wpn.heat = Math.min(1.7, wpn.heat + R.heat);

  // дульная вспышка: спрайт в виде оружия + импульс света в мире
  wpn.flashT = 0.06;
  wpn.flashS = R.flash*rnd(0.85,1.20);
  if(vmFlash){
    vmFlash.visible = true;
    vmFlash.material.color.setHex(a.col);
    vmFlash.material.rotation = rnd(0, 6.283);
    vmFlash.scale.setScalar(wpn.flashS);
  }
  if(WPN_flashCore){
    WPN_flashCore.visible = true;
    WPN_flashCore.scale.setScalar(wpn.flashS*0.42);
  }
  if(WPN_vmLight){ WPN_vmLight.color.setHex(a.col); WPN_vmLight.intensity = 7; }
  for(const s of WPN_smoke) s.material.color.setHex(WPN_SMOKE_COL[a.id] || 0x8d8880);

  const mz = WPN_muzzleWorld(WPN_v1);
  camera.getWorldDirection(WPN_v2);
  if(typeof LIGHTS !== 'undefined' && LIGHTS.flash) LIGHTS.flash(mz, a.col, 6, 14, 0.06);

  // дым и искры — свои для каждого типа
  FX.burst(mz, R.smoke, {mat:PMAT.smoke, speed:2.6, life:a.id==='frag'?0.95:0.55,
                         size:a.id==='frag'?0.16:0.10, s1:a.id==='frag'?0.5:0.22,
                         g:-0.9, dir:WPN_v2, push:3.2});
  if(R.spark) FX.burst(mz, R.spark, {mat:PMAT.spark, speed:6, life:0.22, size:0.05, s1:0.01, g:6, dir:WPN_v2, push:5});
  if(R.ember){
    // зажигательный сыплет углями прямо с дула
    if(FX.magic) FX.magic(mz, R.ember, PAL.ember);
    else FX.burst(mz, R.ember, {mat:PMAT.fire, speed:3.5, life:0.5, size:0.07, s1:0.01, g:-1.5});
  }
  if(a.id==='frag' && FX.ring) FX.ring(mz, 1.0, 0xffb072);   // ударная волна из ствола

  SFX.shot(a.id, 0, 1);
  SFX.noise({dur:0.05, f:1700, q:4, g:0.09, delay:0.03});     // лязг механики поверх выстрела
}

function tryFire(){
  if(game.state!=='play' || !player.alive) return;
  const a = A();
  /* Откат типа — главный ограничитель темпа: он проверяется раньше всего,
     чтобы игрок всегда понимал, что мешает именно выбранный боеприпас. */
  if(wpn.cd[wpn.idx] > 0){
    if(WPN_blockT <= 0){ SFX.blocked(); WPN_blockT = 0.22; }
    WPN_status('cd', WPN_cdTxt(a, wpn.cd[wpn.idx]), '#e08a4a');
    wpn.kickV += 0.6;                     // сухой щелчок в модели, без вспышки
    return;
  }
  if(wpn.rel>0 || wpn.bolt>0) return;
  if(wpn.loaded[wpn.idx] <= 0){ SFX.dry(); startReload(); return; }

  wpn.loaded[wpn.idx]--;
  game.shots++;
  const chg = wpn.sT>0.6 ? wpn.charge : 0;
  const dmg = lerp(a.dmgMin, a.dmgMax, chg);

  camera.getWorldDirection(_fwd);
  const sd = currentSpreadDeg()*Math.PI/180;
  if(sd>0){
    const ang = rnd(0,Math.PI*2), rad = Math.sqrt(Math.random())*sd;
    const up = _t1.set(0,1,0), rt = _t2.crossVectors(_fwd, up).normalize();
    const u2 = _t3.crossVectors(rt, _fwd).normalize();
    _fwd.addScaledVector(rt, Math.tan(rad)*Math.cos(ang)).addScaledVector(u2, Math.tan(rad)*Math.sin(ang)).normalize();
  }
  spawnBullet(camera.position, _fwd, a, dmg, 'player', chg);
  // остальным нужен наш выстрел для трассера и звука — попадание считаем мы сами
  if(NET_ACTIVE) NET.reportShot(wpn.idx, camera.position, _fwd, chg);

  wpn.cd[wpn.idx] = a.cd;                 // персональный откат типа пошёл
  wpn.charge = 0;
  wpn.bolt = a.bolt;
  wpn.boltAnim = 0; wpn.ejected = false; WPN_ejectArm = true;
  WPN_shotFx(a, chg);
  if(a.cd > 0) WPN_status('cd', WPN_cdTxt(a, a.cd), '#e08a4a');
}
function startReload(){
  const a = A();
  if(wpn.rel>0 || wpn.loaded[wpn.idx] >= a.mag || wpn.res[wpn.idx] <= 0) return;
  wpn.rel = wpn.relTotal = a.reload;
  wpn.relStage = 0;
  wpn.charge = 0;
  SFX.reloadS();
}
function finishReload(){
  const a = A();
  const need = a.mag - wpn.loaded[wpn.idx];
  const take = Math.min(need, wpn.res[wpn.idx]);
  wpn.loaded[wpn.idx] += take; wpn.res[wpn.idx] -= take;
  wpn.relStage = 0;
}
function switchAmmo(i){
  if(i===wpn.idx || wpn.rel>0) return;
  wpn.idx = i; wpn.charge = 0; wpn.bolt = Math.max(wpn.bolt, 0.45);
  wpn.boltAnim = 0; wpn.ejected = true; WPN_ejectArm = false;   // смена пояса — не выстрел, гильзе взяться неоткуда
  SFX.bolt();
  // сразу показать, готов ли новый тип: пояс общий, откаты у типов свои
  const a = AMMO[i];
  if(wpn.cd[i] > 0) WPN_status('cd', WPN_cdTxt(a, wpn.cd[i]), '#e08a4a');
  else WPN_statusOff('cd');
  updateAmmoHUD(); updateReticle();
}

/* ------------------------------ ГИЛЬЗЫ ------------------------------
   Гильза вылетает не в момент выстрела, а когда игрок передёргивает
   затвор — это болтовка. Живёт в сцене вида, физика — тоже в ней. */
const WPN_SHELL_GEO = new THREE.CylinderGeometry(0.011,0.013,0.052,6);
const WPN_SHELL_COL = { match:0xd8b464, frag:0x9aa2a6, fire:0xc07a44 };
const WPN_shells = [];
function WPN_shellMat(a){ return toon(WPN_SHELL_COL[a.id] || 0xd8b464); }
function WPN_ejectShell(a){
  if(!vmRifle) return;
  let s = null;
  for(let i=0;i<WPN_shells.length;i++) if(WPN_shells[i].life<=0){ s = WPN_shells[i]; break; }
  if(!s){
    if(WPN_shells.length >= 8) return;
    s = { m:new THREE.Mesh(WPN_SHELL_GEO, WPN_shellMat(a)), v:new THREE.Vector3(), w:new THREE.Vector3(), life:0, tink:false };
    s.m.castShadow = false; s.m.frustumCulled = false;
    vmScene.add(s.m);
    WPN_shells.push(s);
  }
  s.m.material = WPN_shellMat(a);
  s.m.visible = true;
  // окно выброса — справа от ствольной коробки
  vmRifle.localToWorld(WPN_v1.set(0.08, 0.04, 0.02));
  s.m.position.copy(WPN_v1);
  s.m.rotation.set(rnd(0,3), rnd(0,3), rnd(0,3));
  s.v.set(rnd(1.1,2.0), rnd(0.9,1.7), rnd(0.1,0.8));
  s.w.set(rnd(-14,14), rnd(-14,14), rnd(-14,14));
  s.life = 1.15; s.tink = false;
  s.m.scale.setScalar(1);
  SFX.noise({dur:0.04, f:3400, q:6, g:0.05});
}
function WPN_updateShells(dt){
  for(let i=0;i<WPN_shells.length;i++){
    const s = WPN_shells[i];
    if(s.life<=0) continue;
    s.life -= dt;
    if(s.life<=0){ s.m.visible = false; continue; }
    s.v.y -= 4.6*dt;
    s.m.position.addScaledVector(s.v, dt);
    s.m.rotation.x += s.w.x*dt; s.m.rotation.y += s.w.y*dt; s.m.rotation.z += s.w.z*dt;
    if(s.m.position.y < -0.60){          // условный «пол» кадра
      s.m.position.y = -0.60;
      s.v.y = Math.abs(s.v.y)*0.34; s.v.x *= 0.55; s.v.z *= 0.55;
      s.w.multiplyScalar(0.5);
      if(!s.tink){ s.tink = true; SFX.noise({dur:0.05, f:2800, q:7, g:0.05}); }
    }
    // общий материал — гасим размером, а не прозрачностью
    s.m.scale.setScalar(clamp(s.life/0.35, 0, 1));
  }
}
/* Дым из ствола, пока он горячий: тем гуще, чем чаще стреляли. */
function WPN_updateBarrelSmoke(dt){
  wpn.heat = Math.max(0, wpn.heat - dt*0.34);
  const on = wpn.heat > 0.05 && vmRoot && vmRoot.visible;
  if(!on){ for(const s of WPN_smoke) s.visible = false; return; }
  vmRifle.localToWorld(WPN_v1.set(0, 0.02, -1.02));
  for(let i=0;i<WPN_smoke.length;i++){
    const s = WPN_smoke[i];
    s.userData.t += dt*(0.55 + i*0.11);
    if(s.userData.t > 1) s.userData.t -= 1;
    const t = s.userData.t;
    s.visible = true;
    s.position.set(WPN_v1.x + Math.sin(t*6.0 + i)*0.03*t,
                   WPN_v1.y + t*0.34,
                   WPN_v1.z + t*0.06);
    s.scale.setScalar(0.10 + t*0.30);
    s.material.opacity = clamp(wpn.heat, 0, 1)*0.42*Math.sin(t*Math.PI);
  }
}

/* ------------------------------ ПУЛИ ------------------------------ */
const bullets = [];
const WPN_BGEO = new THREE.BoxGeometry(0.05,0.05,0.75);
const WPN_MATS = {};        // материалы следа, по одному на тип патрона
const WPN_visAll = [];      // все созданные визуалы пуль
const WPN_visPool = [];     // из них свободные
let WPN_visBusy = 0;
function WPN_matFor(a){
  let m = WPN_MATS[a.id];
  if(!m){
    m = WPN_MATS[a.id] = {
      body: basic(a.trail, {transparent:true, opacity:0.9, depthWrite:false}),
      glow: new THREE.SpriteMaterial({map:TEX_GLOW, color:a.col, blending:THREE.AdditiveBlending, depthWrite:false})
    };
  }
  return m;
}
function WPN_visGet(a){
  const mm = WPN_matFor(a);
  let v = WPN_visPool.pop();
  if(!v){
    const mesh = new THREE.Mesh(WPN_BGEO, mm.body); mesh.frustumCulled = false;
    const glow = new THREE.Sprite(mm.glow); glow.frustumCulled = false;
    v = { mesh, glow };
    WPN_visAll.push(v);
  }
  v.mesh.material = mm.body; v.glow.material = mm.glow;
  // 90_game.js при рестарте вынимает меши из сцены — возвращаем на место
  if(!v.mesh.parent) scene.add(v.mesh);
  if(!v.glow.parent) scene.add(v.glow);
  v.mesh.visible = true; v.glow.visible = true;
  WPN_visBusy++;
  return v;
}
function WPN_visFree(v){
  if(!v) return;
  v.mesh.visible = false; v.glow.visible = false;
  WPN_visPool.push(v);
  if(WPN_visBusy>0) WPN_visBusy--;
}
function WPN_visReclaim(){
  WPN_visPool.length = 0;
  for(let i=0;i<WPN_visAll.length;i++){
    const v = WPN_visAll[i];
    v.mesh.visible = false; v.glow.visible = false;
    WPN_visPool.push(v);
  }
  WPN_visBusy = 0;
}

/* Индекс типа боеприпаса по его дескриптору. Ищем в самом AMMO, а не по
   wpn.idx и не по порядковому номеру из головы: пояс объявлен в 10_core.js,
   и перестановка типов там не должна молча ломать сетевые заявки.
   Пуля бота приходит с самодельным дескриптором ('ai'), которого в AMMO нет:
   такие пули заявок не порождают, им хватит нуля. */
function WPN_ammoIdx(a){
  const i = AMMO.indexOf(a);
  return i < 0 ? 0 : i;
}

function spawnBullet(from, dir, a, dmg, owner, chg){
  const v = WPN_visGet(a);
  const heavy = a.id==='frag';
  const b = {
    pos: from.clone().addScaledVector(dir, 0.5),
    vel: dir.clone().multiplyScalar(a.v),
    a, dmg, owner, chg: chg||0, life:0,
    /* Тип запоминаем НА ПУЛЕ (§9.3): wpn.idx переключается мгновенно, а пуля
       летит до полусекунды. Если в заявку уйдёт текущий выбор, сервер не найдёт
       под неё выстрела — урон потеряется, а нам капнет отказ. */
    ai: WPN_ammoIdx(a),
    vis: v, mesh: v.mesh, glow: v.glow,
    g: CFG.bulletG*a.gMul, drag:a.drag, wm:a.windMul,
    start: from.clone(), trP: from.clone(), trT:0, roll: rnd(0,6.283),
    whiz:false,
    // толстый медленный снаряд читается на трассе, тонкий матчевый — нет
    w: heavy ? 2.4 : (a.id==='fire' ? 1.5 : 0.85),
    gs: heavy ? 0.62 : (a.id==='fire' ? 0.52 : 0.34)
  };
  v.mesh.scale.set(b.w, b.w, 1);
  v.glow.scale.setScalar(b.gs);
  v.mesh.position.copy(b.pos); v.glow.position.copy(b.pos);
  bullets.push(b);
  return b;
}

/* След пули: у каждого типа свой почерк. Ближние 3.5 м не трогаем —
   иначе трасса засвечивает центр экрана и цель не читается. */
function WPN_trail(b, dt){
  const a = b.a;
  b.trT -= dt;
  if(b.trT > 0) return;
  if(b.pos.distanceToSquared(b.start) < 12.25) return;
  if(a.id==='fire'){
    b.trT = 0.055;
    if(FX.magic) FX.magic(b.pos, 1, 0xff8b4a);
    else FX.burst(b.pos, 1, {mat:PMAT.fire, speed:0.8, life:0.45, size:0.06, s1:0.01, g:-1.4});
    if(FX.tracer) FX.tracer(b.trP, b.pos, a.trail, 0.09);
  } else if(a.id==='frag'){
    b.trT = 0.075;
    FX.burst(b.pos, 1, {mat:PMAT.smoke, speed:0.7, life:0.85, size:0.09, s1:0.30, g:-0.8});
  } else {
    b.trT = (b.owner==='player') ? 0.045 : 0.065;
    if(FX.tracer) FX.tracer(b.trP, b.pos, a.trail, 0.06);
  }
  b.trP.copy(b.pos);
}

function updateBullets(dt){
  // внешний сброс (рестарт матча) — вернуть визуалы в пул
  if(bullets.length===0 && WPN_visBusy>0) WPN_visReclaim();
  for(let i=bullets.length-1;i>=0;i--){
    const b = bullets[i];
    const sub = clamp(Math.ceil(dt/0.005), 1, 8);
    const h = dt/sub;
    let dead = false;
    for(let s=0;s<sub && !dead;s++){
      b.vel.y -= b.g*h;
      b.vel.x += wind.x*b.wm*3.0*h;
      b.vel.z += wind.z*b.wm*3.0*h;
      b.vel.multiplyScalar(Math.max(0.2, 1 - b.drag*h));
      const seg = b.vel.length()*h;
      _t1.copy(b.vel).normalize();
      let bt = seg+0.001, hitKind = null, hitObj = null, hitPart = null;
      if(b.owner==='player'){
        for(const e of enemies){
          if(!e.alive) continue;
          const r = e.segHit(b.pos, _t1, bt);
          if(r && r.t < bt){ bt = r.t; hitKind='enemy'; hitObj=e; hitPart=r.part; }
        }
        // Сетевые противники. Попадание засчитывает стреляющий: он бьёт по той
        // позиции, которую видит у себя на экране, — так пропадают «призрачные»
        // промахи по цели, до которой пуля летит полсекунды.
        if(NET_ACTIVE){
          const rn = NETP.segHit(b.pos, _t1, bt);
          if(rn && rn.t < bt){ bt = rn.t; hitKind='netplayer'; hitObj=rn; hitPart=rn.part; }
        }
      } else if(player.alive){
        const r = segPlayer(b.pos, _t1, bt);
        if(r && r.t < bt){ bt = r.t; hitKind='player'; hitPart=r.part; }
      }
      const rb = rayBoxes(b.pos, _t1, bt);
      if(rb){ bt = rb.t; hitKind='box'; hitObj=null; _t4.copy(rb.n); }
      const rt = rayTerrain(b.pos, _t1, bt);
      if(rt){ bt = rt.t; hitKind='terrain'; }

      if(hitKind){
        _t2.copy(b.pos).addScaledVector(_t1, bt);
        onBulletHit(b, hitKind, hitObj, hitPart, _t2, hitKind==='box'?_t4:null);
        dead = true; break;
      }
      b.pos.addScaledVector(b.vel, h);
      b.life += h;
      if(b.life>6 || b.pos.y < -30 || Math.abs(b.pos.x)>140 || Math.abs(b.pos.z)>140) dead = true;
    }
    // свист рядом с ухом
    if(!dead && b.owner==='enemy' && !b.whiz){
      const d = b.pos.distanceTo(camera.position);
      if(d < 3.2){ b.whiz = true; SFX.whiz(panOf(b.pos)); }
    }
    if(dead){ WPN_visFree(b.vis); b.vis = null; bullets.splice(i,1); continue; }

    const m = b.mesh, gl = b.glow;
    m.position.copy(b.pos); gl.position.copy(b.pos);
    m.lookAt(_t1.copy(b.pos).add(b.vel));
    if(b.a.id==='frag'){ b.roll += dt*9; m.rotateZ(b.roll); }   // тяжёлый снаряд кувыркается на трассе
    // на вылете пуля «разгоняется» визуально: у дула она почти не видна
    const fade = clamp(b.pos.distanceTo(b.start)/6, 0, 1);
    const len = clamp(b.vel.length()*0.045, 0.6, 3.2);
    m.scale.set(b.w*(0.35+0.65*fade), b.w*(0.35+0.65*fade), len);
    gl.scale.setScalar(b.gs*(0.35+0.65*fade)*(b.a.id==='fire' ? (0.85+0.25*Math.sin(b.life*40)) : 1));
    WPN_trail(b, dt);
  }
}

/* Крит есть только у типа с AMMO[i].crit === true и никогда у фугаса.
   Полный крит (гарантированное убийство) — ровно один, у матчевого:
   зажигательный бьёт сильнее обычного, но добивает уже горением. */
function WPN_headDamage(a, dmg){
  if(a.id === 'frag' || a.crit !== true) return -1;
  return a.id === 'match' ? 999 : dmg*2.2;
}

function onBulletHit(b, kind, obj, part, pIn, n){
  const a = b.a;
  const P = _hit.copy(pIn);
  if(n) _nrm.copy(n); else _nrm.set(0,1,0);
  const byPlayer = (b.owner === 'player');
  const isFrag = (a.id === 'frag');
  const isFire = (a.id === 'fire');

  if(kind==='enemy'){
    const hd = (part==='head') ? WPN_headDamage(a, b.dmg) : -1;
    const crit = hd >= 0;
    const dmg = crit ? hd : b.dmg;
    const hpWas = obj.hp;
    // здоровье ботов в сети ведёт хост — см. пояснение в explode()
    if(!NET_ACTIVE || NET.host) obj.hurt(dmg, crit ? 'head' : 'body', P);
    else if(byPlayer) NET.reportBotHit(obj.id, dmg, crit ? 'head' : 'body', b.ai);
    if(byPlayer){
      game.hits++;
      const dist = b.start.distanceTo(P);
      hitMarker(crit);
      WPN_v1.copy(P); WPN_v1.y += 0.45;
      FX.num(WPN_v1, (crit && a.id==='match') ? 'КРИТ' : Math.round(Math.min(dmg, hpWas)), crit);
      if(crit){ game.heads++; SFX.crit(); } else SFX.hit();
      if(!obj.alive) game.best = Math.max(game.best, dist);
    }
    FX.burst(P, crit?16:9, {mat:PMAT.blood, speed:crit?9:5.5, life:0.6, size:0.09});
    if(isFire && obj.alive){
      /* Горение бота ведёт хост: у остальных боты — реплики, их update() не
         зовётся, поэтому накопленный burn никогда не стечёт и реплика будет
         гореть вечно, а урон до хоста не дойдёт. */
      if(!NET_ACTIVE || NET.host) obj.applyBurn(a.burnTime*a.burnDps, true);
      else NET.reportBotHit(obj.id, a.burnTime*a.burnDps, 'burn', b.ai);
      if(FX.magic) FX.magic(P, 6, PAL.ember);
    }
  } else if(kind==='netplayer'){
    /* Урон себе не применяем: здоровье чужого игрока ведёт сервер. Мы только
       показываем отклик и отправляем заявку — сервер её проверит и разошлёт. */
    const hd = (part==='head') ? WPN_headDamage(a, b.dmg) : -1;
    const crit = hd >= 0;
    const dmg = crit ? hd : b.dmg;
    game.hits++;
    hitMarker(crit);
    if(crit){ game.heads++; SFX.crit(); } else SFX.hit();
    WPN_v1.copy(P); WPN_v1.y += 0.45;
    FX.num(WPN_v1, (crit && a.id==='match') ? 'КРИТ' : Math.round(dmg), crit);
    FX.burst(P, crit?16:9, {mat:PMAT.blood, speed:crit?9:5.5, life:0.6, size:0.09});
    game.best = Math.max(game.best, b.start.distanceTo(P));
    /* Тип берём у пули, а не из wpn.idx: игрок мог переключить пояс, пока
       пуля летела, и сервер сопоставляет заявку именно с тем выстрелом. */
    NET.reportHit(obj.id, part, dmg, b.ai);
    if(isFire) NET.reportBurn(obj.id, a.burnTime*a.burnDps);
  } else if(kind==='player'){
    // по игроку стреляют боты матчевым — крит у него полноценный
    const crit = (part==='head') && !isFrag;
    /* Здоровье в сети принадлежит серверу (§9.1), поэтому player.hp здесь не
       трогаем ни при каких условиях: и приём урона, и превращение его в заявку
       живут в одном месте — hurtPlayer()/burnPlayer() из 75_combat.js. Свой
       сетевой путь в обход них означал бы второй источник правды. */
    hurtPlayer(crit ? b.dmg*1.65 : b.dmg, b.start, crit ? 'В ГОЛОВУ' : null);
    FX.burst(P, 6, {mat:PMAT.blood, speed:4, life:0.5, size:0.08});
    if(isFire && typeof burnPlayer === 'function') burnPlayer(a.burnTime*a.burnDps);
  } else {
    if(!n) terrainN(P.x,P.z,_nrm);
    /* burst() с нормалью и push сам распознаёт попадание пули и уводит его в
       FX.impact(), а та кладёт след по типу поверхности. Свой FX.decal здесь
       не нужен: он давал вторую метку в той же точке и жёг пул декалей вдвое. */
    FX.burst(P, 8, {mat: kind==='terrain'?PMAT.dust:PMAT.spark, speed:5.5, life:0.55, size:0.075, dir:_nrm, push:3});
    if(isFire){
      // промах зажигательным — это не промах, а очаг на земле
      FX.firePool(P, a.poolR, a.poolTime, a.poolDps, byPlayer);
      // очаг соперника обязан быть виден и опасен и остальным
      if(NET_ACTIVE && byPlayer) NET.reportPool(P);
      if(FX.magic) FX.magic(P, 8, PAL.ember);
    }
    SFX.noise({dur:0.12, f:kind==='terrain'?520:2200, q:2, g:0.16*volOf(P), pan:panOf(P)});
    if(byPlayer && typeof LIGHTS !== 'undefined' && LIGHTS.flash && isFire)
      LIGHTS.flash(P, 0xff7a30, 4, 10, 0.12);
  }

  /* Фугас считает урон площадью и делает это последним: splashDamage()
     сама срежет урон за укрытием, а крита у фугаса нет ни при каком попадании.
     Тип отдаём взрыву явно — заявки об уроне ботам он шлёт сам, и индекс там
     нужен тот же самый, от пули (§9.3). */
  if(isFrag) explode(P, a.splashR, a.splashMax, byPlayer, a.splashFall, a.splashCover, b.ai);
}

function segPlayer(p0, dir, len){
  const hh = player.h;
  const t1 = segSphere(p0,dir,len, player.pos.x, player.pos.y+hh-0.20, player.pos.z, 0.235);
  if(t1>=0) return {t:t1, part:'head'};
  const t2 = segOBB(p0,dir,len, player.pos.x, player.pos.y+hh*0.52, player.pos.z, 0.33, hh*0.40, 0.27, player.yaw);
  if(t2>=0) return {t:t2, part:'body'};
  return null;
}
function segSphere(p0, d, len, cx,cy,cz, r){
  const ox=p0.x-cx, oy=p0.y-cy, oz=p0.z-cz;
  const b = ox*d.x+oy*d.y+oz*d.z;
  const c = ox*ox+oy*oy+oz*oz - r*r;
  const disc = b*b-c;
  if(disc<0) return -1;
  const sq = Math.sqrt(disc);
  let t = -b-sq;
  if(t<0) t = -b+sq;
  if(t<0 || t>len) return -1;
  return Math.max(t,0);
}
function segOBB(p0, d, len, cx,cy,cz, hx,hy,hz, yaw){
  const co=Math.cos(yaw), si=Math.sin(yaw);
  const dx=p0.x-cx, dz=p0.z-cz;
  const O=[dx*co-dz*si, p0.y-cy, dx*si+dz*co];
  const Dv=[d.x*co-d.z*si, d.y, d.x*si+d.z*co];
  const Hh=[hx,hy,hz];
  let t0=0, t1=len;
  for(let a=0;a<3;a++){
    if(Math.abs(Dv[a])<1e-8){ if(Math.abs(O[a])>Hh[a]) return -1; continue; }
    const inv=1/Dv[a];
    let ta=(-Hh[a]-O[a])*inv, tb=(Hh[a]-O[a])*inv;
    if(ta>tb){ const q=ta; ta=tb; tb=q; }
    if(ta>t0) t0=ta;
    if(tb<t1) t1=tb;
    if(t0>t1) return -1;
  }
  return t0<=0 ? 0 : t0;
}
