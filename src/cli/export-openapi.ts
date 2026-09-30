/** Writes openapi.json without starting the HTTP server (used by CI and by the frontend's Orval step). */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { writeFileSync } from 'node:fs';
import { AppModule } from '../app.module';
import { buildOpenApi } from '../openapi';

async function main() {
  const app = await NestFactory.create(AppModule, new FastifyAdapter(), { logger: false, abortOnError: false });
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  await app.init();
  const doc = buildOpenApi(app);
  const out = process.argv[2] ?? 'openapi.json';
  writeFileSync(out, JSON.stringify(doc, null, 2));
  console.log(`Wrote ${out} (${Object.keys(doc.paths).length} paths)`);
  await app.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
