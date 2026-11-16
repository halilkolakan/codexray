import fs from 'fs/promises';
import path from 'path';
import simpleGit from 'simple-git';
import {
  AnalysisQueuePayload,
  GITHUB_REPO_REGEX,
  Prisma,
  prisma,
} from '@codexray/shared';
import { analyzeRepositoryAst } from './ast-analyzer';
import { generateAiArchitectureReview } from './ai-reviewer';
import { fetchGitHubRepoMetadata } from './github-meta';
import { publishProgress } from './publisher';

/**
 * Execute the full repository analysis pipeline for a single AnalysisJob
 */
export async function processAnalysisJob(
  payload: AnalysisQueuePayload
): Promise<void> {
  const { jobId, repoId, repoUrl, owner, name, fullName } = payload;

  // Sanitize jobId strictly to alphanumeric/dash/underscore to prevent path traversal
  const safeJobId = jobId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeJobId) {
    throw new Error('Invalid jobId');
  }

  // Strictly validate repoUrl before passing to simple-git
  const cleanCloneUrl = repoUrl.trim().replace(/\/$/, '');
  if (!GITHUB_REPO_REGEX.test(cleanCloneUrl)) {
    throw new Error(`Security rejection: Invalid GitHub URL "${repoUrl}"`);
  }

  // Unique clone directory under /tmp/codexray/<jobId>
  const cloneDir = path.resolve('/tmp/codexray', safeJobId);

  try {
    // STEP 1: CLONING
    await prisma.analysisJob.update({
      where: { id: jobId },
      data: { status: 'CLONING' },
    });

    await publishProgress(
      jobId,
      'CLONING',
      'Cloning Repository',
      `Initializing shallow clone (--depth 1) for ${fullName}...`,
      10
    );

    // Ensure clean target directory
    await fs.rm(cloneDir, { recursive: true, force: true });
    await fs.mkdir(cloneDir, { recursive: true });

    // Fetch GitHub repo metadata in parallel with git clone
    const metaPromise = fetchGitHubRepoMetadata(owner, name);

    const git = simpleGit({
      timeout: {
        block: 60000,
      },
    });

    await git.clone(cleanCloneUrl, cloneDir, [
      '--depth',
      '1',
      '--single-branch',
      '--no-tags',
    ]);

    const repoMeta = await metaPromise;

    await publishProgress(
      jobId,
      'CLONING',
      'Cloning Repository',
      `Shallow clone complete (${fullName}, ★ ${repoMeta.stars.toLocaleString()}, branch: ${repoMeta.defaultBranch}).`,
      22
    );

    // STEP 2: AST PARSING & DEPENDENCY GRAPH
    await prisma.analysisJob.update({
      where: { id: jobId },
      data: { status: 'PARSING' },
    });

    await publishProgress(
      jobId,
      'PARSING',
      'Building AST & Dependency Graph',
      'Walking source tree (.ts, .tsx, .js, .jsx) and extracting AST imports/exports...',
      26
    );

    const astOutput = analyzeRepositoryAst(cloneDir, (msg, pct) => {
      void publishProgress(
        jobId,
        'PARSING',
        'Building AST & Dependency Graph',
        msg,
        pct
      );
    });

    await publishProgress(
      jobId,
      'PARSING',
      'Building AST & Dependency Graph',
      `AST graph built: ${astOutput.metrics.fileCount} files (${astOutput.metrics.totalLoc.toLocaleString()} LOC), ${astOutput.metrics.circularDependencyCount} circular dependencies, Health Score: ${astOutput.healthScore}/100.`,
      65
    );

    // STEP 3: AI SENIOR ENGINEER REVIEW
    await prisma.analysisJob.update({
      where: { id: jobId },
      data: { status: 'AI_REVIEW' },
    });

    await publishProgress(
      jobId,
      'AI_REVIEW',
      'AI Senior Engineer Review',
      'Streaming structural telemetry to Gemini 2.5 Flash for architectural analysis...',
      72
    );

    const aiReview = await generateAiArchitectureReview(
      fullName,
      astOutput.healthScore,
      astOutput.structuralSummary
    );

    await publishProgress(
      jobId,
      'AI_REVIEW',
      'AI Senior Engineer Review',
      `AI review synthesized (Pattern: ${aiReview.architecturePattern}). Persisting results...`,
      92
    );

    // STEP 4: PERSIST TO POSTGRESQL & PUBLISH COMPLETED
    const now = new Date();
    await prisma.$transaction([
      prisma.repository.update({
        where: { id: repoId },
        data: {
          stars: repoMeta.stars > 0 ? repoMeta.stars : undefined,
          defaultBranch: repoMeta.defaultBranch,
          lastAnalyzedAt: now,
        },
      }),
      prisma.analysisJob.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          healthScore: astOutput.healthScore,
          metricsJson: astOutput.metrics as unknown as Prisma.InputJsonValue,
          graphJson: astOutput.graph as unknown as Prisma.InputJsonValue,
          aiReviewJson: aiReview as unknown as Prisma.InputJsonValue,
          errorMessage: null,
          completedAt: now,
        },
      }),
    ]);

    await publishProgress(
      jobId,
      'COMPLETED',
      'Analysis Complete',
      `CodeXray analysis completed for ${fullName} with Health Score ${astOutput.healthScore}/100.`,
      100
    );
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : 'Unexpected worker error';
    console.error(`[Worker] Job ${jobId} (${fullName}) failed:`, errorMessage);

    try {
      await prisma.analysisJob.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          errorMessage,
          completedAt: new Date(),
        },
      });
    } catch (dbErr) {
      console.error(`[Worker] Failed to record FAILED status for ${jobId}:`, dbErr);
    }

    await publishProgress(
      jobId,
      'FAILED',
      'Analysis Failed',
      `Error: ${errorMessage}`,
      100
    );

    throw err;
  } finally {
    // Always clean up /tmp/codexray/<jobId> inside a finally block
    try {
      await fs.rm(cloneDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.warn(
        `[Worker] Failed to clean up ${cloneDir}:`,
        cleanupErr instanceof Error ? cleanupErr.message : cleanupErr
      );
    }
  }
}
