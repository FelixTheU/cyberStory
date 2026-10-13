# cyberstory 系统设计文档

## 1. 系统概述与目标

**cyberstory** 是一个面向个人的全文本地历史记录检索与知识管理系统。
当前阶段核心聚焦于 **YouTube 历史记录的台词级全文检索**。

### 1.1 核心痛点
- **传统历史记录检索的局限**：浏览器或 YouTube 自带的历史搜索仅支持对**视频标题**和**频道名称**的模糊匹配，无法触及视频内部实际讲授的核心观点、关键词和对话内容。
- **信息沉淀与回溯困难**：用户在观看访谈、教程、科普或新闻视频后，往往只记得“某人在某期视频中提到了某个概念”，难以通过标题准确定位到具体视频，更无法快速找到对应的时间节点。

### 1.2 系统目标
1. **静默/自动采集**：利用浏览器常驻的 YouTube 历史记录页，通过油猴（Tampermonkey）脚本定期扫描增量观看记录并同步至本地服务端。
2. **多模态台词提取**：
   - **快速通道**：优先抓取 YouTube 原生字幕（官方人工字幕或自动生成字幕），秒级完成解析。
   - **ASR 降级通道**：对于无字幕视频，自动提取音频流并调用本地轻量级语音识别引擎（Faster-Whisper）生成带时间戳的逐句转写文本。
3. **全文检索引擎**：基于本地 SQLite FTS5 构建分词全文索引，提供毫秒级全文匹配与上下文高亮（Snippet）。
4. **精准回溯体验**：在 Web 搜索界面中直接呈现命中内容的前后上下文，点击对应时间戳直达 YouTube 原视频对应秒数播放；同时支持查看完整字幕流。
5. **架构可扩展性**：底层数据模型保持通用化，预留对知乎、微信公众号等图文历史的接入能力。

---

## 2. 总体架构与数据流

### 2.1 架构分层

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        数据采集层 (Chrome 浏览器端)                       │
│                                                                        │
│   常驻标签页: https://www.youtube.com/feed/history                      │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │ 油猴守护脚本 (Tampermonkey Daemon)                              │   │
│   │ - 定时增量扫描 DOM (yt-lockup-view-model)                       │   │
│   │ - 游标对比与去重 (GM_getValue: last_synced_video_id)             │   │
│   │ - 状态小胶囊 UI (连接状态 / 上次同步数 / [立即同步]按钮)          │   │
│   │ - 增量上报: POST http://127.0.0.1:8765/api/sync/youtube         │   │
│   └────────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTP JSON
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                       服务端业务与调度层 (FastAPI)                       │
│                                                                        │
│   ┌───────────────────────────┐     ┌──────────────────────────────┐   │
│   │ REST API 控制器            │     │ 异步处理任务管道 (Worker)     │   │
│   │ - POST /api/sync/youtube  │────>│ 1. 任务排队与去重            │   │
│   │ - GET  /api/search        │     │ 2. 字幕/音频分流处理          │   │
│   │ - GET  /api/items/{id}    │     │ 3. 结果入库与临时文件清理    │   │
│   └───────────────────────────┘     └──────────────┬───────────────┘   │
└──────────────────┬─────────────────────────────────┼───────────────────┘
                   │                                 ▼
                   │                  ┌──────────────────────────────┐
                   │                  │   处理引擎 (Pipeline Core)    │
                   │                  │   - yt-dlp (字幕抓取/音频抽取) │
                   │                  │   - faster-whisper (本地 ASR) │
                   │                  └──────────────┬───────────────┘
                   ▼                                 ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        数据存储与检索引擎 (SQLite)                       │
│                                                                        │
│   ┌─────────────────────┐   ┌──────────────────────────────────────┐   │
│   │ items 表            │   │ video_subtitles 表                   │   │
│   │ (通用历史元数据)    │   │ (video_id, start_sec, end_sec, text) │   │
│   └──────────┬──────────┘   └──────────────────┬───────────────────┘   │
│              │                                 │                       │
│              └────────────────┬────────────────┘                       │
│                               ▼                                        │
│               ┌────────────────────────────────┐                       │
│               │ subtitles_fts 全文索引虚拟表    │                       │
│               │ (FTS5 + Trigram / 中文分词)    │                       │
│               └────────────────────────────────┘                       │
└───────────────────────────────────▲────────────────────────────────────┘
                                    │ Query & Highlights
                                    │
