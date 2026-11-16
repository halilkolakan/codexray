import { PrismaClient, JobStatus } from '@prisma/client';
import { z } from 'zod';

export { PrismaClient, JobStatus };
export * from '@prisma/client';

// Global singleton PrismaClient to prevent connection pool exhaustion in dev
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// ============================================================================
// REDIS & QUEUE CONTRACTS
// ============================================================================

export const REDIS_CHANNELS = {
  JOB_EVENTS: 'codexray:events',
} as const;

export const QUEUE_NAMES = {
  REPO_ANALYSIS: 'repo-analysis',
} as const;

export const GITHUB_REPO_REGEX =
  /^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

export const AnalyzeRequestSchema = z.object({
  repoUrl: z
    .string()
    .trim()
    .regex(
      GITHUB_REPO_REGEX,
      'Must be a valid GitHub repository URL (e.g. https://github.com/owner/repo)'
    ),
  force: z.boolean().optional().default(false),
});

export type AnalyzeRequest = z.infer<typeof AnalyzeRequestSchema>;

export function parseGitHubUrl(url: string): {
  owner: string;
  name: string;
  fullName: string;
  cleanUrl: string;
} {
  const trimmed = url.trim().replace(/\.git$/, '').replace(/\/$/, '');
  const match = /^https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/.exec(
    trimmed
  );
  if (!match) {
    throw new Error(`Invalid GitHub repository URL: ${url}`);
  }
  const owner = match[1];
  const name = match[2];
  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
    cleanUrl: `https://github.com/${owner}/${name}`,
  };
}

export const JobStatusSchema = z.enum([
  'QUEUED',
  'CLONING',
  'PARSING',
  'AI_REVIEW',
  'COMPLETED',
  'FAILED',
]);

export type AnalysisJobStatus = z.infer<typeof JobStatusSchema>;

export const JobProgressEventSchema = z.object({
  jobId: z.string(),
  status: JobStatusSchema,
  step: z.string(),
  logLine: z.string(),
  progressPercent: z.number().min(0).max(100),
  timestamp: z.string(),
});

export type JobProgressEvent = z.infer<typeof JobProgressEventSchema>;

export interface AnalysisQueuePayload {
  jobId: string;
  repoId: string;
  repoUrl: string;
  owner: string;
  name: string;
  fullName: string;
  userId?: string | null;
}

// ============================================================================
// GRAPH & METRICS CONTRACTS
// ============================================================================

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface HotspotFile {
  filePath: string;
  loc: number;
  fanIn: number;
  fanOut: number;
  couplingScore: number;
  inCycle: boolean;
}

export interface AnalysisMetrics {
  fileCount: number;
  totalLoc: number;
  avgLoc: number;
  circularDependencyCount: number;
  circularDependencies: string[][];
  maxFanIn: number;
  maxFanOut: number;
  mostCoupledFile: string | null;
  hotspotFiles: HotspotFile[];
  languageBreakdown: Record<string, number>;
}

export interface ReactFlowNodeData {
  label: string;
  filePath: string;
  folder: string;
  loc: number;
  fanIn: number;
  fanOut: number;
  inCycle: boolean;
  isHub: boolean;
  riskLevel: RiskLevel;
  imports: string[];
  importedBy: string[];
  exports: string[];
}

