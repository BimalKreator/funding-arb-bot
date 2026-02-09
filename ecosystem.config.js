/**
 * PM2 ecosystem config – run both backend and frontend with one command.
 *
 * Paths are relative to the repo root (where this file lives).
 *
 * Prerequisites:
 * - Backend: from root, run npm run build:shared && npm run build:backend (or install from root so workspaces are linked).
 * - Frontend: from root, run npm run build:frontend so apps/frontend/dist exists.
 *
 * Start: pm2 start ecosystem.config.js
 * Logs:  pm2 logs
 * Stop:  pm2 stop all
 */
module.exports = {
  apps: [
    {
      name: 'backend',
      cwd: './apps/backend',
      script: 'npm',
      args: 'run dev',
      watch: false,
      interpreter: 'none',
      env: { NODE_ENV: 'development' },
      env_production: { NODE_ENV: 'production' },
    },
    {
      name: 'frontend',
      cwd: './apps/frontend',
      script: 'npx',
      args: 'serve -s dist -l 5173',
      watch: false,
      interpreter: 'none',
      env: { NODE_ENV: 'production' },
    },
  ],
};
