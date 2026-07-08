const fs = require('node:fs/promises');
const path = require('node:path');
const { loadEnvConfig } = require('@next/env');
const { Pool } = require('pg');

const migrationsDir = path.join(__dirname, 'migrations');
const projectDir = path.resolve(__dirname, '../..');

loadEnvConfig(projectDir);

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to run migrations.');
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    await client.query(`
      create table if not exists schema_migrations (
        id text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const files = (await fs.readdir(migrationsDir))
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const existing = await client.query(
        'select 1 from schema_migrations where id = $1',
        [file]
      );

      if (existing.rowCount > 0) {
        console.log(`skipped ${file}`);
        continue;
      }

      const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');

      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (id) values ($1)', [file]);
        await client.query('commit');
        console.log(`applied ${file}`);
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
