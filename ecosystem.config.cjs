module.exports = {
  apps: [
    {
      name: "gpb-backend",
      cwd: "/home/kenji/GamePingBooster",
      script: "/home/kenji/.bun/bin/bun",
      args: "run server/src/index.ts",
      env: {
        PORT: "20080",
        NODE_ENV: "production"
      },
      restart_delay: 3000,
      max_restarts: 10,
      autorestart: true,
      watch: false
    }
  ]
};
