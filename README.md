# openhanako-email-bridge

Hanako 邮件监听服务。通过 ClawEmail WebSocket Push 实时接收新邮件通知，存档到本地并弹出桌面通知。事件驱动，无需轮询。

## 架构

```
发件人 → ClawEmail → WebSocket Push → monitor.mjs
                                          ↓
                                   存档到 data/
                                          ↓
                                   桌面通知
                                          ↓
                                   hanako 定时处理
```

- **monitor.mjs**：持久化守护进程（PM2），WebSocket 实时接收邮件推送
- **identity.mjs**：访客意识引擎，按收件人身份路由邮件，对外部访客启用隐私过滤
- 启动时自动扫描未读邮件，避免遗漏
- 所有配置通过 `.env` 注入，不硬编码凭据
- 不自动回复，新邮件进入待处理队列由 hanako 定时巡检

## 快速开始

```bash
# 克隆
git clone https://github.com/Yuexiye/openhanako-email-bridge.git
cd openhanako-email-bridge

# 安装依赖
npm install

# 配置环境变量（必填）
export CLAWEMAIL_API_KEY=your_api_key_here
export CLAWEMAIL_ADDRESS=your_email@example.com
export CLAWEMAIL_HOME_EMAIL=admin@example.com   # 可选

# 启动
pm2 start ecosystem.config.cjs

# 安装日志轮转（防止日志文件无限增长）
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 5

# 持久化（开机自启）
pm2 save

# 查看状态
pm2 status
pm2 logs email-monitor
```

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `CLAWEMAIL_API_KEY` | 是 | ClawEmail API Key |
| `CLAWEMAIL_ADDRESS` | 是 | 监听邮箱地址 |
| `CLAWEMAIL_EXTRA_ADDRESSES` | 否 | 额外邮箱，逗号分隔 |
| `CLAWEMAIL_HOME_EMAIL` | 否 | 主账号邮箱（跳过自动回复） |
| `EMAIL_IDENTITY_MAP` | 否 | 访客意识映射，`addr=identity,addr=identity` |
| `EMAIL_INTERNAL_CONTACTS` | 否 | 内部联系人，发给这些地址的邮件不触发对外意识 |

## 访客意识（Visitor Awareness）

每个监听地址可以映射到一个身份（如 ophelia、luoqixi、yuexiye）。
新邮件到达后，系统按收件人地址自动识别身份，并执行对应规则。

### 身份路由

| 身份 | 默认规则 |
|------|----------|
| `ophelia` | 高优先级、通知、自动标签 `[ophelia, assistant]` |
| `luoqixi` | 高优先级、通知、自动标签 `[luoqixi, assistant]` |
| `yuexiye` | 中优先级、通知、自动标签 `[yuexiye, owner]` |
| `unknown` | 低优先级、通知、自动标签 `[unclassified]` |

配置示例：

```env
# 访客意识映射
EMAIL_IDENTITY_MAP=ophelia@claw.163.com=ophelia,luoqixi@claw.163.com=luoqixi,owner@qq.com=yuexiye
```

### 对外意识（External Awareness）

当**外部访客**（非 owner、非 self、非 internal）发邮件到任意监听地址时，系统进入**对外模式**：

| 规则 | 行为 |
|------|------|
| 自动回复 | **默认关闭** |
| 隐私过滤 | **自动脱敏**：本地路径、凭证、邮箱、手机号 |
| 通知 | 主人可见，但内容已脱敏 |
| 验证码 | 白名单机制，仍自动提取并通知 |
| 系统通知 | 自动跳过（除非验证码） |

配置内部联系人（视为“自己人”，不触发对外意识）：

```env
EMAIL_INTERNAL_CONTACTS=friend@example.com,colleague@example.com
```

### 回复决策

邮件存档和待处理队列中会写入 `replyDecision`：

```json
{
  "replyDecision": "none",
  "isExternal": false,
  "identity": "ophelia"
}
```

| 值 | 含义 |
|----|------|
| `auto` | 系统自动回复 |
| `manual` | 需要人工确认后回复 |
| `none` | 不回复 |

### 脱敏示例

对外部邮件，系统会自动替换以下内容：

| 原始 | 替换后 |
|------|--------|
| `C:\Users\Administrator\file.txt` | `...\file.txt` |
| `sk-abc123...` | `[REDACTED]` |
| `user@example.com` | `***@example.com` |
| `13812345678` | `138****0000` |

### 桌面通知格式

```
🔒 [ophelia] 张三: 项目进度同步
🔒 [外部] 陌生人: 你好，请问...
```

## 目录结构

```
email-monitor/
├── monitor.mjs          # 主程序
├── identity.mjs         # 访客意识引擎
├── .env.example         # 环境变量模板
├── package.json
└── data/                # 邮件存档（gitignored）
    ├── _pending/        # 临时队列
    ├── _processed.json  # 已处理邮件 ID
    └── <mailId>/        # 单封邮件存档
```

## License

MIT
