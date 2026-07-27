import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

function publicSubdir(name: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, `../public/${name}`),
    path.join(here, `../../public/${name}`),
    path.join(here, `public/${name}`),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return candidates[0]!;
}

function registerStaticDir(
  app: FastifyInstance,
  routePrefix: string,
  dirName: string,
): void {
  const dir = publicSubdir(dirName);

  app.get<{ Params: { file: string } }>(`${routePrefix}/:file`, async (request, reply) => {
    const file = path.basename(request.params.file);
    if (!file || file === '.' || file === '..') {
      return reply.code(400).send({ error: 'invalid_file' });
    }
    const full = path.join(dir, file);
    if (!full.startsWith(dir) || !existsSync(full)) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const ext = path.extname(file).toLowerCase();
    reply.header('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
    reply.header('Cache-Control', 'public, max-age=86400');
    return reply.send(createReadStream(full));
  });
}

/** Serve catalog images at /products/:file and brand assets at /brand/:file. */
export async function registerProductImageRoutes(app: FastifyInstance): Promise<void> {
  registerStaticDir(app, '/products', 'products');
  registerStaticDir(app, '/brand', 'brand');
}
