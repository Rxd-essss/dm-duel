# DM_DUEL v3 — контракт модулей

Игра собирается из `src/*` в один самодостаточный файл `dm_duel_v3.html`:

```bash
node build.js
```

Всё содержимое `src/*.js` попадает **в одну область видимости одного `<script>`**
в лексикографическом порядке имён файлов. Значит:

* объявления верхнего уровня видны всем модулям — это и есть «экспорт»;
* два модуля **не имеют права** объявить одно и то же имя (сборка это проверяет и падает);
* порядок файлов важен только для кода, выполняющегося на верхнем уровне;
  функции и классы можно вызывать из любого модуля.

Сборка также прогоняет `node --check` по склеенному скрипту. **Собирайся после каждой
правки** — красная сборка блокирует всех.

---

## 0. Железные правила

1. **Только three.js r128** (грузится с CDN). Никаких `outputColorSpace`, `WebGLRenderer.useLegacyLights`,
   `BatchedMesh` и прочего из поздних версий. `outputEncoding`, `MeshToonMaterial`, `PointLight` — можно.
2. **Никаких ES-модулей, `import`, `export`, внешних файлов и ассетов.** Всё процедурное.
3. **Не переименовывай и не удаляй существующие публичные имена** (список в §2) — на них завязаны другие модули.
4. **Свои внутренние глобалы префиксуй тегом модуля** (`PHYS_`, `MAP_`, `AI_`, `FX_`, `HUD_`, `WPN_`, `RND_`, `MDL_`).
   Публичные имена — только те, что описаны в этом контракте.
5. **Правь только свои файлы.** Нужен чужой API — он описан здесь; если чего-то не хватает,
   реализуй обход у себя, не лезь в чужой модуль.
6. **Ноль аллокаций в горячем цикле.** Переиспользуй `_t1.._t4` (объявлены в `60_weapon.js`) или
   заведи свои `const _pX = new THREE.Vector3()` на уровне модуля.
7. **Бюджет производительности:** 60 fps на среднем ноутбуке. Максимум 8 динамических `PointLight`
   одновременно (см. `LIGHTS`), суммарно не более ~1500 мешей в сцене, тени только там, где они читаются.
8. **Язык комментариев — русский**, стиль — как в существующем коде: по делу, о «почему», а не о «что».
9. **Читаемость боя важнее красоты.** Это снайперский шутер: силуэт врага должен читаться на 100+ м,
   магические эффекты не должны забивать центр экрана и мешать различать цели.

---

## 1. Владение файлами

| Файл | Владелец | Тема |
|---|---|---|
| `00_head.html`, `01_body.html`, `80_hud.js` | **F** | HUD, разметка, стили, экраны |
| `10_core.js` | *заморожен* | CFG / PAL / AMMO / DIFFS / утилиты / SFX |
| `20_render.js`, `22_tex.js` *(создать)* | **E1** | рендер, свет, материалы, процедурные текстуры |
| `25_terrain.js` | **E2** | ландшафт, небо, атмосфера |
| `30_physics.js`, `85_player.js` | **A** | коллизии, паркур, движение игрока |
| `40_props.js`, `45_map.js` | **B** | пропы и компоновка карты |
| `50_models.js` | **G** | модели винтовки и бойцов |
| `55_fx.js` | **E3** | частицы, взрывы, огонь, магия |
| `60_weapon.js`, `87_weapon_update.js` | **C** | оружие, баллистика, боеприпасы |
| `70_ai.js` | **D** | ИИ противника |
| `75_combat.js`, `90_game.js` | **H** | урон игроку, пикапы, состояния, цикл |
| `99_tail.html` | — | закрывающие теги |

---

## 2. Существующий публичный API (нельзя ломать)

**`10_core.js`** (только чтение):
`CFG`, `PAL`, `AMMO`, `DIFFS`, `clamp`, `lerp`, `rnd`, `rint`, `pick`, `smoothstep`, `damp`,
`fmtTime`, `V(x,y,z)`, `$(id)`, `keys`, `splashDamage(d,R,maxDmg,fall,covered,coverMul)`, `SFX`.

