import { Worker, Job } from 'bullmq';
import Redis from 'ioredis';
import {
  AnalysisQueuePayload,
  QUEUE_NAMES,
  prisma,
} from '@codexray/shared';
import { env } from './env';
import { processAnalysisJob } from './processor';
import { closePublisher } from './publisher';

const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});
let workerRedisWarned = false;
connection.on('error', (err) => {
  if (!workerRedisWarned) {
    console.warn('[Worker] Waiting for Redis connection on', env.REDIS_URL, '-', err.message);
    workerRedisWarned = true;
  }
});
connection.on('connect', () => {
  workerRedisWarned = false;
});

console.log('====================================================');
console.log('🚀 CodeXray Worker starting...');
console.log(`📡 Queue: ${QUEUE_NAMES.REPO_ANALYSIS}`);
console.log(`🔗 Redis: ${env.REDIS_URL}`);
console.log('====================================================');

const worker = new Worker<AnalysisQueuePayload>(
  QUEUE_NAMES.REPO_ANALYSIS,
  async (job: Job<AnalysisQueuePayload>) => {
    console.log(
      `[Worker] Picked up job ${job.data.jobId} for repository ${job.data.fullName}`
    );
    await processAnalysisJob(job.data);
  },
  {
    connection,
    concurrency: 2,
  }
);

worker.on('completed', (job) => {
  console.log(
    `[Worker] ✅ Job ${job.data.jobId} (${job.data.fullName}) completed.`
  );
});

worker.on('failed', (job, err) => {
  console.error(
    `[Worker] ❌ Job ${job?.data?.jobId} (${job?.data?.fullName}) failed:`,
    err.message
  );
});

async function shutdown() {
  console.log('[Worker] Shutting down gracefully...');
  await worker.close();
  await closePublisher();
  await connection.quit();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
