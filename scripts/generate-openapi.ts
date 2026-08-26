/**
 * Generates openapi.yaml from the NestJS Swagger module metadata.
 *
 * Run from the ws-gateway directory: npm run generate:openapi
 *
 * The emitted openapi.yaml is committed to the repo. It only documents
 * POST /ws/ticket — the WebSocket itself is not an HTTP endpoint.
 */
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

process.env.AUTH_DISABLED ??= 'true';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.WS_TICKET_SECRET ??= 'generate-openapi-placeholder-secret';

// Deliberately a require(), not a static import: AppModule's
// ConfigModule.forRoot({ validationSchema }) validates process.env
// SYNCHRONOUSLY the moment the module is loaded (not deferred to
// NestFactory.create()). A static `import` would be hoisted above the
// process.env defaults set above regardless of source order, so AppModule
// would load — and fail Joi validation — before the defaults ever ran.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AppModule } = require('../src/app.module');

async function generate(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });

  const config = new DocumentBuilder()
    .setTitle('WS Gateway API')
    .setDescription(
      'Ticket issuance for the realtime WebSocket handshake. The WebSocket itself ' +
        '(wss://.../ws?ticket=...) is not an HTTP endpoint and does not appear here.',
    )
    .setVersion('0.1.0')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  const outPath = join(__dirname, '..', 'openapi.yaml');
  writeFileSync(outPath, yaml.dump(document, { lineWidth: 120, noRefs: true }));
  console.log(`openapi.yaml written to ${outPath}`);

  await app.close();
}

// exitCode (not exit()) so a pending async stderr/stdout write from the lines
// above can't be truncated by an immediate process termination.
generate()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
