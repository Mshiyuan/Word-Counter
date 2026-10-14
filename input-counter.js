// 输入计数：输入框实时 Token + 字数，以及每个楼层的 Token + 字数
// 作者：时鸢
// 运行环境：酒馆助手（Tavern Helper）脚本。脚本跑在 iframe 里，UI 挂在父文档（酒馆主页面）上。
// 不改动酒馆源码，只读输入框和聊天记录的内容，用酒馆自己的分词器算 token。
$(() => {
  const mainWin = (() => { try { return window.parent && window.parent.document ? window.parent : window; } catch (e) { return window; } })();
  const mainDoc = mainWin.document;

  const SCRIPT_ID = 'input-counter';
  const BUTTON_NAME = '输入计数';
  const LS_ENABLED = `${SCRIPT_ID}:enabled`;
  const LS_POS = `${SCRIPT_ID}:pos`;
  const LS_COLLAPSED = `${SCRIPT_ID}:collapsed`;
  const BADGE_ID = `${SCRIPT_ID}-badge`;
  const STYLE_ID = `${SCRIPT_ID}-style`;
  const MES_CLASS = `${SCRIPT_ID}-mes`;
  const MES_ON_CLASS = `${SCRIPT_ID}-mes-on`;
  const TOKEN_DEBOUNCE_MS = 350;
  const POLL_MS = 500;
  const MES_POLL_MS = 1000;

  // ---------- 本地存储 ----------
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) {} };
  let enabled = lsGet(LS_ENABLED) !== '0';

  // ---------- 字数 ----------
  // 中文按"字"算（汉字、假名、韩文、全角标点各算 1），英文/数字按"词"算（连续一串算 1），和 Word 的字数口径一致。
  const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯　-〿＀-￯]/g;
  const WORD_RE = /[A-Za-z0-9À-ɏ]+(?:['’.\-][A-Za-z0-9À-ɏ]+)*/g;
  function countWords(text) {
    if (!text) return { words: 0, chars: 0, charsNoSpace: 0 };
    const cjk = (text.match(CJK_RE) || []).length;
    const latin = (text.replace(CJK_RE, ' ').match(WORD_RE) || []).length;
    const chars = Array.from(text).length;
    const charsNoSpace = Array.from(text.replace(/\s/g, '')).length;
    return { words: cjk + latin, chars, charsNoSpace };
  }

  // ---------- Token ----------
  // 用酒馆当前选中的分词器（跟随 API/模型设置），和酒馆自己显示的 token 口径一致。
  function getCtx() {
    try { return mainWin.SillyTavern?.getContext?.() || null; } catch (e) { return null; }
  }
  async function countTokens(text) {
    if (!text) return { value: 0, estimated: false };
    const ctx = getCtx();
    try {
      if (ctx && typeof ctx.getTokenCountAsync === 'function') {
        return { value: await ctx.getTokenCountAsync(text), estimated: false };
      }
      if (ctx && typeof ctx.getTokenCount === 'function') {
        return { value: ctx.getTokenCount(text), estimated: false };
      }
    } catch (e) {
      console.warn(`[${SCRIPT_ID}] token 计算失败，改用估算`, e);
    }
    // 兜底估算：中日韩字符约 1 token/字，其余约 4 字符/token
    const cjk = (text.match(CJK_RE) || []).length;
    const rest = Array.from(text).length - cjk;
    return { value: Math.ceil(cjk + rest / 4), estimated: true };
  }
  const fmtTokens = (r) => `${r.estimated ? '≈' : ''}${r.value}`;

  // ---------- 样式 ----------
  function injectStyle() {
    mainDoc.getElementById(STYLE_ID)?.remove();
    const style = mainDoc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      /* 输入框标签：外层只管定位/拖动/按压，里面是"胶囊"和"球"两层，叠在同一个位置互相切换。
         动画只用 transform + opacity；展开带回弹，收起干脆利落。 */
      #${BADGE_ID} {
        position: fixed;
        z-index: 3000;
        height: 24px;
        font-size: 12px;
        line-height: 18px;
        font-family: var(--mainFontFamily, inherit);
        color: var(--SmartThemeBodyColor, #ddd);
        cursor: grab;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
        -webkit-tap-highlight-color: transparent;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
        transition: transform 140ms ease-out;
      }
      #${BADGE_ID}.ic-pressed { transform: scale(0.92); }
      #${BADGE_ID}.ic-dragging { cursor: grabbing; transform: scale(1.04); }
      #${BADGE_ID}[hidden] { display: none; }
      #${BADGE_ID} .ic-panel,
      #${BADGE_ID} .ic-ball {
        box-sizing: border-box;
        height: 24px;
        background: var(--SmartThemeBlurTintColor, rgba(0, 0, 0, 0.55));
        border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.15));
        backdrop-filter: blur(var(--SmartThemeBlurStrength, 6px));
        -webkit-backdrop-filter: blur(var(--SmartThemeBlurStrength, 6px));
        will-change: transform, opacity;
      }
      #${BADGE_ID} .ic-panel {
        display: flex;
        gap: 8px;
        align-items: center;
        padding: 2px 9px;
        border-radius: 12px;
        transform-origin: calc(100% - 12px) 50%;
        transform: scale(1);
        opacity: 0.88;
        transition: transform 420ms cubic-bezier(0.68, -0.6, 0.32, 1.6), opacity 180ms ease-out;
      }
      #${BADGE_ID} .ic-ball {
        position: absolute;
        top: 0;
        right: 0;
        width: 24px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        transform: scale(0.3);
        opacity: 0;
        pointer-events: none;
        transition: transform 200ms cubic-bezier(0.4, 0, 0.2, 1), opacity 140ms ease-in;
      }
      #${BADGE_ID} .ic-ball::after {
        content: '';
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--SmartThemeQuoteColor, #e18a24);
        opacity: 0.85;
      }
      /* 收起：胶囊往右侧的球心缩没，球弹出来 */
      #${BADGE_ID}.ic-collapsed .ic-panel {
        position: absolute;
        top: 0;
        right: 0;
        transform: scale(0.12);
        opacity: 0;
        pointer-events: none;
        transition: transform 220ms cubic-bezier(0.4, 0, 0.2, 1), opacity 160ms ease-in;
      }
      #${BADGE_ID}.ic-collapsed .ic-ball {
        position: static;
        transform: scale(1);
        opacity: 0.88;
        pointer-events: auto;
        transition: transform 420ms cubic-bezier(0.68, -0.6, 0.32, 1.6), opacity 180ms ease-out;
      }
      #${BADGE_ID} .ic-pending { opacity: 0.5; }
      /* 楼层计数：和输入框标签同一套横排胶囊样式，缩小一号，靠右放在正文下面 */
      .${MES_CLASS} {
        display: flex;
        justify-content: flex-end;
        margin-top: 4px;
        pointer-events: none;
      }
      .${MES_CLASS} .ic-pill {
        display: inline-flex;
        gap: 7px;
        padding: 1px 8px;
        border-radius: 9px;
        font-size: 11px;
        line-height: 16px;
        color: var(--SmartThemeBodyColor, #ddd);
        background: var(--SmartThemeBlurTintColor, rgba(0, 0, 0, 0.35));
        border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.12));
        opacity: 0.55;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
        pointer-events: auto;
      }
      .${MES_CLASS}.ic-pending .ic-tokens { opacity: 0.5; }
      /* 楼层计数开启时，把酒馆自带的（过往楼层常是 0 的）token 显示藏起来，避免两个数打架 */
      body.${MES_ON_CLASS} #chat .mes .tokenCounterDisplay { display: none !important; }
    `;
    mainDoc.head.appendChild(style);
  }

  // =====================================================================
  //  一、输入框悬浮标签（可拖动）
  // =====================================================================
  function getBadge() {
    let badge = mainDoc.getElementById(BADGE_ID);
    if (!badge) {
      badge = mainDoc.createElement('div');
      badge.id = BADGE_ID;
      badge.innerHTML = '<div class="ic-panel"><span class="ic-tokens">Token 0</span><span class="ic-words">字数 0</span></div><div class="ic-ball"></div>';
      badge.classList.toggle('ic-collapsed', collapsed);
      mainDoc.body.appendChild(badge);
      bindDrag(badge);
    }
    return badge;
  }

  // 拖过就记住位置（按视口比例存，横竖屏切换也不会跑出屏幕）；长按恢复默认位置
  const loadPos = () => { try { return JSON.parse(lsGet(LS_POS) || 'null'); } catch (e) { return null; } };
  let savedPos = loadPos();
  let collapsed = lsGet(LS_COLLAPSED) === '1';

  function clampToViewport(badge, left, top) {
    const bw = badge.offsetWidth;
    const bh = badge.offsetHeight;
    return {
      left: Math.max(2, Math.min(left, mainWin.innerWidth - bw - 2)),
      top: Math.max(2, Math.min(top, mainWin.innerHeight - bh - 2)),
    };
  }

  function savePosFrom(badge) {
    const rect = badge.getBoundingClientRect();
    savedPos = { x: rect.left / mainWin.innerWidth, y: rect.top / mainWin.innerHeight };
    lsSet(LS_POS, JSON.stringify(savedPos));
  }

  function positionBadge() {
    const badge = mainDoc.getElementById(BADGE_ID);
    if (!badge || badge.hidden || badge.classList.contains('ic-dragging')) return;
    let left, top;
    if (savedPos) {
      left = savedPos.x * mainWin.innerWidth;
      top = savedPos.y * mainWin.innerHeight;
    } else {
      // 默认：贴在输入框右上角外侧
      const anchor = mainDoc.getElementById('send_form') || mainDoc.getElementById('send_textarea');
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      left = rect.right - badge.offsetWidth - 6;
      top = rect.top - badge.offsetHeight - 4;
    }
    const p = clampToViewport(badge, left, top);
    badge.style.left = `${p.left}px`;
    badge.style.top = `${p.top}px`;
  }

  // 点一下在"胶囊"和"球"之间切换。球固定在胶囊右端，切换时保持右边缘不动，看起来就是原地缩放。
  function toggleCollapsed(badge) {
    const before = badge.offsetLeft + badge.offsetWidth;
    collapsed = !collapsed;
    lsSet(LS_COLLAPSED, collapsed ? '1' : '0');
    badge.classList.toggle('ic-collapsed', collapsed);
    if (savedPos) {
      badge.style.left = `${badge.offsetLeft + before - (badge.offsetLeft + badge.offsetWidth)}px`;
      const p = clampToViewport(badge, badge.offsetLeft, badge.offsetTop);
      badge.style.left = `${p.left}px`;
      savePosFrom(badge);
    }
    positionBadge();
  }

  function bindDrag(badge) {
    let start = null;
    let pressTimer = null;
    badge.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      const rect = badge.getBoundingClientRect();
      start = { id: e.pointerId, dx: e.clientX - rect.left, dy: e.clientY - rect.top, x: e.clientX, y: e.clientY, moved: false, longPressed: false };
      try { badge.setPointerCapture(e.pointerId); } catch (err) {}
      badge.classList.add('ic-pressed');
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => {
        if (!start || start.moved) return;
        start.longPressed = true;
        badge.classList.remove('ic-pressed');
        savedPos = null;
        lsDel(LS_POS);
        positionBadge();
        if (typeof toastr !== 'undefined') toastr.info('计数标签已回到默认位置', '', { timeOut: 1200 });
      }, 650);
      e.preventDefault();
    });
    badge.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== start.id || start.longPressed) return;
      if (!start.moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5) return;
      start.moved = true;
      clearTimeout(pressTimer);
      badge.classList.remove('ic-pressed');
      badge.classList.add('ic-dragging');
      const p = clampToViewport(badge, e.clientX - start.dx, e.clientY - start.dy);
      badge.style.left = `${p.left}px`;
      badge.style.top = `${p.top}px`;
    });
    const end = (e) => {
      if (!start || e.pointerId !== start.id) return;
      clearTimeout(pressTimer);
      try { badge.releasePointerCapture(e.pointerId); } catch (err) {}
      badge.classList.remove('ic-pressed', 'ic-dragging');
      if (start.moved) savePosFrom(badge);
      else if (!start.longPressed && e.type === 'pointerup') toggleCollapsed(badge);
      start = null;
      positionBadge();
    };
    badge.addEventListener('pointerup', end);
    badge.addEventListener('pointercancel', end);
  }

  // ---------- 输入框计数 ----------
  let lastText = null;
  let tokenTimer = null;
  let tokenSeq = 0;

  function updateInput(force = false) {
    if (!enabled) return;
    const ta = mainDoc.getElementById('send_textarea');
    if (!ta) return;
    const text = ta.value || '';
    if (!force && text === lastText) { positionBadge(); return; }
    lastText = text;

    const badge = getBadge();
    const w = countWords(text);
    badge.querySelector('.ic-words').textContent = `字数 ${w.words}`;
    badge.title = `字数 ${w.words}｜字符 ${w.chars}（不含空白 ${w.charsNoSpace}）\n点击收起/展开，拖动可移动，长按回到默认位置`;

    // 字数是即时的；token 要调分词器（可能走后端），防抖后再算，期间先把旧数字变淡
    const tokEl = badge.querySelector('.ic-tokens');
    tokEl.classList.add('ic-pending');
    clearTimeout(tokenTimer);
    const seq = ++tokenSeq;
    tokenTimer = setTimeout(async () => {
      const r = await countTokens(text);
      if (seq !== tokenSeq) return; // 期间又输入了，丢弃过期结果
      tokEl.textContent = `Token ${fmtTokens(r)}`;
      tokEl.classList.remove('ic-pending');
      positionBadge();
    }, text ? TOKEN_DEBOUNCE_MS : 0);

    positionBadge();
  }

  // =====================================================================
  //  二、楼层计数：每条消息都显示 Token + 字数（包括很早以前的楼层）
  // =====================================================================
  // 文本 → token 结果的缓存，同样的内容不重复算
  const tokenCache = new Map();
  // 每个楼层元素上次算的是哪段文本；文本变了（编辑、切换 swipe、流式输出）就重算
  const mesTextOf = new WeakMap();
  // token 计算排队一个一个来，几百层的老聊天也不会一下子把后端打满
  const queue = [];
  let queueRunning = false;

  function getMesText(mesEl) {
    const id = Number(mesEl.getAttribute('mesid'));
    const ctx = getCtx();
    const msg = ctx?.chat?.[id];
    if (msg && typeof msg.mes === 'string') return msg.mes;
    return mesEl.querySelector('.mes_text')?.innerText || '';
  }

  function getMesLabel(mesEl) {
    let label = mesEl.querySelector(`.${MES_CLASS}`);
    if (label) return label;
    label = mainDoc.createElement('div');
    label.className = MES_CLASS;
    label.innerHTML = '<span class="ic-pill"><span class="ic-tokens"></span><span class="ic-words"></span></span>';
    // 放在正文下面靠右；找不到正文就放到名字那一行
    const mesText = mesEl.querySelector('.mes_text');
    const slot = mesEl.querySelector('.ch_name');
    if (mesText) mesText.after(label);
    else if (slot) slot.appendChild(label);
    else return null;
    return label;
  }

  function renderMesLabel(label, text, tokens) {
    const w = countWords(text);
    label.querySelector('.ic-tokens').textContent = `Token ${tokens ?? '…'}`;
    label.querySelector('.ic-words').textContent = `字数 ${w.words}`;
    label.title = `Token ${tokens ?? '计算中'}｜字数 ${w.words}｜字符 ${w.chars}`;
    label.classList.toggle('ic-pending', tokens == null);
  }

  async function runQueue() {
    if (queueRunning) return;
    queueRunning = true;
    try {
      while (queue.length && enabled) {
        const { el, text } = queue.shift();
        if (!el.isConnected || mesTextOf.get(el) !== text) continue; // 楼层没了或内容又变了
        let r = tokenCache.get(text);
        if (!r) {
          r = await countTokens(text);
          if (!r.estimated) {
            if (tokenCache.size > 3000) tokenCache.clear(); // 流式输出会留下很多中间文本，别让缓存无限长
            tokenCache.set(text, r);
          }
        }
        if (!el.isConnected || mesTextOf.get(el) !== text) continue;
        const label = getMesLabel(el);
        if (label) renderMesLabel(label, text, fmtTokens(r));
      }
    } finally {
      queueRunning = false;
    }
  }

  function scanMessages() {
    if (!enabled) return;
    const els = mainDoc.querySelectorAll('#chat .mes[mesid]');
    // 从最新的楼层往前排，先算眼前能看到的
    for (let i = els.length - 1; i >= 0; i--) {
      const el = els[i];
      const text = getMesText(el);
      if (mesTextOf.get(el) === text && el.querySelector(`.${MES_CLASS}`)) continue;
      mesTextOf.set(el, text);
      const label = getMesLabel(el);
      if (!label) continue;
      const cached = tokenCache.get(text);
      if (!text) renderMesLabel(label, text, '0');
      else if (cached) renderMesLabel(label, text, fmtTokens(cached));
      else {
        renderMesLabel(label, text, null);
        queue.push({ el, text });
      }
    }
    runQueue();
  }

  function clearMessageLabels() {
    queue.length = 0;
    mainDoc.querySelectorAll(`.${MES_CLASS}`).forEach((n) => n.remove());
  }

  // =====================================================================
  //  开关
  // =====================================================================
  const toast = (msg) => { if (typeof toastr !== 'undefined') toastr.info(msg, '', { timeOut: 1200 }); };

  // 一个开关同时管输入框标签和楼层计数
  function setEnabled(v) {
    enabled = v;
    lsSet(LS_ENABLED, v ? '1' : '0');
    getBadge().hidden = !v;
    mainDoc.body.classList.toggle(MES_ON_CLASS, v);
    if (v) { updateInput(true); scanMessages(); } else clearMessageLabels();
    toast(v ? '计数已开启' : '计数已关闭');
  }

  // ---------- 事件 ----------
  // input 事件管手动输入；轮询兜底管程序改值（发送后清空、QR 填入、切换聊天等，这些不会触发 input）
  const onInput = () => updateInput();
  const onResize = () => positionBadge();
  function bindTextarea() {
    const ta = mainDoc.getElementById('send_textarea');
    if (!ta || ta.dataset.icBound === '1') return;
    ta.dataset.icBound = '1';
    ta.addEventListener('input', onInput);
  }
  function unbindTextarea() {
    const ta = mainDoc.getElementById('send_textarea');
    if (!ta) return;
    ta.removeEventListener('input', onInput);
    delete ta.dataset.icBound;
  }

  const pollTimer = setInterval(() => {
    bindTextarea();
    updateInput();
  }, POLL_MS);
  const mesPollTimer = setInterval(scanMessages, MES_POLL_MS);
  mainWin.addEventListener('resize', onResize);

  // ---------- 酒馆助手脚本按钮（显示在 QR 栏） ----------
  function setupButton() {
    const buttons = [{ name: BUTTON_NAME, visible: true }];
    try {
      if (typeof appendInexistentScriptButtons === 'function') appendInexistentScriptButtons(buttons);
      else if (typeof replaceScriptButtons === 'function') replaceScriptButtons(buttons);
    } catch (e) {
      console.warn(`[${SCRIPT_ID}] 创建脚本按钮失败`, e);
    }
    try {
      if (typeof eventOn === 'function' && typeof getButtonEvent === 'function') {
        eventOn(getButtonEvent(BUTTON_NAME), () => setEnabled(!enabled));
      }
    } catch (e) {
      console.warn(`[${SCRIPT_ID}] 绑定脚本按钮失败`, e);
    }
  }

  // ---------- 清理：脚本被关闭/重载时把父文档里的东西拆干净 ----------
  function cleanup() {
    unbindTextarea();
    mainDoc.getElementById(BADGE_ID)?.remove();
    mainDoc.getElementById(STYLE_ID)?.remove();
    mainDoc.querySelectorAll(`.${MES_CLASS}`).forEach((n) => n.remove());
    mainDoc.body.classList.remove(MES_ON_CLASS);
  }
  $(window).on('pagehide', () => {
    clearInterval(pollTimer);
    clearInterval(mesPollTimer);
    clearTimeout(tokenTimer);
    queue.length = 0;
    mainWin.removeEventListener('resize', onResize);
    cleanup();
  });

  // ---------- 启动 ----------
  cleanup(); // 上一个实例如果没清理干净（热重载），先拆掉残留
  injectStyle();
  getBadge().hidden = !enabled;
  mainDoc.body.classList.toggle(MES_ON_CLASS, enabled);
  bindTextarea();
  setupButton();
  updateInput(true);
  scanMessages();
});