**`20_render.js`**: `renderer`, `scene`, `camera`, `vmScene`, `vmCamera`, `world`, `sun`, `hemi`,
`skyMesh`, `W`, `H`, `initThree()`, `onResize()`, `setShadows(level)`, `GRAD`, `toon(color,opts)`,
`basic(color,opts)`, `sprTex(inner,outer)`, `TEX_GLOW`, `TEX_FIRE`, `TEX_SMOKE`.

**`25_terrain.js`**: `FLATS`, `terrainH(x,z)`, `terrainN(x,z,out)`, `buildTerrain()`, `buildSky()`.

**`30_physics.js`**: `Box`, `BOXES`, `addBoxMesh(...)`, `blk`, `rayBoxes(o,d,maxT)`,
`rayTerrain(o,d,maxT)`, `losClear(a,b)`, `moveHoriz(e,dt)`, `moveVert(e,dt)`.

**`40_props.js`**: `gh(x,z)`, `mkCrate`, `mkBarrel`, `mkContainer`, `mkRock`, `mkTree`, `mkSandbags`,
`mkFence`, `mkHay`, `mkWaterTower`, `mkSlitWall`, `mkWall`, `mkShack`, `mkSign`, `mkNest`, `mkBunker`.

**`45_map.js`**: `POSTS`, `SPAWNS_RED`, `SPAWNS_BLU`, `PICKUPS`, `buildMap()`, `buildPickupMeshes()`.

**`50_models.js`**: `mBox`, `mCyl`, `mkRifle(team,big)`, `mkSniper(team,teamDk)`.

**`55_fx.js`**: `PGEO`, `PMAT`, `FX`, `explode(...)`.

**`60_weapon.js`**: `ZOOMS`, `player`, `wpn`, `wind`, `game`, `D`, `_t1`…`_t4`, `_hit`, `_nrm`, `_mz`,
`_fwd`, `shake(a)`, `playerEye(o)`, `playerCenter(o)`, `panOf(p)`, `volOf(p)`, `vmRoot`, `vmRifle`,
`vmFlash`, `vmHandL`, `buildViewmodel()`, `A()`, `currentSpreadDeg()`, `swayAmp()`, `tryFire()`,
`startReload()`, `finishReload()`, `switchAmmo(i)`, `bullets`, `spawnBullet(...)`, `updateBullets(dt)`,
`onBulletHit(...)`, `segPlayer(...)`, `segSphere(...)`, `segOBB(...)`.

**`70_ai.js`**: `enemies`, `Enemy`, `angDiff(a,b)`, `flyingHats`.

**`75_combat.js`**: `hurtPlayer(dmg,from,label)`, `killPlayer()`, `respawnPlayer()`, `updatePickups(dt)`, `SLOTS`.

**`80_hud.js`**: `updateHP()`, `updateAmmoHUD()`, `updateScore()`, `addFeed(html)`, `toast(t,sub)`,
`hitMarker(crit)`, `dmgFlash(d)`, `dirIndicator(from)`, `updateReticle()`, `updateWind()`, `updateWindHUD()`.

**`85_player.js`**: `accelerate(...)`, `updatePlayer(dt)`, `updateCamera(dt)`.
**`87_weapon_update.js`**: `updateWeapon(dt)`, `updateRangefinder()`.
**`90_game.js`**: `initInput()`, `startGame()`, `pauseGame()`, `resumeGame()`, `endGame(win)`, `loop(now)`, `bindUI()`, `boot()`.

---

## 3. Новый межмодульный API v3

Ниже — **точные сигнатуры**. Владелец обязан реализовать, остальные могут звать.
Пиши код так, будто чужие функции уже существуют.

### 3.1 Свет — `LIGHTS` (владелец **E1**, файл `20_render.js`)

Форвардный рендер three.js не тянет много источников, поэтому все динамические огни идут
через пул: реальных `PointLight` ровно `LIGHTS.max`, они каждый кадр переназначаются
на самые важные (ближние и яркие) логические источники.

```js
const LIGHTS = {
  max: 8,
  init(),                                            // из initThree(), после создания scene
  flash(pos, color, intensity, distance, life),      // разовая вспышка; life в секундах
  addStatic(pos, color, intensity, distance),        // -> handle постоянного источника
  removeStatic(handle),
  setStatic(handle, intensity),                      // для пульсации рун/жаровен
  update(dt, camPos)                                 // вызывает 90_game.js каждый кадр
};
```

