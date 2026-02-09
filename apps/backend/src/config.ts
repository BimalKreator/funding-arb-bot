export const config = {
  port: Number(process.env.PORT) || 3001,
  nodeEnv: process.env.NODE_ENV || 'development',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  version: process.env.npm_package_version || '1.0.0',
  exchanges: {
    binance: {
      apiKey: process.env.BINANCE_API_KEY ?? '',
      apiSecret: process.env.BINANCE_API_SECRET ?? '',
      testnet: process.env.BINANCE_TESTNET === 'true',
    },
    bybit: {
      apiKey: process.env.BYBIT_API_KEY ?? '',
      apiSecret: process.env.BYBIT_API_SECRET ?? '',
      testnet: process.env.BYBIT_TESTNET === 'true',
    },
  },
};
