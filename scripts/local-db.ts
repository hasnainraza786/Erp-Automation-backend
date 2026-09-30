/**
 * Runs a real PostgreSQL server from npm (no Docker needed) on port 5433.
 * Data persists in ./.data/pg. Stop with Ctrl+C.
 */
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const dataDir = join(process.cwd(), '.data', 'pg');
const port = Number(process.env.LOCAL_DB_PORT ?? 5433);

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'erp',
    password: 'erp',
    port,
    persistent: true,
  });

  const fresh = !existsSync(join(dataDir, 'PG_VERSION'));
  if (fresh) await pg.initialise();
  await pg.start();
  if (fresh) await pg.createDatabase('erp');

  console.log(`PostgreSQL ready: postgresql://erp:erp@localhost:${port}/erp`);

  const shutdown = async () => {
    await pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
