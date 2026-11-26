// Tests run offline: no RPC, quiet logs, a throwaway master key.
process.env.RPC_URL = '';
process.env.LIVE_TRADING = 'false';
process.env.LOG_LEVEL = 'error';
process.env.MAX_SOL_PER_BUY = '0.05';
process.env.MASTER_KEY = '11'.repeat(32);
process.env.SIGNUP_CODE = 'friends';
