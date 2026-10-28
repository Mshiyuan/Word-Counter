// 酒馆助手脚本「预设条目工具」
// 功能：
//   1. 双击新建：双击条目左侧的「☰」拖动手柄，在该条目下方新建空条目。
//   2. 版本对比：导入预设时，若检测到同一预设的旧版本，列出仅存在于旧版本的条目和内容不同的条目，
//      所选条目插入新预设中与旧版本相同的位置。
//   3. 条目方案：将条目开关保存为方案，绑定到角色或聊天存档，切换时自动套用。
// 各功能可在「扩展」页面的「预设条目工具」中启用或停用。
// 兼容 ST-BaiBai-Tools 的预设分组。
(() => {
    const CONFIG = {
        // 双击新建：新条目的名称。名称重复时自动追加编号。
        newPromptName: '新条目',
        // 双击新建：新建后是否打开编辑窗口。
        openEditor: true,
        // 双击新建：新建后是否自动保存当前预设。
        autoSavePreset: false,
        // 双击新建：两次点击的最大间隔（毫秒）。
        doubleTapMs: 350,
        // 双击新建：单次点击允许的最大位移（像素），超出视为拖动。
        moveTolerance: 10,
        // 版本对比：名称不匹配时，判定为同一预设所需的最少相同自定义条目数。
        minSharedCustomPrompts: 3,
        // 版本对比：名称不匹配时，判定为同一预设所需的相同自定义条目最低占比。
        minOverlapRatio: 0.5,
        // 版本对比：内容预览的最大字数。
        previewChars: 2000,
    };

    const SETTINGS_KEY = 'presetEntryTools';
    const DEFAULT_SETTINGS = {
        doubleTapEnabled: true,
        importCompareEnabled: true,
        profilesEnabled: true,
        // 切换角色、聊天存档或预设时自动套用方案；关闭时需在方案栏点击「套用」
        autoApply: true,
        // 未记录开关的取值来源：'saved' 为预设上次保存的状态，'previous' 为保持切换前的状态
        defaultSource: 'saved',
        confirmNewEntries: true,
    };
    const DEFAULT_SOURCES = ['saved', 'previous'];
    const BUTTON_NAME = '对比旧版本预设';
    const INSTALL_KEY = '__presetEntryToolsScript';
    // 已合并到本脚本的旧脚本。同一页面中仍在运行时先卸载。
    const LEGACY_INSTALL_KEYS = ['__doubleTapNewPromptScript', '__presetVersionMigrateScript'];
    const BAIBAI_STATE_KEY = '__baiBaiToolkitExtensionInstalled';
    const BAIBAI_VUE_LIST_KEY = '__baiBaiToolkitPresetVueListManager';
    const STYLE_ID = 'preset-entry-tools-style';
    const BAR_ID = 'preset-entry-tools-profile-bar';
    const PANEL_ID = 'preset-entry-tools-settings';
    const ROW_SELECTOR = '#completion_prompt_manager_list li.completion_prompt_manager_prompt[data-pm-identifier]';
    const GLOBAL_ORDER_ID = '100001';
    // SillyTavern 内置条目。所有预设都包含这些条目，不参与同一预设的判定。
    const BUILTIN_IDS = new Set([
        'main', 'nsfw', 'jailbreak', 'enhanceDefinitions', 'worldInfoBefore', 'worldInfoAfter',
        'charDescription', 'charPersonality', 'scenario', 'personaDescription', 'dialogueExamples', 'chatHistory',
    ]);
    const COMPARE_FIELDS = {
        content: '',
        role: 'system',
        injection_position: 0,
        injection_depth: 4,
        injection_order: 100,
        injection_trigger: [],
        forbid_overrides: false,
    };
    const FIELD_LABELS = {
        content: '内容',
        role: '角色',
        injection_position: '插入位置',
        injection_depth: '深度',
        injection_order: '顺序',
        injection_trigger: '触发条件',
        forbid_overrides: '禁止覆盖',
    };

    const pwin = window.parent;
    const pdoc = pwin.document;
    const notify = pwin.toastr ?? window.toastr;

    // 重复加载时先卸载上一次的实例
    pwin[INSTALL_KEY]?.uninstall?.();
    LEGACY_INSTALL_KEYS.forEach(key => pwin[key]?.uninstall?.());

    // ---------- SillyTavern 模块与设置 ----------

    const moduleCache = new Map();

    // 在主页面中导入模块，以取得 SillyTavern 正在使用的同一模块实例
    function importFromTavern(path) {
        if (!moduleCache.has(path)) {
            const url = new URL(path, pdoc.baseURI).href;
            const promise = Promise.resolve(new pwin.Function('url', 'return import(url);')(url))
                .catch(error => {
                    moduleCache.delete(path);
                    throw error;
                });
            moduleCache.set(path, promise);
        }

        return moduleCache.get(path);
    }

    const loadOpenAi = () => importFromTavern('scripts/openai.js');
    const loadPopup = () => importFromTavern('scripts/popup.js');
    const getContext = () => pwin.SillyTavern.getContext();

    // 写入 SillyTavern 数据的对象在主页面中创建，避免跨 iframe 的对象引用
    const toParent = value => pwin.structuredClone(value);

    function getSettings() {
        const extensionSettings = getContext().extensionSettings;

        if (!extensionSettings[SETTINGS_KEY] || typeof extensionSettings[SETTINGS_KEY] !== 'object') {
            extensionSettings[SETTINGS_KEY] = toParent({});
        }

        const settings = extensionSettings[SETTINGS_KEY];

        // 旧版设置项 restoreBaselineEnabled 迁移为 defaultSource
        if ('restoreBaselineEnabled' in settings) {
            if (!DEFAULT_SOURCES.includes(settings.defaultSource)) {
                settings.defaultSource = settings.restoreBaselineEnabled === false ? 'previous' : 'saved';
            }

            delete settings.restoreBaselineEnabled;
        }

        for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
            if (typeof settings[key] !== typeof value) {
                settings[key] = value;
            }
        }

        if (!DEFAULT_SOURCES.includes(settings.defaultSource)) {
            settings.defaultSource = DEFAULT_SETTINGS.defaultSource;
        }

        if (!settings.presets || typeof settings.presets !== 'object') {
            settings.presets = toParent({});
        }

        return settings;
    }

    const saveSettings = () => getContext().saveSettingsDebounced();

    function createUniqueId(exists = () => false) {
        const makeId = () => (pwin.crypto?.randomUUID?.()
            ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
        let id = makeId();

        while (exists(id)) {
            id = makeId();
        }

        return id;
    }

    // ---------- 预设数据 ----------

    function getPresetNames(oai) {
        return Object.keys(oai.openai_setting_names ?? {});
    }

    // 当前预设返回实时数据（含未保存的修改），其他预设返回已保存的数据
    function getPresetData(oai, name) {
        if (name === oai.oai_settings?.preset_settings_openai) {
            return oai.oai_settings;
        }

        return getSavedPresetData(oai, name);
    }

    function getSavedPresetData(oai, name) {
        const index = oai.openai_setting_names?.[name];
        return index === undefined ? null : oai.openai_settings?.[index] ?? null;
    }

    function getOrderList(preset) {
        const lists = preset?.prompt_order;

        if (!Array.isArray(lists) || !lists.length) {
            return null;
        }

        // 早期格式：prompt_order 直接存放条目顺序
        if (lists[0] && 'identifier' in lists[0]) {
            return lists;
        }

        const list = lists.find(item => String(item?.character_id) === GLOBAL_ORDER_ID)
            ?? lists.find(item => Array.isArray(item?.order));
        return Array.isArray(list?.order) ? list.order : null;
    }

    function getCustomIds(preset) {
        return new Set((getOrderList(preset) ?? [])
            .map(entry => entry?.identifier)
            .filter(id => id && !BUILTIN_IDS.has(id)));
    }

    function readGroupStateFromPreset(preset) {
        const value = preset?.extensions?.baibaiToolkit?.presetPromptGroups;
        return isGroupState(value) ? value : null;
    }

    function readLiveGroupState(presetName) {
        const baibai = pwin[BAIBAI_STATE_KEY];
        const value = baibai?.presetPromptGroupRuntimeState;
        return baibai?.presetPromptGroupRuntimePresetName === presetName && isGroupState(value) ? value : null;
    }

    function isGroupState(value) {
        return Boolean(value && Array.isArray(value.groups) && value.prompts && typeof value.prompts === 'object');
    }

    // 当前预设的分组数据：BaiBai 运行中的副本与预设 extensions 中的副本（可能为同一对象）
    function getCurrentGroupStates(oai) {
        const presetName = oai.oai_settings?.preset_settings_openai;
        return [...new Set([readLiveGroupState(presetName), readGroupStateFromPreset(oai.oai_settings)].filter(Boolean))];
    }

    function getGroupName(groupState, promptId) {
        const groupId = groupState?.prompts?.[promptId]?.groupId;
        return groupId ? (groupState.groups.find(group => group?.id === groupId)?.name ?? null) : null;
    }

    // ---------- 界面工具 ----------

    function injectStyle() {
        pdoc.getElementById(STYLE_ID)?.remove();

        const style = pdoc.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
.pvm-root { display: flex; flex-direction: column; gap: 10px; text-align: left; }
.pvm-head { display: flex; flex-direction: column; gap: 6px; }
.pvm-head select { width: 100%; }
.pvm-hint { opacity: 0.75; font-size: 0.9em; }
.pvm-section { border: 1px solid var(--SmartThemeBorderColor, #8884); border-radius: 8px; padding: 8px 10px; }
.pvm-section-title { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 6px; font-weight: bold; }
.pvm-section-actions { display: flex; gap: 6px; font-weight: normal; }
.pvm-section-actions .menu_button { margin: 0; padding: 2px 8px; width: auto; font-size: 0.85em; }
.pvm-item { border-top: 1px solid var(--SmartThemeBorderColor, #8884); padding: 6px 0; }
.pvm-item:first-of-type { border-top: none; }
.pvm-item label { display: flex; gap: 8px; align-items: flex-start; cursor: pointer; }
.pvm-item input[type="checkbox"] { flex: none; margin-top: 3px; }
.pvm-name { font-weight: bold; word-break: break-word; }
.pvm-meta { display: block; opacity: 0.7; font-size: 0.85em; font-weight: normal; }
.pvm-item details { margin: 4px 0 0 24px; font-size: 0.9em; }
.pvm-item summary { cursor: pointer; opacity: 0.8; }
.pvm-pre { white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow: auto; font-size: 0.85em;
    background: var(--black30a, #0002); padding: 6px; border-radius: 6px; margin: 4px 0; }
.pvm-empty { opacity: 0.7; padding: 4px 0; }

#${BAR_ID} { display: flex; flex-direction: column; gap: 6px; margin: 0 0 8px; padding: 6px 8px;
    border: 1px solid var(--SmartThemeBorderColor, #8884); border-radius: 8px; }
#${BAR_ID} .pet-bar-title { display: flex; align-items: center; gap: 6px; font-size: 0.9em; opacity: 0.85; word-break: break-word; }
#${BAR_ID} .pet-bar-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
#${BAR_ID} .pet-bar-row select { flex: 1 1 140px; min-width: 0; margin: 0; }
#${BAR_ID} .pet-bar-row .menu_button { margin: 0; width: auto; white-space: nowrap; }
#${BAR_ID} .pet-bar-chat { font-size: 0.85em; opacity: 0.85; }
#${BAR_ID} .menu_button.disabled { opacity: 0.4; pointer-events: none; }

#${PANEL_ID} .pet-panel-option { margin-top: 6px; }
#${PANEL_ID} .pet-panel-hint { opacity: 0.7; font-size: 0.85em; margin: 2px 0 0 24px; }
#${PANEL_ID} .pet-panel-select { display: flex; flex-direction: column; gap: 4px; }
#${PANEL_ID} .pet-panel-select .pet-panel-hint { margin-left: 0; }
#${PANEL_ID} .menu_button { width: auto; margin-top: 10px; }
`;
        pdoc.head.append(style);
    }

    function el(tag, attributes = {}, children = []) {
        const element = pdoc.createElement(tag);

        for (const [key, value] of Object.entries(attributes)) {
            if (key === 'text') {
                element.textContent = value;
            } else if (key === 'className') {
                element.className = value;
            } else if (value !== undefined && value !== null && value !== false) {
                element.setAttribute(key, value === true ? '' : value);
            }
        }

        element.append(...children.filter(Boolean));
        return element;
    }

    function waitFrames(count) {
        return new Promise(resolve => {
            const step = remaining => (remaining <= 0 ? resolve() : pwin.requestAnimationFrame(() => step(remaining - 1)));
            step(count);
        });
    }

    // 带「全选 / 全不选」的勾选列表
    function renderSection({ title, hint, items, renderItem, emptyText, isChecked = () => false }) {
        const boxes = [];
        const list = el('div');

        for (const item of items) {
            const box = el('input', { type: 'checkbox' });
            box.checked = isChecked(item);
            boxes.push({ box, item });
            list.append(renderItem(item, box));
        }

        const setAll = checked => boxes.forEach(({ box }) => { box.checked = checked; });
        const actions = items.length
            ? el('span', { className: 'pvm-section-actions' }, [
                el('span', { className: 'menu_button', text: '全选' }),
                el('span', { className: 'menu_button', text: '全不选' }),
            ])
            : null;

        actions?.children[0].addEventListener('click', () => setAll(true));
        actions?.children[1].addEventListener('click', () => setAll(false));

        const section = el('div', { className: 'pvm-section' }, [
            el('div', { className: 'pvm-section-title' }, [el('span', { text: `${title}（${items.length}）` }), actions]),
            hint ? el('div', { className: 'pvm-hint', text: hint }) : null,
            items.length ? list : el('div', { className: 'pvm-empty', text: emptyText }),
        ]);

        return { section, getChecked: () => boxes.filter(({ box }) => box.checked).map(({ item }) => item) };
    }

    // =====================================================================
    // 1. 双击新建
    // =====================================================================

    function getTargetRow(target) {
        const handle = target?.closest?.('.drag-handle');
        const row = handle?.closest(ROW_SELECTOR);

        // 排除 BaiBai 收藏区的镜像条目和全局库条目
        if (!row
            || row.dataset.presetFavoriteMirror === 'true'
            || row.classList.contains('bai-bai-preset-global-library-prompt')) {
            return null;
        }

        return row;
    }

    let pointerDown = null;
    let lastTap = null;
    let lastTriggerAt = 0;
    let insertBusy = false;
    // 第二次点击的按下事件不传给拖动库的截止时间。见 onPointerDown。
    let suppressGestureUntil = 0;

    function isSecondTap(row, event) {
        return Boolean(lastTap
            && lastTap.id === row.dataset.pmIdentifier
            && Date.now() - lastTap.time <= CONFIG.doubleTapMs
            && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) <= CONFIG.moveTolerance * 2);
    }

    function onPointerDown(event) {
        if (event.isPrimary === false || (event.pointerType === 'mouse' && event.button !== 0)) {
            pointerDown = null;
            return;
        }

        const row = getTargetRow(event.target);
        pointerDown = row
            ? { row, id: row.dataset.pmIdentifier, x: event.clientX, y: event.clientY, pointerId: event.pointerId }
            : null;

        // 第二次点击不传给拖动库。否则拖动库会将其视为一次拖放，
        // BaiBai 随即按其列表模型重写条目顺序；若此时新条目已插入而模型尚未更新，新条目会被移出顺序。
        if (row && getSettings().doubleTapEnabled && isSecondTap(row, event)) {
            suppressGestureUntil = Date.now() + 800;
            event.stopImmediatePropagation();
        }
    }

    // 拖动库在部分浏览器上监听 touchstart 或 mousedown 而非 pointerdown，同样拦截
    function onLegacyPointerStart(event) {
        if (Date.now() < suppressGestureUntil && getTargetRow(event.target)) {
            event.stopImmediatePropagation();
        }
    }

    function onPointerUp(event) {
        const down = pointerDown;
        pointerDown = null;

        if (!down || event.pointerId !== down.pointerId) {
            return;
        }

        if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > CONFIG.moveTolerance) {
            lastTap = null;
            return;
        }

        const now = Date.now();

        if (lastTap
            && lastTap.id === down.id
            && now - lastTap.time <= CONFIG.doubleTapMs
            && Math.hypot(down.x - lastTap.x, down.y - lastTap.y) <= CONFIG.moveTolerance * 2) {
            lastTap = null;
            triggerInsert(down.row);
            return;
        }

        lastTap = { id: down.id, time: now, x: down.x, y: down.y };
    }

    function onPointerCancel() {
        pointerDown = null;
        lastTap = null;
    }

    // 备用触发方式：pointer 事件被其他脚本拦截时，使用浏览器的 dblclick 事件
    function onDoubleClick(event) {
        const row = getTargetRow(event.target);

        if (row) {
            triggerInsert(row);
        }
    }

    function triggerInsert(row) {
        const now = Date.now();

        if (!getSettings().doubleTapEnabled || now - lastTriggerAt < 600) {
            return;
        }

        lastTriggerAt = now;
        pwin.getSelection?.()?.removeAllRanges?.();
        void insertPromptAfter(row.dataset.pmIdentifier, row.dataset.presetGroupId || '');
    }

    async function insertPromptAfter(sourceId, groupIdFromRow) {
        if (insertBusy) {
            return;
        }

        insertBusy = true;

        try {
            const oai = await loadOpenAi();
            const pm = oai.promptManager;

            if (!pm?.activeCharacter || !Array.isArray(pm.serviceSettings?.prompts)) {
                notify?.warning('预设管理器尚未就绪，请稍后重试。');
                return;
            }

            await waitForBaiBaiDragIdle();

            const order = pm.getPromptOrderForCharacter(pm.activeCharacter);
            const orderIndex = Array.isArray(order) ? order.findIndex(entry => entry?.identifier === sourceId) : -1;

            if (orderIndex < 0) {
                notify?.warning('该条目不在当前条目列表中。');
                return;
            }

            const id = createUniqueId(candidate => Boolean(pm.getPromptById?.(candidate)));
            const prompt = toParent({
                identifier: id,
                name: createUniquePromptName(pm),
                role: 'system',
                content: '',
                system_prompt: false,
                marker: false,
                injection_position: 0,
                injection_depth: 4,
                injection_order: 100,
                injection_trigger: [],
                forbid_overrides: false,
            });
            const promptIndex = pm.serviceSettings.prompts.findIndex(item => item?.identifier === sourceId);

            if (promptIndex >= 0) {
                pm.serviceSettings.prompts.splice(promptIndex + 1, 0, prompt);
            } else {
                pm.serviceSettings.prompts.push(prompt);
            }

            order.splice(orderIndex + 1, 0, toParent({ identifier: id, enabled: true }));

            const groupId = assignDoubleTapGroup(oai, sourceId, id, groupIdFromRow);
            const counts = pm.tokenHandler?.getCounts?.();

            if (counts && typeof counts === 'object') {
                counts[id] = null;
            }

            pm.log?.(`Double-tap created prompt: ${id} after ${sourceId}`);

            // BaiBai 在重新渲染时将分组数据同步到预设 extensions，因此先渲染后保存
            await pm.render?.();
            await waitFrames(2);
            // 该 Promise 在设置保存完成后才结束，保存失败时不会结束，因此不等待
            void pm.saveServiceSettings?.();

            if (CONFIG.autoSavePreset) {
                pdoc.getElementById('update_oai_preset')?.click();
            }

            guardInsertedPrompt(oai, id, sourceId, groupId);

            const newRow = await waitForRow(id);
            newRow?.scrollIntoView?.({ block: 'nearest' });

            if (CONFIG.openEditor) {
                openEditor(pm, prompt, newRow);
            }
        } catch (error) {
            console.error('[预设条目工具] 新建条目失败', error);
            notify?.error('新建条目失败。详细信息见浏览器控制台。');
        } finally {
            insertBusy = false;
        }
    }

    // 将新条目加入被双击条目所在的 BaiBai 分组，返回分组 id
    function assignDoubleTapGroup(oai, sourceId, newId, groupIdFromRow) {
        const groupState = readLiveGroupState(oai.oai_settings?.preset_settings_openai || 'current');

        // 仅当 BaiBai 分组功能启用并按分组渲染列表时，条目行上才有 data-preset-group-id
        if (!groupState || !groupIdFromRow || groupState.prompts[sourceId]?.groupId !== groupIdFromRow) {
            return null;
        }

        const group = groupState.groups.find(item => item?.id === groupIdFromRow);

        if (!group) {
            return null;
        }

        groupState.prompts[newId] = toParent({ groupId: groupIdFromRow });
        return groupIdFromRow;
    }

    // 等待 BaiBai 的拖动及其顺序保存结束，最长 1.5 秒
    async function waitForBaiBaiDragIdle() {
        const deadline = Date.now() + 1500;

        do {
            await waitFrames(2);

            const manager = pwin[BAIBAI_STATE_KEY]?.[BAIBAI_VUE_LIST_KEY];
            const busy = Boolean(manager?.state?.dragging
                || manager?.saveTimer != null
                || manager?.saveFrame != null);

            if (!busy) {
                return;
            }
        } while (Date.now() < deadline);
    }

    // 新建后的 3 秒内检查新条目是否仍在顺序中。若被其他脚本移出，按原位置放回。
    function guardInsertedPrompt(oai, id, sourceId, groupId) {
        const check = () => {
            const pm = oai.promptManager;
            const order = pm.getPromptOrderForCharacter(pm.activeCharacter);

            if (!pm.getPromptById?.(id) || order.some(entry => entry?.identifier === id)) {
                return;
            }

            const sourceIndex = order.findIndex(entry => entry?.identifier === sourceId);
            order.splice(sourceIndex >= 0 ? sourceIndex + 1 : order.length, 0, toParent({ identifier: id, enabled: true }));

            const groupState = readLiveGroupState(oai.oai_settings?.preset_settings_openai || 'current');

            if (groupId && groupState?.groups.some(group => group?.id === groupId)) {
                groupState.prompts[id] = toParent({ groupId });
            }

            console.warn('[预设条目工具] 新条目被移出顺序，已放回原位置', id);
            pm.render?.();
            void pm.saveServiceSettings?.();
        };

        [300, 1000, 3000].forEach(delay => pwin.setTimeout(check, delay));
    }

    function openEditor(pm, prompt, row) {
        const editButton = row?.querySelector('[data-preset-prompt-action="edit"], .prompt-manager-edit-action');

        if (editButton) {
            editButton.click();
            return;
        }

        try {
            pm.clearEditForm?.();
            pm.loadPromptIntoEditForm?.(prompt);
            pm.showPopup?.();
        } catch (error) {
            console.debug('[预设条目工具] 打开编辑窗口失败', error);
        }
    }

    function createUniquePromptName(pm) {
        const names = new Set((pm.serviceSettings?.prompts ?? []).map(item => item?.name));
        const base = CONFIG.newPromptName;

        if (!names.has(base)) {
            return base;
        }

        for (let index = 2; index < 1000; index++) {
            if (!names.has(`${base} ${index}`)) {
                return `${base} ${index}`;
            }
        }

        return `${base} ${Date.now()}`;
    }

    async function waitForRow(id, timeoutMs = 1500) {
        const selector = `${ROW_SELECTOR}[data-pm-identifier="${pwin.CSS?.escape ? pwin.CSS.escape(id) : id}"]`;
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const row = pdoc.querySelector(selector);

            if (row) {
                return row;
            }

            await waitFrames(1);
        }

        return null;
    }

    // =====================================================================
    // 2. 版本对比
    // =====================================================================

    // 去除名称中的版本号与版本标记，用于判断两个预设是否为同一预设的不同版本
    function getVersionlessName(name) {
        return String(name ?? '')
            .normalize('NFKC')
            .toLowerCase()
            .replace(/(?:version|ver|v)\s*[._-]?\s*\d+(?:\s*[._-]\s*\d+)*[a-z]?/g, ' ')
            .replace(/\d+(?:[._-]\d+)*/g, ' ')
            .replace(/beta|alpha|test|fixed|fix|final|latest|测试版?|修复版?|最终版?|正式版?|最新版?|更新版?|新版|旧版|版本/g, ' ')
            .replace(/[\s\p{P}\p{S}]+/gu, '');
    }

    function rankCandidates(oai, targetName, targetPreset, excludeName) {
        const targetBase = getVersionlessName(targetName);
        const targetCustomIds = getCustomIds(targetPreset);
        const candidates = [];

        for (const name of getPresetNames(oai)) {
            if (name === excludeName) {
                continue;
            }

            const preset = getPresetData(oai, name);

            if (!Array.isArray(preset?.prompts)) {
                continue;
            }

            const customIds = getCustomIds(preset);
            const shared = [...customIds].filter(id => targetCustomIds.has(id)).length;
            const ratio = shared / Math.max(1, Math.min(customIds.size, targetCustomIds.size));
            const sameName = name === targetName;
            const sameBase = Boolean(targetBase) && getVersionlessName(name) === targetBase;
            const similar = shared >= CONFIG.minSharedCustomPrompts && ratio >= CONFIG.minOverlapRatio;

            candidates.push({
                name,
                likely: sameName || sameBase || similar,
                score: (sameName ? 3000 : 0) + (sameBase ? 2000 : 0) + ratio * 1000 + shared,
                reason: sameName ? '同名预设' : sameBase ? '名称仅版本号不同' : similar ? `${shared} 个相同条目` : '',
            });
        }

        // 得分相同时，版本号较大的排在前面
        return candidates.sort((a, b) => b.score - a.score
            || b.name.localeCompare(a.name, undefined, { numeric: true }));
    }

    function normalizeField(prompt, field) {
        const value = prompt?.[field] ?? COMPARE_FIELDS[field];
        return field === 'content' ? String(value).trim() : JSON.stringify(value);
    }

    function getDifferentFields(oldPrompt, newPrompt) {
        return Object.keys(COMPARE_FIELDS).filter(field => normalizeField(oldPrompt, field) !== normalizeField(newPrompt, field));
    }

    // 条目先按 identifier 匹配，未匹配时按名称匹配
    function buildDiff(oldPreset, oldGroupState, target) {
        const oldOrder = getOrderList(oldPreset) ?? [];
        const oldPrompts = new Map((oldPreset.prompts ?? []).filter(p => p?.identifier).map(p => [p.identifier, p]));
        const newById = new Map(target.prompts.filter(p => p?.identifier).map(p => [p.identifier, p]));
        const newByName = new Map();

        for (const prompt of target.prompts) {
            if (prompt?.name && !newByName.has(prompt.name)) {
                newByName.set(prompt.name, prompt);
            }
        }

        const matchOf = new Map();
        const added = [];
        const changed = [];

        oldOrder.forEach((entry, oldIndex) => {
            const oldPrompt = oldPrompts.get(entry?.identifier);

            if (!oldPrompt) {
                return;
            }

            const newPrompt = newById.get(oldPrompt.identifier) ?? (oldPrompt.name ? newByName.get(oldPrompt.name) : undefined);

            if (newPrompt) {
                matchOf.set(oldPrompt.identifier, newPrompt.identifier);

                const fields = oldPrompt.marker || newPrompt.marker ? [] : getDifferentFields(oldPrompt, newPrompt);

                if (fields.length) {
                    changed.push({ oldPrompt, newPrompt, fields });
                }

                return;
            }

            added.push({
                prompt: oldPrompt,
                enabled: entry.enabled !== false,
                oldIndex,
                oldGroupName: getGroupName(oldGroupState, oldPrompt.identifier),
                afterName: findPreviousName(oldOrder, oldPrompts, oldIndex),
            });
        });

        return { oldOrder, matchOf, added, changed };
    }

    function findPreviousName(oldOrder, oldPrompts, oldIndex) {
        for (let index = oldIndex - 1; index >= 0; index--) {
            const prompt = oldPrompts.get(oldOrder[index]?.identifier);

            if (prompt) {
                return prompt.name || prompt.identifier;
            }
        }

        return null;
    }

    // 插入位置：旧版本中位于其前方、且新预设中也存在的最近条目之后；
    // 前方没有此类条目时，插入到后方最近条目之前；都没有时追加到末尾。
    function findInsertIndex(diff, oldIndex, order) {
        const positionOf = oldId => {
            const id = diff.matchOf.get(oldId) ?? oldId;
            return order.findIndex(entry => entry?.identifier === id);
        };

        for (let index = oldIndex - 1; index >= 0; index--) {
            const position = positionOf(diff.oldOrder[index]?.identifier);

            if (position >= 0) {
                return position + 1;
            }
        }

        for (let index = oldIndex + 1; index < diff.oldOrder.length; index++) {
            const position = positionOf(diff.oldOrder[index]?.identifier);

            if (position >= 0) {
                return position;
            }
        }

        return order.length;
    }

    // 分组规则：前后条目属于同一分组时加入该分组；
    // 位于分组边界时，仅当旧版本中所属分组与相邻分组同名才加入。
    function assignMigratedGroup(target, position, promptId, oldGroupName) {
        const primary = target.groupStates[0];

        if (!primary) {
            return null;
        }

        const groupIdAt = index => primary.prompts[target.order[index]?.identifier]?.groupId ?? null;
        const groupNameOf = groupId => primary.groups.find(group => group?.id === groupId)?.name ?? null;
        const previousGroupId = position > 0 ? groupIdAt(position - 1) : null;
        const nextGroupId = groupIdAt(position + 1);
        let groupId = null;

        if (previousGroupId && previousGroupId === nextGroupId) {
            groupId = previousGroupId;
        } else if (oldGroupName && previousGroupId && groupNameOf(previousGroupId) === oldGroupName) {
            groupId = previousGroupId;
        } else if (oldGroupName && nextGroupId && groupNameOf(nextGroupId) === oldGroupName) {
            groupId = nextGroupId;
        }

        if (!groupId) {
            return null;
        }

        for (const groupState of target.groupStates) {
            if (groupState.groups.some(group => group?.id === groupId)) {
                groupState.prompts[promptId] = toParent({ groupId });
            }
        }

        return groupNameOf(groupId);
    }

    function applyMigration(diff, selection, target) {
        const selectedAdded = new Set(selection.added);
        const insertedIds = [];

        // 按旧版本顺序依次插入，使连续的多个条目保持原有先后顺序
        for (const item of diff.added) {
            if (!selectedAdded.has(item)) {
                continue;
            }

            const id = item.prompt.identifier;
            const position = findInsertIndex(diff, item.oldIndex, target.order);
            target.prompts.push(toParent(item.prompt));
            target.order.splice(position, 0, toParent({ identifier: id, enabled: item.enabled }));
            assignMigratedGroup(target, position, id, item.oldGroupName);
            insertedIds.push(id);
        }

        for (const { oldPrompt, newPrompt } of selection.changed) {
            for (const field of Object.keys(COMPARE_FIELDS)) {
                if (field in oldPrompt) {
                    newPrompt[field] = toParent(oldPrompt[field]);
                } else {
                    delete newPrompt[field];
                }
            }
        }

        return { insertedIds, replaced: selection.changed.length };
    }

    function preview(text) {
        const value = String(text ?? '');

        if (!value.trim()) {
            return '（空）';
        }

        return value.length > CONFIG.previewChars
            ? `${value.slice(0, CONFIG.previewChars)}…（另有 ${value.length - CONFIG.previewChars} 字未显示）`
            : value;
    }

    function renderAddedItem(item, box) {
        const meta = [
            item.afterName ? `位置：「${item.afterName}」之后` : '位置：列表开头',
            item.oldGroupName ? `分组：${item.oldGroupName}` : '',
            item.enabled ? '' : '旧版本中为关闭状态',
        ].filter(Boolean).join(' · ');

        return el('div', { className: 'pvm-item' }, [
            el('label', {}, [
                box,
                el('span', {}, [
                    el('span', { className: 'pvm-name', text: item.prompt.name || item.prompt.identifier }),
                    el('span', { className: 'pvm-meta', text: meta }),
                ]),
            ]),
            item.prompt.marker ? null : el('details', {}, [
                el('summary', { text: '查看内容' }),
                el('div', { className: 'pvm-pre', text: preview(item.prompt.content) }),
            ]),
        ]);
    }

    function renderChangedItem(item, box) {
        const meta = [
            `差异：${item.fields.map(field => FIELD_LABELS[field]).join('、')}`,
            item.oldPrompt.name !== item.newPrompt.name ? `新版本名称：${item.newPrompt.name}` : '',
        ].filter(Boolean).join(' · ');

        return el('div', { className: 'pvm-item' }, [
            el('label', {}, [
                box,
                el('span', {}, [
                    el('span', { className: 'pvm-name', text: item.oldPrompt.name || item.oldPrompt.identifier }),
                    el('span', { className: 'pvm-meta', text: meta }),
                ]),
            ]),
            el('details', {}, [
                el('summary', { text: '对比内容' }),
                el('div', { className: 'pvm-hint', text: '旧版本：' }),
                el('div', { className: 'pvm-pre', text: preview(item.oldPrompt.content) }),
                el('div', { className: 'pvm-hint', text: '新版本：' }),
                el('div', { className: 'pvm-pre', text: preview(item.newPrompt.content) }),
            ]),
        ]);
    }

    // 显示对比窗口。确认时返回 { diff, selection, oldName }，取消时返回 null。
    async function showCompareDialog({ mode, targetName, target, candidates, getOldPreset }) {
        const { callGenericPopup, POPUP_TYPE, POPUP_RESULT } = await loadPopup();
        const root = el('div', { className: 'pvm-root' });
        const select = el('select', { className: 'text_pole' });

        for (const candidate of candidates) {
            select.append(el('option', {
                value: candidate.name,
                text: candidate.reason ? `${candidate.name}（${candidate.reason}）` : candidate.name,
            }));
        }

        const sectionsHost = el('div', { className: 'pvm-root' });
        let current = null;

        const renderLists = () => {
            const oldName = select.value;
            const { preset, groupState } = getOldPreset(oldName);
            const diff = buildDiff(preset, groupState, target);
            const addedSection = renderSection({
                title: '仅存在于旧版本的条目',
                hint: '勾选的条目将插入新预设中与旧版本相同的位置。',
                items: diff.added,
                renderItem: renderAddedItem,
                emptyText: '无。',
            });
            const changedSection = renderSection({
                title: '两个版本中设置不同的条目',
                hint: '勾选的条目将以旧版本的设置覆盖新版本。',
                items: diff.changed,
                renderItem: renderChangedItem,
                emptyText: '无。',
            });

            sectionsHost.replaceChildren(addedSection.section, changedSection.section);
            current = { oldName, diff, addedSection, changedSection };
        };

        select.addEventListener('change', renderLists);

        root.append(
            el('div', { className: 'pvm-head' }, [
                el('div', { className: 'pvm-name', text: mode === 'import' ? `导入预设：${targetName}` : `当前预设：${targetName}` }),
                el('div', { className: 'pvm-hint', text: '对比对象（旧版本预设）：' }),
                select,
                el('div', {
                    className: 'pvm-hint',
                    text: mode === 'import'
                        ? '确认后，所选条目将合并到正在导入的预设中，并随导入一同保存。旧版本预设不受影响。'
                        : '确认后，所选条目将添加到当前预设。预设不会自动保存，请检查后手动保存。',
                }),
            ]),
            sectionsHost,
        );

        renderLists();

        const result = await callGenericPopup(root, POPUP_TYPE.CONFIRM, '', {
            okButton: '导入所选条目',
            cancelButton: mode === 'import' ? '跳过，直接导入' : '取消',
            wide: true,
            allowVerticalScrolling: true,
            leftAlign: true,
        });

        if (result !== POPUP_RESULT.AFFIRMATIVE || !current) {
            return null;
        }

        const selection = {
            added: current.addedSection.getChecked(),
            changed: current.changedSection.getChecked(),
        };

        if (!selection.added.length && !selection.changed.length) {
            return null;
        }

        return { diff: current.diff, selection, oldName: current.oldName };
    }

    function makeOldPresetGetter(oai) {
        return name => {
            const preset = getPresetData(oai, name);
            const live = name === oai.oai_settings?.preset_settings_openai ? readLiveGroupState(name) : null;
            return { preset, groupState: live ?? readGroupStateFromPreset(preset) };
        };
    }

    function describeMigration({ insertedIds, replaced }) {
        return [
            insertedIds.length ? `导入 ${insertedIds.length} 个条目` : '',
            replaced ? `覆盖 ${replaced} 个条目的设置` : '',
        ].filter(Boolean).join('，');
    }

    let compareBusy = false;

    // 在 SillyTavern 保存导入的预设之前执行，修改 event.data 即修改将要保存的内容
    async function onPresetImportReady(event) {
        if (!getSettings().importCompareEnabled || compareBusy) {
            return;
        }

        const data = event?.data;
        const newName = event?.presetName;
        const order = getOrderList(data);

        if (!newName || !Array.isArray(data?.prompts) || !order) {
            return;
        }

        compareBusy = true;

        try {
            const oai = await loadOpenAi();
            const candidates = rankCandidates(oai, newName, data, null);

            if (!candidates[0]?.likely) {
                return;
            }

            const target = {
                prompts: data.prompts,
                order,
                groupStates: [readGroupStateFromPreset(data)].filter(Boolean),
            };
            const getOldPreset = makeOldPresetGetter(oai);
            const firstDiff = buildDiff(getOldPreset(candidates[0].name).preset, null, target);

            if (!firstDiff.added.length && !firstDiff.changed.length) {
                notify?.info(`「${newName}」与旧版本「${candidates[0].name}」的条目没有差异。`);
                return;
            }

            const result = await showCompareDialog({ mode: 'import', targetName: newName, target, candidates, getOldPreset });

            if (!result) {
                return;
            }

            const summary = applyMigration(result.diff, result.selection, target);
            notify?.success(`已从「${result.oldName}」${describeMigration(summary)}。`);
        } catch (error) {
            console.error('[预设条目工具] 版本对比失败', error);
            notify?.error('版本对比失败，本次按原样导入。详细信息见浏览器控制台。');
        } finally {
            compareBusy = false;
        }
    }

    async function compareWithOldPreset() {
        if (compareBusy) {
            return;
        }

        compareBusy = true;

        try {
            const oai = await loadOpenAi();
            const pm = oai.promptManager;
            const currentName = oai.oai_settings?.preset_settings_openai;

            if (!pm?.activeCharacter || !currentName || !Array.isArray(oai.oai_settings?.prompts)) {
                notify?.warning('预设管理器尚未就绪，请稍后重试。');
                return;
            }

            const candidates = rankCandidates(oai, currentName, oai.oai_settings, currentName);

            if (!candidates.length) {
                notify?.warning('没有其他预设可供对比。');
                return;
            }

            const target = {
                prompts: oai.oai_settings.prompts,
                order: pm.getPromptOrderForCharacter(pm.activeCharacter),
                groupStates: getCurrentGroupStates(oai),
            };
            const result = await showCompareDialog({
                mode: 'manual',
                targetName: currentName,
                target,
                candidates,
                getOldPreset: makeOldPresetGetter(oai),
            });

            if (!result) {
                return;
            }

            const summary = applyMigration(result.diff, result.selection, target);
            const counts = pm.tokenHandler?.getCounts?.();

            for (const id of summary.insertedIds) {
                if (counts && typeof counts === 'object') {
                    counts[id] = null;
                }
            }

            await pm.render?.();
            void pm.saveServiceSettings?.();
            notify?.success(`已从「${result.oldName}」${describeMigration(summary)}。当前预设尚未保存。`);
        } catch (error) {
            console.error('[预设条目工具] 版本对比失败', error);
            notify?.error('版本对比失败。详细信息见浏览器控制台。');
        } finally {
            compareBusy = false;
        }
    }

    // =====================================================================
    // 3. 条目方案
    // =====================================================================
    // 数据位置：extension_settings.presetEntryTools.presets[预设名称]
    //   profiles:          { 方案 id: { name, owner, ownerName, entries: { 条目 id: 开关 }, groups: { 分组 id: 开关 } } }
    //   characterBindings: { 角色 key: 方案 id }
    //   chatBindings:      { 角色 key::聊天存档 id: 方案 id，或 '' 表示该存档不使用方案 }
    //
    // 套用规则：
    //   目标开关 = 默认值，再以方案中记录的开关覆盖。
    //   默认值由设置 defaultSource 决定：
    //     'saved'    预设上次保存的开关；
    //     'previous' 保持切换前的开关（即不修改）。
    //   未使用方案时，目标开关即为默认值。
    //   当前预设没有任何方案时，不修改开关。
    //   设置 autoApply 关闭时，切换时不套用，仅在方案栏点击「套用」或在下拉框中选择方案时套用。

    let oaiModule = null;
    // 每次套用递增。弹窗关闭时若该值已变化，说明期间切换过角色、聊天存档或预设，弹窗结果作废。
    let applySequence = 0;
    let newEntryDialogOpen = false;

    function getChatScope() {
        const context = getContext();
        const chatId = context.getCurrentChatId?.() || null;

        if (context.groupId) {
            const group = context.groups?.find(item => String(item?.id) === String(context.groupId));
            return { key: `group:${context.groupId}`, name: group?.name || '群聊', chatId };
        }

        const character = context.characters?.[context.characterId];

        if (!character?.avatar) {
            return null;
        }

        return { key: `char:${character.avatar}`, name: character.name || character.avatar, chatId };
    }

    function getPresetStore(presetName, create = true) {
        const presets = getSettings().presets;

        if (!presets[presetName]) {
            if (!create) {
                return null;
            }

            presets[presetName] = toParent({});
        }

        const store = presets[presetName];

        for (const key of ['profiles', 'characterBindings', 'chatBindings']) {
            if (!store[key] || typeof store[key] !== 'object') {
                store[key] = toParent({});
            }
        }

        return store;
    }

    const getChatBindingKey = scope => (scope.chatId ? `${scope.key}::${scope.chatId}` : null);

    // 聊天存档的绑定优先于角色的绑定
    function getBinding(store, scope) {
        const chatKey = getChatBindingKey(scope);
        const chatLevel = Boolean(chatKey && Object.hasOwn(store.chatBindings, chatKey));
        const profileId = chatLevel ? store.chatBindings[chatKey] : store.characterBindings[scope.key];
        return { profileId: profileId && store.profiles[profileId] ? profileId : '', chatLevel };
    }

    function setBinding(store, scope, profileId, chatLevel) {
        const chatKey = getChatBindingKey(scope);

        if (chatLevel && chatKey) {
            store.chatBindings[chatKey] = profileId;
        } else if (profileId) {
            store.characterBindings[scope.key] = profileId;
        } else {
            delete store.characterBindings[scope.key];
        }
    }

    function captureStates(oai) {
        const pm = oai.promptManager;
        const entries = {};
        const groups = {};

        for (const entry of pm.getPromptOrderForCharacter(pm.activeCharacter)) {
            if (entry?.identifier) {
                entries[entry.identifier] = entry.enabled !== false;
            }
        }

        for (const group of getCurrentGroupStates(oai)[0]?.groups ?? []) {
            if (group?.id) {
                groups[group.id] = group.enabled !== false;
            }
        }

        return { entries, groups };
    }

    // 仅修改 states 中列出的条目和分组，返回发生变化的数量
    function applyStates(oai, { entries = {}, groups = {} }) {
        const pm = oai.promptManager;
        let changed = 0;

        for (const entry of pm.getPromptOrderForCharacter(pm.activeCharacter)) {
            const id = entry?.identifier;

            if (id && Object.hasOwn(entries, id) && (entry.enabled !== false) !== entries[id]) {
                entry.enabled = entries[id];
                changed++;
            }
        }

        const changedGroups = new Set();

        for (const groupState of getCurrentGroupStates(oai)) {
            for (const group of groupState.groups) {
                if (group?.id && Object.hasOwn(groups, group.id) && (group.enabled !== false) !== groups[group.id]) {
                    group.enabled = groups[group.id];
                    changedGroups.add(group.id);
                }
            }
        }

        changed += changedGroups.size;

        if (changed) {
            pm.render?.();
            void pm.saveServiceSettings?.();
        }

        return changed;
    }

    // 预设上次保存的开关，不含未保存的修改
    function getSavedStates(oai, presetName) {
        const saved = getSavedPresetData(oai, presetName);

        if (!saved) {
            return null;
        }

        const entries = {};
        const groups = {};

        for (const entry of getOrderList(saved) ?? []) {
            if (entry?.identifier) {
                entries[entry.identifier] = entry.enabled !== false;
            }
        }

        for (const group of readGroupStateFromPreset(saved)?.groups ?? []) {
            if (group?.id) {
                groups[group.id] = group.enabled !== false;
            }
        }

        return { entries, groups };
    }

    function getTargetStates(oai, presetName, profile) {
        const defaults = getSettings().defaultSource === 'saved' ? getSavedStates(oai, presetName) : null;
        return {
            entries: { ...defaults?.entries, ...profile?.entries },
            groups: { ...defaults?.groups, ...profile?.groups },
        };
    }

    // 当前列表中有、但方案中没有开关记录的条目
    function getUnrecordedEntries(oai, profile) {
        const pm = oai.promptManager;
        const recorded = profile.entries ?? {};

        return pm.getPromptOrderForCharacter(pm.activeCharacter)
            .filter(entry => entry?.identifier && !Object.hasOwn(recorded, entry.identifier))
            .map(entry => ({
                id: entry.identifier,
                name: pm.getPromptById?.(entry.identifier)?.name || entry.identifier,
                enabled: entry.enabled !== false,
            }));
    }

    function getProfileState() {
        const oai = oaiModule;
        const presetName = oai?.oai_settings?.preset_settings_openai;
        const scope = getChatScope();
        const ready = Boolean(oai?.promptManager?.activeCharacter && presetName && scope);
        return { oai, presetName, scope, ready, store: ready ? getPresetStore(presetName, false) : null };
    }

    // announce：开关有变化时提示；manual：由用户操作触发，无论有无变化都提示结果
    async function applyProfileForCurrentChat({ announce = true, manual = false } = {}) {
        const sequence = ++applySequence;
        const settings = getSettings();
        const { oai, presetName, scope, ready, store } = getProfileState();

        if (!settings.profilesEnabled || !ready) {
            return;
        }

        // 当前预设没有任何方案时不做处理，以免影响不使用本功能时的手动开关
        if (!store || !Object.keys(store.profiles).length) {
            if (manual) {
                notify?.info('当前预设没有方案，条目开关未修改。');
            }

            return;
        }

        const { profileId } = getBinding(store, scope);
        const profile = profileId ? store.profiles[profileId] : null;
        const changed = applyStates(oai, getTargetStates(oai, presetName, profile));

        if (!profile) {
            if (manual) {
                notify?.info(changed ? `已按默认值设置 ${changed} 项开关。` : '条目开关已是默认值，未修改。');
            }

            return;
        }

        if (manual || (changed && announce)) {
            notify?.info(changed ? `已套用条目方案「${profile.name}」，修改 ${changed} 项开关。` : `条目开关与方案「${profile.name}」一致，未修改。`);
        }

        const unrecorded = getUnrecordedEntries(oai, profile);

        if (!unrecorded.length || !settings.confirmNewEntries || newEntryDialogOpen) {
            return;
        }

        const decisions = await askUnrecordedEntries(profile, unrecorded);

        if (!decisions || sequence !== applySequence || getPresetStore(presetName, false)?.profiles[profileId] !== profile) {
            return;
        }

        profile.entries ??= toParent({});
        Object.assign(profile.entries, toParent(decisions));
        profile.updatedAt = Date.now();
        saveSettings();
        applyStates(oai, { entries: decisions });
        notify?.success(`已将 ${unrecorded.length} 个条目的开关写入方案「${profile.name}」。`);
    }

    // 逐项确认未记录条目的开关。确认时返回 { 条目 id: 开关 }，取消时返回 null。
    async function askUnrecordedEntries(profile, unrecorded) {
        const { callGenericPopup, POPUP_TYPE, POPUP_RESULT } = await loadPopup();
        newEntryDialogOpen = true;

        try {
            const section = renderSection({
                title: '未记录的条目',
                hint: '勾选表示开启。当前勾选状态为默认值。',
                items: unrecorded,
                isChecked: item => item.enabled,
                renderItem: (item, box) => el('div', { className: 'pvm-item' }, [
                    el('label', {}, [box, el('span', { className: 'pvm-name', text: item.name })]),
                ]),
                emptyText: '无。',
            });
            const root = el('div', { className: 'pvm-root' }, [
                el('div', { className: 'pvm-name', text: `条目方案：${profile.name}` }),
                el('div', {
                    className: 'pvm-hint',
                    text: '该方案中没有以下条目的开关记录，通常是方案保存后新增的条目。'
                        + '选择「写入方案」后，勾选结果将保存到该方案，之后切换时不再询问；'
                        + '选择「暂不写入」则本次使用默认值，下次切换时再次询问。',
                }),
                section.section,
            ]);
            const result = await callGenericPopup(root, POPUP_TYPE.CONFIRM, '', {
                okButton: '写入方案',
                cancelButton: '暂不写入',
                allowVerticalScrolling: true,
                leftAlign: true,
            });

            if (result !== POPUP_RESULT.AFFIRMATIVE) {
                return null;
            }

            const checked = new Set(section.getChecked());
            return Object.fromEntries(unrecorded.map(item => [item.id, checked.has(item)]));
        } finally {
            newEntryDialogOpen = false;
        }
    }

    function buildProfileBar() {
        const title = el('span', { className: 'pet-bar-who' });
        const select = el('select', { className: 'text_pole pet-bar-select', title: '切换到本角色时自动套用的条目方案' });
        const saveButton = el('div', { className: 'menu_button pet-bar-save', title: '将当前的条目开关保存为本角色的方案' }, [
            el('i', { className: 'fa-solid fa-floppy-disk' }),
            el('span', { text: ' 当前角色保存为…' }),
        ]);
        const applyButton = el('div', { className: 'menu_button pet-bar-apply', title: '按当前绑定套用条目开关' }, [
            el('i', { className: 'fa-solid fa-check' }),
            el('span', { text: ' 套用' }),
        ]);
        const deleteButton = el('div', { className: 'menu_button pet-bar-delete fa-solid fa-trash-can', title: '删除所选方案' });
        const chatBox = el('input', { type: 'checkbox' });
        const bar = el('div', { id: BAR_ID }, [
            el('div', { className: 'pet-bar-title' }, [el('i', { className: 'fa-solid fa-masks-theater' }), title]),
            el('div', { className: 'pet-bar-row' }, [select, applyButton, saveButton, deleteButton]),
            el('label', {
                className: 'checkbox_label pet-bar-chat',
                title: '勾选：下拉框中的选择仅绑定到当前聊天存档。不勾选：绑定到角色，适用于该角色所有未单独绑定的聊天存档。',
            }, [chatBox, el('span', { text: '仅绑定到当前聊天存档（不勾选则绑定到角色）' })]),
        ]);

        select.addEventListener('change', () => onProfileSelected(select.value, chatBox.checked));
        chatBox.addEventListener('change', () => onChatLevelToggled(chatBox.checked, select.value));
        applyButton.addEventListener('click', () => void applyProfileForCurrentChat({ manual: true }));
        saveButton.addEventListener('click', () => void saveCurrentAsProfile(select.value, chatBox.checked));
        deleteButton.addEventListener('click', () => void deleteProfile(select.value));

        return bar;
    }

    function updateProfileBar(bar = pdoc.getElementById(BAR_ID)) {
        if (!bar) {
            return;
        }

        const { presetName, scope, ready, store } = getProfileState();
        const select = bar.querySelector('.pet-bar-select');
        const chatBox = bar.querySelector('.pet-bar-chat input');
        const binding = ready && store ? getBinding(store, scope) : { profileId: '', chatLevel: false };

        bar.querySelector('.pet-bar-who').textContent = ready
            ? `条目方案 · ${scope.name}`
            : '条目方案（需要打开角色聊天）';

        select.replaceChildren(el('option', { value: '', text: '不使用方案（按默认值）' }));

        if (ready && store) {
            const profiles = Object.entries(store.profiles)
                .sort(([, a], [, b]) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
            const own = profiles.filter(([, profile]) => profile.owner === scope.key);
            const others = profiles.filter(([, profile]) => profile.owner !== scope.key);

            if (own.length) {
                select.append(el('optgroup', { label: '本角色的方案' },
                    own.map(([id, profile]) => el('option', { value: id, text: profile.name }))));
            }

            if (others.length) {
                select.append(el('optgroup', { label: '其他角色的方案' },
                    others.map(([id, profile]) => el('option', { value: id, text: `${profile.name}（${profile.ownerName}）` }))));
            }
        }

        select.value = binding.profileId;
        select.disabled = !ready;
        chatBox.checked = binding.chatLevel;
        chatBox.disabled = !ready || !scope.chatId;
        // 「套用」按钮仅在关闭自动套用时显示
        bar.querySelector('.pet-bar-apply').style.display = getSettings().autoApply ? 'none' : '';
        bar.querySelector('.pet-bar-apply').classList.toggle('disabled', !ready);
        bar.querySelector('.pet-bar-save').classList.toggle('disabled', !ready);
        bar.querySelector('.pet-bar-delete').classList.toggle('disabled', !ready || !binding.profileId);
        bar.title = presetName ? `方案按预设分别保存。当前预设：${presetName}` : '';
    }

    function bindingTargetText(chatLevel) {
        return chatLevel ? '打开此聊天存档' : '切换到本角色';
    }

    function onProfileSelected(profileId, chatLevel) {
        const { presetName, scope, ready } = getProfileState();

        if (!ready) {
            return;
        }

        const store = getPresetStore(presetName);
        setBinding(store, scope, profileId, chatLevel);
        saveSettings();
        updateProfileBar();

        if (profileId) {
            notify?.success(`已套用方案「${store.profiles[profileId].name}」。${bindingTargetText(chatLevel)}时将自动套用。`);
        }

        void applyProfileForCurrentChat({ announce: false });
    }

    function onChatLevelToggled(chatLevel, profileId) {
        const { presetName, scope, ready } = getProfileState();

        if (!ready || !scope.chatId) {
            return;
        }

        const store = getPresetStore(presetName);

        if (chatLevel) {
            // 将当前选择单独绑定到此聊天存档
            store.chatBindings[getChatBindingKey(scope)] = profileId;
        } else {
            // 解除聊天存档的绑定，改为使用角色的绑定
            delete store.chatBindings[getChatBindingKey(scope)];
        }

        saveSettings();
        updateProfileBar();

        if (!chatLevel && getSettings().autoApply) {
            void applyProfileForCurrentChat();
        }
    }

    async function saveCurrentAsProfile(selectedId, chatLevel) {
        const { oai, presetName, scope, ready } = getProfileState();

        if (!ready) {
            return;
        }

        const { callGenericPopup, POPUP_TYPE, POPUP_RESULT } = await loadPopup();
        const store = getPresetStore(presetName);
        const own = Object.entries(store.profiles).filter(([, profile]) => profile.owner === scope.key);
        const selected = store.profiles[selectedId];
        const defaultName = selected?.owner === scope.key
            ? selected.name
            : `${scope.name} 方案${own.length ? ` ${own.length + 1}` : ''}`;
        const input = await callGenericPopup(
            `将预设「${presetName}」当前的条目开关保存为「${scope.name}」的方案。方案名称：`,
            POPUP_TYPE.INPUT,
            defaultName,
            { okButton: '保存', cancelButton: '取消' },
        );
        const name = typeof input === 'string' ? input.trim() : '';

        if (!name) {
            return;
        }

        const existing = own.find(([, profile]) => profile.name === name);

        if (existing) {
            const confirmed = await callGenericPopup(`方案「${name}」已存在。是否用当前的条目开关覆盖？`, POPUP_TYPE.CONFIRM, '', {
                okButton: '覆盖',
                cancelButton: '取消',
            });

            if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
                return;
            }
        }

        const profileId = existing?.[0] ?? createUniqueId(id => Object.hasOwn(store.profiles, id));
        store.profiles[profileId] = toParent({
            name,
            owner: scope.key,
            ownerName: scope.name,
            ...captureStates(oai),
            updatedAt: Date.now(),
        });
        setBinding(store, scope, profileId, chatLevel);
        saveSettings();
        updateProfileBar();
        notify?.success(`已保存方案「${name}」。${bindingTargetText(chatLevel)}时将自动套用。`);
    }

    async function deleteProfile(profileId) {
        const { presetName, ready } = getProfileState();
        const store = ready ? getPresetStore(presetName, false) : null;
        const profile = store?.profiles[profileId];

        if (!profile) {
            return;
        }

        const { callGenericPopup, POPUP_TYPE, POPUP_RESULT } = await loadPopup();
        const confirmed = await callGenericPopup(
            `删除方案「${profile.name}」？使用该方案的角色和聊天存档将改为不使用方案。当前的条目开关保持不变。`,
            POPUP_TYPE.CONFIRM,
            '',
            { okButton: '删除', cancelButton: '取消' },
        );

        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        delete store.profiles[profileId];

        for (const bindings of [store.characterBindings, store.chatBindings]) {
            for (const [key, value] of Object.entries(bindings)) {
                if (value === profileId) {
                    delete bindings[key];
                }
            }
        }

        saveSettings();
        updateProfileBar();
        notify?.success(`已删除方案「${profile.name}」。`);
    }

    // SillyTavern 每次重新渲染预设面板时会清空面板内容，因此监听面板，按钮栏缺失时重新插入
    let observedContainer = null;
    let containerObserver = null;

    function ensureProfileBar() {
        const container = pdoc.getElementById('completion_prompt_manager');
        const existing = pdoc.getElementById(BAR_ID);

        if (container && container !== observedContainer) {
            containerObserver?.disconnect();
            observedContainer = container;
            containerObserver = new pwin.MutationObserver(() => ensureProfileBar());
            containerObserver.observe(container, { childList: true });
        }

        if (!getSettings().profilesEnabled || !container) {
            existing?.remove();
            return;
        }

        if (existing && container.contains(existing)) {
            return;
        }

        existing?.remove();

        // 插入到「提示词」标题上方
        const anchor = container.querySelector('.completion_prompt_manager_header')
            ?? container.querySelector('#completion_prompt_manager_list');

        if (!anchor) {
            return;
        }

        const bar = buildProfileBar();
        anchor.before(bar);
        updateProfileBar(bar);
    }

    function onChatOrPresetChanged() {
        ensureProfileBar();
        updateProfileBar();

        if (getSettings().autoApply) {
            void applyProfileForCurrentChat();
        }
    }

    // 预设重命名时，方案数据随之迁移到新名称下
    function onPresetRenamed(event) {
        if (event?.apiId !== 'openai' || !event.oldName || !event.newName || event.oldName === event.newName) {
            return;
        }

        const presets = getSettings().presets;

        if (presets[event.oldName] && !presets[event.newName]) {
            presets[event.newName] = presets[event.oldName];
            delete presets[event.oldName];
            saveSettings();
        }
    }

    // =====================================================================
    // 「扩展」页面中的设置面板
    // =====================================================================

    function ensureSettingsPanel() {
        if (pdoc.getElementById(PANEL_ID)) {
            return;
        }

        const host = pdoc.getElementById('extensions_settings2') ?? pdoc.getElementById('extensions_settings');

        if (!host) {
            return;
        }

        const settings = getSettings();
        const checkboxOption = (key, label, hint, onChange) => {
            const box = el('input', { type: 'checkbox' });
            box.checked = settings[key];
            box.addEventListener('change', () => {
                getSettings()[key] = box.checked;
                saveSettings();
                onChange?.();
            });

            return el('div', { className: 'pet-panel-option' }, [
                el('label', { className: 'checkbox_label' }, [box, el('span', { text: label })]),
                hint ? el('div', { className: 'pet-panel-hint', text: hint }) : null,
            ]);
        };
        const selectOption = (key, label, choices, hint) => {
            const select = el('select', { className: 'text_pole' },
                choices.map(([value, text]) => el('option', { value, text })));
            select.value = settings[key];
            select.addEventListener('change', () => {
                getSettings()[key] = select.value;
                saveSettings();
            });

            return el('div', { className: 'pet-panel-option pet-panel-select' }, [
                el('span', { text: label }),
                select,
                hint ? el('div', { className: 'pet-panel-hint', text: hint }) : null,
            ]);
        };
        const compareButton = el('div', { className: 'menu_button' }, [
            el('i', { className: 'fa-solid fa-code-compare' }),
            el('span', { text: ' 对比旧版本预设…' }),
        ]);
        compareButton.addEventListener('click', () => void compareWithOldPreset());

        host.append(el('div', { id: PANEL_ID }, [
            el('div', { className: 'inline-drawer' }, [
                el('div', { className: 'inline-drawer-toggle inline-drawer-header' }, [
                    el('b', { text: '预设条目工具' }),
                    el('div', { className: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' }),
                ]),
                el('div', { className: 'inline-drawer-content' }, [
                    checkboxOption('doubleTapEnabled', '双击新建条目',
                        '双击条目左侧的「☰」，在该条目下方新建空条目。在 BaiBai 分组内双击时，新条目加入同一分组。'),
                    checkboxOption('importCompareEnabled', '导入时对比旧版本',
                        '导入预设时，若存在名称仅版本号不同的旧版本，列出仅存在于旧版本的条目和设置不同的条目，所选条目插入原位置。'),
                    checkboxOption('profilesEnabled', '条目方案',
                        '在「提示词」标题上方显示方案栏。条目开关可保存为方案并绑定到角色或聊天存档，切换时自动套用。方案按预设分别保存。',
                        () => {
                            ensureProfileBar();

                            if (getSettings().autoApply) {
                                void applyProfileForCurrentChat();
                            }
                        }),
                    checkboxOption('autoApply', '切换时自动套用方案',
                        '开启：切换角色、聊天存档或预设时自动套用对应的方案。关闭：切换时不修改条目开关，需在方案栏点击「套用」。在下拉框中选择方案时始终立即套用。',
                        () => updateProfileBar()),
                    selectOption('defaultSource', '默认值（未记录的条目开关）', [
                        ['saved', '预设上次保存的状态'],
                        ['previous', '沿用上一个角色的状态'],
                    ], '适用于：未使用方案的角色；方案中没有记录的条目（例如方案保存后新增的条目）。在下次切换角色、聊天存档或预设时生效。'),
                    checkboxOption('confirmNewEntries', '切换时确认未记录的条目',
                        '所用方案中存在未记录的条目时，弹出窗口逐项确认开关。确认结果写入该方案。'),
                    compareButton,
                ]),
            ]),
        ]));
    }

    // =====================================================================
    // 安装与卸载
    // =====================================================================

    const listenerOptions = { capture: true, passive: true };
    const legacyStartEvents = ['touchstart', 'mousedown'];
    const context = getContext();
    const eventSource = context.eventSource;
    const eventTypes = context.eventTypes ?? {};
    const eventHandlers = [
        [eventTypes.OAI_PRESET_IMPORT_READY ?? 'oai_preset_import_ready', onPresetImportReady],
        [eventTypes.CHAT_CHANGED ?? 'chat_id_changed', onChatOrPresetChanged],
        [eventTypes.OAI_PRESET_CHANGED_AFTER ?? 'oai_preset_changed_after', onChatOrPresetChanged],
        [eventTypes.PRESET_RENAMED ?? 'preset_renamed', onPresetRenamed],
    ];

    injectStyle();
    pwin.addEventListener('pointerdown', onPointerDown, listenerOptions);
    pwin.addEventListener('pointerup', onPointerUp, listenerOptions);
    pwin.addEventListener('pointercancel', onPointerCancel, listenerOptions);
    pwin.addEventListener('dblclick', onDoubleClick, listenerOptions);
    legacyStartEvents.forEach(type => pwin.addEventListener(type, onLegacyPointerStart, listenerOptions));
    eventHandlers.forEach(([type, handler]) => eventSource?.on(type, handler));

    if (typeof eventOn === 'function' && typeof getButtonEvent === 'function') {
        eventOn(getButtonEvent(BUTTON_NAME), compareWithOldPreset);
    }

    ensureSettingsPanel();
    // 预设面板可能晚于脚本加载，或被其他扩展替换，因此定时检查方案栏是否存在
    const barTimer = pwin.setInterval(() => {
        if (getSettings().profilesEnabled && !pdoc.getElementById(BAR_ID)) {
            ensureProfileBar();
        }
    }, 1500);

    loadOpenAi()
        .then(oai => {
            oaiModule = oai;
            onChatOrPresetChanged();
        })
        .catch(error => console.error('[预设条目工具] 加载 SillyTavern 模块失败', error));

    function uninstall() {
        pwin.removeEventListener('pointerdown', onPointerDown, listenerOptions);
        pwin.removeEventListener('pointerup', onPointerUp, listenerOptions);
        pwin.removeEventListener('pointercancel', onPointerCancel, listenerOptions);
        pwin.removeEventListener('dblclick', onDoubleClick, listenerOptions);
        legacyStartEvents.forEach(type => pwin.removeEventListener(type, onLegacyPointerStart, listenerOptions));
        eventHandlers.forEach(([type, handler]) => eventSource?.removeListener(type, handler));
        pwin.clearInterval(barTimer);
        containerObserver?.disconnect();
        pdoc.getElementById(BAR_ID)?.remove();
        pdoc.getElementById(PANEL_ID)?.remove();
        pdoc.getElementById(STYLE_ID)?.remove();

        if (pwin[INSTALL_KEY]?.uninstall === uninstall) {
            delete pwin[INSTALL_KEY];
        }
    }

    pwin[INSTALL_KEY] = { uninstall };
    window.addEventListener('pagehide', uninstall);
})();
