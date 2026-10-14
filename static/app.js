/**
 * cyberstory 前端交互逻辑
 * 模块结构：
 * 1. 视图 Tab 切换与移动端响应式交互
 * 2. 全局搜索 (支持数据源切换、关键词检索、上下文台词联动)
 * 3. YouTube 历史流水 (日期分组、进度耗时透明、点击展开字幕)
 * 4. 时间轴字幕渲染、直达播放与二次过滤
 */

const API_BASE = '';

// 全局运行时状态
let currentTab = 'search';
let searchActiveItemId = null;
let ytActiveItemId = null;
let searchSubtitlesCache = [];
let ytSubtitlesCache = [];

document.addEventListener('DOMContentLoaded', () => {
    initServiceStatus();
    initSearchEvents();
    initFilterEvents();
    loadYtHistory();
    // 10秒定时同步状态与耗时
    setInterval(loadYtHistory, 10000);
});

// ─── 1. 服务状态与统计 ───
async function initServiceStatus() {
    try {
        const res = await fetch(`${API_BASE}/api/status`);
        if (res.ok) {
            const data = await res.json();
            const dot = document.getElementById('serviceDot');
            const statusText = document.getElementById('serviceStatusText');
            const ytBadge = document.getElementById('navYtCount');

            if (dot) dot.style.background = '#22c55e';
            if (statusText) statusText.textContent = '本地服务运行中 (:8765)';
            if (ytBadge) ytBadge.textContent = data.total_videos || '0';
        }
    } catch (e) {
        const dot = document.getElementById('serviceDot');
        const statusText = document.getElementById('serviceStatusText');
        if (dot) dot.style.background = '#ef4444';
        if (statusText) statusText.textContent = '服务离线或异常';
    }
}

// ─── 2. 视图 Tab 切换 ───
function switchMainTab(tabId) {
    currentTab = tabId;
    const tabs = ['search', 'youtube', 'zhihu'];

    // 桌面侧边栏
    tabs.forEach(t => {
        const navEl = document.getElementById(`tab-nav-${t}`);
        if (navEl) navEl.classList.toggle('active', t === tabId);
    });

    // 移动端底部导航
    tabs.forEach(t => {
        const bnavEl = document.getElementById(`bnav-${t}`);
        if (bnavEl) bnavEl.classList.toggle('active', t === tabId);
    });

    // 视图显示
    tabs.forEach(t => {
        const viewEl = document.getElementById(`view-${t}`);
        if (viewEl) viewEl.classList.toggle('active', t === tabId);
    });

    // 关闭任何移动端抽屉
    closeMobileDetail('searchDetailPane');
    closeMobileDetail('ytDetailPane');
}

function openMobileDetail(paneId) {
    if (window.innerWidth <= 768) {
        const pane = document.getElementById(paneId);
        if (pane) pane.classList.add('mobile-open');
    }
}

function closeMobileDetail(paneId) {
    const pane = document.getElementById(paneId);
    if (pane) pane.classList.remove('mobile-open');
}

// ─── 3. 全局搜索模块 ───
function initSearchEvents() {
    const input = document.getElementById('searchInput');
    if (input) {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') doSearch();
        });
    }
}

