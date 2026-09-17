import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query, withTransaction, closePool } from './pool.js';
import { logger } from '../logger.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, 'migrations');

export async function runMigrations(): Promise<string[]> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(
    (await query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
    });
    logger.info({ migration: file }, 'migration applied');
    ran.push(file);
  }
  return ran;
}

/** Wait for Postgres to accept connections; compose starts us in parallel. */
export async function waitForDatabase(attempts = 30, delayMs = 1000): Promise<void> {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i === attempts) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

const isDirectRun = process.argv[1] && process.argv[1].includes('migrate');
if (isDirectRun) {
  waitForDatabase()
    .then(runMigrations)
    .then((ran) => {
      logger.info({ count: ran.length }, ran.length ? 'migrations complete' : 'schema up to date');
      return closePool();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'migration failed');
      process.exit(1);
    });
}
