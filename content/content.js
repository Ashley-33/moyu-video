// 摸鱼视频 —— content script（M1）
// 职责：元素拾取（悬停高亮 + 点击选中）、在目标元素上覆盖播放器、位置同步、还原。
// 用 guard 防止重复注入时重复初始化（chrome.scripting.executeScript 可能被多次调用）。
if (!window.__MOYU_CONTENT__) {
  window.__MOYU_CONTENT__ = true;

  (function () {
    'use strict';

    const HOST_ID = 'moyu-video-host-x9f2a';
    const state = {
      status: 'idle', videoUrl: null, backupUrls: null, target: null,
      muted: true, volume: 0.6, opacity: 1, bossHidden: false, selectorPath: null,
      next: null, autoNext: true, currentTime: 0,
    };

    let hostEl = null;   // 光 DOM 宿主
    let shadow = null;   // shadow root，隔离宿主页样式
    let hlEl = null;     // 拾取高亮框
    let tagEl = null;    // 拾取时跟随鼠标的小标签
    let ovEl = null;     // 覆盖层容器
    let iframeEl = null; // 覆盖层内的播放器 iframe

    let picking = false;
    let hovered = null;
    let rafId = null;
    let ro = null;       // ResizeObserver
    let mo = null;       // MutationObserver
    let lastRect = null;

    // ---------- 状态上报 ----------
    function report() {
      try {
        chrome.runtime.sendMessage({
          type: 'REPORT_STATE',
          state: {
            status: state.status, videoUrl: state.videoUrl, backupUrls: state.backupUrls,
            muted: state.muted, volume: state.volume, opacity: state.opacity, next: state.next,
            selectorPath: state.selectorPath, autoNext: state.autoNext, pageUrl: location.href,
            currentTime: state.currentTime,
          },
        });
      } catch (e) {
        /* SW 可能休眠，忽略 */
      }
    }

    // ---------- 宿主 / shadow ----------
    function ensureHost() {
      if (hostEl && hostEl.isConnected) return;
      hostEl = document.createElement('div');
      hostEl.id = HOST_ID;
      hostEl.style.cssText =
        'all:initial;position:fixed;top:0;left:0;width:0;height:0;margin:0;padding:0;border:0;z-index:2147483647;pointer-events:none;';
      shadow = hostEl.attachShadow({ mode: 'open' });

      const style = document.createElement('style');
      style.textContent =
        '.hl{position:fixed;box-sizing:border-box;border:2px solid #3b82f6;' +
        'background:rgba(59,130,246,.22);border-radius:4px;pointer-events:none;display:none;}' +
        '.tag{position:fixed;pointer-events:none;display:none;background:#1f2430;color:#fff;' +
        'font:12px/1 -apple-system,system-ui,"PingFang SC",sans-serif;padding:5px 8px;border-radius:6px;' +
        'white-space:nowrap;box-shadow:0 2px 10px rgba(0,0,0,.4);}' +
        '.ov{position:fixed;overflow:hidden;background:#000;pointer-events:auto;' +
        'box-shadow:none;border:0;}' +
        '.ov iframe{width:100%;height:100%;border:0;display:block;background:#000;}';

      hlEl = document.createElement('div');
      hlEl.className = 'hl';
      tagEl = document.createElement('div');
      tagEl.className = 'tag';
      tagEl.textContent = '▶ 就盖这里';

      shadow.appendChild(style);
      shadow.appendChild(hlEl);
      shadow.appendChild(tagEl);
      (document.documentElement || document.body).appendChild(hostEl);
    }

    function applyRect(el, r) {
      el.style.top = r.top + 'px';
      el.style.left = r.left + 'px';
      el.style.width = r.width + 'px';
      el.style.height = r.height + 'px';
    }

    function isOur(el) {
      return !el || el === hostEl || el.id === HOST_ID;
    }

    // 是否是「合理的占位元素」：<video> / <img> / 尺寸 ≥ 200×150 的块级容器
    function isValidTarget(el) {
      if (!el || el.nodeType !== 1) return false;
      if (isOur(el)) return false;
      if (el === document.body || el === document.documentElement) return false;
      const tag = el.tagName;
      const r = el.getBoundingClientRect();
      if (tag === 'VIDEO' || tag === 'IMG') return r.width > 0 && r.height > 0;
      const s = getComputedStyle(el);
      const d = s.display;
      const blockish =
        d === 'block' || d === 'flex' || d === 'grid' || d === 'inline-block' ||
        d === 'list-item' || d === 'table' || d === 'flow-root';
      return blockish && r.width >= 200 && r.height >= 150;
    }

    // ---------- 拾取模式 ----------
    function onMove(e) {
      const el = e.target;
      if (!isValidTarget(el)) {
        hlEl.style.display = 'none';
        if (tagEl) tagEl.style.display = 'none';
        hovered = null;
        return;
      }
      hovered = el;
      hlEl.style.display = 'block';
      applyRect(hlEl, el.getBoundingClientRect());
      if (tagEl) {
        tagEl.style.display = 'block';
        positionTag(e.clientX, e.clientY);
      }
    }

    // 小标签跟随鼠标，靠近视口边缘时翻到另一侧避免溢出
    function positionTag(x, y) {
      const offX = 16, offY = 16;
      const tw = tagEl.offsetWidth || 78;
      const th = tagEl.offsetHeight || 26;
      let tx = x + offX, ty = y + offY;
      if (tx + tw > window.innerWidth) tx = x - offX - tw;
      if (ty + th > window.innerHeight) ty = y - offY - th;
      tagEl.style.left = tx + 'px';
      tagEl.style.top = ty + 'px';
    }

    function onClick(e) {
      if (!picking) return;
      // 拾取模式下拦截一切点击，避免误触发宿主页跳转
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      if (hovered) selectTarget(hovered);
    }

    function onKey(e) {
      if (picking && (e.key === 'Escape' || e.key === 'Esc')) {
        e.preventDefault();
        e.stopPropagation();
        stopAll();
      }
    }

    function setPickingCursor(on) {
      const de = document.documentElement;
      if (!de) return;
      let st = document.getElementById('moyu-cursor-style');
      if (on) {
        de.classList.add('moyu-picking-cursor');
        if (!st) {
          st = document.createElement('style');
          st.id = 'moyu-cursor-style';
          st.textContent =
            'html.moyu-picking-cursor, html.moyu-picking-cursor *{cursor:pointer !important;}';
          (document.head || document.documentElement).appendChild(st);
        }
      } else {
        de.classList.remove('moyu-picking-cursor');
        if (st) st.remove();
      }
    }

    function enterPicker() {
      removeOverlay(); // 若已有覆盖层，先撤掉再重新选
      ensureHost();
      picking = true;
      state.status = 'picking';
      hovered = null;
      hlEl.style.display = 'none';
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKey, true);
      setPickingCursor(true);
      report();
    }

    function exitPicker() {
      picking = false;
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      setPickingCursor(false);
      if (hlEl) hlEl.style.display = 'none';
      if (tagEl) tagEl.style.display = 'none';
    }

    function selectTarget(el) {
      exitPicker();
      state.target = el;
      createOverlay(el);
      state.status = 'active';
      report();
    }

    // ---------- 覆盖层 ----------
    function createOverlay(el) {
      ensureHost();
      state.bossHidden = false;
      state.selectorPath = computeSelector(el);
      ovEl = document.createElement('div');
      ovEl.className = 'ov';
      ovEl.style.opacity = String(state.opacity);
      // 尽量贴合原元素观感：复制圆角
      const s = getComputedStyle(el);
      ovEl.style.borderRadius = s.borderRadius && s.borderRadius !== '0px' ? s.borderRadius : '0px';

      iframeEl = document.createElement('iframe');
      // 套一层插件自己的 player.html（web_accessible_resources），绕开宿主页 CSP 的 frame-src 限制
      iframeEl.setAttribute('allow', 'autoplay; fullscreen; encrypted-media; picture-in-picture');
      iframeEl.setAttribute('scrolling', 'no');
      iframeEl.setAttribute('frameborder', '0');
      setPlayerSrc();

      ovEl.appendChild(iframeEl);
      shadow.appendChild(ovEl);

      lastRect = null;
      applyRect(ovEl, el.getBoundingClientRect());
      startSync();
      observe(el);
    }

    function removeOverlay() {
      stopSync();
      if (ro) { try { ro.disconnect(); } catch (e) {} ro = null; }
      if (mo) { try { mo.disconnect(); } catch (e) {} mo = null; }
      window.removeEventListener('scroll', onScrollResize, true);
      window.removeEventListener('resize', onScrollResize, true);
      if (ovEl) { ovEl.remove(); ovEl = null; iframeEl = null; }
      state.target = null;
      lastRect = null;
    }

    // ---------- 位置同步 ----------
    function update() {
      if (!ovEl || !state.target) return;
      if (!state.target.isConnected) { handleLost(); return; }
      const r = state.target.getBoundingClientRect();
      if (
        !lastRect ||
        r.top !== lastRect.top || r.left !== lastRect.left ||
        r.width !== lastRect.width || r.height !== lastRect.height
      ) {
        applyRect(ovEl, r);
        lastRect = { top: r.top, left: r.left, width: r.width, height: r.height };
      }
    }

    function syncLoop() {
      update();
      rafId = requestAnimationFrame(syncLoop);
    }

    function startSync() {
      if (rafId == null) rafId = requestAnimationFrame(syncLoop);
      window.addEventListener('scroll', onScrollResize, true);
      window.addEventListener('resize', onScrollResize, true);
    }

    function stopSync() {
      if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
    }

    function onScrollResize() { update(); }

    function observe(el) {
      try {
        ro = new ResizeObserver(function () { update(); });
        ro.observe(el);
      } catch (e) {}
      try {
        mo = new MutationObserver(function () {
          if (state.target && !state.target.isConnected) handleLost();
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
      } catch (e) {}
    }

    // 目标元素从 DOM 中消失：先按记录的选择器尝试重新定位（SPA 常重建 DOM），失败才收起
    let relocateTries = 0;
    function safeQuery(sel) {
      try { return document.querySelector(sel); } catch (e) { return null; }
    }
    function handleLost() {
      if (state.bossHidden) return; // 老板键隐藏期间不处理
      const found = state.selectorPath ? safeQuery(state.selectorPath) : null;
      if (found && found.isConnected) {
        if (found !== state.target) { state.target = found; lastRect = null; }
        relocateTries = 0;
        return;
      }
      relocateTries += 1;
      if (relocateTries <= 30) return; // 给 SPA 约 0.5s 重建时间再放弃
      relocateTries = 0;
      stopAll();
    }

    // ---------- 完全清理 / 还原 ----------
    function stopAll() {
      exitPicker();
      removeOverlay();
      if (hostEl) { hostEl.remove(); hostEl = null; shadow = null; hlEl = null; tagEl = null; }
      state.status = 'idle';
      state.bossHidden = false;
      report();
    }

    // ---------- M2：老板键 / 音量 / 透明度 / 选择器 ----------
    function clamp01(x) {
      x = Number(x);
      if (isNaN(x)) return 0;
      return Math.max(0, Math.min(1, x));
    }

    function postToPlayer(msg) {
      try {
        if (iframeEl && iframeEl.contentWindow) iframeEl.contentWindow.postMessage(msg, '*');
      } catch (e) {}
    }

    // 设置/更新播放器地址（创建覆盖层、以及「更换链接」时复用）
    function setPlayerSrc() {
      if (!iframeEl) return;
      const b = (state.backupUrls || []).join('\n');
      iframeEl.src =
        chrome.runtime.getURL('player/player.html') +
        '?v=' + encodeURIComponent(state.videoUrl) +
        '&b=' + encodeURIComponent(b) +
        '&vol=' + encodeURIComponent(state.volume) +
        '&muted=' + (state.muted ? '1' : '0') +
        '&t=' + encodeURIComponent(Math.floor(state.currentTime || 0));
    }

    // 播完接力下一条（仅当开启自动 且有下一条），接不下去就停在当前
    let advancing = false;
    function advanceNext() {
      if (!state.autoNext || !state.next || advancing) return;
      if (state.status !== 'active' || !iframeEl) return;
      advancing = true;
      chrome.runtime.sendMessage({ type: 'RESOLVE', url: state.next }, function (res) {
        advancing = false;
        if (!res || res.error || !res.videoUrl) return;
        state.videoUrl = res.videoUrl;
        state.backupUrls = res.backupUrls || [];
        state.next = res.next || null;
        state.muted = true;
        state.currentTime = 0;
        setPlayerSrc();
        report();
      });
    }

    // 老板键：瞬时藏/显，无动画。藏时暂停并静音，显时恢复播放但保持静音。
    function bossToggle() {
      if (state.status !== 'active' || !ovEl) return;
      state.bossHidden = !state.bossHidden;
      if (state.bossHidden) {
        ovEl.style.display = 'none';
        postToPlayer({ type: 'PAUSE_MUTE' });
      } else {
        ovEl.style.display = '';
        postToPlayer({ type: 'RESUME' });
      }
      report();
    }

    // 记录目标的选择器路径，供 SPA 重建后重新定位
    function computeSelector(el) {
      if (!el || el.nodeType !== 1) return null;
      const esc = window.CSS && CSS.escape ? CSS.escape.bind(CSS) : function (s) { return s; };
      const parts = [];
      let node = el, depth = 0;
      while (node && node.nodeType === 1 && node !== document.body && depth < 5) {
        if (node.id && document.querySelectorAll('#' + esc(node.id)).length === 1) {
          parts.unshift('#' + esc(node.id));
          return parts.join(' > ');
        }
        let sel = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (parent) {
          const sameTag = Array.prototype.filter.call(parent.children, function (c) {
            return c.tagName === node.tagName;
          });
          if (sameTag.length > 1) sel += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
        }
        parts.unshift(sel);
        node = node.parentElement;
        depth += 1;
      }
      return parts.length ? parts.join(' > ') : null;
    }

    // ---------- 消息 ----------
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      switch (msg && msg.type) {
        case 'PING':
          sendResponse({ status: state.status, videoUrl: state.videoUrl, backupUrls: state.backupUrls });
          break;
        case 'ENTER_PICKER':
          state.videoUrl = msg.videoUrl;
          state.backupUrls = msg.backupUrls || [];
          state.next = msg.next || null;
          if (msg.keepPlayback) {
            // 重新选择位置：保留当前音量/静音/进度；透明度、自动仍跟随设置
            if (msg.settings) {
              if (typeof msg.settings.opacity === 'number') state.opacity = msg.settings.opacity;
              if (typeof msg.settings.autoNext === 'boolean') state.autoNext = msg.settings.autoNext;
            }
          } else {
            if (msg.settings) {
              if (typeof msg.settings.volume === 'number') state.volume = clamp01(msg.settings.volume);
              if (typeof msg.settings.opacity === 'number') state.opacity = msg.settings.opacity;
              if (typeof msg.settings.autoNext === 'boolean') state.autoNext = msg.settings.autoNext;
            }
            state.muted = true; // 声音安全：全新起播都静音
            state.currentTime = 0;
          }
          enterPicker();
          sendResponse({ ok: true });
          break;
        case 'RESTORE_OVERLAY': {
          // 刷新后恢复：按记录的选择器路径找回目标，直接盖回去（跳过拾取）
          state.videoUrl = msg.videoUrl;
          state.backupUrls = msg.backupUrls || [];
          state.next = msg.next || null;
          state.selectorPath = msg.selectorPath || null;
          if (msg.settings) {
            if (typeof msg.settings.volume === 'number') state.volume = clamp01(msg.settings.volume);
            if (typeof msg.settings.opacity === 'number') state.opacity = msg.settings.opacity;
            if (typeof msg.settings.autoNext === 'boolean') state.autoNext = msg.settings.autoNext;
          }
          state.muted = true;
          state.currentTime = typeof msg.currentTime === 'number' ? msg.currentTime : 0;
          var rel = msg.selectorPath ? safeQuery(msg.selectorPath) : null;
          if (rel && rel.isConnected) {
            exitPicker();
            removeOverlay();
            state.target = rel;
            createOverlay(rel);
            state.status = 'active';
            report();
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false, reason: 'notfound' });
          }
          break;
        }
        case 'STOP':
          stopAll();
          sendResponse({ ok: true });
          break;
        case 'BOSS_TOGGLE':
          bossToggle();
          sendResponse({ ok: true });
          break;
        case 'SWAP_VIDEO':
          // 覆盖播放中直接换视频，位置/目标不变，无需重新拾取
          state.videoUrl = msg.videoUrl;
          state.backupUrls = msg.backupUrls || [];
          state.next = msg.next || null;
          state.muted = true;
          state.currentTime = 0;
          if (state.status === 'active' && iframeEl) setPlayerSrc();
          report();
          sendResponse({ ok: true });
          break;
        case 'SET_MUTED':
          state.muted = !!msg.muted;
          postToPlayer({ type: 'SET_MUTED', muted: state.muted });
          report();
          sendResponse({ ok: true });
          break;
        case 'SET_VOLUME':
          state.volume = clamp01(msg.volume);
          if (state.volume > 0) state.muted = false; // 拖动音量视为取消静音
          postToPlayer({ type: 'SET_VOLUME', volume: state.volume });
          report();
          sendResponse({ ok: true });
          break;
        case 'SET_OPACITY':
          state.opacity = msg.opacity;
          if (ovEl) ovEl.style.opacity = String(state.opacity);
          report();
          sendResponse({ ok: true });
          break;
        case 'SET_AUTONEXT':
          state.autoNext = !!msg.on;
          report();
          sendResponse({ ok: true });
          break;
        case 'GET_PLAYBACK':
          sendResponse({
            status: state.status, muted: state.muted, volume: state.volume,
            opacity: state.opacity, bossHidden: state.bossHidden, autoNext: state.autoNext,
          });
          break;
        default:
          sendResponse({ ok: false });
      }
      return true;
    });

    // 播放器内控制条改了静音/音量，回传给 content，让 popup 也能同步显示
    window.addEventListener('message', function (e) {
      if (!iframeEl || e.source !== iframeEl.contentWindow) return;
      const d = e.data;
      if (!d || d.__moyu !== true) return;
      if (d.type === 'STATE') {
        if (typeof d.muted === 'boolean') state.muted = d.muted;
        if (typeof d.volume === 'number') state.volume = d.volume;
        if (typeof d.currentTime === 'number') state.currentTime = d.currentTime;
        report();
      } else if (d.type === 'ENDED') {
        advanceNext();
      }
    }, false);
  })();
}