* Зовут: `55_fx.js` (взрыв, огонь), `60_weapon.js` (дуло), `45_map.js` (жаровни, кристаллы), `70_ai.js` (выстрел бота).
* `update()` **обязан** гасить неиспользуемые лампы (`intensity = 0`), а не удалять их из сцены.

### 3.2 Текстуры — `TEX` / `toonT` (владелец **E1**, новый файл `22_tex.js`)

Все текстуры процедурные (`<canvas>` → `THREE.CanvasTexture`), кэшируются по ключу.

```js
const TEX = {
  get(name, rx, ry)   // -> THREE.Texture с wrap=RepeatWrapping и repeat=(rx,ry)
};
function toonT(color, name, rx, ry, opts)   // -> MeshToonMaterial с картой; кэш по всем аргументам
```

Обязательный набор `name`:
`'plank'`, `'wood'`, `'metal'`, `'plate'`, `'rust'`, `'conc'`, `'stone'`, `'sand'`, `'cloth'`,
`'roof'`, `'crate'`, `'rune'`, `'grass'`, `'dirt'`.

* Размер холста ≤ 256×256, генерация — один раз при первом запросе.
* `22_tex.js` идёт **после** `20_render.js`, поэтому может пользоваться `toon`, `GRAD`, `MATCACHE`.
* Зовут: `25_terrain.js`, `40_props.js`, `45_map.js`, `50_models.js`.

### 3.3 Паркур и лазание (владелец **A**, файл `30_physics.js`)

```js
const CLIMBS = [];   // зоны вертикального лазания
function addClimb(x, z, y0, y1, yaw, w)   // -> {x,z,y0,y1,yaw,w}; w — ширина зоны
function climbAt(x, z, y)                 // -> зона или null

const ZIPS = [];     // натянутые тросы
function addZip(ax, ay, az, bx, by, bz)   // -> {a:Vector3, b:Vector3, len}
function zipNear(pos, maxD)               // -> {zip, t, point} или null (t — параметр 0..1 вдоль троса)

function mantleFind(e, dx, dz)            // -> {x, y, z} куда встать, или null
```

**Общий контракт сущности.** `moveHoriz(e,dt)` / `moveVert(e,dt)` работают и с игроком, и с ботом.
Сущность — объект с полями `pos`, `vel`, `h`, `grounded`, `stepUp`, `landV`.
Добавляется одно необязательное поле:

* **`e.noGrav === true`** → `moveVert` не применяет гравитацию и не трогает `e.vel.y`
  (вертикалью в этот момент управляет вызывающий: лестница, трос, подтягивание).

Плюс общий примитив, которым пользуются и игрок, и ИИ:

```js
function climbStep(e, dt, wantUp)   // -> true, если e сейчас на лестнице
// Ставит e.noGrav, двигает e.pos.y со скоростью CFG.climbSpeed, снимает у края.
```

Механики, которые **A** реализует в `85_player.js` (`updatePlayer`):
подтягивание на уступ, подкат, магический рывок (`CFG.dash*`), доп. прыжок в воздухе,
coyote-time и буфер прыжка, лестницы, тросы. Управление — см. §5.

### 3.4 Данные карты (владелец **B**, файл `45_map.js`)

Элементы `POSTS` расширяются полями (нужны ИИ):

```js
{ x, z, y,
  via,            // существующее: [{x,z}] маршрут; точка может нести climb:true
  taken,          // существующее
  level,          // 0 — земля, 1 — средний ярус, 2 — верхний
  cover,          // 0..1 — насколько позиция закрыта
  sector,         // 0..7 — сектор карты, Math.floor(((Math.atan2(z,x)+Math.PI)/(Math.PI*2))*8)%8
  name }          // короткая подпись для киллфида/отладки
```

Плюс:

```js
const BRIDGES = [];              // качающиеся мостики: {g:Group, ph, amp, x, z}
function updateMapDynamics(dt)   // качание мостиков, вращение кристаллов, пульс рун
```
`updateMapDynamics(dt)` вызывает `90_game.js` из цикла.

**B** обязан зарегистрировать проходимость: каждая лестница — `addClimb(...)`,
каждый трос — `addZip(...)`. Иначе игрок и боты по ним не полезут.

