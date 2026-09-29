import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { isBlockedHostname, isBlockedIp } from '../../shared/ssrf';
import { CheckStage, StageError, remaining } from './types';

const ms = (t0: number) => Math.max(1, Math.round(performance.now() - t0));

/** Level 1: DNS. Also the SSRF gate: the *resolved* IP is validated, and it is the only IP we connect to. */
export const dnsStage: CheckStage = {
  name: 'DNS',
  applies: () => true,
  async run(ctx) {
    const { hostname, allowPrivate } = ctx.target;
    if (!allowPrivate && isBlockedHostname(hostname)) {
      throw new StageError('SSRF_BLOCKED', `hostname ${hostname} is not allowed`);
    }
    if (net.isIP(hostname)) {
      ctx.ip = hostname;
      ctx.family = net.isIPv6(hostname) ? 6 : 4;
    } else {
      const t0 = performance.now();
      let timer: NodeJS.Timeout | undefined;
      try {
        const addrs = await Promise.race([
          dns.promises.lookup(hostname, { all: true }),
          new Promise<never>((_, rej) => {
            timer = setTimeout(() => rej(new StageError('DNS_TIMEOUT', 'DNS lookup timed out')), Math.max(1, remaining(ctx)));
          }),
        ]);
        ctx.result.dnsLatencyMs = ms(t0);
        const usable = addrs.filter((a) => allowPrivate || !isBlockedIp(a.address));
        if (!usable.length) throw new StageError('SSRF_BLOCKED', `${hostname} resolves to a forbidden address (${addrs[0]?.address})`);
        const pick = usable.find((a) => a.family === 4) ?? usable[0];
        ctx.ip = pick.address;
        ctx.family = pick.family === 6 ? 6 : 4;
      } catch (e) {
        ctx.result.dnsLatencyMs ??= ms(t0);
        if (e instanceof StageError) throw e;
        const code = (e as NodeJS.ErrnoException).code;
        throw new StageError(code === 'ENOTFOUND' ? 'DNS_NXDOMAIN' : 'DNS_ERROR', `DNS: ${(e as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
      ctx.result.dnsSuccess = true;
    }
    ctx.result.resolvedIp = ctx.ip!;
    if (net.isIP(hostname)) ctx.result.dnsSuccess = null;
  },
};

/** Level 2: TCP connect to the pre-validated IP. */
export const tcpStage: CheckStage = {
  name: 'TCP',
  applies: () => true,
  run(ctx) {
    return new Promise<void>((resolve, reject) => {
      const t0 = performance.now();
      const sock = net.connect({ host: ctx.ip!, port: ctx.target.port, family: ctx.family });
      const fail = (type: string, msg: string) => {
        ctx.result.tcpLatencyMs = ms(t0);
        sock.destroy();
        reject(new StageError(type, msg));
      };
      const timer = setTimeout(() => fail('TCP_TIMEOUT', `TCP connect timeout to ${ctx.ip}:${ctx.target.port}`), Math.max(1, remaining(ctx)));
      sock.once('connect', () => {
        clearTimeout(timer);
        ctx.result.tcpLatencyMs = ms(t0);
        ctx.result.tcpSuccess = true;
        ctx.socket = sock;
        resolve();
      });
      sock.once('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        const map: Record<string, string> = {
          ECONNREFUSED: 'TCP_REFUSED', ECONNRESET: 'TCP_RESET', EHOSTUNREACH: 'TCP_UNREACHABLE',
          ENETUNREACH: 'TCP_UNREACHABLE', ETIMEDOUT: 'TCP_TIMEOUT',
        };
        fail(map[e.code ?? ''] ?? 'TCP_ERROR', `TCP ${e.code ?? ''}: ${e.message}`);
      });
    });
  },
};

/** Level 3: TLS handshake + certificate validation (chain, hostname, expiry). */
export const tlsStage: CheckStage = {
  name: 'TLS',
  applies: (ctx) => ctx.target.protocol === 'https',
  run(ctx) {
    return new Promise<void>((resolve, reject) => {
      const t0 = performance.now();
      const { hostname } = ctx.target;
      const secure = tls.connect({
        socket: ctx.socket!,
        servername: net.isIP(hostname) ? undefined : hostname,
        rejectUnauthorized: false, // we inspect the result ourselves so we can report *why* it failed
        ALPNProtocols: ['http/1.1'],
      });
      ctx.socket = secure;
      const fail = (type: string, msg: string) => {
        ctx.result.tlsLatencyMs = ms(t0);
        ctx.result.tlsSuccess = false;
        secure.destroy();
        reject(new StageError(type, msg));
      };
      const timer = setTimeout(() => fail('TLS_TIMEOUT', 'TLS handshake timeout'), Math.max(1, remaining(ctx)));
      secure.once('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        fail('TLS_ERROR', `TLS ${e.code ?? ''}: ${e.message}`);
      });
      secure.once('secureConnect', () => {
        clearTimeout(timer);
        ctx.result.tlsLatencyMs = ms(t0);
        const cert = secure.getPeerCertificate();
        if (cert?.valid_to) {
          const exp = new Date(cert.valid_to);
          if (!isNaN(exp.getTime())) {
            ctx.result.tlsCertExpiresAt = exp.toISOString();
            ctx.result.tlsCertDaysLeft = Math.floor((exp.getTime() - Date.now()) / 86_400_000);
          }
        }
        if (!secure.authorized) {
          const code = String(secure.authorizationError ?? 'UNKNOWN');
          ctx.result.tlsSuccess = false;
          const type =
            code === 'CERT_HAS_EXPIRED' ? 'TLS_CERT_EXPIRED'
            : code === 'ERR_TLS_CERT_ALTNAME_INVALID' ? 'TLS_HOSTNAME_MISMATCH'
            : 'TLS_CERT_INVALID';
          secure.destroy();
          return reject(new StageError(type, `TLS certificate rejected: ${code}`));
        }
        ctx.result.tlsSuccess = true;
        resolve();
      });
    });
  },
};

/** Level 4: HTTP GET over the already established (and validated) connection. */
export const httpStage: CheckStage = {
  name: 'HTTP',
  applies: () => true,
  run(ctx) {
    return new Promise<void>((resolve, reject) => {
      const { hostname, port, path, protocol, expectedStatusCodes } = ctx.target;
      const mod = protocol === 'https' ? https : http;
      const defaultPort = protocol === 'https' ? 443 : 80;
      const t0 = performance.now();
      let done = false;
      const finish = (err?: StageError) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        ctx.result.httpLatencyMs ??= ms(t0);
        err ? reject(err) : resolve();
      };
      const req = mod.request(
        {
          host: hostname,
          port,
          path,
          method: 'GET',
          agent: false,
          createConnection: () => ctx.socket!,
          headers: {
            Host: port === defaultPort ? hostname : `${hostname}:${port}`,
            'User-Agent': 'HazeMonitor/1.0',
            Accept: '*/*',
            Connection: 'close',
          },
        },
        (res) => {
          ctx.result.httpLatencyMs = ms(t0); // time to response headers
          ctx.result.httpStatus = res.statusCode ?? null;
          res.destroy(); // body is irrelevant for availability
          if (res.statusCode && expectedStatusCodes.includes(res.statusCode)) {
            ctx.result.httpSuccess = true;
            finish();
          } else {
            ctx.result.httpSuccess = false;
            finish(new StageError('HTTP_BAD_STATUS', `unexpected HTTP status ${res.statusCode}`));
          }
        },
      );
      const timer = setTimeout(() => {
        ctx.result.httpSuccess = false;
        req.destroy();
        finish(new StageError('HTTP_TIMEOUT', 'HTTP response timeout'));
      }, Math.max(1, remaining(ctx)));
      req.once('error', (e: NodeJS.ErrnoException) => {
        ctx.result.httpSuccess = false;
        finish(new StageError(e.code === 'ECONNRESET' ? 'HTTP_RESET' : 'HTTP_ERROR', `HTTP ${e.code ?? ''}: ${e.message}`));
      });
      req.end();
    });
  },
};
