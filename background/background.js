// 摸鱼视频 —— background service worker（M1，B站直链方案）
// B站官方 player 已禁止站外播放，改走：解析 mp4 直链 → 原生 <video> 播放。
// 视频流 CDN 有 Referer 防盗链，用 declarativeNetRequest 给 *.bilivideo.com 请求补 Referer。

const DNR_RULE_ID = 4201;

function extractBvid(str) {
  const m = String(str || '').match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : null;
}

function extractPage(str) {
  try {
    const u = new URL(str);
    const p = u.searchParams.get('p');
    return p ? parseInt(p, 10) || 1 : 1;
  } catch (e) {
    return 1;
  }
}

function isShortLink(url) {
  return /(^|\/\/)([^/]*\.)?b23\.tv[\/?]/i.test(url) || /(^|\/\/)b23\.tv$/i.test(url);
}

async function fetchJson(url) {
  const resp = await fetch(url, { credentials: 'omit' });
  return resp.json();
}

// 给 *.bilivideo.com 的请求补 Referer，绕过防盗链。
// 只作用于 bilivideo.com（视频流），不碰 bilibili.com，因此不干扰用户正常刷 B站。
async function ensureDnrRule() {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [DNR_RULE_ID],
      addRules: [
        {
          id: DNR_RULE_ID,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'referer', operation: 'set', value: 'https://www.bilibili.com' },
            ],
          },
          condition: {
            requestDomains: ['bilivideo.com'],
            resourceTypes: ['media', 'xmlhttprequest', 'other'],
          },
        },
      ],
    });
  } catch (e) {
    // host 权限未授予时规则不生效，忽略（播放时才真正需要）
  }
}

