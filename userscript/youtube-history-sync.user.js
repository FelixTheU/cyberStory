// ==UserScript==
// @name         cyberstory - YouTube History Sync
// @namespace    https://cyberstory.local
// @version      1.2.0
// @description  自动扫描 YouTube 历史记录 (含长视频与 Shorts) 并严格按浏览次序同步至本地 cyberstory 服务
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

    const SCRIPT_VERSION = '1.2.0';
    const API_BASE = 'http://127.0.0.1:8765';
    const SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 分钟
    const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 小时无新视频则刷新
    const MAX_SYNCED_IDS = 200;

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

    // ─── 核心 DOM 解析：严格按照自上而下文档流捕获长视频与 Shorts ───
    function parseHistoryCards() {
        const sections = Array.from(document.querySelectorAll('ytd-item-section-renderer'));
        const results = [];
        const seen = new Set();
        let seq = 1;

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
                    seq_order: seq++,
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

            // 上报全部已扫描条目 (支持更新既有记录的最新顺序与日期)
            const resp = await fetch(`${API_BASE}/api/sync/youtube`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items: allVideos })
            });
            const result = await resp.json();

            lastNewCount = result.inserted !== undefined ? result.inserted : allVideos.length;
            lastNewTime = Date.now();

            const nextTime = new Date(Date.now() + SYNC_INTERVAL_MS).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
            if (statusEl) statusEl.textContent = `CyberHistory: 已同步 ${allVideos.length} 条 (新增${result.inserted || 0}) | 下次: ${nextTime}`;
        } catch (err) {
            if (statusEl) statusEl.textContent = `CyberHistory: 同步失败 (${err.message})`;
        }

        syncing = false;
        if (syncBtn) syncBtn.disabled = false;
    }

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
