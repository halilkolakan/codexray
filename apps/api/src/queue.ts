import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { AnalysisQueuePayload, QUEUE_NAMES } from '@codexray/shared';
import { env } from './env';

const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});
let queueRedisWarned = false;
connection.on('error', (err) => {
  if (!queueRedisWarned) {
    console.warn('[API Queue] Waiting for Redis connection on', env.REDIS_URL, '-', err.message);
    queueRedisWarned = true;
  }
});
connection.on('connect', () => {
  queueRedisWarned = false;
});

export const analysisQueue = new Queue<AnalysisQueuePayload>(
  QUEUE_NAMES.REPO_ANALYSIS,
  {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  }
);

export async function enqueueAnalysisJob(
  payload: AnalysisQueuePayload
): Promise<void> {
  await analysisQueue.add('analyze-repo', payload, {
    jobId: payload.jobId,
  });
}