### 3.5 Эффекты (владелец **E3**, файл `55_fx.js`)

```js
FX.firePool(p, r, life, dps, byPlayer)   // очаг огня; жжёт И ботов, И игрока
FX.magic(p, n, color)                    // магические искры
FX.ring(p, r, color)                     // расходящееся кольцо ударной волны
FX.tracer(a, b, color, life)             // короткий след

explode(p, R, maxDmg, byPlayer, fall, coverMul)
```

`explode` обязан считать урон **строго** через `splashDamage(d, R, maxDmg, fall, covered, coverMul)`
из `10_core.js` — той же формулой пользуются оружие и ИИ. `covered` = `!losClear(эпицентр, центр цели)`.
**Крита при фугасном уроне нет** ни при каких условиях.

Очаг огня наносит игроку урон через `burnPlayer(total)` (см. 3.6), ботам — через `e.applyBurn(total)`.

### 3.6 Горение игрока (владелец **H**, файл `75_combat.js`)

```js
function burnPlayer(total)     // накопить урон горением (складывается, не перезаписывается)
function tickPlayerBurn(dt)    // списать урон за кадр; зовёт A из updatePlayer
```
Поля `player.burn` и `player.burnFx` объявляет **C** в литерале `player` (значения `0` и `null`).

### 3.7 HUD (владелец **F**, файлы `00_head.html`, `01_body.html`, `80_hud.js`)

**F** добавляет разметку и стили и предоставляет сеттеры, которые зовут другие модули:

```js
function setDashHUD(ratio, ready)      // 0..1 заряд рывка; зовёт A
function setBurnHUD(on)                // виньетка горения; зовёт H
function setStatus(key, text, color)   // строка статуса (например «ЗАЖИГ · ОТКАТ 3.4»)
function clearStatus(key)
```

`updateAmmoHUD()` (уже публичный) **обязан** показывать откат каждого типа боеприпаса:
читает `wpn.cd[i]` и `AMMO[i].cd`, рисует заливку в слоте пояса и гасит слот, пока идёт откат.

### 3.8 Боеприпасы и откаты (владелец **C**, файл `60_weapon.js`)

```js
wpn.cd = [0, 0, 0];   // остаток отката по типам, в секундах
```

Правила (проверяются вручную при приёмке):

* Откат **тикает всегда**, даже когда выбран другой тип — в `updateWeapon(dt)`.
* `tryFire()` при `wpn.cd[wpn.idx] > 0` **не стреляет**: `SFX.blocked()` + `setStatus('cd', …)`.
* После выстрела типом `i`: `wpn.cd[i] = AMMO[i].cd`.
* Когда откат типа дошёл до нуля — `SFX.ready()` один раз.
* **Матчевый** — единственный с полным критом в голову (`AMMO[i].crit === true` и это не фугас).
* **Фугасный** — `crit:false`: попадание в голову даёт обычный урон, множителя нет.
  Основной урон — от `explode(...)` с `AMMO[1].splashR/splashMax/splashFall/splashCover`.
* **Зажигательный** — прямой урон слабый, поджигает цель (`burnDps × burnTime`), промах ставит
  очаг огня `FX.firePool(P, poolR, poolTime, poolDps, byPlayer)`. Откат 5 с.

`player` получает новые поля (объявляет **C**): `burn:0`, `burnFx:null`, `dashCd:0`, `dashT:0`,
`slideT:0`, `mantleT:0`, `airJumps:0`, `coyote:0`, `jumpBuf:0`, `climb:null`, `zip:null`, `noGrav:false`.
Значения этих полей ведёт **A**; **C** только объявляет их в литерале.

### 3.9 ИИ (владелец **D**, файл `70_ai.js`)

`Enemy` сохраняет публичную поверхность: `pos`, `vel`, `h`, `hp`, `alive`, `m`, `yaw`, `post`,
`update(dt)`, `segHit(p0,d,len)`, `hurt(dmg,part,at)`, `applyBurn(total,fresh)`, `center(o)`,
`headP(o)`, `eye(o)`, `muzzle(o)`, `respawn(first)`, `die(part,at)`.

Новое:

