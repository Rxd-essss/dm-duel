/* =====================================================================
   ПРОЦЕДУРНЫЕ ТЕКСТУРЫ (§3.2)

   Ассетов нет и быть не может, поэтому всё рисуется в <canvas> ≤256×256
   и один раз кладётся в кэш. Стиль — не фотоскан, а TF2: крупная деталь,
   видимый мазок, тёплая палитра. Два правила, из которых всё остальное:

   1. Карта не красит объект, она его ТОНИРУЕТ: цвет приходит из материала
      (PAL), поэтому одна доска годится и для ящика, и для мостика. Но она же
      задаёт и ЯРКОСТЬ. Раньше базовый уровень держали у единицы (0.92…0.96) —
      и получили ровно то, на что жаловался заказчик: освещённый солнцем
      светлый камень выбивался в белое целым куском. Общий уровень и контраст
      каждой карты теперь заданы явно, таблицей TX_TONE (см. ниже), и
      подобраны замером кадра, а не на глаз.
   2. Мелкий контрастный шум запрещён. Это снайперский шутер: на 100 м
      текстура обязана усредняться в ровное пятно, иначе она начинает
      конкурировать с силуэтом врага. Отсюда мипы и крупные детали.

   Бесшовность: всё, что рисуется у края, дублируется на противоположную
   сторону (TX_wrap), а периодические узоры получают целое число периодов
   на плитку. Генератор детерминирован (TX_srand) — картинка одинакова от
   запуска к запуску, случайность тут только для «руки художника».
   ===================================================================== */

/* ------------------------------ ИНСТРУМЕНТ ------------------------------ */
let TX_seed = 1;
function TX_srand(s){ TX_seed = (s>>>0) || 1; }
function TX_r(){ TX_seed = (Math.imul(TX_seed, 1664525) + 1013904223) >>> 0; return TX_seed / 4294967296; }
function TX_rr(a,b){ return a + TX_r()*(b-a); }
function TX_ri(a,b){ return Math.floor(TX_rr(a, b+1)); }

/* Кисть: тон 0..~1.2 и альфа. tint — лёгкий тёплый/холодный уклон карты,
   благодаря нему дерево и металл различаются даже под одним цветом. */
function TX_ink(tr,tg,tb){
  return function(v,a){
    const R = Math.round(clamp(v*tr,0,1)*255),
          G = Math.round(clamp(v*tg,0,1)*255),
          B = Math.round(clamp(v*tb,0,1)*255);
    return (a===undefined || a>=1) ? 'rgb('+R+','+G+','+B+')'
                                   : 'rgba('+R+','+G+','+B+','+a.toFixed(3)+')';
  };
}

/* Деталь у края плитки должна выйти с противоположной стороны, иначе шов
   виден за версту. Зерно перед каждой копией откатываем — копии обязаны
   быть идентичными, иначе бесшовности не будет. */
function TX_wrap(S,x,y,r,fn){
  const seed = TX_seed;
  const nx = (x-r < 0) ? 1 : ((x+r > S) ? -1 : 0);
  const ny = (y-r < 0) ? 1 : ((y+r > S) ? -1 : 0);
  TX_seed = seed; fn(x, y);
  if(nx){ TX_seed = seed; fn(x+nx*S, y); }
  if(ny){ TX_seed = seed; fn(x, y+ny*S); }
  if(nx && ny){ TX_seed = seed; fn(x+nx*S, y+ny*S); }
}

// неровное пятно — основа «нарисованности»: ни одна поверхность не ровная
function TX_blob(g,x,y,r,irr,n){
  n = n || 9;
  g.beginPath();
  for(let i=0;i<n;i++){
    const a = i/n*6.283185;
    const rr = r*(1 - irr + TX_r()*irr*2);
    const px = x + Math.cos(a)*rr, py = y + Math.sin(a)*rr;
    if(i===0) g.moveTo(px,py); else g.lineTo(px,py);
  }
  g.closePath();
}
function TX_rrect(g,x,y,w,h,r){
  r = Math.min(r, w*0.5, h*0.5);
  g.beginPath();
  g.moveTo(x+r,y); g.lineTo(x+w-r,y); g.quadraticCurveTo(x+w,y,x+w,y+r);
  g.lineTo(x+w,y+h-r); g.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  g.lineTo(x+r,y+h); g.quadraticCurveTo(x,y+h,x,y+h-r);
  g.lineTo(x,y+r); g.quadraticCurveTo(x,y,x+r,y);
  g.closePath();
}
// мазок: слегка изогнутая линия с круглыми концами
function TX_hair(g,S,x,y,dx,dy,w,style){
  const r = Math.max(Math.abs(dx),Math.abs(dy))*0.5 + w + 1;
  TX_wrap(S,x,y,r,(px,py)=>{
    g.strokeStyle = style; g.lineWidth = w; g.lineCap = 'round';
    g.beginPath();
    g.moveTo(px-dx*0.5, py-dy*0.5);
    g.quadraticCurveTo(px - dy*0.14, py + dx*0.14, px+dx*0.5, py+dy*0.5);
    g.stroke();
  });
}
function TX_mottle(g,S,ink,n,rmin,rmax,vmin,vmax,alpha){
  for(let i=0;i<n;i++){
    const x = TX_rr(0,S), y = TX_rr(0,S), r = TX_rr(rmin,rmax), v = TX_rr(vmin,vmax);
    TX_wrap(S,x,y,r*1.4,(px,py)=>{
      g.fillStyle = ink(v, alpha);
      TX_blob(g,px,py,r,0.34,11); g.fill();
    });
  }
}
function TX_speck(g,S,ink,n,rmin,rmax,vmin,vmax,alpha){
  for(let i=0;i<n;i++){
    const x = TX_rr(0,S), y = TX_rr(0,S), r = TX_rr(rmin,rmax);
    TX_wrap(S,x,y,r+1,(px,py)=>{
      g.fillStyle = ink(TX_rr(vmin,vmax), alpha);
      g.beginPath(); g.arc(px,py,r,0,6.283185); g.fill();
    });
  }
}
// сучок: кольца и тёмное ядро. Ради него доска и не выглядит обоями
function TX_knot(g,S,ink,x,y,r,v){
  TX_wrap(S,x,y,r*1.7,(px,py)=>{
    const rot = TX_rr(0,3.14);
    for(let q=4;q>=1;q--){
      g.strokeStyle = ink(v*(0.54+q*0.08), 0.8);
      g.lineWidth = r*0.2;
      g.beginPath(); g.ellipse(px,py, r*q/4, r*q/4*0.68, rot, 0, 6.283185); g.stroke();
    }
    g.fillStyle = ink(v*0.40, 0.95);
    g.beginPath(); g.ellipse(px,py, r*0.3, r*0.2, rot, 0, 6.283185); g.fill();
  });
}
function TX_rivet(g,S,ink,x,y,r){
  TX_wrap(S,x,y,r+3,(px,py)=>{
    g.fillStyle = ink(0.50,0.55); g.beginPath(); g.arc(px+0.9,py+1.3,r,0,6.283185); g.fill();
    g.fillStyle = ink(0.96);      g.beginPath(); g.arc(px,py,r,0,6.283185); g.fill();
    g.fillStyle = ink(1.14,0.8);  g.beginPath(); g.arc(px-r*0.3,py-r*0.32,r*0.44,0,6.283185); g.fill();
  });
}
// трещина: ломаная, что сужается к концу, со светлой кромкой «на просвет»
function TX_crack(g,S,ink,x,y,len,v){
  TX_wrap(S,x,y,len,(px,py)=>{
    let a = TX_rr(0,6.283185), cx = px, cy = py;
    const n = Math.max(3, Math.round(len/9)), st = len/n;
    g.lineCap = 'round';
    for(let i=0;i<n;i++){
      const nx = cx + Math.cos(a)*st, ny = cy + Math.sin(a)*st;
      g.strokeStyle = ink(v, 0.85 - i/n*0.45);
      g.lineWidth = clamp(2.6*(1-i/n), 0.6, 2.6);
      g.beginPath(); g.moveTo(cx,cy); g.lineTo(nx,ny); g.stroke();
      g.strokeStyle = ink(1.10, 0.22); g.lineWidth = 1;
      g.beginPath(); g.moveTo(cx+1.2,cy+1.4); g.lineTo(nx+1.2,ny+1.4); g.stroke();
      cx = nx; cy = ny; a += TX_rr(-0.55,0.55);
    }
  });
}
/* Мягкое крупное пятно. Жёсткий край у пятна в полсотни пикселей читается
   кляксой, поэтому заливаем радиальным градиентом и слегка сплющиваем —
   идеальные круги на земле выдают себя сразу. */
