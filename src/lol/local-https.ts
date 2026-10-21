import { request, Agent } from 'node:https';

/**
 * The League client and game expose HTTPS on 127.0.0.1 with a certificate
 * signed by Riot's own root, which Node does not trust. Certificate checks are
 * only disabled for this loopback agent.
 */
export const loopbackAgent = new Agent({ rejectUnauthorized: false, keepAlive: true });

export interface LocalRequest {
  port: number;
  path: string;
  method?: string;
  body?: unknown;
  auth?: string;
  timeoutMs?: number;
}

export class LocalHttpError extends Error {
  constructor(readonly status: number, readonly body: string, path: string) {
    super(`HTTP ${status} on ${path}: ${body.slice(0, 200)}`);
  }
}

export function localJson<T = unknown>({ port, path, method = 'GET', body, auth, timeoutMs = 3000 }: LocalRequest): Promise<T> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        agent: loopbackAgent,
        timeout: timeoutMs,
        headers: {
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(auth ? { Authorization: `Basic ${Buffer.from(auth).toString('base64')}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) return reject(new LocalHttpError(status, text, path));
          resolve((text ? JSON.parse(text) : undefined) as T);
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`Timeout on ${path}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
