// PM2 process file (Phase 6, Contabo VPS): `pm2 start ecosystem.config.js --env production`.
// The web app runs in cluster mode; the worker runs as ONE instance so jobs never run twice
// (each job also takes a Postgres advisory lock as a safety net).
module.exports = {
  apps: [
    {
      name: 'web',
      script: 'src/server.js',
      exec_mode: 'cluster',
      instances: 'max',
      max_memory_restart: '400M',
      kill_timeout: 10000,
      env_production: { NODE_ENV: 'production', TZ: 'Africa/Lagos' },
    },
    {
      name: 'worker',
      script: 'src/jobs/worker.js',
      exec_mode: 'fork',
      instances: 1,
      max_memory_restart: '300M',
      kill_timeout: 35000,
      env_production: { NODE_ENV: 'production', TZ: 'Africa/Lagos' },
    },
  ],
};