function TX_soft(g,S,ink,x,y,r,v,a,asp,rot){
  asp = asp || 1; rot = rot || 0;
  TX_wrap(S,x,y,r,(px,py)=>{
    g.save();
    g.translate(px,py); g.rotate(rot); g.scale(1,asp);
    const gr = g.createRadialGradient(0,0,0,0,0,r);
    gr.addColorStop(0.00, ink(v,a));
    gr.addColorStop(0.58, ink(v,a*0.82));
    gr.addColorStop(1.00, ink(v,0));
    g.fillStyle = gr;
    g.beginPath(); g.arc(0,0,r,0,6.283185); g.fill();
    g.restore();
  });
}
function TX_pebble(g,S,ink,x,y,r,v){
  TX_wrap(S,x,y,r+3,(px,py)=>{
    const sd = TX_seed;
    g.fillStyle = ink(v*0.55,0.6); TX_blob(g,px+1,py+1.6,r,0.3,8); g.fill();
    TX_seed = sd;
    g.fillStyle = ink(v);          TX_blob(g,px,py,r,0.3,8); g.fill();
    TX_seed = sd;
    g.fillStyle = ink(v*1.18,0.6); TX_blob(g,px-r*0.22,py-r*0.28,r*0.55,0.3,8); g.fill();
  });
}

/* Глифы для рунного камня: отрезки в локальных координатах -1..1.
   Угловатые, «резаные долотом» — округлых магических завитушек не надо. */
const TX_GLYPH = [
  [[0,-1, 0,1],[0,-0.35, 0.72,-0.85],[0,0.22, -0.72,-0.22],[0,0.66, 0.62,0.34]],
  [[-0.72,-0.9, 0.72,-0.9],[0,-0.9, 0,0.9],[-0.5,0.9, 0.5,0.9],[-0.4,0, 0.4,0]],
  [[-0.8,0.85, 0,-0.9],[0,-0.9, 0.8,0.85],[-0.42,0.12, 0.42,0.12]],
  [[0,-0.95, -0.8,0.2],[-0.8,0.2, 0.8,0.2],[0.8,0.2, 0,-0.95],[0,0.2, 0,0.98]],
  [[-0.7,-0.7, 0.7,0.7],[0.7,-0.7, -0.7,0.7],[0,-1, 0,-0.45],[0,0.45, 0,1]]
];

