// Imported before anything from src/: the fuzzer runs offline, quiet, with a throwaway master key.
// Nothing in this directory opens a network connection, and nothing is ever sent anywhere.
process.env.RPC_URL = '';
process.env.LIVE_TRADING = 'false';
process.env.LOG_LEVEL = 'error';
process.env.MASTER_KEY = '11'.repeat(32);
process.env.DOTENV_CONFIG_QUIET = 'true';
// A database path that is never opened (the fuzzer only uses in-memory stores).
process.env.DB_PATH = ':memory:';

// node:sqlite prints an "experimental" warning once; it is noise here.
const emit = process.emitWarning;
process.emitWarning = function (warning: unknown, ...rest: unknown[]) {
  const text = typeof warning === 'string' ? warning : ((warning as Error | undefined)?.message ?? '');
  if (/SQLite is an experimental feature/.test(text)) return;
  return (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
} as typeof process.emitWarning;
