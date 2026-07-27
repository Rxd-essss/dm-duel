/* =====================================================================
   ПРОЦЕДУРНЫЕ ТЕКСТУРЫ (§3.2)

   Ассетов нет и быть не может, поэтому всё рисуется в <canvas> ≤256×256
   и один раз кладётся в кэш. Стиль — не фотоскан, а TF2: крупная деталь,
   видимый мазок, тёплая палитра. Два правила, из которых всё остальное:

   1. Карта не красит объект, она его ТОНИРУЕТ. Базовый уровень держим у
      единицы (0.92…0.96), детали уводим вниз. Цвет приходит из материала
      (PAL), поэтому одна доска годится и для ящика, и для мостика.
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

  /* трава: терраин и склоны */
  grass(g,S){
    const ink = TX_ink(0.95, 1.0, 0.875);
    TX_srand(1601);
    g.fillStyle = ink(0.93); g.fillRect(0,0,S,S);
    TX_mottle(g,S,ink,16,24,60,0.78,1.04,0.55);
    // пучки мазками: короткие, направленные вверх, три тона.
    // Длину держим малой — на 100 м это обязано слиться в ровный тон,
    // а не в рябь, спорящую с силуэтом
    for(let i=0;i<320;i++){
      const l = TX_rr(4,11), a = TX_rr(-1.95,-1.2);
      TX_hair(g,S,TX_rr(0,S),TX_rr(0,S), Math.cos(a)*l, Math.sin(a)*l, TX_rr(1.4,3.0), ink(TX_rr(0.68,1.08), TX_rr(0.45,0.9)));
    }
    for(let i=0;i<50;i++){
      const l = TX_rr(6,13), a = TX_rr(-2.0,-1.15);
      TX_hair(g,S,TX_rr(0,S),TX_rr(0,S), Math.cos(a)*l, Math.sin(a)*l, TX_rr(1,2.2), ink(TX_rr(1.08,1.18), 0.7));
    }
    for(let i=0;i<9;i++){
      const r = TX_rr(7,16);
      TX_wrap(S,TX_rr(0,S),TX_rr(0,S),r+3,(px,py)=>{
        g.fillStyle = ink(0.70,0.6); TX_blob(g,px,py,r,0.4,10); g.fill();
      });
    }
  },

  /* земля: тропы, дно дворов, проплешины */
  dirt(g,S){
    const ink = TX_ink(1.0, 0.95, 0.875);
    TX_srand(1721);
    g.fillStyle = ink(0.94); g.fillRect(0,0,S,S);
    TX_mottle(g,S,ink,18,22,58,0.74,1.04,0.55);
    for(let i=0;i<26;i++) TX_pebble(g,S,ink, TX_rr(0,S), TX_rr(0,S), TX_rr(2,6), TX_rr(0.8,1.08));
    for(let i=0;i<5;i++) TX_crack(g,S,ink, TX_rr(0,S), TX_rr(0,S), TX_rr(24,60), 0.66);
    // борозды от колёс и ног
    for(let i=0;i<16;i++){
      const a = TX_rr(-0.35,0.35), l = TX_rr(30,80);
      TX_hair(g,S,TX_rr(0,S),TX_rr(0,S), Math.cos(a)*l, Math.sin(a)*l, TX_rr(3,8), ink(TX_rr(0.78,0.9), 0.25));
    }
    TX_speck(g,S,ink,300,0.5,1.8,0.68,1.02,0.3);
  }
};

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

/* ------------------------------ КЭШ И ДОСТУП ------------------------------ */
const TEX = {
  size: 256,           // потолок по контракту; больше — впустую и по памяти, и по генерации
  _cv: new Map(),      // холсты по имени: рисуем один раз
  _t: new Map(),       // готовые текстуры по имени+повтору
  list: ['plank','wood','metal','plate','rust','conc','stone','sand','cloth','roof','crate','rune','runeglow','grass','dirt'],

  canvas(name){
    let c = this._cv.get(name);
    if(c) return c;
    const S = this.size;
    c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    const gen = TX_GEN[name] || TX_GEN.conc;
    g.save(); gen(g, S); g.restore();
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
  MATCACHE.set(key, m);
  return m;
}