async function resolveBili(url) {
  const raw = String(url || '').trim();
  if (!raw) return { error: '请粘贴 B站视频链接' };

  let bvid = extractBvid(raw);
  let page = extractPage(raw);

  // 短链：跟随重定向拿真实 URL
  if (!bvid && isShortLink(raw)) {
    try {
      const resp = await fetch(raw, { redirect: 'follow' });
      const finalUrl = resp.url || '';
      bvid = extractBvid(finalUrl);
      page = extractPage(finalUrl);
    } catch (e) {
      return { error: '短链解析失败：可能未授权访问 b23.tv，或网络异常' };
    }
  }

  if (!bvid) return { error: '未能识别 BV 号，请确认是有效的 B站视频链接' };

  // 1) view 接口拿 cid（对应分P）
  let cid, title, pageCount = 1;
  try {
    const view = await fetchJson('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid);
    if (view.code !== 0) return { error: 'B站接口：' + (view.message || view.code) };
    const data = view.data || {};
    title = data.title || '';
    const pages = data.pages || [];
    pageCount = pages.length || 1;
    const pg = pages[(page || 1) - 1];
    cid = pg ? pg.cid : data.cid;
    if (!cid) return { error: '未取到视频 cid' };
  } catch (e) {
    return { error: '获取视频信息失败（可能未授权访问 bilibili.com）' };
  }

  // 2) playurl 接口拿 mp4 直链（匿名最高约 720P）
  try {
    const pu = await fetchJson(
      'https://api.bilibili.com/x/player/playurl?bvid=' + bvid + '&cid=' + cid + '&qn=80&fnval=0&fourk=0'
    );
    if (pu.code !== 0) return { error: '取流失败：' + (pu.message || pu.code) };
    const d = pu.data || {};
    const durl = d.durl || [];
    if (!durl.length || !durl[0].url) {
      return { error: '未取到可播放的直链（可能是大会员专享清晰度）' };
    }

    await ensureDnrRule();

    return {
      videoUrl: durl[0].url,
      backupUrls: durl[0].backup_url || [],
      segments: durl.length,
      quality: d.quality,
      title: title,
      // 分P视频：下一 P 作为"下一条"
      next: page && pageCount > page ? 'https://www.bilibili.com/video/' + bvid + '/?p=' + (page + 1) : null,
    };
  } catch (e) {
    return { error: '取流失败（可能未授权访问 bilibili.com）' };
  }
}

// ---------- 小红书（实验性）----------
// 无官方 embed、无 DNR 需求：fetch 笔记页 → 从 __INITIAL_STATE__ 抠 masterUrl（单段 mp4）。
// 直链带签名会过期，每次实时解析不缓存；http 换 https 避免宿主页混合内容拦截。
function isXhs(url) {
  return /xiaohongshu\.com/i.test(url) || /xhslink\.com/i.test(url);
}

function xhsDecode(u) {
  if (u && u.indexOf('\\u') >= 0) {
    try { u = JSON.parse('"' + u.replace(/"/g, '\\"') + '"'); } catch (e) {}
  }
  return u;
}

async function resolveXhs(url) {
  let pageUrl = String(url || '').trim();
  if (!pageUrl) return { error: '请粘贴小红书笔记链接' };

  // App 短链 xhslink.com：先跟随重定向拿真实笔记 URL（含 xsec_token）
  if (/xhslink\.com/i.test(pageUrl)) {
    try {
      const r = await fetch(pageUrl, { redirect: 'follow', credentials: 'omit' });
      pageUrl = r.url || pageUrl;
    } catch (e) {
      return { error: '小红书短链解析失败，请重试' };
    }
  }

  const toHttps = (u) => (u ? u.replace(/^http:\/\//i, 'https://') : u);
  let lastErr = '小红书解析失败，可能是链接类型不支持或站点已改版（图文笔记没有视频）';

  // 小红书偶发风控/登录墙，自动重试几次
  for (let attempt = 0; attempt < 3; attempt++) {
    let html = null;
    try {
      const resp = await fetch(pageUrl, {
        credentials: 'omit',
        headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' },
      });
      html = await resp.text();
    } catch (e) {
      lastErr = '小红书笔记抓取失败（可能未授权访问或被风控），已重试';
    }

    if (html) {
      const mm = html.match(/"masterUrl":"(.*?)"/);
      if (mm) {
        const videoUrl = toHttps(xhsDecode(mm[1]));
        let backups = [];
        const bm = html.match(/"backupUrls":\[(.*?)\]/);
        if (bm && bm[1].trim()) {
          backups = bm[1]
            .split(',')
            .map((s) => toHttps(xhsDecode(s.replace(/^\s*"|"\s*$/g, ''))))
            .filter(Boolean);
        }
        return { videoUrl: videoUrl, backupUrls: backups, source: 'xhs' };
      }
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  return { error: lastErr };
}

// ---------- B站番剧 / 影视（pgc）----------
function parseBangumi(url) {
  let m = String(url).match(/bangumi\/play\/ep(\d+)/i);
  if (m) return { epid: m[1] };
  m = String(url).match(/bangumi\/play\/ss(\d+)/i);
  if (m) return { ssid: m[1] };
  return null;
}

async function resolveBangumi(url) {
  const b = parseBangumi(url);
  if (!b) return { error: '未能识别番剧链接' };

  let epid = b.epid;
  try {
    if (!epid && b.ssid) {
      const s = await fetchJson('https://api.bilibili.com/pgc/view/web/season?season_id=' + b.ssid);
      const eps = (s.result && s.result.episodes) || [];
      if (!eps.length) return { error: '未取到剧集信息' };
      epid = eps[0].ep_id || eps[0].id;
    }
  } catch (e) {
    return { error: '获取番剧信息失败（可能未授权访问 bilibili.com）' };
  }

  try {
    const pu = await fetchJson(
      'https://api.bilibili.com/pgc/player/web/playurl?ep_id=' + epid + '&qn=80&fnval=0&fourk=0'
    );
    if (pu.code !== 0) return { error: '番剧取流失败：' + (pu.message || pu.code) };
    const r = pu.result || {};
    if (r.is_preview === 1) {
      return { error: '该番剧/影视是付费内容，免登录只能试看片段，暂不支持。请换普通投稿视频（BV号）' };
    }
    const durl = r.durl || [];
    if (!durl.length || !durl[0].url) {
      return { error: '番剧无可播放直链（可能需要大会员）' };
    }
    await ensureDnrRule();
    return {
      videoUrl: durl[0].url,
      backupUrls: durl[0].backup_url || [],
      source: 'bili-bangumi',
    };
  } catch (e) {
    return { error: '番剧取流失败（可能未授权访问 bilibili.com）' };
  }
}

// ---------- 红果短剧（字节，免费短剧）----------
// 无 DRM、无防盗链、明文 https mp4：fetch 播放页 → 抠 main_url。直链带签名会过期，实时解析。
function isHongguo(url) {
  return /hongguoduanju\.com/i.test(url);
}

async function resolveHongguo(url) {
  const pageUrl = String(url || '').trim();
  if (!pageUrl) return { error: '请粘贴红果短剧链接' };

  const dec = (u) => {
    if (!u) return u;
    u = u.replace(/\\u002[fF]/g, '/').replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    if (u.indexOf('\\u') >= 0) {
      try { u = JSON.parse('"' + u.replace(/"/g, '\\"') + '"'); } catch (e) {}
    }
    return u;
  };

  let lastErr = '红果短剧解析失败，可能是链接类型不支持或站点已改版';
  for (let attempt = 0; attempt < 3; attempt++) {
    let html = null;
    try {
      const resp = await fetch(pageUrl, {
        credentials: 'omit',
        headers: { 'Accept-Language': 'zh-CN,zh;q=0.9' },
      });
      html = await resp.text();
    } catch (e) {
      lastErr = '红果短剧抓取失败（可能未授权访问）';
    }
    if (html) {
      const m = html.match(/"main_url":"(.*?)"/);
      if (m) {
        const videoUrl = dec(m[1]).replace(/^http:\/\//i, 'https://');
        // 解析选集链接 /player/{series}/{ep}（DOM 顺序=集数顺序），算出下一集
        let next = null;
        try {
          const eps = [];
          const seen = new Set();
          const re = /href="\/player\/(\d+)\/(\d+)"/g;
          let mm;
          while ((mm = re.exec(html))) {
            const key = mm[1] + '/' + mm[2];
            if (!seen.has(key)) { seen.add(key); eps.push({ series: mm[1], ep: mm[2] }); }
          }
          if (eps.length) {
            const origin = new URL(pageUrl).origin;
            const cm = pageUrl.match(/\/player\/\d+\/(\d+)/);
            const curEp = cm ? cm[1] : eps[0].ep;
            const idx = eps.findIndex((e) => e.ep === curEp);
            if (idx >= 0 && idx + 1 < eps.length) {
              next = origin + '/player/' + eps[idx].series + '/' + eps[idx + 1].ep;
            }
          }
        } catch (e) {}
        return { videoUrl: videoUrl, backupUrls: [], source: 'hongguo', next: next };
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { error: lastErr };
}

// 统一入口：按域名/路径分流
async function resolveLink(url) {
  if (isXhs(url)) return resolveXhs(url);
  if (isHongguo(url)) return resolveHongguo(url);
  if (/bangumi\/play\/(ep|ss)\d+/i.test(url)) return resolveBangumi(url);
  return resolveBili(url);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'RESOLVE':
        case 'RESOLVE_BILI':
          sendResponse(await resolveLink(msg.url));
          return;
        case 'REPORT_STATE':
          if (sender.tab && sender.tab.id != null) {
            await chrome.storage.session.set({ ['moyu_' + sender.tab.id]: msg.state });
          }
          sendResponse({ ok: true });
          return;
        case 'GET_STATE': {
          const key = 'moyu_' + msg.tabId;
          const data = await chrome.storage.session.get(key);
          sendResponse(data[key] || { status: 'idle' });
          return;
        }
        case 'CLEAR_STATE':
          await chrome.storage.session.remove('moyu_' + msg.tabId);
          sendResponse({ ok: true });
          return;
        default:
          sendResponse({ ok: false });
      }
    } catch (e) {
      sendResponse({ error: String((e && e.message) || e) });
    }
  })();
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    chrome.storage.session.remove('moyu_' + tabId).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove('moyu_' + tabId).catch(() => {});
});

// 老板键：全局快捷键（Alt+Shift+H，用户可在 chrome://extensions/shortcuts 改键）
// 转发给当前活动 tab 的 content script 处理，要求瞬时无动画。
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-boss') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id != null) {
      await chrome.tabs.sendMessage(tab.id, { type: 'BOSS_TOGGLE' });
    }
  } catch (e) {
    // 该 tab 没有覆盖层 / 未注入 content script，忽略
  }
});
