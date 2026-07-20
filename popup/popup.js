// 摸鱼视频 —— popup（M2）
'use strict';

const $ = (s) => document.querySelector(s);
let tab = null;
let settings = { volume: 0.6, opacity: 1, autoNext: true }; // 记忆到 storage.local
let isMuted = true;
let recoverState = null; // 刷新后待恢复的状态

async function getActiveTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t;
}

function isRestricted(url) {
  if (!url) return true;
  if (/^(chrome|edge|brave|opera|about|chrome-extension|devtools|view-source|file):/i.test(url)) return true;
  if (/^https:\/\/chrome\.google\.com\/webstore/i.test(url)) return true;
  if (/^https:\/\/chromewebstore\.google\.com/i.test(url)) return true;
  return false;
}

function show(id) {
  for (const s of ['restricted', 'idle', 'picking', 'active', 'recover']) {
    const el = $('#s-' + s);
    if (el) el.hidden = s !== id;
  }
}

function setErr(m) {
  const el = $('#err');
  if (el) el.textContent = m || '';
}

function setErrRec(m) {
  const el = $('#err-rec');
  if (el) el.textContent = m || '';
}

function bg(msg) {
  return chrome.runtime.sendMessage(msg);
}

// 识别链接来源：小红书 / 红果 / B站 / 无法识别
function detectSource(url) {
  if (/xiaohongshu\.com|xhslink\.com/i.test(url)) return 'xhs';
  if (/hongguoduanju\.com/i.test(url)) return 'hongguo';
  if (/bilibili\.com|b23\.tv/i.test(url) || /BV[0-9A-Za-z]{10}/.test(url)) return 'bili';
  return null;
}

function setErr2(m) {
  const el = $('#err2');
  if (el) el.textContent = m || '';
}

function originsFor(source, url) {
  if (source === 'xhs') return ['*://*.xiaohongshu.com/*', '*://xhslink.com/*', '*://*.xhscdn.com/*'];
  if (source === 'hongguo') return ['*://*.hongguoduanju.com/*'];
  const o = ['*://*.bilibili.com/*', '*://*.bilivideo.com/*'];
  if (/b23\.tv/i.test(url)) o.push('*://b23.tv/*');
  return o;
}

async function loadSettings() {
  try {
    const d = await chrome.storage.local.get('moyu_settings');
    if (d.moyu_settings) settings = Object.assign(settings, d.moyu_settings);
  } catch (e) { /* ignore */ }
}

function saveSettings() {
  chrome.storage.local.set({ moyu_settings: settings }).catch(() => {});
}

// 确保 content script 已注入，然后发消息
async function ensureContentAndSend(msg) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/content.js'] });
  } catch (e) {
    throw new Error('无法在此页面运行（可能是受限页面）');
  }
  return chrome.tabs.sendMessage(tab.id, msg);
}

// 覆盖播放中直接发控制消息（content 已在，无需再注入）
async function sendCtl(msg) {
  try { await chrome.tabs.sendMessage(tab.id, msg); } catch (e) { /* ignore */ }
}

async function start() {
  setErr('');
  const url = ($('#url').value || '').trim();
  if (!url) { setErr('请粘贴 B站 / 小红书 / 红果短剧 链接哦'); return; }

  const source = detectSource(url);
  if (!source) { setErr('无法识别链接，请粘贴 B站 或 小红书 视频链接'); return; }

  const origins = originsFor(source, url);
  let granted = false;
  try { granted = await chrome.permissions.request({ origins }); } catch (e) { /* ignore */ }
  if (!granted) { setErr('需要授权相应站点访问权限才能解析并播放'); return; }

  $('#start').disabled = true;
  if (source === 'xhs') setErr('小红书解析中…（实验性，可能失效）');
  else if (source === 'hongguo') setErr('红果短剧解析中…');
  const res = await bg({ type: 'RESOLVE', url });
  $('#start').disabled = false;
  if (!res || res.error) { setErr((res && res.error) || '解析失败'); return; }
  setErr('');

  try {
    await ensureContentAndSend({
      type: 'ENTER_PICKER',
      videoUrl: res.videoUrl,
      backupUrls: res.backupUrls,
      next: res.next || null,
      settings: settings,
    });
  } catch (e) {
    setErr(e.message || '注入失败');
    return;
  }
  show('picking');
}

async function stopOverlay() {
  setErr('');
  try { await ensureContentAndSend({ type: 'STOP' }); } catch (e) { /* 页面可能已刷新 */ }
  await bg({ type: 'CLEAR_STATE', tabId: tab.id });
  show('idle');
}

async function reselect() {
  setErr('');
  const st = await bg({ type: 'GET_STATE', tabId: tab.id });
  const videoUrl = st && st.videoUrl;
  if (!videoUrl) { setErr('找不到当前视频地址，请重新开始'); show('idle'); return; }
  try {
    await ensureContentAndSend({
      type: 'ENTER_PICKER',
      videoUrl: videoUrl,
      backupUrls: st.backupUrls,
      next: st.next || null,
      settings: settings,
    });
  } catch (e) {
    setErr(e.message || '注入失败');
    return;
  }
  show('picking');
}

// 覆盖播放中直接更换链接：解析新视频，替换当前覆盖层（位置不变，免还原重选）
async function swap() {
  setErr2('');
  const url = ($('#url2').value || '').trim();
  if (!url) { setErr2('请粘贴新链接'); return; }
  const source = detectSource(url);
  if (!source) { setErr2('无法识别链接'); return; }

  const origins = originsFor(source, url);
  let granted = false;
  try { granted = await chrome.permissions.request({ origins }); } catch (e) { /* ignore */ }
  if (!granted) { setErr2('需要授权相应站点访问权限'); return; }

  $('#swapbtn').disabled = true;
  if (source === 'xhs') setErr2('小红书解析中…（实验性）');
  else if (source === 'hongguo') setErr2('红果短剧解析中…');
  const res = await bg({ type: 'RESOLVE', url });
  $('#swapbtn').disabled = false;
  if (!res || res.error) { setErr2((res && res.error) || '解析失败'); return; }
  setErr2('');
  await sendCtl({ type: 'SWAP_VIDEO', videoUrl: res.videoUrl, backupUrls: res.backupUrls, next: res.next || null });
  $('#url2').value = '';
}