/* ------------------------------ ГЕНЕРАТОРЫ ------------------------------ */
const TX_GEN = {

  /* доски вдоль U: настилы, мостики, стены сараев */
  plank(g,S){
    const ink = TX_ink(1.00, 0.955, 0.885);
    TX_srand(1701);
    g.fillStyle = ink(0.94); g.fillRect(0,0,S,S);
    const rows = 4, hh = S/rows;
    for(let r=0;r<rows;r++){
      const y0 = r*hh, v = TX_rr(0.86, 1.02);
      g.fillStyle = ink(v); g.fillRect(0, y0, S, hh);
      // волокно — синус с ЦЕЛЫМ числом периодов на плитку, иначе на стыке излом
      const k = TX_ri(1,3);
      for(let i=0;i<12;i++){
        const gy = y0 + TX_rr(4, hh-4), amp = TX_rr(1.0,3.0), ph = TX_rr(0,6.283185);
        g.strokeStyle = ink(v*TX_rr(0.76,0.94), TX_rr(0.25,0.55));
        g.lineWidth = TX_rr(0.9,2.4); g.lineCap = 'round';
        g.beginPath();
        for(let x=0;x<=S;x+=8){
          const yy = gy + Math.sin(x/S*6.283185*k + ph)*amp;
          if(x===0) g.moveTo(x,yy); else g.lineTo(x,yy);
        }
        g.stroke();
      }
      if(TX_r() < 0.85)
        TX_knot(g,S,ink, TX_rr(12,S-12), y0 + hh*0.5 + TX_rr(-hh*0.2,hh*0.2), TX_rr(4.5,8), v);
      // торцевой стык двух досок в ряду
      if(TX_r() < 0.5){
        const jx = TX_rr(20, S-20);
        TX_wrap(S, jx, y0+hh*0.5, 4, (px,py)=>{
          g.fillStyle = ink(0.50,0.8); g.fillRect(px-1.3, py-hh*0.5+3, 2.6, hh-6);
          g.fillStyle = ink(1.08,0.4); g.fillRect(px+1.3, py-hh*0.5+3, 1.2, hh-6);
        });
      }
      // шов между досками: тень сверху, светлая фаска под ней, тень снизу
      g.fillStyle = ink(0.40,0.85); g.fillRect(0, y0, S, 2.4);
      g.fillStyle = ink(1.08,0.45); g.fillRect(0, y0+2.4, S, 1.6);
      g.fillStyle = ink(0.62,0.45); g.fillRect(0, y0+hh-3.2, S, 3.2);
    }
    TX_speck(g,S,ink,90,0.5,1.6,0.62,0.9,0.3);
  },

  /* Те же доски, но ПОПЕРЁК: стены зала «Лесопилки» обшиты вертикальной
     доской (см. референс §10.0), а 'plank' кладёт доску вдоль U. Развернуть
     UV на самой геометрии нельзя: одна и та же стена служит и обшивкой, и
     основанием для настила, и повтор считается из её габаритов.
     Поворот холста на 90° бесшовности не ломает — плитка это тор, а поворот
     на прямой угол переводит тор сам в себя. */
  vplank(g,S){
    g.save();
    g.translate(S, 0); g.rotate(Math.PI/2);
    TX_GEN.plank(g, S);
    g.restore();
  },

  /* цельный брус: стойки, столбы, приклад. Волокно вдоль V */
  wood(g,S){
    const ink = TX_ink(1.00, 0.935, 0.855);
    TX_srand(2207);
    g.fillStyle = ink(0.93); g.fillRect(0,0,S,S);
    // фальш-объём по ширине: столб перестаёт выглядеть плоской наклейкой
    const grd = g.createLinearGradient(0,0,S,0);
    grd.addColorStop(0.00, ink(0.58,0.9)); grd.addColorStop(0.16, ink(0.9,0.0));
    grd.addColorStop(0.42, ink(1.10,0.30)); grd.addColorStop(0.72, ink(0.9,0.0));
    grd.addColorStop(1.00, ink(0.54,0.9));
    g.fillStyle = grd; g.fillRect(0,0,S,S);
    for(let i=0;i<26;i++){
      const gx = TX_rr(4,S-4), amp = TX_rr(1.2,4.0), ph = TX_rr(0,6.283185), k = TX_ri(1,2);
      g.strokeStyle = ink(TX_rr(0.66,0.90), TX_rr(0.20,0.5));
      g.lineWidth = TX_rr(0.9,2.6); g.lineCap = 'round';
      g.beginPath();
      for(let y=0;y<=S;y+=8){
        const xx = gx + Math.sin(y/S*6.283185*k + ph)*amp;
        if(y===0) g.moveTo(xx,y); else g.lineTo(xx,y);
      }
      g.stroke();
    }
    for(let i=0;i<3;i++) TX_knot(g,S,ink, TX_rr(20,S-20), TX_rr(10,S-10), TX_rr(5,9), 0.92);
    // сколотые щепки по краям бруса
    for(let i=0;i<10;i++){
      const y = TX_rr(0,S), w = TX_rr(3,9), h = TX_rr(6,22), x = (TX_r()<0.5)? TX_rr(0,10) : TX_rr(S-10,S);
      TX_wrap(S,x,y,Math.max(w,h),(px,py)=>{
        g.fillStyle = ink(0.68,0.55); TX_blob(g,px,py,w*0.5+h*0.18,0.5,7); g.fill();
      });
    }
    TX_speck(g,S,ink,70,0.5,1.5,0.6,0.9,0.3);
  },

  /* крашеный листовой металл: борта контейнеров, баки, кровельные щиты */
  metal(g,S){
    const ink = TX_ink(0.955, 0.975, 1.0);
    TX_srand(3313);
    g.fillStyle = ink(0.93); g.fillRect(0,0,S,S);
    // Пятен мало и они крупные: десяток мелких контрастных клякс читается
    // как камуфляж, а нужна просто неровно легшая краска.
    TX_mottle(g,S,ink,7,42,92,0.86,1.05,0.35);
    // широкие мазки — краску клали кистью, а не краскопультом
    for(let i=0;i<24;i++){
      const a = TX_rr(-0.3,0.3), l = TX_rr(50,120);
      TX_hair(g,S,TX_rr(0,S),TX_rr(0,S), Math.cos(a)*l, Math.sin(a)*l, TX_rr(4,10), ink(TX_rr(0.86,1.10), 0.2));
    }
    // царапины: тонкие светлые, почти горизонтальные
    for(let i=0;i<28;i++){
      const a = TX_rr(-0.22,0.22), l = TX_rr(18,70);
      TX_hair(g,S,TX_rr(0,S),TX_rr(0,S), Math.cos(a)*l, Math.sin(a)*l, TX_rr(0.7,1.6), ink(TX_rr(1.04,1.15), 0.45));
    }
    // сколы краски: тёмное пятно и светлая кромка обнажённого металла
    for(let i=0;i<16;i++){
      const r = TX_rr(3,9);
      TX_wrap(S,TX_rr(0,S),TX_rr(0,S),r+3,(px,py)=>{
        const sd = TX_seed;
        g.fillStyle = ink(1.12,0.5); TX_blob(g,px,py+1.4,r,0.42,8); g.fill();
        TX_seed = sd;
        g.fillStyle = ink(0.66,0.85); TX_blob(g,px,py,r,0.42,8); g.fill();
      });
    }
    // вмятины
    for(let i=0;i<6;i++){
      const r = TX_rr(10,22);
      TX_wrap(S,TX_rr(0,S),TX_rr(0,S),r+4,(px,py)=>{
        g.fillStyle = ink(0.80,0.35); TX_blob(g,px,py+r*0.2,r,0.3,10); g.fill();
        g.fillStyle = ink(1.10,0.30); TX_blob(g,px,py-r*0.3,r*0.7,0.3,10); g.fill();
      });
    }
  },

  /* стальная плита с заклёпками: бронелисты, люки, опоры мостков */
  plate(g,S){
    const ink = TX_ink(0.945, 0.97, 1.0);
    TX_srand(4409);
    g.fillStyle = ink(0.92); g.fillRect(0,0,S,S);
    TX_mottle(g,S,ink,10,26,70,0.86,1.02,0.4);
    // след проката: диагональ с шагом 8 (делит 256 нацело — шва не будет),
    // случайность привязана к остатку, иначе на стыке линии «разъедутся»
    for(let i=-S;i<S*2;i+=8){
      TX_srand(9000 + (((i % S)+S) % S));
      g.strokeStyle = ink(TX_rr(0.88,1.12), 0.10);
      g.lineWidth = TX_rr(2,6);
      g.beginPath(); g.moveTo(i,0); g.lineTo(i-S,S); g.stroke();
    }
    TX_srand(4457);
    // швы по краю плитки
    g.fillStyle = ink(0.52,0.9); g.fillRect(0,0,S,3); g.fillRect(0,S-3,S,3); g.fillRect(0,0,3,S); g.fillRect(S-3,0,3,S);
    g.fillStyle = ink(1.12,0.5); g.fillRect(0,3,S,1.6); g.fillRect(3,0,1.6,S);
    // заклёпки вдоль швов
    for(let x=16;x<S;x+=32){ TX_rivet(g,S,ink,x,13,4); TX_rivet(g,S,ink,x,S-13,4); }
    for(let y=16;y<S;y+=32){ TX_rivet(g,S,ink,13,y,4); TX_rivet(g,S,ink,S-13,y,4); }
    for(let i=0;i<22;i++){
      const a = TX_rr(-0.3,0.3), l = TX_rr(20,80);
      TX_hair(g,S,TX_rr(0,S),TX_rr(0,S), Math.cos(a)*l, Math.sin(a)*l, TX_rr(0.7,1.7), ink(TX_rr(1.02,1.14), 0.4));
    }
  },

  /* ржавчина: бочки, старые балки, всё, что стоит тут не первый год */
  rust(g,S){
    const ink = TX_ink(1.0, 0.875, 0.735);
    TX_srand(5501);
    g.fillStyle = ink(0.92); g.fillRect(0,0,S,S);
    TX_mottle(g,S,ink,9,34,74,0.66,0.94,0.40);   // крупные зоны поражения
    TX_mottle(g,S,ink,14,9,22,0.56,0.86,0.45);   // очаги внутри них
    TX_mottle(g,S,ink,10,10,26,0.98,1.12,0.32);  // ещё не съеденный металл
    // потёки всегда вниз — по ним читается, где у объекта верх
    for(let i=0;i<26;i++){
      const len = TX_rr(30,96), w = TX_rr(2,7), x = TX_rr(0,S), y = TX_rr(0,S);
      TX_wrap(S, x, y, Math.max(len*0.5,w)+2, (px,py)=>{
        const gr = g.createLinearGradient(px, py-len*0.5, px, py+len*0.5);
        gr.addColorStop(0, ink(0.62,0.55)); gr.addColorStop(0.75, ink(0.66,0.28)); gr.addColorStop(1, ink(0.7,0));
        g.fillStyle = gr; g.fillRect(px-w*0.5, py-len*0.5, w, len);
      });
    }
    // отслоившиеся чешуйки
    for(let i=0;i<14;i++){
      const r = TX_rr(4,11);
      TX_wrap(S,TX_rr(0,S),TX_rr(0,S),r+3,(px,py)=>{
        const sd = TX_seed;
        g.fillStyle = ink(0.48,0.7); TX_blob(g,px+1,py+1.6,r,0.45,8); g.fill();
        TX_seed = sd;
        g.fillStyle = ink(1.05,0.65); TX_blob(g,px,py,r,0.45,8); g.fill();
      });
    }
    TX_speck(g,S,ink,200,0.6,2.0,0.45,0.78,0.45);
  },

  /* бетон: бункер, плиты, подпорные стенки */
  conc(g,S){
    const ink = TX_ink(1.0, 0.985, 0.95);
    TX_srand(6607);
    g.fillStyle = ink(0.95); g.fillRect(0,0,S,S);
    TX_mottle(g,S,ink,14,26,64,0.80,1.04,0.55);
    // следы опалубки: по ним читается масштаб стены
    for(const yy of [0, S*0.5]){
      g.fillStyle = ink(0.72,0.6); g.fillRect(0,yy,S,2.5);
      g.fillStyle = ink(1.08,0.4); g.fillRect(0,yy+2.5,S,1.5);
    }
    // сколы с обнажённым заполнителем
    for(let i=0;i<7;i++){
      const r = TX_rr(6,16);
      TX_wrap(S,TX_rr(0,S),TX_rr(0,S),r+4,(px,py)=>{
        const sd = TX_seed;
        g.fillStyle = ink(0.70,0.7); TX_blob(g,px,py,r,0.42,10); g.fill();
        TX_seed = sd;
        g.fillStyle = ink(1.06,0.45); TX_blob(g,px-1.6,py-1.8,r*0.82,0.42,10); g.fill();
        for(let k=0;k<7;k++){
          g.fillStyle = ink(TX_rr(0.6,1.1),0.65);
          g.beginPath(); g.arc(px+TX_rr(-r,r), py+TX_rr(-r,r), TX_rr(0.8,2.2), 0, 6.283185); g.fill();
        }
      });
    }
    for(let i=0;i<4;i++) TX_crack(g,S,ink, TX_rr(0,S), TX_rr(0,S), TX_rr(30,80), 0.6);
    TX_speck(g,S,ink,240,0.5,1.8,0.68,1.0,0.42);
  },

  /* кладка: цоколи, скальные укрепления, основание рунных площадок */
  stone(g,S){
    const ink = TX_ink(0.99, 0.985, 0.96);
    TX_srand(7717);
    g.fillStyle = ink(0.58); g.fillRect(0,0,S,S);        // раствор
    TX_speck(g,S,ink,140,0.6,1.8,0.5,0.72,0.4);
    const rows = 4, hh = S/rows, cols = 4, bw = S/cols;
    for(let r=0;r<rows;r++){
      const off = (r%2) ? bw*0.5 : 0;
      for(let c=0;c<cols;c++){
        const v = TX_rr(0.82,1.04);
        TX_wrap(S, c*bw + off + bw*0.5, r*hh + hh*0.5, bw*0.5+4, (px,py)=>{
          const x0 = px-bw*0.5+3, y0 = py-hh*0.5+3, w = bw-6, h = hh-6;
          g.fillStyle = ink(v); TX_rrect(g,x0,y0,w,h,5); g.fill();
          // фаска: свет сверху-слева, тень снизу-справа — блок «выступает»
          g.fillStyle = ink(v*1.14,0.55); TX_rrect(g,x0,y0,w,4.5,4); g.fill();
          g.fillStyle = ink(v*1.14,0.32); TX_rrect(g,x0,y0,4.5,h,4); g.fill();
          g.fillStyle = ink(v*0.66,0.5);  TX_rrect(g,x0,y0+h-5,w,5,4); g.fill();
          g.fillStyle = ink(v*0.66,0.32); TX_rrect(g,x0+w-5,y0,5,h,4); g.fill();
          for(let k=0;k<10;k++){
            g.fillStyle = ink(v*TX_rr(0.78,1.12), 0.4);
            g.beginPath(); g.arc(x0+TX_rr(4,w-4), y0+TX_rr(4,h-4), TX_rr(1,3.4), 0, 6.283185); g.fill();
          }
          if(TX_r() < 0.5){
            g.strokeStyle = ink(v*0.6,0.7); g.lineWidth = 1.6; g.lineCap='round';
            let cx = x0+TX_rr(6,w-6), cy = y0+3, a = TX_rr(1.1,2.0);
            g.beginPath(); g.moveTo(cx,cy);
            for(let k=0;k<4;k++){ cx += Math.cos(a)*TX_rr(4,9); cy += Math.sin(a)*TX_rr(4,9); g.lineTo(cx,cy); a += TX_rr(-0.6,0.6); }
            g.stroke();
          }
        });
      }
    }
  },

  /* песок и мешковина: брустверы, дно окопов, насыпи */
  sand(g,S){
    const ink = TX_ink(1.0, 0.955, 0.845);
    TX_srand(8821);
    g.fillStyle = ink(0.96); g.fillRect(0,0,S,S);
    TX_mottle(g,S,ink,14,30,72,0.84,1.06,0.5);
    // грубая мешковина: два перекрёстных набора мягких мазков
    for(let d=0;d<2;d++){
      const a = d? 0.72 : -0.72;
      for(let i=0;i<34;i++){
        const l = TX_rr(30,80);
        TX_hair(g,S,TX_rr(0,S),TX_rr(0,S), Math.cos(a)*l, Math.sin(a)*l, TX_rr(4,9), ink(TX_rr(0.82,1.08), 0.22));
      }
    }
    for(let i=0;i<11;i++){
      const r = TX_rr(8,18);
      TX_wrap(S,TX_rr(0,S),TX_rr(0,S),r+3,(px,py)=>{
        g.fillStyle = ink(TX_rr(0.76,0.90),0.5); TX_blob(g,px,py,r,0.35,10); g.fill();
      });
    }
    TX_speck(g,S,ink,380,0.5,1.6,0.76,1.10,0.4);
  },

  /* брезент и ткань: тенты, флаги, палатки */
  cloth(g,S){
    const ink = TX_ink(1.0, 0.99, 0.965);
    TX_srand(9931);
    g.fillStyle = ink(0.93); g.fillRect(0,0,S,S);
    // Складки — главное в ткани: без них тент выглядит куском картона.
    // Полосы идут на всю высоту, поэтому по вертикали шва не возникает.
    for(let i=0;i<7;i++){
      const w = TX_rr(26,62);
      TX_wrap(S,TX_rr(0,S),S*0.5,w,(px)=>{
        const gr = g.createLinearGradient(px-w*0.5,0,px+w*0.5,0);
        gr.addColorStop(0.00, ink(0.8,0));     gr.addColorStop(0.38, ink(0.66,0.55));
        gr.addColorStop(0.56, ink(1.14,0.45)); gr.addColorStop(1.00, ink(1.0,0));
        g.fillStyle = gr; g.fillRect(px-w*0.5,0,w,S);
      });
    }
    // Переплетение с шагом 8 (делит 256 нацело). Нить рисуем отрезками, а не
    // сплошной полосой: сплошная даёт муар, отрезки мипы сводят в ровный тон.
    for(let x=0;x<S;x+=8){
      for(let y=0;y<S;y+=8){
        g.fillStyle = ink(1.10,0.22); g.fillRect(x,y,4.5,4.5);
        g.fillStyle = ink(0.78,0.22); g.fillRect(x+4,y+4,4.5,4.5);
        g.fillStyle = ink(0.86,0.16); g.fillRect(x+4,y,4.5,4.5);
        g.fillStyle = ink(1.02,0.16); g.fillRect(x,y+4,4.5,4.5);
      }
    }
    // Сшивка полотнищ: горизонтальный рубец со строчкой по обе стороны.
    // Идёт по краю плитки — при повторе получается ровный ряд швов.
    g.fillStyle = ink(0.86,0.55); g.fillRect(0,S-7,S,7); g.fillRect(0,0,S,7);
    g.fillStyle = ink(1.14,0.45); g.fillRect(0,S-7,S,2);   // блик на верхе рубца
    g.fillStyle = ink(0.60,0.45); g.fillRect(0,5,S,2);     // тень на низе — уже в следующей плитке
    g.setLineDash([7,6]); g.lineWidth = 2; g.lineCap = 'butt';
    g.strokeStyle = ink(0.58,0.75);
    g.beginPath(); g.moveTo(0,S-4); g.lineTo(S,S-4); g.moveTo(0,2.5); g.lineTo(S,2.5); g.stroke();
    g.setLineDash([]);
    // потёртости на сгибах
    for(let i=0;i<12;i++){
      const l = TX_rr(20,60), a = TX_rr(1.3,1.85);
      TX_hair(g,S,TX_rr(0,S),TX_rr(0,S), Math.cos(a)*l, Math.sin(a)*l, TX_rr(2,5), ink(TX_rr(1.06,1.16), 0.3));
    }
    TX_speck(g,S,ink,120,0.5,1.4,0.72,1.08,0.3);
  },

  /* черепица: крыши сараев, навесы редутов */
  roof(g,S){
    const ink = TX_ink(1.0, 0.94, 0.895);
    TX_srand(1223);
    g.fillStyle = ink(0.6); g.fillRect(0,0,S,S);
    const rows = 4, hh = S/rows, per = 8, tw = S/per;
    for(let r=0;r<rows;r++){
      const off = (r%2) ? tw*0.5 : 0, yr = r*hh;
      for(let c=0;c<per;c++){
        const v = TX_rr(0.80,1.06), broken = TX_r() < 0.10;
        TX_wrap(S, c*tw + off + tw*0.5, yr + hh*0.5, tw*0.5+5, (px,py)=>{
          const x0 = px-tw*0.5+1, y0 = py-hh*0.5-3, w = tw-2, h = hh+3;
          // тень: верхний ряд лежит на нижнем, стык обязан читаться
          g.fillStyle = ink(0.42,0.7); TX_rrect(g,x0-1.5,y0-2,w+3,h+2,4); g.fill();
          g.fillStyle = ink(broken? v*0.72 : v); TX_rrect(g,x0,y0,w,h,4); g.fill();
          g.fillStyle = ink(v*1.16,0.5); g.fillRect(x0+2,y0+2,w-4,2.5);
          g.fillStyle = ink(v*0.7,0.4);  g.fillRect(x0+2,y0+h-4,w-4,3);
          for(let k=0;k<4;k++){
            g.fillStyle = ink(v*TX_rr(0.82,1.1),0.35);
            g.beginPath(); g.arc(x0+TX_rr(3,w-3), y0+TX_rr(5,h-4), TX_rr(1,2.6), 0, 6.283185); g.fill();
          }
          if(broken){
            g.strokeStyle = ink(0.3,0.85); g.lineWidth = 2; g.lineCap='round';
            g.beginPath(); g.moveTo(x0+w*0.5, y0+3); g.lineTo(x0+w*TX_rr(0.2,0.8), y0+h-2); g.stroke();
          }
        });
      }
    }
  },

  /* грань армейского ящика: доски в рамке и трафарет */
  crate(g,S){
    const ink = TX_ink(1.0, 0.945, 0.86);
    TX_srand(1361);
    const nb = 4, bw = S/nb;
    g.fillStyle = ink(0.92); g.fillRect(0,0,S,S);
    for(let i=0;i<nb;i++){
      const v = TX_rr(0.86,1.02), x = i*bw;
      g.fillStyle = ink(v); g.fillRect(x,0,bw,S);
      for(let k=0;k<8;k++){
        const gx = x + TX_rr(3,bw-3), amp = TX_rr(0.8,2.4), ph = TX_rr(0,6.283185), kk = TX_ri(1,2);
        g.strokeStyle = ink(v*TX_rr(0.76,0.94), TX_rr(0.22,0.5));
        g.lineWidth = TX_rr(0.9,2.2); g.lineCap='round';
        g.beginPath();
        for(let y=0;y<=S;y+=8){
          const xx = gx + Math.sin(y/S*6.283185*kk + ph)*amp;
          if(y===0) g.moveTo(xx,y); else g.lineTo(xx,y);
        }
        g.stroke();
      }
      g.fillStyle = ink(0.44,0.85); g.fillRect(x,0,2.2,S);
      g.fillStyle = ink(1.08,0.4);  g.fillRect(x+2.2,0,1.4,S);
    }
    // Рамка по периметру. Через границу плитки полоса ЕДИНАЯ, поэтому блик
    // кладём на её верх (y = S-fr), а тень — на низ, который уже в следующей
    // плитке. Иначе на стыке встретятся блик и тень, и шов станет виден.
    const fr = 22;
    g.fillStyle = ink(1.0);
    g.fillRect(0,0,S,fr); g.fillRect(0,S-fr,S,fr); g.fillRect(0,0,fr,S); g.fillRect(S-fr,0,fr,S);
    g.fillStyle = ink(1.12,0.45); g.fillRect(0,S-fr,S,2);
    g.fillStyle = ink(0.50,0.60); g.fillRect(0,fr-2.5,S,2.5);
    g.fillStyle = ink(1.10,0.40); g.fillRect(S-fr,0,2,S);
    g.fillStyle = ink(0.50,0.55); g.fillRect(fr-2,0,2,S);
    for(const cx of [fr*0.5, S-fr*0.5]) for(const cy of [fr*0.5, S-fr*0.5]){
      g.fillStyle = ink(0.7,0.75); TX_rrect(g,cx-13,cy-13,26,26,4); g.fill();
      TX_rivet(g,S,ink,cx,cy,3.2);
    }
    // трафарет: угловатый знак, слегка вытертый
    const cx = S*0.5, cy = S*0.5, sc = 34;
    g.save();
    g.globalAlpha = 0.5; g.strokeStyle = ink(0.30); g.lineWidth = 5; g.lineCap='round'; g.lineJoin='round';
    g.beginPath(); g.arc(cx,cy,sc,0,6.283185); g.stroke();
    const gl = TX_GLYPH[3];
    g.beginPath();
    for(const seg of gl){ g.moveTo(cx+seg[0]*sc*0.62, cy+seg[1]*sc*0.62); g.lineTo(cx+seg[2]*sc*0.62, cy+seg[3]*sc*0.62); }
    g.stroke();
    g.restore();
    TX_speck(g,S,ink,110,0.5,1.7,0.6,0.92,0.3);
  },

  /* рунный камень: тёмная порода со светящейся резьбой.
     Для свечения бери материал toonT(col,'rune',rx,ry,{emissive:…, emissiveMap:true})
     — тогда emissiveMap подставится из маски 'runeglow' и светиться будет
     только резьба, а не весь блок. */
  rune(g,S){ TX_runeStone(g,S,false); },
  runeglow(g,S){ TX_runeStone(g,S,true); },

  /* Руны, ВРЕЗАННЫЕ В БРУС. MAPDESIGN §10.6 требует, чтобы магия встраивалась
     в дерево, а не спорила с ним: на несущих балках зала слабо светится
     резьба, и балка при этом остаётся деревянной. Через 'rune' этого не
     сделать — там камень, и брус с каменной картой читается колонной.
     Пользоваться так же: toonT(PAL.woodDk,'runewood',rx,ry,{emissive:…,
     emissiveMap:true}) — маска 'runewoodglow' подставится сама. */
  runewood(g,S){ TX_runeBeam(g,S,false); },
  runewoodglow(g,S){ TX_runeBeam(g,S,true); },

  /* Решётчатый настил: площадки над шахтой. Не прозрачный — сквозной настил
     потребовал бы alphaTest, а это отдельная ветка сортировки и лишний
     материал; рисунок решётки с провалами в чёрное читается сверху так же,
     а снизу площадка и должна быть тёмной. */
  grate(g,S){
    const ink = TX_ink(0.95, 0.97, 1.0);
    TX_srand(2903);
    g.fillStyle = ink(0.10); g.fillRect(0,0,S,S);      // провал между прутьями
    const step = S/8;                                   // 8 делит 256 нацело
    for(let i=0;i<8;i++){
      const p = i*step;
      // прут: тёмное основание, светлая фаска сверху-слева
      g.fillStyle = ink(0.52); g.fillRect(p, 0, step*0.34, S);
      g.fillStyle = ink(0.52); g.fillRect(0, p, S, step*0.34);
      g.fillStyle = ink(0.86,0.7); g.fillRect(p, 0, step*0.12, S);
      g.fillStyle = ink(0.86,0.7); g.fillRect(0, p, S, step*0.12);
      g.fillStyle = ink(0.30,0.6); g.fillRect(p+step*0.28, 0, step*0.08, S);
      g.fillStyle = ink(0.30,0.6); g.fillRect(0, p+step*0.28, S, step*0.08);
    }
    TX_speck(g,S,ink,160,0.5,1.8,0.35,0.80,0.4);       // грязь и задиры
    for(let i=0;i<8;i++){
      const a = TX_rr(-0.3,0.3), l = TX_rr(20,60);
      TX_hair(g,S,TX_rr(0,S),TX_rr(0,S), Math.cos(a)*l, Math.sin(a)*l, TX_rr(1,2.4), ink(TX_rr(1.0,1.15), 0.35));
    }
  },

  /* Трава: терраин и склоны.
     Главная работа этой карты — не «зерно», а КРУПНЫЙ ТОН. 25_terrain.js
     нормирует детальную карту по её собственному среднему, поэтому общий
     уровень тут не значит ничего, а значит РАЗБРОС. Старая трава давала
     множитель 0.83…0.93 — по сути константу, и замер это показывал в лоб:
     взгляд вниз на открытую землю давал p05..p95 = 145..178 из 255, то есть
     ровное светлое поле без света и тени, максимум яркости 183…196.
     Крупные пятна ниже дают ходу вниз до нижнего клампа шейдера и вверх до
     верхнего — и поле наконец получает объём.
     Масштаб пятен выбран не на глаз: плитка травы ~5 м, значит пятно радиусом
     50…110 текселей — это 2…4.5 м на земле, а вторая октава (плитка ~17 м)
     растягивает его до 7…15 м. И то и другое КРУПНЕЕ бойца, поэтому на 100 м
     такое пятно не спорит с силуэтом, а работает фоном под ним. */
  grass(g,S){
    const ink = TX_ink(0.95, 1.0, 0.875);
    TX_srand(1601);
    g.fillStyle = ink(0.72); g.fillRect(0,0,S,S);
    TX_mottle(g,S,ink,14,18,44,0.62,1.02,0.38);
    // пучки мазками: короткие, направленные вверх, три тона.
    // Длину держим малой — на 100 м это обязано слиться в ровный тон,
    // а не в рябь, спорящую с силуэтом
    for(let i=0;i<320;i++){
      const l = TX_rr(4,11), a = TX_rr(-1.95,-1.2);
      TX_hair(g,S,TX_rr(0,S),TX_rr(0,S), Math.cos(a)*l, Math.sin(a)*l, TX_rr(1.4,3.0), ink(TX_rr(0.55,0.95), TX_rr(0.35,0.7)));
    }
    for(let i=0;i<50;i++){
      const l = TX_rr(6,13), a = TX_rr(-2.0,-1.15);
      TX_hair(g,S,TX_rr(0,S),TX_rr(0,S), Math.cos(a)*l, Math.sin(a)*l, TX_rr(1,2.2), ink(TX_rr(1.02,1.16), 0.55));
    }
    for(let i=0;i<9;i++){
      const r = TX_rr(7,16);
      TX_wrap(S,TX_rr(0,S),TX_rr(0,S),r+3,(px,py)=>{
        g.fillStyle = ink(0.44,0.55); TX_blob(g,px,py,r,0.4,10); g.fill();
      });
    }
    /* Крупный тон кладём ПОВЕРХ зерна и через multiply/screen, а не заливкой:
       заливка стёрла бы траву, а умножение только меняет её уровень. Это и
       есть та самая тень и тот самый свет, которых на открытой земле не было. */
    g.save();
    g.globalCompositeOperation = 'multiply';
    for(let i=0;i<7;i++)                       // сырые лощины
      TX_soft(g,S,ink, TX_rr(0,S), TX_rr(0,S), TX_rr(54,118), TX_rr(0.40,0.62), TX_rr(0.85,1.0), TX_rr(0.5,1.0), TX_rr(0,3.14));
    for(let i=0;i<9;i++)                        // средний масштаб — связка
      TX_soft(g,S,ink, TX_rr(0,S), TX_rr(0,S), TX_rr(22,52), TX_rr(0.62,0.90), TX_rr(0.5,0.85), TX_rr(0.5,1.0), TX_rr(0,3.14));
    g.globalCompositeOperation = 'screen';
    for(let i=0;i<6;i++)                        // выгоревшие проплешины
      TX_soft(g,S,ink, TX_rr(0,S), TX_rr(0,S), TX_rr(46,104), TX_rr(0.30,0.52), TX_rr(0.85,1.0), TX_rr(0.5,1.0), TX_rr(0,3.14));
    for(let i=0;i<7;i++)
      TX_soft(g,S,ink, TX_rr(0,S), TX_rr(0,S), TX_rr(20,48), TX_rr(0.16,0.34), TX_rr(0.6,0.9), TX_rr(0.5,1.0), TX_rr(0,3.14));
    g.restore();
  },

  /* Земля: тропы, дно дворов, проплешины. Та же беда, что у травы, и то же
     лекарство — крупный тон вместо ровной заливки. */
  dirt(g,S){
    const ink = TX_ink(1.0, 0.95, 0.875);
    TX_srand(1721);
    g.fillStyle = ink(0.74); g.fillRect(0,0,S,S);
    TX_mottle(g,S,ink,16,16,40,0.60,1.02,0.40);
    for(let i=0;i<26;i++) TX_pebble(g,S,ink, TX_rr(0,S), TX_rr(0,S), TX_rr(2,6), TX_rr(0.7,0.98));
    for(let i=0;i<5;i++) TX_crack(g,S,ink, TX_rr(0,S), TX_rr(0,S), TX_rr(24,60), 0.50);
    // борозды от колёс и ног
    for(let i=0;i<16;i++){
      const a = TX_rr(-0.35,0.35), l = TX_rr(30,80);
      TX_hair(g,S,TX_rr(0,S),TX_rr(0,S), Math.cos(a)*l, Math.sin(a)*l, TX_rr(3,8), ink(TX_rr(0.62,0.80), 0.28));
    }
    TX_speck(g,S,ink,300,0.5,1.8,0.58,0.94,0.3);
    g.save();
    g.globalCompositeOperation = 'multiply';
    for(let i=0;i<7;i++)
      TX_soft(g,S,ink, TX_rr(0,S), TX_rr(0,S), TX_rr(50,112), TX_rr(0.40,0.62), TX_rr(0.85,1.0), TX_rr(0.5,1.0), TX_rr(0,3.14));
    for(let i=0;i<9;i++)
      TX_soft(g,S,ink, TX_rr(0,S), TX_rr(0,S), TX_rr(20,50), TX_rr(0.60,0.90), TX_rr(0.5,0.85), TX_rr(0.5,1.0), TX_rr(0,3.14));
    g.globalCompositeOperation = 'screen';
    for(let i=0;i<6;i++)
      TX_soft(g,S,ink, TX_rr(0,S), TX_rr(0,S), TX_rr(44,100), TX_rr(0.30,0.52), TX_rr(0.85,1.0), TX_rr(0.5,1.0), TX_rr(0,3.14));
    for(let i=0;i<7;i++)
      TX_soft(g,S,ink, TX_rr(0,S), TX_rr(0,S), TX_rr(18,46), TX_rr(0.16,0.34), TX_rr(0.6,0.9), TX_rr(0.5,1.0), TX_rr(0,3.14));
    g.restore();
  }
};

