# cyberstory 数据与系统迁移指南 (Migration Guide)

本文档面向系统管理员与开发者，详细说明 `cyberstory` (CyberHistoryExplorer) 系统的数据库构成、必须迁移的资产、可丢弃的临时文件，以及跨机器/跨平台（如 Windows 迁移至 Linux/CentOS）的无损迁移操作流程。

---

## 一、 系统数据资产全景分析

整个系统的数据资产分布在三类载体中：**持久化数据库**、**认证凭据与配置**、**AI 模型权重**。

### 1. 核心持久化数据（必须迁移，不可替代）
- **文件路径**：`.data/cyber_history.db`
- **文件体量**：约 **47.16 MB** (49,451,008 字节)
- **包含内容**：
  - **`items` 表**（1,859 条）：收录的全部 YouTube 视频与未来知乎历史元数据（`ts_id` 主键、标题、频道、真实时长、处理状态、原片直达链接等）。
  - **`video_subtitles` 表**（125,946 条）：经过 ASR 或官方下载提取的精确到毫秒的时间轴分段明细（`start_sec`, `end_sec`, `text`）。
  - **`subtitles_fts` 虚表及索引**（1,147 篇长文档）：SQLite FTS5 全文检索引擎的倒排索引（`trigram` 分词），支撑毫秒级台词匹配。
- **价值说明**：ASR 语音转写消耗了大量 CPU/GPU 算力，这是整个系统最宝贵、不可恢复的资产。

### 2. 认证凭据与配置（必须迁移或重新生成）
- **`youtube_cookies.txt`**（路径：`.data/youtube_cookies.txt`，约 4.7 KB）：
  - `yt-dlp` 抓取非公开历史、绕过 YouTube 机器人检测（Bot Detection）和反爬风控所必需的会话凭据。
  - 若不迁移，新机器上 `yt-dlp` 会提示 `Sign in to confirm you're not a bot`，导致音频下载与字幕提取失败。
- **`config.py`**（路径：项目根目录）：
  - 服务的监听端口（`0.0.0.0:8765`）、网络代理地址（`http://127.0.0.1:10809`）、Whisper 模型规格等。

### 3. 本地大模型权重（建议迁移，免去外网漫长下载）
- **文件路径**：`~/.cache/huggingface/hub/models--Systran--faster-whisper-small/`
- **文件体量**：约 **463.7 MB**
- **说明**：`faster-whisper` 的 CTranslate2 模型。在无代理或受限网络的目标服务器（如局域网内机房、CentOS 实验机）上，将此目录一并拷贝，可实现 **100% 离线免联网即时转写**。

### 4. 临时与过渡文件（【禁止】迁移，直接丢弃）
- **`.data/temp/audio/`**（约 **4.26 GB**，数百个待处理的 `.opus` 文件）：
  - 这是 `DownloadWorker` 跑在前面高速下载下来的音频缓冲池，`ASRWorker` 消费转写后会自动删除。迁移时**不要拷贝此目录**，节省数 GB 的带宽；新机器启动后会自动按需拉取。
- **`.data/temp/subs/`**：抓取字幕过程中的临时测试文件。
- **`__pycache__/`** 与 `*.pyc`：Python 字节码缓存。
- **`.data/cyber_history.db-wal` / `.data/cyber_history.db-shm`**：SQLite 的 WAL 临时写入文件。迁移前请确保服务已优雅停止或执行热备份，避免拷贝处于写入锁状态的文件。

---

## 二、 迁移策略与打包方案

根据网络环境与磁盘条件，可选用以下两种迁移方案之一：

| 迁移方案 | 推荐携带文件清单 | 压缩打包体积 | 耗时 | 适用场景 |
| :--- | :--- | :--- | :--- | :--- |
| **方案 A：极简轻量迁移 (推荐)** | `cyber_history.db` + `youtube_cookies.txt` + 代码仓库 | **~ 48 MB** | < 10 秒 | 目标机器有正常外网/代理环境 |
| **方案 B：全量离线迁移** | 方案 A 全部文件 + `faster-whisper-small` 模型权重包 | **~ 512 MB** | 1~2 分钟 | 局域网实验机、无外网代理服务器 |

---

## 三、 标准迁移实操步骤

### 步骤 1：源主机执行数据库一致性备份与归档
在当前主机终端执行，利用 SQLite 的 `VACUUM INTO` 创建无锁干净快照，并打包核心资产：

