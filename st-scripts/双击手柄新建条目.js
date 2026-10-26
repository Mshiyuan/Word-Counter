// 酒馆助手脚本：双击预设条目最前面的「☰」拖动手柄，在它下面新建一个空条目。
// 兼容 ST-BaiBai-Tools 的预设分组：在分组内双击时，新条目会自动进入同一个分组。
(() => {
    const CONFIG = {
        // 新条目的默认名字，重名时会自动加上编号
        newPromptName: '新条目',
        // 新建后是否直接打开编辑窗口
        openEditor: true,
        // 新建后是否自动保存当前预设（相当于点一下「保存预设」）；默认不保存，自己手动保存
        autoSavePreset: false,
        // 两次点击的最大间隔（毫秒）
        doubleTapMs: 350,
        // 单次点击允许的手指/鼠标位移（像素），超过就当作拖动
        moveTolerance: 10,
    };

    const INSTALL_KEY = '__doubleTapNewPromptScript';
    const BAIBAI_STATE_KEY = '__baiBaiToolkitExtensionInstalled';
    const ROW_SELECTOR = '#completion_prompt_manager_list li.completion_prompt_manager_prompt[data-pm-identifier]';

    const pwin = window.parent;
    const pdoc = pwin.document;
    const notify = pwin.toastr ?? window.toastr;

    // 重复加载脚本时先卸掉旧的监听
    pwin[INSTALL_KEY]?.uninstall?.();

    let openAiModulePromise = null;

    // 在酒馆主页面里 import，拿到的才是同一个 promptManager 实例
    function loadOpenAiModule() {
        if (!openAiModulePromise) {
            const url = new URL('scripts/openai.js', pdoc.baseURI).href;
            openAiModulePromise = Promise.resolve(new pwin.Function('url', 'return import(url);')(url))
                .catch(error => {
                    openAiModulePromise = null;
                    throw error;
                });
        }

        return openAiModulePromise;
    }

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

    // ---------- 双击 / 双击触摸识别 ----------

    let pointerDown = null;
    let lastTap = null;
    let lastTriggerAt = 0;
    let busy = false;

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
            trigger(down.row);
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
            trigger(row);
        }
    }

    function trigger(row) {
        const now = Date.now();

        if (now - lastTriggerAt < 600) {
            return;
        }

        lastTriggerAt = now;
        pwin.getSelection?.()?.removeAllRanges?.();
        void insertPromptAfter(row.dataset.pmIdentifier, row.dataset.presetGroupId || '');
    }

    // ---------- 新建条目 ----------

    async function insertPromptAfter(sourceId, groupIdFromRow) {
        if (busy) {
            return;
        }

        busy = true;

        try {
            const { promptManager: pm, oai_settings: oaiSettings } = await loadOpenAiModule();

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

            const id = createUniqueIdentifier(pm);
            const prompt = {
                identifier: id,
                name: createUniqueName(pm),
                role: 'system',
                content: '',
                system_prompt: false,
                marker: false,
                injection_position: 0,
                injection_depth: 4,
                injection_order: 100,
                injection_trigger: [],
                forbid_overrides: false,
            };

            const promptIndex = pm.serviceSettings.prompts.findIndex(item => item?.identifier === sourceId);

            if (promptIndex >= 0) {
                pm.serviceSettings.prompts.splice(promptIndex + 1, 0, prompt);
            } else {
                pm.serviceSettings.prompts.push(prompt);
            }

            order.splice(orderIndex + 1, 0, { identifier: id, enabled: true });

            const groupName = assignBaiBaiGroup(oaiSettings, sourceId, id, groupIdFromRow);

            const counts = pm.tokenHandler?.getCounts?.();

            if (counts && typeof counts === 'object') {
                counts[id] = null;
            }

            pm.log?.(`Double-tap created prompt: ${id} after ${sourceId}`);

            // BaiBai 的分组会在重新渲染时把分组数据同步进预设的 extensions，所以先渲染再保存
            await pm.render?.();
            await waitFrames(2);
            await pm.saveServiceSettings?.();

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
            console.error('[双击新建条目]', error);
            notify?.error('新建条目失败，详情见控制台。');
        } finally {
            busy = false;
        }
    }

    // 把新条目放进被双击条目所在的 BaiBai 分组
    function assignBaiBaiGroup(oaiSettings, sourceId, newId, groupIdFromRow) {
        const baibai = pwin[BAIBAI_STATE_KEY];
        const groupState = baibai?.presetPromptGroupRuntimeState;
        const presetName = oaiSettings?.preset_settings_openai || 'current';

        if (!groupState?.prompts
            || !Array.isArray(groupState.groups)
            || baibai.presetPromptGroupRuntimePresetName !== presetName) {
            return null;
        }

        // 只有分组功能开着、列表按分组渲染时，行上才有 data-preset-group-id
        const groupId = groupIdFromRow || '';

        if (!groupId || groupState.prompts[sourceId]?.groupId !== groupId) {
            return null;
        }

        const group = groupState.groups.find(item => item?.id === groupId);

        if (!group) {
            return null;
        }

        groupState.prompts[newId] = { groupId };
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
            console.debug('[双击新建条目] 打开编辑窗口失败', error);
        }
    }

    function createUniqueIdentifier(pm) {
        const makeId = () => (pwin.crypto?.randomUUID?.()
            ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
        let id = makeId();

        while (pm.getPromptById?.(id)) {
            id = makeId();
        }

        return id;
    }

    function createUniqueName(pm) {
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

    function waitFrames(count) {
        return new Promise(resolve => {
            const step = remaining => (remaining <= 0 ? resolve() : pwin.requestAnimationFrame(() => step(remaining - 1)));
            step(count);
        });
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

    // ---------- 安装 / 卸载 ----------

    const listenerOptions = { capture: true, passive: true };

    pwin.addEventListener('pointerdown', onPointerDown, listenerOptions);
    pwin.addEventListener('pointerup', onPointerUp, listenerOptions);
    pwin.addEventListener('pointercancel', onPointerCancel, listenerOptions);
    pwin.addEventListener('dblclick', onDoubleClick, listenerOptions);

    function uninstall() {
        pwin.removeEventListener('pointerdown', onPointerDown, listenerOptions);
        pwin.removeEventListener('pointerup', onPointerUp, listenerOptions);
        pwin.removeEventListener('pointercancel', onPointerCancel, listenerOptions);
        pwin.removeEventListener('dblclick', onDoubleClick, listenerOptions);

        if (pwin[INSTALL_KEY]?.uninstall === uninstall) {
            delete pwin[INSTALL_KEY];
        }
    }

    pwin[INSTALL_KEY] = { uninstall };
    window.addEventListener('pagehide', uninstall);
})();