/* Брус с врезанными рунами и его маска свечения. Как и у камня, база и маска
   рисуются одним кодом с одного зерна — иначе свечение съедет с резьбы.
   Глифы выстроены столбиком по центру бруса: балка длинная и узкая, а руны,
   разбросанные как по камню, на ней складываются в мусор. */
function TX_runeBeam(g,S,glow){
  const ink = TX_ink(0.96, 0.99, 1.0);
  if(glow){
    g.fillStyle = '#000'; g.fillRect(0,0,S,S);
  } else {
    g.save(); TX_GEN.wood(g,S); g.restore();
  }
  TX_srand(2311);
  const n = 3, step = S/n;
  for(let i=0;i<n;i++){
    const cx = S*0.5 + TX_rr(-5,5), cy = i*step + step*0.5, sc = step*0.26;
    const gl = TX_GLYPH[TX_ri(0, TX_GLYPH.length-1)];
    TX_wrap(S,cx,cy,sc*1.8,(px,py)=>{
      const stroke = (style,w,blur)=>{
        g.strokeStyle = style; g.lineWidth = w; g.lineCap='round'; g.lineJoin='round';
        g.shadowBlur = blur||0; g.shadowColor = 'rgba(150,235,255,0.9)';
        g.beginPath();
        for(const seg of gl){ g.moveTo(px+seg[0]*sc, py+seg[1]*sc); g.lineTo(px+seg[2]*sc, py+seg[3]*sc); }
        g.stroke();
        g.shadowBlur = 0;
      };
      g.save();
      // на дереве жёлоб делаем мягче, чем на камне: долото по волокну не рвёт
      if(!glow) stroke(ink(0.24,0.9), sc*0.22, 0);
      g.globalCompositeOperation = 'lighter';
      stroke(glow ? 'rgba(58,132,176,0.5)' : ink(0.5,0.26), sc*0.30, sc*0.7);
      stroke(glow ? 'rgba(196,246,255,0.92)' : 'rgba(200,244,255,0.72)', sc*0.10, sc*0.32);
      g.restore();
    });
  }
  g.shadowBlur = 0;
}

