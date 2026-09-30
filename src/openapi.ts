import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { env } from './config/env';

export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Automation ERP API')
    .setDescription(
      'REST API for the Automation Company ERP. Money values are decimal strings in PKR. ' +
        'Errors follow RFC 7807 (application/problem+json).',
    )
    .setVersion(process.env.npm_package_version ?? '1.0.0')
    .addServer(env.PUBLIC_API_URL)
    .addBearerAuth()
    .addSecurityRequirements('bearer')
    .setOpenAPIVersion('3.1.0')
    .build();

  const doc = SwaggerModule.createDocument(app, config, {
    // Controller method names are unique across the app, giving Orval clean hook names (useListClients, ...).
    operationIdFactory: (_controllerKey, methodKey) => methodKey,
  });
  return cleanupOpenApiDoc(doc, { version: '3.1' });
}