export interface GraphNode {
  id: string;
  type: 'fileNode';
  position: { x: number; y: number };
  data: ReactFlowNodeData;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  animated?: boolean;
  data?: {
    isCircular: boolean;
  };
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ============================================================================
// AI SENIOR ENGINEER REVIEW CONTRACTS
// ============================================================================

export const AiStrengthSchema = z.object({
  title: z.string(),
  description: z.string(),
  impact: z.string(),
});

export const AiRiskSchema = z.object({
  title: z.string(),
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  description: z.string(),
  affectedFiles: z.array(z.string()),
  recommendation: z.string(),
});

export const AiOnboardingStepSchema = z.object({
  step: z.number(),
  fileOrDir: z.string(),
  reason: z.string(),
});

export const AiOnboardingGuideSchema = z.object({
  overview: z.string(),
  entryPoints: z.array(z.string()),
  readingOrder: z.array(AiOnboardingStepSchema),
  keyConventions: z.array(z.string()),
});

export const AiReviewSchema = z.object({
  architecturePattern: z.string(),
  architectureSummary: z.string(),
  strengths: z.array(AiStrengthSchema).min(1).max(5),
  risks: z.array(AiRiskSchema).min(1).max(5),
  onboardingGuide: AiOnboardingGuideSchema,
});

export type AiReviewData = z.infer<typeof AiReviewSchema>;

// ============================================================================
// API RESPONSE CONTRACTS
// ============================================================================

export interface RepositoryDto {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  stars: number;
  defaultBranch: string;
  lastAnalyzedAt: string | null;
}

export interface AnalysisJobDto {
  id: string;
  repoId: string;
  userId: string | null;
  status: AnalysisJobStatus;
  healthScore: number | null;
  metricsJson: AnalysisMetrics | null;
  graphJson: GraphData | null;
  aiReviewJson: AiReviewData | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  repository: RepositoryDto;
}

export interface AnalyzeResponseDto {
  jobId: string;
  status: AnalysisJobStatus;
  cached: boolean;
  job?: AnalysisJobDto;
}

// ============================================================================
// WEBCONTAINER LIVE BROWSER SANDBOX CONTRACTS
// ============================================================================

export interface WebContainerFileNode {
  file: {
    contents: string;
  };
}

export interface WebContainerDirNode {
  directory: WebContainerFileSystemTree;
}

export interface WebContainerFileSystemTree {
  [name: string]: WebContainerFileNode | WebContainerDirNode;
}

export type SandboxPackageManager = 'npm' | 'pnpm' | 'yarn';

export type SandboxTargetTier = 'READY' | 'NEEDS_CONFIG' | 'UNSUPPORTED';

export interface SandboxTargetInfo {
  dir: string; // '' for root, or relative path e.g. 'client'
  label: string; // e.g. '/ (Root)' or '/client'
  framework: string;
  tier: SandboxTargetTier;
  warnings: string[];
  scripts: string[];
  defaultScript?: string;
  hasEnvExample: boolean;
}

export interface SandboxFilesResponseDto {
  jobId: string;
  fullName: string;
  supported: boolean;
  reason?: string;
  packageManager: SandboxPackageManager;
  startScript?: string;
  workingDir?: string;
  availableTargets?: SandboxTargetInfo[];
  isStaticHtml?: boolean;
  fileCount: number;
  totalBytes: number;
  tree: WebContainerFileSystemTree;
}

// ============================================================================
// DOCKER SANDBOX RUNNER CONTRACTS
// ============================================================================

export const DockerSandboxStartRequestSchema = z.object({
  jobId: z.string().min(1),
  workingDir: z.string().optional().default(''),
  script: z.string().optional().default('dev'),
  envVars: z.string().optional(),
});

export type DockerSandboxStartRequest = z.infer<
  typeof DockerSandboxStartRequestSchema
>;

export interface DockerStatusResponseDto {
  available: boolean;
  version?: string;
}

export interface DockerSandboxStartResponseDto {
  sandboxId: string;
  hostPort: number;
  previewUrl: string;
  proxyUrl: string;
  hasPostgresSidecar: boolean;
  hasMongoSidecar: boolean;
}

export interface DockerSandboxLogEvent {
  sandboxId: string;
  stage:
    | 'BOOTING_WASM'
    | 'INSTALLING_DEPS'
    | 'STARTING_SERVER'
    | 'SERVER_READY'
    | 'ERROR';
  line: string;
  timestamp: string;
}

export interface DockerSandboxReadyEvent {
  sandboxId: string;
  hostPort: number;
  previewUrl: string;
  proxyUrl: string;
}