async function doSearch() {
    const input = document.getElementById('searchInput');
    const q = input ? input.value.trim() : '';
    const sourceSelect = document.getElementById('searchSourceSelect');
    const source = sourceSelect ? sourceSelect.value : 'all';

    const resultsContainer = document.getElementById('searchResults');
    const statsText = document.getElementById('searchResultStats');
    const timeCostText = document.getElementById('searchTimeCost');

    if (!q) {
        resultsContainer.innerHTML = '<div class="empty-hint">请输入关键词开始检索，点击卡片可在右侧查看上下文台词</div>';
        statsText.textContent = '请输入关键词搜索台词与内容';
        timeCostText.textContent = '';
        return;
    }

    statsText.textContent = `正在检索 "${escapeHtml(q)}"...`;
    timeCostText.textContent = '';
    resultsContainer.innerHTML = '<div class="empty-hint">正在搜索全文索引 (FTS5)...</div>';

    const t0 = performance.now();
    try {
        const res = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(q)}&source=${encodeURIComponent(source)}`);
        const elapsed = Math.round(performance.now() - t0);
        if (!res.ok) throw new Error('Search failed');
        const data = await res.json();

        const sourceLabel = source === 'youtube' ? 'YouTube' : (source === 'zhihu' ? '知乎' : '全部');
        statsText.textContent = `[${sourceLabel}] 命中 ${data.total} 条记录`;
        timeCostText.textContent = `耗时 ${elapsed}ms`;

        renderSearchResults(data.items, q);
    } catch (e) {
        console.error('Search error', e);
        resultsContainer.innerHTML = '<div class="empty-hint">搜索失败，请检查服务连接</div>';
    }
}

function renderSearchResults(items, keyword) {
    const container = document.getElementById('searchResults');
    if (!items || items.length === 0) {
        container.innerHTML = '<div class="empty-hint">未检索到匹配的台词或内容</div>';
        return;
    }

    let html = '';
    items.forEach((item, idx) => {
        const isFirst = idx === 0;
        const durationStr = formatSeconds(item.duration_sec);
        const sourceClass = item.source === 'zhihu' ? 'zhihu' : 'yt';
        const sourceName = item.source === 'zhihu' ? '知乎' : 'YouTube';

        html += `
            <div class="result-card ${isFirst ? 'active' : ''}" id="search-card-${item.id}" onclick="selectSearchResultItem(${item.id}, ${item.start_sec || 0}, '${escapeHtml(keyword)}')">
                <div class="result-top">
                    <div class="result-thumb">
                        <img src="${escapeHtml(item.thumbnail_url)}" alt="thumb" loading="lazy" onerror="this.src='https://placehold.co/120x68?text=Video'">
                        <span class="result-duration">${escapeHtml(durationStr)}</span>
                    </div>
                    <div class="result-info">
                        <div class="result-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
                        <div class="result-meta">
                            <span class="source-tag ${sourceClass}">${sourceName}</span>
                            <span>${escapeHtml(item.author || '')}</span>
                            <span>•</span>
                            <span>${escapeHtml(item.watched_at || '')}</span>
                        </div>
                    </div>
                </div>

                <div class="result-snippet">
                    ${item.snippet || item.fts_snippet || escapeHtml(item.title)}
                </div>

                <div class="result-actions">
                    <a href="${escapeHtml(item.jump_url)}" target="_blank" class="time-jump-link" onclick="event.stopPropagation()">
                        ⏱ ${escapeHtml(item.time_stamp || '00:00')} (直达原片播放) ↗
                    </a>
                    <span style="font-size:11px; color:#2563eb; font-weight:600;">右侧查看上下文 →</span>
                </div>
            </div>
        `;
    });

    container.innerHTML = html;

    // 默认高亮并展开优先选中有字幕的卡片
    let defaultItem = items.find(i => i.sub_source === 'native' || i.sub_source === 'asr') || items[0];
    if (defaultItem) {
        selectSearchResultItem(defaultItem.id, defaultItem.start_sec || 0, keyword, false);
    }
}

async function selectSearchResultItem(itemId, startSec, keyword, openMobile = true) {
    searchActiveItemId = itemId;

    // 更新卡片激活态
    document.querySelectorAll('#searchResults .result-card').forEach(el => el.classList.remove('active'));
    const card = document.getElementById(`search-card-${itemId}`);
    if (card) {
        card.classList.add('active');
        const titleText = card.querySelector('.result-title')?.textContent || '视频详情';
        const channelText = card.querySelector('.result-meta span:nth-child(2)')?.textContent || '';
        document.getElementById('searchDetailTitle').textContent = titleText;
        document.getElementById('searchDetailMeta').innerHTML = `
            <span class="source-tag yt">YouTube</span>
            <span>${escapeHtml(channelText)}</span>
            <span>•</span>
            <span id="searchSubCountMeta">加载台词中...</span>
        `;
    }

    const stream = document.getElementById('searchTimelineStream');
    stream.innerHTML = '<div class="empty-hint">正在读取台词时间轴...</div>';

    try {
        const res = await fetch(`${API_BASE}/api/items/${itemId}/subtitles`);
        if (!res.ok) throw new Error('Failed to load subtitles');
        const data = await res.json();
        searchSubtitlesCache = data.subtitles || [];

        const countEl = document.getElementById('searchSubCountMeta');
        if (countEl) countEl.textContent = `共 ${searchSubtitlesCache.length} 条台词分段`;

        renderTimelineRows(searchSubtitlesCache, 'searchTimelineStream', startSec, keyword);
        if (openMobile) openMobileDetail('searchDetailPane');
    } catch (e) {
        stream.innerHTML = '<div class="empty-hint">暂无可用台词数据</div>';
    }
}

// ─── 4. YouTube 历史记录模块 (无搜索区，双栏展示) ───
async function loadYtHistory() {
    try {
        const res = await fetch(`${API_BASE}/api/history`);
        if (!res.ok) return;
        const groups = await res.json();

        let total = 0;
        groups.forEach(g => total += (g.items ? g.items.length : 0));
        const countMeta = document.getElementById('ytHistoryCount');
        const navCount = document.getElementById('navYtCount');
        if (countMeta) countMeta.textContent = `共 ${total} 条视频`;
        if (navCount) navCount.textContent = total;

        renderYtFeed(groups);
    } catch (e) {
        console.error('Failed to load YouTube history', e);
    }
}

function renderYtFeed(groups) {
    const feed = document.getElementById('ytHistoryFeed');
    if (!groups || groups.length === 0) {
        feed.innerHTML = '<div class="empty-hint">暂无历史记录</div>';
        return;
    }

    let html = '';
    let firstReadyItem = null;

    groups.forEach(group => {
        html += `
            <div class="date-group">
                <div class="date-title">
                    ${escapeHtml(group.date)}
                    <span>${group.items.length} 个视频</span>
                </div>
        `;

        group.items.forEach(item => {
            const isActive = ytActiveItemId === item.id ? 'active' : '';
            if (!firstReadyItem && item.status === 'ready') firstReadyItem = item;
            const isShort = (item.url && item.url.includes('/shorts/')) || (item.author === 'YouTube Shorts');
            const durationLabel = isShort ? 'Shorts' : escapeHtml(item.duration_str);

            // 状态徽标与步骤耗时
            let badgeHtml = '';
            let progressHtml = '';

            if (isShort) {
                badgeHtml += `<span class="badge-tag" style="background:#fce7f3; color:#be185d;">📱 Shorts</span>`;
            }

            if (item.status === 'ready') {
                if (item.sub_source === 'native') {
                    badgeHtml += `<span class="badge-tag tag-native">📝 原生官方字幕</span>`;
                } else if (item.sub_source === 'asr') {
                    badgeHtml += `<span class="badge-tag tag-asr">🎙 AI转写完成</span>`;
                } else {
                    badgeHtml += `<span class="badge-tag tag-pending">纯标题 (无字幕)</span>`;
                }
                if (item.cost_time_str) {
                    badgeHtml += `<span style="font-size:10px; color:#94a3b8;">耗时 ${escapeHtml(item.cost_time_str)}</span>`;
                }
            } else if (item.status === 'processing') {
                const stepText = item.current_step || '排队准备中';
                const pct = (typeof item.progress_pct === 'number' && item.progress_pct > 0) ? item.progress_pct : 5;
                const elapsedStr = item.cost_time_str ? `已耗时 ${item.cost_time_str}` : '刚刚开始';
                badgeHtml += `<span class="badge-tag tag-processing">⚡ ${escapeHtml(stepText)}</span>`;
                progressHtml = `
                    <div class="progress-block">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <span><b>步骤:</b> ${escapeHtml(stepText)}</span>
                            <span><b>${pct}%</b> <span style="font-size:9px; color:#92400e;">(${escapeHtml(elapsedStr)})</span></span>
                        </div>
                        <div class="progress-bar-bg">
                            <div class="progress-bar-val" style="width: ${pct}%;"></div>
                        </div>
                    </div>
                `;
            } else if (item.status === 'failed') {
                badgeHtml += `<span class="badge-tag tag-failed">❌ 处理失败</span>`;
            } else {
                badgeHtml += `<span class="badge-tag tag-pending">⏳ 待处理 (排队中)</span>`;
            }

            html += `
                <div class="history-card ${isActive}" id="yt-card-${item.id}" onclick="selectYtHistoryItem(${item.id})">
                    <div class="result-thumb">
                        <img src="${escapeHtml(item.thumbnail_url)}" alt="thumb" loading="lazy" onerror="this.src='https://placehold.co/120x68?text=Video'">
                        <span class="result-duration" style="${isShort ? 'background:#be185d;' : ''}">${durationLabel}</span>
                    </div>
                    <div class="result-info">
                        <div class="result-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
                        <div class="result-meta">
                            <span>${escapeHtml(item.author || 'YouTube')}</span>
                        </div>
                        <div style="margin-top:6px; display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
                            ${badgeHtml}
                        </div>
                        ${progressHtml}
                    </div>
                </div>
            `;
        });

        html += `</div>`;
    });

    feed.innerHTML = html;

    // 初次加载若无选中项，默认选中第一条
    if (!ytActiveItemId && firstReadyItem) {
        selectYtHistoryItem(firstReadyItem.id, false);
    }
}

async function selectYtHistoryItem(itemId, openMobile = true) {
    ytActiveItemId = itemId;

    document.querySelectorAll('#ytHistoryFeed .history-card').forEach(el => el.classList.remove('active'));
    const card = document.getElementById(`yt-card-${itemId}`);
    if (card) {
        card.classList.add('active');
        const title = card.querySelector('.result-title')?.textContent || '视频详情';
        const channel = card.querySelector('.result-meta span')?.textContent || '';
        document.getElementById('ytDetailTitle').textContent = title;
        document.getElementById('ytDetailMeta').innerHTML = `
            <span>${escapeHtml(channel)}</span>
            <span>•</span>
            <span id="ytSubCountMeta">加载台词中...</span>
        `;
    }

    const stream = document.getElementById('ytTimelineStream');
    stream.innerHTML = '<div class="empty-hint">正在读取台词时间轴...</div>';

    try {
        const res = await fetch(`${API_BASE}/api/items/${itemId}/subtitles`);
        if (!res.ok) throw new Error('Failed to load subtitles');
        const data = await res.json();
        ytSubtitlesCache = data.subtitles || [];

        const countEl = document.getElementById('ytSubCountMeta');
        if (countEl) countEl.textContent = `共 ${ytSubtitlesCache.length} 条台词分段`;

        renderTimelineRows(ytSubtitlesCache, 'ytTimelineStream', null, '');
        if (openMobile) openMobileDetail('ytDetailPane');
    } catch (e) {
        stream.innerHTML = '<div class="empty-hint">暂无可用字幕/台词数据</div>';
    }
}

// ─── 5. 台词时间轴渲染与局部二次过滤 ───
function renderTimelineRows(segments, containerId, highlightSec = null, keyword = '') {
    const container = document.getElementById(containerId);
    if (!segments || segments.length === 0) {
        container.innerHTML = '<div class="empty-hint">该视频暂无字幕分段</div>';
        return;
    }

    // 针对大体量长视频进行视口分段渲染优化（避免卡死浏览器）
    let renderList = segments;
    if (segments.length > 250) {
        let centerIdx = 0;
        if (highlightSec !== null) {
            centerIdx = segments.findIndex(s => Math.abs(s.start - highlightSec) < 6.0);
            if (centerIdx === -1) centerIdx = 0;
        }
        const start = Math.max(0, centerIdx - 40);
        const end = Math.min(segments.length, start + 160);
        renderList = segments.slice(start, end);
    }

    let html = '';
    renderList.forEach((seg, idx) => {
        let isHigh = false;
        if (highlightSec !== null && Math.abs(seg.start - highlightSec) < 4.0) {
            isHigh = true;
        }
        let lineText = escapeHtml(seg.text);
        if (keyword && lineText.toLowerCase().includes(keyword.toLowerCase())) {
            isHigh = true;
            const reg = new RegExp(keyword, 'gi');
            lineText = lineText.replace(reg, m => `<mark style="background:#fef08a; padding:1px 3px;">${m}</mark>`);
        }

        html += `
            <div class="timeline-row ${isHigh ? 'highlighted' : ''}" id="${containerId}-row-${idx}">
                <span class="time-badge">${escapeHtml(seg.time_str || '00:00')}</span>
                <div class="timeline-text">${lineText}</div>
            </div>
        `;
    });

    container.innerHTML = html;

    const highEl = container.querySelector('.timeline-row.highlighted');
    if (highEl) {
        highEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

// 二次过滤输入框
function initFilterEvents() {
    const searchFilter = document.getElementById('searchSubFilter');
    if (searchFilter) {
        searchFilter.addEventListener('input', () => {
            filterTimelineRows('searchTimelineStream', searchFilter.value.trim().toLowerCase());
        });
    }

    const ytFilter = document.getElementById('ytSubFilter');
    if (ytFilter) {
        ytFilter.addEventListener('input', () => {
            filterTimelineRows('ytTimelineStream', ytFilter.value.trim().toLowerCase());
        });
    }
}

function filterTimelineRows(containerId, query) {
    const rows = document.querySelectorAll(`#${containerId} .timeline-row`);
    rows.forEach(r => {
        const text = r.querySelector('.timeline-text')?.textContent.toLowerCase() || '';
        if (!query || text.includes(query)) {
            r.style.display = 'flex';
        } else {
            r.style.display = 'none';
        }
    });
}

// ─── 工具函数 ───
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatSeconds(sec) {
    if (!sec) return '00:00';
    const total = Math.floor(sec);
    const m = Math.floor(total / 60);
    const s = total % 60;
    const h = Math.floor(m / 60);
    const min = m % 60;
    if (h > 0) {
        return `${h}:${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${min}:${String(s).padStart(2, '0')}`;
}
