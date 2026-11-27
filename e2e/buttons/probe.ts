// Asks the product's own Store what the copy engine would act on right now (which wallets it watches, which copies
// follow one wallet). Read-only use of the same methods the engine calls; the server keeps running next to it.
//
//   npx tsx e2e/buttons/probe.ts <db file> <leader address>
import { Store } from '../../src/store.js';

const [db, leader] = process.argv.slice(2);
if (!db || !leader || !db.includes('/e2e/buttons/')) {
  console.error('usage: npx tsx e2e/buttons/probe.ts <db file under e2e/buttons> <leader address>');
  process.exit(2);
}
const store = new Store(db);
const copies = store.enabledCopiesForLeader(leader);
console.log(JSON.stringify({
  watched: store.watchedLeaders().includes(leader),
  copiesTheEngineWouldBuyFor: copies.map((c) => ({ id: c.id, user: store.user(c.userId)?.username, name: c.settings.name, buySol: c.settings.buySol })),
}));
store.close();
