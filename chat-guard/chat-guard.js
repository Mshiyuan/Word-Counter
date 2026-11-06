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
    snapshots: true, // 是否保存快照
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
  let selfReloadUntil = 0; // 在这之前的坏保存是我们自己重新载入造成的
  let lastChatChangedTs = 0;
  let restoringId = null;

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
    if (!settings.snapshots) return false;
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
    if (now < selfReloadUntil) {
      // 是我们自己在重新载入聊天，载入途中的空保存直接挡掉，不打扰
      console.info('[聊天保护] 载入途中的空保存已挡下');
      return;
    }
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
    if (settings.autoRestore) setTimeout(() => maybeAutoReload(b.key, now), 1500);
  }

  async function maybeAutoReload(key, blockTs) {
    if (currentKey() !== key) return;
    if (lastChatChangedTs > blockTs) return; // 酒馆自己已经载入完了
    const e = expected[key];
    if (!isBadDrop(e, ctx().chat.length)) return; // ST 自己已经重新读回来了
    const now = Date.now();
    if (now - autoReloads.ts > 60000) autoReloads = { ts: now, count: 0 };
    if (autoReloads.count >= 3) return;
    autoReloads.count++;
    selfReloadUntil = Date.now() + 15000;
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
    lastChatChangedTs = Date.now();
    selfReloadUntil = Math.min(selfReloadUntil, Date.now() + 1000);
    requestRender();
    const key = currentKey();
    if (!key) return;
    const c = ctx();
    const n = c.chat.length;
    const e = expected[key];

    if (isBadDrop(e, n)) {
      // 硬盘上的文件可能已经被写坏了
      const latest = settings.snapshots ? await get(key + '|L') : null;
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
        if (!settings.snapshots || currentKey() !== key || ctx().chat.length !== n) return;
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
    if (restoringId) return false;
    restoringId = rec.id;
    requestRender();
    if (!silent) notify.info('正在恢复…', '聊天保护', { timeOut: 1500 });
    try {
      // 先把现在的最新完好版留进历史（后台进行，不耽误恢复）
      if (settings.snapshots) enqueue(() => rotateToHistory(rec.key, '恢复前'));
      // 直接用存好的原文写回，不再整份解析/重新序列化，大聊天也不卡
      let text = await gunzip(rec.blob);
      if (/"force":(true|false)/.test(text)) text = text.replace(/"force":(true|false)/, '"force":true');
      else text = '{"force":true,' + text.slice(1);
      const res = await origFetch.call(P, rec.url, {
        method: 'POST',
        cache: 'no-cache',
        headers: ctx().getRequestHeaders(),
        body: text,
      });
      if (!res.ok) {
        notify.error('恢复失败：' + res.status, '聊天保护');
        return false;
      }
      setExpected(rec.key, rec.n);
      prevFp.delete(rec.key);
      if (rec.key === currentKey()) {
        selfReloadUntil = Date.now() + 15000;
        await ctx().reloadCurrentChat();
      }
      notify.success(`已恢复到 ${fmtTime(rec.ts)} 的版本（${rec.n} 楼）`, silent ? '聊天保护：自动恢复' : '聊天保护');
      return true;
    } finally {
      restoringId = null;
      requestRender();
    }
  }

  // ---------- 面板（直接放在「扩展」里正则下面的下拉框中） ----------
  const fmtShort = ts => {
    const d = new Date(ts);
    const hm = d.toTimeString().slice(0, 5);
    return d.toDateString() === new Date().toDateString() ? '今天 ' + hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  };
  // 颜色全部取自酒馆主题变量，跟随美化变化
  const PANEL_CSS = `
    #${ENTRY_ID} .cg{
      --cg-fg: var(--SmartThemeBodyColor, #555);
      --cg-c1: rgba(127,127,127,.08); --cg-c2: rgba(127,127,127,.14); --cg-c3: rgba(127,127,127,.22);
      --cg-muted: rgba(127,127,127,.95); --cg-line: rgba(127,127,127,.55);
      --cg-shadow: var(--SmartThemeShadowColor, rgba(0,0,0,.15));
      --cg-spring: cubic-bezier(0.16, 1, 0.3, 1);
      display:flex;flex-direction:column;gap:8px;padding:6px 0 4px;color:var(--cg-fg);text-align:left;
    }
    @supports (color: color-mix(in srgb, red 50%, blue)) {
      #${ENTRY_ID} .cg{
        --cg-c1: color-mix(in srgb, var(--cg-fg) 6%, transparent);
        --cg-c2: color-mix(in srgb, var(--cg-fg) 11%, transparent);
        --cg-c3: color-mix(in srgb, var(--cg-fg) 17%, transparent);
        --cg-muted: color-mix(in srgb, var(--cg-fg) 62%, transparent);
        --cg-line: color-mix(in srgb, var(--cg-fg) 55%, transparent);
      }
    }
    @supports (animation-timing-function: linear(0, 1)) {
      #${ENTRY_ID} .cg{ --cg-spring: linear(0, 0.038, 0.119, 0.226, 0.355, 0.475, 0.588, 0.699, 0.786, 0.859, 0.922, 0.967, 0.999, 1.024, 1.038, 1.045, 1.048, 1.047, 1.043, 1.038, 1.032, 1.026, 1.02, 1.015, 1.011, 1.007, 1.004, 1.002, 1, 0.999, 0.998, 0.998, 0.998, 0.998, 0.998, 0.998, 0.998, 0.999, 0.999, 0.999, 1); }
    }
    #${ENTRY_ID} .cg *{box-sizing:border-box}
    @keyframes cg-pop{from{opacity:0;transform:translateY(28px) scale(.94)}to{opacity:1;transform:none}}
    #${ENTRY_ID} .cg-pop{animation:cg-pop 820ms var(--cg-spring) both}
    #${ENTRY_ID} .cg-leave{opacity:0 !important;transform:translateY(8px) scale(.98) !important;
      transition:opacity 220ms cubic-bezier(.4,0,1,1), transform 220ms cubic-bezier(.4,0,1,1) !important}
    #${ENTRY_ID} .cg-switch{position:relative;flex-shrink:0;width:36px;height:21px;border-radius:999px;background:var(--cg-c3);cursor:pointer;
      transition:background .25s ease}
    #${ENTRY_ID} .cg-switch i{position:absolute;top:2.5px;left:2.5px;width:16px;height:16px;border-radius:50%;
      background:var(--SmartThemeBlurTintColor, #fff);box-shadow:0 1px 3px var(--cg-shadow);transition:transform 600ms var(--cg-spring)}
    #${ENTRY_ID} .cg-switch.cg-on{background:var(--cg-line)}
    #${ENTRY_ID} .cg-switch.cg-on i{transform:translateX(15px)}
    #${ENTRY_ID} .cg-sec-r{display:flex;align-items:center;gap:8px}
    #${ENTRY_ID} .cg-alert{touch-action:pan-y;user-select:none;will-change:transform}
    #${ENTRY_ID} .cg-x{flex-shrink:0;color:var(--cg-muted);font-size:.8em;padding:3px 5px;border-radius:8px;cursor:pointer}
    #${ENTRY_ID} .cg-x:hover{color:var(--cg-fg);background:var(--cg-c2)}
    #${ENTRY_ID} .cg-busy{opacity:.55;pointer-events:none}
    #${ENTRY_ID} .cg-off{color:var(--cg-muted);font-size:.8em;padding:0 2px}
    #${ENTRY_ID} .cg-card{background:var(--cg-c1);border-radius:12px;padding:9px 12px;border:1.5px solid transparent;
      transition:background .2s ease, border-color .2s ease, transform .18s cubic-bezier(.34,1.56,.64,1)}
    #${ENTRY_ID} .cg-hero{display:flex;align-items:center;gap:10px}
    #${ENTRY_ID} .cg-grow{flex:1;min-width:0}
    #${ENTRY_ID} .cg-t{font-weight:600;font-size:.95em;line-height:1.4}
    #${ENTRY_ID} .cg-sub{color:var(--cg-muted);font-size:.8em;line-height:1.45;margin-top:1px;overflow:hidden;text-overflow:ellipsis}
    #${ENTRY_ID} .cg-nowrap{white-space:nowrap}
    #${ENTRY_ID} .cg-pill{flex-shrink:0;white-space:nowrap;border-radius:999px;background:var(--cg-c2);padding:2px 10px;font-size:.8em;
      display:inline-flex;align-items:center;gap:6px;user-select:none}
    #${ENTRY_ID} .cg-btn{cursor:pointer;transition:background .2s ease, transform .18s cubic-bezier(.34,1.56,.64,1)}
    #${ENTRY_ID} .cg-btn:hover{background:var(--cg-c3)}
    #${ENTRY_ID} .cg-btn:active{transform:scale(.94)}
    #${ENTRY_ID} .cg-sec{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 2px 0}
    #${ENTRY_ID} .cg-sec-t{color:var(--cg-muted);font-size:.82em}
    #${ENTRY_ID} .cg-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
    #${ENTRY_ID} .cg-snap{position:relative;cursor:pointer;display:flex;flex-direction:column;padding:9px 11px}
    #${ENTRY_ID} .cg-snap:hover{background:var(--cg-c2)}
    #${ENTRY_ID} .cg-snap:active{transform:scale(.97)}
    #${ENTRY_ID} .cg-snap.cg-on{border-color:var(--cg-line);background:var(--cg-c2)}
    #${ENTRY_ID} .cg-snap .cg-t{padding-right:16px}
    #${ENTRY_ID} .cg-check{position:absolute;top:10px;right:11px;font-size:.75em}
    #${ENTRY_ID} .cg-tags{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-top:auto;padding-top:6px}
    #${ENTRY_ID} .cg-tag{background:var(--cg-c2);border-radius:999px;padding:0 7px;font-size:.72em;color:var(--cg-muted);white-space:nowrap}
    #${ENTRY_ID} .cg-trash{margin-left:auto;font-size:.8em;color:var(--cg-muted);padding:3px 5px;border-radius:8px;cursor:pointer;transition:color .2s, background .2s}
    #${ENTRY_ID} .cg-trash:hover{color:var(--cg-fg);background:var(--cg-c2)}
    #${ENTRY_ID} .cg-add{grid-column:1 / -1;display:flex;align-items:center;justify-content:center;gap:6px;min-height:0;padding:12px;
      background:transparent;border:2px dashed var(--cg-c3);color:var(--cg-muted);cursor:pointer;font-size:.9em}
    #${ENTRY_ID} .cg-add:hover{color:var(--cg-fg);border-color:var(--cg-line)}
    #${ENTRY_ID} .cg-empty{grid-column:1 / -1;color:var(--cg-muted);font-size:.8em;text-align:center;padding:10px}
    #${ENTRY_ID} .cg-opt + .cg-opt{margin-top:10px}
    #${ENTRY_ID} .cg-opt .cg-sub{margin-bottom:5px}
    #${ENTRY_ID} .cg-seg{display:flex;gap:3px;padding:3px;border-radius:10px;background:var(--cg-c1)}
    #${ENTRY_ID} .cg-seg-i{flex:1;text-align:center;white-space:nowrap;padding:3px 4px;border-radius:8px;font-size:.85em;cursor:pointer;color:var(--cg-muted);
      transition:background .25s ease, color .25s ease, box-shadow .25s ease, transform .18s cubic-bezier(.34,1.56,.64,1)}
    #${ENTRY_ID} .cg-seg-i:active{transform:scale(.94)}
    #${ENTRY_ID} .cg-seg-i.cg-on{color:var(--cg-fg);font-weight:700;background:var(--SmartThemeBlurTintColor, var(--cg-c3));box-shadow:0 1px 3px var(--cg-shadow)}
  `;
  let renderTimer = null;
  let snapAnim = false;
  let alertShownTs = 0;
  function panelBody() {
    return P.document.querySelector('#' + ENTRY_ID + ' .cg-body');
  }
  function requestRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      if (dragging) return requestRender();
      render().catch(e => console.warn('[聊天保护] 面板刷新失败', e));
    }, 300);
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

    const anim = snapAnim;
    snapAnim = false;
    const pop = () => (anim ? 'cg-pop' : '');
    const delay = i => (anim ? `animation-delay:${i * 45}ms` : '');
    const card = (r, isLatest, i = 0) => `
      <div class="${pop(i)} cg-card cg-snap ${isLatest ? 'cg-on' : ''} ${restoringId ? 'cg-busy' : ''}" style="${delay(i)}" data-act="restore" data-id="${esc(r.id)}">
        ${isLatest ? '<i class="fa-solid fa-check cg-check"></i>' : ''}
        <div class="cg-t">${isLatest ? '最新完好版' : esc(r.reason || '历史版本')}</div>
        <div class="cg-sub">${restoringId === r.id ? '恢复中…' : fmtShort(r.ts) + (isLatest ? ' · 推荐恢复' : '')}</div>
        <div class="cg-tags">
          <span class="cg-tag">${r.n} 楼</span><span class="cg-tag">${fmtSize(r.size)}</span>
          ${isLatest ? '' : `<i class="fa-solid fa-trash-can cg-trash" data-act="del" data-id="${esc(r.id)}" title="删除"></i>`}
        </div>
      </div>`;
    const seg = (k, opts, cur) => `
      <div class="cg-seg">${opts
        .map(([v, label]) => `<div class="cg-seg-i ${String(v) === String(cur) ? 'cg-on' : ''}" data-act="set" data-k="${k}" data-v="${v}">${label}</div>`)
        .join('')}</div>`;

    const bad = key && isBadDrop(e, n);
    const blocked = lastBlocked && lastBlocked.key === key;
    const hero = `
      <div class="cg-card cg-hero">
        <div class="cg-grow">
          <div class="cg-t">${!key ? '待命中' : bad ? '聊天不完整' : '保护中'}</div>
          <div class="cg-sub cg-nowrap">${
            !key ? '打开一个聊天后开始保护' : bad ? `记录是 ${e} 楼，点下面的快照恢复` : esc(currentTitle())
          }</div>
        </div>
        ${key ? `<span class="cg-pill">${n} 楼</span>` : ''}
      </div>`;
    const alertNew = blocked && lastBlocked.ts !== alertShownTs;
    if (blocked) alertShownTs = lastBlocked.ts;
    const alert = blocked
      ? `<div class="cg-card cg-hero cg-alert ${alertNew ? 'cg-pop' : ''}" style="border-color:var(--cg-line)">
           <div class="cg-grow">
             <div class="cg-t">挡下了一次坏保存</div>
             <div class="cg-sub">${fmtShort(lastBlocked.ts)} · ${lastBlocked.e} 楼 → ${lastBlocked.n} 楼 · 文件没被改动 · 右滑关闭</div>
           </div>
           <span class="cg-pill cg-btn" data-act="allow" title="如果这次是你有意删的楼，点这里放行">放行</span>
           <i class="fa-solid fa-xmark cg-x" data-act="dismiss" title="关闭"></i>
         </div>`
      : '';
    const cards = [];
    if (latest) cards.push(card(latest, true, 1));
    hist.forEach((h, i) => cards.push(card(h, false, i + (latest ? 2 : 1))));
    const snaps = key
      ? `<div class="cg-sec">
           <span class="cg-sec-t">快照</span>
           <span class="cg-sec-r">
             ${settings.snapshots ? `<span class="cg-pill cg-btn cg-snap-part ${pop()}" data-act="snap"><i class="fa-solid fa-plus"></i>存一份</span>` : ''}
             <span class="cg-switch ${settings.snapshots ? 'cg-on' : ''}" data-act="toggle-snap" title="保存快照"><i></i></span>
           </span>
         </div>
         ${
           settings.snapshots
             ? `<div class="cg-grid cg-snap-part">
                  ${
                    cards.length
                      ? cards.join('')
                      : `<div class="cg-card cg-empty ${pop()}" style="${delay(1)}">还没有快照，正常保存一次后会自动生成</div>`
                  }
                </div>`
             : '<div class="cg-off">快照已关闭，不再保存新快照（已有的会保留）。拦截坏保存不受影响。</div>'
         }`
      : '';
    const limits = [1, 3, 5, 10];
    if (!limits.includes(settings.historyLimit)) limits.push(settings.historyLimit), limits.sort((x, y) => x - y);
    const prefs = `
      <div class="cg-sec"><span class="cg-sec-t">设置</span></div>
      <div class="cg-card">
        <div class="cg-opt">
          <div class="cg-t">挡下坏保存后</div>
          <div class="cg-sub">文件本身不会被改动，只是选怎么让聊天回来</div>
          ${seg('autoRestore', [[1, '自动恢复'], [0, '只提示']], settings.autoRestore ? 1 : 0)}
        </div>
        <div class="cg-opt">
          <div class="cg-t">每个聊天保留历史</div>
          <div class="cg-sub">只在删很多楼、大面积改写、打开聊天时留底</div>
          ${seg('historyLimit', limits.map(v => [v, v + ' 份']), settings.historyLimit)}
        </div>
      </div>`;
    body.innerHTML = `<div class="cg">${hero}${alert}${snaps}${prefs}</div>`;
    const al = body.querySelector('.cg-alert');
    if (al) bindSwipe(al);
  }

  // 提示卡右滑关闭
  let dragging = false;
  let suppressClick = false;
  function dismissAlert(el) {
    const h = el.offsetHeight;
    el.style.transition = 'transform 220ms cubic-bezier(.4,0,1,1), opacity 220ms cubic-bezier(.4,0,1,1)';
    el.style.transform = 'translateX(110%)';
    el.style.opacity = '0';
    setTimeout(() => {
      el.style.transition = 'height 200ms cubic-bezier(.4,0,.2,1), margin 200ms, padding 200ms';
      el.style.height = h + 'px';
      el.style.overflow = 'hidden';
      requestAnimationFrame(() => {
        el.style.height = '0px';
        el.style.paddingTop = el.style.paddingBottom = '0px';
        el.style.marginTop = '-8px';
        el.style.borderWidth = '0';
      });
      setTimeout(() => {
        lastBlocked = null;
        render();
      }, 210);
    }, 220);
  }
  function bindSwipe(el) {
    let x0 = 0, y0 = 0, dx = 0, active = false, horiz = null;
    el.addEventListener('pointerdown', ev => {
      if (ev.button > 0) return;
      active = true; horiz = null; dx = 0; x0 = ev.clientX; y0 = ev.clientY;
    });
    el.addEventListener('pointermove', ev => {
      if (!active) return;
      const mx = ev.clientX - x0, my = ev.clientY - y0;
      if (horiz === null && Math.abs(mx) + Math.abs(my) > 6) horiz = Math.abs(mx) > Math.abs(my);
      if (!horiz) return;
      if (!dragging) { dragging = true; try { el.setPointerCapture(ev.pointerId); } catch { /* ignore */ } }
      dx = Math.max(0, mx);
      el.style.transition = 'none';
      el.style.transform = `translateX(${dx}px)`;
      el.style.opacity = String(1 - Math.min(0.8, dx / el.offsetWidth));
    });
    const end = () => {
      if (!active) return;
      active = false;
      if (!dragging) return;
      dragging = false;
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 50);
      if (dx > el.offsetWidth * 0.35) dismissAlert(el);
      else {
        el.style.transition = 'transform 600ms var(--cg-spring), opacity 300ms ease';
        el.style.transform = '';
        el.style.opacity = '';
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  async function onPanelClick(ev) {
    if (suppressClick) return;
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (restoringId && act !== 'set') return;
    if (act === 'toggle-snap') {
      const on = !settings.snapshots;
      btn.classList.toggle('cg-on', on);
      if (on) {
        settings.snapshots = true;
        saveSettings();
        snapAnim = true;
        render();
        onChatChanged();
      } else {
        panelBody()?.querySelectorAll('.cg-snap-part').forEach(x => x.classList.add('cg-leave'));
        settings.snapshots = false;
        saveSettings();
        clearTimeout(pendingTimer);
        pending = null;
        setTimeout(render, 230);
      }
      return;
    }
    if (act === 'dismiss') {
      const el = btn.closest('.cg-alert');
      if (el) dismissAlert(el);
      return;
    }
    const id = btn.dataset.id;
    const key = currentKey();
    if (act === 'set') {
      const k = btn.dataset.k;
      const v = Number(btn.dataset.v);
      if (k === 'autoRestore') settings.autoRestore = v === 1;
      else if (k === 'historyLimit') settings.historyLimit = v;
      saveSettings();
      btn.parentElement.querySelectorAll('.cg-seg-i').forEach(x => x.classList.toggle('cg-on', x === btn));
      return;
    }
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
    box.querySelector('.cg-body').addEventListener('animationend', ev => {
      ev.target.classList.remove('cg-pop');
      ev.target.style.animationDelay = '';
    });
    box.querySelector('.inline-drawer-toggle').addEventListener('click', () =>
      setTimeout(() => {
        snapAnim = true;
        render().catch(() => {});
      }, 30),
    );
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
