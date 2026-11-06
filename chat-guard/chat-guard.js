// 聊天保护 (Chat Guard) —— 酒馆助手 (JS-Slash-Runner) 脚本
// 1. 拦截"楼层异常骤减"的保存（例如改正则后聊天只剩开场白），手动删楼放行
// 2. 自动保存"最新完好版"快照（压缩存 IndexedDB），可一键恢复
// 3. 在特殊时刻（大面积改写 / 大量删楼 / 每次打开聊天）留历史版本

(() => {
  'use strict';

  const P = window.parent;
  const GLOBAL_KEY = '__chatGuard__';
  const LS_EXPECTED = 'chatGuard:expected';
  const LS_SETTINGS = 'chatGuard:settings';
  const DB_NAME = 'chat-guard';
  const STORE = 'snaps';
  const ENTRY_ID = 'chat_guard_settings';

  const DEFAULTS = {
    autoRestore: true, // true: 挡下后自动恢复聊天; false: 只提示
    historyLimit: 3, // 每个聊天保留的历史版本数
    dropThreshold: 3, // 未授权地一次少了 >= 这么多楼就拦截
    totalCapMB: 50, // 快照总占用上限
  };
  const LATEST_DEBOUNCE = 15000; // 最新完好版的写入防抖
  const REWRITE_MIN = 3; // 最后两楼以外同时被改的楼数 >= 这个值视为大面积改写

  // ---------- 小工具 ----------
  const lsGet = (k, d) => {
    try {
      const v = P.localStorage.getItem(k);
      return v ? JSON.parse(v) : d;
    } catch {
      return d;
    }
  };
  const lsSet = (k, v) => {
    try {
      P.localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  };
  const settings = Object.assign({}, DEFAULTS, lsGet(LS_SETTINGS, {}));
  const saveSettings = () => lsSet(LS_SETTINGS, settings);

  const expected = lsGet(LS_EXPECTED, {});
  const setExpected = (key, n) => {
    expected[key] = n;
    const keys = Object.keys(expected);
    if (keys.length > 800) keys.slice(0, keys.length - 800).forEach(k => delete expected[k]);
    lsSet(LS_EXPECTED, expected);
  };

  const ctx = () => P.SillyTavern.getContext();
  const notify = P.toastr || window.toastr;
  const idle = fn => (P.requestIdleCallback ? P.requestIdleCallback(fn, { timeout: 5000 }) : setTimeout(fn, 200));
  const fmtTime = ts => new Date(ts).toLocaleString();
  const fmtSize = b => (b > 1048576 ? (b / 1048576).toFixed(2) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  async function gzip(text) {
    return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
  }
  async function gunzip(blob) {
    return new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  }

  // 每条消息的轻量指纹：id 用来认"是不是同一楼"，h 用来认"内容变没变"
  function fingerprints(msgs) {
    let sig = 2166136261;
    const list = msgs.map(m => {
      const t = typeof m?.mes === 'string' ? m.mes : '';
      const id = (m?.is_user ? 'u' : 'a') + '|' + (m?.send_date ?? '') + '|' + (m?.name ?? '');
      const h = t.length + ':' + t.slice(0, 16) + t.slice(-16) + ':' + (m?.swipe_id ?? '');
      const s = id + h;
      for (let i = 0; i < s.length; i++) sig = Math.imul(sig ^ s.charCodeAt(i), 16777619);
      return { id, h };
    });
    return { list, sig: (sig >>> 0).toString(36) + '-' + msgs.length };
  }

  // new 是否是 old 删掉若干楼后的结果（其余楼完全一致、顺序一致）
  function isSubsequence(oldList, newList) {
    let j = 0;
    for (let i = 0; i < oldList.length && j < newList.length; i++) {
      if (oldList[i].id === newList[j].id && oldList[i].h === newList[j].h) j++;
    }
    return j === newList.length;
  }

  function countRewrites(oldList, newList) {
    const lim = Math.min(oldList.length, newList.length) - 2;
    let c = 0;
    for (let i = 0; i < lim; i++) {
      if (oldList[i].id === newList[i].id && oldList[i].h !== newList[i].h) c++;
    }
    return c;
  }

  function isBadDrop(e, n) {
    if (e == null || n >= e) return false;
    if (n === 0) return true;
    if (n <= 1 && e >= 3) return true;
    return e - n >= settings.dropThreshold;
  }

  // ---------- IndexedDB ----------
  let dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = P.indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const s = req.result.createObjectStore(STORE, { keyPath: 'id' });
          s.createIndex('key', 'key');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const s = t.objectStore(STORE);
      let out;
      Promise.resolve(fn(s, v => (out = v))).catch(reject);
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  const put = rec => tx('readwrite', s => s.put(rec));
  const del = id => tx('readwrite', s => s.delete(id));
  const get = id =>
    tx('readonly', (s, set) => {
      const r = s.get(id);
      r.onsuccess = () => set(r.result);
    });
  const byKey = key =>
    tx('readonly', (s, set) => {
      const r = s.index('key').getAll(key);
      r.onsuccess = () => set(r.result || []);
    });
  const all = () =>
    tx('readonly', (s, set) => {
      const r = s.getAll();
      r.onsuccess = () => set(r.result || []);
    });

  // ---------- 快照队列（保证顺序：先落盘旧的完好版，再挪进历史，再记新的） ----------
  let queue = Promise.resolve();
  const enqueue = fn => (queue = queue.then(fn).catch(e => console.warn('[聊天保护] 快照任务失败', e)));

  let pending = null; // { key, url, text, n, sig, title }
  let pendingTimer = null;
  let writesSincePrune = 0;

  function setPending(p) {
    pending = p;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => idle(() => enqueue(flushPending)), LATEST_DEBOUNCE);
  }

  async function flushPending() {
    clearTimeout(pendingTimer);
    const p = pending;
    if (!p) return;
    pending = null;
    const old = await get(p.key + '|L');
    if (old && old.sig === p.sig) return;
    const blob = await gzip(p.text);
    await put({ id: p.key + '|L', key: p.key, kind: 'L', ts: Date.now(), n: p.n, sig: p.sig, url: p.url, title: p.title, size: blob.size, blob });
    requestRender();
    if (++writesSincePrune >= 10) {
      writesSincePrune = 0;
      await prune();
    }
  }

  // 把当前"最新完好版"复制一份进历史
  async function rotateToHistory(key, reason) {
    const limit = Math.max(0, Number(settings.historyLimit) || 0);
    if (limit === 0) return;
    const latest = await get(key + '|L');
    if (!latest) return;
    const hist = (await byKey(key)).filter(r => r.kind === 'H').sort((a, b) => b.ts - a.ts);
    if (hist[0] && hist[0].sig === latest.sig) return; // 内容没变，不重复存
    await put({ ...latest, id: key + '|H|' + Date.now(), kind: 'H', ts: Date.now(), reason });
    requestRender();
    for (const r of hist.slice(limit - 1)) await del(r.id);
  }

  async function prune() {
    const recs = await all();
    let total = recs.reduce((s, r) => s + (r.size || 0), 0);
    const cap = settings.totalCapMB * 1048576;
    if (total <= cap) return;
    const cur = currentKey();
    const order = recs
      .filter(r => r.key !== cur)
      .sort((a, b) => (a.kind === b.kind ? a.ts - b.ts : a.kind === 'H' ? -1 : 1));
    for (const r of order) {
      if (total <= cap) break;
      await del(r.id);
      total -= r.size || 0;
    }
  }

  // ---------- 当前聊天 ----------
  function currentKey() {
    const c = ctx();
    if (!c.chatId) return null;
    if (c.groupId) return 'group|' + c.chatId;
    const ch = c.characters?.[c.characterId];
    return ch ? ch.avatar + '|' + ch.chat : null;
  }
  function currentTitle() {
    const c = ctx();
    if (c.groupId) return (c.groups?.find(g => g.id === c.groupId)?.name || '群聊') + ' / ' + c.chatId;
    const ch = c.characters?.[c.characterId];
    return ch ? ch.name + ' / ' + ch.chat : String(c.chatId);
  }
  function buildCurrentBody() {
    const c = ctx();
    const header = { chat_metadata: { ...c.chatMetadata }, user_name: 'unused', character_name: 'unused' };
    if (c.groupId) return { url: '/api/chats/group/save', text: JSON.stringify({ id: c.chatId, chat: [header, ...c.chat] }) };
    const ch = c.characters[c.characterId];
    return {
      url: '/api/chats/save',
      text: JSON.stringify({ ch_name: ch.name, file_name: ch.chat, chat: [header, ...c.chat], avatar_url: ch.avatar }),
    };
  }

  const prevFp = new Map(); // key -> fingerprint list（上一次确认完好的状态）
  const openedThisSession = new Set();
  let pendingDelete = null; // { key, count, ts }
  let lastBlocked = null; // { key, path, init, e, n, ts }
  let autoReloads = { ts: 0, count: 0 };

  // ---------- 拦截保存 ----------
  async function readBody(init) {
    const body = init?.body;
    if (typeof body === 'string') return body;
    if (body == null) return null;
    const enc = new Headers(init.headers || {}).get('Content-Encoding');
    const blob = body instanceof Blob ? body : new Blob([body]);
    return enc && enc.includes('gzip') ? gunzip(blob) : blob.text();
  }

  /** @returns {Promise<boolean>} true = 拦下 */
  async function inspectSave(path, init) {
    const text = await readBody(init);
    if (!text) return false;
    const data = JSON.parse(text);
    const isGroup = path.endsWith('/group/save');
    const key = isGroup ? 'group|' + data.id : data.avatar_url + '|' + data.file_name;
    const arr = Array.isArray(data.chat) ? data.chat : [];
    const msgs = arr.length && arr[0] && typeof arr[0] === 'object' && 'chat_metadata' in arr[0] ? arr.slice(1) : arr;
    const n = msgs.length;
    const e = expected[key];
    const fp = fingerprints(msgs);
    const prev = prevFp.get(key);

    const authorizedDelete = pendingDelete && pendingDelete.key === key && n === pendingDelete.count && Date.now() - pendingDelete.ts < 20000;
    const cleanDelete = prev && n >= 2 && n < prev.length && isSubsequence(prev, fp.list);

    if (!data.force && !authorizedDelete && !cleanDelete && isBadDrop(e, n)) {
      onBlocked({ key, path, init, e, n });
      return true;
    }

    // 放行：更新记录和快照
    setExpected(key, n);
    prevFp.set(key, fp.list);
    let reason = null;
    if (prev) {
      if (prev.length - n >= settings.dropThreshold) reason = '删楼前';
      else if (countRewrites(prev, fp.list) >= REWRITE_MIN) reason = '大面积改写前';
    }
    const title = key === currentKey() ? currentTitle() : isGroup ? '群聊 / ' + data.id : (data.ch_name || '') + ' / ' + data.file_name;
    const next = { key, url: path, text, n, sig: fp.sig, title };
    if (reason) {
      enqueue(async () => {
        await flushPending(); // 先把改动前的完好版落盘
        await rotateToHistory(key, reason);
      });
      enqueue(async () => setPending(next));
    } else {
      enqueue(async () => {
        if (pending && pending.key !== key) await flushPending();
        setPending(next);
      });
    }
    return false;
  }

  function onBlocked(b) {
    const now = Date.now();
    const repeat = lastBlocked && lastBlocked.key === b.key && now - lastBlocked.ts < 5000;
    lastBlocked = { ...b, ts: now };
    requestRender();
    console.warn(`[聊天保护] 已拦下一次异常保存：${b.e} 楼 → ${b.n} 楼`, b.key);
    if (!repeat) {
      notify.warning(
        settings.autoRestore ? '文件没有被改动，正在恢复聊天…' : '文件没有被改动，刷新页面即可恢复。如果这次是你有意为之，可在「扩展 → 聊天保护」里放行。',
        `聊天保护：已拦下异常保存（${b.e} → ${b.n} 楼）`,
        { timeOut: 6000 },
      );
    }
    if (settings.autoRestore) setTimeout(() => maybeAutoReload(b.key), 1500);
  }

  async function maybeAutoReload(key) {
    if (currentKey() !== key) return;
    const e = expected[key];
    if (!isBadDrop(e, ctx().chat.length)) return; // ST 自己已经重新读回来了
    const now = Date.now();
    if (now - autoReloads.ts > 60000) autoReloads = { ts: now, count: 0 };
    if (autoReloads.count >= 3) return;
    autoReloads.count++;
    await ctx().reloadCurrentChat();
  }

  async function allowLastBlocked() {
    const b = lastBlocked;
    if (!b) return;
    lastBlocked = null;
    const res = await origFetch.call(P, b.path, b.init);
    if (res.ok) {
      setExpected(b.key, b.n);
      prevFp.delete(b.key);
      notify.success(`已放行，现在是 ${b.n} 楼`);
    } else notify.error('放行失败：' + res.status);
  }

  // ---------- 聊天载入 ----------
  async function onChatChanged() {
    requestRender();
    const key = currentKey();
    if (!key) return;
    const c = ctx();
    const n = c.chat.length;
    const e = expected[key];

    if (isBadDrop(e, n)) {
      // 硬盘上的文件可能已经被写坏了
      const latest = await get(key + '|L');
      if (latest && latest.n > n) {
        if (settings.autoRestore) {
          notify.warning(`聊天只有 ${n} 楼，记录是 ${e} 楼，正在从快照自动恢复…`, '聊天保护');
          await restore(latest, { silent: true });
        } else {
          notify.warning(`聊天只有 ${n} 楼，记录是 ${e} 楼。去「扩展 → 聊天保护」可以一键恢复。`, '聊天保护', { timeOut: 10000 });
        }
      }
      return;
    }

    const fp = fingerprints(c.chat);
    prevFp.set(key, fp.list);
    setExpected(key, n);

    idle(() =>
      enqueue(async () => {
        if (currentKey() !== key || ctx().chat.length !== n) return;
        const latest = await get(key + '|L');
        if (!latest || latest.sig !== fp.sig) {
          // 快照和打开时的样子不一致（或还没有快照）：先补一份最新完好版
          await flushPending();
          const body = buildCurrentBody();
          setPending({ key, url: body.url, text: body.text, n, sig: fp.sig, title: currentTitle() });
          await flushPending();
        }
        if (!openedThisSession.has(key)) {
          openedThisSession.add(key);
          await rotateToHistory(key, '打开聊天时');
        }
      }),
    );
  }

  function onMessageDeleted(count) {
    const key = currentKey();
    if (key && count > 0 && ctx().chat.length === count) pendingDelete = { key, count, ts: Date.now() };
  }

  // ---------- 恢复 ----------
  async function restore(rec, { silent = false } = {}) {
    const text = await gunzip(rec.blob);
    const data = JSON.parse(text);
    data.force = true;
    await enqueue(async () => {
      await flushPending();
      await rotateToHistory(rec.key, '恢复前');
    });
    const res = await origFetch.call(P, rec.url, {
      method: 'POST',
      cache: 'no-cache',
      headers: ctx().getRequestHeaders(),
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      notify.error('恢复失败：' + res.status, '聊天保护');
      return false;
    }
    const msgs = data.chat.slice(1);
    setExpected(rec.key, msgs.length);
    prevFp.set(rec.key, fingerprints(msgs).list);
    if (rec.key === currentKey()) await ctx().reloadCurrentChat();
    requestRender();
    notify.success(`已恢复到 ${fmtTime(rec.ts)} 的版本（${rec.n} 楼）`, silent ? '聊天保护：自动恢复' : '聊天保护');
    return true;
  }

  // ---------- 面板（直接放在「扩展」里正则下面的下拉框中） ----------
  const fmtShort = ts => {
    const d = new Date(ts);
    const hm = d.toTimeString().slice(0, 5);
    return d.toDateString() === new Date().toDateString() ? '今天 ' + hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  };
  const PANEL_CSS = `
    #${ENTRY_ID} .cg{display:flex;flex-direction:column;gap:10px;text-align:left;padding:6px 0 4px}
    #${ENTRY_ID} .cg-card{border-radius:12px;padding:12px;background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.16)}
    #${ENTRY_ID} .cg-status{display:flex;gap:12px;align-items:center}
    #${ENTRY_ID} .cg-ok{background:rgba(76,175,80,.12);border-color:rgba(76,175,80,.32)}
    #${ENTRY_ID} .cg-warn{background:rgba(230,160,40,.15);border-color:rgba(230,160,40,.4)}
    #${ENTRY_ID} .cg-icon{flex-shrink:0;width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;color:#fff;background:#4caf50}
    #${ENTRY_ID} .cg-warn .cg-icon{background:#e6a028}
    #${ENTRY_ID} .cg-main{flex:1;min-width:0}
    #${ENTRY_ID} .cg-h{font-weight:bold;font-size:1.05em;line-height:1.35}
    #${ENTRY_ID} .cg-sub{opacity:.7;font-size:.85em;line-height:1.45;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #${ENTRY_ID} .cg-title{display:flex;align-items:center;gap:7px;font-weight:bold;margin-bottom:10px}
    #${ENTRY_ID} .cg-title i{opacity:.7}
    #${ENTRY_ID} .cg-item{display:flex;align-items:center;gap:8px;padding:9px 10px;border-radius:9px;background:rgba(127,127,127,.08)}
    #${ENTRY_ID} .cg-item + .cg-item{margin-top:6px}
    #${ENTRY_ID} .cg-latest{background:rgba(76,175,80,.13);box-shadow:inset 3px 0 0 #4caf50}
    #${ENTRY_ID} .cg-badge{display:inline-block;font-size:.72em;font-weight:normal;padding:1px 7px;border-radius:8px;background:#4caf50;color:#fff;margin-left:6px;vertical-align:middle}
    #${ENTRY_ID} .cg-btn{flex-shrink:0;white-space:nowrap;cursor:pointer;padding:4px 13px;border-radius:999px;font-size:.85em;border:1px solid rgba(127,127,127,.38);user-select:none;line-height:1.5}
    #${ENTRY_ID} .cg-btn:hover{background:rgba(127,127,127,.15)}
    #${ENTRY_ID} .cg-primary{background:#4caf50;border-color:#4caf50;color:#fff}
    #${ENTRY_ID} .cg-primary:hover{background:#43a047}
    #${ENTRY_ID} .cg-amber{background:#e6a028;border-color:#e6a028;color:#fff}
    #${ENTRY_ID} .cg-del{padding:4px 9px;color:#d9534f;border-color:rgba(217,83,79,.4)}
    #${ENTRY_ID} .cg-add{margin-top:10px;text-align:center;padding:8px;border-radius:9px;border:1px dashed rgba(127,127,127,.5);cursor:pointer;font-size:.9em;opacity:.85}
    #${ENTRY_ID} .cg-add:hover{opacity:1;background:rgba(127,127,127,.08)}
    #${ENTRY_ID} .cg-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 0}
    #${ENTRY_ID} .cg-row + .cg-row{border-top:1px solid rgba(127,127,127,.16)}
    #${ENTRY_ID} .cg-row select, #${ENTRY_ID} .cg-row input{width:auto !important;min-width:0;margin:0 !important;flex-shrink:0}
    #${ENTRY_ID} .cg-row input{width:4.5em !important;text-align:center}
    #${ENTRY_ID} .cg-empty{opacity:.6;font-size:.85em;padding:2px}
  `;
  let renderTimer = null;
  function panelBody() {
    return P.document.querySelector('#' + ENTRY_ID + ' .cg-body');
  }
  function requestRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => render().catch(e => console.warn('[聊天保护] 面板刷新失败', e)), 300);
  }

  async function render() {
    const body = panelBody();
    if (!body || !body.offsetParent) return; // 没展开就不刷新
    const key = currentKey();
    const n = ctx().chat.length;
    const e = key ? expected[key] : null;
    const recs = key ? await byKey(key) : [];
    const latest = recs.find(r => r.kind === 'L');
    const hist = recs.filter(r => r.kind === 'H' && (!latest || r.sig !== latest.sig)).sort((x, y) => y.ts - x.ts);

    const item = (r, isLatest) => `
      <div class="cg-item ${isLatest ? 'cg-latest' : ''}">
        <div class="cg-main">
          <div class="cg-h" style="font-size:.95em">${isLatest ? '最新完好版<span class="cg-badge">推荐</span>' : esc(r.reason || '历史版本')}</div>
          <div class="cg-sub">${fmtShort(r.ts)} · ${r.n} 楼 · ${fmtSize(r.size)}</div>
        </div>
        <div class="cg-btn ${isLatest ? 'cg-primary' : ''}" data-act="restore" data-id="${esc(r.id)}">恢复</div>
        ${isLatest ? '' : `<div class="cg-btn cg-del" data-act="del" data-id="${esc(r.id)}" title="删除"><i class="fa-solid fa-trash-can"></i></div>`}
      </div>`;

    const bad = key && isBadDrop(e, n);
    const blocked = lastBlocked && lastBlocked.key === key;
    const status = !key
      ? `<div class="cg-card cg-status">
           <div class="cg-icon" style="background:rgba(127,127,127,.5)"><i class="fa-solid fa-shield-halved"></i></div>
           <div class="cg-main"><div class="cg-h">待命中</div><div class="cg-sub">打开一个聊天后开始保护</div></div>
         </div>`
      : `<div class="cg-card cg-status ${bad ? 'cg-warn' : 'cg-ok'}">
           <div class="cg-icon"><i class="fa-solid ${bad ? 'fa-triangle-exclamation' : 'fa-shield-halved'}"></i></div>
           <div class="cg-main">
             <div class="cg-h">${bad ? '聊天不完整' : '保护中'}</div>
             <div class="cg-sub">${esc(currentTitle())}</div>
             <div class="cg-sub">${bad ? `当前 ${n} 楼，记录是 ${e} 楼，可以从下面恢复` : `共 ${n} 楼`}</div>
           </div>
         </div>`;
    const alert = blocked
      ? `<div class="cg-card cg-status cg-warn">
           <div class="cg-icon"><i class="fa-solid fa-hand"></i></div>
           <div class="cg-main">
             <div class="cg-h">挡下了一次坏保存</div>
             <div class="cg-sub">${fmtShort(lastBlocked.ts)} · ${lastBlocked.e} 楼 → ${lastBlocked.n} 楼 · 文件没被改动</div>
           </div>
           <div class="cg-btn cg-amber" data-act="allow" title="如果这次是你有意删的楼，点这里放行">放行</div>
         </div>`
      : '';
    const snaps = key
      ? `<div class="cg-card">
           <div class="cg-title"><i class="fa-solid fa-clock-rotate-left"></i>快照</div>
           ${latest ? item(latest, true) : '<div class="cg-empty">还没有快照，正常保存一次后会自动生成</div>'}
           ${hist.map(r => item(r, false)).join('')}
           <div class="cg-add" data-act="snap"><i class="fa-solid fa-plus"></i> 把当前聊天存一份到历史</div>
         </div>`
      : '';
    const prefs = `
      <div class="cg-card">
        <div class="cg-title"><i class="fa-solid fa-sliders"></i>设置</div>
        <div class="cg-row">
          <span>挡下坏保存后</span>
          <select class="text_pole" data-set="autoRestore">
            <option value="1" ${settings.autoRestore ? 'selected' : ''}>自动恢复聊天</option>
            <option value="0" ${settings.autoRestore ? '' : 'selected'}>只弹小提示</option>
          </select>
        </div>
        <div class="cg-row">
          <span>每个聊天保留历史（份）</span>
          <input type="number" min="0" max="20" class="text_pole" data-set="historyLimit" value="${settings.historyLimit}">
        </div>
      </div>`;
    body.innerHTML = `<div class="cg">${status}${alert}${snaps}${prefs}</div>`;
  }

  async function onPanelClick(ev) {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const id = btn.dataset.id;
    const key = currentKey();
    if (act === 'allow') {
      await allowLastBlocked();
    } else if (act === 'del') {
      await del(id);
    } else if (act === 'restore') {
      const rec = await get(id);
      if (!rec) return;
      const c = ctx();
      const ok = await c.callGenericPopup(
        `恢复到 ${fmtShort(rec.ts)} 的版本（${rec.n} 楼）？<br><small>恢复前会先把现在的版本存进历史。</small>`,
        c.POPUP_TYPE.CONFIRM,
      );
      if (ok) await restore(rec);
    } else if (act === 'snap' && key) {
      const n = ctx().chat.length;
      if (isBadDrop(expected[key], n)) return notify.warning('当前聊天看起来不完整，没有存。');
      const body = buildCurrentBody();
      const fp = fingerprints(ctx().chat);
      await enqueue(async () => {
        await flushPending();
        setPending({ key, url: body.url, text: body.text, n, sig: fp.sig, title: currentTitle() });
        await flushPending();
        await rotateToHistory(key, '手动保存');
      });
      notify.success('已存入历史');
    }
    requestRender();
  }

  function onPanelChange(ev) {
    const t = ev.target;
    if (t.dataset.set === 'autoRestore') settings.autoRestore = t.value === '1';
    else if (t.dataset.set === 'historyLimit') settings.historyLimit = Math.max(0, Math.min(20, Number(t.value) || 0));
    else return;
    saveSettings();
  }

  // ---------- 安装 / 卸载 ----------
  if (P[GLOBAL_KEY]) {
    try {
      P[GLOBAL_KEY].destroy();
    } catch {
      /* 旧实例所在 iframe 已销毁 */
      if (P[GLOBAL_KEY].origFetch) P.fetch = P[GLOBAL_KEY].origFetch;
    }
  }
  const origFetch = P.fetch;

  function guardedFetch(input, init) {
    let path = '';
    try {
      path = new URL(typeof input === 'string' ? input : input?.url || String(input), P.location.href).pathname;
    } catch {
      /* ignore */
    }
    const isSave = (path === '/api/chats/save' || path === '/api/chats/group/save') && String(init?.method || '').toUpperCase() === 'POST';
    if (!isSave) return origFetch.call(P, input, init);
    return inspectSave(path, init).then(
      blocked =>
        blocked
          ? new P.Response('{"result":"blocked by chat guard"}', { status: 200, headers: { 'Content-Type': 'application/json' } })
          : origFetch.call(P, input, init),
      err => {
        console.warn('[聊天保护] 检查失败，按原样放行', err);
        return origFetch.call(P, input, init);
      },
    );
  }

  function destroy() {
    if (P.fetch === guardedFetch) P.fetch = origFetch;
    if (P[GLOBAL_KEY]?.fetch === guardedFetch) delete P[GLOBAL_KEY];
    if (pending) flushPending().catch(() => {});
  }

  P.fetch = guardedFetch;
  P[GLOBAL_KEY] = { destroy, origFetch, fetch: guardedFetch };
  $(window).on('pagehide', destroy);

  eventOn(tavern_events.CHAT_CHANGED, () => setTimeout(onChatChanged, 0));
  eventOn(tavern_events.MESSAGE_DELETED, onMessageDeleted);
  // 入口放在「扩展」面板里正则设置的下面，不占 QR 按钮
  try {
    replaceScriptButtons([]);
  } catch {
    /* ignore */
  }
  function mountEntry() {
    const doc = P.document;
    if (doc.getElementById(ENTRY_ID)) return true;
    const regex = doc.querySelector('.regex_settings');
    if (!regex) return false;
    const box = doc.createElement('div');
    box.id = ENTRY_ID;
    box.innerHTML = `
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>聊天保护</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content cg-body"></div>
      </div>`;
    const style = doc.createElement('style');
    style.textContent = PANEL_CSS;
    box.prepend(style);
    box.querySelector('.cg-body').addEventListener('click', onPanelClick);
    box.querySelector('.cg-body').addEventListener('change', onPanelChange);
    box.querySelector('.inline-drawer-toggle').addEventListener('click', () => setTimeout(requestRender, 50));
    regex.after(box);
    return true;
  }
  let mountTries = 0;
  const mountTimer = setInterval(() => {
    if (mountEntry() || ++mountTries > 60) clearInterval(mountTimer);
  }, 500);
  mountEntry();
  $(window).on('pagehide', () => {
    clearInterval(mountTimer);
    P.document.getElementById(ENTRY_ID)?.remove();
  });

  onChatChanged();
  console.info('[聊天保护] 已启用');
})();
