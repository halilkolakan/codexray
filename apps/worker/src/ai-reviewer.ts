import { GoogleGenAI, Type } from '@google/genai';
import { AiReviewData, AiReviewSchema } from '@codexray/shared';
import { StructuralSummary } from './ast-analyzer';
import { env } from './env';

/**
 * Generate a deterministic fallback review when Gemini API is unavailable or rate-limited
 */
function buildDeterministicFallbackReview(
  fullName: string,
  healthScore: number,
  summary: StructuralSummary
): AiReviewData {
  const topHubs = summary.topHubFiles.slice(0, 4);
  const topHubNames = topHubs.map((h) => h.filePath);
  const depKeys = Object.keys(summary.packageDependencies);

  const hasReact = depKeys.some((d) => d === 'react' || d === 'next');
  const hasExpress = depKeys.some((d) => d === 'express' || d === 'fastify');
  const isMonorepo = summary.folderTree.some(
    (f) => f.startsWith('packages/') || f.startsWith('apps/')
  );

  const architecturePattern = isMonorepo
    ? 'Multi-Package Workspace / Modular Monorepo Architecture'
    : hasReact
    ? 'Component-Driven Frontend / Reactive State Architecture'
    : hasExpress
    ? 'Layered HTTP Service & Middleware Pipeline Architecture'
    : 'Modular TypeScript / JavaScript Library Architecture';

  const cycleCount = summary.circularDependencies.length;

  return {
    architecturePattern,
    architectureSummary: `${fullName} comprises ${summary.fileCount} analyzed source modules totaling ${summary.totalLoc.toLocaleString()} lines of code (Health Score: ${healthScore}/100). The codebase is organized around ${
      summary.folderTree.slice(0, 5).join(', ') || 'root modules'
    }, with primary dependency hubs centered at ${
      topHubNames.slice(0, 3).join(', ') || 'the entry module'
    }. ${
      cycleCount === 0
        ? 'The module dependency graph is strictly acyclic (DAG), enabling clean tree-shaking and predictable build boundaries.'
        : `AST analysis identified ${cycleCount} circular dependency chain(s) that increase coupling between internal modules.`
    }`,
    strengths: [
      {
        title:
          cycleCount === 0
            ? 'Zero Circular Dependencies (Strict DAG)'
            : 'Clear Core Abstraction Boundaries',
        description:
          cycleCount === 0
            ? 'Every internal import flows unidirectionally from high-level entrypoints down to foundational utilities without cyclic back-edges.'
            : `Core domain logic is consolidated into dedicated directory layers (${
                summary.folderTree.slice(0, 4).join(', ') || 'root'
              }), keeping feature modules discoverable.`,
        impact:
          'Reduces regression blast radius, improves bundler tree-shaking, and accelerates unit test isolation.',
      },
      {
        title: 'Cohesive Module Granularity',
        description: `Across ${summary.fileCount} source files, the average module size is ${Math.round(
          summary.totalLoc / Math.max(1, summary.fileCount)
        )} LOC, avoiding monolithic multi-thousand-line source files.`,
        impact:
          'Keeps cognitive load low during code reviews and enables parallel developer contributions with fewer merge conflicts.',
      },
      {
        title: 'Centralized Public Surface & Hub Reuse',
        description: `High fan-in modules (${
          topHubNames.slice(0, 2).join(', ') || 'core exports'
        }) act as well-defined shared primitives consumed across the repository.`,
        impact:
          'Promotes DRY reuse and establishes clear contract boundaries for downstream consumers.',
      },
    ],
    risks: [
      cycleCount > 0
        ? {
            title: `Circular Module Coupling (${cycleCount} Cycle${
              cycleCount > 1 ? 's' : ''
            } Detected)`,
            severity: cycleCount > 3 ? 'HIGH' : 'MEDIUM',
            description: `Mutual import cycles were detected (e.g. ${summary.circularDependencies[0]?.join(
              ' -> '
            )}). Cyclic dependencies can cause undefined runtime imports during module initialization.`,
            affectedFiles: summary.circularDependencies[0]?.slice(0, 4) || topHubNames.slice(0, 2),
            recommendation:
              'Extract shared interfaces, types, or helper constants into a leaf module that both sides can import unidirectionally.',
          }
        : {
            title: 'High Fan-In Hub Concentration',
            severity: 'LOW',
            description: `Top hub modules (${
              topHubNames.slice(0, 2).join(', ') || 'index'
            }) carry high fan-in/fan-out coupling scores, making breaking changes ripple across many dependents.`,
            affectedFiles: topHubNames.slice(0, 3),
            recommendation:
              'Lock down public signatures of high fan-in modules with dedicated unit contract tests and avoid adding side effects at module top-level.',
          },
      {
        title: 'Hotspot Module Complexity & Change Amplification',
        severity:
          (topHubs[0]?.loc ?? 0) > 400 || (topHubs[0]?.couplingScore ?? 0) > 25
            ? 'MEDIUM'
            : 'LOW',
        description: `Primary hotspot ${
          topHubs[0]?.filePath || 'core module'
        } (${topHubs[0]?.loc || 0} LOC, fan-in ${topHubs[0]?.fanIn || 0}, fan-out ${
          topHubs[0]?.fanOut || 0
        }) concentrates both orchestration and implementation details.`,
        affectedFiles: topHubNames.slice(0, 2),
        recommendation:
          'Split orchestration logic from pure data transformations so complex edge cases can be tested without mocking downstream dependencies.',
      },
      {
        title: 'Barrel File & Transitive Import Chains',
        severity: 'LOW',
        description:
          'Re-exporting multiple submodules through shared index files can pull unused modules into the module graph during cold starts.',
        affectedFiles: topHubNames.filter((f) => f.includes('index')).slice(0, 3).length
          ? topHubNames.filter((f) => f.includes('index')).slice(0, 3)
          : topHubNames.slice(0, 2),
        recommendation:
          'Prefer direct leaf imports for heavy internal utilities and verify `"sideEffects": false` in package configuration.',
      },
    ],
    onboardingGuide: {
      overview: `Welcome to ${fullName}. Start by understanding the public API contracts and entry modules before diving into internal implementation helpers.`,
      entryPoints:
        topHubNames.slice(0, 3).length > 0 ? topHubNames.slice(0, 3) : ['src/index.ts'],
      readingOrder: topHubs.slice(0, 4).map((hub, idx) => ({
        step: idx + 1,
        fileOrDir: hub.filePath,
        reason:
          idx === 0
            ? `Primary architectural hub (fan-in: ${hub.fanIn}, fan-out: ${hub.fanOut}, ${hub.loc} LOC) that defines core abstractions.`
            : `Key module in the dependency graph (${hub.loc} LOC, imported by ${hub.fanIn} module(s)).`,
      })),
      keyConventions: [
        'Follow unidirectional module imports from feature/API layers down into shared core utilities.',
        'Keep barrel exports minimal and co-locate unit tests alongside core domain modules.',
        'Check the interactive dependency graph before modifying high fan-in hub files.',
      ],
    },
  };
}

