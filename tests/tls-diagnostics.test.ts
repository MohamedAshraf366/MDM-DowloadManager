import { once } from 'node:events';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { friendlyErrorMessage, mapNetworkError } from '../src/engine/errors';
import { HttpClient } from '../src/engine/http-client';
import { describeTlsFailure, type TlsInspection } from '../src/engine/tls-diagnostics';
import { PLAIN_FIXTURE, SCANNER_FIXTURE } from './support/tls-fixtures';

const servers: https.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});

async function untrustedServer(fixture: { key: string; cert: string }): Promise<string> {
  const server = https.createServer(fixture, (_request, response) => response.end('ok'));
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `https://localhost:${(server.address() as AddressInfo).port}/file.bin`;
}

function client(): HttpClient {
  return new HttpClient({
    connectTimeoutMs: 5000,
    idleTimeoutMs: 5000,
    maxRedirects: 3,
    ipVersion: 'ipv4',
    userAgent: 'tls-diagnostics-test',
    proxy: null,
    maxSocketsPerHost: 4
  });
}

const certificate = (overrides: Partial<TlsInspection['chain'][number]> = {}) => ({
  subject: 'drive.example',
  issuer: 'Some CA',
  validFrom: 'Jan  1 00:00:00 2026 GMT',
  validTo: 'Jan  1 00:00:00 2027 GMT',
  fingerprint256: 'AA',
  ...overrides
});

describe('describeTlsFailure', () => {
  const now = new Date('2026-11-02T00:00:00Z');

  it('names the issuer and says it is not trusted', () => {
    const text = describeTlsFailure('drive.example', { authorizationError: null, anchored: false, chain: [certificate()] }, now);
    expect(text).toContain('"Some CA"');
    expect(text).toMatch(/not a certificate authority that Windows or MDM trusts/);
  });

  it('recognises HTTPS scanning by a security product', () => {
    const text = describeTlsFailure(
      'drive.example',
      { authorizationError: null, anchored: false, chain: [certificate({ issuer: 'ESET SSL Filter CA' })] },
      now
    );
    expect(text).toMatch(/HTTPS scanning by "ESET SSL Filter CA"/);
    expect(text).toMatch(/Trusted Root Certification Authorities/);
  });

  it('blames the clock when the certificate is not valid yet or has expired', () => {
    const early = describeTlsFailure(
      'x',
      { authorizationError: null, anchored: false, chain: [certificate({ validFrom: 'Jan  1 00:00:00 2030 GMT', validTo: 'Jan  1 00:00:00 2031 GMT' })] },
      now
    );
    expect(early).toMatch(/before the certificate becomes valid/);
    const late = describeTlsFailure(
      'x',
      { authorizationError: null, anchored: false, chain: [certificate({ validTo: 'Jan  1 00:00:00 2026 GMT' })] },
      now
    );
    expect(late).toMatch(/certificate expired/);
  });

  it('points at a missing intermediate when the chain does lead to a trusted authority', () => {
    const text = describeTlsFailure('x', { authorizationError: null, anchored: true, chain: [certificate()] }, now);
    expect(text).toMatch(/missing intermediate/);
  });

  it('says nothing when it could not look', () => {
    expect(describeTlsFailure('x', null, now)).toBe('');
  });
});

describe('a certificate that nothing trusts, end to end', () => {
  it('reports who issued it, instead of a generic message', async () => {
    const url = await untrustedServer(PLAIN_FIXTURE);
    const error = await client()
      .request(url)
      .then(
        () => null,
        (reason: unknown) => reason
      );
    expect(error).not.toBeNull();
    const mapped = mapNetworkError(error);
    expect(mapped.code).toBe('TLS_CHAIN');
    expect(mapped.detail).toContain('"MDM Test Root CA"');
    expect(mapped.detail).toMatch(/not a certificate authority that Windows or MDM trusts/);
    const shown = friendlyErrorMessage(mapped);
    expect(shown).toContain('MDM Test Root CA');
    expect(shown).toMatch(/could not be verified \(/); // Node's own reason is no longer thrown away
    expect(shown).toMatch(/Allow invalid TLS certificates/);
  });

  it('recognises a certificate re-signed by an antivirus-style authority', async () => {
    const url = await untrustedServer(SCANNER_FIXTURE);
    const error = await client()
      .request(url)
      .then(
        () => null,
        (reason: unknown) => reason
      );
    const mapped = mapNetworkError(error);
    expect(mapped.code).toBe('TLS_CHAIN');
    expect(mapped.detail).toMatch(/HTTPS scanning by "Kaspersky Anti-Virus Personal Root Certificate"/);
  });

  it('still lets the person proceed when they explicitly allow it', async () => {
    const url = await untrustedServer(PLAIN_FIXTURE);
    const lenient = new HttpClient({
      connectTimeoutMs: 5000,
      idleTimeoutMs: 5000,
      maxRedirects: 3,
      ipVersion: 'ipv4',
      userAgent: 'tls-diagnostics-test',
      proxy: null,
      maxSocketsPerHost: 4,
      tlsAllowInsecure: true
    });
    const response = await lenient.request(url);
    expect(response.status).toBe(200);
    response.close();
  });
});
