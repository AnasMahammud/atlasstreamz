import { openDb } from './db.ts';
import { config } from './config.ts';
import { log } from './log.ts';
import { ensureInitialProvider, listProviders } from './providers.ts';
import { SyncManager } from './sync/manager.ts';
import { CatalogSearch, heroEnrichmentCandidates, invalidateGuideCoverage, movieDetails } from './catalog.ts';
import { buildApp } from './app.ts';

const db = openDb();
ensureInitialProvider(db);

const search = new CatalogSearch();
search.rebuild(db);

const sync = new SyncManager(db);

/** After a sync, quietly fetch details for a few recent movies so Home has real hero artwork. */
async function enrichHero(): Promise<void> {
  for (const id of heroEnrichmentCandidates(db, 10)) {
    await movieDetails(db, id).catch(() => null);
  }
}

sync.on('catalogChanged', () => {
  search.rebuild(db);
  invalidateGuideCoverage();
  void enrichHero();
});

const app = await buildApp({ db, sync, search });
await app.listen({ host: config.host, port: config.port });
log.info(`ATLAS server listening on http://${config.host}:${config.port}`);
log.info(`${listProviders(db).length} provider(s) configured`);
sync.start();
void enrichHero();

const shutdown = async () => {
  sync.stop();
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
