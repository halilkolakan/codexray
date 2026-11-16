import http from 'http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import {
  AnalyzeRequestSchema,
  DockerSandboxStartRequestSchema,
  parseGitHubUrl,
  prisma,
} from '@codexray/shared';
import { env } from './env';
import { enqueueAnalysisJob, analysisQueue } from './queue';
import { setupSocketAndPubSub } from './socket';
import { renderScoreBadgeSvg } from './badge';
import { authRouter, getOptionalUserFromRequest } from './auth';
import { getOrBuildSandboxFiles } from './sandbox-tree';
import {
  checkDockerAvailable,
  cleanupAllDockerSandboxes,
  proxyDockerSandboxRequest,
  setupSandboxSocketReplay,
  startDockerSandbox,
  stopDockerSandbox,
} from './docker-runner';

const app = express();
const server = http.createServer(app);

const { io, subRedis } = setupSocketAndPubSub(server);
setupSandboxSocketReplay(io);

app.use(
  cors({
    origin: [env.WEB_URL, 'http://localhost:3000', 'http://127.0.0.1:3000'],
    credentials: true,
  })
);

// Mount Docker Sandbox reverse proxy BEFORE helmet and body parsers so
// iframe responses are never blocked by X-Frame-Options or CSP frame-ancestors
app.use('/api/sandbox/docker/proxy/:sandboxId', (req, res) => {
  proxyDockerSandboxRequest(req, res);
});

const helmetMiddleware = helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
});
app.use((req, res, next) => {
  if (req.path.startsWith('/api/sandbox/docker/proxy')) {
    next();
    return;
  }
  helmetMiddleware(req, res, next);
});

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

const analyzeRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 20, // up to 20 analysis requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many repository analysis requests. Please wait a moment and try again.',
  },
});

app.use('/api/auth', authRouter);

// Healthcheck endpoint
app.get('/api/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: 'ok',
      service: 'codexray-api',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({
      status: 'error',
      error: err instanceof Error ? err.message : 'Database unreachable',
    });
  }
});

// 1. Submit Repo (POST /api/analyze)
app.post('/api/analyze', analyzeRateLimiter, async (req, res) => {
  const parsedBody = AnalyzeRequestSchema.safeParse(req.body);
  if (!parsedBody.success) {
    res.status(400).json({
      error:
        parsedBody.error.errors[0]?.message ||
        'Invalid GitHub repository URL. Format: https://github.com/owner/repo',
      details: parsedBody.error.flatten(),
    });
    return;
  }

  const { repoUrl, force } = parsedBody.data;
  const { owner, name, fullName, cleanUrl } = parseGitHubUrl(repoUrl);
  const authUser = getOptionalUserFromRequest(req);

  try {
    const repository = await prisma.repository.upsert({
      where: { fullName },
      update: {},
      create: {
        owner,
        name,
        fullName,
      },
    });

    // Check if a recent completed analysis exists (< 10 mins old and not forced)
    if (!force) {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      const cachedJob = await prisma.analysisJob.findFirst({
        where: {
          repoId: repository.id,
          status: 'COMPLETED',
          completedAt: {
            gte: tenMinutesAgo,
          },
        },
        include: {
          repository: true,
        },
        orderBy: {
          completedAt: 'desc',
        },
      });

      if (cachedJob) {
        res.status(200).json({
          jobId: cachedJob.id,
          status: cachedJob.status,
          cached: true,
          job: cachedJob,
        });
        return;
      }
    }

    // Create new QUEUED AnalysisJob and push to BullMQ repo-analysis queue
    const newJob = await prisma.analysisJob.create({
      data: {
        repoId: repository.id,
        userId: authUser?.userId ?? null,
        status: 'QUEUED',
      },
      include: {
        repository: true,
      },
    });

    await enqueueAnalysisJob({
      jobId: newJob.id,
      repoId: repository.id,
      repoUrl: cleanUrl,
      owner,
      name,
      fullName,
      userId: authUser?.userId ?? null,
    });

    res.status(202).json({
      jobId: newJob.id,
      status: newJob.status,
      cached: false,
    });
  } catch (err) {
    console.error('[POST /api/analyze] Error:', err);
    res.status(500).json({
      error:
        err instanceof Error
          ? err.message
          : 'Failed to enqueue repository analysis job',
    });
  }
});

