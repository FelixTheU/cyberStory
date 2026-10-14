// ==UserScript==
// @name         cyberstory - YouTube History Sync
// @namespace    https://cyberstory.local
// @version      1.5.0
// @description  基于绝对 ts_id (时间戳*1000+倒序seq) 与 range 范围探测的 YouTube 历史智能同步 (支持常规增量追加与深度回溯插入)
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

    const SCRIPT_VERSION = '1.5.0';
    const API_BASE = 'http://127.0.0.1:8765';
    const SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 分钟

    let syncing = false;
    let autoScrolling = false;

    // ─── 1. UI: 胶囊与操作弹窗面板 (纯 DOM 安全构建，适配 YouTube Trusted Types) ───
    function injectUI() {
        if (document.getElementById('cyber-history-capsule')) return;

        // 样式注入
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
        syncBtn.textContent = '智能同步';
        capsule.appendChild(syncBtn);

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'ch-btn-sub';
        toggleBtn.id = 'chToggleModalBtn';
        toggleBtn.textContent = '⚙ 控制台';
        capsule.appendChild(toggleBtn);

        document.body.appendChild(capsule);

        // 控制台弹窗
        const modal = document.createElement('div');
        modal.id = 'ch-op-modal';

        const mHeader = document.createElement('div');
        mHeader.className = 'ch-modal-header';
        const mTitle = document.createElement('h4');
        mTitle.textContent = 'YouTube 历史同步控制台 (ts-id 架构)';
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

        const rowMax = document.createElement('div');
        rowMax.textContent = '库内上限 (最新): ';
        const bMax = document.createElement('b');
        bMax.id = 'infoMaxTsId';
        bMax.textContent = '加载中...';
        rowMax.appendChild(bMax);
        infoBox.appendChild(rowMax);

        const rowMin = document.createElement('div');
        rowMin.textContent = '库内下限 (最老): ';
        const bMin = document.createElement('b');
        bMin.id = 'infoMinTsId';
        bMin.textContent = '加载中...';
        rowMin.appendChild(bMin);
        infoBox.appendChild(rowMin);

        const rowTotal = document.createElement('div');
        rowTotal.textContent = '库内视频总数: ';
        const bTotal = document.createElement('b');
        bTotal.id = 'infoTotalVideos';
        bTotal.textContent = '-';
        rowTotal.appendChild(bTotal);
        infoBox.appendChild(rowTotal);

        modal.appendChild(infoBox);

        // 操作组
        const actGroup = document.createElement('div');
        actGroup.className = 'ch-actions-group';

        const btnSyncNow = document.createElement('button');
        btnSyncNow.className = 'ch-action-btn ch-btn-primary';
        btnSyncNow.id = 'btnSyncCurrent';
        btnSyncNow.textContent = '⚡ 智能同步当前可见差量';
        actGroup.appendChild(btnSyncNow);

        const rowBacktrack = document.createElement('div');
        rowBacktrack.style.display = 'flex';
        rowBacktrack.style.gap = '6px';

        const selTarget = document.createElement('select');
        selTarget.id = 'selectBacktrackTarget';
        selTarget.style.cssText = 'padding:6px; border-radius:6px; border:1px solid #cbd5e1; font-size:12px; flex:1;';

        const opt1M = document.createElement('option');
        opt1M.value = '25'; opt1M.textContent = '同步最近 1 个月 (滚动约25屏)';
        selTarget.appendChild(opt1M);

        const opt3M = document.createElement('option');
        opt3M.value = '60'; opt3M.textContent = '同步最近 3 个月 (滚动约60屏)';
        selTarget.appendChild(opt3M);

        const opt6M = document.createElement('option');
        opt6M.value = '120'; opt6M.textContent = '同步最近 6 个月 (滚动约120屏)';
        selTarget.appendChild(opt6M);

        const opt1Y = document.createElement('option');
        opt1Y.value = '240'; opt1Y.textContent = '同步最近 1 年 (滚动约240屏)';
        selTarget.appendChild(opt1Y);

        rowBacktrack.appendChild(selTarget);

        const btnDeepSync = document.createElement('button');
        btnDeepSync.className = 'ch-action-btn ch-btn-secondary';
        btnDeepSync.id = 'btnDeepSync';
        btnDeepSync.style.cssText = 'width:auto; padding:6px 12px;';
        btnDeepSync.textContent = '⏬ 深度回溯同步';
        rowBacktrack.appendChild(btnDeepSync);

        actGroup.appendChild(rowBacktrack);

        const btnStop = document.createElement('button');
        btnStop.className = 'ch-action-btn ch-btn-warn';
        btnStop.id = 'btnStopScroll';
        btnStop.style.display = 'none';
        btnStop.textContent = '⏹ 停止滚动';
        actGroup.appendChild(btnStop);

        modal.appendChild(actGroup);
        document.body.appendChild(modal);

        // 绑定事件
        syncBtn.addEventListener('click', () => doSmartSync());
        toggleBtn.addEventListener('click', toggleModal);
        mClose.addEventListener('click', () => modal.classList.remove('show'));
        btnSyncNow.addEventListener('click', () => { modal.classList.remove('show'); doSmartSync(); });
        btnDeepSync.addEventListener('click', handleDeepBacktrackSync);
        btnStop.addEventListener('click', () => { autoScrolling = false; });
    }

    async function toggleModal() {
        const modal = document.getElementById('ch-op-modal');
        if (!modal) return;
        modal.classList.toggle('show');
        if (modal.classList.contains('show')) {
            updateModalInfo();
        }
    }

    async function updateModalInfo() {
        try {
            const res = await fetch(`${API_BASE}/api/sync/range`);
            if (res.ok) {
                const data = await res.json();
                if (data.has_data) {
                    const maxDate = data.max_item ? `${data.max_item.watched_at} (${data.max_item.title.slice(0, 14)}...)` : data.max_ts_id;
                    const minDate = data.min_item ? `${data.min_item.watched_at} (${data.min_item.title.slice(0, 14)}...)` : data.min_ts_id;
                    document.getElementById('infoMaxTsId').textContent = `${maxDate}`;
                    document.getElementById('infoMinTsId').textContent = `${minDate}`;
                    document.getElementById('infoTotalVideos').textContent = `${data.total} 部`;
                } else {
                    document.getElementById('infoMaxTsId').textContent = '库内无数据';
                    document.getElementById('infoMinTsId').textContent = '库内无数据';
                    document.getElementById('infoTotalVideos').textContent = '0 部';
                }
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

    // ─── 3. 时间与日期解析辅助函数 ───
    function parseDateToMidnightTs(dateStr) {
        const s = dateStr ? dateStr.trim() : '';
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

        if (s.includes('今天') || s.includes('Today')) {
            return Math.floor(today.getTime() / 1000);
        }
        if (s.includes('昨天') || s.includes('Yesterday')) {
            const y = new Date(today.getTime() - 24 * 3600 * 1000);
            return Math.floor(y.getTime() / 1000);
        }

        const m = s.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/);
        if (m) {
            const year = m[1] ? parseInt(m[1], 10) : now.getFullYear();
            const month = parseInt(m[2], 10) - 1;
            const day = parseInt(m[3], 10);
            const dt = new Date(year, month, day, 0, 0, 0, 0);
            return Math.floor(dt.getTime() / 1000);
        }

        const weekdays = { '星期一': 1, '星期二': 2, '星期三': 3, '星期四': 4, '星期五': 5, '星期六': 6, '星期日': 0, '星期天': 0 };
        for (const [wName, wDay] of Object.entries(weekdays)) {
            if (s.includes(wName)) {
                const currentDay = now.getDay();
                let diff = (currentDay - wDay + 7) % 7;
                if (diff === 0) diff = 7;
                const dt = new Date(today.getTime() - diff * 24 * 3600 * 1000);
                return Math.floor(dt.getTime() / 1000);
            }
        }

        return Math.floor((today.getTime() - 60 * 24 * 3600 * 1000) / 1000);
    }

    function parseDuration(str) {
        if (!str) return 0;
        const parts = str.trim().split(':').map(Number);
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        return 0;
    }

    // ─── 4. 核心算法：组内倒序生成 seq，计算全局唯一绝对 ts_id ───
    function extractAllCardsWithTsId() {
        const sections = Array.from(document.querySelectorAll('ytd-item-section-renderer'));
        const allItems = [];
        const seenVids = new Set();

        sections.forEach(sec => {
            const headerEl = sec.querySelector('#header, #title, #header-text, h2');
            let dateLabel = headerEl ? headerEl.textContent.trim() : '';
            if (!dateLabel || dateLabel === 'Shorts') dateLabel = '未知日期';

            const midnightTs = parseDateToMidnightTs(dateLabel);

            // 查找该 section 下的所有卡片
            const cards = Array.from(sec.querySelectorAll('yt-lockup-view-model, ytd-video-renderer, ytm-shorts-lockup-view-model, ytd-reel-item-renderer, yt-shorts-lockup-view-model'));
            const validCardsInSec = [];

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

                if (!videoId || seenVids.has(videoId)) return;
                seenVids.add(videoId);

                validCardsInSec.push({ card, videoId, isShort, link });
            });

            // 核心设计：组内共有 n 个视频，页面自上而下顺序的“倒序”编号 001, 002, 003...
            // 最底端最早看的: seq = 1
            // 最顶端最晚看的: seq = n
            const n = validCardsInSec.length;
            validCardsInSec.forEach((itemObj, idxFromTop) => {
                const seq = n - idxFromTop; // 1 <= seq <= n
                const ts_id = midnightTs * 1000 + seq;

                const card = itemObj.card;
                const videoId = itemObj.videoId;
                const isShort = itemObj.isShort;
                const link = itemObj.link;

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

                allItems.push({
                    ts_id,
                    seq_num: seq,
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

        return allItems;
    }

    // ─── 5. 基于 Range 的差量探测与智能同步 ───
    async function doSmartSync() {
        if (syncing) return;
        syncing = true;
        const syncBtn = document.getElementById('chSyncBtn');
        const statusEl = document.getElementById('chStatus');

        if (syncBtn) syncBtn.disabled = true;
        if (statusEl) statusEl.textContent = 'CyberHistory: 获取已入库范围...';

        const online = await checkHealth();
        if (!online) {
            syncing = false;
            if (syncBtn) syncBtn.disabled = false;
            return;
        }

        try {
            // 步骤 1: 获取服务端已有的 ts_id 范围
            const rangeRes = await fetch(`${API_BASE}/api/sync/range`);
            const rangeData = await rangeRes.json();

            // 步骤 2: 扫描当前展开的所有卡片并计算绝对 ts_id
            if (statusEl) statusEl.textContent = 'CyberHistory: 计算 ts-id...';
            const allItems = extractAllCardsWithTsId();

            let toInsert = [];
            let tailCount = 0;
            let headCount = 0;

            if (!rangeData.has_data) {
                toInsert = allItems;
                tailCount = allItems.length;
            } else {
                const maxTsId = rangeData.max_ts_id;
                const minTsId = rangeData.min_ts_id;

                // 核心设计：基于 range 判定哪些记录是未入库的
                // 1. 尾部追加项 (比已入库最新的还新)
                const tailItems = allItems.filter(i => i.ts_id > maxTsId);
                // 2. 头部插入项 (比已入库最老的还老)
                const headItems = allItems.filter(i => i.ts_id < minTsId);

                tailCount = tailItems.length;
                headCount = headItems.length;
                toInsert = [...headItems, ...tailItems];
            }

            if (toInsert.length === 0) {
                const nextTime = new Date(Date.now() + SYNC_INTERVAL_MS).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
                if (statusEl) statusEl.textContent = `CyberHistory: 已是最新 (无未入库记录) | 下次: ${nextTime}`;
                syncing = false;
                if (syncBtn) syncBtn.disabled = false;
                return;
            }

            // 按 ts_id 递增顺序排序入库 (时间由旧至新自然追加)
            toInsert.sort((a, b) => a.ts_id - b.ts_id);

            if (statusEl) statusEl.textContent = `CyberHistory: 入库中 (新追加${tailCount}, 历史${headCount})...`;

            // 分批上报 (每批 200 条，防止超大包超时)
            let totalInserted = 0;
            const batchSize = 200;
            for (let i = 0; i < toInsert.length; i += batchSize) {
                const batch = toInsert.slice(i, i + batchSize);
                const resp = await fetch(`${API_BASE}/api/sync/youtube`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ items: batch })
                });
                const r = await resp.json();
                totalInserted += (r.inserted || 0);
            }

            const nextTime = new Date(Date.now() + SYNC_INTERVAL_MS).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
            if (statusEl) statusEl.textContent = `CyberHistory: 入库完成 ${totalInserted} 条 (尾部+${tailCount}, 头部+${headCount}) | 下次: ${nextTime}`;
        } catch (err) {
            if (statusEl) statusEl.textContent = `CyberHistory: 同步异常 (${err.message})`;
        }

        syncing = false;
        if (syncBtn) syncBtn.disabled = false;
    }

    // ─── 6. 深度回溯滚动与同步处理器 ───
    async function handleDeepBacktrackSync() {
        const modal = document.getElementById('ch-op-modal');
        if (modal) modal.classList.remove('show');

        const select = document.getElementById('selectBacktrackTarget');
        const maxScrolls = parseInt(select ? select.value : '60', 10) || 60;
        const statusEl = document.getElementById('chStatus');
        const stopBtn = document.getElementById('btnStopScroll');

        autoScrolling = true;
        if (stopBtn) stopBtn.style.display = 'block';

        let scrollCount = 0;
        while (autoScrolling && scrollCount < maxScrolls) {
            scrollCount++;
            if (statusEl) statusEl.textContent = `CyberHistory: 回溯滚动中 (${scrollCount}/${maxScrolls})...`;
            window.scrollTo(0, document.documentElement.scrollHeight);
            await new Promise(r => setTimeout(r, 2200));
        }

        if (stopBtn) stopBtn.style.display = 'none';
        autoScrolling = false;

        // 滚动完成后自动执行基于 ts-id range 的差量入库
        doSmartSync();
    }

    window.__cyberHistorySync = doSmartSync;
    window.__extractAllCardsWithTsId = extractAllCardsWithTsId;

    // ─── 初始化与心跳 ───
    injectUI();
    setTimeout(() => doSmartSync(), 2500);
    setInterval(() => doSmartSync(), SYNC_INTERVAL_MS);
    checkHealth();
})();
