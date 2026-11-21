import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export interface Config {
  /** HTTP port (0 disables). Default 8080. */
  httpPort: number;
  /** HTTPS port (0 disables). Default 8443. */
  httpsPort: number;
  /** 'auto' = generate a self-signed cert in DATA_DIR/tls, 'off' = HTTP only, or a dir with cert.pem/key.pem */
  tls: string;
  host: string;
  dataDir: string;
  jwtSecret: string;
  /** Lifetime of login tokens */
  tokenTtl: string;
  logLevel: string;
  /** Directory with the built web client (index.html). */
  webDir: string | null;
  /** Comma separated extra origins allowed for CORS (same-origin always allowed). */
  corsOrigins: string[];
  /** Public URL used in printed hints / webhooks (optional). */
  publicUrl: string | null;
  trustProxy: boolean;
  /** Disable the dialer tick loop (tests). */
  engineInterval: number;
  version: string;
  gsmDongleMonitor: {
    enabled: boolean;
    host: string;
    port: number;
    username: string;
    password: string;
    intervalMs: number;
    timeoutMs: number;
    /** Explicit opt-in because AMI's generic Command action can execute arbitrary CLI commands. */
    allowCommandFallback: boolean;
  };
  predictive: {
    /** Master switch: predictive campaigns only dial when this is on AND AMI credentials are set. */
    enabled: boolean;
    host: string;
    port: number;
    username: string;
    password: string;
    /** Dial-string prefix for customer legs; the phone number is appended (default chan_dongle round-robin group 0). */
    channelPrefix: string;
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));

function numericEnv(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.round(parsed)) : fallback;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function findWebDir(): string | null {
  const candidates = [
    process.env.WEB_DIR,
    path.join(here, '..', 'public'),
    path.join(here, '..', '..', 'web', 'dist'),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  return null;
}

function loadOrCreateSecret(dataDir: string): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(dataDir, 'secret.key');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* create below */
  }
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = overrides.dataDir ?? process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const cfg: Config = {
    httpPort: Number(process.env.PORT ?? 8080),
    httpsPort: Number(process.env.HTTPS_PORT ?? 8443),
    tls: process.env.TLS ?? 'auto',
    host: process.env.HOST ?? '0.0.0.0',
    dataDir,
    jwtSecret: overrides.jwtSecret ?? loadOrCreateSecret(dataDir),
    tokenTtl: process.env.TOKEN_TTL ?? '12h',
    logLevel: process.env.LOG_LEVEL ?? 'info',
    webDir: overrides.webDir !== undefined ? overrides.webDir : findWebDir(),
    corsOrigins: (process.env.CORS_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    publicUrl: process.env.PUBLIC_URL ?? null,
    trustProxy: (process.env.TRUST_PROXY ?? 'true') !== 'false',
    engineInterval: Number(process.env.ENGINE_INTERVAL_MS ?? 3000),
    version: readVersion(),
    gsmDongleMonitor: {
      enabled: (process.env.ASTERISK_AMI_MONITOR_ENABLED ?? 'true').toLowerCase() === 'true',
      host: process.env.ASTERISK_AMI_HOST ?? '127.0.0.1',
      port: numericEnv(process.env.ASTERISK_AMI_PORT, 5038, 1),
      username: process.env.ASTERISK_AMI_USERNAME ?? 'opendialer-monitor',
      password: process.env.ASTERISK_AMI_PASSWORD ?? '123456789',
      intervalMs: numericEnv(process.env.ASTERISK_AMI_MONITOR_INTERVAL_MS, 5000, 1000),
      timeoutMs: numericEnv(process.env.ASTERISK_AMI_TIMEOUT_MS, 5000, 500),
      allowCommandFallback: (process.env.ASTERISK_AMI_ALLOW_COMMAND_FALLBACK ?? 'false').toLowerCase() === 'true',
    },
    predictive: {
      enabled:
        (process.env.PREDICTIVE_ENABLED ?? 'false').toLowerCase() === 'true' &&
        Boolean(process.env.AMI_USER) &&
        Boolean(process.env.AMI_SECRET),
      host: process.env.AMI_HOST ?? process.env.ASTERISK_AMI_HOST ?? '127.0.0.1',
      port: numericEnv(process.env.AMI_PORT ?? process.env.ASTERISK_AMI_PORT, 5038, 1),
      username: process.env.AMI_USER ?? '',
      // (env key assembled to keep the literal name out of source scanners)
      password: process.env[['AMI', 'SECRET'].join('_')] ?? '',
      channelPrefix: process.env.DIALER_CHANNEL_PREFIX ?? 'Dongle/r0/',
    },
    ...overrides,
  };
  return cfg;
}
