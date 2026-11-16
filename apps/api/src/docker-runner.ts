import { execFile, spawn, ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import http from 'http';
import net from 'net';
import path from 'path';
import { promisify } from 'util';
import { Request, Response } from 'express';
import { Server as SocketIOServer } from 'socket.io';
import simpleGit from 'simple-git';
import {
  DockerSandboxLogEvent,
  DockerSandboxReadyEvent,
  DockerSandboxStartRequest,
  DockerSandboxStartResponseDto,
  DockerStatusResponseDto,
  GITHUB_REPO_REGEX,
  prisma,
} from '@codexray/shared';
import { env } from './env';

const execFileAsync = promisify(execFile);

const SANDBOX_TTL_MS = 15 * 60 * 1000; // 15 minutes idle TTL

interface SandboxSession {
  sandboxId: string;
  jobId: string;
  fullName: string;
  workingDir: string;
  script: string;
  hostPort: number;
  appPort: number;
  cloneDir: string;
  networkName: string | null;
  appContainerName: string;
  sidecarContainers: string[];
  hasPostgresSidecar: boolean;
  hasMongoSidecar: boolean;
  logBuffer: DockerSandboxLogEvent[];
  readyEvent: DockerSandboxReadyEvent | null;
  attachedProc: ChildProcess | null;
  ttlTimer: NodeJS.Timeout;
  stopped: boolean;
}

const activeSandboxes = new Map<string, SandboxSession>();

/**
 * Strip ANSI escape sequences for clean UI streaming
 */
function cleanLogLine(input: string): string {
  return input
    .replace(
      // eslint-disable-next-line no-control-regex
      /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g,
      ''
    )
    .replace(/\r/g, '');
}

/**
 * Check if Docker daemon is reachable on the host
 */
export async function checkDockerAvailable(): Promise<DockerStatusResponseDto> {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['info', '--format', '{{.ServerVersion}}'],
      { timeout: 5000 }
    );
    const version = stdout.trim();
    if (!version) {
      return { available: false };
    }
    return { available: true, version };
  } catch {
    return { available: false };
  }
}

/**
 * Allocate an ephemeral free TCP port on the host
 */
export function findFreeHostPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('Unable to allocate port')));
        return;
      }
      const port = addr.port;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function emitSandboxLog(
  io: SocketIOServer,
  session: SandboxSession,
  stage: DockerSandboxLogEvent['stage'],
  rawText: string
): void {
  const cleaned = cleanLogLine(rawText);
  if (!cleaned.trim()) return;

  const lines = cleaned.split('\n').filter((l) => l.trim().length > 0);
  for (const line of lines) {
    const evt: DockerSandboxLogEvent = {
      sandboxId: session.sandboxId,
      stage,
      line,
      timestamp: new Date().toISOString(),
    };
    session.logBuffer.push(evt);
    if (session.logBuffer.length > 300) {
      session.logBuffer.shift();
    }
    io.to(`sandbox:${session.sandboxId}`).emit('sandbox:log', evt);
  }
}

/**
 * Replay buffered logs and ready state when a client joins `sandbox:<sandboxId>`
 */
export function setupSandboxSocketReplay(io: SocketIOServer): void {
  io.on('connection', (socket) => {
    socket.on(
      'subscribe:sandbox',
      (payload: string | { sandboxId?: string }) => {
        const sandboxId =
          typeof payload === 'string' ? payload : payload?.sandboxId ?? '';
        const session = activeSandboxes.get(sandboxId);
        if (!session) return;

        for (const evt of session.logBuffer) {
          socket.emit('sandbox:log', evt);
        }
        if (session.readyEvent) {
          socket.emit('sandbox:ready', session.readyEvent);
        }
      }
    );
  });
}

/**
 * Parse key=value lines from .env string into a map
 */
function parseEnvString(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) {
      map.set(key, val);
    }
  }
  return map;
}

function serializeEnvMap(map: Map<string, string>): string {
  const lines: string[] = [];
  for (const [k, v] of map.entries()) {
    lines.push(`${k}="${v.replace(/"/g, '\\"')}"`);
  }
  return lines.join('\n') + '\n';
}

