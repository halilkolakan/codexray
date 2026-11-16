import fs from 'fs';
import path from 'path';
import { prisma, parseGitHubUrl } from '@codexray/shared';
import { processAnalysisJob } from './processor';
import { closePublisher } from './publisher';

async function runVerificationTest() {
  const testRepoUrl = 'https://github.com/pmndrs/zustand';
  const parsed = parseGitHubUrl(testRepoUrl);

  console.log(`[Test Pipeline] Starting standalone verification on ${parsed.fullName}...`);

  const repo = await prisma.repository.upsert({
    where: { fullName: parsed.fullName },
    update: {},
    create: {
      owner: parsed.owner,
      name: parsed.name,
      fullName: parsed.fullName,
    },
  });

  const job = await prisma.analysisJob.create({
    data: {
      repoId: repo.id,
      status: 'QUEUED',
    },
  });

  console.log(`[Test Pipeline] Created AnalysisJob ${job.id}`);

  await processAnalysisJob({
    jobId: job.id,
    repoId: repo.id,
    repoUrl: parsed.cleanUrl,
    owner: parsed.owner,
    name: parsed.name,
    fullName: parsed.fullName,
  });

  const completedJob = await prisma.analysisJob.findUnique({
    where: { id: job.id },
    include: { repository: true },
  });

  if (!completedJob || completedJob.status !== 'COMPLETED') {
    throw new Error(`Expected COMPLETED status, got ${completedJob?.status}`);
  }

  const cloneDir = path.resolve('/tmp/codexray', job.id);
  const tmpExists = fs.existsSync(cloneDir);
  if (tmpExists) {
    throw new Error(`Cleanup verification failed: ${cloneDir} still exists!`);
  }

  console.log('[Test Pipeline] ✅ Verification PASSED!');
  console.log(`  - Repository: ${completedJob.repository.fullName} (★ ${completedJob.repository.stars})`);
  console.log(`  - Status: ${completedJob.status}`);
  console.log(`  - Health Score: ${completedJob.healthScore}/100`);
  console.log(
    `  - Metrics:`,
    JSON.stringify(completedJob.metricsJson).slice(0, 220) + '...'
  );
  console.log(
    `  - AI Review Pattern:`,
    (completedJob.aiReviewJson as { architecturePattern?: string })?.architecturePattern
  );
  console.log(`  - Temp directory cleaned up (${cloneDir}): ${!tmpExists}`);

  await closePublisher();
  await prisma.$disconnect();
}

runVerificationTest().catch(async (err) => {
  console.error('[Test Pipeline] ❌ Verification FAILED:', err);
  await closePublisher();
  await prisma.$disconnect();
  process.exit(1);
});
