// 摸鱼视频 —— 覆盖层内页（M2）
// 原生 <video> 播 B站 mp4 直链 + hover 才现的极简控制条。
// 接收来自 content 的控制（popup 滑块 / 老板键），并把静音/音量变化回传给 content。
'use strict';

(function () {
  const p = new URLSearchParams(location.search);
  const videoUrl = p.get('v');
  const backups = (p.get('b') || '').split('\n').filter(Boolean);
  let vol = parseFloat(p.get('vol'));
  if (isNaN(vol)) vol = 0.6;
  vol = Math.max(0, Math.min(1, vol));
  const wantMuted = p.get('muted') !== '0'; // 期望的静音状态（默认静音）
  let startAt = parseFloat(p.get('t'));      // 起播位置（秒），用于重选位置/刷新恢复续播
  if (isNaN(startAt) || startAt < 0) startAt = 0;

  const stage = document.getElementById('stage');
  if (!videoUrl) {
    stage.innerHTML = '<div class="msg">缺少视频地址</div>';
    return;
  }

  const sources = [videoUrl].concat(backups);
  let idx = 0;

  // ---------- video ----------
  const v = document.createElement('video');
  v.muted = true; // 声音安全：默认静音起播
  v.autoplay = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.volume = vol;

  // ---------- 控制条 ----------
  const bar = document.createElement('div');
  bar.className = 'bar';

  const btnPlay = document.createElement('button');
  btnPlay.title = '播放/暂停';
  btnPlay.textContent = '▶';

  const progWrap = document.createElement('span');
  progWrap.className = 'prog';
  const prog = document.createElement('input');
  prog.type = 'range'; prog.min = '0'; prog.max = '1000'; prog.value = '0';
  progWrap.appendChild(prog);

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = '0:00 / 0:00';

  const btnMute = document.createElement('button');
  btnMute.title = '静音/取消静音';
  btnMute.textContent = '🔇';

  const volInput = document.createElement('input');
  volInput.type = 'range'; volInput.min = '0'; volInput.max = '100';
  volInput.className = 'vol';
  volInput.value = String(Math.round(v.volume * 100));

  bar.appendChild(btnPlay);
  bar.appendChild(progWrap);
  bar.appendChild(time);
  bar.appendChild(btnMute);
  bar.appendChild(volInput);

  // ---------- 工具 ----------
  function fail(text) { stage.innerHTML = '<div class="msg">' + text + '</div>'; }
  function fmt(t) {
    if (!isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function postState() {
    try {
      window.parent.postMessage(
        { __moyu: true, type: 'STATE', muted: v.muted, volume: v.volume, currentTime: v.currentTime },
        '*'
      );
    } catch (e) {}
  }
  function syncPlayUI() { btnPlay.textContent = v.paused ? '▶' : '⏸'; }
  function syncMuteUI() { btnMute.textContent = (v.muted || v.volume === 0) ? '🔇' : '🔊'; }
  function syncVolUI() {
    volInput.value = String(Math.round((v.muted ? 0 : v.volume) * 100));
    syncMuteUI();
  }

  function togglePlay() {
    if (v.paused) { const pl = v.play(); if (pl && pl.catch) pl.catch(function () {}); }
    else v.pause();
  }

  function load(i) {
    if (i >= sources.length) { fail('视频加载失败，直链可能已过期，请在插件里重新「开始」'); return; }
    v.src = sources[i];
    v.load();
    const pl = v.play();
    if (pl && pl.catch) pl.catch(function () { /* 自动播放被拦时忽略 */ });
  }

  // ---------- video 事件 ----------
  v.addEventListener('error', function () {
    idx += 1;
    if (idx < sources.length) load(idx);
    else fail('视频加载失败，直链可能已过期，请在插件里重新「开始」');
  });
  v.addEventListener('loadeddata', function () {
    const m = stage.querySelector('.msg'); if (m) m.remove();
    // 续播到指定位置（只跳一次）
    if (startAt > 0 && isFinite(v.duration) && startAt < v.duration) {
      try { v.currentTime = startAt; } catch (e) {}
    }
    startAt = 0;
    // 恢复声音：muted 起播保证能自动播，加载后若期望非静音再取消静音（此时页面已有交互）
    if (!wantMuted) v.muted = false;
    syncPlayUI(); syncVolUI();
  });
  v.addEventListener('play', syncPlayUI);
  v.addEventListener('pause', syncPlayUI);
  v.addEventListener('ended', function () {
    // 播完通知 content，由它决定是否接力下一条
    try { window.parent.postMessage({ __moyu: true, type: 'ENDED' }, '*'); } catch (e) {}
  });

  let dragging = false;
  let lastReport = 0;
  v.addEventListener('timeupdate', function () {
    if (!dragging && v.duration) prog.value = String(Math.round((v.currentTime / v.duration) * 1000));
    time.textContent = fmt(v.currentTime) + ' / ' + fmt(v.duration || 0);
    // 节流上报进度给 content（约每秒），供重选位置/刷新恢复续播
    const now = performance.now();
    if (now - lastReport > 1000) { lastReport = now; postState(); }
  });

  // ---------- 控制条交互 ----------
  btnPlay.addEventListener('click', togglePlay);
  v.addEventListener('click', togglePlay);

  prog.addEventListener('input', function () {
    dragging = true;
    if (v.duration) v.currentTime = (Number(prog.value) / 1000) * v.duration;
  });
  prog.addEventListener('change', function () { dragging = false; });

  btnMute.addEventListener('click', function () {
    v.muted = !v.muted;
    if (!v.muted && v.volume === 0) v.volume = 0.6;
    syncVolUI();
    postState();
  });
  volInput.addEventListener('input', function () {
    const val = Number(volInput.value) / 100;
    v.volume = val;
    v.muted = val === 0;
    syncMuteUI();
    postState();
  });

  // ---------- 来自 content 的控制（popup 滑块 / 老板键）----------
  window.addEventListener('message', function (e) {
    const d = e.data;
    if (!d || !d.type) return;
    switch (d.type) {
      case 'PAUSE_MUTE': // 老板键藏：暂停并静音
        v.pause(); v.muted = true; syncVolUI(); syncPlayUI(); postState();
        break;
      case 'RESUME': { // 老板键显：恢复播放但保持静音
        v.muted = true;
        const pl = v.play(); if (pl && pl.catch) pl.catch(function () {});
        syncVolUI(); syncPlayUI(); postState();
        break;
      }
      case 'SET_MUTED':
        v.muted = !!d.muted;
        if (!v.muted && v.volume === 0) v.volume = 0.6;
        syncVolUI();
        break;
      case 'SET_VOLUME': {
        let x = Number(d.volume); if (isNaN(x)) x = 0;
        x = Math.max(0, Math.min(1, x));
        v.volume = x; v.muted = x === 0;
        syncVolUI();
        break;
      }
    }
  });

  stage.appendChild(v);
  stage.appendChild(bar);
  syncVolUI();

  // 覆盖层太小时：控制条精简为"只有完整进度条"，其余请到扩展弹窗设置
  bar.title = '点画面可播放/暂停 · 音量、透明度请点扩展「摸」图标设置';
  function applyCompact() {
    const w = document.documentElement.clientWidth || window.innerWidth || 0;
    document.body.classList.toggle('compact', w < 280);
  }
  applyCompact();
  window.addEventListener('resize', applyCompact);

  load(0);
})();
