/**
 * cyberstory 前端交互逻辑
 * 支持三栏联动：A区(历史流) -> B区(全文搜索) -> C区(台词时间轴)
 */

const API_BASE = '';

let currentActiveItemId = null;
let currentSubtitles = [];
let allHistoryItems = [];

document.addEventListener('DOMContentLoaded', () => {
    initService();
    initSearch();
    initSubFilter();
    loadHistoryFeed();
    setInterval(loadHistoryFeed, 10000); // 10秒定时刷新状态与进度
});

// ─── 1. 初始化服务与状态 ───
async function initService() {
    try {
        const res = await fetch(`${API_BASE}/api/status`);
        if (res.ok) {
            const data = await res.json();
            document.getElementById('serviceDot').style.background = '#22c55e';
            document.getElementById('serviceStatusText').textContent = '本地服务运行中 (:8765)';
            document.getElementById('navBadgeCount').textContent = data.total_videos || '0';
        }
    } catch (e) {
        document.getElementById('serviceDot').style.background = '#ef4444';
        document.getElementById('serviceStatusText').textContent = '服务离线或异常';
    }
}

// ─── 2. 加载 A 区历史流水 (按日期分组) ───
async function loadHistoryFeed() {
    try {
        const res = await fetch(`${API_BASE}/api/history`);
        if (!res.ok) return;
        const groups = await res.json();

        let totalCount = 0;
        groups.forEach(g => totalCount += (g.items ? g.items.length : 0));
        document.getElementById('historyMetaCount').textContent = `共 ${totalCount} 条`;
        document.getElementById('navBadgeCount').textContent = totalCount;

        renderHistoryFeed(groups);
    } catch (e) {
        console.error('Failed to load history feed', e);
    }
}

