import { Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import Redis from 'ioredis';
import {
  JobProgressEvent,
  JobProgressEventSchema,
  REDIS_CHANNELS,
  prisma,
} from '@codexray/shared';
import { env } from './env';

export function setupSocketAndPubSub(httpServer: HttpServer): {
  io: SocketIOServer;
  subRedis: Redis;
} {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: [env.WEB_URL, 'http://localhost:3000', 'http://127.0.0.1:3000'],
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  const subRedis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
  });
  let redisWarned = false;
  subRedis.on('error', (err) => {
    if (!redisWarned) {
      console.warn('[API PubSub] Waiting for Redis connection on', env.REDIS_URL, '-', err.message);
      redisWarned = true;
    }
  });
  subRedis.on('connect', () => {
    redisWarned = false;
  });

  subRedis.subscribe(REDIS_CHANNELS.JOB_EVENTS, (err) => {
    if (err) {
      console.error('[API PubSub] Failed to subscribe to Redis channel:', err);
    } else {
      console.log(
        `[API PubSub] Subscribed to Redis channel "${REDIS_CHANNELS.JOB_EVENTS}"`
      );
    }
  });

  subRedis.on('message', (channel, message) => {
    if (channel !== REDIS_CHANNELS.JOB_EVENTS) return;
    try {
      const parsed = JSON.parse(message);
      const event = JobProgressEventSchema.parse(parsed);
      io.to(`job:${event.jobId}`).emit('job:progress', event);
    } catch (err) {
      console.warn('[API PubSub] Malformed progress event ignored:', err);
    }
  });

  io.on('connection', (socket) => {
    socket.on('subscribe:job', async (payload: string | { jobId?: string }) => {
      const jobId =
        typeof payload === 'string' ? payload : payload?.jobId ?? '';
      if (!jobId) return;

      const roomName = `job:${jobId}`;
      await socket.join(roomName);

      // Immediately emit current state from DB so client is synchronized even if job progressed before subscribe
      try {
        const job = await prisma.analysisJob.findUnique({
          where: { id: jobId },
          include: { repository: true },
        });
        if (job) {
          const stepMap: Record<string, { step: string; pct: number }> = {
            QUEUED: { step: 'Queued in BullMQ', pct: 5 },
            CLONING: { step: 'Cloning Repository', pct: 18 },
            PARSING: { step: 'Building AST & Dependency Graph', pct: 45 },
            AI_REVIEW: { step: 'AI Senior Engineer Review', pct: 78 },
            COMPLETED: { step: 'Analysis Complete', pct: 100 },
            FAILED: { step: 'Analysis Failed', pct: 100 },
          };
          const info = stepMap[job.status] || { step: 'Processing', pct: 10 };
          const initialEvent: JobProgressEvent = {
            jobId: job.id,
            status: job.status,
            step: info.step,
            logLine:
              job.status === 'COMPLETED'
                ? `Completed analysis for ${job.repository.fullName} (Score: ${job.healthScore}/100).`
                : job.status === 'FAILED'
                ? `Failed: ${job.errorMessage || 'Unknown error'}`
                : `Connected to live telemetry stream for ${job.repository.fullName} (${job.status})...`,
            progressPercent: info.pct,
            timestamp: new Date().toISOString(),
          };
          socket.emit('job:progress', initialEvent);
        }
      } catch {
        // ignore initial state lookup errors
      }
    });

    socket.on('unsubscribe:job', async (payload: string | { jobId?: string }) => {
      const jobId =
        typeof payload === 'string' ? payload : payload?.jobId ?? '';
      if (!jobId) return;
      await socket.leave(`job:${jobId}`);
    });

    socket.on(
      'subscribe:sandbox',
      async (payload: string | { sandboxId?: string }) => {
        const sandboxId =
          typeof payload === 'string' ? payload : payload?.sandboxId ?? '';
        if (!sandboxId) return;
        await socket.join(`sandbox:${sandboxId}`);
        socket.emit('sandbox:subscribed', { sandboxId });
      }
    );

    socket.on(
      'unsubscribe:sandbox',
      async (payload: string | { sandboxId?: string }) => {
        const sandboxId =
          typeof payload === 'string' ? payload : payload?.sandboxId ?? '';
        if (!sandboxId) return;
        await socket.leave(`sandbox:${sandboxId}`);
      }
    );
  });

  return { io, subRedis };
}