/* Камень и его маска свечения рисуются одним кодом: раскладка глифов должна
   совпадать до пикселя, иначе emissiveMap «поедет» относительно резьбы. */
function TX_runeStone(g,S,glow){
  const ink = TX_ink(0.93, 0.98, 1.0);
  if(glow){
    g.fillStyle = '#000'; g.fillRect(0,0,S,S);
  } else {
    TX_srand(1499);
    g.fillStyle = ink(0.52); g.fillRect(0,0,S,S);
    TX_mottle(g,S,ink,14,20,54,0.40,0.66,0.5);
    TX_speck(g,S,ink,220,0.6,2.0,0.34,0.70,0.4);
    for(let i=0;i<3;i++) TX_crack(g,S,ink, TX_rr(0,S), TX_rr(0,S), TX_rr(40,90), 0.30);
  }
  TX_srand(1777);
  for(let n=0;n<4;n++){
    const cx = TX_rr(34,S-34), cy = TX_rr(34,S-34), sc = TX_rr(17,27);
    const gl = TX_GLYPH[TX_ri(0, TX_GLYPH.length-1)], ring = TX_r() < 0.5;
    TX_wrap(S,cx,cy,sc*1.7,(px,py)=>{
      const stroke = (style,w,blur)=>{
        g.strokeStyle = style; g.lineWidth = w; g.lineCap='round'; g.lineJoin='round';
        g.shadowBlur = blur||0; g.shadowColor = 'rgba(150,235,255,0.9)';
        g.beginPath();
        for(const seg of gl){ g.moveTo(px+seg[0]*sc, py+seg[1]*sc); g.lineTo(px+seg[2]*sc, py+seg[3]*sc); }
        if(ring) { g.moveTo(px+sc*1.2, py); g.arc(px,py,sc*1.2,0,6.283185); }
        g.stroke();
        g.shadowBlur = 0;
      };
      g.save();
      if(!glow) stroke(ink(0.20,0.95), sc*0.26, 0);          // прорезанный жёлоб
      g.globalCompositeOperation = 'lighter';
      stroke(glow ? 'rgba(60,140,185,0.55)' : ink(0.5,0.30), sc*0.34, sc*0.75);
      stroke(glow ? 'rgba(200,248,255,0.95)' : 'rgba(205,246,255,0.8)', sc*0.11, sc*0.35);
      g.restore();
    });
  }
  g.shadowBlur = 0;
}

