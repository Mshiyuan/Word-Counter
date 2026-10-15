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
  const LS_SETTINGS = `${SCRIPT_ID}:settings`;
  const BADGE_ID = `${SCRIPT_ID}-badge`;
  const SETTINGS_ID = `${SCRIPT_ID}-settings`;
  const STYLE_ID = `${SCRIPT_ID}-style`;
  const MES_CLASS = `${SCRIPT_ID}-mes`;
  const MES_ON_CLASS = `${SCRIPT_ID}-mes-on`;
  const TOKEN_DEBOUNCE_MS = 350;
  const POLL_MS = 500;
  const MES_POLL_MS = 1000;
  const BADGE_LONG_PRESS_MS = 550; // 悬浮栏长按打开设置
  const LABEL_LONG_PRESS_MS = 380; // 楼层计数长按后才能拖，避免和聊天上下滚动冲突
  // 阻尼较大的弹簧（stiffness 170 / damping 18），只轻微过冲一次
  const SPRING_SOFT = 'linear(0, 0.038, 0.119, 0.226, 0.355, 0.475, 0.588, 0.699, 0.786, 0.859, 0.922, 0.967, 0.999, 1.024, 1.038, 1.045, 1.048, 1.047, 1.043, 1.038, 1.032, 1.026, 1.02, 1.015, 1.011, 1.007, 1.004, 1.002, 1, 0.999, 0.998, 0.998, 0.998, 0.998, 0.998, 0.998, 0.998, 0.999, 0.999, 0.999, 1)';
  const EASE_POP = 'cubic-bezier(0.68, -0.6, 0.32, 1.6)';
  const EASE_BACK = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
  const EASE_OUT = 'cubic-bezier(0.4, 0, 0.2, 1)';

  // ---------- 本地存储 ----------
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) {} };
  let enabled = lsGet(LS_ENABLED) !== '0';

  // 设置：
  //   mode       'perFloor' 每层独立显示 / 'follow' 悬浮栏跟随当前楼层
  //   globalPos  拖动一层的计数，所有楼层跟着变
  //   splitRole  （globalPos 打开时）角色和用户分开记位置
  //   pos        全局位置 { all, user, char }；perMes 每层独立位置 { '聊天#楼层号': pos }
  //   位置格式   { h: 'left'|'right', x: px, v: 'top'|'bottom', y: px }，贴最近的两条边，楼层高矮不同也不会跑偏
  const DEFAULT_SETTINGS = { mode: 'perFloor', globalPos: true, splitRole: false, pos: { all: null, user: null, char: null }, perMes: {} };
  const settings = (() => {
    try {
      const s = JSON.parse(lsGet(LS_SETTINGS) || 'null') || {};
      return { ...DEFAULT_SETTINGS, ...s, pos: { ...DEFAULT_SETTINGS.pos, ...(s.pos || {}) }, perMes: s.perMes || {} };
    } catch (e) { return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); }
  })();
  const saveSettings = () => lsSet(LS_SETTINGS, JSON.stringify(settings));
  const isFollow = () => settings.mode === 'follow';

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

  // 文本 → token 结果的缓存，同样的内容不重复算
  const tokenCache = new Map();
  async function countTokensCached(text) {
    const hit = tokenCache.get(text);
    if (hit) return hit;
    const r = await countTokens(text);
    if (!r.estimated) {
      if (tokenCache.size > 3000) tokenCache.clear(); // 流式输出会留下很多中间文本，别让缓存无限长
      tokenCache.set(text, r);
    }
    return r;
  }

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
        -webkit-touch-callout: none;
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
        transition: transform 420ms ${EASE_POP}, opacity 180ms ease-out;
      }
      #${BADGE_ID} .ic-where { opacity: 0.6; }
      #${BADGE_ID} .ic-where:empty { display: none; }
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
        transition: transform 200ms ${EASE_OUT}, opacity 140ms ease-in;
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
        transition: transform 220ms ${EASE_OUT}, opacity 160ms ease-in;
      }
      #${BADGE_ID}.ic-collapsed .ic-ball {
        position: static;
        transform: scale(1);
        opacity: 0.88;
        pointer-events: auto;
        transition: transform 420ms ${EASE_POP}, opacity 180ms ease-out;
      }
      #${BADGE_ID} .ic-pending { opacity: 0.5; }

      /* 楼层计数：和输入框标签同一套横排胶囊样式，缩小一号，默认靠右放在正文下面 */
      .${MES_CLASS} {
        display: flex;
        justify-content: flex-end;
        margin-top: 4px;
        pointer-events: none;
      }
      .${MES_CLASS}.ic-abs {
        position: absolute;
        z-index: 5;
        display: block;
        margin: 0;
      }
      #chat .mes.ic-has-abs { position: relative; }
      .${MES_CLASS}.ic-dragging-label { z-index: 50; }
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
        user-select: none;
        -webkit-user-select: none;
        -webkit-touch-callout: none;
        -webkit-tap-highlight-color: transparent;
        transition: transform 600ms ${SPRING_SOFT}, opacity 200ms ease, box-shadow 200ms ease;
      }
      /* 长按后浮起：放大、变实、带阴影，表示可以拖了 */
      .${MES_CLASS}.ic-lifted .ic-pill {
        transform: scale(1.15);
        opacity: 1;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
        cursor: grabbing;
        transition: transform 420ms ${EASE_BACK}, opacity 120ms ease, box-shadow 200ms ease;
      }
      .${MES_CLASS}.ic-pending .ic-tokens { opacity: 0.5; }
      /* 楼层计数开启时，把酒馆自带的（过往楼层常是 0 的）token 显示藏起来，避免两个数打架 */
      body.${MES_ON_CLASS} #chat .mes .tokenCounterDisplay { display: none !important; }

      /* ---------- 设置浮窗 ---------- */
      /* ST 里 position: fixed 的层级会被压在聊天区后面；照书摘的做法，absolute 贴 body 铺满 + 超高 z-index
         （ST 的 body 本身不滚动，absolute 贴 body 视觉上等于固定） */
      #${SETTINGS_ID} {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100vh;
        height: 100dvh;
        box-sizing: border-box;
        z-index: 2147483630;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        font-family: var(--mainFontFamily, inherit);
        color: var(--SmartThemeBodyColor, #ddd);
        -webkit-tap-highlight-color: transparent;
      }
      #${SETTINGS_ID}[hidden] { display: none; }
      #${SETTINGS_ID} .ic-mask {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        opacity: 0;
        transition: opacity 180ms ease-in;
      }
      #${SETTINGS_ID} .ic-sheet {
        position: relative;
        width: min(360px, 100%);
        max-height: calc(100% - 32px);
        overflow-y: auto;
        box-sizing: border-box;
        padding: 16px 18px 18px;
        border-radius: 18px;
        background: var(--SmartThemeBlurTintColor, rgba(28, 28, 32, 0.92));
        border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.12));
        backdrop-filter: blur(calc(var(--SmartThemeBlurStrength, 10px) + 6px));
        -webkit-backdrop-filter: blur(calc(var(--SmartThemeBlurStrength, 10px) + 6px));
        box-shadow: 0 18px 50px rgba(0, 0, 0, 0.4);
        display: flex;
        flex-direction: column;
        gap: 14px;
        font-size: 14px;
        line-height: 1.5;
        transform: translateY(16px) scale(0.94);
        opacity: 0;
        transition: transform 180ms cubic-bezier(0.4, 0, 1, 1), opacity 150ms ease-in;
        will-change: transform, opacity;
      }
      #${SETTINGS_ID}.ic-open .ic-mask { opacity: 1; transition: opacity 220ms ease-out; }
      #${SETTINGS_ID}.ic-open .ic-sheet {
        transform: none;
        opacity: 1;
        transition: transform 720ms ${SPRING_SOFT}, opacity 200ms ease-out;
      }
      #${SETTINGS_ID} .ic-head { display: flex; align-items: center; justify-content: space-between; }
      #${SETTINGS_ID} .ic-head b { font-size: 16px; }
      #${SETTINGS_ID} .ic-group { display: flex; flex-direction: column; gap: 8px; }
      #${SETTINGS_ID} .ic-group[hidden] { display: none; }
      #${SETTINGS_ID} .ic-title { font-size: 12px; opacity: 0.6; letter-spacing: 0.04em; }
      #${SETTINGS_ID} .ic-note { margin: 0; font-size: 12.5px; opacity: 0.7; }
      #${SETTINGS_ID} .ic-note[hidden] { display: none; }
      #${SETTINGS_ID} button { font: inherit; color: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
      #${SETTINGS_ID} .ic-x {
        width: 30px; height: 30px; border-radius: 50%; border: 0; background: rgba(127, 127, 127, 0.18); font-size: 18px; line-height: 1;
        transition: transform 380ms ${EASE_BACK};
      }
      #${SETTINGS_ID} .ic-seg { position: relative; display: grid; grid-template-columns: 1fr 1fr; padding: 3px; border-radius: 12px; background: rgba(127, 127, 127, 0.16); }
      #${SETTINGS_ID} .ic-seg .ic-ind {
        position: absolute; top: 3px; bottom: 3px; left: 3px; width: calc(50% - 3px); border-radius: 9px;
        background: var(--SmartThemeQuoteColor, #e18a24); opacity: 0.9;
        transition: transform 520ms ${SPRING_SOFT};
      }
      #${SETTINGS_ID} .ic-seg[data-v="follow"] .ic-ind { transform: translateX(100%); }
      #${SETTINGS_ID} .ic-seg button { position: relative; border: 0; background: none; padding: 7px 4px; font-size: 13px; border-radius: 9px; }
      #${SETTINGS_ID} .ic-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 0; }
      #${SETTINGS_ID} .ic-row[hidden] { display: none; }
      #${SETTINGS_ID} .ic-row.ic-pop { animation: ic-spring-in 720ms ${SPRING_SOFT} both; }
      @keyframes ic-spring-in { from { opacity: 0; transform: translateY(-10px) scale(0.92); } to { opacity: 1; transform: none; } }
      #${SETTINGS_ID} .ic-sub { padding-left: 12px; border-left: 2px solid var(--SmartThemeQuoteColor, #e18a24); }
      #${SETTINGS_ID} .ic-switch {
        position: relative; flex: none; width: 46px; height: 26px; border-radius: 13px; border: 0; padding: 0;
        background: rgba(127, 127, 127, 0.35); transition: background-color 200ms ease;
      }
      #${SETTINGS_ID} .ic-switch::after {
        content: ''; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: #fff;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3); transition: transform 420ms ${EASE_BACK};
      }
      #${SETTINGS_ID} .ic-switch[aria-checked="true"] { background: var(--SmartThemeQuoteColor, #e18a24); }
      #${SETTINGS_ID} .ic-switch[aria-checked="true"]::after { transform: translateX(20px); }
      #${SETTINGS_ID} .ic-btn {
        border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.15)); background: rgba(127, 127, 127, 0.12);
        border-radius: 12px; padding: 8px 12px; text-align: center;
        transition: transform 380ms ${EASE_BACK};
      }
      #${SETTINGS_ID} .ic-btn:active, #${SETTINGS_ID} .ic-x:active, #${SETTINGS_ID} .ic-switch:active { transform: scale(0.93); transition: transform 80ms ease-out; }
      #${SETTINGS_ID} .ic-switch:active::after { transform: scaleX(1.15); }
      #${SETTINGS_ID} .ic-switch[aria-checked="true"]:active::after { transform: translateX(17px) scaleX(1.15); }
    `;
    mainDoc.head.appendChild(style);
  }

  const toast = (msg) => { if (typeof toastr !== 'undefined') toastr.info(msg, '', { timeOut: 1200 }); };

  // =====================================================================
  //  一、悬浮栏（点击收起/展开，拖动移动，长按打开设置）
  // =====================================================================
  function getBadge() {
    let badge = mainDoc.getElementById(BADGE_ID);
    if (!badge) {
      badge = mainDoc.createElement('div');
      badge.id = BADGE_ID;
      badge.innerHTML = '<div class="ic-panel"><span class="ic-where"></span><span class="ic-tokens">Token 0</span><span class="ic-words">字数 0</span></div><div class="ic-ball"></div>';
      badge.classList.toggle('ic-collapsed', collapsed);
      badge.title = '点击收起/展开，拖动可移动，长按打开设置';
      badge.addEventListener('contextmenu', (e) => e.preventDefault());
      mainDoc.body.appendChild(badge);
      bindBadge(badge);
    }
    return badge;
  }

  // 拖过就记住位置（按视口比例存，横竖屏切换也不会跑出屏幕）
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

  function resetBadgePos() {
    savedPos = null;
    lsDel(LS_POS);
    const badge = mainDoc.getElementById(BADGE_ID);
    if (!badge) return;
    // 归位也用弹簧滑过去，而不是瞬移
    const before = badge.getBoundingClientRect();
    positionBadge();
    const after = badge.getBoundingClientRect();
    badge.animate(
      [{ transform: `translate(${before.left - after.left}px, ${before.top - after.top}px)` }, { transform: 'none' }],
      { duration: 720, easing: SPRING_SOFT },
    );
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

  function bindBadge(badge) {
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
        try { mainWin.navigator.vibrate?.(12); } catch (err) {}
        openSettings();
      }, BADGE_LONG_PRESS_MS);
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

  // ---------- 悬浮栏内容 ----------
  // 每层独立模式：只算输入框。
  // 跟随模式：输入框有光标时算输入框，否则算屏幕上正在看的那一层。
  let shownKey = null;
  let tokenTimer = null;
  let tokenSeq = 0;

  function getTextarea() { return mainDoc.getElementById('send_textarea'); }

  // 找屏幕上"正在看"的楼层：聊天区 40% 高度那条线落在哪一层（楼层按顺序排，二分查找，几百层也不卡）
  function currentFloorEl() {
    const chat = mainDoc.getElementById('chat');
    if (!chat) return null;
    const els = chat.querySelectorAll('.mes[mesid]');
    if (!els.length) return null;
    const cr = chat.getBoundingClientRect();
    const visibleBottom = Math.min(cr.bottom, mainWin.innerHeight);
    const lineY = cr.top + (visibleBottom - cr.top) * 0.4;
    let lo = 0, hi = els.length - 1, ans = els.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (els[mid].getBoundingClientRect().bottom < lineY) lo = mid + 1;
      else { ans = mid; hi = mid - 1; }
    }
    return els[ans];
  }

  function updateBadge(force = false) {
    if (!enabled) return;
    const ta = getTextarea();
    let text = '', where = '', key = '';
    if (isFollow() && !(ta && mainDoc.activeElement === ta)) {
      const el = currentFloorEl();
      if (el) {
        text = getMesText(el);
        where = `#${el.getAttribute('mesid')}`;
      }
      key = `floor:${where}:${text}`;
    } else {
      if (!ta) return;
      text = ta.value || '';
      where = isFollow() ? '输入' : '';
      key = `input:${where}:${text}`;
    }
    if (!force && key === shownKey) { positionBadge(); return; }
    shownKey = key;

    const badge = getBadge();
    const w = countWords(text);
    badge.querySelector('.ic-where').textContent = where;
    badge.querySelector('.ic-words').textContent = `字数 ${w.words}`;
    badge.title = `字数 ${w.words}｜字符 ${w.chars}（不含空白 ${w.charsNoSpace}）\n点击收起/展开，拖动可移动，长按打开设置`;

    // 字数是即时的；token 要调分词器（可能走后端），防抖后再算，期间先把旧数字变淡
    const tokEl = badge.querySelector('.ic-tokens');
    const cached = tokenCache.get(text);
    clearTimeout(tokenTimer);
    const seq = ++tokenSeq;
    if (!text || cached) {
      tokEl.textContent = `Token ${text ? fmtTokens(cached) : 0}`;
      tokEl.classList.remove('ic-pending');
    } else {
      tokEl.classList.add('ic-pending');
      tokenTimer = setTimeout(async () => {
        const r = await countTokensCached(text);
        if (seq !== tokenSeq) return; // 期间内容又变了，丢弃过期结果
        tokEl.textContent = `Token ${fmtTokens(r)}`;
        tokEl.classList.remove('ic-pending');
        positionBadge();
      }, TOKEN_DEBOUNCE_MS);
    }
    positionBadge();
  }

  // =====================================================================
  //  二、楼层计数：每条消息都显示 Token + 字数（包括很早以前的楼层）
  // =====================================================================
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

  function isUserMes(mesEl) {
    const attr = mesEl.getAttribute('is_user');
    if (attr != null) return attr === 'true';
    return !!getCtx()?.chat?.[Number(mesEl.getAttribute('mesid'))]?.is_user;
  }
  function mesKey(mesEl) {
    let chatId = '';
    try { chatId = getCtx()?.getCurrentChatId?.() || getCtx()?.chatId || ''; } catch (e) {}
    return `${chatId}#${mesEl.getAttribute('mesid')}`;
  }

  // ---------- 楼层计数的位置 ----------
  // 没单独拖过的就沿用上一级：每层独立 → 角色/用户 → 全部楼层，切换开关时不会突然全部跳回默认
  function getPosFor(mesEl) {
    const shared = (settings.splitRole && settings.pos[isUserMes(mesEl) ? 'user' : 'char']) || settings.pos.all || null;
    if (!settings.globalPos) return settings.perMes[mesKey(mesEl)] || shared;
    return shared;
  }
  function setPosFor(mesEl, pos) {
    if (!settings.globalPos) settings.perMes[mesKey(mesEl)] = pos;
    else if (settings.splitRole) settings.pos[isUserMes(mesEl) ? 'user' : 'char'] = pos;
    else settings.pos.all = pos;
    saveSettings();
  }

  function placeLabelDefault(mesEl, label) {
    const mesText = mesEl.querySelector('.mes_text');
    const slot = mesEl.querySelector('.ch_name');
    if (mesText) { if (mesText.nextElementSibling !== label) mesText.after(label); }
    else if (slot) { if (label.parentElement !== slot) slot.appendChild(label); }
  }

  function applyLabelPos(mesEl, label) {
    const pos = getPosFor(mesEl);
    if (!pos) {
      label.classList.remove('ic-abs');
      label.style.left = label.style.right = label.style.top = label.style.bottom = '';
      mesEl.classList.remove('ic-has-abs');
      placeLabelDefault(mesEl, label);
      return;
    }
    if (label.parentElement !== mesEl) mesEl.appendChild(label);
    mesEl.classList.add('ic-has-abs');
    label.classList.add('ic-abs');
    label.style.left = pos.h === 'left' ? `${pos.x}px` : '';
    label.style.right = pos.h === 'right' ? `${pos.x}px` : '';
    label.style.top = pos.v === 'top' ? `${pos.y}px` : '';
    label.style.bottom = pos.v === 'bottom' ? `${pos.y}px` : '';
  }

  // 改位置后，屏幕上能看到的其他楼层用弹簧"滑"到新位置（FLIP），看不到的直接换
  function applyAllLabelPos(except) {
    const vh = mainWin.innerHeight;
    mainDoc.querySelectorAll(`#chat .mes[mesid] .${MES_CLASS}`).forEach((label) => {
      const mesEl = label.closest('.mes');
      if (!mesEl || label === except) return;
      const pill = label.querySelector('.ic-pill');
      const b = pill.getBoundingClientRect();
      const visible = b.bottom > 0 && b.top < vh;
      applyLabelPos(mesEl, label);
      if (!visible) return;
      const a = pill.getBoundingClientRect();
      const dx = b.left - a.left, dy = b.top - a.top;
      if (Math.abs(dx) + Math.abs(dy) < 1) return;
      label.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 720, easing: SPRING_SOFT });
    });
  }

  // 长按楼层计数 → 浮起 → 拖动 → 松手。
  // 关键：不长按就什么都不拦，手指一动就是正常上下滚动聊天；
  // 长按到时间后手指还没动，浏览器还没开始滚动，这时在 touchmove 里 preventDefault 就能接管手势而不和滚动打架。
  function bindLabelDrag(label) {
    const pill = label.querySelector('.ic-pill');
    let st = null;
    pill.addEventListener('contextmenu', (e) => e.preventDefault());
    pill.addEventListener('touchmove', (e) => { if (st?.dragging && e.cancelable) e.preventDefault(); }, { passive: false });
    const cancel = () => {
      if (!st) return;
      clearTimeout(st.timer);
      st = null;
    };
    pill.addEventListener('pointerdown', (e) => {
      if (isFollow() || (e.button !== undefined && e.button !== 0)) return;
      st = { id: e.pointerId, x: e.clientX, y: e.clientY, dragging: false };
      st.timer = setTimeout(() => {
        if (!st) return;
        st.dragging = true;
        try { pill.setPointerCapture(st.id); } catch (err) {}
        try { mainWin.navigator.vibrate?.(12); } catch (err) {}
        label.classList.add('ic-lifted', 'ic-dragging-label');
      }, LABEL_LONG_PRESS_MS);
    });
    pill.addEventListener('pointermove', (e) => {
      if (!st || e.pointerId !== st.id) return;
      if (!st.dragging) {
        if (Math.hypot(e.clientX - st.x, e.clientY - st.y) > 8) cancel(); // 手指动了：这是在滚动，不是要拖
        return;
      }
      e.preventDefault();
      label.style.transform = `translate(${e.clientX - st.x}px, ${e.clientY - st.y}px)`;
    });
    const end = (e) => {
      if (!st || e.pointerId !== st.id) return;
      const wasDragging = st.dragging;
      cancel();
      if (!wasDragging) return;
      try { pill.releasePointerCapture(e.pointerId); } catch (err) {}
      const mesEl = label.closest('.mes');
      if (mesEl) {
        // 按落点离哪两条边近，就贴哪两条边
        const m = mesEl.getBoundingClientRect();
        const r = pill.getBoundingClientRect();
        const w = pill.offsetWidth, h = pill.offsetHeight;
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const left = cx - w / 2 - m.left, right = m.right - (cx + w / 2);
        const top = cy - h / 2 - m.top, bottom = m.bottom - (cy + h / 2);
        const pos = {
          h: left <= right ? 'left' : 'right', x: Math.round(Math.max(0, Math.min(left, right))),
          v: top <= bottom ? 'top' : 'bottom', y: Math.round(Math.max(0, Math.min(top, bottom))),
        };
        setPosFor(mesEl, pos);
        label.style.transform = '';
        applyLabelPos(mesEl, label);
        if (settings.globalPos) applyAllLabelPos(label);
      } else {
        label.style.transform = '';
      }
      label.classList.remove('ic-lifted');
      setTimeout(() => label.classList.remove('ic-dragging-label'), 600);
    };
    pill.addEventListener('pointerup', end);
    pill.addEventListener('pointercancel', end);
  }

  function getMesLabel(mesEl) {
    let label = mesEl.querySelector(`.${MES_CLASS}`);
    if (label) return label;
    label = mainDoc.createElement('div');
    label.className = MES_CLASS;
    label.innerHTML = '<span class="ic-pill"><span class="ic-tokens"></span><span class="ic-words"></span></span>';
    placeLabelDefault(mesEl, label);
    if (!label.parentElement) return null;
    applyLabelPos(mesEl, label);
    bindLabelDrag(label);
    return label;
  }

  function renderMesLabel(label, text, tokens) {
    const w = countWords(text);
    label.querySelector('.ic-tokens').textContent = `Token ${tokens ?? '…'}`;
    label.querySelector('.ic-words').textContent = `字数 ${w.words}`;
    label.title = `Token ${tokens ?? '计算中'}｜字数 ${w.words}｜字符 ${w.chars}\n长按后可拖动位置`;
    label.classList.toggle('ic-pending', tokens == null);
  }

  async function runQueue() {
    if (queueRunning) return;
    queueRunning = true;
    try {
      while (queue.length && enabled && !isFollow()) {
        const { el, text } = queue.shift();
        if (!el.isConnected || mesTextOf.get(el) !== text) continue; // 楼层没了或内容又变了
        const r = await countTokensCached(text);
        if (!el.isConnected || mesTextOf.get(el) !== text) continue;
        const label = getMesLabel(el);
        if (label) renderMesLabel(label, text, fmtTokens(r));
      }
    } finally {
      queueRunning = false;
    }
  }

  function scanMessages() {
    if (!enabled || isFollow()) return;
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
    mainDoc.querySelectorAll('#chat .mes.ic-has-abs').forEach((n) => n.classList.remove('ic-has-abs'));
  }

  // =====================================================================
  //  三、设置浮窗（长按悬浮栏打开）
  // =====================================================================
  function getSettingsEl() {
    let el = mainDoc.getElementById(SETTINGS_ID);
    if (el) return el;
    el = mainDoc.createElement('div');
    el.id = SETTINGS_ID;
    el.hidden = true;
    el.innerHTML = `
      <div class="ic-mask"></div>
      <div class="ic-sheet" role="dialog" aria-label="计数设置">
        <div class="ic-head"><b>计数设置</b><button type="button" class="ic-x" aria-label="关闭">×</button></div>
        <div class="ic-group">
          <div class="ic-title">显示方式</div>
          <div class="ic-seg" data-v="perFloor">
            <span class="ic-ind"></span>
            <button type="button" data-mode="perFloor">每层独立显示</button>
            <button type="button" data-mode="follow">悬浮栏跟随楼层</button>
          </div>
          <p class="ic-note" data-note="perFloor">每一层下面各自显示计数，悬浮栏只算输入框。</p>
          <p class="ic-note" data-note="follow">楼层上不再单独显示。悬浮栏显示屏幕上正在看的那一层；点输入框出现光标时，改为计算正在输入的文字。</p>
        </div>
        <div class="ic-group" data-group="pos">
          <div class="ic-title">楼层计数位置</div>
          <p class="ic-note">被美化挡住了？长按楼层计数约 0.4 秒，它会浮起来，这时拖到想放的地方松手。</p>
          <div class="ic-row"><span>拖动一层，所有楼层跟着变</span><button type="button" class="ic-switch" role="switch" data-key="globalPos"></button></div>
          <div class="ic-row ic-sub" data-row="splitRole"><span>角色和用户分开设置</span><button type="button" class="ic-switch" role="switch" data-key="splitRole"></button></div>
          <button type="button" class="ic-btn" data-act="resetMes">楼层计数回到默认位置</button>
        </div>
        <div class="ic-group">
          <div class="ic-title">悬浮栏</div>
          <button type="button" class="ic-btn" data-act="resetBadge">悬浮栏归位</button>
          <p class="ic-note">点一下收成小球，按住拖动可以移动，长按打开这里。</p>
        </div>
      </div>`;
    mainDoc.body.appendChild(el);

    el.querySelector('.ic-mask').addEventListener('click', closeSettings);
    el.querySelector('.ic-x').addEventListener('click', closeSettings);
    el.querySelectorAll('.ic-seg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    el.querySelectorAll('.ic-switch').forEach((sw) => sw.addEventListener('click', () => {
      const key = sw.dataset.key;
      settings[key] = !settings[key];
      saveSettings();
      syncSettingsUI(key === 'globalPos');
      // 切换位置规则后，所有楼层按新规则重新摆
      applyAllLabelPos(null);
    }));
    el.querySelector('[data-act="resetMes"]').addEventListener('click', () => {
      settings.pos = { all: null, user: null, char: null };
      settings.perMes = {};
      saveSettings();
      applyAllLabelPos(null);
      toast('楼层计数已回到默认位置');
    });
    el.querySelector('[data-act="resetBadge"]').addEventListener('click', () => {
      closeSettings();
      setTimeout(resetBadgePos, 120);
    });
    return el;
  }

  function syncSettingsUI(popSub = false) {
    const el = getSettingsEl();
    el.querySelector('.ic-seg').dataset.v = settings.mode;
    el.querySelectorAll('[data-note]').forEach((n) => { n.hidden = n.dataset.note !== settings.mode; });
    el.querySelector('[data-group="pos"]').hidden = isFollow();
    el.querySelectorAll('.ic-switch').forEach((sw) => sw.setAttribute('aria-checked', String(!!settings[sw.dataset.key])));
    const sub = el.querySelector('[data-row="splitRole"]');
    sub.hidden = !settings.globalPos;
    // "角色和用户分开设置"出现时用弹簧阻尼弹出来
    sub.classList.remove('ic-pop');
    if (popSub && settings.globalPos) { void sub.offsetWidth; sub.classList.add('ic-pop'); }
  }

  let settingsCloseTimer = null;
  function openSettings() {
    const el = getSettingsEl();
    clearTimeout(settingsCloseTimer);
    syncSettingsUI();
    el.hidden = false;
    void el.offsetWidth;
    el.classList.add('ic-open');
  }
  function closeSettings() {
    const el = mainDoc.getElementById(SETTINGS_ID);
    if (!el) return;
    el.classList.remove('ic-open');
    settingsCloseTimer = setTimeout(() => { el.hidden = true; }, 220);
  }

  function setMode(mode) {
    if (settings.mode === mode) return;
    settings.mode = mode;
    saveSettings();
    syncSettingsUI();
    if (isFollow()) clearMessageLabels();
    else scanMessages();
    updateBadge(true);
  }

  // =====================================================================
  //  开关
  // =====================================================================
  // 一个开关同时管悬浮栏和楼层计数
  function setEnabled(v) {
    enabled = v;
    lsSet(LS_ENABLED, v ? '1' : '0');
    getBadge().hidden = !v;
    mainDoc.body.classList.toggle(MES_ON_CLASS, v);
    if (v) { updateBadge(true); scanMessages(); } else { clearMessageLabels(); closeSettings(); }
    toast(v ? '计数已开启' : '计数已关闭');
  }

  // ---------- 事件 ----------
  // input 事件管手动输入；focus/blur 管跟随模式在"输入"和"楼层"之间切换；
  // 轮询兜底管程序改值（发送后清空、QR 填入、切换聊天、流式输出等，这些不会触发 input）
  const onInput = () => updateBadge();
  const onFocusChange = () => setTimeout(() => updateBadge(), 0);
  const onResize = () => positionBadge();
  let scrollRaf = 0;
  const onChatScroll = () => {
    if (!isFollow() || scrollRaf) return;
    scrollRaf = mainWin.requestAnimationFrame(() => { scrollRaf = 0; updateBadge(); });
  };
  let boundChat = null;
  function bindTargets() {
    const ta = getTextarea();
    if (ta && ta.dataset.icBound !== '1') {
      ta.dataset.icBound = '1';
      ta.addEventListener('input', onInput);
      ta.addEventListener('focus', onFocusChange);
      ta.addEventListener('blur', onFocusChange);
    }
    const chat = mainDoc.getElementById('chat');
    if (chat && chat !== boundChat) {
      boundChat?.removeEventListener('scroll', onChatScroll);
      chat.addEventListener('scroll', onChatScroll, { passive: true });
      boundChat = chat;
    }
  }
  function unbindTargets() {
    const ta = getTextarea();
    if (ta) {
      ta.removeEventListener('input', onInput);
      ta.removeEventListener('focus', onFocusChange);
      ta.removeEventListener('blur', onFocusChange);
      delete ta.dataset.icBound;
    }
    boundChat?.removeEventListener('scroll', onChatScroll);
    boundChat = null;
  }

  const pollTimer = setInterval(() => {
    bindTargets();
    updateBadge();
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
    unbindTargets();
    mainDoc.getElementById(BADGE_ID)?.remove();
    mainDoc.getElementById(SETTINGS_ID)?.remove();
    mainDoc.getElementById(STYLE_ID)?.remove();
    clearMessageLabels();
    mainDoc.body.classList.remove(MES_ON_CLASS);
  }
  $(window).on('pagehide', () => {
    clearInterval(pollTimer);
    clearInterval(mesPollTimer);
    clearTimeout(tokenTimer);
    clearTimeout(settingsCloseTimer);
    if (scrollRaf) mainWin.cancelAnimationFrame(scrollRaf);
    mainWin.removeEventListener('resize', onResize);
    cleanup();
  });

  // ---------- 启动 ----------
  cleanup(); // 上一个实例如果没清理干净（热重载），先拆掉残留
  injectStyle();
  getBadge().hidden = !enabled;
  mainDoc.body.classList.toggle(MES_ON_CLASS, enabled);
  bindTargets();
  setupButton();
  updateBadge(true);
  scanMessages();
});
