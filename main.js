// === main.js 完全版（Human待機＋未読込時に安全に停止） ===
(async function boot() {
  // DOM要素は最初に取っておく（未読込時にも使う）
  const overlay = document.getElementById('overlay');
  const ctx = overlay.getContext('2d');
  const btnStart = document.getElementById('btnStart');
  const btnStop  = document.getElementById('btnStop');
  const btnCsv   = document.getElementById('btnCsv');
  const ckFront  = document.getElementById('ckFront');
  const statusEl = document.getElementById('status');
  const tbody    = document.getElementById('tbody');
  const logEl    = document.getElementById('log');

  // まずはUI初期状態
  btnStop.disabled = true;
  statusEl.textContent = '準備中…';

  // ---- Humanの到着を待つ（最大5秒）----
  for (let i = 0; i < 50 && !window.Human; i++) {
    await new Promise(r => setTimeout(r, 100));
  }
  if (!window.Human) {
    statusEl.textContent = 'Humanが読み込めませんでした（ネットワーク/キャッシュを確認）';
    // ボタンを無効化して終了（イベントも付けない）
    btnStart.disabled = true;
    btnStop.disabled  = true;
    console.error('Human not loaded');
    return;
  }

  // ---- Human がある：以降は通常初期化 ----

  // 入力用の非表示videoを用意
  const video = document.createElement('video');
  video.id = 'video';
  video.playsInline = true;
  video.muted = true;
  document.body.appendChild(video);

  // 表示からvideoは隠す（念のためCSSでも隠している想定）
  Object.assign(video.style, {
    display: 'none', visibility: 'hidden', width: '0px', height: '0px',
    position: 'absolute', opacity: '0', zIndex: -9999
  });

  // Human設定（ローカルmodelsを使う構成）
  const human = new Human.Human({
    modelBasePath: './models',
    face: {
      detector: { rotation: true, maxDetected: 5 },
      mesh: false, iris: false,
      description: { enabled: true },
      descriptor:  { enabled: true },
    },
    body: { enabled: false }, hand: { enabled: false }, gesture: { enabled: false },
    filter: { enabled: true, equalization: true },
  });

  // ---------------- 集計まわり ----------------
  const buckets = ['child','10s','20s','30s','40s','50s','60s+','unknown'];
  const minuteCounts = {};
  function initCounts() { for (const b of buckets) minuteCounts[b] = { male:0, female:0, unknown:0 }; }
  function renderTable() {
    tbody.innerHTML = buckets.map(b => {
      const c = minuteCounts[b]; return `<tr><td>${b}</td><td>${c.male}</td><td>${c.female}</td><td>${c.unknown}</td></tr>`;
    }).join('');
  }
  initCounts(); renderTable();
  function resetMinute(){ initCounts(); renderTable(); }
  setInterval(resetMinute, 60*1000);

  function toBucket(age){
    if (!age && age !== 0) return 'unknown';
    if (age < 13) return 'child';
    if (age < 20) return '10s';
    if (age < 30) return '20s';
    if (age < 40) return '30s';
    if (age < 50) return '40s';
    if (age < 60) return '50s';
    return '60s+';
  }

  // ---------------- ユニーク判定 ----------------
  const SITE_SECRET = 'FIXED_SECRET_12345';
  const todayStr = ()=>{ const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
  function loadUniqSet(){ try{ const raw=localStorage.getItem(todayStr()); return new Set(raw?JSON.parse(raw):[]);}catch{return new Set();}}
  function saveUniqSet(set){ localStorage.setItem(todayStr(), JSON.stringify([...set])); }
  let uniqSet = loadUniqSet();

  async function hashFaceEmbedding(face){
    const emb = face.descriptor || face.embedding;
    if (!emb || !Array.isArray(emb)) return null;
    const rounded = emb.map(v=>Math.round(v*100)/100);
    const payload = JSON.stringify({ r: rounded, d: todayStr(), s: SITE_SECRET });
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    const view = new DataView(buf);
    let out=''; for (let i=0;i<16;i++) out += view.getUint8(i).toString(16).padStart(2,'0');
    return out;
  }

  // ---------------- カメラ制御 ----------------
  let running=false, stream=null, rafId=null, lastTick=0;

  async function startCamera(){
    const facing = ckFront.checked ? 'user' : 'environment';
    const s = await navigator.mediaDevices.getUserMedia({
      video: { facingMode:{ideal:facing}, width:{ideal:640}, height:{ideal:480} },
      audio: false
    });
    stream = s; video.srcObject = s; await video.play();
    overlay.width = video.videoWidth || 640;
    overlay.height = video.videoHeight || 480;
    running = true; btnStart.disabled = true; btnStop.disabled = false;
    statusEl.textContent = '実行中（ローカルモデル・ユニーク集計）';
    loop();
  }

  function stopCamera(){
    running=false; if (rafId) cancelAnimationFrame(rafId);
    if (stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
    btnStart.disabled=false; btnStop.disabled=true; statusEl.textContent='停止';
  }

  async function loop(ts){
    if (!running) return;
    if (ts && ts - lastTick < 100){ rafId = requestAnimationFrame(loop); return; }
    lastTick = ts || performance.now();

    await human.load();
    const result = await human.detect(video);

    ctx.clearRect(0,0,overlay.width,overlay.height);
    ctx.drawImage(video,0,0,overlay.width,overlay.height);

    const faces = result.face || [];
    for (const f of faces){
      const age = f.age ? Math.round(f.age) : null;
      const gender = (f.gender || 'unknown').toLowerCase();
      const gkey = gender.startsWith('f') ? 'female' : (gender.startsWith('m') ? 'male' : 'unknown');
      const bucket = toBucket(age);

      const h = await hashFaceEmbedding(f);
      if (h && !uniqSet.has(h)){
        uniqSet.add(h); saveUniqSet(uniqSet);
        minuteCounts[bucket][gkey] += 1;
      }

      const [x,y,w,hb] = f.box;
      ctx.lineWidth=2; ctx.strokeStyle='#00FF88'; ctx.strokeRect(x,y,w,hb);
      const label = `${bucket} • ${gkey}` + (age ? ` (${age})` : '');
      ctx.fillStyle='rgba(0,0,0,0.5)';
      const tw = ctx.measureText(label).width+10;
      ctx.fillRect(x, Math.max(0, y-20), tw, 20);
      ctx.fillStyle='#fff'; ctx.fillText(label, x+5, Math.max(12,y-6));
    }

    renderTable();
    logEl.textContent = `faces: ${faces.length}\nユニーク人数: ${uniqSet.size}`;
    rafId = requestAnimationFrame(loop);
  }

  // ---------------- ボタン ----------------
  btnStart.addEventListener('click', async () => {
    try { await startCamera(); }
    catch(e){ statusEl.textContent = 'カメラ開始に失敗: '+ e.message; }
  });
  btnStop.addEventListener('click', stopCamera);

  btnCsv.addEventListener('click', () => {
    const lines=['bucket,male,female,unknown'];
    for (const b of buckets){ const c = minuteCounts[b]; lines.push([b,c.male,c.female,c.unknown].join(',')); }
    const blob = new Blob([lines.join('\n')], {type:'text/csv'});
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), {href:url, download:`attributes_${Date.now()}.csv`});
    a.click(); URL.revokeObjectURL(url);
  });

  // 初期メッセージ
  if (!('mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices)){
    statusEl.textContent = 'このブラウザはカメラ取得に未対応です';
  } else {
    statusEl.textContent = '「カメラ開始」を押してください（HTTPS必須）';
  }
})();
