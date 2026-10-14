// 输入框实时计数：Token + 字数
// 作者：时鸢
// 运行环境：酒馆助手（Tavern Helper）脚本。脚本跑在 iframe 里，UI 挂在父文档（酒馆主页面）上。
// 不改动酒馆源码，只读 #send_textarea 的内容，用酒馆自己的分词器算 token。
$(() => {
  const mainWin = (() => { try { return window.parent && window.parent.document ? window.parent : window; } catch (e) { return window; } })();
  const mainDoc = mainWin.document;

  const SCRIPT_ID = 'input-counter';
  const BUTTON_NAME = '输入计数';
  const LS_ENABLED = `${SCRIPT_ID}:enabled`;
  const BADGE_ID = `${SCRIPT_ID}-badge`;
  const STYLE_ID = `${SCRIPT_ID}-style`;
  const TOKEN_DEBOUNCE_MS = 350;
  const POLL_MS = 500;

  // ---------- 开关状态（存在本地，刷新后保持） ----------
  const loadEnabled = () => {
    try { return localStorage.getItem(LS_ENABLED) !== '0'; } catch (e) { return true; }
  };
  const saveEnabled = (v) => {
    try { localStorage.setItem(LS_ENABLED, v ? '1' : '0'); } catch (e) {}
  };
  let enabled = loadEnabled();

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

  // ---------- UI ----------
  function injectStyle() {
    mainDoc.getElementById(STYLE_ID)?.remove();
    const style = mainDoc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${BADGE_ID} {
        position: fixed;
        z-index: 3000;
        display: flex;
        gap: 8px;
        align-items: center;
        padding: 2px 8px;
        border-radius: 10px;
        font-size: 12px;
        line-height: 18px;
        font-family: var(--mainFontFamily, inherit);
        color: var(--SmartThemeBodyColor, #ddd);
        background: var(--SmartThemeBlurTintColor, rgba(0, 0, 0, 0.55));
        border: 1px solid var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.15));
        backdrop-filter: blur(var(--SmartThemeBlurStrength, 6px));
        opacity: 0.85;
        pointer-events: none;
        user-select: none;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      #${BADGE_ID}[hidden] { display: none; }
      #${BADGE_ID} .ic-pending { opacity: 0.5; }
    `;
    mainDoc.head.appendChild(style);
  }

  function getBadge() {
    let badge = mainDoc.getElementById(BADGE_ID);
    if (!badge) {
      badge = mainDoc.createElement('div');
      badge.id = BADGE_ID;
      badge.innerHTML = '<span class="ic-tokens">Token 0</span><span class="ic-words">字数 0</span>';
      mainDoc.body.appendChild(badge);
    }
    return badge;
  }

  // 贴在输入框右上角外侧，随输入框高度/窗口大小变化跟着走
  function positionBadge() {
    const badge = mainDoc.getElementById(BADGE_ID);
    const ta = mainDoc.getElementById('send_textarea');
    if (!badge || !ta || badge.hidden) return;
    const anchor = mainDoc.getElementById('send_form') || ta;
    const rect = anchor.getBoundingClientRect();
    const bw = badge.offsetWidth;
    const bh = badge.offsetHeight;
    const left = Math.max(4, Math.min(rect.right - bw - 6, mainWin.innerWidth - bw - 4));
    const top = Math.max(4, rect.top - bh - 4);
    badge.style.left = `${left}px`;
    badge.style.top = `${top}px`;
  }

  // ---------- 计数主流程 ----------
  let lastText = null;
  let tokenTimer = null;
  let tokenSeq = 0;

  function update(force = false) {
    if (!enabled) return;
    const ta = mainDoc.getElementById('send_textarea');
    if (!ta) return;
    const text = ta.value || '';
    if (!force && text === lastText) { positionBadge(); return; }
    lastText = text;

    const badge = getBadge();
    const w = countWords(text);
    const wordsEl = badge.querySelector('.ic-words');
    wordsEl.textContent = `字数 ${w.words}`;
    badge.title = `字数 ${w.words}｜字符 ${w.chars}（不含空白 ${w.charsNoSpace}）`;

    // 字数是即时的；token 要调分词器（可能走后端），防抖后再算，期间先把旧数字变淡
    const tokEl = badge.querySelector('.ic-tokens');
    tokEl.classList.add('ic-pending');
    clearTimeout(tokenTimer);
    const seq = ++tokenSeq;
    tokenTimer = setTimeout(async () => {
      const r = await countTokens(text);
      if (seq !== tokenSeq) return; // 期间又输入了，丢弃过期结果
      tokEl.textContent = `Token ${r.estimated ? '≈' : ''}${r.value}`;
      tokEl.classList.remove('ic-pending');
      positionBadge();
    }, text ? TOKEN_DEBOUNCE_MS : 0);

    positionBadge();
  }

  function setEnabled(v) {
    enabled = v;
    saveEnabled(v);
    const badge = getBadge();
    badge.hidden = !v;
    if (v) update(true);
    if (typeof toastr !== 'undefined') toastr.info(v ? '输入计数已开启' : '输入计数已关闭', '', { timeOut: 1200 });
  }

  // ---------- 事件 ----------
  // input 事件管手动输入；轮询兜底管程序改值（发送后清空、QR 填入、切换聊天等，这些不会触发 input）
  const onInput = () => update();
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
    update();
  }, POLL_MS);
  mainWin.addEventListener('resize', onResize);

  // ---------- 酒馆助手脚本按钮（显示在 QR 栏） ----------
  function setupButton() {
    try {
      if (typeof appendInexistentScriptButtons === 'function') {
        appendInexistentScriptButtons([{ name: BUTTON_NAME, visible: true }]);
      } else if (typeof replaceScriptButtons === 'function') {
        replaceScriptButtons([{ name: BUTTON_NAME, visible: true }]);
      }
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
  $(window).on('pagehide', () => {
    clearInterval(pollTimer);
    clearTimeout(tokenTimer);
    mainWin.removeEventListener('resize', onResize);
    unbindTextarea();
    mainDoc.getElementById(BADGE_ID)?.remove();
    mainDoc.getElementById(STYLE_ID)?.remove();
  });

  // ---------- 启动 ----------
  // 上一个实例如果没清理干净（热重载），先拆掉残留
  mainDoc.getElementById(BADGE_ID)?.remove();
  unbindTextarea();
  injectStyle();
  getBadge().hidden = !enabled;
  bindTextarea();
  setupButton();
  update(true);
});
