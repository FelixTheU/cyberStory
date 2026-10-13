/**
 * CyberHistoryExplorer — Frontend interaction & API logic
 */

const API_BASE = '';
let currentDrawerSubs = [];
let currentDrawerVideoId = '';

// ─── Init ───
document.addEventListener('DOMContentLoaded', () => {
    loadStats();
    // Keyboard shortcut: / to focus search
    document.addEventListener('keydown', (e) => {
        if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
            e.preventDefault();
            document.getElementById('searchInput').focus();
        }
        if (e.key === 'Escape') {
            closeDrawer();
        }
    });
    // Enter to search
    document.getElementById('searchInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doSearch();
    });
});

// ─── Stats ───
async function loadStats() {
    try {
        const res = await fetch(`${API_BASE}/api/status`);
        const data = await res.json();
        document.getElementById('statTotal').textContent = data.total_videos || 0;
        document.getElementById('statReady').textContent = data.ready || 0;
        document.getElementById('statPending').textContent = data.pending || 0;
    } catch {
        // silent
    }
}

// ─── Search ───
async function doSearch() {
    const q = document.getElementById('searchInput').value.trim();
    if (!q) return;

    const section = document.getElementById('resultsSection');
    section.innerHTML = `<div class="loading"><div class="spinner"></div><p>正在搜索...</p></div>`;

    try {
        const res = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(q)}&page=1&page_size=50`);
        const data = await res.json();
        renderResults(data, q);
    } catch (err) {
        section.innerHTML = `<div class="empty-state"><div class="emoji">⚠️</div><h3>搜索出错</h3><p>${err.message}</p></div>`;
    }
}

// ─── Render Results ───
function renderResults(data, query) {
    const section = document.getElementById('resultsSection');

    if (!data.items || data.items.length === 0) {
        section.innerHTML = `
            <div class="empty-state">
                <div class="emoji">🤷</div>
                <h3>未找到匹配结果</h3>
                <p>尝试使用不同的关键词搜索</p>
            </div>`;
        return;
    }

    let html = `<p class="results-info">找到 <strong>${data.items.length}</strong> 个匹配结果</p>`;

    for (const item of data.items) {
        const thumbUrl = item.thumbnail_url || `https://i.ytimg.com/vi/${item.source_id}/hqdefault.jpg`;
        const duration = formatDuration(item.duration_sec);
        const jumpUrl = item.jump_url || item.url;
        const timeStamp = item.time_stamp || '00:00';
        const snippet = item.snippet || item.title;
        const videoUrl = item.url || `https://www.youtube.com/watch?v=${item.source_id}`;

        html += `
        <div class="result-card">
            <div class="card-thumb">
                <img src="${escapeHtml(thumbUrl)}" alt="" loading="lazy"
                     onerror="this.style.display='none'">
                ${duration ? `<span class="duration-badge">${duration}</span>` : ''}
            </div>
            <div class="card-content">
                <div class="card-title">
                    <a href="${escapeHtml(videoUrl)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>
                    <span class="ext-icon">↗</span>
                </div>
                <div class="card-meta">
                    ${item.author ? `<span>📺 ${escapeHtml(item.author)}</span>` : ''}
                    ${item.watched_at ? `<span>🕐 ${escapeHtml(item.watched_at)}</span>` : ''}
                    ${item.sub_source ? `<span>📝 ${item.sub_source === 'native' ? '原生字幕' : item.sub_source === 'asr' ? 'AI转写' : '仅标题'}</span>` : ''}
                </div>
                <div class="card-snippet">${snippet}</div>
                <div class="card-actions">
                    <a class="time-badge" href="${escapeHtml(jumpUrl)}" target="_blank" rel="noopener">
                        ⏱ ${timeStamp}
                    </a>
                    <button class="btn-subtitle" onclick="openSubtitleDrawer(${item.id}, '${escapeHtml(item.title)}', '${escapeHtml(item.source_id)}')">
                        📜 查看完整字幕
                    </button>
                </div>
            </div>
        </div>`;
    }

    section.innerHTML = html;
}

// ─── Subtitle Drawer ───
async function openSubtitleDrawer(itemId, title, videoId) {
    const overlay = document.getElementById('drawerOverlay');
    const drawer = document.getElementById('subtitleDrawer');
    const body = document.getElementById('drawerBody');

    document.getElementById('drawerTitle').textContent = title || '完整字幕';
    document.getElementById('drawerFilter').value = '';
    body.innerHTML = `<div class="loading"><div class="spinner"></div><p>加载字幕中...</p></div>`;

    overlay.classList.add('open');
    drawer.classList.add('open');

    currentDrawerVideoId = videoId;

    try {
        const res = await fetch(`${API_BASE}/api/items/${itemId}/subtitles`);
        const data = await res.json();
        currentDrawerSubs = data.subtitles || [];
        renderSubtitles(currentDrawerSubs, videoId);
    } catch {
        body.innerHTML = `<p style="color:#94a3b8;text-align:center;padding:40px">暂无字幕数据</p>`;
    }
}

function renderSubtitles(subs, videoId) {
    const body = document.getElementById('drawerBody');
    if (!subs.length) {
        body.innerHTML = `<p style="color:#94a3b8;text-align:center;padding:40px">暂无字幕数据</p>`;
        return;
    }

    let html = '';
    for (const s of subs) {
        const jumpUrl = `https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(s.start)}s`;
        html += `
        <div class="sub-line" data-text="${escapeHtml(s.text).toLowerCase()}">
            <a class="sub-time" href="${jumpUrl}" target="_blank" rel="noopener">${s.time_str || formatTime(s.start)}</a>
            <span class="sub-text">${escapeHtml(s.text)}</span>
        </div>`;
    }
    body.innerHTML = html;
}

function filterSubtitles() {
    const q = document.getElementById('drawerFilter').value.trim().toLowerCase();
    const lines = document.querySelectorAll('#drawerBody .sub-line');
    lines.forEach(line => {
        const text = line.getAttribute('data-text') || '';
        line.style.display = (!q || text.includes(q)) ? '' : 'none';
    });
}

function closeDrawer() {
    document.getElementById('drawerOverlay').classList.remove('open');
    document.getElementById('subtitleDrawer').classList.remove('open');
}

// ─── Helpers ───
function formatDuration(sec) {
    if (!sec || sec <= 0) return '';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function formatTime(sec) {
    const total = Math.floor(sec);
    const m = Math.floor(total / 60);
    const s = total % 60;
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