┌───────────────────────────────────┴────────────────────────────────────┐
│                        Web 交互检索端 (Frontend)                        │
│                                                                        │
│   - 单页检索交互界面 (FastAPI 静态托管)                                  │
│   - 实时搜索：视频卡片 + 命中关键词上下文高亮片段 (Snippets)             │
│   - 锚点跳转：点击命中时间戳直达 YouTube (https://youtu.be/...&t=120s)  │
│   - 完整字幕抽屉：展开查看全篇台词流水与时间轴                          │
└────────────────────────────────────────────────────────────────────────┘
```

### 2.2 数据生命周期与处理时序

```text
[油猴脚本]               [FastAPI 服务端]          [任务管道 Worker]          [SQLite 数据库]
   │                           │                         │                       │
   │ 1. 扫描新增记录           │                         │                       │
   │──────────────────────────>│                         │                       │
   │    POST /api/sync/youtube │                         │                       │
   │                           │ 2. 插入元数据 (pending) │                       │
   │                           │────────────────────────────────────────────────>│
   │ 3. 返回同步响应           │                         │                       │
   │<──────────────────────────│                         │                       │
   │                           │ 4. 触发后台 Worker 队列 │                       │
   │                           │────────────────────────>│                       │
   │                           │                         │ 5. yt-dlp 探查字幕    │
   │                           │                         │──┐                    │
   │                           │                         │  │ 有字幕             │
   │                           │                         │<─┘                    │
   │                           │                         │ (若无字幕则走 ASR)    │
   │                           │                         │──┐                    │
   │                           │                         │  │ 抽音频 + Whisper   │
   │                           │                         │<─┘                    │
   │                           │                         │ 6. 写入字幕分段与全文 │
   │                           │                         │──────────────────────>│
   │                           │                         │ 7. 更新状态为 ready   │
   │                           │                         │──────────────────────>│
```

---

## 3. 核心模块详细设计

### 3.1 模块一：油猴常驻采集脚本 (Tampermonkey Daemon)

#### 1. 运行环境与目标页面
- **匹配网址**：`https://www.youtube.com/feed/history*`
- **运行前提**：用户在 Chrome 中保持该标签页长期打开。

#### 2. DOM 解析规范（适配现代 YouTube Web）
当前 YouTube 采用 Polymer 架构，历史列表渲染为 `yt-lockup-view-model` 组件：
- **Video ID**：从 `a[href*="/watch?v="]` 中解析参数 `v`。
- **Title**：从视频卡片的标题节点或 `h3` 获取文本。
- **Channel**：从卡片文本中解析频道/作者名称。
- **Duration**：从缩略图时长徽标提取（如 `11:36`、`1:06:00`），转换为秒数存储。
- **Thumbnail**：提取 `https://i.ytimg.com/vi/{videoId}/hqdefault.jpg`。
- **Watched Date**：从当前卡片所在的父级日期分组标题（如“今天”、“昨天”、“9月11日”）提取归类。

#### 3. 增量对比与去重机制
- 脚本使用 `GM_getValue('last_synced_video_ids', [])` 缓存最近已同步的 ID 列表（保留最近 50 个已同步 ID 构成滑动窗口）。
- 每次扫描时从顶部向下迭代卡片，若遇到处于已同步集合中的记录，则判定新增数据扫描完毕，立即截断。

#### 4. 自动化轮询调度
- **定时心跳**：使用 `setInterval` 每隔 30 分钟检查一次页面是否有新卡片出现。
- **保活与软刷新**：若连续 6 小时无新视频，执行一次页面静默刷新（`window.location.reload()`），确保能加载最新的历史流。
- **防重复触发锁**：同步过程中加锁，避免并发重复上报。

#### 5. 页面小胶囊 UI 设计
在历史记录页面右下角固定注入一个低侵入悬浮胶囊：
- 🟢/🔴 指示灯：实时显示与本地服务端 (`http://127.0.0.1:8765/api/health`) 的连接心跳。
- 文本提示：`CyberHistory: 已同步 12 条 | 下次同步: 15:30`。
- 快捷操作：`[立即同步]` 按钮，允许用户刚看完视频后手动一键同步。

---

### 3.2 模块二：数据模型与存储设计 (SQLite + FTS5)

选用本地文件型数据库 **SQLite 3**，开启 **WAL (Write-Ahead Logging)** 模式以保证读写并发不锁库。

#### 1. 数据库表结构定义 (DDL)

```sql
-- 1. 核心条目表 (预留多源字段，当前 source 固定为 'youtube')
CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL DEFAULT 'youtube',       -- 平台来源: youtube, zhihu, wechat
    source_id TEXT NOT NULL,                     -- 平台内部唯一ID (如 YouTube videoId)
    title TEXT NOT NULL,                         -- 视频/文章标题
    author TEXT,                                 -- 频道名 / 作者
    url TEXT NOT NULL,                           -- 原始跳转链接
    duration_sec INTEGER DEFAULT 0,              -- 视频时长 (秒)
    thumbnail_url TEXT,                          -- 封面缩略图地址
    watched_at TEXT,                             -- 浏览/观看时间戳或相对描述
    status TEXT NOT NULL DEFAULT 'pending',      -- 处理状态: pending, fetching_sub, transcribing, ready, failed
    sub_source TEXT,                             -- 字幕来源: native (官方/机翻字幕), asr (本地模型转写), none
    error_message TEXT,                          -- 错误原因 (若失败)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source, source_id)
);

-- 2. 字幕分段详情表 (保留逐句精准时间戳，供精准跳转)
CREATE TABLE IF NOT EXISTS video_subtitles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL,
    start_sec REAL NOT NULL,                     -- 起始时间 (秒，支持小数)
    end_sec REAL NOT NULL,                       -- 结束时间 (秒)
    text TEXT NOT NULL,                          -- 分段文字内容
    FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_video_subtitles_item_id ON video_subtitles(item_id);

-- 3. 全文检索虚拟表 (SQLite FTS5)
-- 使用 trigram 分词器对中英混合内容进行滑动切词，支持前缀、包含与高亮
CREATE VIRTUAL TABLE IF NOT EXISTS subtitles_fts USING fts5(
    item_id UNINDEXED,                           -- 关联 items.id
    title,                                       -- 标题
    author,                                      -- 频道名
    content,                                     -- 完整文本或分段内容
    tokenize = 'trigram'
);
```

#### 2. 检索与高亮查询原理
通过 FTS5 的 `snippet` 函数提取匹配词的前后上下文：
```sql
SELECT 
    items.id,
    items.source_id,
    items.title,
    items.author,
    items.url,
    items.duration_sec,
    items.thumbnail_url,
    items.watched_at,
    snippet(subtitles_fts, 3, '<mark>', '</mark>', '...', 16) AS highlight_snippet,
    bm25(subtitles_fts) AS rank_score
FROM subtitles_fts
JOIN items ON items.id = subtitles_fts.item_id
WHERE subtitles_fts MATCH :query
ORDER BY rank_score ASC
LIMIT :limit OFFSET :offset;
```

---

### 3.3 模块三：服务端异步处理管道 (Subtitle & ASR Pipeline)

#### 1. 任务流转状态机
```text
  [pending] 
     │
     ▼
[fetching_sub] ──(抓到原生字幕)──> [ready]
     │
     ▼ (无原生字幕)
[transcribing] ──(Whisper转写完成)──> [ready]
     │
     ▼ (任一步骤发生不可恢复异常)
  [failed]
```

#### 2. 字幕探查与下载（路径 A：原生字幕优先）
- **工具**：`yt-dlp`（Python 库调用或命令行调用）。
- **参数控制**：
  ```bash
  yt-dlp \
    --skip-download \
    --write-sub --write-auto-sub \
    --sub-lang "zh-Hans,zh,zh-Hant,en" \
    --sub-format "vtt/json3" \
    --proxy "http://127.0.0.1:10809" \
    -o "temp/subs/%(id)s.%(ext)s" \
    "https://www.youtube.com/watch?v={videoId}"
  ```
- **解析器**：解析生成的 `.vtt` 或 `.json3` 格式，将其格式化为具有 `start_sec`, `end_sec`, `text` 的规范数据结构。
- **性能优势**：只抓取几 KB 的文本文件，单条视频处理耗时仅约 1~3 秒。

#### 3. 语音转录降级（路径 B：无字幕时 ASR）
- **音频流抽取**：当检测到无任何字幕时，仅下载音频轨（不拉取画面流以极大缩短传输时间）：
  ```bash
  yt-dlp \
    -x --audio-format opus --audio-quality 0 \
    --proxy "http://127.0.0.1:10809" \
    -o "temp/audio/%(id)s.%(ext)s" \
    "https://www.youtube.com/watch?v={videoId}"
  ```
- **转写推理**：调用本地 `faster-whisper`：
  - **默认模型**：`large-v3-turbo`（显存充足时推荐，速度极快且中英准确率顶尖）或 `small` / `base`（纯 CPU 极低占用环境）。
  - **参数设置**：
    ```python
    segments, info = model.transcribe(
        audio_path,
        beam_size=5,
        language="zh",
        vad_filter=True, # 启用 VAD 静音切除，加速长音频处理
        vad_parameters=dict(min_silence_duration_ms=500)
    )
    ```
- **存储节约策略**：转写完成后，立即调用 `os.remove(audio_path)` **彻底删除临时音频文件**，仅将提纯后的文字分段写入数据库，避免硬盘空间被巨量音频占满。

#### 4. 并发控制与防风控机制
- **串行处理排队**：Worker 严格单线程串行处理（Concurrency = 1），各视频处理之间插入 2~5 秒的随机延迟，防止短时间内对 YouTube 产生高频并发导致触发 HTTP 429 或 Google 验证码。
- **网络代理穿透**：服务端统一支持读取系统环境变量 `HTTP_PROXY`/`HTTPS_PROXY` 或配置文件中的代理端口（如 `http://127.0.0.1:10809`）。

---

### 3.4 模块四：Web 检索前端界面设计

前端采用极简现代风格（Light 风格，纯白高对比底色、清晰阴影与卡片结构），单文件 SPA 直接嵌入在 FastAPI 中，启动即用。

#### 1. 核心布局规范
1. **顶部导航栏 (Header)**：
   - 品牌 Logo 与标题：`CyberHistoryExplorer`。
   - 统计仪表盘：总索引视频数、字幕覆盖率、队列待处理数。
2. **中心检索区 (Search Bar)**：
   - 沉浸式搜索输入框（快捷键 `/` 自动聚焦）。
   - 过滤筛选标签：`全部` / `有字幕` / `观看时间范围`。
3. **结果列表流 (Result Feed)**：
   - 每张卡片包含：
     - **左侧**：视频缩略图（带总时长徽标）。
     - **中间**：视频标题（带外链图标）、频道作者、观看时间。
     - **命中上下文高亮区（核心亮点）**：展示匹配的台词片段，匹配关键词以 `<mark>` 高亮。
     - **时间戳直达徽章**：计算该分段的起始秒数并格式化（如 `[04:12]`），点击新开标签直接跳转 `https://www.youtube.com/watch?v={id}&t=252s`。
     - **功能按钮**：【查看完整字幕】按钮。
4. **右侧字幕抽屉 (Subtitle Drawer)**：
   - 点击卡片右侧的【查看完整字幕】，页面右侧滑出全文字幕面板。
   - 列表按时间轴递增展示每句台词，支持在抽屉内进行本地文本过滤（快速定位全篇上下文）。

---

## 4. API 接口定义

| 方法 | 路径 | 功能说明 | 核心参数 / 请求体 |
|---|---|---|---|
| `GET` | `/api/health` | 服务健康检查与心跳 | 无 |
| `POST` | `/api/sync/youtube` | 接收油猴脚本上报的历史记录 | `items: Array<VideoMeta>` |
| `GET` | `/api/search` | 全文检索接口 | `q` (关键词), `page`, `page_size` |
| `GET` | `/api/items/{id}/subtitles` | 获取单视频完整字幕时间轴 | 路径参数 `id` |
| `GET` | `/api/status` | 获取系统索引与任务队列状态 | 无 |

---

## 5. 项目工程结构规范

项目落地在目录 `D:\space\gemini-space\07-CyberHistoryExplorer\`，代码结构规划如下：

```text
07-CyberHistoryExplorer/
├── design.md                      # 系统设计文档 (本文件)
├── requirements.txt               # Python 依赖清单 (fastapi, uvicorn, yt-dlp, faster-whisper, 等)
├── config.py                      # 统一配置 (端口, 代理, 数据库路径, 模型尺寸)
├── server.py                      # FastAPI 主入口与路由服务
├── database.py                    # SQLite 数据库初始化、FTS5 虚拟表建表与数据访问层
├── pipeline.py                    # yt-dlp 字幕抽取与 faster-whisper ASR 调度管道
├── userscript/
│   └── youtube-history-sync.user.js # Tampermonkey 历史记录采集油猴脚本
├── static/
│   ├── index.html                 # 检索 Web 前端单页应用
│   └── app.js                     # 前端交互与 API 联动逻辑
└── .data/                         # 数据持久化目录 (自动生成)
    ├── cyber_history.db           # SQLite 数据库文件 (含 FTS5 索引)
    └── temp/                      # 临时抓取目录 (转写完毕自动清理)
```

---

## 6. 后续多源扩展路线图 (Future Roadmap)

虽然当前专注于 YouTube 历史记录，但数据结构与检索层已完成通用化解耦：
1. **知乎历史检索 (Zhihu)**：
   - 油猴脚本扩展知乎个人历史页；
   - 提取知乎回答/专栏正文（Markdown），直接入库 FTS5，提供站内直接阅读模式。
2. **微信公众号文章历史 (WeChat MP)**：
   - 抓取已读公众号推文的正文与结构化图文；
   - 统一合并入 `subtitles_fts` / 全文索引，实现全平台阅读足迹统一检索。
