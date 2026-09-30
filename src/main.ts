import 'reflect-metadata';
import multipart from '@fastify/multipart';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { corsOrigins, env } from './config/env';
import { buildOpenApi } from './openapi';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ bodyLimit: 10 * 1024 * 1024, trustProxy: true }),
    { bufferLogs: false },
  );

  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

  app.enableCors({
    origin: corsOrigins.includes('*') ? true : corsOrigins,
    credentials: true,
    exposedHeaders: ['Content-Disposition'],
  });
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  app.enableShutdownHooks();

  const document = buildOpenApi(app);
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'openapi.json',
    swaggerOptions: { persistAuthorization: true },
  });

  await app.listen(env.PORT, '0.0.0.0');
  Logger.log(`API ready on http://localhost:${env.PORT}  (docs: /docs, spec: /openapi.json)`, 'Bootstrap');
}

bootstrap();
