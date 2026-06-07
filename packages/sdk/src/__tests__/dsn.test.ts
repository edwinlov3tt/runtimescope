import { describe, it, expect } from 'vitest';
import { parseDsn, buildDsn } from '../dsn.js';

// Locks the single-443 endpoint resolution (ADR-0010 follow-up): a TLS DSN with
// no explicit port targets one HTTPS domain on 443 (a reverse proxy splits the
// WS upgrade), instead of the dev ports. The three SDKs duplicate this parser
// (dependency-free); this guards the shared contract.
describe('parseDsn — endpoint resolution', () => {
  it('TLS + no port → single 443 domain (clean wss/https, no port suffix)', () => {
    const d = parseDsn('runtimescopes://proj_abc@collector.example.com');
    expect(d.tls).toBe(true);
    expect(d.httpEndpoint).toBe('https://collector.example.com');
    expect(d.wsEndpoint).toBe('wss://collector.example.com');
    expect(d.projectId).toBe('proj_abc');
  });

  it('plaintext + no port → local collector defaults (6768 / 6767)', () => {
    const d = parseDsn('runtimescope://proj_abc@localhost');
    expect(d.tls).toBe(false);
    expect(d.httpEndpoint).toBe('http://localhost:6768');
    expect(d.wsEndpoint).toBe('ws://localhost:6767');
  });

  it('explicit port → HTTP there, WS on port-1 (preserved for dev/custom)', () => {
    const d = parseDsn('runtimescopes://proj_abc:tok_123@host:6768/my-app');
    expect(d.httpEndpoint).toBe('https://host:6768');
    expect(d.wsEndpoint).toBe('wss://host:6767');
    expect(d.authToken).toBe('tok_123');
    expect(d.appName).toBe('my-app');
  });

  it('rejects a non-runtimescope scheme and a missing projectId', () => {
    expect(() => parseDsn('https://proj_abc@host')).toThrow();
    expect(() => parseDsn('runtimescopes://nope@host')).toThrow();
  });
});

describe('buildDsn — port omission', () => {
  it('TLS + no port → no port suffix (single-443)', () => {
    expect(buildDsn({ projectId: 'proj_abc', host: 'c.example.com', tls: true })).toBe(
      'runtimescopes://proj_abc@c.example.com',
    );
  });

  it('plaintext + no port → explicit :6768', () => {
    expect(buildDsn({ projectId: 'proj_abc', host: 'localhost' })).toBe(
      'runtimescope://proj_abc@localhost:6768',
    );
  });

  it('round-trips a TLS single-443 DSN through parseDsn', () => {
    const dsn = buildDsn({ projectId: 'proj_abc', authToken: 'tok', host: 'c.example.com', tls: true, appName: 'web' });
    const d = parseDsn(dsn);
    expect(d.httpEndpoint).toBe('https://c.example.com');
    expect(d.wsEndpoint).toBe('wss://c.example.com');
    expect(d.authToken).toBe('tok');
    expect(d.appName).toBe('web');
  });
});
