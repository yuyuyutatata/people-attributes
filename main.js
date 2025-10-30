// === 日次集計・動いても同じ人は日内で厳密に1回のみ ===
(async function boot() {
  // ---- DOM ----
  const overlay = document.getElementById('overlay');
  const ctx = overlay.getContext('2d');
  const btnStart = document.getElementById('btnStart');
  const btnStop  = document.getElementById('btnStop');
  const btnCsv   = document.getElementById('btnCsv');
  const ckFront  = document.getElementById('ckFront');
  const statusEl = document.getElementById('status');
  const tbody    = document.getElementById('tbody');
  const logEl    = document.getElementById('log');
  if (logEl) logEl.remove(); // 余計な表示は消す

  btnStop.disabled = true;
  statusEl.textContent = '準備中…';

  // ---- Human 読み込み待ち ----
  for (let i = 0; i < 200 && !window.Human; i++) await new Promise(r => setTimeout(r, 100));
  if (!window.Human) { statusEl.textContent = 'Humanが読み込めませんでした'; btnStart.disabled = true; btnStop.disabled = true; return; }

  // 入力ビデオ（非表示）
  const video = document.createElement('video');
  Object.assign(video.style, { display:'none', width:'0px', height:'0px', position:'absolute', opacity:'0' });
  document.body.appendChild(video);

  // ---- Human 設定 ----
  const human = new Human.Human({
    modelBasePath: './models',
    face: {
      detector: { rotation:true, maxDetected: 3 }, // 少数に制限
      mesh:false, iris:false,
      description:{ enabled:true },   // 年齢・性別
      descriptor:{  enabled:true },   // 顔ベクトル
    },
    body:{enabled:false}, hand:{enabled:false}, gesture:{enabled:false},
    filter:{enabled:true, equalization:true},
  });
  await human.load().catch(()=>{});

  // ---- 日付・保存 ----
  const todayStr = () => {
    const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  };
  let currentDay = todayStr();

  const buckets = ['child','10s','20s','30s','40s','50s','60s+','unknown'];
  const blankCounts = ()=>{ const o={}; for(const b of buckets) o[b]={male:0,female:0,unknown:0}; return o; };
  const countsKey = d => `counts:${d}`;
  const uniqKey   = d => `uniq:${d}`;

  const loadCounts = d => { try{ const raw = localStorage.getItem(countsKey(d)); return raw ? JSON.parse(raw) : blankCounts(); }catch{ return blankCounts(); } };
  const saveCounts = (d, obj) => localStorage.setItem(countsKey(d), JSON.stringify(obj));
  const loadUniq   = d => { try{ const raw = localStorage.getItem(uniqKey(d)); return new Set(raw?JSON.parse(raw):[]);}catch{ return new Set(); } };
  const saveUniq   = (d, set) => localStorage.setItem(uniqKey(d), JSON.stringify([...set]));

  let dayCounts = loadCounts(currentDay);
  let uniqSet   = loadUniq(currentDay);

  const renderTable = () => {
    tbody.innerHTML = buckets.map(b=>{
      const c = dayCounts[b];
      return `<tr><td>${b}</td><td>${c.male}</td><td>${c.female}</td><td>${c.unknown}</td></tr>`;
    }).join('');
  };
  renderTable();

  // ---- ベクトル処理 ----
  const SITE_SECRET = 'FIXED_SECRET_12345';
  const normalize = v => {
    const out = new Float32Array(v.length); let n=0;
    for(let i=0;i<v.length;i++){ const x=v[i]; n+=x*x; }
    const s = n ? 1/Math.sqrt(n) : 1;
    for(let i=0;i<v.length;i++) out[i]=v[i]*s;
    return out;
  };
  const cosSim = (a,b) => {
    let dot=0,na=0,nb=0, L=Math.min(a.length,b.length);
    for(let i=0;i<L;i++){ const x=a[i],y=b[i]; dot+=x*y; na+=x*x; nb+=y*y; }
    return (na&&nb)? dot/(Math.sqrt(na)*Math.sqrt(nb)) : 0;
  };
  const iou = (b1,b2) => {
    const [x1,y1,w1,h1]=b1,[x2,y2,w2,h2]=b2;
    const xa=Math.max(x1,x2), ya=Math.max(y1,y2);
    const xb=Math.min(x1+w1,x2+w2), yb=Math.min(y1+h1,y2+h2);
    const inter=Math.max(0,xb-xa)*Math.max(0,yb-ya);
    const uni=w1*h1+w2*h2-inter;
    return uni>0? inter/uni:0;
  };
  const centerDist = (b1,b2) => {
    const c1x=b1[0]+b1[2]/2, c1y=b1[1]+b1[3]/2;
    const c2x=b2[0]+b2[2]/2, c2y=b2[1]+b2[3]/2;
    const dx=c1x-c2x, dy=c1y-c2y;
    return Math.hypot(dx,dy);
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
    return { vec: norm, hash };
  }

  // ---- 既知の人物クラスタ（ベクトル代表）----
  const people = []; // [{vecs:[Float32Array,...]}]
  const MEMORY_SIM_TH = 0.998; // 姿勢が変わっても同一とみなす厳格さ
  const matchesKnownPerson = vec => people.some(p => p.vecs.some(v => cosSim(vec, v) >= MEMORY_SIM_TH));
  const addPersonVec = vec => {
    for(const p of people){
      for(const v of p.vecs){
        if (cosSim(vec, v) >= MEMORY_SIM_TH) {
          p.vecs.push(vec); if (p.vecs.length>3) p.vecs.shift(); return;
        }
      }
    }
    people.push({ vecs:[vec] });
  };

  // ---- 簡易トラッカー（動いても同一トラックへ割当）----
  // 各トラックは 2秒 見失うと終了。確定（STREAKを満たす）時に一回だけカウント。
  let nextTrackId = 1;
  const tracks = new Map(); // id -> {id, box, vec, lastTs, streak, counted, hash}
  const TRACK_MAX_AGE = 2000;  // ms
  const STREAK_N = 6;          // 連続フレームでの確定条件（厳しめ）
  const COST_SIM_W = 0.7;      // 顔類似の重み（高）
  const COST_DIST_W = 0.2;     // 位置距離の重み
  const COST_IOU_W  = 0.1;     // IoU は「1-IOU」でコストに
  const NORM_DIST = () => Math.hypot(overlay.width, overlay.height); // 正規化距離

  function cleanupTracks(now){
    for(const [id,t] of tracks){
      if (now - t.lastTs > TRACK_MAX_AGE) tracks.delete(id);
    }
  }

  // 検出一覧(detections)と既存tracksをマッチング（小規模なので貪欲マッチで十分）
  function assignDetectionsToTracks(dets){
    const now = performance.now();
    cleanupTracks(now);
    const unassigned = new Set(dets.map((_,i)=>i));
    const entries = [...tracks.values()];

    // コスト行列を作る（低いほど良い）
    const pairs = [];
    for(const t of entries){
      for(let i=0;i<dets.length;i++){
        const d = dets[i];
        // 距離が大きすぎる・IoUが小さすぎる場合はスキップ
        const dist = centerDist(t.box, d.box) / NORM_DIST();
        const ov   = iou(t.box, d.box);
        const sim  = t.vec && d.vec ? cosSim(t.vec, d.vec) : 0;
        const cost = COST_SIM_W * (1 - sim) + COST_DIST_W * dist + COST_IOU_W * (1 - ov);
        pairs.push({tid:t.id, i, cost, sim, dist, ov});
      }
    }
    // コスト昇順に割当
    pairs.sort((a,b)=>a.cost-b.cost);

    const usedT = new Set(), usedD = new Set();
    const matches = [];
    const SIM_MIN = 0.995;   // 顔ベクトルの最低類似
    const IOU_MIN = 0.35;    // 位置重なり
    const DIST_MAX = 0.15;   // 画面対角比での距離上限

    for(const p of pairs){
      if (usedT.has(p.tid) || usedD.has(p.i)) continue;
      if (p.sim >= SIM_MIN && p.ov >= IOU_MIN && p.dist <= DIST_MAX) {
        matches.push(p);
        usedT.add(p.tid); usedD.add(p.i);
        unassigned.delete(p.i);
      }
    }

    // マッチしたものはトラック更新、してない検出は後で新規トラック化
    for(const m of matches){
      const t = tracks.get(m.tid);
      const d = dets[m.i];
      t.box = d.box; t.vec = d.vec; t.hash = d.hash || t.hash;
      t.lastTs = now;
      t.streak = Math.min(t.streak + 1, STREAK_N);
    }

    return [...unassigned];
  }

  function createTrack(det){
    const now = performance.now();
    const t = {
      id: nextTrackId++,
      box: det.box,
      vec: det.vec,
      hash: det.hash || null,
      streak: 1,
      counted: false,
      lastTs: now,
    };
    tracks.set(t.id, t);
  }

  // ---- カメラ ----
  let running=false, stream=null, rafId=null, lastTick=0;

  async function startCamera(){
    const facing=ckFront.checked?'user':'environment';
    stream=await navigator.mediaDevices.getUserMedia({
      video:{facingMode:{ideal:facing}, width:{ideal:640}, height:{ideal:480}}, audio:false
    });
    video.srcObject=stream; await video.play();
    overlay.width=video.videoWidth||640; overlay.height=video.videoHeight||480;
    running=true; btnStart.disabled=true; btnStop.disabled=false;
    statusEl.textContent='実行中（日次・動いても1回だけ）';
    loop();
  }
  function stopCamera(){
    running=false; if(rafId) cancelAnimationFrame(rafId);
    if(stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
    btnStart.disabled=false; btnStop.disabled=true; statusEl.textContent='停止';
  }

  async function loop(ts){
    if(!running) return;

    // 日付跨ぎ検知
    const dnow = todayStr();
    if (dnow !== currentDay) {
      currentDay = dnow;
      dayCounts = loadCounts(currentDay);
      uniqSet   = loadUniq(currentDay);
      renderTable();
    }

    if(ts && ts-lastTick<100){ rafId=requestAnimationFrame(loop); return; }
    lastTick = ts || performance.now();

    const result = await human.detect(video);

    ctx.clearRect(0,0,overlay.width,overlay.height);
    ctx.drawImage(video,0,0,overlay.width,overlay.height);

    // 検出の前処理（スコア・サイズの最低ライン）
    const MIN_FACE_SCORE = 0.65;
    const MIN_AREA_RATIO = 0.04; // 4%未満は採用しない（遠景や誤検出を排除）
    const frameArea = overlay.width * overlay.height;

    // 検出を「埋め込み付き」にして配列化
    const faces = (result.face || []).filter(f => {
      const [x,y,w,h] = f.box;
      const okScore = (typeof f.score !== 'number') ? true : f.score >= MIN_FACE_SCORE;
      const okArea  = (w*h)/frameArea >= MIN_AREA_RATIO;
      return okScore && okArea;
    });

    const detections = [];
    for (const f of faces) {
      const {vec, hash} = await faceEmbedding(f);
      if (!vec || !hash) continue;
      detections.push({ box: f.box, vec, hash, age: f.age ? Math.round(f.age) : null, gender: (f.gender||'unknown').toLowerCase() });
    }

    // 既存トラックに割当
    const unassignedIdx = assignDetectionsToTracks(detections);

    // 未割当の検出は新規トラックとして作成
    for (const idx of unassignedIdx) createTrack(detections[idx]);

    // トラックごとの確定＆カウント判定
    for (const t of [...tracks.values()]) {
      if (t.streak >= STREAK_N && !t.counted && t.vec && t.hash) {
        // 既知クラスタに十分近ければ同一人物として弾く
        if (!matchesKnownPerson(t.vec)) {
          if (!uniqSet.has(t.hash)) {
            // 初出の人物 → カウント（年齢・性別はトラックに残っていないので直近検出から推定）
            // 最も近い検出を使って属性を得る（表示目的）
            let attr = {bucket:'unknown', gkey:'unknown'};
            let bestSim=-1;
            for (const d of detections) {
              const s = cosSim(t.vec, d.vec);
              if (s>bestSim) { bestSim=s;
                const age = d.age;
                attr.bucket = age==null ? 'unknown' : age<13?'child':age<20?'10s':age<30?'20s':age<40?'30s':age<50?'40s':age<60?'50s':'60s+';
                const g = d.gender; attr.gkey = g.startsWith('f')?'female':(g.startsWith('m')?'male':'unknown');
              }
            }
            uniqSet.add(t.hash); saveUniq(currentDay, uniqSet);
            dayCounts[attr.bucket][attr.gkey] += 1; saveCounts(currentDay, dayCounts);
            renderTable();
            addPersonVec(t.vec); // 代表ベクトルを記憶
          } else {
            // ハッシュ一致＝確実に同一人物 → 代表ベクトルだけ更新
            addPersonVec(t.vec);
          }
        }
        t.counted = true; // このトラックは以後カウントしない
      }
    }

    // 描画
    ctx.font = '14px system-ui';
    for (const t of [...tracks.values()]) {
      const [x,y,w,h] = t.box;
      ctx.lineWidth=2; ctx.strokeStyle = t.counted ? '#00FF88' : '#ffaa00';
      ctx.strokeRect(x,y,w,h);
      const tag = t.counted ? 'counted' : `tracking ${t.streak}/${STREAK_N}`;
      const tw = ctx.measureText(tag).width + 10;
      ctx.fillStyle='rgba(0,0,0,0.5)'; ctx.fillRect(x, Math.max(0,y-20), tw, 20);
      ctx.fillStyle='#fff'; ctx.fillText(tag, x+5, Math.max(12, y-6));
    }

    rafId = requestAnimationFrame(loop);
  }

  // ---- イベント ----
  btnStart.addEventListener('click', async ()=>{ try{ await startCamera(); }catch(e){ statusEl.textContent = 'カメラ開始失敗: ' + e.message; }});
  btnStop.addEventListener('click', stopCamera);
  btnCsv.addEventListener('click', ()=>{
    const lines=['bucket,male,female,unknown'];
    for(const b of buckets){ const c=dayCounts[b]; lines.push([b,c.male,c.female,c.unknown].join(',')); }
    const blob=new Blob([lines.join('\n')],{type:'text/csv'});
    const url=URL.createObjectURL(blob);
    const a=Object.assign(document.createElement('a'), {href:url, download:`daily_attributes_${currentDay}.csv`});
    a.click(); URL.revokeObjectURL(url);
  });

  // ---- ブラウザ対応表示 ----
  if (!('mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices))
    statusEl.textContent = 'このブラウザはカメラ取得に未対応です';
  else
    statusEl.textContent = '「カメラ開始」を押してください（HTTPS必須）';
})();
