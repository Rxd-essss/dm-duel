#!/usr/bin/env node
/* Сквозная проверка мультиплеера: поднимает настоящий сервер, подключает
   несколько живых клиентов встроенным в Node 22 WebSocket и проверяет
   поведение комнаты целиком — а не отдельные функции.

   Запуск:  node tools/mptest.js [--port 8199]

   Это приёмочный тест, а не юнит: он ловит расхождения между сервером и
   протоколом, гонки за пикап, авторитет здоровья и выбор хоста ботов. */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = (() => {
  const i = process.argv.indexOf('--port');
  return i > 0 ? +process.argv[i + 1] : 8199;
})();
const URL = 'ws://127.0.0.1:' + PORT;

let ok = 0, fail = 0;
const T = (name, cond, extra) => {
  if (cond) { ok++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------ клиент ------------------------------ */
class C {
  constructor(name) {
    this.name = name;
    this.got = [];            // все входящие сообщения
    this.me = null;           // welcome
    this.open = false;
  }
  connect() {
    return new Promise((res, rej) => {
      const ws = new WebSocket(URL);
      this.ws = ws;
      const to = setTimeout(() => rej(new Error('таймаут подключения ' + this.name)), 5000);
      ws.onopen = () => { this.open = true; this.send({ t: 'hello', name: this.name, ver: this.ver }); };
      ws.onmessage = ev => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        this.got.push(m);
        if (m.t === 'ping') this.send({ t: 'pong', k: m.k });
        if (m.t === 'welcome') { clearTimeout(to); this.me = m; res(m); }
        if (m.t === 'err' && !this.me) { clearTimeout(to); res(m); }
      };
      ws.onerror = () => {};
      ws.onclose = () => { this.open = false; };
    });
  }
  send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
  move(x, y, z, extra) {
    this.at = { x, y, z };
    this.send(Object.assign({ t: 'move', s: (this.s = (this.s | 0) + 1), x, y, z, yaw: 0, pitch: 0, h: 1.8, f: 0 }, extra || {}));
  }
  /* Сервер проверяет выстрел по-настоящему: ствол не дальше 6 м от заявленной
     позиции, направление обязано смотреть в цель, темп не быстрее затвора.
     Поэтому целимся честно — иначе мы проверяем не игру, а свою невнимательность. */
  shootAt(ammo, target) {
    const o = { x: this.at.x, y: this.at.y + 1.66, z: this.at.z };
    const c = { x: target.at.x, y: target.at.y + 1.8 * 0.5, z: target.at.z };
    const dx = c.x - o.x, dy = c.y - o.y, dz = c.z - o.z;
    const L = Math.hypot(dx, dy, dz) || 1;
    this.send({ t: 'shot', a: ammo, ox: o.x, oy: o.y, oz: o.z, dx: dx / L, dy: dy / L, dz: dz / L, c: 1 });
  }
  last(t) { for (let i = this.got.length - 1; i >= 0; i--) if (this.got[i].t === t) return this.got[i]; return null; }
  all(t) { return this.got.filter(m => m.t === t); }
  clear() { this.got.length = 0; }
  close() { try { this.ws.close(); } catch (e) {} }
}

/* ------------------------------ прогон ------------------------------ */
(async function main() {
  if (typeof WebSocket === 'undefined') {
    console.error('Нужен Node 18+ со встроенным WebSocket (проверено на 22).');
    process.exit(2);
  }

  console.log('запуск сервера на порту ' + PORT + ' …');
  const srv = spawn(process.execPath, [path.join(ROOT, 'net', 'server.js'), '--port', String(PORT)],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let srvOut = '';
  srv.stdout.on('data', d => { srvOut += d; });
  srv.stderr.on('data', d => { srvOut += d; });
  const die = code => { try { srv.kill(); } catch (e) {} process.exit(code); };
  process.on('exit', () => { try { srv.kill(); } catch (e) {} });

  await sleep(900);
  if (srv.exitCode !== null) { console.error('сервер не поднялся:\n' + srvOut); die(2); }

  try {
    /* --- 1. вход и распределение по командам --- */
    console.log('\n[1] вход в комнату');
    const a = new C('ИГРОК-A'), b = new C('ИГРОК-B'), c = new C('ИГРОК-C');
    const wa = await a.connect(); await sleep(60);
    const wb = await b.connect(); await sleep(60);
    const wc = await c.connect(); await sleep(200);

    T('все трое получили welcome', !!(wa.id && wb.id && wc.id), [wa.t, wb.t, wc.t]);
    T('id различаются', wa.id !== wb.id && wb.id !== wc.id);
    T('команды раскиданы поровну', wa.team !== wb.team, { a: wa.team, b: wb.team });
    T('хост ботов — первый вошедший', wa.host === wa.id, { host: wa.host, a: wa.id });
    T('welcome несёт цель матча', wa.goal > 0, wa.goal);
    T('§9.5 welcome несёт время респавна', typeof wa.respawn === 'number' && wa.respawn > 0, wa.respawn);
    T('о входе сообщили остальным', a.all('join').length >= 2, a.all('join').length);

    /* --- 2. движение и снапшоты --- */
    console.log('\n[2] снапшоты');
    a.clear(); b.clear();
    for (let i = 0; i < 12; i++) { a.move(10 + i, 3, -20); await sleep(25); }
    a.move(21, 3, -20);
    await sleep(250);
    const snaps = b.all('snap');
    T('снапшоты идут', snaps.length >= 4, snaps.length);
    const last = b.last('snap');
    const ea = last && last.p && last.p.find(e => e.i === wa.id);
    T('в снапшоте видно чужую позицию', !!ea && ea.x > 10, ea && ea.x);
    T('§9.5 запись снапшота несёт команду', !!ea && ea.tm !== undefined, ea && ea.tm);
    T('снапшот несёт серверное время', !!last && typeof last.k === 'number');

    /* --- 3. ретрансляция выстрела --- */
    console.log('\n[3] выстрел');
    // ставим стрелка и жертву на дистанцию дуэли и даём серверу увидеть обоих
    a.move(0, 2.2, -56); b.move(0, 2.2, -26); c.move(40, 2, 40);
    await sleep(200);
    b.clear();
    a.shootAt(0, b);
    await sleep(200);
    T('чужой выстрел долетел', b.all('shot').length === 1, b.all('shot').length);
    T('себе выстрел не эхом', a.all('shot').length === 0, a.all('shot').length);

    /* --- 4. попадание: авторитетный урон --- */
    console.log('\n[4] попадание и урон');
    b.clear();
    a.send({ t: 'hit', v: wb.id, p: 'body', d: 40, a: 0 });
    await sleep(250);
    const dmg = b.last('dmg');
    T('жертва получила dmg', !!dmg, dmg);
    T('здоровье пришло с сервера', !!dmg && dmg.hp < 100 && dmg.hp >= 0, dmg && dmg.hp);
    T('указан источник', !!dmg && dmg.from === wa.id, dmg && dmg.from);

    /* --- 5. самоурон (§9.1) --- */
    console.log('\n[5] самоурон');
    c.clear();
    const hpBefore = (() => { const s = c.last('snap'); const e = s && s.p && s.p.find(x => x.i === wc.id); return e ? e.hp : 100; })();
    c.send({ t: 'self', d: 25, c: 'frag' });
    await sleep(250);
    const selfDmg = c.last('dmg');
    T('§9.1 сервер принял самоурон', !!selfDmg, selfDmg);
    T('§9.1 самоурон без источника', !selfDmg || selfDmg.from === -1, selfDmg && selfDmg.from);
    T('§9.1 здоровье уменьшилось', !selfDmg || selfDmg.hp < hpBefore, { was: hpBefore, now: selfDmg && selfDmg.hp });

    /* --- 6. спор за пикап (§9.2) --- */
    console.log('\n[6] спор за пикап');
    // Сервер проверяет близость: оба обязаны реально стоять у предмета.
    // Берём аптечку 5 — западный фланг, ярус 1, лечит на 50.
    // Координаты обязаны совпадать с PICKS в net/server.js (а те — с 45_map.js).
    const PICK = { i: 5, x: -52, y: 7.50, z: -2 };
    a.move(PICK.x + 1, PICK.y, PICK.z); b.move(PICK.x - 1, PICK.y, PICK.z + 1);
    await sleep(220);
    a.clear(); b.clear();
    a.send({ t: 'pick', i: PICK.i });
    b.send({ t: 'pick', i: PICK.i });
    await sleep(300);
    const pa = a.all('pick').filter(m => m.i === PICK.i), pb = b.all('pick').filter(m => m.i === PICK.i);
    const healed = [...pa, ...pb].filter(m => typeof m.hp === 'number');
    T('§9.2 лечение авторитетное (в ответе есть hp)', healed.length > 0, [...pa, ...pb]);
    const owners = new Set([...pa, ...pb].map(m => m.by));
    T('§9.2 обоим сообщили о пикапе', pa.length >= 1 && pb.length >= 1, { a: pa.length, b: pb.length });
    T('§9.2 владелец ровно один', owners.size === 1, [...owners]);
    T('§9.2 указано время возврата', pa.length > 0 && typeof pa[0].at === 'number', pa[0] && pa[0].at);

    /* --- 7. убийство, счёт, респавн --- */
    console.log('\n[7] убийство и респавн');
    // возвращаем дуэльную геометрию и выдерживаем темп затвора (max(cd,bolt)*0.85)
    a.move(0, 2.2, -56); b.move(0, 2.2, -26);
    await sleep(1100);
    a.clear(); b.clear();
    a.shootAt(0, b);
    await sleep(120);
    a.send({ t: 'hit', v: wb.id, p: 'head', d: 900, a: 0 });   // матчевый в голову — крит
    await sleep(350);
    const kill = b.last('kill') || a.last('kill');
    T('убийство объявлено', !!kill && kill.v === wb.id, kill);
    T('убийца назван', !!kill && kill.k === wa.id, kill && kill.k);
    const sc = a.last('score');
    T('счёт разослан', !!sc && (sc.blu + sc.red) >= 1, sc);
    b.clear();
    await sleep(Math.max(1200, (wa.respawn || 3) * 1000 + 400));
    b.send({ t: 'resp' });
    await sleep(400);
    const rs = b.last('resp');
    T('респавн выдан', !!rs, rs);
    T('координаты респавна конечны', !!rs && isFinite(rs.x) && isFinite(rs.y) && isFinite(rs.z), rs);

    /* --- 8. боты и смена хоста --- */
    console.log('\n[8] боты и хост');
    b.clear(); c.clear();
    a.send({ t: 'bots', b: [{ i: 0, x: 1, y: 2, z: 3, yaw: 0, pitch: 0, h: 1.8, st: 1, a: 1 }] });
    await sleep(250);
    const sb = c.last('snap');
    T('кадр ботов долетел до остальных', !!sb && Array.isArray(sb.b) && sb.b.length === 1, sb && sb.b);
    b.clear(); c.clear();
    b.send({ t: 'bots', b: [{ i: 0, x: 9, y: 9, z: 9, yaw: 0, pitch: 0, h: 1.8, st: 1, a: 1 }] });
    await sleep(200);
    const sb2 = c.last('snap');
    T('кадр ботов не от хоста отвергнут', !sb2 || !sb2.b || !sb2.b.length || sb2.b[0].x !== 9, sb2 && sb2.b);
    b.clear(); c.clear();
    a.close();
    await sleep(500);
    const hm = b.last('host');
    T('хост переизбран после ухода', !!hm, hm);

    /* --- 9. устойчивость --- */
    console.log('\n[9] устойчивость');
    const d = new C('ИГРОК-D'); await d.connect(); await sleep(100);
    d.clear();
    d.ws.send('это не json');
    d.ws.send(JSON.stringify({ t: '__proto__' }));
    d.ws.send(JSON.stringify({ t: 'constructor' }));
    d.ws.send(JSON.stringify({ t: 'valueOf' }));
    d.ws.send(JSON.stringify({ t: 'move', s: 1, x: NaN, y: 'ой', z: {} }));
    d.ws.send(JSON.stringify({ t: 'неизвестный' }));
    await sleep(400);
    T('§9.5 ключи прототипа не рвут связь', d.open, 'соединение закрыто');
    d.clear();
    d.move(5, 3, 5);
    await sleep(300);
    T('после мусора клиент жив и получает снапшоты', d.all('snap').length > 0, d.all('snap').length);
    T('сервер не упал', srv.exitCode === null, srv.exitCode);

    b.close(); c.close(); d.close();
    await sleep(200);
  } catch (e) {
    fail++;
    console.log('\nИСКЛЮЧЕНИЕ В ТЕСТЕ: ' + e.message + '\n' + (e.stack || ''));
  }

  console.log('\n──────────────────────────────');
  console.log('пройдено: ' + ok + ', провалено: ' + fail);
  if (srv.exitCode !== null) console.log('!!! сервер завершился с кодом ' + srv.exitCode + '\n' + srvOut.slice(-2000));
  die(fail ? 1 : 0);
})();
