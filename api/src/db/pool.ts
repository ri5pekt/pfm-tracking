import pg from 'pg';
import type { Env } from '../config.js';

const { Pool } = pg;

export type Db = pg.Pool;

export function createPool(env: Env): Db {
  return new Pool({ connectionString: env.DATABASE_URL });
}
