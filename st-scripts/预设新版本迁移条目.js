// 酒馆助手脚本：导入同一个预设的新版本时，列出旧版里有、新版里没有（比如自己缝的）或内容不同的条目，
// 勾选后放进新预设里和旧版相同的位置。兼容 ST-BaiBai-Tools 的预设分组。
// 也可以随时点脚本按钮「对比旧版预设」，拿当前预设和任意一个旧预设对比。
(() => {
    const CONFIG = {
        // 导入预设时自动检测旧版本并弹出对比窗口
        autoDetectOnImport: true,
        // 名字对不上时，至少要有这么多相同的自定义条目才算同一个预设
        minSharedCustomPrompts: 3,
        // 名字对不上时，相同自定义条目占比至少这么多才算同一个预设
        minOverlapRatio: 0.5,
        // 内容预览最多显示多少字
        previewChars: 2000,
    };

    const BUTTON_NAME = '对比旧版预设';
    const INSTALL_KEY = '__presetVersionMigrateScript';
    const BAIBAI_STATE_KEY = '__baiBaiToolkitExtensionInstalled';
    const STYLE_ID = 'preset-version-migrate-style';
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

    // ---------- 酒馆模块 ----------

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

    // 放进酒馆数据里的对象都在主页面里创建，免得跨 iframe 的对象出怪问题
    const toParent = value => pwin.structuredClone(value);

    // ---------- 预设数据 ----------

    function getPresetNames(oai) {
        return Object.keys(oai.openai_setting_names ?? {});
    }

    // 当前正在用的预设读实时数据（包括还没保存的改动），其他预设读已保存的
    function getPresetData(oai, name) {
        if (name === oai.oai_settings?.preset_settings_openai) {
            return oai.oai_settings;
        }

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

    function getGroupName(groupState, promptId) {
        const groupId = groupState?.prompts?.[promptId]?.groupId;
        return groupId ? (groupState.groups.find(group => group?.id === groupId)?.name ?? null) : null;
    }

    // ---------- 判断是不是同一个预设的不同版本 ----------

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

    // ---------- 对比 ----------

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

    // ---------- 合并 ----------

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
    function assignGroup(target, position, promptId, oldGroupName) {
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
            assignGroup(target, position, id, item.oldGroupName);
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

    // ---------- 对比窗口 ----------

    function injectStyle() {
        if (pdoc.getElementById(STYLE_ID)) {
            return;
        }

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
    async function showDialog({ mode, targetName, target, candidates, getOldPreset }) {
        injectStyle();

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

    function describeResult({ insertedIds, replaced }) {
        return [
            insertedIds.length ? `放进了 ${insertedIds.length} 个旧版条目` : '',
            replaced ? `用旧版内容覆盖了 ${replaced} 个条目` : '',
        ].filter(Boolean).join('，');
    }

    // ---------- 导入时自动检测 ----------

    let importBusy = false;

    async function onPresetImportReady(event) {
        if (!CONFIG.autoDetectOnImport || importBusy) {
            return;
        }

        const data = event?.data;
        const newName = event?.presetName;
        const order = getOrderList(data);

        if (!newName || !Array.isArray(data?.prompts) || !order) {
            return;
        }

        importBusy = true;

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

            const result = await showDialog({ mode: 'import', targetName: newName, target, candidates, getOldPreset });

            if (!result) {
                return;
            }

            const summary = applyMigration(result.diff, result.selection, target);
            notify?.success(`已从「${result.oldName}」${describeResult(summary)}。`);
        } catch (error) {
            console.error('[预设新版本迁移条目]', error);
            notify?.error('对比旧版预设失败，这次按原样导入。详情见控制台。');
        } finally {
            importBusy = false;
        }
    }

    // ---------- 手动对比当前预设 ----------

    async function onButtonClick() {
        if (importBusy) {
            return;
        }

        importBusy = true;

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

            const extensionGroupState = readGroupStateFromPreset(oai.oai_settings);
            const target = {
                prompts: oai.oai_settings.prompts,
                order: pm.getPromptOrderForCharacter(pm.activeCharacter),
                groupStates: [...new Set([readLiveGroupState(currentName), extensionGroupState].filter(Boolean))],
            };
            const result = await showDialog({
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
            notify?.success(`已从「${result.oldName}」${describeResult(summary)}。检查好了记得手动保存预设。`);
        } catch (error) {
            console.error('[预设新版本迁移条目]', error);
            notify?.error('对比旧版预设失败，详情见控制台。');
        } finally {
            importBusy = false;
        }
    }

    // ---------- 安装 / 卸载 ----------

    const context = pwin.SillyTavern?.getContext?.();
    const eventSource = context?.eventSource;
    const importEvent = context?.eventTypes?.OAI_PRESET_IMPORT_READY ?? 'oai_preset_import_ready';

    eventSource?.on(importEvent, onPresetImportReady);

    if (typeof eventOn === 'function' && typeof getButtonEvent === 'function') {
        eventOn(getButtonEvent(BUTTON_NAME), onButtonClick);
    }

    function uninstall() {
        eventSource?.removeListener(importEvent, onPresetImportReady);
        pdoc.getElementById(STYLE_ID)?.remove();

        if (pwin[INSTALL_KEY]?.uninstall === uninstall) {
            delete pwin[INSTALL_KEY];
        }
    }

    pwin[INSTALL_KEY] = { uninstall };
    window.addEventListener('pagehide', uninstall);
})();