/* ------------------------- ЭКСПОЗИЦИЯ КАРТ -------------------------
   Приёмка мерила реальные пиксели и указала пальцем: в кадре у жаровни ярче
   235 было 55% пикселей, и когда огонь погасили — осталось 47%. То есть
   выбивал не свет, а АЛЬБЕДО: освещённый солнцем светлый камень и доска.
   Считается это в лоб: карта 'stone' имела средний тон 0.82, цвет PAL.conc
   даёт 0.5 по яркости, суммарная освещённость грани на солнце ~2.0 — на
   выходе 225 из 255 у СРЕДНЕГО тексела, а разброс карты добивал остальное.

   Правило «карта только тонирует, база у единицы» из шапки файла было
   ошибкой ровно в этом: оно оставляло всю яркость на совести PAL, а PAL
   калибровался без тонмаппинга. Здесь общий уровень крупных светлых
   поверхностей опускается, а заодно растягивается их собственный контраст —
   чтобы стена не превратилась в ровную серую заливку.

   lvl — во сколько раз опускается средний тон карты;
   con — показатель контраста вокруг этого среднего (>1 — разброс шире).
   Меняется тон, не цвет: опора считается по каждому каналу отдельно.
   Земля ('grass'/'dirt'/'stone' в терраине) нормируется по среднему в
   25_terrain.js, поэтому lvl на неё не влияет вовсе — только con. */