```js
const SQUAD = {
  update(dt),          // раз в ~0.4 с: раздать роли, выбрать вектор охвата
  roleOf(e),           // 'anchor' | 'flanker' | 'suppressor' | 'rusher'
  onPlayerSeen(e),     // бот доложил о контакте — остальные знают последнюю позицию
  lastKnown            // {x, z, t} последняя известная позиция игрока (t — game.time)
};
```

Требования к поведению:

* **Лазание.** Если следующая точка маршрута выше на > 1.2 м и рядом есть `climbAt(...)` —
  бот лезет через `climbStep(this, dt, true)`. Готовность лезть масштабируется `D.climb`.
* **Обход.** С вероятностью `D.flank` бот выбирает позицию в секторе, смещённом от сектора игрока
  на 2–4 (то есть сбоку/со спины), а не лобовую.
* **Окружение.** Если живых ботов ≥ 3 и игрок держится в одном месте, `SQUAD` разводит их
  по разным секторам вокруг игрока, а не сгоняет в один.
* **Подавление.** С вероятностью `D.sup` бот стреляет по краю укрытия игрока (по последней
  известной позиции), а не ждёт чистой линии — чтобы выгонять игрока с точки.
* **Реакция на огонь.** Горящий бот (`this.burn > 0`) обязан сорваться с позиции и сменить её.
  Бот, попавший в очаг огня или под фугас, отступает.
* Телеграф остаётся: луч + блик оптики перед выстрелом — игрок должен успевать реагировать.

`SQUAD.update(dt)` вызывает `90_game.js` из цикла.

### 3.10 Цикл (владелец **H**, файл `90_game.js`)

В `loop()` добавляются вызовы (порядок важен):

```js
updatePlayer(dt);
updateWeapon(dt);
SQUAD.update(dt);
for (const e of enemies) e.update(dt);
updateBullets(dt);
updatePickups(dt);
updateMapDynamics(dt);
FX.update(dt);
updateCamera(dt);
LIGHTS.update(dt, camera.position);
updateRangefinder();
updateAmmoHUD();
updateWindHUD();
```

`startGame()` обязан сбрасывать новое состояние: `wpn.cd = [0,0,0]`, `player.burn = 0`,
`player.dashCd = 0`, и всё, что относится к паркуру.

---

## 4. Что именно требует заказчик

1. **Аркадность и физика.** Живое, быстрое движение: подкат, подтягивание на уступ, рывок,
   доп. прыжок, coyote-time. Инерция читаемая, но управление отзывчивое.
2. **Боевая динамика и детализация стрельбы.** Отдача, тряска, вспышка, гильза, дым, звук,
   след пули, реакция цели — всё должно давать ощущение веса выстрела.
3. **Боеприпас решает.** Огонь — зона горения и урон по времени, откат 5 с. Фугас — урон по радиусу
   без крита, спад с расстоянием, чтобы выкуривать из укрытий.
4. **Карта.** Заметно детальнее и интереснее: ярусы, навесные мостики, элементы паркура,
   больше мест, где можно полазить.
5. **Динамическое освещение.** Жаровни, кристаллы, огонь, взрывы, дуло — всё светит.
6. **Текстуры.** Процедурные, вместо голых цветов.
7. **Враги.** Детальнее и умнее: лезут, занимают позиции, окружают.
8. **Вайб.** Team Fortress 2 — плотные силуэты, тёплая палитра, «нарисованность» — плюс лёгкая магия:
   руны, кристаллы, эфирные искры. Магия — акцент, а не основной тон.

---

## 5. Управление (единая раскладка v3)

| Действие | Клавиша |
|---|---|
| Движение | `W` `A` `S` `D` |
| Ускорение | `Shift` |
| Присесть / подкат (в беге) | `Ctrl` / `C` |
| Прыжок, доп. прыжок в воздухе | `Space` |
| Подтянуться на уступ | `Space` у стены (автоматически) |
| Магический рывок | `Q` |
| Лестница / трос | `W` в зоне, `Space` — спрыгнуть |
| Выстрел | ЛКМ |
| Оптика | ПКМ |
| Кратность | колесо в оптике |
| Задержать дыхание | `Shift` в оптике |
| Тип патрона | `1` `2` `3` / колесо вне оптики |
| Перезарядка | `R` |
| Пауза | `Esc` |

**F** обязан отразить эту раскладку в брифинге (`01_body.html`), **A** и **H** — реализовать.
