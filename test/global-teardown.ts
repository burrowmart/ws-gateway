import type { UpstreamStub } from './support/upstream-stub';

export default async function globalTeardown(): Promise<void> {
  const stub = (global as unknown as { __UPSTREAM_STUB__?: UpstreamStub }).__UPSTREAM_STUB__;
  if (stub) await stub.stop();
}
