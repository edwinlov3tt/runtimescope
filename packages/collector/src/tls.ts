import { readFileSync } from 'node:fs';
import type { SecureContextOptions } from 'node:tls';

// ============================================================
// TLS Support
// Loads certificate files for WSS + HTTPS
// ============================================================

export interface TlsConfig {
  certPath: string;
  keyPath: string;
  caPath?: string;
}

/**
 * Load TLS certificate files and return options suitable for
 * https.createServer() or tls.createSecureContext().
 */
export function loadTlsOptions(config: TlsConfig): SecureContextOptions {
  return {
    cert: readFileSync(config.certPath, 'utf-8'),
    key: readFileSync(config.keyPath, 'utf-8'),
    ...(config.caPath ? { ca: readFileSync(config.caPath, 'utf-8') } : {}),
  };
}

/**
 * Resolve TLS config from environment variables.
 * Returns null if TLS is not configured.
 */
export function resolveTlsConfig(): TlsConfig | null {
  const certPath = process.env.RUNTIMESCOPE_TLS_CERT;
  const keyPath = process.env.RUNTIMESCOPE_TLS_KEY;

  if (!certPath || !keyPath) return null;

  return {
    certPath,
    keyPath,
    caPath: process.env.RUNTIMESCOPE_TLS_CA,
  };
}