```bash
# 1. 进入项目根目录
cd D:/space/gemini-space/07-CyberHistoryExplorer

# 2. 执行安全快照 (消除 WAL 碎片，生成独立无锁 DB)
python -c "import sqlite3; conn=sqlite3.connect('.data/cyber_history.db'); conn.execute('VACUUM INTO \".data/clean_backup.db\"'); conn.close(); print('Backup complete!')"

# 3. 打包核心资产 (方案 A)
tar -czvf cyberstory_backup_$(date +%Y%m%d).tar.gz \
  --exclude='.data/temp' \
  --exclude='__pycache__' \
  --exclude='.git' \
  --exclude='.data/cyber_history.db*' \
  config.py database.py pipeline.py server.py requirements.txt \
  static/ userscript/ \
  .data/clean_backup.db .data/youtube_cookies.txt
```

> **离线模型打包（如需方案 B）**：
> ```bash
> tar -czvf whisper_model_small.tar.gz -C "$HOME/.cache/huggingface/hub" models--Systran--faster-whisper-small
> ```

---

### 步骤 2：传输至目标服务器
使用 `scp`、`rsync` 或 Tailscale 传输至目标机器（例如 Linux 服务器 `/root/dev/vibe-space/07-CyberHistoryExplorer`）：

```bash
scp cyberstory_backup_*.tar.gz root@<TARGET_IP>:/root/dev/vibe-space/
```

---

### 步骤 3：目标服务器部署与环境安装

在目标机器上解压并安装运行依赖：

```bash
# 1. 创建并解压
mkdir -p /root/dev/vibe-space/07-CyberHistoryExplorer
cd /root/dev/vibe-space/07-CyberHistoryExplorer
tar -xzvf /root/dev/vibe-space/cyberstory_backup_*.tar.gz

# 2. 还原数据库文件名
mv .data/clean_backup.db .data/cyber_history.db

# 3. （如为离线方案 B）还原 Whisper 模型
mkdir -p ~/.cache/huggingface/hub
tar -xzvf /root/dev/vibe-space/whisper_model_small.tar.gz -C ~/.cache/huggingface/hub/

# 4. 依赖项检查与安装
# 需要: python >= 3.10, ffmpeg, yt-dlp, nodejs (用于 JS 挑战计算)
pip install fastapi uvicorn faster-whisper yt-dlp psutil requests
```

---

### 步骤 4：调整目标环境 `config.py`
根据目标机器的实际网络情况，编辑 `config.py`：
- **`PROXY_URL`**：如果目标服务器本身就在海外或具备全局网关，可设为 `""` 或目标本地代理（如 `http://127.0.0.1:7890`）。
- **`YT_DLP_BIN`**：Linux 环境通常为系统全局路径 `yt-dlp`。
- **`WHISPER_CPU_THREADS`**：根据目标服务器 CPU 核心数调节（建议保持为 2，避免打满核心）。

---

### 步骤 5：启动验证与数据库完整性校验

在目标服务器后台启动服务并检查连通性：

```bash
# 后台启动
python3 server.py &

# 校验服务健康度与数据总览
curl -s http://127.0.0.1:8765/api/health
curl -s http://127.0.0.1:8765/api/tasks | grep "total_videos"
```

若返回的 `total_videos` 数量精确等于 `1859`，且 `ready` 状态数量完全一致，则表明系统迁移已 100% 成功。

---

## 四、 数据库逻辑级导入与导出（备用方案）

若未来数据库升级，需要在不同数据库引擎（如 MySQL/PostgreSQL）或不同 SQLite 编译版本间交换数据，建议采用逻辑级 JSONL 导出方案：

1. **导出逻辑**：通过 SQL 提取 `items` 与 `video_subtitles` 两张表为标准 JSON 格式。
2. **导入与 FTS 索引快速重建**：
   导入所有 `items` 和 `video_subtitles` 记录后，执行单条 SQL 即可完成全文索引重建：
   ```sql
   INSERT INTO subtitles_fts (item_id, title, author, content)
   SELECT i.ts_id, i.title, i.author, GROUP_CONCAT(s.text, ' ')
   FROM items i
   JOIN video_subtitles s ON i.ts_id = s.item_id
   GROUP BY i.ts_id;
   ```
   该方法不依赖底层物理索引二进制格式，具备极佳的前后向兼容性。