/* ПЕРЕСМОТР ПОД ЗАМЕР ПО РАКУРСАМ ИГРОКА. Прежние уровни подбирались под
   тонмаппинг, растягивавший яркость (L^1.5). Кривая заменена на сжимающую
   (20_render.js), и разброс альбедо стал виден напрямую — а он был перекошен.
   Разбор пикселей кадра по материалу показал ровно двух виновников каждой
   беды, и оба чинятся здесь.

   ЧТО ВЫБИВАЛО. Ракурс «ярус 3, взгляд вниз»: 99% пикселей ярче 235 давала
   доска стропил (deck3, #c59d66 по карте 'plank'). Ракурс «ярус 0, поперёк»:
   88% — круг опилок на полу (#bda06a по карте 'sand'). Отсюда 'plank' и
   особенно 'sand' опущены.

   ЧТО ПРОВАЛИВАЛОСЬ В ЧЁРНОЕ. Ракурсы «вверх на стропила»: 93…95% пикселей
   темнее 80 давала изнанка кровли (#6c4530 по карте 'roof'), остальное —
   несущий брус (#5e3820 по карте 'wood'). Отсюда 'roof' поднят вдвое: изнанка
   кровли занимает половину кадра на верхних ярусах и не освещается ничем,
   кроме полусферы, а собственного тона у неё почти не было.

   'wood', НАОБОРОТ, ОПУЩЕН (0.73 -> 0.62). Той же картой крыты длинные стены
   зала, а стена — это половина кадра на ракурсах «поперёк» и почти весь кадр
   на «вплотную к настенной лампе». Замер: при 0.85 стена в двух метрах давала
   ровные 210 из 255 и тянула ракурс у лампы к 188 при рамке 120…160.

   КОНТРАСТ ВАЖНЕЕ УРОВНЯ. Приёмка требует в каждом кадре не меньше 6%
   пикселей темнее 60, а кадр «стена в двух метрах» никакой геометрической
   тени не содержит вовсе — тени там взяться неоткуда. Зато у доски есть швы
   и волокно, и они ТЁМНЫЕ. Поэтому у крупных пород (доска, брус, кровля,
   ящик, решётка, металл) показатель контраста поднят с 1.2…1.3 до 3.6: щели
   между досками уходят в тень, доля тёмных пикселей по 29 ракурсам выросла
   с 1.1% до 13%, а общий уровень при этом почти не поехал. Мипы усредняют
   этот рисунок на дистанции, поэтому правило «на 100 м текстура обязана
   собраться в ровное пятно» не нарушено — проверено замером силуэта.

   'grass'/'dirt'/'stone' на ЗЕМЛЕ нормируются по среднему (25_terrain.js),
   поэтому на ландшафт lvl по-прежнему не влияет — только на пропы. Земляной
   ПОЛ ЗАЛА — это не ландшафт, а отдельная плита с картой 'dirt' (45_map.js),
   и её уровень выбран так, чтобы пол не оказался светлее настилов: он смотрит
   нормалью вверх и получает больше всех света, поэтому при lvl 1.5 читался
   ярче стропил (191 против 143 у яруса 1) — прямое нарушение «выше светлее». */