// 2. Get Analysis Job by ID (GET /api/jobs/:jobId)
app.get('/api/jobs/:jobId', async (req, res) => {
  const { jobId } = req.params;
  try {
    const job = await prisma.analysisJob.findUnique({
      where: { id: jobId },
      include: {
        repository: true,
      },
    });

    if (!job) {
      res.status(404).json({ error: 'Analysis job not found' });
      return;
    }

    res.json(job);
  } catch (err) {
    console.error(`[GET /api/jobs/${jobId}] Error:`, err);
    res.status(500).json({ error: 'Failed to fetch analysis job' });
  }
});

// 2b. Get WebContainer FileSystemTree for a Job (GET /api/jobs/:jobId/files)
app.get('/api/jobs/:jobId/files', async (req, res) => {
  const { jobId } = req.params;
  try {
    const sandboxData = await getOrBuildSandboxFiles(jobId);
    res.json(sandboxData);
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : 'Failed to build sandbox file tree';
    const status = msg.includes('not found') ? 404 : 500;
    console.error(`[GET /api/jobs/${jobId}/files] Error:`, msg);
    res.status(status).json({ error: msg });
  }
});

// 2c. Docker Sandbox Runner Endpoints
app.get('/api/sandbox/docker/status', async (_req, res) => {
  const status = await checkDockerAvailable();
  res.json(status);
});

app.post('/api/sandbox/docker/start', async (req, res) => {
  const parsed = DockerSandboxStartRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.errors[0]?.message || 'Invalid Docker sandbox request',
    });
    return;
  }

  try {
    const result = await startDockerSandbox(io, parsed.data);
    res.status(202).json(result);
  } catch (err) {
    console.error('[POST /api/sandbox/docker/start] Error:', err);
    res.status(500).json({
      error:
        err instanceof Error ? err.message : 'Failed to start Docker sandbox',
    });
  }
});

app.post('/api/sandbox/docker/stop', async (req, res) => {
  const sandboxId =
    typeof req.body?.sandboxId === 'string' ? req.body.sandboxId : '';
  if (!sandboxId) {
    res.status(400).json({ error: 'sandboxId is required' });
    return;
  }

  const stopped = await stopDockerSandbox(sandboxId);
  res.json({ ok: true, stopped });
});

// 3. Get Recent / User History (GET /api/history)
app.get('/api/history', async (req, res) => {
  const authUser = getOptionalUserFromRequest(req);
  const mineOnly = req.query.mine === 'true';

  try {
    const jobs = await prisma.analysisJob.findMany({
      where: {
        status: 'COMPLETED',
        ...(mineOnly && authUser ? { userId: authUser.userId } : {}),
      },
      orderBy: {
        completedAt: 'desc',
      },
      take: 20,
      select: {
        id: true,
        repoId: true,
        userId: true,
        status: true,
        healthScore: true,
        createdAt: true,
        completedAt: true,
        metricsJson: true,
        repository: true,
      },
    });

    res.json({ jobs });
  } catch (err) {
    console.error('[GET /api/history] Error:', err);
    res.status(500).json({ error: 'Failed to fetch analysis history' });
  }
});

// 4. Dynamic SVG Badge (GET /api/badge/:owner/:repo.svg)
app.get('/api/badge/:owner/:repoWithExt', async (req, res) => {
  const { owner, repoWithExt } = req.params;
  const repoName = repoWithExt.replace(/\.svg$/i, '');
  const fullName = `${owner}/${repoName}`;

  try {
    const latestJob = await prisma.analysisJob.findFirst({
      where: {
        repository: {
          fullName: {
            equals: fullName,
            mode: 'insensitive',
          },
        },
        status: 'COMPLETED',
      },
      orderBy: {
        completedAt: 'desc',
      },
      select: {
        healthScore: true,
      },
    });

    const svg = renderScoreBadgeSvg(latestJob?.healthScore ?? null);
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.status(200).send(svg);
  } catch (err) {
    console.error(`[GET /api/badge/${fullName}] Error:`, err);
    const fallbackSvg = renderScoreBadgeSvg(null);
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.status(200).send(fallbackSvg);
  }
});

server.listen(env.PORT, () => {
  console.log('====================================================');
  console.log(`⚡ CodeXray API listening on http://localhost:${env.PORT}`);
  console.log(`🔌 Socket.io ready & bridged to Redis Pub/Sub`);
  console.log('====================================================');
});

async function shutdown() {
  console.log('[API] Shutting down gracefully...');
  await cleanupAllDockerSandboxes();
  io.close();
  await subRedis.quit();
  await analysisQueue.close();
  await prisma.$disconnect();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