/**
 * Call Gemini 2.5 Flash with structured JSON output to produce a Senior Staff Engineer code review
 */
export async function generateAiArchitectureReview(
  fullName: string,
  healthScore: number,
  summary: StructuralSummary
): Promise<AiReviewData> {
  if (!env.GEMINI_API_KEY) {
    return buildDeterministicFallbackReview(fullName, healthScore, summary);
  }

  try {
    const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

    const compactPayload = {
      repository: fullName,
      healthScore,
      fileCount: summary.fileCount,
      totalLoc: summary.totalLoc,
      folderStructure: summary.folderTree,
      topHubFiles: summary.topHubFiles,
      circularDependencies: summary.circularDependencies,
      dependencies: Object.keys(summary.packageDependencies).slice(0, 45),
      readmeExcerpt: summary.readmeExcerpt.slice(0, 900),
    };

    const prompt = `You are a Principal Systems Architect conducting an architectural design review of the GitHub repository "${fullName}".
Analyze the following AST dependency graph telemetry and repository structure:
${JSON.stringify(compactPayload, null, 2)}

Produce a comprehensive, deeply technical architectural review in strict JSON matching the requested schema:
- architecturePattern: Concise name of the architectural style (e.g., "Middleware Pipeline & Modular Router", "Flux-Inspired Reactive Store").
- architectureSummary: 2-3 sentences explaining the repository's structure, module boundaries, and coupling health.
- strengths: Exactly 3 concrete architectural strengths referencing real file paths or metrics from the telemetry.
- risks: Exactly 3 concrete architectural risks or refactoring opportunities referencing real file paths from the telemetry.
- onboardingGuide: A practical guide for a new senior engineer joining the codebase, including overview, entryPoints (real file paths), a 4-step readingOrder with real files/dirs, and 3 keyConventions.`;

    const schemaConfig = {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        required: [
          'architecturePattern',
          'architectureSummary',
          'strengths',
          'risks',
          'onboardingGuide',
        ],
        properties: {
          architecturePattern: { type: Type.STRING },
          architectureSummary: { type: Type.STRING },
          strengths: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              required: ['title', 'description', 'impact'],
              properties: {
                title: { type: Type.STRING },
                description: { type: Type.STRING },
                impact: { type: Type.STRING },
              },
            },
          },
          risks: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              required: [
                'title',
                'severity',
                'description',
                'affectedFiles',
                'recommendation',
              ],
              properties: {
                title: { type: Type.STRING },
                severity: {
                  type: Type.STRING,
                  enum: ['HIGH', 'MEDIUM', 'LOW'],
                },
                description: { type: Type.STRING },
                affectedFiles: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
                recommendation: { type: Type.STRING },
              },
            },
          },
          onboardingGuide: {
            type: Type.OBJECT,
            required: [
              'overview',
              'entryPoints',
              'readingOrder',
              'keyConventions',
            ],
            properties: {
              overview: { type: Type.STRING },
              entryPoints: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              readingOrder: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  required: ['step', 'fileOrDir', 'reason'],
                  properties: {
                    step: { type: Type.INTEGER },
                    fileOrDir: { type: Type.STRING },
                    reason: { type: Type.STRING },
                  },
                },
              },
              keyConventions: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
            },
          },
        },
      },
    };

    const response = await Promise.race([
      ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: schemaConfig,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Gemini API request timed out after 12s')), 12000)
      ),
    ]);

    const rawText = response.text;
    if (!rawText) {
      throw new Error('Empty response from Gemini 2.5 Flash');
    }

    const parsed = JSON.parse(rawText);
    const validated = AiReviewSchema.parse(parsed);
    return validated;
  } catch (err) {
    console.warn(
      `[AI Reviewer] Gemini API fallback triggered for ${fullName}:`,
      err instanceof Error ? err.message : err
    );
    return buildDeterministicFallbackReview(fullName, healthScore, summary);
  }
}
