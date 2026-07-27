import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(here, '../../.env') });
loadDotenv();

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  PORT: z.coerce.number().default(3000),
  PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),
  ADMIN_SESSION_SECRET: z.string().min(16),
  ADMIN_BOOTSTRAP_EMAIL: z.string().email().optional(),
  ADMIN_BOOTSTRAP_PASSWORD: z.string().min(8).optional(),
  APP_VERSION: z.string().default('0.1.0'),
  GIT_SHA: z.string().default('dev'),
  SHIPBOB_API_KEY: z.string().optional(),
  SHIPBOB_CHANNEL_ID: z.string().default('180705'),
  SHIPBOB_API_BASE: z.string().default('https://api.shipbob.com/1.0'),
  SHIPBOB_TRACKING_API_BASE: z.string().default('https://api.shipbob.com/2026-07'),
  /** When no sync cursor exists, how far back to pull ShipBob orders (hours). Prod fresh-start: 1. */
  SHIPBOB_ORDERS_LOOKBACK_HOURS: z.coerce.number().default(48),
  KLB_API_KEY: z.string().optional(),
  KLB_API_SECRET: z.string().optional(),
  KLB_LEGACY_API_SECRET: z.string().optional(),
  KLB_API_BASE: z.string().default('https://app.zenventory.com/rest'),
  /** KLB shipping-order window in days (0 = today UTC only). Prod fresh-start: 0 or 1. */
  KLB_WINDOW_DAYS: z.coerce.number().default(30),
  TRACKINGMORE_API_KEY: z.string().optional(),
  TRACKINGMORE_API_BASE: z.string().default('https://api.trackingmore.com/v4'),
  KLAVIYO_API_KEY: z.string().optional(),
  KLAVIYO_DRY_RUN: z.string().optional(),
  STALLED_DAYS: z.coerce.number().default(7),
  RICHPANEL_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${details}`);
  }
  return parsed.data;
}
