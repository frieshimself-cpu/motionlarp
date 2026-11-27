// What a transaction that failed on chain says about why, read from its program logs.
//
// An Anchor program (pump.fun, PumpSwap, Jupiter) logs "Error Code: X. Error Number: N. Error Message: Y." for the
// instruction that failed: that is far more useful than the bare number ({"Custom":6003}) the status carries, and the
// same number means different things in different programs. The system program says "insufficient lamports".

/** "X: Y" from the failing instruction's Anchor error, the system program's lamport complaint, or null. */
export function programError(logs: string[] | null | undefined): string | null {
  if (!logs?.length) return null;
  for (let i = logs.length - 1; i >= 0; i--) {
    const line = logs[i]!;
    const anchor = /Error Code: (\w+)\. Error Number: \d+\. Error Message: (.+?)\.?$/.exec(line);
    if (anchor) return `${anchor[1]}: ${anchor[2]!.replace(/\.$/, '')}.`;
    const lamports = /insufficient lamports (\d+), need (\d+)/.exec(line);
    if (lamports) return `insufficient lamports ${lamports[1]}, need ${lamports[2]}`;
  }
  return null;
}