const TX_TONE = {
  plank: { lvl:0.44, con:3.60 },
  vplank:{ lvl:0.62, con:3.60 },   // та же доска, только поперёк — и тон тот же
  grate: { lvl:0.58, con:3.60 },
  wood:  { lvl:0.62, con:3.60 },
  metal: { lvl:0.60, con:3.60 },
  plate: { lvl:0.55, con:1.30 },
  rust:  { lvl:0.78, con:1.15 },
  conc:  { lvl:0.60, con:1.50 },
  stone: { lvl:0.60, con:1.30 },
  sand:  { lvl:0.42, con:1.45 },
  cloth: { lvl:0.64, con:1.35 },
  roof:  { lvl:1.60, con:3.60 },
  crate: { lvl:0.66, con:3.60 },
  grass: { lvl:0.82, con:1.20 },
  dirt:  { lvl:0.85, con:2.40 }
  // 'rune'/'runeglow' не трогаем: там важна не яркость камня, а свечение резьбы
};

/* Пересчёт тона холста по таблице. Через LUT: 768 вызовов pow вместо 196 тыс.
   Опора — средний тон КАНАЛА: крутим контраст вокруг него, иначе вместе с
   уровнем поедет и цвет карты. */
function TX_expose(c, S, name){
  const t = TX_TONE[name];
  if(!t || (t.lvl === 1 && t.con === 1)) return;
  const g = c.getContext('2d');
  const im = g.getImageData(0,0,S,S), d = im.data, n = d.length/4;
  let m0=0, m1=0, m2=0;
  for(let i=0;i<d.length;i+=4){ m0+=d[i]; m1+=d[i+1]; m2+=d[i+2]; }
  const M = [Math.max(m0/n,1), Math.max(m1/n,1), Math.max(m2/n,1)];
  const lut = [new Uint8Array(256), new Uint8Array(256), new Uint8Array(256)];
  for(let ch=0; ch<3; ch++){
    const m = M[ch], out = m*t.lvl, L = lut[ch];
    for(let v=0; v<256; v++){
      const y = out*Math.pow(v/m, t.con);
      L[v] = y<=0 ? 0 : (y>=255 ? 255 : Math.round(y));
    }
  }
  for(let i=0;i<d.length;i+=4){ d[i]=lut[0][d[i]]; d[i+1]=lut[1][d[i+1]]; d[i+2]=lut[2][d[i+2]]; }
  g.putImageData(im,0,0);
}

/* ------------------------------ КЭШ И ДОСТУП ------------------------------ */
const TEX = {
  size: 256,           // потолок по контракту; больше — впустую и по памяти, и по генерации
  _cv: new Map(),      // холсты по имени: рисуем один раз
  _t: new Map(),       // готовые текстуры по имени+повтору
  /* Обязательный набор §3.2 плюс четыре карты под деревянный зал §10:
     'vplank'   — та же доска, но вертикальная (обшивка стен по референсу);
     'grate'    — решётчатый настил над шахтой;
     'runewood' — брус с врезанными светящимися рунами (+ маска 'runewoodglow'). */
  list: ['plank','vplank','wood','metal','plate','rust','conc','stone','sand','cloth','roof','crate',
         'grate','rune','runeglow','runewood','runewoodglow','grass','dirt'],

  canvas(name){
    let c = this._cv.get(name);
    if(c) return c;
    const S = this.size;
    c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    const gen = TX_GEN[name] || TX_GEN.conc;
    g.save(); gen(g, S); g.restore();
    TX_expose(c, S, name);          // общий уровень и контраст — см. TX_TONE
    this._cv.set(name, c);
    return c;
  },

  get(name, rx, ry){
    rx = (rx===undefined || !(rx>0)) ? 1 : rx;
    ry = (ry===undefined || !(ry>0)) ? rx : ry;
    // округляем ключ: почти одинаковые повторы не должны плодить копии в VRAM
    rx = Math.round(rx*100)/100; ry = Math.round(ry*100)/100;
    const key = name+'|'+rx+'|'+ry;
    let t = this._t.get(key);
    if(t) return t;
    t = new THREE.CanvasTexture(this.canvas(name));
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rx, ry);
    // Мипы тут не роскошь: без них рисунок на 100 м рассыпается в мерцающую
    // рябь и начинает спорить с силуэтом цели.
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    if(typeof renderer !== 'undefined' && renderer && renderer.capabilities)
      t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    t.needsUpdate = true;
    // Имя обязательно: по нему 55_fx.js определяет породу поверхности под пулей
    // (щепа с доски, искры с металла, пыль с камня). Без него разбор попадания
    // сваливается на угадывание по цвету, и крашенная бочка читается как металл.
    t.name = name;
    this._t.set(key, t);
    return t;
  }
};

// ключ материала: opts может нести Color и Texture, JSON.stringify их не переживёт
function TX_key(o){
  if(!o) return '';
  let s = '';
  for(const k in o){
    const v = o[k];
    if(v && typeof v === 'object') s += k+':'+(v.uuid || (v.getHexString ? v.getHexString() : 'o'))+',';
    else s += k+':'+v+',';
  }
  return s;
}

/* Тун-материал с процедурной картой. Кэш по всем аргументам — материалов
   в карте сотни, а разных сочетаний десятки.
   opts.emissiveMap === true — «свети собственным рисунком»: для имён, у
   которых есть маска <name>glow (сейчас 'rune'), берётся она. */
function toonT(color, name, rx, ry, opts){
  const key = 'T|'+color+'|'+name+'|'+rx+'|'+ry+'|'+TX_key(opts);
  const had = MATCACHE.get(key);
  if(had) return had;
  const o = Object.assign({}, opts||{});
  const map = TEX.get(name, rx, ry);
  if(o.emissiveMap === true) o.emissiveMap = TX_GEN[name+'glow'] ? TEX.get(name+'glow', rx, ry) : map;
  o.color = color; o.map = map; o.gradientMap = toonGrad();
  const m = new THREE.MeshToonMaterial(o);
  // вертикальный градиент непрямого света (20_render.js): ярусы обязаны
  // различаться яркостью, и через toonT проходит вся карта
  if(typeof RND_ambRamp === 'function') m.onBeforeCompile = RND_ambRamp;
  MATCACHE.set(key, m);
  return m;
}
