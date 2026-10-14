// ==UserScript==
// @name         cyberstory - YouTube History Sync
// @namespace    https://cyberstory.local
// @version      1.4.0
// @description  自动扫描 YouTube 历史记录 (支持双游标自动推算：尾部追加最新 + 头部回溯插入，附控制台操作窗口)
// @author       cyberstory
// @match        https://www.youtube.com/feed/history*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const SCRIPT_VERSION = '1.4.0';
    const API_BASE = 'http://127.0.0.1:8765';
    const SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 分钟

    let syncing = false;
    let autoScrolling = false;

    // ─── 1. UI: 胶囊与操作弹窗面板 (严格适配 YouTube Trusted Types，纯 DOM 构建) ───
    function injectUI() {
        if (document.getElementById('cyber-history-capsule')) return;

        // 注入样式
        const style = document.createElement('style');
        style.textContent = `
            #cyber-history-capsule {
                position: fixed; bottom: 24px; right: 24px; z-index: 99999;
                display: flex; align-items: center; gap: 8px;
                background: #ffffff; border: 1px solid #e2e8f0; border-radius: 999px;
                padding: 8px 14px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                font-size: 13px; color: #334155; box-shadow: 0 4px 16px rgba(0,0,0,0.12);
                transition: all 0.2s ease;
            }
            #cyber-history-capsule:hover { box-shadow: 0 6px 20px rgba(0,0,0,0.18); }
            #cyber-history-capsule .indicator {
                width: 8px; height: 8px; border-radius: 50%; background: #94a3b8; display: inline-block;
            }
            #cyber-history-capsule .indicator.online { background: #22c55e; }
            #cyber-history-capsule .indicator.offline { background: #ef4444; }
            .ch-btn {
                padding: 4px 12px; background: #2563eb; color: #fff; border: none; border-radius: 999px;
                cursor: pointer; font-size: 12px; font-weight: 600; transition: background 0.15s;
            }
            .ch-btn:hover { background: #1d4ed8; }
            .ch-btn:disabled { background: #94a3b8; cursor: wait; }
            .ch-btn-sub {
                padding: 4px 10px; background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1;
                border-radius: 999px; cursor: pointer; font-size: 12px; font-weight: 600; transition: all 0.15s;
            }
            .ch-btn-sub:hover { background: #e2e8f0; color: #0f172a; }

            #ch-op-modal {
                display: none; position: fixed; bottom: 74px; right: 24px; z-index: 99999;
                width: 380px; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 12px;
                padding: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.18);
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                font-size: 13px; color: #1e293b;
            }
            #ch-op-modal.show { display: block; }
            .ch-modal-header {
                display: flex; justify-content: space-between; align-items: center;
                padding-bottom: 10px; border-bottom: 1px solid #f1f5f9; margin-bottom: 12px;
            }
            .ch-modal-header h4 { font-size: 14px; font-weight: 700; color: #0f172a; }
            .ch-modal-close { cursor: pointer; color: #94a3b8; font-size: 16px; border: none; background: none; }
            .ch-modal-close:hover { color: #0f172a; }
            .ch-info-box {
                background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px;
                padding: 10px 12px; margin-bottom: 14px; font-size: 12px; line-height: 1.6;
            }
            .ch-info-box b { color: #0f172a; }
            .ch-actions-group { display: flex; flex-direction: column; gap: 8px; }
            .ch-action-btn {
                width: 100%; padding: 8px 12px; border-radius: 8px; font-size: 12px; font-weight: 600;
                cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px;
                transition: all 0.15s; border: 1px solid transparent;
            }
            .ch-btn-primary { background: #2563eb; color: #fff; }
            .ch-btn-primary:hover { background: #1d4ed8; }
            .ch-btn-secondary { background: #f8fafc; color: #334155; border-color: #cbd5e1; }
            .ch-btn-secondary:hover { background: #f1f5f9; }
            .ch-btn-warn { background: #fff1f2; color: #e11d48; border-color: #fecdd3; }
            .ch-btn-warn:hover { background: #ffe4e6; }
        `;
        document.head.appendChild(style);

        // 胶囊容器
        const capsule = document.createElement('div');
        capsule.id = 'cyber-history-capsule';

        const indicator = document.createElement('span');
        indicator.className = 'indicator';
        indicator.id = 'chIndicator';
        capsule.appendChild(indicator);

        const statusEl = document.createElement('span');
        statusEl.id = 'chStatus';
        statusEl.textContent = 'CyberHistory: 初始化...';
        capsule.appendChild(statusEl);

        const syncBtn = document.createElement('button');
        syncBtn.className = 'ch-btn';
        syncBtn.id = 'chSyncBtn';
        syncBtn.textContent = '立即同步';
        capsule.appendChild(syncBtn);

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'ch-btn-sub';
        toggleBtn.id = 'chToggleModalBtn';
        toggleBtn.textContent = '⚙ 选项';
        capsule.appendChild(toggleBtn);

        document.body.appendChild(capsule);

        // 控制台弹窗
        const modal = document.createElement('div');
        modal.id = 'ch-op-modal';

        const mHeader = document.createElement('div');
        mHeader.className = 'ch-modal-header';
        const mTitle = document.createElement('h4');
        mTitle.textContent = 'YouTube 历史双向同步控制台';
        mHeader.appendChild(mTitle);
        const mClose = document.createElement('button');
        mClose.className = 'ch-modal-close';
        mClose.id = 'chCloseModal';
        mClose.textContent = '✕';
        mHeader.appendChild(mClose);
        modal.appendChild(mHeader);

        const infoBox = document.createElement('div');
        infoBox.className = 'ch-info-box';
        infoBox.id = 'chCursorInfo';
        
        const rowTail = document.createElement('div');
        rowTail.textContent = '最新分界 (Tail): ';
        const bTail = document.createElement('b');
        bTail.id = 'infoTailCursor';
        bTail.textContent = '加载中...';
        rowTail.appendChild(bTail);
        infoBox.appendChild(rowTail);

        const rowHead = document.createElement('div');
        rowHead.textContent = '最老分界 (Head): ';
        const bHead = document.createElement('b');
        bHead.id = 'infoHeadCursor';
        bHead.textContent = '加载中...';
        rowHead.appendChild(bHead);
        infoBox.appendChild(rowHead);

        const rowTotal = document.createElement('div');
        rowTotal.textContent = '库内视频基准总数: ';
        const bTotal = document.createElement('b');
        bTotal.id = 'infoTotalVideos';
        bTotal.textContent = '-';
        rowTotal.appendChild(bTotal);
        infoBox.appendChild(rowTotal);

        modal.appendChild(infoBox);

        // 操作按钮组
        const actGroup = document.createElement('div');
        actGroup.className = 'ch-actions-group';

        const btnTail = document.createElement('button');
        btnTail.className = 'ch-action-btn ch-btn-primary';
        btnTail.id = 'btnSyncTail';
        btnTail.textContent = '▶ 同步最新观看 (尾部追加)';
        actGroup.appendChild(btnTail);

        const rowPrepend = document.createElement('div');
        rowPrepend.style.display = 'flex';
        rowPrepend.style.gap = '6px';

        const selTarget = document.createElement('select');
        selTarget.id = 'selectBacktrackTarget';
        selTarget.style.cssText = 'padding:6px; border-radius:6px; border:1px solid #cbd5e1; font-size:12px; flex:1;';
        
        const opt60 = document.createElement('option');
        opt60.value = '60'; opt60.textContent = '回溯半年 (自动滚动约60屏)';
        selTarget.appendChild(opt60);

        const opt120 = document.createElement('option');
        opt120.value = '120'; opt120.textContent = '回溯一年 (自动滚动约120屏)';
        selTarget.appendChild(opt120);

        const optCurr = document.createElement('option');
        optCurr.value = 'current'; optCurr.textContent = '仅同步当前已展开的历史';
        selTarget.appendChild(optCurr);

        rowPrepend.appendChild(selTarget);

        const btnHead = document.createElement('button');
        btnHead.className = 'ch-action-btn ch-btn-secondary';
        btnHead.id = 'btnSyncHead';
        btnHead.style.cssText = 'width:auto; padding:6px 12px;';
        btnHead.textContent = '⏬ 回溯同步 (头部插入)';
        rowPrepend.appendChild(btnHead);

        actGroup.appendChild(rowPrepend);

        const btnStop = document.createElement('button');
        btnStop.className = 'ch-action-btn ch-btn-warn';
        btnStop.id = 'btnStopScroll';
        btnStop.style.display = 'none';
        btnStop.textContent = '⏹ 停止自动滚动';
        actGroup.appendChild(btnStop);

        modal.appendChild(actGroup);
        document.body.appendChild(modal);

        // 绑定事件
        syncBtn.addEventListener('click', () => doSmartSync('auto'));
        toggleBtn.addEventListener('click', toggleModal);
        mClose.addEventListener('click', () => modal.classList.remove('show'));
        btnTail.addEventListener('click', () => { modal.classList.remove('show'); doSmartSync('tail_only'); });
        btnHead.addEventListener('click', handleBacktrackSync);
        btnStop.addEventListener('click', () => { autoScrolling = false; });
    }

    async function toggleModal() {
        const modal = document.getElementById('ch-op-modal');
        if (!modal) return;
        modal.classList.toggle('show');
        if (modal.classList.contains('show')) {
            updateModalCursorInfo();
        }
    }

    async function updateModalCursorInfo() {
        try {
            const res = await fetch(`${API_BASE}/api/sync/cursors`);
            if (res.ok) {
                const data = await res.json();
                document.getElementById('infoTailCursor').textContent = data.tail_cursor ? `${data.tail_cursor.watched_at} (${data.tail_cursor.title.slice(0, 16)}...)` : '无';
                document.getElementById('infoHeadCursor').textContent = data.head_cursor ? `${data.head_cursor.watched_at} (${data.head_cursor.title.slice(0, 16)}...)` : '无';
                document.getElementById('infoTotalVideos').textContent = `${data.total_items} 部`;
            }
        } catch (e) {}
    }

    // ─── 2. 健康检查 ───
    async function checkHealth() {
        const indicator = document.getElementById('chIndicator');
        const statusEl = document.getElementById('chStatus');
        try {
            const r = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
            if (r.ok) {
                if (indicator) indicator.className = 'indicator online';
                return true;
            }
        } catch {}
        if (indicator) indicator.className = 'indicator offline';
        if (statusEl) statusEl.textContent = 'CyberHistory: 服务未连接';
        return false;
    }

    // ─── 3. 获取服务端双游标 ───
    async function fetchDualCursors() {
        try {
            const res = await fetch(`${API_BASE}/api/sync/cursors`, { signal: AbortSignal.timeout(4000) });
            if (res.ok) {
                return await res.json();
            }
        } catch (e) {
            console.warn('Failed to fetch dual cursors', e);
        }
        return { has_cursor: false, tail_cursor: null, head_cursor: null, total_items: 0 };
    }

    function parseDuration(str) {
        if (!str) return 0;
        const parts = str.trim().split(':').map(Number);
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        return 0;
    }

    // ─── 4. 扫描页面当前所有卡片 ───
    function scanAllRenderedCards() {
        const sections = Array.from(document.querySelectorAll('ytd-item-section-renderer'));
        const results = [];
        const seen = new Set();

        sections.forEach(sec => {
            const headerEl = sec.querySelector('#header, #title, #header-text, h2');
            let dateLabel = headerEl ? headerEl.textContent.trim() : '';
            if (!dateLabel || dateLabel === 'Shorts') dateLabel = '未知日期';

            const cards = sec.querySelectorAll('yt-lockup-view-model, ytd-video-renderer, ytm-shorts-lockup-view-model, ytd-reel-item-renderer, yt-shorts-lockup-view-model');

            cards.forEach(card => {
                const watchLink = card.querySelector('a[href*="/watch?v="]');
                const shortsLink = card.querySelector('a[href*="/shorts/"]');

                let videoId = null;
                let isShort = false;
                let link = null;

                if (watchLink) {
                    const m = watchLink.href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
                    if (m) { videoId = m[1]; link = watchLink; }
                } else if (shortsLink) {
                    const m = shortsLink.href.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
                    if (m) { videoId = m[1]; isShort = true; link = shortsLink; }
                }

                if (!videoId || seen.has(videoId)) return;
                seen.add(videoId);

                let title = '';
                const titleEl = card.querySelector('h3, #video-title, .yt-core-attributed-string');
                if (titleEl) title = titleEl.textContent.trim();
                if (!title && link) {
                    title = link.getAttribute('aria-label') || link.textContent.trim() || '';
                }

                let channel = '';
                let duration_sec = isShort ? 60 : 0;

                if (!isShort) {
                    const metaTexts = card.querySelectorAll('.ytContentMetadataViewModelMetadataText, #channel-name, .ytd-channel-name');
                    if (metaTexts.length > 0) channel = metaTexts[0].textContent.trim();

                    const links = Array.from(card.querySelectorAll('a[href*="/watch?v="]'));
                    for (const l of links) {
                        const t = l.textContent.trim();
                        if (/^\d+(:\d+)+$/.test(t)) {
                            duration_sec = parseDuration(t);
                            break;
                        }
                    }
                } else {
                    channel = 'YouTube Shorts';
                    const metaTexts = card.querySelectorAll('.ytContentMetadataViewModelMetadataText, span');
                    for (const m of metaTexts) {
                        const t = m.textContent.trim();
                        if (t.includes('次观看') || t.includes('views')) continue;
                        if (t.length > 1 && t.length < 25 && t !== title) {
                            channel = t;
                            break;
                        }
                    }
                }

                results.push({
                    videoId,
                    title: title.slice(0, 150),
                    channel: channel || (isShort ? 'YouTube Shorts' : 'YouTube'),
                    url: isShort ? `https://www.youtube.com/shorts/${videoId}` : `https://www.youtube.com/watch?v=${videoId}`,
                    duration_sec,
                    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                    watchedDate: dateLabel,
                    is_short: isShort
                });
            });
        });

        return results;
    }

    // ─── 5. 核心算法：双游标自动推算 (切分出尾部追加与头部插入批次) ───
    function partitionCardsByCursors(allCards, tailCursorId, headCursorId) {
        if (!tailCursorId && !headCursorId) {
            // 空库状态：全部作为初始尾部追加
            return {
                tailAppend: allCards,
                headPrepend: []
            };
        }

        const tailAppend = [];
        const headPrepend = [];
        let state = tailCursorId ? 'BEFORE_TAIL' : 'IN_MIDDLE';

        for (const card of allCards) {
            const vid = card.videoId;

            if (state === 'BEFORE_TAIL') {
                if (vid === tailCursorId) {
                    // 遇到最新分界线：结束尾部追加批次，进入已有区间
                    state = headCursorId ? 'IN_MIDDLE' : 'DONE';
                    continue;
                }
                tailAppend.push(card);
            } else if (state === 'IN_MIDDLE') {
                if (vid === headCursorId) {
                    // 遇到最老分界线：结束已有区间，进入更早历史回溯区间
                    state = 'AFTER_HEAD';
                    continue;
                }
                // 处于已同步区间，忽略
            } else if (state === 'AFTER_HEAD') {
                // 比最老分界线更早的历史：归入头部插入批次
                headPrepend.push(card);
            }
        }

        return { tailAppend, headPrepend };
    }

    // ─── 6. 智能同步执行器 ───
    async function doSmartSync(mode = 'auto') {
        if (syncing) return;
        syncing = true;
        const syncBtn = document.getElementById('chSyncBtn');
        const statusEl = document.getElementById('chStatus');

        if (syncBtn) syncBtn.disabled = true;
        if (statusEl) statusEl.textContent = 'CyberHistory: 获取双游标...';

        const online = await checkHealth();
        if (!online) {
            syncing = false;
            if (syncBtn) syncBtn.disabled = false;
            return;
        }

        try {
            // 步骤 1: 获取双游标
            const cursorData = await fetchDualCursors();
            const tailId = cursorData.tail_cursor ? cursorData.tail_cursor.source_id : null;
            const headId = cursorData.head_cursor ? cursorData.head_cursor.source_id : null;

            // 步骤 2: 扫描当前展开的所有卡片
            if (statusEl) statusEl.textContent = 'CyberHistory: 扫描页面卡片...';
            const allCards = scanAllRenderedCards();

            // 步骤 3: 自动推算分区
            const { tailAppend, headPrepend } = partitionCardsByCursors(allCards, tailId, headId);

            let appendCount = 0;
            let prependCount = 0;

            // 执行尾部追加 (新视频，倒序为较旧->最新提交)
            if (tailAppend.length > 0 && mode !== 'head_only') {
                if (statusEl) statusEl.textContent = `CyberHistory: 追加最新 ${tailAppend.length} 条...`;
                const toAppend = tailAppend.reverse();
                const resp = await fetch(`${API_BASE}/api/sync/youtube?direction=tail_append`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ items: toAppend })
                });
                const r = await resp.json();
                appendCount = r.inserted || toAppend.length;
            }

            // 执行头部回溯插入 (更深历史，保持自上而下较近过去->更深过去提交)
            if (headPrepend.length > 0 && mode !== 'tail_only') {
                if (statusEl) statusEl.textContent = `CyberHistory: 插入历史 ${headPrepend.length} 条...`;
                const resp = await fetch(`${API_BASE}/api/sync/youtube?direction=head_prepend`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ items: headPrepend })
                });
                const r = await resp.json();
                prependCount = r.inserted || headPrepend.length;
            }

            const nextTime = new Date(Date.now() + SYNC_INTERVAL_MS).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

            if (appendCount === 0 && prependCount === 0) {
                if (statusEl) statusEl.textContent = `CyberHistory: 已是最新 (无未同步项) | 下次: ${nextTime}`;
            } else {
                let msg = '已同步: ';
                if (appendCount > 0) msg += `追加最新${appendCount}条 `;
                if (prependCount > 0) msg += `插入历史${prependCount}条 `;
                if (statusEl) statusEl.textContent = `CyberHistory: ${msg}| 下次: ${nextTime}`;
            }
        } catch (err) {
            if (statusEl) statusEl.textContent = `CyberHistory: 同步异常 (${err.message})`;
        }

        syncing = false;
        if (syncBtn) syncBtn.disabled = false;
    }

    // ─── 7. 回溯滚动同步处理器 ───
    async function handleBacktrackSync() {
        const modal = document.getElementById('ch-op-modal');
        if (modal) modal.classList.remove('show');

        const select = document.getElementById('selectBacktrackTarget');
        const targetVal = select ? select.value : '60';

        if (targetVal === 'current') {
            doSmartSync('auto');
            return;
        }

        const maxScrolls = parseInt(targetVal, 10) || 60;
        const statusEl = document.getElementById('chStatus');
        const stopBtn = document.getElementById('btnStopScroll');

        autoScrolling = true;
        if (stopBtn) stopBtn.style.display = 'block';

        let scrollCount = 0;
        while (autoScrolling && scrollCount < maxScrolls) {
            scrollCount++;
            if (statusEl) statusEl.textContent = `CyberHistory: 回溯滚动中 (${scrollCount}/${maxScrolls})...`;
            window.scrollTo(0, document.documentElement.scrollHeight);
            await new Promise(r => setTimeout(r, 2000));
        }

        if (stopBtn) stopBtn.style.display = 'none';
        autoScrolling = false;

        // 滚动完成后自动执行双向同步入库
        doSmartSync('auto');
    }

    // 挂载全局对象供外部探测
    window.__cyberHistorySync = doSmartSync;
    window.__partitionCardsByCursors = partitionCardsByCursors;

    // ─── 初始化与心跳 ───
    injectUI();
    setTimeout(() => doSmartSync('auto'), 2000);
    setInterval(() => doSmartSync('auto'), SYNC_INTERVAL_MS);
    checkHealth();
})();
