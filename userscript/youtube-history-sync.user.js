// ==UserScript==
// @name         CyberHistoryExplorer - YouTube History Sync
// @namespace    https://cyberhistory.local
// @version      1.0.1
// @description  自动扫描 YouTube 历史记录并同步至本地 CyberHistoryExplorer 服务
// @author       CyberHistory
// @match        https://www.youtube.com/feed/history*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const SCRIPT_VERSION = '1.0.1';
    const API_BASE = 'http://127.0.0.1:8765';
    const SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 分钟
    const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 小时无新视频则刷新
    const MAX_SYNCED_IDS = 100;

    let syncing = false;
    let lastNewCount = 0;
    let lastNewTime = Date.now();

    // ─── Capsule UI ───
    if (!document.getElementById('cyber-history-capsule')) {
        const capsule = document.createElement('div');
        capsule.id = 'cyber-history-capsule';
        capsule.innerHTML = `
            <style>
                #cyber-history-capsule {
                    position: fixed;
                    bottom: 24px;
                    right: 24px;
                    z-index: 99999;
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    background: #ffffff;
                    border: 1px solid #e2e8f0;
                    border-radius: 999px;
                    padding: 8px 16px;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    font-size: 13px;
                    color: #334155;
                    box-shadow: 0 4px 16px rgba(0,0,0,0.1);
                    transition: all 0.2s ease;
                }
                #cyber-history-capsule:hover {
                    box-shadow: 0 6px 20px rgba(0,0,0,0.15);
                }
                #cyber-history-capsule .indicator {
                    width: 8px; height: 8px;
                    border-radius: 50%;
                    background: #94a3b8;
                    display: inline-block;
                }
                #cyber-history-capsule .indicator.online { background: #22c55e; }
                #cyber-history-capsule .indicator.offline { background: #ef4444; }
                #cyber-history-capsule button {
                    padding: 4px 12px;
                    background: #2563eb;
                    color: #fff;
                    border: none;
                    border-radius: 999px;
                    cursor: pointer;
                    font-size: 12px;
                    font-weight: 600;
                    transition: background 0.2s;
                }
                #cyber-history-capsule button:hover { background: #1d4ed8; }
                #cyber-history-capsule button:disabled { background: #94a3b8; cursor: wait; }
            </style>
            <span class="indicator" id="chIndicator"></span>
            <span id="chStatus">CyberHistory: 初始化...</span>
            <button id="chSyncBtn">立即同步</button>
        `;
        document.body.appendChild(capsule);

        document.getElementById('chSyncBtn').addEventListener('click', () => doSync());
    }

    // ─── Health Check ───
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

    // ─── Helpers ───
    function parseDuration(str) {
        if (!str) return 0;
        const parts = str.trim().split(':').map(Number);
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        return 0;
    }

    // ─── DOM Parsing ───
    function parseHistoryCards() {
        const cards = document.querySelectorAll('yt-lockup-view-model, ytd-video-renderer');
        const results = [];

        cards.forEach(card => {
            const links = Array.from(card.querySelectorAll('a[href*="/watch?v="]'));
            if (!links.length) return;

            let videoId = null;
            for (const l of links) {
                const m = l.href.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
                if (m) { videoId = m[1]; break; }
            }
            if (!videoId) return;

            let durationText = '';
            let title = '';
            
            for (const l of links) {
                const t = l.textContent.trim();
                if (/^\d+(:\d+)+$/.test(t)) {
                    durationText = t;
                } else if (t.length > title.length) {
                    title = t;
                }
            }

            let channel = '';
            const metaTexts = card.querySelectorAll('.ytContentMetadataViewModelMetadataText, #channel-name, .ytd-channel-name');
            if (metaTexts.length > 0) {
                channel = metaTexts[0].textContent.trim();
            }

            let watchedDate = '';
            let parent = card.parentElement;
            while (parent && parent !== document.body) {
                const titleHeader = parent.querySelector('#title, .section-title, h2, #header-text');
                if (titleHeader && titleHeader.textContent.trim()) {
                    const hText = titleHeader.textContent.trim();
                    if (hText.includes('今天') || hText.includes('昨天') || hText.includes('月') || hText.includes('年') || hText.includes('Today') || hText.includes('Yesterday')) {
                        watchedDate = hText;
                        break;
                    }
                }
                parent = parent.parentElement;
            }

            results.push({
                videoId,
                title,
                channel,
                url: `https://www.youtube.com/watch?v=${videoId}`,
                duration_sec: parseDuration(durationText),
                thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                watchedDate
            });
        });

        return results;
    }

    // ─── Sync Logic ───
    async function doSync() {
        if (syncing) return;
        syncing = true;
        const syncBtn = document.getElementById('chSyncBtn');
        const statusEl = document.getElementById('chStatus');

        if (syncBtn) syncBtn.disabled = true;
        if (statusEl) statusEl.textContent = 'CyberHistory: 扫描中...';

        const online = await checkHealth();
        if (!online) {
            syncing = false;
            if (syncBtn) syncBtn.disabled = false;
            return;
        }

        try {
            const allVideos = parseHistoryCards();
            if (allVideos.length === 0) {
                if (statusEl) statusEl.textContent = 'CyberHistory: 未找到视频卡片';
                syncing = false;
                if (syncBtn) syncBtn.disabled = false;
                return;
            }

            // 存储机制（兼容 GM_getValue 或 localStorage）
            let syncedIds = [];
            try {
                if (typeof GM_getValue !== 'undefined') {
                    syncedIds = GM_getValue('last_synced_video_ids', []);
                } else {
                    syncedIds = JSON.parse(localStorage.getItem('ch_synced_video_ids') || '[]');
                }
            } catch {
                syncedIds = [];
            }

            const syncedSet = new Set(syncedIds);
            const newVideos = [];
            for (const v of allVideos) {
                if (syncedSet.has(v.videoId)) break;
                newVideos.push(v);
            }

            // 如果全都在已同步列表，但用户点击了立即同步，依然上报所有视频以确保服务端同步
            const toSend = newVideos.length > 0 ? newVideos : allVideos;

            // 上报
            const resp = await fetch(`${API_BASE}/api/sync/youtube`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items: toSend })
            });
            const result = await resp.json();

            // 更新滑动窗口
            const newIds = toSend.map(v => v.videoId);
            const updatedIds = [...newIds, ...syncedIds.filter(id => !newIds.includes(id))].slice(0, MAX_SYNCED_IDS);
            try {
                if (typeof GM_setValue !== 'undefined') {
                    GM_setValue('last_synced_video_ids', updatedIds);
                } else {
                    localStorage.setItem('ch_synced_video_ids', JSON.stringify(updatedIds));
                }
            } catch {}

            lastNewCount = result.inserted !== undefined ? result.inserted : toSend.length;
            lastNewTime = Date.now();

            const nextTime = new Date(Date.now() + SYNC_INTERVAL_MS).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
            if (statusEl) statusEl.textContent = `CyberHistory: 已同步 ${lastNewCount} 条 | 下次: ${nextTime}`;
        } catch (err) {
            if (statusEl) statusEl.textContent = `CyberHistory: 同步失败 (${err.message})`;
        }

        syncing = false;
        if (syncBtn) syncBtn.disabled = false;
    }

    // 挂载到全局方便测试/调用
    window.__cyberHistorySync = doSync;

    // ─── Scheduling ───
    setTimeout(() => doSync(), 1500);
    setInterval(() => doSync(), SYNC_INTERVAL_MS);

    setInterval(() => {
        if (Date.now() - lastNewTime > REFRESH_INTERVAL_MS) {
            window.location.reload();
        }
    }, 60 * 60 * 1000);

    checkHealth();
})();