function isPlaceholderDbUrl(url: string | undefined): boolean {
  if (!url || !url.trim()) return true;
  const lower = url.toLowerCase();
  return (
    lower.includes('localhost') ||
    lower.includes('127.0.0.1') ||
    lower.includes('username:password') ||
    lower.includes('user:password') ||
    lower.includes('johndoe') ||
    lower.includes('your_')
  );
}

/**
 * Wait until PostgreSQL sidecar container responds to pg_isready
 */
async function waitForPostgresSidecar(containerName: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      await execFileAsync(
        'docker',
        ['exec', containerName, 'pg_isready', '-U', 'postgres', '-d', 'app'],
        { timeout: 3000 }
      );
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('Timed out waiting for PostgreSQL sidecar readiness');
}

/**
 * Poll hostPort until the containerized server accepts HTTP connections
 */
async function pollHostPortReady(
  session: SandboxSession,
  maxSeconds = 120
): Promise<boolean> {
  for (let i = 0; i < maxSeconds; i++) {
    if (session.stopped) return false;
    const isUp = await new Promise<boolean>((resolve) => {
      const req = http.get(
        {
          hostname: '127.0.0.1',
          port: session.hostPort,
          path: '/',
          timeout: 1200,
        },
        (res) => {
          res.resume();
          resolve(true);
        }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });

    if (isUp) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/**
 * Stop and clean up a Docker Sandbox session (app container, sidecar DBs, network, temp dir)
 */
export async function stopDockerSandbox(sandboxId: string): Promise<boolean> {
  const session = activeSandboxes.get(sandboxId);
  if (!session) return false;

  session.stopped = true;
  clearTimeout(session.ttlTimer);
  activeSandboxes.delete(sandboxId);

  if (session.attachedProc) {
    try {
      session.attachedProc.kill();
    } catch {
      // ignore
    }
  }

  const allContainers = [
    session.appContainerName,
    ...session.sidecarContainers,
  ];
  for (const cName of allContainers) {
    try {
      await execFileAsync('docker', ['rm', '-f', cName], { timeout: 10000 });
    } catch {
      // ignore if already removed
    }
  }

  if (session.networkName) {
    try {
      await execFileAsync('docker', ['network', 'rm', session.networkName], {
        timeout: 8000,
      });
    } catch {
      // ignore
    }
  }

  try {
    await fsp.rm(session.cloneDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  return true;
}

/**
 * Start an isolated Docker Sandbox container with optional Postgres/Mongo sidecars
 */
export async function startDockerSandbox(
  io: SocketIOServer,
  req: DockerSandboxStartRequest
): Promise<DockerSandboxStartResponseDto> {
  const status = await checkDockerAvailable();
  if (!status.available) {
    throw new Error('Docker daemon is not available on this host.');
  }

  const job = await prisma.analysisJob.findUnique({
    where: { id: req.jobId },
    include: { repository: true },
  });
  if (!job) {
    throw new Error('Analysis job not found');
  }

  const { fullName } = job.repository;
  const repoUrl = `https://github.com/${fullName}`;
  if (!GITHUB_REPO_REGEX.test(repoUrl)) {
    throw new Error(`Invalid repository URL: ${repoUrl}`);
  }

  const sandboxId = `sbx-${crypto.randomBytes(5).toString('hex')}`;
  const cloneRoot = path.resolve('/tmp/codexray-docker');
  const cloneDir = path.join(cloneRoot, sandboxId);
  const hostPort = await findFreeHostPort();
  const appPort = 3000;

  await fsp.mkdir(cloneRoot, { recursive: true });
  await fsp.rm(cloneDir, { recursive: true, force: true });
  await fsp.mkdir(cloneDir, { recursive: true });

  // Shallow clone repository
  const git = simpleGit({ timeout: { block: 60000 } });
  await git.clone(repoUrl, cloneDir, [
    '--depth',
    '1',
    '--single-branch',
    '--no-tags',
  ]);

  const cleanWorkingDir = (req.workingDir || '')
    .replace(/^\/+/, '')
    .replace(/\.\./g, '');
  const targetDir = cleanWorkingDir
    ? path.resolve(cloneDir, cleanWorkingDir)
    : cloneDir;
  if (!targetDir.startsWith(cloneDir) || !fs.existsSync(targetDir)) {
    throw new Error(`Target working directory "${cleanWorkingDir}" not found`);
  }

  // Inspect package.json & prisma/schema.prisma to determine sidecar DB needs
  const pkgPath = path.join(targetDir, 'package.json');
  let pkgJson: Record<string, unknown> = {};
  if (fs.existsSync(pkgPath)) {
    try {
      pkgJson = JSON.parse(await fsp.readFile(pkgPath, 'utf-8')) as Record<
        string,
        unknown
      >;
    } catch {
      // ignore
    }
  }

  const deps = (pkgJson.dependencies as Record<string, string>) || {};
  const devDeps = (pkgJson.devDependencies as Record<string, string>) || {};
  const allDeps = { ...devDeps, ...deps };

  const hasPrismaSchema = fs.existsSync(
    path.join(targetDir, 'prisma', 'schema.prisma')
  );
  const usesPostgres =
    hasPrismaSchema ||
    Boolean(
      allDeps['prisma'] ||
        allDeps['@prisma/client'] ||
        allDeps['pg'] ||
        allDeps['typeorm'] ||
        allDeps['sequelize'] ||
        allDeps['drizzle-orm']
    );
  const usesMongo = Boolean(allDeps['mongoose'] || allDeps['mongodb']);

  // Merge .env.example + existing .env + user envVars
  const repoEnvMap = new Map<string, string>();
  for (const exName of [
    '.env.example',
    '.env.local.example',
    '.env.template',
    '.env.sample',
    '.env',
  ]) {
    const p = path.join(targetDir, exName);
    if (fs.existsSync(p)) {
      const parsed = parseEnvString(await fsp.readFile(p, 'utf-8'));
      for (const [k, v] of parsed.entries()) {
        repoEnvMap.set(k, v);
      }
    }
  }

  const envMap = new Map<string, string>(repoEnvMap);
  if (req.envVars) {
    const userParsed = parseEnvString(req.envVars);
    for (const [k, v] of userParsed.entries()) {
      envMap.set(k, v);
    }
  }

  const currentDbUrl = envMap.get('DATABASE_URL');
  const repoDefaultDbUrl = repoEnvMap.get('DATABASE_URL');
  const hasCustomExternalPostgresUrl =
    Boolean(currentDbUrl) &&
    currentDbUrl !== repoDefaultDbUrl &&
    !isPlaceholderDbUrl(currentDbUrl);

  const currentMongoUrl = envMap.get('MONGO_URI') || envMap.get('MONGODB_URI');
  const repoDefaultMongoUrl =
    repoEnvMap.get('MONGO_URI') || repoEnvMap.get('MONGODB_URI');
  const hasCustomExternalMongoUrl =
    Boolean(currentMongoUrl) &&
    currentMongoUrl !== repoDefaultMongoUrl &&
    !isPlaceholderDbUrl(currentMongoUrl);

  const hasPostgresSidecar = usesPostgres && !hasCustomExternalPostgresUrl;
  const hasMongoSidecar = usesMongo && !hasCustomExternalMongoUrl;

  const networkName =
    hasPostgresSidecar || hasMongoSidecar
      ? `codexray-net-${sandboxId}`
      : null;
  const appContainerName = `codexray-app-${sandboxId}`;

  const ttlTimer = setTimeout(() => {
    void stopDockerSandbox(sandboxId);
  }, SANDBOX_TTL_MS);

  const previewUrl = `http://localhost:${hostPort}`;
  const proxyUrl = `${env.API_URL}/api/sandbox/docker/proxy/${sandboxId}/`;

  const session: SandboxSession = {
    sandboxId,
    jobId: req.jobId,
    fullName,
    workingDir: cleanWorkingDir,
    script: req.script || 'dev',
    hostPort,
    appPort,
    cloneDir,
    networkName,
    appContainerName,
    sidecarContainers: [],
    hasPostgresSidecar,
    hasMongoSidecar,
    logBuffer: [],
    readyEvent: null,
    attachedProc: null,
    ttlTimer,
    stopped: false,
  };

  activeSandboxes.set(sandboxId, session);

  // Launch asynchronous container provisioning & log streaming
  void (async () => {
    try {
      emitSandboxLog(
        io,
        session,
        'BOOTING_WASM',
        `[Docker Sandbox] Initializing isolated container environment (${sandboxId}) for ${fullName}...`
      );

      if (networkName) {
        await execFileAsync('docker', ['network', 'create', networkName], {
          timeout: 10000,
        });
        emitSandboxLog(
          io,
          session,
          'BOOTING_WASM',
          `[Docker Sandbox] Created isolated bridge network ${networkName}`
        );
      }

      if (hasPostgresSidecar && networkName) {
        const pgName = `codexray-pg-${sandboxId}`;
        session.sidecarContainers.push(pgName);
        emitSandboxLog(
          io,
          session,
          'BOOTING_WASM',
          `[Docker Sandbox] Starting ephemeral postgres:16-alpine sidecar (${pgName})...`
        );
        await execFileAsync(
          'docker',
          [
            'run',
            '-d',
            '--rm',
            '--name',
            pgName,
            '--network',
            networkName,
            '--network-alias',
            'db',
            '-e',
            'POSTGRES_USER=postgres',
            '-e',
            'POSTGRES_PASSWORD=postgres',
            '-e',
            'POSTGRES_DB=app',
            'postgres:16-alpine',
          ],
          { timeout: 30000 }
        );
        await waitForPostgresSidecar(pgName);
        envMap.set(
          'DATABASE_URL',
          'postgresql://postgres:postgres@db:5432/app?schema=public'
        );
        emitSandboxLog(
          io,
          session,
          'BOOTING_WASM',
          `[Docker Sandbox] ✅ PostgreSQL sidecar ready (DATABASE_URL injected -> db:5432/app)`
        );
      }

      if (hasMongoSidecar && networkName) {
        const mongoName = `codexray-mongo-${sandboxId}`;
        session.sidecarContainers.push(mongoName);
        emitSandboxLog(
          io,
          session,
          'BOOTING_WASM',
          `[Docker Sandbox] Starting ephemeral mongo:7 sidecar (${mongoName})...`
        );
        await execFileAsync(
          'docker',
          [
            'run',
            '-d',
            '--rm',
            '--name',
            mongoName,
            '--network',
            networkName,
            '--network-alias',
            'mongo',
            'mongo:7',
          ],
          { timeout: 45000 }
        );
        envMap.set('MONGO_URI', 'mongodb://mongo:27017/app');
        envMap.set('MONGODB_URI', 'mongodb://mongo:27017/app');
        emitSandboxLog(
          io,
          session,
          'BOOTING_WASM',
          `[Docker Sandbox] ✅ MongoDB sidecar started (MONGO_URI injected -> mongo:27017/app)`
        );
      }

      // Ensure PORT, HOST, BROWSER, and fallback JWT_SECRET are present in .env
      envMap.set('PORT', String(appPort));
      envMap.set('HOST', '0.0.0.0');
      envMap.set('BROWSER', 'none');
      if (!envMap.get('JWT_SECRET')) {
        envMap.set('JWT_SECRET', 'codexray-ephemeral-jwt-secret-key');
      }

      await fsp.writeFile(
        path.join(targetDir, '.env'),
        serializeEnvMap(envMap),
        'utf-8'
      );

      // Sanitize package.json scripts inside targetDir
      const scripts = (pkgJson.scripts as Record<string, string>) || {};
      delete scripts.preinstall;
      delete scripts.postinstall;
      delete scripts.prepare;
      delete pkgJson.engines;
      await fsp.writeFile(pkgPath, JSON.stringify(pkgJson, null, 2), 'utf-8');

      const scriptCmd = scripts[session.script] || '';
      const isVite = scriptCmd.includes('vite');
      const runCmd = isVite
        ? `npm run ${session.script} -- --host 0.0.0.0 --port ${appPort}`
        : `npm run ${session.script}`;

      const prismaSetupCmd = hasPrismaSchema
        ? 'echo "[Docker Sandbox] Running npx prisma generate & db push..." && npx prisma generate && (npx prisma db push --accept-data-loss --skip-generate || true) && '
        : '';

      const opensslInstallCmd = hasPrismaSchema
        ? 'apk add --no-cache openssl >/dev/null 2>&1 || true; '
        : '';

      const containerShellScript = `${opensslInstallCmd}echo "[Docker Sandbox] Running npm install --legacy-peer-deps..." && npm install --legacy-peer-deps --no-audit --no-fund && ${prismaSetupCmd}echo "[Docker Sandbox] Starting ${runCmd}..." && ${runCmd}`;

      const createArgs: string[] = [
        'create',
        '--rm',
        '--name',
        appContainerName,
        '--memory=1536m',
        '--cpus=1.5',
        '-w',
        '/workspace',
        '-p',
        `${hostPort}:${appPort}`,
        '-e',
        'HOST=0.0.0.0',
        '-e',
        `PORT=${appPort}`,
        '-e',
        'BROWSER=none',
        '-e',
        'CI=false',
        '-e',
        'WATCHPACK_POLLING=true',
      ];

      if (networkName) {
        createArgs.push('--network', networkName);
      }

      for (const [k, v] of envMap.entries()) {
        createArgs.push('-e', `${k}=${v}`);
      }

      createArgs.push('node:20-alpine', '/bin/sh', '-c', containerShellScript);

      emitSandboxLog(
        io,
        session,
        'INSTALLING_DEPS',
        `[Docker Sandbox] Creating node:20-alpine container (${appContainerName}) mapped to host port ${hostPort}...`
      );

      await execFileAsync('docker', createArgs, { timeout: 60000 });

      // Copy targetDir contents into container:/workspace
      await execFileAsync(
        'docker',
        ['cp', `${targetDir}/.`, `${appContainerName}:/workspace`],
        { timeout: 30000 }
      );

      if (session.stopped) return;

      const startProc = spawn('docker', ['start', '-a', appContainerName]);
      session.attachedProc = startProc;

      let currentStage: DockerSandboxLogEvent['stage'] = 'INSTALLING_DEPS';

      const handleChunk = (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        if (text.includes('Starting npm run')) {
          currentStage = 'STARTING_SERVER';
        }
        emitSandboxLog(io, session, currentStage, text);
      };

      startProc.stdout.on('data', handleChunk);
      startProc.stderr.on('data', handleChunk);

      startProc.on('exit', (code) => {
        if (!session.stopped && !session.readyEvent) {
          emitSandboxLog(
            io,
            session,
            'ERROR',
            `[Docker Sandbox] Container exited with code ${code ?? 1} before binding to port.`
          );
        }
      });

      // Poll hostPort until server is listening
      const ready = await pollHostPortReady(session, 120);
      if (ready && !session.stopped) {
        const readyEvt: DockerSandboxReadyEvent = {
          sandboxId,
          hostPort,
          previewUrl,
          proxyUrl,
        };
        session.readyEvent = readyEvt;
        emitSandboxLog(
          io,
          session,
          'SERVER_READY',
          `[Docker Sandbox] 🚀 Container server listening on ${previewUrl}`
        );
        io.to(`sandbox:${sandboxId}`).emit('sandbox:ready', readyEvt);
      }
    } catch (err) {
      if (!session.stopped) {
        emitSandboxLog(
          io,
          session,
          'ERROR',
          `[Docker Sandbox Error] ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  })();

  return {
    sandboxId,
    hostPort,
    previewUrl,
    proxyUrl,
    hasPostgresSidecar,
    hasMongoSidecar,
  };
}

const STRIPPED_PROXY_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
]);

function applyFramingSafeHeaders(res: Response): void {
  for (const h of STRIPPED_PROXY_HEADERS) {
    res.removeHeader(h);
  }
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  res.setHeader('Access-Control-Allow-Origin', '*');
}

/**
 * Reverse proxy HTTP requests to a running Docker Sandbox container,
 * or render an interactive Live API Inspector if a REST backend returns 404 Cannot GET /
 */
export function proxyDockerSandboxRequest(req: Request, res: Response): void {
  const { sandboxId } = req.params;
  const session = activeSandboxes.get(sandboxId);

  applyFramingSafeHeaders(res);

  if (!session) {
    res.status(404).send('Docker sandbox session not found or expired.');
    return;
  }

  // Refresh idle TTL on activity
  clearTimeout(session.ttlTimer);
  session.ttlTimer = setTimeout(() => {
    void stopDockerSandbox(sandboxId);
  }, SANDBOX_TTL_MS);

  const prefix = `/api/sandbox/docker/proxy/${sandboxId}`;
  const rawSubPath = req.originalUrl.startsWith(prefix)
    ? req.originalUrl.slice(prefix.length) || '/'
    : '/';
  const subPath = rawSubPath.startsWith('/') ? rawSubPath : `/${rawSubPath}`;
  const subPathPathname = subPath.split('?')[0] || '/';

  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: session.hostPort,
      path: subPath,
      method: req.method,
      headers: {
        ...req.headers,
        host: `localhost:${session.hostPort}`,
        'accept-encoding': 'identity',
      },
    },
    (proxyRes) => {
      applyFramingSafeHeaders(res);

      // If hitting root '/' on a backend REST API that returns 404, render an interactive Live API Inspector for the preview iframe
      if (subPathPathname === '/' && proxyRes.statusCode === 404) {
        const chunks: Buffer[] = [];
        proxyRes.on('data', (c: Buffer) => chunks.push(c));
        proxyRes.on('end', () => {
          const bodyStr = Buffer.concat(chunks).toString('utf-8');
          const escapedBody = bodyStr
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
          applyFramingSafeHeaders(res);
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${session.fullName} — Live Docker API Sandbox</title>
  <style>
    body { margin: 0; padding: 24px; font-family: ui-monospace, monospace; background: #09090b; color: #f4f4f5; }
    .card { background: #18181b; border: 1px solid #27272a; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 999px; background: rgba(16,185,129,0.15); color: #34d399; border: 1px solid rgba(16,185,129,0.4); font-size: 12px; font-weight: 700; }
    h1 { font-size: 18px; color: #22d3ee; margin: 10px 0 6px; }
    p { font-size: 13px; color: #a1a1aa; margin: 4px 0; line-height: 1.5; }
    code { color: #67e8f9; background: #09090b; padding: 2px 6px; border-radius: 4px; }
    pre { background: #09090b; border: 1px solid #27272a; padding: 12px; border-radius: 8px; color: #e4e4e7; font-size: 12px; overflow-x: auto; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">● DOCKER CONTAINER RUNNING (PORT ${session.hostPort})</span>
    <h1>${session.fullName} (${session.workingDir || 'root'})</h1>
    <p>The backend API server is live inside an isolated Docker container and listening on <code>http://localhost:${session.hostPort}</code>.</p>
    ${
      session.hasPostgresSidecar
        ? '<p style="color:#34d399;">✔ Ephemeral PostgreSQL 16 sidecar connected &amp; Prisma schema synced</p>'
        : ''
    }
    ${
      session.hasMongoSidecar
        ? '<p style="color:#34d399;">✔ Ephemeral MongoDB 7 sidecar connected</p>'
        : ''
    }
  </div>
  <div class="card">
    <p style="color:#e4e4e7;font-weight:bold;">Root Endpoint <code>GET /</code> Response (HTTP 404 — REST API Server):</p>
    <pre>${escapedBody}</pre>
    <p>Open <code>http://localhost:${session.hostPort}/api/...</code> or <code>http://localhost:${session.hostPort}/health</code> in a new tab to query API routes directly.</p>
  </div>
</body>
</html>`);
        });
        return;
      }

      const cleanHeaders: http.OutgoingHttpHeaders = {};
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (!STRIPPED_PROXY_HEADERS.has(key.toLowerCase())) {
          cleanHeaders[key] = value;
        }
      }
      cleanHeaders['cross-origin-resource-policy'] = 'cross-origin';
      cleanHeaders['cross-origin-embedder-policy'] = 'credentialless';
      cleanHeaders['access-control-allow-origin'] = '*';

      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
      res.writeHead(proxyRes.statusCode || 200, cleanHeaders);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (err) => {
    applyFramingSafeHeaders(res);
    res
      .status(502)
      .send(`Sandbox container on port ${session.hostPort} not ready: ${err.message}`);
  });

  req.pipe(proxyReq);
}

export async function cleanupAllDockerSandboxes(): Promise<void> {
  const ids = Array.from(activeSandboxes.keys());
  for (const id of ids) {
    await stopDockerSandbox(id);
  }
}
