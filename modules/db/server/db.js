import pg from 'pg';

const { Pool } = pg;

let pool;

export function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }

  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }

  return pool;
}

export async function query(text, params) {
  return getPool().query(text, params);
}