function renderHistoryFeed(groups) {
    const feed = document.getElementById('historyFeed');
    if (!groups || groups.length === 0) {
        feed.innerHTML = '<div class="empty-hint">暂无历史记录</div>';
        return;
    }

    let html = '';
    groups.forEach(group => {
        html += `
            <div class="date-group">
                <div class="date-title">
                    ${escapeHtml(group.date)}
                    <span>${group.items.length} 个视频</span>
                </div>
        `;

        group.items.forEach(item => {
            const isActive = currentActiveItemId === item.id ? 'active' : '';

            // 状态徽标
            let badgeHtml = '';
            let progressHtml = '';

            if (item.status === 'ready') {
                if (item.sub_source === 'native') {
                    badgeHtml = `<span class="badge-tag tag-native">📝 原生官方字幕</span>`;
                } else if (item.sub_source === 'asr') {
                    badgeHtml = `<span class="badge-tag tag-asr">🎙 AI转写完成</span>`;
                } else {
                    badgeHtml = `<span class="badge-tag tag-pending">纯标题 (无字幕)</span>`;
                }
                if (item.cost_time_str) {
                    badgeHtml += `<span style="font-size:10px; color:#94a3b8;">耗时 ${escapeHtml(item.cost_time_str)}</span>`;
                }
            } else if (item.status === 'processing') {
                const stepText = item.current_step || '正在处理';
                const pct = item.progress_pct || 30;
                badgeHtml = `<span class="badge-tag tag-processing">⚡ ${escapeHtml(stepText)}</span>`;
                progressHtml = `
                    <div class="progress-block">
                        <div style="display:flex; justify-content:space-between;">
                            <span>${escapeHtml(stepText)}</span>
                            <span><b>${pct}%</b></span>
                        </div>
                        <div class="progress-bar-bg">
                            <div class="progress-bar-val" style="width: ${pct}%;"></div>
                        </div>
                    </div>
                `;
            } else if (item.status === 'failed') {
                badgeHtml = `<span class="badge-tag tag-failed">❌ 处理失败</span>`;
            } else {
                badgeHtml = `<span class="badge-tag tag-pending">⏳ 待处理 (排队中)</span>`;
            }

            html += `
                <div class="history-card ${isActive}" id="hist-card-${item.id}" onclick="selectItem(${item.id})">
                    <div class="thumb-box">
                        <img src="${escapeHtml(item.thumbnail_url)}" alt="thumb" loading="lazy" onerror="this.src='https://placehold.co/100x56?text=Video'">
                        <span class="thumb-duration">${escapeHtml(item.duration_str)}</span>
                    </div>
                    <div class="card-info">
                        <div class="card-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
                        <div class="card-channel">${escapeHtml(item.author || 'YouTube')}</div>
                        <div class="card-badges">
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
}

// ─── 3. 选择卡片联动 C 区详情 ───
async function selectItem(itemId, highlightSec = null, highlightText = '') {
    currentActiveItemId = itemId;

    // 更新 A 区高亮
    document.querySelectorAll('.history-card').forEach(el => el.classList.remove('active'));
    const activeEl = document.getElementById(`hist-card-${itemId}`);
    if (activeEl) activeEl.classList.add('active');

    // 加载 C 区
    document.getElementById('detailTitle').textContent = '加载台词中...';
    document.getElementById('detailMetaBar').innerHTML = '<span>获取时间轴列表...</span>';
    document.getElementById('timelineStream').innerHTML = '<div class="empty-hint">正在读取时间轴...</div>';

    try {
        const res = await fetch(`${API_BASE}/api/items/${itemId}/subtitles`);
        if (!res.ok) {
            document.getElementById('timelineStream').innerHTML = '<div class="empty-hint">暂无可用字幕/台词记录</div>';
            return;
        }
        const data = await res.json();
        currentSubtitles = data.subtitles || [];

        // 查找卡片元信息
        let itemTitle = '视频详情';
        let itemChannel = '';
        let itemUrl = `https://www.youtube.com/watch?v=`;

        const card = document.getElementById(`hist-card-${itemId}`);
        if (card) {
            itemTitle = card.querySelector('.card-title').textContent;
            itemChannel = card.querySelector('.card-channel').textContent;
        }

        document.getElementById('detailTitle').textContent = itemTitle;
        document.getElementById('detailMetaBar').innerHTML = `
            <span>${escapeHtml(itemChannel)}</span>
            <span>•</span>
            <span>共 ${currentSubtitles.length} 条台词分段</span>
        `;

        renderTimeline(currentSubtitles, highlightSec, highlightText);
    } catch (e) {
        console.error('Failed to load item subtitles', e);
        document.getElementById('timelineStream').innerHTML = '<div class="empty-hint">读取字幕失败</div>';
    }
}

function renderTimeline(segments, highlightSec = null, highlightKeyword = '') {
    const stream = document.getElementById('timelineStream');
    if (!segments || segments.length === 0) {
        stream.innerHTML = '<div class="empty-hint">该视频暂无提取的字幕分段</div>';
        return;
    }

    let html = '';
    segments.forEach((seg, idx) => {
        const sec = seg.start;
        const timeStr = seg.time_str || '00:00';
        let isHighlighted = false;

        if (highlightSec !== null && Math.abs(sec - highlightSec) < 3.0) {
            isHighlighted = true;
        }

        let lineText = escapeHtml(seg.text);
        if (highlightKeyword && lineText.toLowerCase().includes(highlightKeyword.toLowerCase())) {
            isHighlighted = true;
            const reg = new RegExp(highlightKeyword, 'gi');
            lineText = lineText.replace(reg, m => `<mark style="background:#fef08a; padding:1px 3px;">${m}</mark>`);
        }

        html += `
            <div class="timeline-row ${isHighlighted ? 'highlighted' : ''}" id="timeline-row-${idx}">
                <a href="${seg.url || '#'}&t=${Math.floor(sec)}s" target="_blank" class="time-badge">${escapeHtml(timeStr)}</a>
                <div class="timeline-text">${lineText}</div>
            </div>
        `;
    });

    stream.innerHTML = html;

    // 自动滚动到高亮行
    const firstHigh = stream.querySelector('.timeline-row.highlighted');
    if (firstHigh) {
        firstHigh.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

// ─── 4. B 区搜索逻辑 ───
function initSearch() {
    const input = document.getElementById('searchInput');
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            doSearch();
        }
    });
}

async function doSearch() {
    const q = document.getElementById('searchInput').value.trim();
    const resultsContainer = document.getElementById('searchResults');
    const metaText = document.getElementById('searchMetaText');
    const costText = document.getElementById('searchCostText');

    if (!q) {
        resultsContainer.innerHTML = '<div class="empty-hint">请输入关键词检索全文台词</div>';
        metaText.textContent = '输入关键词检索全文台词';
        costText.textContent = '';
        return;
    }

    metaText.textContent = `正在检索 "${escapeHtml(q)}"...`;
    resultsContainer.innerHTML = '<div class="empty-hint">正在搜索全文索引...</div>';

    const t0 = performance.now();
    try {
        const res = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(q)}`);
        const elapsed = Math.round(performance.now() - t0);
        if (!res.ok) throw new Error('Search failed');
        const data = await res.json();

        costText.textContent = `耗时 ${elapsed}ms`;
        metaText.textContent = `关键词 "${escapeHtml(q)}" 命中 ${data.total} 条`;

        renderSearchResults(data.items, q);
    } catch (e) {
        console.error(e);
        resultsContainer.innerHTML = '<div class="empty-hint">搜索失败，请检查服务连接</div>';
    }
}

function renderSearchResults(items, keyword) {
    const container = document.getElementById('searchResults');
    if (!items || items.length === 0) {
        container.innerHTML = '<div class="empty-hint">未检索到匹配的视频台词</div>';
        return;
    }

    let html = '';
    items.forEach(item => {
        const durationStr = formatSeconds(item.duration_sec);
        const subBadge = item.sub_source === 'native'
            ? '<span class="badge-tag tag-native">原生字幕</span>'
            : (item.sub_source === 'asr' ? '<span class="badge-tag tag-asr">AI转写</span>' : '');

        html += `
            <div class="result-card" onclick="selectItem(${item.id}, ${item.start_sec || 0}, '${escapeHtml(keyword)}')">
                <div class="result-top">
                    <div class="thumb-box">
                        <img src="${escapeHtml(item.thumbnail_url)}" alt="thumb" loading="lazy">
                        <span class="thumb-duration">${escapeHtml(durationStr)}</span>
                    </div>
                    <div class="result-detail">
                        <div class="result-title">${escapeHtml(item.title)}</div>
                        <div class="result-meta">
                            <span>📺 ${escapeHtml(item.author || 'YouTube')}</span>
                            <span>🕐 ${escapeHtml(item.watched_at || '')}</span>
                            ${subBadge}
                        </div>
                    </div>
                </div>

                <div class="snippet-box">
                    ${item.snippet || item.fts_snippet || escapeHtml(item.title)}
                </div>

                <div class="result-actions">
                    <a href="${escapeHtml(item.jump_url)}" target="_blank" class="time-jump-btn" onclick="event.stopPropagation();">
                        ⏱ ${escapeHtml(item.time_stamp || '00:00')} (直达播放) ↗
                    </a>
                    <button class="view-detail-btn" onclick="selectItem(${item.id}, ${item.start_sec || 0}, '${escapeHtml(keyword)}'); event.stopPropagation();">
                        👉 在右侧查看全篇字幕 (C区)
                    </button>
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

// ─── 5. C 区字幕内部二次过滤 ───
function initSubFilter() {
    const filterInput = document.getElementById('subFilterInput');
    filterInput.addEventListener('input', () => {
        const q = filterInput.value.trim().toLowerCase();
        const rows = document.querySelectorAll('#timelineStream .timeline-row');
        rows.forEach(r => {
            const text = r.querySelector('.timeline-text').textContent.toLowerCase();
            if (!q || text.includes(q)) {
                r.style.display = 'flex';
            } else {
                r.style.display = 'none';
            }
        });
    });
}

// ─── 工具辅助函数 ───
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
