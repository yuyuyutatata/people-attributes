// === 人属性カウント：同一人物は日内で厳密に1回のみ ===
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

  // 「今日のユニーク合計」の表示は完全に消す
  if (logEl) logEl.remove();

  btnStop.disabled = true;
  statusEl.textContent = '準備中…';

  // ---- Human 読み込み待ち ----
  for (let i = 0; i < 200 && !window.Human; i++) {
    await new Promise(r => setTimeout(r, 100));
  }
  if (!window.Human) {
    statusEl.textContent = 'Humanが読み込めませんでした';
    btnStart.disabled = true; btnStop.disabled = true;
    return;
  }

  // 入力ビデオは非表示（オーバーレイのみ表示）
  const video = document.createElement('video');
  Object.assign(video.style, { display:'none', width:'0px', height:'0px' });
  document.body.appendChild(video);

  // ---- Human 設定 ----
  const human = new Human.Human({
    modelBasePath: './models',
    face: {
      detector: { rotation:true, maxDetected:5 },
      mesh:false, iris:false,
      description:{ enabled:true },   // 年齢・性別
      descriptor:{  enabled:true },   // 顔ベクトル
    },
    body:{enabled:false}, hand:{enabled:false}, gesture:{enabled:false},
    filter:{enabled:true, equalization:true},
  });

  // ---- 集計（直近1分）----
  const buckets = ['child','10s','20s','30s','40s','50s','60s+','unknown'];
  const minuteCounts = {};
  function initCounts(){ for(const b of buckets) minuteCounts[b]={male:0,female:0,unknown:0}; }
  function renderTable(){
    tbody.innerHTML = buckets.map(b=>{
      const c = minuteCounts[b];
      return `<tr><td>${b}</td><td>${c.male}</td><td>${c.female}</td><td>${c.unknown}</td></tr>`;
    }).join('');
  }
  initCounts(); renderTable();
  // 直近1分の見せ方：1分ごとにリセット
  setInterval(()=>{ initCounts(); renderTable(); }, 60*1000);

  // ---- 日内ユニーク管理（ローカルのみ）----
  const SITE_SECRET = 'FIXED_SECRET_12345'; // 端末間共有なら同じ値に
  const todayStr = () => {
    const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  };
  function loadUniqSet(){ try{ const raw=localStorage.getItem(todayStr()); return new Set(raw?JSON.parse(raw):[]);}catch{return new Set();} }
  function saveUniqSet(s){ localStorage.setItem(todayStr(), JSON.stringify([...s])); }
  let uniqSet = loadUniqSet();

  // ---- 類似計算ユーティリティ ----
  function normalize(v){ // L2 正規化
    const out=new Float32Array(v.length); let n=0;
    for(let i=0;i<v.length;i++){ const x=v[i]; n+=x*x; }
    const s = n ? 1/Math.sqrt(n) : 1;
    for(let i=0;i<v.length;i++) out[i]=v[i]*s;
    return out;
  }
  function cosSim(a,b){
    let dot=0,na=0,nb=0, L=Math.min(a.length,b.length);
    for(let i=0;i<L;i++){ const x=a[i],y=b[i]; dot+=x*y; na+=x*x; nb+=y*y; }
    return (na&&nb)? dot/(Math.sqrt(na)*Math.sqrt(nb)) : 0;
  }
  function iou(b1,b2){
    const [x1,y1,w1,h1]=b1,[x2,y2,w2,h2]=b2;
    const xa=Math.max(x1,x2), ya=Math.max(y1,y2);
    const xb=Math.min(x1+w1,x2+w2), yb=Math.min(y1+h1,y2+h2);
    const inter=Math.max(0,xb-xa)*Math.max(0,yb-ya);
    const uni=w1*h1+w2*h2-inter;
    return uni>0? inter/uni:0;
  }

  // ---- 「人物クラスタ」記憶（姿勢変化でも再カウント禁止）----
  // すでにカウント済みの人ごとに、代表ベクトル（最大3個）を保存して照合する
  const people = []; // [{vecs:[Float32Array,...]}]
  const MEMORY_SIM_TH = 0.996; // これ以上似ていれば同一人物扱い
  function matchesKnownPerson(vec){
    for(const p of people){
      for(const v of p.vecs){
        if (cosSim(vec, v) >= MEMORY_SIM_TH) return true;
      }
    }
    return false;
  }
  function addPersonVec(vec){
    // 近いクラスタがあればそちらにベクトル追加、なければ新規作成
    for(const p of people){
      for(const v of p.vecs){
        if (cosSim(vec, v) >= MEMORY_SIM_TH) {
          p.vecs.push(vec);
          if (p.vecs.length>3) p.vecs.shift(); // 上限3でロール
          return;
        }
      }
    }
    people.push({ vecs:[vec] });
  }

  // ---- 直近観測 & トラック状態（滞在中の再カウント禁止）----
  const recent=[];                  // {vec, box, t}
  const trackState=new Map();       // key -> {streak,lastTs,lastBox,countedForever}
  const RECENT_MS=60*1000, SIM_TH=0.99, IOU_TH=0.35, STREAK_N=3;

  function prune(now){
    for(let i=recent.length-1;i>=0;i--) if(now-recent[i].t>RECENT_MS) recent.splice(i,1);
    for(const [k,st] of trackState) if(now-st.lastTs>RECENT_MS) trackState.delete(k);
  }
  function gridKey(box){ const [x,y,w,h]=box; return [Math.round((x+w/2)/40),Math.round((y+h/2)/40),Math.round(w/40),Math.round(h/40)].join(':'); }
  function findDup(vec,box,now){
    let best=null,simBest=0;
    for(const r of recent){ if(now-r.t>RECENT_MS) continue;
      const s=cosSim(vec,r.vec||vec);
      if(s>=SIM_TH && iou(box,r.box)>=IOU_TH && s>simBest){best=r;simBest=s;}
    }
    return best;
  }

  async function hashFaceEmbedding(face){
    const emb = face.descriptor || face.embedding;
    if(!emb || !Array.isArray(emb)) return {vec:null,hash:null};
    const norm = normalize(new Float32Array(emb));
    // 量子化（0.02刻み）で日内ハッシュを安定化
    const q = Array.from(norm, v=>Math.round(v/0.02)*0.02);
    const payload=JSON.stringify({r:q,d:todayStr(),s:SITE_SECRET});
    const buf=await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    const v=new Uint8Array(buf);
    const hash=Array.from(v.slice(0,16), b=>b.toString(16).padStart(2,'0')).join('');
    return {vec:norm, hash};
  }

  // ---- カメラ制御 ----
  let running=false, stream=null, rafId=null, lastTick=0;

  async function startCamera(){
    const facing=ckFront.checked?'user':'environment';
    stream=await navigator.mediaDevices.getUserMedia({
      video:{facingMode:{ideal:facing}, width:{ideal:640}, height:{ideal:480}}, audio:false
    });
    video.srcObject=stream; await video.play();
    overlay.width=video.videoWidth||640; overlay.height=video.videoHeight||480;
    running=true; btnStart.disabled=true; btnStop.disabled=false;
    statusEl.textContent='実行中（ユニーク1回のみ）';
    loop();
  }
  function stopCamera(){
    running=false; if(rafId) cancelAnimationFrame(rafId);
    if(stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
    btnStart.disabled=false; btnStop.disabled=true; statusEl.textContent='停止';
  }

  async function loop(ts){
    if(!running) return;
    if(ts && ts-lastTick<100){ rafId=requestAnimationFrame(loop); return; }
    lastTick = ts || performance.now();

    await human.load();
    const result = await human.detect(video);

    ctx.clearRect(0,0,overlay.width,overlay.height);
    ctx.drawImage(video,0,0,overlay.width,overlay.height);

    const faces = result.face || [];
    const now = performance.now(); prune(now);

    for(const f of faces){
      const [x,y,w,h] = f.box;
      const age = f.age ? Math.round(f.age) : null;
      const bucket = age==null ? 'unknown'
                   : age<13 ? 'child'
                   : age<20 ? '10s'
                   : age<30 ? '20s'
                   : age<40 ? '30s'
                   : age<50 ? '40s'
                   : age<60 ? '50s' : '60s+';
      const g = (f.gender||'unknown').toLowerCase();
      const gkey = g.startsWith('f') ? 'female' : (g.startsWith('m') ? 'male' : 'unknown');

      const {vec, hash} = await hashFaceEmbedding(f);
      if(!vec){ draw(); continue; }

      const key = gridKey(f.box);
      const st = trackState.get(key) || { streak:0, lastTs:0, lastBox:f.box, countedForever:false };

      const dup = findDup(vec, f.box, now);
      const stable = !!dup || iou(st.lastBox, f.box) >= IOU_TH;
      st.streak = stable ? Math.min(st.streak+1, STREAK_N) : 1;
      st.lastTs = now; st.lastBox = f.box;

      // 滞在中は一度確定したら二度とカウントしない
      if (!st.countedForever && st.streak >= STREAK_N && hash) {
        // ① 既知クラスタに非常に近ければ“同一人物”として弾く
        const alreadyKnown = matchesKnownPerson(vec);
        if (!alreadyKnown) {
          // ② 日内ユニーク（ハッシュ）で初めてなら加算
          if (!uniqSet.has(hash)) {
            uniqSet.add(hash); saveUniqSet(uniqSet);
            minuteCounts[bucket][gkey] += 1;   // ← 日内でこの1回のみ
            addPersonVec(vec);                 // 代表ベクトルをクラスタへ
          } else {
            // ハッシュは同じ＝明確に同一人物 → クラスタに追加入力だけ
            addPersonVec(vec);
          }
        }
        st.countedForever = true; // セッション中の再カウント禁止
      }

      recent.push({vec, box:f.box, t:now});
      if (recent.length > 200) recent.shift();

      trackState.set(key, st);

      function draw(){
        ctx.lineWidth=2; ctx.strokeStyle='#00FF88'; ctx.strokeRect(x,y,w,h);
        const tag = `${bucket} • ${gkey}` + (age ? ` (${age})` : '');
        ctx.fillStyle='rgba(0,0,0,0.5)';
        const tw = ctx.measureText(tag).width + 10;
        ctx.fillRect(x, Math.max(0, y-20), tw, 20);
        ctx.fillStyle='#fff'; ctx.fillText(tag, x+5, Math.max(12, y-6));
      }
      draw();
    }

    renderTable();
    rafId = requestAnimationFrame(loop);
  }

  // ---- イベント ----
  btnStart.addEventListener('click', async ()=>{
    try { await startCamera(); } catch(e){ statusEl.textContent = 'カメラ開始失敗: ' + e.message; }
  });
  btnStop.addEventListener('click', stopCamera);
  btnCsv.addEventListener('click', ()=>{
    const lines=['bucket,male,female,unknown'];
    for(const b of buckets){ const c=minuteCounts[b]; lines.push([b,c.male,c.female,c.unknown].join(',')); }
    const blob=new Blob([lines.join('\n')],{type:'text/csv'});
    const url=URL.createObjectURL(blob);
    const a=Object.assign(document.createElement('a'), {href:url, download:`attributes_${Date.now()}.csv`});
    a.click(); URL.revokeObjectURL(url);
  });

  // ---- ブラウザ対応表示 ----
  if (!('mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices))
    statusEl.textContent = 'このブラウザはカメラ取得に未対応です';
  else
    statusEl.textContent = '「カメラ開始」を押してください（HTTPS必須）';
})();