function updateMuteBtn() {
  const mute = $('#mute');
  if (mute) mute.textContent = isMuted ? '🔇 取消静音' : '🔊 静音';
}

// 进入控制面板：用当前播放状态回填滑块（拿不到就用记忆值）
function setupControls(pb) {
  const vol = $('#vol');
  const op = $('#op');
  const mute = $('#mute');

  const curVol = pb && typeof pb.volume === 'number' ? pb.volume : settings.volume;
  const curOp = pb && typeof pb.opacity === 'number' ? pb.opacity : settings.opacity;
  isMuted = pb ? !!pb.muted : true;

  vol.value = String(Math.round(curVol * 100));
  op.value = String(Math.round(curOp * 100));
  updateMuteBtn();

  vol.oninput = () => {
    const val = Number(vol.value) / 100;
    settings.volume = val;
    isMuted = val === 0;
    updateMuteBtn();
    saveSettings();
    sendCtl({ type: 'SET_VOLUME', volume: val });
  };
  op.oninput = () => {
    const val = Number(op.value) / 100;
    settings.opacity = val;
    saveSettings();
    sendCtl({ type: 'SET_OPACITY', opacity: val });
  };
  mute.onclick = () => {
    isMuted = !isMuted;
    updateMuteBtn();
    sendCtl({ type: 'SET_MUTED', muted: isMuted });
  };

  const auto = $('#autonext');
  if (auto) {
    auto.checked = pb && typeof pb.autoNext === 'boolean'
      ? pb.autoNext
      : (typeof settings.autoNext === 'boolean' ? settings.autoNext : true);
    auto.onchange = () => {
      settings.autoNext = auto.checked;
      saveSettings();
      sendCtl({ type: 'SET_AUTONEXT', on: auto.checked });
    };
  }
}

// 按平台/用户设置，动态显示老板键真实快捷键（Mac 显示 ⌘⇧H 等）
async function setupBossKey() {
  try {
    const cmds = await chrome.commands.getAll();
    const boss = cmds.find((c) => c.name === 'toggle-boss');
    const txt = boss && boss.shortcut ? boss.shortcut : '未设置（去 chrome://extensions/shortcuts 指定）';
    document.querySelectorAll('.boss-key').forEach((el) => { el.textContent = txt; });
  } catch (e) { /* ignore */ }
}

// 刷新后恢复：注入 content，按记录的选择器路径把视频盖回原位
async function doRecover() {
  setErrRec('');
  if (!recoverState) { show('idle'); return; }
  let res;
  try {
    res = await ensureContentAndSend({
      type: 'RESTORE_OVERLAY',
      videoUrl: recoverState.videoUrl,
      backupUrls: recoverState.backupUrls,
      next: recoverState.next,
      selectorPath: recoverState.selectorPath,
      settings: {
        volume: recoverState.volume,
        opacity: recoverState.opacity,
        autoNext: recoverState.autoNext,
      },
    });
  } catch (e) {
    setErrRec(e.message || '恢复失败');
    return;
  }
  if (res && res.ok) {
    let pb = null;
    try { pb = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PLAYBACK' }); } catch (e) { /* ignore */ }
    show('active');
    setupControls(pb);
  } else {
    await bg({ type: 'CLEAR_STATE', tabId: tab.id });
    recoverState = null;
    setErr('原来的位置找不到了（页面可能变了），请重新开始');
    show('idle');
  }
}

async function skipRecover() {
  await bg({ type: 'CLEAR_STATE', tabId: tab.id });
  recoverState = null;
  show('idle');
}

async function init() {
  // 顶部动态显示当前版本号（每次更新 bump manifest version 即可）
  const verEl = document.querySelector('.ver');
  if (verEl) verEl.textContent = 'v' + chrome.runtime.getManifest().version;

  tab = await getActiveTab();
  setupBossKey();

  if (isRestricted(tab && tab.url)) {
    show('restricted');
    return;
  }

  await loadSettings();

  const st = await bg({ type: 'GET_STATE', tabId: tab.id });
  const status = (st && st.status) || 'idle';

  if (status === 'active') {
    let pb = null;
    try { pb = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PLAYBACK' }); } catch (e) { /* ignore */ }
    show('active');
    setupControls(pb);
  } else if (status === 'picking') {
    show('picking');
  } else if (status === 'recoverable' && st.pageUrl && tab.url === st.pageUrl && st.videoUrl && st.selectorPath) {
    // 同一页刷新，提供恢复
    recoverState = st;
    show('recover');
  } else {
    if (status === 'recoverable') await bg({ type: 'CLEAR_STATE', tabId: tab.id }); // 已导航到别处，清掉
    show('idle');
  }

  $('#start').addEventListener('click', start);
  $('#url').addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
  $('#cancel').addEventListener('click', stopOverlay);
  $('#restore').addEventListener('click', stopOverlay);
  $('#reselect').addEventListener('click', reselect);
  $('#swapbtn').addEventListener('click', swap);
  $('#url2').addEventListener('keydown', (e) => { if (e.key === 'Enter') swap(); });
  $('#recover').addEventListener('click', doRecover);
  $('#recover-skip').addEventListener('click', skipRecover);
}

init();
