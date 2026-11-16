import Redis from 'ioredis';
import {
  JobProgressEvent,
  AnalysisJobStatus,
  REDIS_CHANNELS,
} from '@codexray/shared';
import { env } from './env';

let pubClient: Redis | null = null;

export function getPublisherClient(): Redis {
  if (!pubClient) {
    pubClient = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });
  }
  return pubClient;
}

export async function publishProgress(
  jobId: string,
  status: AnalysisJobStatus,
  step: string,
  logLine: string,
  progressPercent: number
): Promise<void> {
  const event: JobProgressEvent = {
    jobId,
    status,
    step,
    logLine,
    progressPercent: Math.max(0, Math.min(100, Math.round(progressPercent))),
    timestamp: new Date().toISOString(),
  };

  try {
    const redis = getPublisherClient();
    await redis.publish(REDIS_CHANNELS.JOB_EVENTS, JSON.stringify(event));
  } catch (err) {
    console.error(`[Worker Publisher] Failed to publish event for ${jobId}:`, err);
  }
}

export async function closePublisher(): Promise<void> {
  if (pubClient) {
    await pubClient.quit();
    pubClient = null;
  }
}
