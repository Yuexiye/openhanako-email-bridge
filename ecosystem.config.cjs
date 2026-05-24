// PM2 生态系统配置 — email-monitor
// 启动：pm2 start ecosystem.config.cjs
// 保存：pm2 save

module.exports = {
  apps: [{
    name: "email-monitor",
    script: "./monitor.mjs",
    cwd: __dirname,
    // 日志由 PM2 接管，存 C 盘避免外接盘 IO
    out_file: "C:/Users/Administrator/.pm2/logs/email-monitor-out.log",
    error_file: "C:/Users/Administrator/.pm2/logs/email-monitor-error.log",
    // 日志轮转：单文件 50MB，保留 3 个历史文件
    max_size: "50M",
    max_restarts: 10,
    // 异常退出后等 5 秒再重启，避免疯狂刷日志
    restart_delay: 5000,
    // 如果 60 秒内重启超过 10 次，停止重启
    min_uptime: "10s",
    max_memory_restart: "200M",
    // 环境变量从 .env 加载
    env: {
      NODE_ENV: "production",
    },
  }],
};