/**
 * cyberstory 前端交互逻辑
 * 模块结构：
 * 1. 视图 Tab 切换 (搜索, YouTube, 知乎, 任务管理) 与移动端抽屉
 * 2. 全局搜索 (支持数据源切换、关键词检索、上下文台词联动)
 * 3. YouTube 历史流水 (日期分组与折叠展开、Shorts识别、展开字幕)
 * 4. 任务管理 (总览统计、进行中进度条、排队队列实时流、完成自动移除)
 * 5. 台词时间轴渲染、直达播放与二次过滤
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
    loadTasks();

    // 定时轮询：任务管理每 3 秒刷新，历史流水每 10 秒刷新
    setInterval(loadTasks, 3000);
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

// ─── 搜索源下拉菜单控制 ───
function toggleSourceDropdown(e) {
    if (e) e.stopPropagation();
    const dropdown = document.getElementById('sourceCustomSelect');
    if (dropdown) dropdown.classList.toggle('open');
}

function selectSourceOption(val, label, el) {
    const input = document.getElementById('searchSourceSelect');
    if (input) input.value = val;
    const labelEl = document.getElementById('currentSourceLabel');
    if (labelEl) labelEl.textContent = label;
    
    // 更新图标
    const iconContainer = document.getElementById('currentSourceIcon');
    const clickedSvg = el.querySelector('svg');
    if (iconContainer && clickedSvg) {
        iconContainer.innerHTML = clickedSvg.outerHTML;
    }

    // 更新选中样式
    document.querySelectorAll('.source-menu-item').forEach(m => m.classList.remove('selected'));
    el.classList.add('selected');

    const dropdown = document.getElementById('sourceCustomSelect');
    if (dropdown) dropdown.classList.remove('open');

    // 触发搜索
    doSearch();
}

// 点击空白关闭下拉菜单
document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('sourceCustomSelect');
    if (dropdown && !dropdown.contains(e.target)) {
        dropdown.classList.remove('open');
    }
});

// ─── 2. 视图 Tab 切换 ───
function switchMainTab(tabId) {
    currentTab = tabId;
    const tabs = ['search', 'youtube', 'zhihu', 'tasks'];

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

    if (tabId === 'tasks') {
        loadTasks();
    }
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
        const isShort = (item.url && item.url.includes('/shorts/')) || (item.author === 'YouTube Shorts');
        const durText = escapeHtml(item.duration_str || formatSeconds(item.duration_sec));
        // Shorts 视频统一移除时长显示，仅显示 Shorts 标识；常规长视频显示真实时长
        const durationLabel = isShort ? 'Shorts' : durText;
        const sourceClass = item.source === 'zhihu' ? 'zhihu' : 'yt';
        const sourceName = item.source === 'zhihu' ? '知乎' : 'YouTube';

        html += `
            <div class="result-card ${isFirst ? 'active' : ''}" id="search-card-${item.ts_id || item.id}" onclick="selectSearchResultItem(${item.ts_id || item.id}, ${item.start_sec || 0}, '${escapeHtml(keyword)}')">
                <div class="result-top">
                    <div class="result-thumb">
                        <img src="${escapeHtml(item.thumbnail_url)}" alt="thumb" loading="lazy" onerror="this.src='https://placehold.co/120x68?text=Video'">
                        <span class="result-duration" style="${isShort ? 'background:#be185d;' : ''}">${durationLabel}</span>
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

    let defaultItem = items.find(i => i.sub_source === 'native' || i.sub_source === 'asr') || items[0];
    if (defaultItem) {
        selectSearchResultItem(defaultItem.ts_id || defaultItem.id, defaultItem.start_sec || 0, keyword, false);
    }
}

async function selectSearchResultItem(itemId, startSec, keyword, openMobile = true) {
    searchActiveItemId = itemId;

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

// ─── 4. YouTube 历史流水模块 (支持日期折叠) ───
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

    // 保存当前各分区的折叠状态
    const collapsedMap = {};
    feed.querySelectorAll('.date-group.collapsed').forEach(el => {
        const d = el.getAttribute('data-date');
        if (d) collapsedMap[d] = true;
    });

    let html = '';
    let firstReadyItem = null;

    groups.forEach((group, gIdx) => {
        const isCollapsed = collapsedMap[group.date] ? 'collapsed' : '';
        html += `
            <div class="date-group ${isCollapsed}" data-date="${escapeHtml(group.date)}">
                <div class="date-title" onclick="toggleDateGroup(this)">
                    <div class="date-title-left">
                        <span class="date-collapse-icon">▼</span>
                        <span>${escapeHtml(group.date)}</span>
                    </div>
                    <span class="date-group-count">${group.items.length} 个视频</span>
                </div>
                <div class="date-group-content">
        `;

        group.items.forEach(item => {
            const itemId = item.ts_id || item.id;
            const isActive = ytActiveItemId === itemId ? 'active' : '';
            if (!firstReadyItem && item.status === 'ready') firstReadyItem = item;
            const isShort = (item.url && item.url.includes('/shorts/')) || (item.author === 'YouTube Shorts');
            const durText = escapeHtml(item.duration_str || '00:00');
            // Shorts 视频统一移除时长显示，仅显示 Shorts 标识；常规长视频显示真实时长
            const durationLabel = isShort ? 'Shorts' : durText;

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
                const stepText = item.current_step || '处理准备中';
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
                <div class="history-card ${isActive}" id="yt-card-${itemId}" onclick="selectYtHistoryItem(${itemId})">
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

        html += `</div></div>`;
    });

    feed.innerHTML = html;

    if (!ytActiveItemId && firstReadyItem) {
        selectYtHistoryItem(firstReadyItem.ts_id || firstReadyItem.id, false);
    }
}

function toggleDateGroup(titleEl) {
    const group = titleEl.closest('.date-group');
    if (group) {
        group.classList.toggle('collapsed');
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

// ─── 5. 任务管理模块 (Task Management) ───
async function loadTasks() {
    try {
        const res = await fetch(`${API_BASE}/api/tasks`);
        if (!res.ok) return;
        const data = await res.json();

        // 1. 更新调度状态 UI
        updatePipelineUI(data.pipeline_running !== false);

        // 2. 更新顶部总览指标 (严格保证：已就绪数 + 排队数 = 视频总收录数)
        const sum = data.summary || {};
        const totalVideos = sum.total_videos || 0;
        const readyVideos = sum.ready || 0;
        const pendingVideos = (sum.pending !== undefined) ? sum.pending : Math.max(0, totalVideos - readyVideos);

        document.getElementById('statTotalVideos').textContent = totalVideos;
        document.getElementById('statProcessing').textContent = sum.processing || 0;
        document.getElementById('statPending').textContent = pendingVideos;
        document.getElementById('statReadyCoverage').textContent = `${sum.sub_coverage_pct || 0}%`;
        document.getElementById('statReadySubCount').textContent = `已就绪 ${readyVideos} 部 (共 ${sum.total_segments || 0} 句)`;

        // 官方原生字幕统计卡片
        const nativeCountEl = document.getElementById('statNativeCount');
        const nativePctEl = document.getElementById('statNativePct');
        if (nativeCountEl) nativeCountEl.textContent = sum.native_count || 0;
        if (nativePctEl) nativePctEl.textContent = `占比 ${sum.native_pct || 0}% | 创作者上传`;

        // 3. 更新侧边栏/底部 Tab 角标 (展示排队待完成总量)
        const tasksBadge = document.getElementById('navTasksBadge');
        if (tasksBadge) {
            tasksBadge.textContent = pendingVideos;
            tasksBadge.classList.toggle('pulse', (sum.processing || 0) > 0);
        }

        // 4. 如果当前处于任务管理界面，渲染任务流
        if (currentTab === 'tasks') {
            renderTaskList(data.tasks || []);
        }
    } catch (e) {
        console.error('Failed to load tasks', e);
    }
}

// 调度启动与暂停控制
async function togglePipeline() {
    try {
        const stateRes = await fetch(`${API_BASE}/api/pipeline/state`);
        const state = await stateRes.json();
        const action = state.running ? 'pause' : 'resume';
        const res = await fetch(`${API_BASE}/api/pipeline/${action}`, { method: 'POST' });
        const result = await res.json();
        updatePipelineUI(result.running);
        loadTasks();
    } catch (e) {
        console.error('Failed to toggle pipeline', e);
    }
}

function updatePipelineUI(running) {
    const badge = document.getElementById('pipelineStateBadge');
    const btnIcon = document.getElementById('btnPipelineIcon');
    const btnText = document.getElementById('btnPipelineText');
    if (badge) {
        if (running) {
            badge.style.background = '#dcfce7';
            badge.style.color = '#15803d';
            badge.innerHTML = '<span style="width:7px; height:7px; border-radius:50%; background:#16a34a; display:inline-block;"></span><span>调度运行中</span>';
        } else {
            badge.style.background = '#fee2e2';
            badge.style.color = '#b91c1c';
            badge.innerHTML = '<span style="width:7px; height:7px; border-radius:50%; background:#dc2626; display:inline-block;"></span><span>任务已暂停</span>';
        }
    }
    if (btnIcon && btnText) {
        if (running) {
            btnIcon.textContent = '⏸';
            btnText.textContent = '暂停任务';
        } else {
            btnIcon.textContent = '▶';
            btnText.textContent = '启动任务';
        }
    }
}

function renderTaskList(tasks) {
    const feed = document.getElementById('taskListFeed');
    if (!tasks || tasks.length === 0) {
        feed.innerHTML = `
            <div class="empty-hint" style="padding: 80px 20px;">
                <div style="font-size: 36px; margin-bottom: 12px;">🎉</div>
                <h3 style="font-size: 15px; color: #0f172a; margin-bottom: 6px;">任务队列空闲</h3>
                <p style="color: #64748b; font-size: 13px;">当前没有正在处理或排队中的视频，所有历史记录已完成字幕提取与全文索引。</p>
            </div>
        `;
        return;
    }

    let html = '';
    tasks.forEach(task => {
        const isProcessing = ['processing', 'transcribing', 'downloading'].includes(task.status);
        const isShort = (task.url && task.url.includes('/shorts/')) || (task.author === 'YouTube Shorts');
        const durText = escapeHtml(task.duration_str || '00:00');
        // Shorts 视频统一移除时长显示，仅显示 Shorts 标识；常规长视频显示真实时长
        const durationLabel = isShort ? 'Shorts' : durText;

        let statusTag = `<span class="badge-tag tag-pending">⏳ 排队等待中</span>`;
        if (task.status === 'downloading') {
            statusTag = `<span class="badge-tag tag-processing" style="background:#e0f2fe; color:#0369a1; font-weight:700;">📥 音频下载中</span>`;
        } else if (task.status === 'audio_ready') {
            statusTag = `<span class="badge-tag tag-processing" style="background:#dbeafe; color:#1d4ed8; font-weight:700;">🎵 音频就绪待转写</span>`;
        } else if (task.status === 'transcribing' || task.status === 'processing') {
            statusTag = `<span class="badge-tag tag-processing" style="background:#fef3c7; color:#b45309; font-weight:700;">⚡ ASR 转写中</span>`;
        }

        const stepText = task.current_step || (isProcessing ? '处理准备中' : '排队中');
        const pct = (typeof task.progress_pct === 'number' && task.progress_pct > 0) ? task.progress_pct : (isProcessing ? 10 : 0);
        const costTime = task.cost_time_str ? `已耗时 ${task.cost_time_str}` : '刚刚加入';

        html += `
            <div class="history-card" style="${isProcessing ? 'border-color:#f59e0b; background:#fffdfa;' : ''}">
                <div class="result-thumb">
                    <img src="${escapeHtml(task.thumbnail_url)}" alt="thumb" loading="lazy" onerror="this.src='https://placehold.co/120x68?text=Video'">
                    <span class="result-duration" style="${isShort ? 'background:#be185d;' : ''}">${durationLabel}</span>
                </div>
                <div class="result-info">
                    <div class="result-title" title="${escapeHtml(task.title)}">${escapeHtml(task.title)}</div>
                    <div class="result-meta">
                        <span>${escapeHtml(task.author || 'YouTube')}</span>
                        <span>•</span>
                        <span>观看于 ${escapeHtml(task.watched_at || '')}</span>
                    </div>

                    <!-- 进度卡片垂直信息流：当前步骤、处理进度、累计耗时各自独占一行，绝不折行 -->
                    <div class="task-info-block" style="margin-top: 8px; display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: #475569;">
                        <!-- 第 1 行：当前步骤 -->
                        <div style="display: flex; align-items: center; gap: 6px;">
                            <span style="color: #64748b; font-size: 11px; flex-shrink: 0;">当前步骤：</span>
                            ${statusTag}
                            <span style="font-weight: 600; color: #1e293b;">${escapeHtml(stepText)}</span>
                        </div>

                        <!-- 第 2 行：处理进度 -->
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <span style="color: #64748b; font-size: 11px; flex-shrink: 0;">处理进度：</span>
                            <div class="progress-bar-bg" style="flex: 1; height: 6px; background: #e2e8f0; border-radius: 3px; overflow: hidden;">
                                <div class="progress-bar-val" style="width: ${pct}%; height: 100%; background: ${isProcessing ? '#d97706' : '#94a3b8'}; transition: width 0.3s;"></div>
                            </div>
                            <span style="font-weight: 700; font-size: 11px; color: #334155; min-width: 32px; text-align: right;">${pct}%</span>
                        </div>

                        <!-- 第 3 行：累计耗时 -->
                        <div style="display: flex; align-items: center; gap: 6px;">
                            <span style="color: #64748b; font-size: 11px; flex-shrink: 0;">累计耗时：</span>
                            <span style="color: #64748b; font-family: monospace;">${escapeHtml(costTime)}</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
    });

    feed.innerHTML = html;
}

// ─── 6. 台词时间轴渲染与局部二次过滤 ───
function renderTimelineRows(segments, containerId, highlightSec = null, keyword = '') {
    const container = document.getElementById(containerId);
    if (!segments || segments.length === 0) {
        container.innerHTML = '<div class="empty-hint">该视频暂无字幕分段</div>';
        return;
    }

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
