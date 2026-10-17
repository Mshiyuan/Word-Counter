// 计字簿：输入框实时 Token + 字数，以及每个楼层的 Token + 字数
// 作者：时鸢
// 版本：1.0.1
// 运行环境：酒馆助手（Tavern Helper）脚本。脚本跑在 iframe 里，UI 挂在父文档（酒馆主页面）上。
// 不改动酒馆源码，只读输入框和聊天记录的内容，用酒馆自己的分词器算 token。
$(() => {
  const mainWin = (() => { try { return window.parent && window.parent.document ? window.parent : window; } catch (e) { return window; } })();
  const mainDoc = mainWin.document;

  const VERSION = '1.0.1';
  const SCRIPT_ID = 'input-counter';
  const BUTTON_NAME = '计字簿';
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
  //   统计口径（每一项都可以分别选择计入 Token、计入字数）：
  //     cReasonTok / cReasonWords   思维链：酒馆自带思维链 + 正文里 <think> 等标签内的内容
  //     cHiddenTok / cHiddenWords   隐藏内容：HTML 标签、注释、CSS，以及被正则隐藏、页面上看不到的文字
  //     u* 同上，"角色与用户分别设置"（splitCount）开启时用于用户消息，c* 用于角色消息；关闭时全部用 c*
  //   以上是第一次导入时的默认值，之后一直用用户自己保存的设置
  //   hideNative      是否隐藏酒馆自带的楼层 Token 显示
  const DEFAULT_SETTINGS = { mode: 'follow', globalPos: true, splitRole: false, cReasonTok: true, cReasonWords: true, cHiddenTok: true, cHiddenWords: false, splitCount: false, uReasonTok: true, uReasonWords: true, uHiddenTok: true, uHiddenWords: false, hideNative: false, pos: { all: null, user: null, char: null }, perMes: {} };
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

      /* ---------- 设置浮窗 ----------
         ST 里 position: fixed 的层级会被压在聊天区后面；照书摘的做法，absolute 贴 body 铺满 + 超高 z-index
         （ST 的 body 本身不滚动，absolute 贴 body 视觉上等于固定）。
         浮窗背景单独一层（.ic-bg），内容变多变少时只对背景做 translateY + scaleY 的弹簧过渡，内容只做位移，全程不过渡 height。 */
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
        user-select: none;
        -webkit-user-select: none;
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
        isolation: isolate;
        width: min(360px, 100%);
        transform: translateY(16px) scale(0.94);
        opacity: 0;
        transition: transform 180ms cubic-bezier(0.4, 0, 1, 1), opacity 150ms ease-in;
        will-change: transform, opacity;
      }
      #${SETTINGS_ID} .ic-bg {
        position: absolute;
        inset: 0;
        z-index: -1;
        border-radius: 20px;
        background: var(--SmartThemeBlurTintColor, rgba(28, 28, 32, 0.92));
        border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.12));
        backdrop-filter: blur(calc(var(--SmartThemeBlurStrength, 10px) + 6px));
        -webkit-backdrop-filter: blur(calc(var(--SmartThemeBlurStrength, 10px) + 6px));
        box-shadow: 0 18px 50px rgba(0, 0, 0, 0.4);
        transform-origin: 50% 0;
        will-change: transform;
      }
      #${SETTINGS_ID} .ic-body {
        max-height: calc(100dvh - 32px);
        overflow-y: auto;
        box-sizing: border-box;
        padding: 18px 18px 20px;
        display: flex;
        flex-direction: column;
        gap: 18px;
        font-size: 14px;
        line-height: 1.5;
      }
      #${SETTINGS_ID}.ic-open .ic-mask { opacity: 1; transition: opacity 220ms ease-out; }
      #${SETTINGS_ID}.ic-open .ic-sheet {
        transform: none;
        opacity: 1;
        transition: transform 720ms ${SPRING_SOFT}, opacity 200ms ease-out;
      }
      #${SETTINGS_ID} button { font: inherit; color: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }

      /* 标题栏 */
      #${SETTINGS_ID} .ic-head { display: flex; align-items: center; justify-content: space-between; }
      #${SETTINGS_ID} .ic-head b { font-size: 17px; font-weight: 600; }
      #${SETTINGS_ID} .ic-x {
        width: 30px; height: 30px; border-radius: 50%; border: 0; padding: 0; background: rgba(127, 127, 127, 0.16); font-size: 17px; line-height: 30px;
        transition: transform 420ms ${SPRING_SOFT};
      }

      /* 分区：小标题 + 圆角分组 + 底部说明，像系统设置那样 */
      #${SETTINGS_ID} .ic-section { display: flex; flex-direction: column; gap: 6px; }
      #${SETTINGS_ID} .ic-section[hidden] { display: none; }
      #${SETTINGS_ID} .ic-label { font-size: 12px; opacity: 0.55; letter-spacing: 0.06em; padding-left: 4px; }
      #${SETTINGS_ID} .ic-card { border-radius: 14px; background: rgba(127, 127, 127, 0.1); overflow: hidden; }
      #${SETTINGS_ID} .ic-foot { margin: 0; padding: 0 4px; font-size: 12px; line-height: 1.55; opacity: 0.55; }
      #${SETTINGS_ID} .ic-foot[hidden] { display: none; }
      #${SETTINGS_ID} .ic-row {
        display: flex; align-items: center; justify-content: space-between; gap: 12px;
        min-height: 46px; padding: 0 14px; box-sizing: border-box;
      }
      #${SETTINGS_ID} .ic-row + .ic-row { box-shadow: inset 0 1px 0 rgba(127, 127, 127, 0.18); }
      #${SETTINGS_ID} .ic-row[hidden] { display: none; }
      #${SETTINGS_ID} .ic-row.ic-sub { padding-left: 30px; }
      #${SETTINGS_ID} .ic-lbl > span { display: inline-block; }
      #${SETTINGS_ID} .ic-prefix[hidden] { display: none; }
      #${SETTINGS_ID} .ic-prefix, #${SETTINGS_ID} .ic-tag { opacity: 0.6; white-space: pre; }
      /* 统计口径矩阵：行 = 思维链 / 隐藏内容，列 = Token / 字数 */
      #${SETTINGS_ID} .ic-mrow {
        display: grid; grid-template-columns: 1fr 64px 64px; align-items: center; justify-items: center;
        min-height: 46px; padding: 0 14px; box-sizing: border-box;
      }
      #${SETTINGS_ID} .ic-mrow > span:first-child { justify-self: start; }
      #${SETTINGS_ID} .ic-mrow + .ic-mrow { box-shadow: inset 0 1px 0 rgba(127, 127, 127, 0.18); }
      #${SETTINGS_ID} .ic-mhead { min-height: 32px; font-size: 12px; }
      #${SETTINGS_ID} .ic-mhead > span:not(:first-child) { opacity: 0.55; }
      #${SETTINGS_ID} .ic-matrix + .ic-row { box-shadow: inset 0 1px 0 rgba(127, 127, 127, 0.18); }
      /* 用户那一组：组本身不做动画，各行依次弹入 */
      #${SETTINGS_ID} .ic-rowgroup { box-shadow: inset 0 1px 0 rgba(127, 127, 127, 0.18); }
      #${SETTINGS_ID} .ic-rowgroup[hidden] { display: none; }
      #${SETTINGS_ID} .ic-rowgroup.ic-in { animation: none; }
      #${SETTINGS_ID} .ic-rowgroup.ic-in .ic-mrow { animation: ic-spring-in 620ms ${SPRING_SOFT} both; }
      #${SETTINGS_ID} .ic-rowgroup.ic-in .ic-mrow:nth-child(2) { animation-delay: 50ms; }
      #${SETTINGS_ID} .ic-rowgroup.ic-in .ic-mrow:nth-child(3) { animation-delay: 100ms; }
      #${SETTINGS_ID} .ic-row.ic-sub > span:first-child::before { content: '└'; margin-right: 6px; opacity: 0.35; }
      #${SETTINGS_ID} .ic-act {
        width: 100%; border: 0; background: none; text-align: left; font-size: 14px;
        color: var(--SmartThemeQuoteColor, #e18a24);
        transition: background-color 160ms ease;
      }
      #${SETTINGS_ID} .ic-act:active { background: rgba(127, 127, 127, 0.14); transition-duration: 0ms; }

      /* 进入 / 离开：只用 transform + opacity，弹簧阻尼 */
      #${SETTINGS_ID} .ic-in { animation: ic-spring-in 620ms ${SPRING_SOFT} both; }
      #${SETTINGS_ID} .ic-out { animation: ic-fade-out 160ms cubic-bezier(0.4, 0, 1, 1) both; pointer-events: none; }
      @keyframes ic-spring-in { from { opacity: 0; transform: translateY(-8px) scale(0.94); } to { opacity: 1; transform: none; } }
      @keyframes ic-fade-out { to { opacity: 0; transform: scale(0.96); } }

      /* 分段选择 */
      #${SETTINGS_ID} .ic-seg { position: relative; display: grid; grid-template-columns: 1fr 1fr; padding: 3px; border-radius: 12px; background: rgba(127, 127, 127, 0.14); }
      #${SETTINGS_ID} .ic-seg .ic-ind {
        position: absolute; top: 3px; bottom: 3px; left: 3px; width: calc(50% - 3px); border-radius: 9px;
        background: var(--SmartThemeBlurTintColor, rgba(60, 60, 60, 0.9)); box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18);
        transition: transform 560ms ${SPRING_SOFT};
      }
      #${SETTINGS_ID} .ic-seg[data-v="follow"] .ic-ind { transform: translateX(100%); }
      #${SETTINGS_ID} .ic-seg button { position: relative; border: 0; background: none; padding: 8px 4px; font-size: 13px; border-radius: 9px; opacity: 0.6; transition: opacity 200ms ease; }
      #${SETTINGS_ID} .ic-seg button[aria-pressed="true"] { opacity: 1; font-weight: 600; }

      /* 开关：滑块用弹簧，按下时滑块朝运动方向拉长一点（预告要往哪边走），不缩放整个开关 */
      #${SETTINGS_ID} .ic-switch {
        position: relative; flex: none; width: 48px; height: 28px; border-radius: 14px; border: 0; padding: 0;
        background: rgba(127, 127, 127, 0.35); transition: background-color 260ms ease;
        touch-action: manipulation;
      }
      #${SETTINGS_ID} .ic-switch::after {
        content: ''; position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 11px; background: #fff;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
        transform-origin: left center;
        transition: transform 460ms ${SPRING_SOFT}, width 0ms;
      }
      #${SETTINGS_ID} .ic-switch[aria-checked="true"] { background: var(--SmartThemeQuoteColor, #e18a24); }
      #${SETTINGS_ID} .ic-switch[aria-checked="true"]::after { transform: translateX(20px); }
      #${SETTINGS_ID} .ic-switch.ic-press::after { transform: scaleX(1.25); transition: transform 160ms ease-out; }
      #${SETTINGS_ID} .ic-switch[aria-checked="true"].ic-press::after { transform-origin: right center; transform: translateX(20px) scaleX(1.25); }
      #${SETTINGS_ID} .ic-x:active { transform: scale(0.88); transition: transform 90ms ease-out; }
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
    let text = '', tokText = '', where = '', key = '';
    if (isFollow() && !(ta && mainDoc.activeElement === ta)) {
      const el = currentFloorEl();
      if (el) {
        ({ body: text, tok: tokText } = getMesParts(el));
        where = `#${el.getAttribute('mesid')}`;
      }
      key = `floor:${where}:${tokText}`;
    } else {
      if (!ta) return;
      text = tokText = ta.value || '';
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
    const cached = tokenCache.get(tokText);
    clearTimeout(tokenTimer);
    const seq = ++tokenSeq;
    if (!tokText || cached) {
      tokEl.textContent = `Token ${tokText ? fmtTokens(cached) : 0}`;
      tokEl.classList.remove('ic-pending');
    } else {
      tokEl.classList.add('ic-pending');
      tokenTimer = setTimeout(async () => {
        const r = await countTokensCached(tokText);
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
  let mesTextOf = new WeakMap();
  // token 计算排队一个一个来，几百层的老聊天也不会一下子把后端打满
  const queue = [];
  let queueRunning = false;

  // body：正文，用来算字数；tok：思维链 + 正文，用来算 token。
  // 酒馆自带的楼层 token 就是 (extra.reasoning || '') + mes 一起算的，这里保持同一口径，数字才对得上。
  // 设置里可以关掉思维链、关掉隐藏内容（关掉后改用页面上实际显示的文字）
  // 思维链有两种存法：
  //   1) 酒馆自带的推理功能，存在 extra.reasoning 里（和正文分开）；
  //   2) 写在正文里的标签，比如 <thinking>…</thinking>，通常再用正则隐藏。很多预设是这种。
  // "计入思维链"关闭时两种都要去掉，否则第 2 种会被当成正文一直算进去。
  const REASONING_TAGS = 'think|thinking|reasoning|thought|thoughts|cot|analysis';
  const REASONING_BLOCK_RE = new RegExp(`<(${REASONING_TAGS})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi');
  const REASONING_OPEN_RE = new RegExp(`<(${REASONING_TAGS})\\b[^>]*>[\\s\\S]*$`, 'i'); // 流式输出中还没闭合的
  const stripReasoningTags = (text) => text.replace(REASONING_BLOCK_RE, '').replace(REASONING_OPEN_RE, '');

  // 去掉 HTML 注释和标签，只留文字（用于"不计隐藏内容"时的思维链原文）
  const stripMarkup = (text) => text.replace(/<!--[\s\S]*?-->/g, '').replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, '').replace(/<[^>]+>/g, '');

  // 页面上显示的正文：用 innerText（不含 <style>/<script>、不含被隐藏的元素），
  // 再扣掉其中显示出来的思维链块（思维链单独统计）。
  // 注意不能用 textContent：美化消息里常有大段 <style>，textContent 会把 CSS 代码也算进去。
  function shownBody(mesEl) {
    const node = mesEl.querySelector('.mes_text');
    if (!node) return '';
    let text = node.innerText || '';
    const blocks = [...node.querySelectorAll(REASONING_TAGS.split('|').join(','))];
    node.querySelectorAll('details').forEach((d) => {
      if (/思|推理|think|reason|cot/i.test(d.querySelector('summary')?.textContent || '')) blocks.push(d);
    });
    blocks.forEach((el) => {
      const t = el.innerText;
      if (t && t.trim()) text = text.replace(t, '');
    });
    return text;
  }

  // 统计口径：一条消息拆成四份
  //   正文原文 / 正文显示文字（不含思维链）
  //   思维链原文 / 思维链去掉代码后的文字
  // Token 和字数各自按开关从里面挑：
  //   计入思维链 → 加上思维链；计入隐藏内容 → 用原文，否则用显示出来的文字
  function getMesParts(mesEl) {
    const id = Number(mesEl.getAttribute('mesid'));
    const msg = getCtx()?.chat?.[id];
    const p = settings.splitCount && isUserMes(mesEl) ? 'u' : 'c';
    const flag = (k) => !!settings[p + k];
    const raw = msg && typeof msg.mes === 'string' ? msg.mes : null;

    let inline = '';
    if (raw) {
      const blocks = raw.match(REASONING_BLOCK_RE) || [];
      const open = raw.replace(REASONING_BLOCK_RE, '').match(REASONING_OPEN_RE); // 流式输出中还没闭合的
      inline = [...blocks, open?.[0]].filter(Boolean).join('');
    }
    let reasonRaw = (typeof msg?.extra?.reasoning === 'string' ? msg.extra.reasoning : '') + inline;
    if (!raw && !reasonRaw) reasonRaw = mesEl.querySelector('.mes_reasoning')?.textContent || '';

    // 显示文字要读页面（innerText 会触发排版），只在用得到时才读
    let shown = null;
    const bodyShown = () => (shown ??= shownBody(mesEl));
    const bodyOf = (hidden) => (hidden && raw != null ? stripReasoningTags(raw) : bodyShown());
    const reasonOf = (hidden) => (hidden ? reasonRaw : stripMarkup(reasonRaw));

    // 和酒馆自带计数一样直接拼接（reasoning + mes），数字才对得上
    const tokReason = flag('ReasonTok') ? reasonOf(flag('HiddenTok')) : '';
    const tok = tokReason + bodyOf(flag('HiddenTok'));
    const words = (flag('ReasonWords') ? reasonOf(flag('HiddenWords')) : '') + bodyOf(flag('HiddenWords'));
    return { body: words, tok, hasReasoning: !!tokReason.trim() };
  }

  // 酒馆自带的楼层 Token 显示：脚本开启且设置里选了隐藏时才藏
  function syncNativeHidden() {
    mainDoc.body.classList.toggle(MES_ON_CLASS, enabled && settings.hideNative);
  }

  // 统计口径变了：所有楼层和悬浮栏按新口径重算
  function recountAll() {
    mesTextOf = new WeakMap();
    queue.length = 0;
    scanMessages();
    updateBadge(true);
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

  function renderMesLabel(label, parts, tokens) {
    const w = countWords(parts.body);
    label.querySelector('.ic-tokens').textContent = `Token ${tokens ?? '…'}`;
    label.querySelector('.ic-words').textContent = `字数 ${w.words}`;
    label.title = `Token ${tokens ?? '计算中'}${parts.hasReasoning ? '（含思维链）' : ''}｜正文字数 ${w.words}｜字符 ${w.chars}\n长按后可拖动位置`;
    label.classList.toggle('ic-pending', tokens == null);
  }

  async function runQueue() {
    if (queueRunning) return;
    queueRunning = true;
    try {
      while (queue.length && enabled && !isFollow()) {
        const { el, parts } = queue.shift();
        if (!el.isConnected || mesTextOf.get(el) !== parts.tok) continue; // 楼层没了或内容又变了
        const r = await countTokensCached(parts.tok);
        if (!el.isConnected || mesTextOf.get(el) !== parts.tok) continue;
        const label = getMesLabel(el);
        if (label) renderMesLabel(label, parts, fmtTokens(r));
      }
    } finally {
      queueRunning = false;
    }
  }

  // 只处理屏幕上看得到的楼层，再加上下各 MES_MARGIN 层的余量：
  // 滚动时提前算好，眼睛看到时已经有数字；看不到的老楼层不算，长聊天也不会一下子发几百次分词请求。
  const MES_MARGIN = 10;
  function visibleRange(els) {
    const chat = mainDoc.getElementById('chat');
    const n = els.length;
    if (!chat || !n) return [0, n - 1];
    const cr = chat.getBoundingClientRect();
    const top = cr.top, bottom = Math.min(cr.bottom, mainWin.innerHeight);
    // 第一层底边在视口顶之下的楼层
    let lo = 0, hi = n - 1, first = n - 1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (els[mid].getBoundingClientRect().bottom >= top) { first = mid; hi = mid - 1; } else lo = mid + 1; }
    // 最后一层顶边在视口底之上的楼层
    lo = first; hi = n - 1; let last = first;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (els[mid].getBoundingClientRect().top <= bottom) { last = mid; lo = mid + 1; } else hi = mid - 1; }
    return [Math.max(0, first - MES_MARGIN), Math.min(n - 1, last + MES_MARGIN)];
  }

  function scanMessages() {
    if (!enabled || isFollow()) return;
    const els = mainDoc.querySelectorAll('#chat .mes[mesid]');
    const [from, to] = visibleRange(els);
    // 从下往上排，先算眼前和下方（最新）的楼层
    for (let i = to; i >= from; i--) {
      const el = els[i];
      const parts = getMesParts(el);
      if (mesTextOf.get(el) === parts.tok && el.querySelector(`.${MES_CLASS}`)) continue;
      mesTextOf.set(el, parts.tok);
      const label = getMesLabel(el);
      if (!label) continue;
      const cached = tokenCache.get(parts.tok);
      if (!parts.tok) renderMesLabel(label, parts, '0');
      else if (cached) renderMesLabel(label, parts, fmtTokens(cached));
      else {
        renderMesLabel(label, parts, null);
        queue.push({ el, parts });
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
      <div class="ic-sheet" role="dialog" aria-label="计字簿设置">
        <div class="ic-bg"></div>
        <div class="ic-body">
          <div class="ic-head"><b>计字簿设置</b><button type="button" class="ic-x" aria-label="关闭">✕</button></div>

          <div class="ic-section">
            <div class="ic-label">显示方式</div>
            <div class="ic-seg" data-v="perFloor">
              <span class="ic-ind"></span>
              <button type="button" data-mode="perFloor">每层独立</button>
              <button type="button" data-mode="follow">跟随楼层</button>
            </div>
            <p class="ic-foot" data-note="perFloor">每层消息下方显示该层计数；悬浮栏仅统计输入框。</p>
            <p class="ic-foot" data-note="follow">楼层内不显示计数。悬浮栏显示视口当前所在楼层；输入框获得焦点时，改为统计输入内容。</p>
            <div class="ic-card">
              <div class="ic-row"><span>隐藏酒馆自带楼层计数</span><button type="button" class="ic-switch" role="switch" data-key="hideNative"></button></div>
            </div>
          </div>

          <div class="ic-section" data-section="pos">
            <div class="ic-label">楼层计数位置</div>
            <div class="ic-card">
              <div class="ic-row"><span>同步所有楼层位置</span><button type="button" class="ic-switch" role="switch" data-key="globalPos"></button></div>
              <div class="ic-row ic-sub" data-row="splitRole"><span>角色与用户分别设置</span><button type="button" class="ic-switch" role="switch" data-key="splitRole"></button></div>
              <div class="ic-row" style="padding:0"><button type="button" class="ic-row ic-act" data-act="resetMes">恢复默认位置</button></div>
            </div>
            <p class="ic-foot">长按楼层计数约 0.4 秒后可拖动，松开即保存位置。</p>
          </div>

          <div class="ic-section">
            <div class="ic-label">统计口径</div>
            <div class="ic-card">
              <div class="ic-matrix">
                <div class="ic-mrow ic-mhead"><span class="ic-lbl"><span class="ic-prefix">角色</span><span class="ic-text"></span></span><span>Token</span><span>字数</span></div>
                <div class="ic-mrow"><span>思维链</span><button type="button" class="ic-switch" role="switch" data-key="cReasonTok" aria-label="思维链计入 Token"></button><button type="button" class="ic-switch" role="switch" data-key="cReasonWords" aria-label="思维链计入字数"></button></div>
                <div class="ic-mrow"><span>隐藏内容</span><button type="button" class="ic-switch" role="switch" data-key="cHiddenTok" aria-label="隐藏内容计入 Token"></button><button type="button" class="ic-switch" role="switch" data-key="cHiddenWords" aria-label="隐藏内容计入字数"></button></div>
              </div>
              <div class="ic-row" style="padding-right:22px"><span>角色与用户分别设置</span><button type="button" class="ic-switch" role="switch" data-key="splitCount"></button></div>
              <div class="ic-rowgroup" data-row="userCount">
              <div class="ic-matrix">
                <div class="ic-mrow ic-mhead"><span class="ic-lbl"><span class="ic-tag">用户</span></span><span>Token</span><span>字数</span></div>
                <div class="ic-mrow"><span>思维链</span><button type="button" class="ic-switch" role="switch" data-key="uReasonTok" aria-label="思维链计入 Token"></button><button type="button" class="ic-switch" role="switch" data-key="uReasonWords" aria-label="思维链计入字数"></button></div>
                <div class="ic-mrow"><span>隐藏内容</span><button type="button" class="ic-switch" role="switch" data-key="uHiddenTok" aria-label="隐藏内容计入 Token"></button><button type="button" class="ic-switch" role="switch" data-key="uHiddenWords" aria-label="隐藏内容计入字数"></button></div>
              </div>
              </div>
            </div>
            <p class="ic-foot">分别选择思维链、隐藏内容是否计入 Token 和字数。<br>思维链：酒馆自带的思维链，以及正文中 &lt;think&gt; 等标签内的内容。<br>隐藏内容：HTML 标签、注释、CSS 代码，以及被正则隐藏、页面上看不到的文字。<br>思维链与隐藏内容的 Token 都开启时，与酒馆自带计数一致。输入框始终按原文统计。</p>
          </div>

          <div class="ic-section">
            <div class="ic-label">悬浮栏</div>
            <div class="ic-card">
              <div class="ic-row" style="padding:0"><button type="button" class="ic-row ic-act" data-act="resetBadge">恢复默认位置</button></div>
            </div>
            <p class="ic-foot">单击：收起 / 展开　·　拖动：移动　·　长按：打开设置</p>
            <p class="ic-foot" style="text-align:center; margin-top:6px">计字簿 v${VERSION} · 时鸢</p>
          </div>
        </div>
      </div>`;
    mainDoc.body.appendChild(el);

    el.querySelector('.ic-mask').addEventListener('click', closeSettings);
    el.querySelector('.ic-x').addEventListener('click', closeSettings);
    el.querySelectorAll('.ic-seg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    el.querySelectorAll('.ic-switch').forEach((sw) => {
      // 按下就给反馈（滑块拉长），不用等 click；松开 / 划走就收回
      sw.addEventListener('pointerdown', () => sw.classList.add('ic-press'));
      ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => sw.addEventListener(t, () => sw.classList.remove('ic-press')));
      sw.addEventListener('click', () => {
        sw.classList.remove('ic-press');
        const key = sw.dataset.key;
        settings[key] = !settings[key];
        saveSettings();
        sw.setAttribute('aria-checked', String(settings[key]));
        if (key === 'splitCount') {
          // 用户那两行作为一组一起进出（只做一次尺寸过渡），上面两行的"角色 · "前缀同时滑入 / 滑出
          toggleSection(el.querySelector('[data-row="userCount"]'), settings.splitCount);
          syncRoleLabels(true);
        }
        // 重算放到动画开始之后，避免和过渡抢主线程
        if (key === 'splitCount' || /^[cu](Reason|Hidden)(Tok|Words)$/.test(key)) { setTimeout(recountAll, 60); return; }
        if (key === 'hideNative') { syncNativeHidden(); return; }
        if (key === 'globalPos') toggleSection(el.querySelector('[data-row="splitRole"]'), settings.globalPos);
        // 切换位置规则后，所有楼层按新规则重新摆
        applyAllLabelPos(null);
      });
    });
    el.querySelector('[data-act="resetMes"]').addEventListener('click', () => {
      settings.pos = { all: null, user: null, char: null };
      settings.perMes = {};
      saveSettings();
      applyAllLabelPos(null);
      toast('楼层计数已恢复默认位置');
    });
    el.querySelector('[data-act="resetBadge"]').addEventListener('click', () => {
      closeSettings();
      setTimeout(resetBadgePos, 120);
    });
    return el;
  }

  // 浮窗内容增减时的弹簧过渡（FLIP）：
  // 先记下背景和各分区的位置 → 改内容 → 背景从旧尺寸 translateY + scaleY 弹到新尺寸，分区从旧位置 translateY 弹到新位置。
  function resizeSheet(mutate) {
    const el = getSettingsEl();
    const bg = el.querySelector('.ic-bg');
    const items = [...el.querySelectorAll('.ic-head, .ic-section:not([hidden])')];
    const b0 = bg.getBoundingClientRect();
    const tops = new Map(items.map((n) => [n, n.getBoundingClientRect().top]));
    mutate();
    const b1 = bg.getBoundingClientRect();
    if (!b1.height) return;
    const opts = { duration: 640, easing: SPRING_SOFT };
    if (Math.abs(b0.height - b1.height) > 0.5 || Math.abs(b0.top - b1.top) > 0.5) {
      bg.animate([{ transform: `translateY(${b0.top - b1.top}px) scaleY(${b0.height / b1.height})` }, { transform: 'none' }], opts);
    }
    tops.forEach((top, n) => {
      if (!n.isConnected || n.hidden) return;
      const dy = top - n.getBoundingClientRect().top;
      if (Math.abs(dy) > 0.5) n.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], opts);
    });
  }

  // 显示 / 隐藏一块内容：出现时弹簧弹入，消失时先淡出再收起，浮窗尺寸都跟着弹簧过渡
  function toggleSection(node, show) {
    if (show === !node.hidden && !node.classList.contains('ic-out')) return;
    clearTimeout(node._icTimer);
    if (show) {
      node.classList.remove('ic-out', 'ic-in');
      resizeSheet(() => { node.hidden = false; });
      void node.offsetWidth;
      node.classList.add('ic-in');
    } else {
      node.classList.remove('ic-in');
      node.classList.add('ic-out');
      node._icTimer = setTimeout(() => {
        node.classList.remove('ic-out');
        resizeSheet(() => { node.hidden = true; });
      }, 150);
    }
  }

  function syncSettingsUI() {
    const el = getSettingsEl();
    el.querySelector('.ic-seg').dataset.v = settings.mode;
    el.querySelectorAll('.ic-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === settings.mode)));
    el.querySelectorAll('[data-note]').forEach((n) => { n.hidden = n.dataset.note !== settings.mode; });
    el.querySelector('[data-section="pos"]').hidden = isFollow();
    el.querySelectorAll('.ic-switch').forEach((sw) => sw.setAttribute('aria-checked', String(!!settings[sw.dataset.key])));
    el.querySelector('[data-row="splitRole"]').hidden = !settings.globalPos;
    el.querySelector('[data-row="userCount"]').hidden = !settings.splitCount;
    syncRoleLabels();
  }

  // 分开设置时，上面那组开关前面加"角色 · "，和下面"用户 · "那组对应
  // 动画：前缀出现 / 消失时，后面的文字用 FLIP 从原位置弹簧滑到新位置，前缀本身淡入并从左侧滑进来
  function syncRoleLabels(animate = false) {
    getSettingsEl().querySelectorAll('.ic-prefix').forEach((prefix) => {
      const lbl = prefix.parentElement;
      const text = lbl.querySelector('.ic-text');
      const before = animate && text ? text.getBoundingClientRect().left : 0;
      prefix.hidden = !settings.splitCount;
      if (!animate) return;
      const dx = text ? before - text.getBoundingClientRect().left : 0;
      const opts = { duration: 560, easing: SPRING_SOFT };
      if (text && Math.abs(dx) > 0.5) text.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], opts);
      if (settings.splitCount) {
        // 淡入的终点用 CSS 里的浅色透明度，而不是 1，否则动画期间是深色、结束才跳回浅色
        const target = Number(mainWin.getComputedStyle(prefix).opacity) || 0.6;
        prefix.animate([{ opacity: 0, transform: 'translateX(-8px)' }, { opacity: target, transform: 'none' }], opts);
      }
    });
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
    const el = getSettingsEl();
    el.querySelector('.ic-seg').dataset.v = mode;
    el.querySelectorAll('.ic-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    // 说明文字和"楼层计数位置"分区一起换，浮窗尺寸弹簧过渡
    resizeSheet(() => {
      el.querySelectorAll('[data-note]').forEach((n) => {
        n.hidden = n.dataset.note !== mode;
        if (!n.hidden) { n.classList.remove('ic-in'); void n.offsetWidth; n.classList.add('ic-in'); }
      });
    });
    toggleSection(el.querySelector('[data-section="pos"]'), !isFollow());
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
    syncNativeHidden();
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
  // 跟随模式：滚动时更新悬浮栏；每层独立模式：滚动时补算新进入范围的楼层
  // （补算节流到 150ms 一次，快速滑动时不会每帧都去读楼层内容，避免卡顿）
  let scanThrottle = 0;
  const onChatScroll = () => {
    if (isFollow()) {
      if (scrollRaf) return;
      scrollRaf = mainWin.requestAnimationFrame(() => { scrollRaf = 0; updateBadge(); });
    } else if (!scanThrottle) {
      scanThrottle = setTimeout(() => { scanThrottle = 0; scanMessages(); }, 150);
    }
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
    clearTimeout(scanThrottle);
    mainWin.removeEventListener('resize', onResize);
    cleanup();
  });

  // ---------- 启动 ----------
  cleanup(); // 上一个实例如果没清理干净（热重载），先拆掉残留
  injectStyle();
  getBadge().hidden = !enabled;
  syncNativeHidden();
  bindTargets();
  setupButton();
  updateBadge(true);
  scanMessages();
});
