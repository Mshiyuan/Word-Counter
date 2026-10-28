// 酒馆助手脚本「预设条目工具」，兼容 ST-BaiBai-Tools 的预设分组：
// 1. 双击条目最前面的「☰」，在下面新建一个空条目；
// 2. 导入同一个预设的新版本时，列出旧版独有（比如自己缝的）或内容不同的条目，勾选后放进新预设里和旧版相同的位置；
// 3. 角色条目方案：把条目开关保存给角色或某个聊天存档，切换时自动套用。
// 开关在「扩展」页面的「预设条目工具」里。
(() => {
    const CONFIG = {
        // 双击新建：新条目的默认名字，重名时会自动加上编号
        newPromptName: '新条目',
        // 双击新建：新建后是否直接打开编辑窗口
        openEditor: true,
        // 双击新建：新建后是否自动保存当前预设；默认不保存，自己手动保存
        autoSavePreset: false,
        // 双击新建：两次点击的最大间隔（毫秒）
        doubleTapMs: 350,
        // 双击新建：单次点击允许的手指/鼠标位移（像素），超过就当作拖动
        moveTolerance: 10,
        // 对比旧版：名字对不上时，至少要有这么多相同的自定义条目才算同一个预设
        minSharedCustomPrompts: 3,
        // 对比旧版：名字对不上时，相同自定义条目占比至少这么多才算同一个预设
        minOverlapRatio: 0.5,
        // 对比旧版：内容预览最多显示多少字
        previewChars: 2000,
    };

    const SETTINGS_KEY = 'presetEntryTools';
    const DEFAULT_SETTINGS = {
        doubleTapEnabled: true,
        importCompareEnabled: true,
        profilesEnabled: true,
        restoreBaselineEnabled: true,
    };
    const BUTTON_NAME = '对比旧版预设';
    const INSTALL_KEY = '__presetEntryToolsScript';
    // 合并之前的两个旧脚本，同一页面里还在的话先卸掉
    const LEGACY_INSTALL_KEYS = ['__doubleTapNewPromptScript', '__presetVersionMigrateScript'];
    const BAIBAI_STATE_KEY = '__baiBaiToolkitExtensionInstalled';
    const STYLE_ID = 'preset-entry-tools-style';
    const BAR_ID = 'preset-entry-tools-profile-bar';
    const PANEL_ID = 'preset-entry-tools-settings';
    const ROW_SELECTOR = '#completion_prompt_manager_list li.completion_prompt_manager_prompt[data-pm-identifier]';
    const GLOBAL_ORDER_ID = '100001';
    // 酒馆自带的条目，所有预设都有，不能拿来判断是不是同一个预设
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

    // 重复加载脚本时先卸掉旧的
    pwin[INSTALL_KEY]?.uninstall?.();
    LEGACY_INSTALL_KEYS.forEach(key => pwin[key]?.uninstall?.());

    // ---------- 酒馆模块 / 设置 ----------

    const moduleCache = new Map();

    // 在酒馆主页面里 import，拿到的才是酒馆正在用的同一份模块
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

    // 放进酒馆数据里的对象都在主页面里创建，免得跨 iframe 的对象出怪问题
    const toParent = value => pwin.structuredClone(value);

    function getSettings() {
        const extensionSettings = getContext().extensionSettings;

        if (!extensionSettings[SETTINGS_KEY] || typeof extensionSettings[SETTINGS_KEY] !== 'object') {
            extensionSettings[SETTINGS_KEY] = toParent({});
        }

        const settings = extensionSettings[SETTINGS_KEY];

        for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
            if (typeof settings[key] !== 'boolean') {
                settings[key] = value;
            }
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

    // 当前正在用的预设读实时数据（包括还没保存的改动），其他预设读已保存的
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

        // 极老的预设直接把顺序平铺在 prompt_order 里
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

    // 当前预设的分组：BaiBai 正在用的那份，加上写在预设里的那份（两份可能是同一个对象）
    function getCurrentGroupStates(oai) {
        const presetName = oai.oai_settings?.preset_settings_openai;
        return [...new Set([readLiveGroupState(presetName), readGroupStateFromPreset(oai.oai_settings)].filter(Boolean))];
    }

    function getGroupName(groupState, promptId) {
        const groupId = groupState?.prompts?.[promptId]?.groupId;
        return groupId ? (groupState.groups.find(group => group?.id === groupId)?.name ?? null) : null;
    }

    // ---------- 界面小工具 ----------

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

    // =====================================================================
    // 1. 双击「☰」新建条目
    // =====================================================================

    function getTargetRow(target) {
        const handle = target?.closest?.('.drag-handle');
        const row = handle?.closest(ROW_SELECTOR);

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

    function onPointerDown(event) {
        if (event.isPrimary === false || (event.pointerType === 'mouse' && event.button !== 0)) {
            pointerDown = null;
            return;
        }

        const row = getTargetRow(event.target);
        pointerDown = row
            ? { row, id: row.dataset.pmIdentifier, x: event.clientX, y: event.clientY, pointerId: event.pointerId }
            : null;
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

    // 兜底：有些环境下 pointer 事件被拦，退回浏览器自己的 dblclick
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
                notify?.warning('预设管理器还没准备好，稍后再试。');
                return;
            }

            const order = pm.getPromptOrderForCharacter(pm.activeCharacter);
            const orderIndex = Array.isArray(order) ? order.findIndex(entry => entry?.identifier === sourceId) : -1;

            if (orderIndex < 0) {
                notify?.warning('这个条目不在当前列表里。');
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

            const groupName = assignDoubleTapGroup(oai, sourceId, id, groupIdFromRow);
            const counts = pm.tokenHandler?.getCounts?.();

            if (counts && typeof counts === 'object') {
                counts[id] = null;
            }

            pm.log?.(`Double-tap created prompt: ${id} after ${sourceId}`);

            // BaiBai 的分组会在重新渲染时把分组数据同步进预设的 extensions，所以先渲染再保存
            await pm.render?.();
            await waitFrames(2);
            // 这个 Promise 要等酒馆存完设置才会结束，存失败就一直不结束，所以不等它
            void pm.saveServiceSettings?.();

            if (CONFIG.autoSavePreset) {
                pdoc.getElementById('update_oai_preset')?.click();
            }

            notify?.success(groupName ? `已在分组「${groupName}」中新建条目。` : '已新建条目。');

            const newRow = await waitForRow(id);
            newRow?.scrollIntoView?.({ block: 'nearest' });

            if (CONFIG.openEditor) {
                openEditor(pm, prompt, newRow);
            }
        } catch (error) {
            console.error('[预设条目工具] 新建条目失败', error);
            notify?.error('新建条目失败，详情见控制台。');
        } finally {
            insertBusy = false;
        }
    }

    // 把新条目放进被双击条目所在的 BaiBai 分组
    function assignDoubleTapGroup(oai, sourceId, newId, groupIdFromRow) {
        const groupState = readLiveGroupState(oai.oai_settings?.preset_settings_openai || 'current');

        // 只有分组功能开着、列表按分组渲染时，行上才有 data-preset-group-id
        if (!groupState || !groupIdFromRow || groupState.prompts[sourceId]?.groupId !== groupIdFromRow) {
            return null;
        }

        const group = groupState.groups.find(item => item?.id === groupIdFromRow);

        if (!group) {
            return null;
        }

        groupState.prompts[newId] = toParent({ groupId: groupIdFromRow });
        return String(group.name || '未命名分组');
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
    // 2. 导入新版本时对比旧版
    // =====================================================================

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
                reason: sameName ? '同名的旧预设' : sameBase ? '名字只差版本号' : similar ? `有 ${shared} 个相同条目` : '',
            });
        }

        // 分数一样时（比如好几个旧版本），优先版本号大的
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

    // 找旧版里离它最近、新版里也有的条目当锚点，放在它后面；前面没有就放在后面那个的前面
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

    // 夹在同一个分组中间就必须进这个分组；在分组边上时，旧版里同名的分组才进
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

        // 按旧版顺序一个个放，连着的几条自缝条目会保持原来的先后
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
            ? `${value.slice(0, CONFIG.previewChars)}…（后面还有 ${value.length - CONFIG.previewChars} 字）`
            : value;
    }

    function renderSection({ title, hint, items, renderItem, emptyText }) {
        const boxes = [];
        const list = el('div');

        for (const item of items) {
            const box = el('input', { type: 'checkbox' });
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

    function renderAddedItem(item, box) {
        const meta = [
            item.afterName ? `原来在「${item.afterName}」后面` : '原来在最前面',
            item.oldGroupName ? `分组「${item.oldGroupName}」` : '',
            item.enabled ? '' : '原来是关闭的',
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
            `不同：${item.fields.map(field => FIELD_LABELS[field]).join('、')}`,
            item.oldPrompt.name !== item.newPrompt.name ? `新版叫「${item.newPrompt.name}」` : '',
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
                el('div', { className: 'pvm-hint', text: '旧版：' }),
                el('div', { className: 'pvm-pre', text: preview(item.oldPrompt.content) }),
                el('div', { className: 'pvm-hint', text: '新版：' }),
                el('div', { className: 'pvm-pre', text: preview(item.newPrompt.content) }),
            ]),
        ]);
    }

    // 弹出对比窗口；确认后返回 { diff, selection, oldName }，取消返回 null
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
                title: '旧版独有的条目',
                hint: '勾选的条目会放进新预设里和旧版相同的位置。',
                items: diff.added,
                renderItem: renderAddedItem,
                emptyText: '没有旧版独有的条目。',
            });
            const changedSection = renderSection({
                title: '两边都有、但内容不同的条目',
                hint: '勾选 = 用旧版的内容覆盖新版。没改过作者的条目就不用勾。',
                items: diff.changed,
                renderItem: renderChangedItem,
                emptyText: '没有内容不同的条目。',
            });

            sectionsHost.replaceChildren(addedSection.section, changedSection.section);
            current = { oldName, diff, addedSection, changedSection };
        };

        select.addEventListener('change', renderLists);

        root.append(
            el('div', { className: 'pvm-head' }, [
                el('div', { className: 'pvm-name', text: mode === 'import' ? `正在导入「${targetName}」` : `当前预设「${targetName}」` }),
                el('div', { className: 'pvm-hint', text: '和这个旧预设对比：' }),
                select,
                el('div', {
                    className: 'pvm-hint',
                    text: mode === 'import'
                        ? '确认后条目会合并进导入的新预设，酒馆导入时会直接保存它；旧预设不会被改动。'
                        : '确认后条目会加进当前预设，不会自动保存，检查好了再手动保存预设。',
                }),
            ]),
            sectionsHost,
        );

        renderLists();

        const result = await callGenericPopup(root, POPUP_TYPE.CONFIRM, '', {
            okButton: '导入勾选的条目',
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
            insertedIds.length ? `放进了 ${insertedIds.length} 个旧版条目` : '',
            replaced ? `用旧版内容覆盖了 ${replaced} 个条目` : '',
        ].filter(Boolean).join('，');
    }

    let compareBusy = false;

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
                notify?.info(`「${newName}」和旧版「${candidates[0].name}」没有不同的条目。`);
                return;
            }

            const result = await showCompareDialog({ mode: 'import', targetName: newName, target, candidates, getOldPreset });

            if (!result) {
                return;
            }

            const summary = applyMigration(result.diff, result.selection, target);
            notify?.success(`已从「${result.oldName}」${describeMigration(summary)}。`);
        } catch (error) {
            console.error('[预设条目工具] 对比旧版预设失败', error);
            notify?.error('对比旧版预设失败，这次按原样导入。详情见控制台。');
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
                notify?.warning('预设管理器还没准备好，稍后再试。');
                return;
            }

            const candidates = rankCandidates(oai, currentName, oai.oai_settings, currentName);

            if (!candidates.length) {
                notify?.warning('没有别的预设可以对比。');
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
            notify?.success(`已从「${result.oldName}」${describeMigration(summary)}。检查好了记得手动保存预设。`);
        } catch (error) {
            console.error('[预设条目工具] 对比旧版预设失败', error);
            notify?.error('对比旧版预设失败，详情见控制台。');
        } finally {
            compareBusy = false;
        }
    }

    // =====================================================================
    // 3. 角色条目方案
    // =====================================================================
    // 存在 extension_settings.presetEntryTools.presets[预设名] 里：
    //   profiles:          { 方案id: { name, owner, ownerName, entries: {条目id: 开关}, groups: {分组id: 开关} } }
    //   characterBindings: { 角色key: 方案id }
    //   chatBindings:      { 角色key::聊天存档id: 方案id 或 ''（这个存档明确不切换） }

    let oaiModule = null;
    // 现在的开关是不是来自某个方案（{ presetName, profileId }）；切到没有方案的角色时，据此判断要不要恢复预设自己的开关
    let lastApplied = null;

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

    // 先看这个聊天存档自己的绑定，没有再看角色的
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

    // 只改方案里记过的条目，之后新加的条目保持原样
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

    // 预设自己保存的开关（还没手动保存的改动不算）
    function getBaselineStates(oai, presetName) {
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

    function getProfileState() {
        const oai = oaiModule;
        const presetName = oai?.oai_settings?.preset_settings_openai;
        const scope = getChatScope();
        const ready = Boolean(oai?.promptManager?.activeCharacter && presetName && scope);
        return { oai, presetName, scope, ready, store: ready ? getPresetStore(presetName, false) : null };
    }

    function applyProfileForCurrentChat() {
        const settings = getSettings();
        const { oai, presetName, scope, ready, store } = getProfileState();

        if (!settings.profilesEnabled || !ready) {
            return;
        }

        const { profileId } = store ? getBinding(store, scope) : { profileId: '' };

        if (profileId) {
            const profile = store.profiles[profileId];

            if (applyStates(oai, profile)) {
                notify?.info(`已套用条目方案「${profile.name}」。`);
            }

            lastApplied = { presetName, profileId };
            return;
        }

        // 上一个角色套过方案，切到没有方案的角色时恢复预设自己的开关，免得把上一个角色的开关带过来
        if (settings.restoreBaselineEnabled && lastApplied?.presetName === presetName) {
            const baseline = getBaselineStates(oai, presetName);

            if (baseline) {
                applyStates(oai, baseline);
            }
        }

        lastApplied = null;
    }

    function buildProfileBar() {
        const title = el('span', { className: 'pet-bar-who' });
        const select = el('select', { className: 'text_pole pet-bar-select', title: '切换角色时自动套用的条目方案' });
        const saveButton = el('div', { className: 'menu_button pet-bar-save', title: '把现在的条目开关保存成这个角色的方案' }, [
            el('i', { className: 'fa-solid fa-floppy-disk' }),
            el('span', { text: ' 当前角色保存为…' }),
        ]);
        const deleteButton = el('div', { className: 'menu_button pet-bar-delete fa-solid fa-trash-can', title: '删除选中的方案' });
        const chatBox = el('input', { type: 'checkbox' });
        const bar = el('div', { id: BAR_ID }, [
            el('div', { className: 'pet-bar-title' }, [el('i', { className: 'fa-solid fa-masks-theater' }), title]),
            el('div', { className: 'pet-bar-row' }, [select, saveButton, deleteButton]),
            el('label', { className: 'checkbox_label pet-bar-chat' }, [chatBox, el('span', { text: '只对当前聊天存档生效' })]),
        ]);

        select.addEventListener('change', () => onProfileSelected(select.value, chatBox.checked));
        chatBox.addEventListener('change', () => onChatLevelToggled(chatBox.checked, select.value));
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
            : '条目方案（打开一个角色聊天后可用）';

        select.replaceChildren(el('option', { value: '', text: '不自动切换' }));

        if (ready && store) {
            const profiles = Object.entries(store.profiles)
                .sort(([, a], [, b]) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
            const own = profiles.filter(([, profile]) => profile.owner === scope.key);
            const others = profiles.filter(([, profile]) => profile.owner !== scope.key);

            if (own.length) {
                select.append(el('optgroup', { label: '这个角色的方案' },
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
        bar.querySelector('.pet-bar-save').classList.toggle('disabled', !ready);
        bar.querySelector('.pet-bar-delete').classList.toggle('disabled', !ready || !binding.profileId);
        bar.title = presetName ? `方案按预设分开保存，现在是「${presetName}」的方案` : '';
    }

    function onProfileSelected(profileId, chatLevel) {
        const { oai, presetName, scope, ready } = getProfileState();

        if (!ready) {
            return;
        }

        const store = getPresetStore(presetName);
        setBinding(store, scope, profileId, chatLevel);
        saveSettings();

        if (profileId) {
            applyStates(oai, store.profiles[profileId]);
            lastApplied = { presetName, profileId };
            notify?.success(`已套用「${store.profiles[profileId].name}」，${chatLevel ? '打开这个聊天存档' : '切换到这个角色'}时会自动套用。`);
        }

        // 选「不自动切换」时开关还是方案里的样子，lastApplied 留着，切到别的角色时才能恢复预设自己的开关

        updateProfileBar();
    }

    function onChatLevelToggled(chatLevel, profileId) {
        const { presetName, scope, ready } = getProfileState();

        if (!ready || !scope.chatId) {
            return;
        }

        const store = getPresetStore(presetName);

        if (chatLevel) {
            // 把现在选的方案单独记给这个聊天存档
            store.chatBindings[getChatBindingKey(scope)] = profileId;
        } else {
            // 取消后跟随角色的方案
            delete store.chatBindings[getChatBindingKey(scope)];
            applyProfileForCurrentChat();
        }

        saveSettings();
        updateProfileBar();
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
            : `${scope.name}的方案${own.length ? ` ${own.length + 1}` : ''}`;
        const input = await callGenericPopup(
            `把现在「${presetName}」的条目开关保存给「${scope.name}」，起个名字：`,
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
            const confirmed = await callGenericPopup(`「${name}」已经存在，要用现在的开关覆盖它吗？`, POPUP_TYPE.CONFIRM, '', {
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
        lastApplied = { presetName, profileId };
        saveSettings();
        updateProfileBar();
        notify?.success(`已保存「${name}」，${chatLevel ? '打开这个聊天存档' : '切换到这个角色'}时会自动套用。`);
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
            `删除方案「${profile.name}」？用到它的角色和聊天存档都会变成不自动切换，现在的条目开关不会变。`,
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
        notify?.success(`已删除「${profile.name}」。`);
    }

    // 酒馆每次重画预设面板都会清空它，所以盯着面板，按钮栏没了就补回去
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

        // 放在「提示词」标题上方
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
        applyProfileForCurrentChat();
        ensureProfileBar();
        updateProfileBar();
    }

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

        if (lastApplied?.presetName === event.oldName) {
            lastApplied.presetName = event.newName;
        }
    }

    // =====================================================================
    // 扩展页面里的设置
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
        const option = (key, label, hint, onChange) => {
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
        const compareButton = el('div', { className: 'menu_button' }, [
            el('i', { className: 'fa-solid fa-code-compare' }),
            el('span', { text: ' 对比旧版预设…' }),
        ]);
        compareButton.addEventListener('click', () => void compareWithOldPreset());

        host.append(el('div', { id: PANEL_ID }, [
            el('div', { className: 'inline-drawer' }, [
                el('div', { className: 'inline-drawer-toggle inline-drawer-header' }, [
                    el('b', { text: '预设条目工具' }),
                    el('div', { className: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' }),
                ]),
                el('div', { className: 'inline-drawer-content' }, [
                    option('doubleTapEnabled', '双击条目前的 ☰ 新建条目', '在这个条目下面新建一个空条目；在分组里双击会进同一个分组。'),
                    option('importCompareEnabled', '导入预设时对比旧版本',
                        '导入名字只差版本号的新预设时，列出旧版独有（比如自己缝的）或内容不同的条目，勾选后放回原位置。'),
                    option('profilesEnabled', '角色条目方案',
                        '在「提示词」上方显示「当前角色保存为…」，把条目开关按角色或聊天存档保存，切换时自动套用。每个预设分开保存。',
                        () => {
                            ensureProfileBar();
                            applyProfileForCurrentChat();
                        }),
                    option('restoreBaselineEnabled', '切到没有方案的角色时，恢复预设自己保存的开关',
                        '关掉的话，会沿用上一个角色的开关。'),
                    compareButton,
                ]),
            ]),
        ]));
    }

    // =====================================================================
    // 安装 / 卸载
    // =====================================================================

    const listenerOptions = { capture: true, passive: true };
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
    eventHandlers.forEach(([type, handler]) => eventSource?.on(type, handler));

    if (typeof eventOn === 'function' && typeof getButtonEvent === 'function') {
        eventOn(getButtonEvent(BUTTON_NAME), compareWithOldPreset);
    }

    ensureSettingsPanel();
    // 预设面板可能比脚本晚出现，或者被别的插件整个换掉，隔一会儿检查一次
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
        .catch(error => console.error('[预设条目工具] 加载酒馆模块失败', error));

    function uninstall() {
        pwin.removeEventListener('pointerdown', onPointerDown, listenerOptions);
        pwin.removeEventListener('pointerup', onPointerUp, listenerOptions);
        pwin.removeEventListener('pointercancel', onPointerCancel, listenerOptions);
        pwin.removeEventListener('dblclick', onDoubleClick, listenerOptions);
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
