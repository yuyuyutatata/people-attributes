// === 日次ユニーク集計 + 動いても1回だけ + ローカル顔DB(IndexedDB)既知照合 ===
(async function boot() {
  // ---------------- DOM ----------------
  const overlay = document.getElementById('overlay');
  const ctx     = overlay.getContext('2d');
  const btnStart= document.getElementById('btnStart');
  const btnStop = document.getElementById('btnStop');
  const btnCsv  = document.getElementById('btnCsv');
  const ckFront = document.getElementById('ckFront');
  const statusEl= document.getElementById('status');
  const tbody   = document.getElementById('tbody');
  const logEl   = document.getElementById('log');
  if (logEl) logEl.remove(); // 余計な表示は消す

  btnStop.disabled = true;
  statusEl.textContent = '準備中…';

  // ---------------- Human 読み込み ----------------
  for (let i=0; i<200 && !window.Human; i++) await delay(100);
  if (!window.Human) { statusEl.textContent='Humanが読み込めませんでした'; btnStart.disabled=true; btnStop.disabled=true; return; }

  // 非表示の入力ビデオ
  const video = document.createElement('video');
  Object.assign(video.style, { display:'none', width:'0px', height:'0px', position:'absolute', opacity:'0' });
  document.body.appendChild(video);

  const human = new Human.Human({
    modelBasePath: './models',
    face: {
      detector:   { rotation:true, maxDetected:3 },
      mesh:false, iris:false,
      description:{ enabled:true },
      descriptor: { enabled:true },
    },
    body:{enabled:false}, hand:{enabled:false}, gesture:{enabled:false},
    filter:{enabled:true, equalization:true},
  });
  await human.load().catch(()=>{});

  // ---------------- 日付・保存 ----------------
  const SITE_SECRET = 'FIXED_SECRET_12345'; // 端末間で同じにするなら共通値に
  const todayStr = () => {
    const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  };
  let currentDay = todayStr();

  const buckets = ['child','10s','20s','30s','40s','50s','60s+','unknown'];
  const blankCounts = ()=>{ const o={}; for(const b of buckets) o[b]={male:0,female:0,unknown:0}; return o; };

  const countsKey = d => `counts:${d}`;
  const uniqKey   = d => `uniq:${d}`;

  const loadCounts = d => { try{ const raw=localStorage.getItem(countsKey(d)); return raw?JSON.parse(raw):blankCounts(); }catch{ return blankCounts(); } };
  const saveCounts = (d,obj) => localStorage.setItem(countsKey(d), JSON.stringify(obj));
  const loadUniq   = d => { try{ const raw=localStorage.getItem(uniqKey(d)); return new Set(raw?JSON.parse(raw):[]);}catch{ return new Set(); } };
  const saveUniq   = (d,set)=> localStorage.setItem(uniqKey(d), JSON.stringify([...set]));

  let dayCounts = loadCounts(currentDay);
  let uniqSet   = loadUniq(currentDay);

  function renderTable(){
    tbody.innerHTML = buckets.map(b=>{
      const c = dayCounts[b];
      return `<tr><td>${b}</td><td>${c.male}</td><td>${c.female}</td><td>${c.unknown}</td></tr>`;
    }).join('');
  }
  renderTable();

  // ---------------- IndexedDB（顔DB） ----------------
  const DB_NAME='faces-db', STORE='vectors', DB_VER=1;
  function openDB(){
    return new Promise((resolve,reject)=>{
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath:'id', autoIncrement:true });
          os.createIndex('tsLast', 'tsLast');
        }
      };
      req.onsuccess = ()=>resolve(req.result);
      req.onerror   = ()=>reject(req.error);
    });
  }
  async function dbPut(record){
    const db = await openDB();
    return new Promise((res,rej)=>{
      const tx = db.transaction(STORE,'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error);
    });
  }
  async function dbGetAll(){
    const db = await openDB();
    return new Promise((res,rej)=>{
      const tx = db.transaction(STORE,'readonly');
      const rq = tx.objectStore(STORE).getAll();
      rq.onsuccess=()=>res(rq.result||[]); rq.onerror=()=>rej(rq.error);
    });
  }
  async function dbUpdate(id, patch){
    const db = await openDB();
    return new Promise((res,rej)=>{
      const tx = db.transaction(STORE,'readwrite');
      const os = tx.objectStore(STORE);
      const get = os.get(id);
      get.onsuccess = ()=>{
        const rec = Object.assign(get.result, patch);
        os.put(rec);
      };
      tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error);
    });
  }
  async function dbDeleteByIds(ids){
    if (!ids.length) return;
    const db = await openDB();
    return new Promise((res,rej)=>{
      const tx = db.transaction(STORE,'readwrite');
      const os = tx.objectStore(STORE);
      ids.forEach(id => os.delete(id));
      tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error);
    });
  }
  async function dbMaintenance(){
    // 30日より古いものを削除、1万件上限
    const THIRTY_DAYS = 30*24*60*60*1000;
    const MAX_KEEP = 10000;
    const all = await dbGetAll();
    const now = Date.now();

    const old = all.filter(r => (r.tsLast||r.tsFirst||0) < (now - THIRTY_DAYS)).map(r=>r.id);
    await dbDeleteByIds(old);

    const rest = (await dbGetAll()).sort((a,b)=>(a.tsLast||a.tsFirst)-(b.tsLast||b.tsFirst));
    if (rest.length > MAX_KEEP) {
      const nDel = rest.length - MAX_KEEP;
      await dbDeleteByIds(rest.slice(0,nDel).map(r=>r.id));
    }
  }
  await dbMaintenance();

  // 既知検索（最も近い1件）
  function cosSim(a,b){
    let dot=0,na=0,nb=0, L=Math.min(a.length,b.length);
    for(let i=0;i<L;i++){ const x=a[i],y=b[i]; dot+=x*y; na+=x*x; nb+=y*y; }
    return (na&&nb)? dot/(Math.sqrt(na)*Math.sqrt(nb)) : 0;
  }
  async function findNearestInDB(vec, SIM_TH=0.998) {
    const all = await dbGetAll();
    let best=null, bestSim=-1;
    for (const r of all){
      if (!r.vec) continue;
      const s = cosSim(vec, new Float32Array(r.vec));
      if (s > bestSim){ bestSim=s; best=r; }
    }
    return (best && bestSim >= SIM_TH) ? { rec:best, sim:bestSim } : null;
  }

  // ---------------- 追尾・一致判定 ----------------
  const MIN_FACE_SCORE = 0.65;
  const MIN_AREA_RATIO = 0.04; // 顔面積が小さすぎる検出は無視

  const normalize = v => {
    const out=new Float32Array(v.length); let n=0;
    for(let i=0;i<v.length;i++){const x=v[i]; n+=x*x;}
    const s=n?1/Math.sqrt(n):1; for(let i=0;i<v.length;i++) out[i]=v[i]*s;
    return out;
  };
  const iou = (b1,b2)=>{
    const [x1,y1,w1,h1]=b1,[x2,y2,w2,h2]=b2;
    const xa=Math.max(x1,x2), ya=Math.max(y1,y2);
    const xb=Math.min(x1+w1,x2+w2), yb=Math.min(y1+h1,y2+h2);
    const inter=Math.max(0,xb-xa)*Math.max(0,yb-ya);
    const uni=w1*h1+w2*h2-inter; return uni>0? inter/uni:0;
  };
  const centerDist = (b1,b2)=>{
    const c1x=b1[0]+b1[2]/2, c1y=b1[1]+b1[3]/2;
    const c2x=b2[0]+b2[2]/2, c2y=b2[1]+b2[3]/2;
    return Math.hypot(c1x-c2x, c1y-c2y);
  };
  async function faceEmbedding(face){
    const emb = face.descriptor || face.embedding;
    if(!emb || !Array.isArray(emb)) return {vec:null, hash:null};
    const norm = normalize(new Float32Array(emb));
    // 量子化（0.02刻み）で日内ハッシュを安定化
    const q = Array.from(norm, v=>Math.round(v/0.02)*0.02);
    const payload = JSON.stringify({ r:q, d: currentDay, s: SITE_SECRET });
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    const v = new Uint8Array(buf);
    const hash = Array.from(v.slice(0,16), b=>b.toString(16).padStart(2,'0')).join('');
    return { vec:norm, hash };
  }

  // 既知人物クラスタ（メモリ内ベクトル）— 誤マージ防止＆姿勢変化耐性
  const people = []; // [{vecs:[Float32Array,...]}]
  const MEMORY_SIM_TH = 0.998;
  const matchesKnownPerson = vec => people.some(p => p.vecs.some(v => cosSim(vec, v) >= MEMORY_SIM_TH));
  const addPersonVec = vec => {
    for(const p of people){
      for(const v of p.vecs){
        if (cosSim(vec, v) >= MEMORY_SIM_TH){
          p.vecs.push(vec); if (p.vecs.length>3) p.vecs.shift(); return;
        }
      }
    }
    people.push({ vecs:[vec] });
  };

  // 簡易トラッカー（動いても同一IDへ）
  let nextTrackId=1;
  const tracks = new Map(); // id -> {id, box, vec, hash, lastTs, streak, counted}
  const TRACK_MAX_AGE = 2000; // ms
  const STREAK_N      = 6;    // 連続フレームで確定
  const COST_SIM_W=0.7, COST_DIST_W=0.2, COST_IOU_W=0.1;
  const SIM_MIN  = 0.995, IOU_MIN = 0.35, DIST_MAX_RATIO = 0.15;

  function cleanupTracks(now){
    for (const [id,t] of tracks) if (now - t.lastTs > TRACK_MAX_AGE) tracks.delete(id);
  }
  function assignDetectionsToTracks(dets){
    const now = performance.now(); cleanupTracks(now);
    const unassigned = new Set(dets.map((_,i)=>i));
    const entries = [...tracks.values()];
    const diag = Math.hypot(overlay.width, overlay.height) || 1;

    const pairs = [];
    for(const t of entries){
      for(let i=0;i<dets.length;i++){
        const d = dets[i];
        const dist = centerDist(t.box, d.box)/diag;
        const ov   = iou(t.box, d.box);
        const sim  = t.vec && d.vec ? cosSim(t.vec, d.vec) : 0;
        const cost = COST_SIM_W*(1-sim) + COST_DIST_W*dist + COST_IOU_W*(1-ov);
        pairs.push({tid:t.id, i, cost, sim, dist, ov});
      }
    }
    pairs.sort((a,b)=>a.cost-b.cost);

    const usedT=new Set(), usedD=new Set(), matches=[];
    for(const p of pairs){
      if (usedT.has(p.tid) || usedD.has(p.i)) continue;
      if (p.sim >= SIM_MIN && p.ov >= IOU_MIN && p.dist <= DIST_MAX_RATIO) {
        matches.push(p); usedT.add(p.tid); usedD.add(p.i); unassigned.delete(p.i);
      }
    }

    for(const m of matches){
      const t = tracks.get(m.tid), d = dets[m.i];
      t.box = d.box; t.vec = d.vec; t.hash = d.hash || t.hash;
      t.lastTs = now; t.streak = Math.min(t.streak+1, STREAK_N);
    }
    return [...unassigned];
  }
  function createTrack(det){
    const now = performance.now();
    tracks.set(nextTrackId, {
      id: nextTrackId++,
      box: det.box, vec: det.vec, hash: det.hash || null,
      lastTs: now, streak: 1, counted: false
    });
  }

  // ---------------- カメラ制御 ----------------
  let running=false, stream=null, rafId=null, lastTick=0;

  async function startCamera(){
    const facing = ckFront.checked ? 'user' : 'environment';
    stream = await navigator.mediaDevices.getUserMedia({
      video:{ facingMode:{ideal:facing}, width:{ideal:640}, height:{ideal:480} },
      audio:false
    });
    video.srcObject = stream; await video.play();
    overlay.width = video.videoWidth || 640; overlay.height = video.videoHeight || 480;
    running=true; btnStart.disabled=true; btnStop.disabled=false;
    statusEl.textContent = '実行中（日次・DB照合・動いても1回だけ）';
    loop();
  }
  function stopCamera(){
    running=false; if (rafId) cancelAnimationFrame(rafId);
    if (stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
    btnStart.disabled=false; btnStop.disabled=true; statusEl.textContent='停止';
  }

  async function loop(ts){
    if (!running) return;

    // 日付跨ぎ：自動切替
    const dnow = todayStr();
    if (dnow !== currentDay) {
      currentDay = dnow;
      dayCounts = loadCounts(currentDay);
      uniqSet   = loadUniq(currentDay);
      renderTable();
    }

    if (ts && ts - lastTick < 100) { rafId = requestAnimationFrame(loop); return; }
    lastTick = ts || performance.now();

    const result = await human.detect(video);

    ctx.clearRect(0,0,overlay.width,overlay.height);
    ctx.drawImage(video,0,0,overlay.width,overlay.height);

    // 前処理（スコア・面積フィルタ）
    const frameArea = overlay.width * overlay.height;
    const faces = (result.face || []).filter(f => {
      const [x,y,w,h] = f.box;
      const okScore = (typeof f.score !== 'number') ? true : f.score >= MIN_FACE_SCORE;
      const okArea  = (w*h)/frameArea >= MIN_AREA_RATIO;
      return okScore && okArea;
    });

    // 埋め込み計算
    const detections = [];
    for (const f of faces){
      const {vec, hash} = await faceEmbedding(f);
      if (!vec || !hash) continue;
      detections.push({
        box: f.box, vec, hash,
        age: f.age ? Math.round(f.age) : null,
        gender: (f.gender||'unknown').toLowerCase()
      });
    }

    // 既存トラックへ割当 → 余りは新規トラック化
    const unassignedIdx = assignDetectionsToTracks(detections);
    for (const idx of unassignedIdx) createTrack(detections[idx]);

    // 確定（STREAK満たした）トラックだけ DB照合 → 未知なら登録＆日内カウント
    for (const t of [...tracks.values()]) {
      if (t.streak >= STREAK_N && !t.counted && t.vec && t.hash) {
        // 1) まず「ローカル顔DB」に似た人がいるか（超厳しめ）
        const nearest = await findNearestInDB(t.vec, 0.998);
        if (nearest) {
          // 既知：DBの最終観測更新
          await dbUpdate(nearest.rec.id, { tsLast: Date.now(), seenCount: (nearest.rec.seenCount||0)+1 });
          addPersonVec(t.vec); // メモリクラスタにも追加（姿勢変化耐性Up）
        } else {
          // 未知：DBに登録（画像は保存せずベクトルのみ）
          const attr = estimateAttrFromDetections(t.vec, detections);
          await dbPut({
            vec: Array.from(t.vec),
            tsFirst: Date.now(),
            tsLast:  Date.now(),
            seenCount: 1,
            attrs: attr
          });
          addPersonVec(t.vec);
          // 2) 日内ユニーク（ハッシュ）で初めてなら＋1（DB既知でも当日未カウントなら本来＋1だが、DB既知=過去来店なので原則当日でも既知扱いで加算しない運用に）
          if (!uniqSet.has(t.hash)) {
            // ただし厳密に「当日一回だけ」にしたい場合は、DB既知でも t.hash が未登録なら加算する仕様に変更可
            const b = attr.bucket, g = attr.gkey;
            uniqSet.add(t.hash); saveUniq(currentDay, uniqSet);
            dayCounts[b][g] += 1; saveCounts(currentDay, dayCounts);
            renderTable();
          }
        }
        t.counted = true; // このトラックは二度と数えない
      }
    }

    // 可視化
    ctx.font = '14px system-ui';
    for (const t of [...tracks.values()]) {
      const [x,y,w,h] = t.box;
      ctx.lineWidth = 2; ctx.strokeStyle = t.counted ? '#00FF88' : '#ffaa00';
      ctx.strokeRect(x,y,w,h);
      const tag = t.counted ? 'counted' : `tracking ${t.streak}/${STREAK_N}`;
      const tw = ctx.measureText(tag).width + 10;
      ctx.fillStyle='rgba(0,0,0,0.5)'; ctx.fillRect(x, Math.max(0,y-20), tw, 20);
      ctx.fillStyle='#fff'; ctx.fillText(tag, x+5, Math.max(12,y-6));
    }

    rafId = requestAnimationFrame(loop);
  }

  // ---------------- イベント ----------------
  btnStart.addEventListener('click', async ()=>{ try{ await startCamera(); }catch(e){ statusEl.textContent='カメラ開始失敗: '+e.message; }});
  btnStop .addEventListener('click', stopCamera);
  btnCsv  .addEventListener('click', ()=>{
    const lines=['bucket,male,female,unknown'];
    for(const b of buckets){ const c=dayCounts[b]; lines.push([b,c.male,c.female,c.unknown].join(',')); }
    const blob=new Blob([lines.join('\n')],{type:'text/csv'});
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), {href:url, download:`daily_attributes_${currentDay}.csv`});
    a.click(); URL.revokeObjectURL(url);
  });

  // ---------------- 表示 ----------------
  if (!('mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices))
    statusEl.textContent='このブラウザはカメラ取得に未対応です';
  else
    statusEl.textContent='「カメラ開始」を押してください（HTTPS必須）';

  // ---------------- Helpers ----------------
  function delay(ms){ return new Promise(r=>setTimeout(r,ms)); }

  function estimateAttrFromDetections(vec, dets){
    // その時点で最も近い観測から属性推定（年齢層/性別）
    let best=null, bestSim=-1;
    for (const d of dets){
      const s = cosSim(vec, d.vec);
      if (s > bestSim){ bestSim=s; best=d; }
    }
    let bucket='unknown', gkey='unknown';
    if (best){
      const age = best.age;
      bucket = (age==null) ? 'unknown'
              : age<13 ? 'child'
              : age<20 ? '10s'
              : age<30 ? '20s'
              : age<40 ? '30s'
              : age<50 ? '40s'
              : age<60 ? '50s' : '60s+';
      const g = best.gender;
      gkey = g.startsWith('f') ? 'female' : (g.startsWith('m') ? 'male' : 'unknown');
    }
    return { bucket, gkey };
  }

})();
