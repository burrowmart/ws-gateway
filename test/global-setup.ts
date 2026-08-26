/**
 * Jest globalSetup — runs once before any test file is loaded, in the same
 * process as the tests themselves (relies on --runInBand, same as every
 * other service's e2e suite in this repo).
 *
 * Must set every env var AppModule needs BEFORE the test file's `import {
 * AppModule } from '../src/app.module'` executes: ConfigModule.forRoot({
 * validationSchema }) validates process.env SYNCHRONOUSLY the moment
 * app.module.ts is loaded, not lazily — see scripts/generate-openapi.ts for
 * the same trap hit and worked around there.
 *
 * REDIS_URL is left pointing at a real Redis (default localhost:6379, the
 * platform-infra compose stack) because the whole point of this suite is
 * proving real pub/sub fan-out — a mock can't faithfully stand in for that.
 * chat-service and notification-service are NOT started for real; UpstreamStub
 * serves just enough of their REST contract to exercise the gateway's calls.
 */
import { UpstreamStub } from './support/upstream-stub';

export default async function globalSetup(): Promise<void> {
  process.env.AUTH_DISABLED = 'true';
  process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
  process.env.WS_TICKET_SECRET = 'e2e-test-secret-do-not-use-in-prod';
  process.env.WS_TICKET_TTL_SECONDS = '30';
  process.env.PORT = '0';

  const stub = new UpstreamStub();
  const url = await stub.start();
  process.env.CHAT_SERVICE_URL = url;
  process.env.NOTIFICATION_SERVICE_URL = url;

  // Stash for the test file and globalTeardown (same process, same global object).
  (global as unknown as { __UPSTREAM_STUB__: UpstreamStub }).__UPSTREAM_STUB__ = stub;
}
