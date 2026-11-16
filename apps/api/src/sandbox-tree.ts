import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import simpleGit from 'simple-git';
import {
  GITHUB_REPO_REGEX,
  SandboxFilesResponseDto,
  SandboxPackageManager,
  SandboxTargetInfo,
  SandboxTargetTier,
  WebContainerFileSystemTree,
  prisma,
} from '@codexray/shared';

const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  '.turbo',
  '.cache',
  'vendor',
  '.vercel',
  '.husky',
  '.github',
]);

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.avif',
  '.bmp',
  '.tiff',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.mp4',
  '.webm',
  '.mp3',
  '.wav',
  '.ogg',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.7z',
  '.rar',
  '.wasm',
  '.node',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.pyc',
  '.class',
  '.jar',
  '.db',
  '.sqlite',
  '.sqlite3',
  '.lockb',
]);

const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

const NATIVE_BINARY_PACKAGES = new Set([
  'sharp',
  'puppeteer',
  'playwright',
  'better-sqlite3',
  'canvas',
  'sqlite3',
  'bcrypt',
  'grpc',
  'node-pty',
  'serialport',
]);

const DATABASE_PACKAGES = new Set([
  'prisma',
  '@prisma/client',
  'mongoose',
  'pg',
  'typeorm',
  'mysql2',
  'sequelize',
  'kysely',
  'drizzle-orm',
]);

const MAX_TOTAL_BYTES = 15 * 1024 * 1024; // 15 MB cap
const MAX_SINGLE_FILE_BYTES = 512 * 1024; // 512 KB per file cap
const MAX_LOCKFILE_BYTES = 1024 * 1024; // 1 MB lockfile cap
const MAX_SANDBOX_FILES = 500;

function isProbablyBinary(buffer: Buffer): boolean {
  const checkLen = Math.min(buffer.length, 512);
  for (let i = 0; i < checkLen; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * Create a live interactive Node HTTP server script for JS/TS library repositories
 * that do not define their own "dev" or "start" web server script.
 */
function createInteractiveLibraryRunnerScript(
  fullName: string,
  pkgJson: Record<string, unknown>
): string {
  const pkgName = typeof pkgJson.name === 'string' ? pkgJson.name : fullName;
  const pkgVersion =
    typeof pkgJson.version === 'string' ? pkgJson.version : '0.0.0';
  const pkgDesc =
    typeof pkgJson.description === 'string'
      ? pkgJson.description
      : 'Interactive Node.js WebContainer Sandbox';
  const mainEntry =
    typeof pkgJson.main === 'string'
      ? pkgJson.main
      : typeof pkgJson.module === 'string'
      ? pkgJson.module
      : './index.js';

  return `const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const pkgName = ${JSON.stringify(pkgName)};
const pkgVersion = ${JSON.stringify(pkgVersion)};
const pkgDesc = ${JSON.stringify(pkgDesc)};
const mainEntry = ${JSON.stringify(mainEntry)};

let loadedExports = [];
let loadStatus = 'Ready';

try {
  const resolved = path.resolve(__dirname, mainEntry);
  if (fs.existsSync(resolved)) {
    const mod = require(resolved);
    if (typeof mod === 'function' && pkgName === 'express') {
      loadedExports = Object.keys(mod);
      loadStatus = 'Express application factory loaded and active on port ' + PORT;
    } else if (mod && typeof mod === 'object') {
      loadedExports = Object.keys(mod);
      loadStatus = 'Loaded module "' + mainEntry + '" with ' + loadedExports.length + ' export(s)';
    } else if (typeof mod === 'function') {
      loadedExports = [mod.name || 'defaultFunction', ...Object.keys(mod)];
      loadStatus = 'Loaded function export from "' + mainEntry + '"';
    }
  } else {
    loadStatus = 'Source repository mounted cleanly (TypeScript / ESM source tree)';
  }
} catch (err) {
  loadStatus = 'Source tree mounted (' + (err && err.message ? err.message.split('\\n')[0] : 'ESM/TS') + ')';
}

const server = http.createServer((req, res) => {
  if (req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      repository: ${JSON.stringify(fullName)},
      package: pkgName,
      version: pkgVersion,
      runtime: process.version,
      platform: process.platform + ' (' + process.arch + ' WebContainer)',
      status: loadStatus,
      exports: loadedExports,
      timestamp: new Date().toISOString()
    }, null, 2));
    return;
  }

  const fileList = [];
  try {
    for (const item of fs.readdirSync(__dirname)) {
      if (!item.startsWith('__codexray') && item !== 'node_modules') {
        fileList.push(item);
      }
    }
  } catch {}

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(\`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>\${pkgName} - CodeXray Live Sandbox</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      background: #09090b;
      color: #f4f4f5;
      line-height: 1.5;
    }
    .card {
      background: #18181b;
      border: 1px solid #27272a;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 16px;
    }
    .badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 999px;
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.35);
      font-size: 12px;
      font-weight: 700;
    }
    h1 { margin: 8px 0 4px; font-size: 20px; color: #22d3ee; }
    p { margin: 4px 0; color: #a1a1aa; font-size: 13px; }
    .pill-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .pill {
      padding: 4px 10px;
      border-radius: 6px;
      background: #09090b;
      border: 1px solid #27272a;
      color: #67e8f9;
      font-size: 12px;
    }
    a.btn {
      display: inline-block;
      margin-top: 8px;
      padding: 6px 12px;
      border-radius: 6px;
      background: #06b6d4;
      color: #09090b;
      text-decoration: none;
      font-weight: 700;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">● LIVE IN WEBCONTAINER (\${process.version})</span>
    <h1>\${pkgName} <span style="color:#71717a;font-size:14px;">v\${pkgVersion}</span></h1>
    <p>\${pkgDesc}</p>
    <p style="color:#34d399;margin-top:8px;">\${loadStatus}</p>
    <a class="btn" href="/api/status">Test JSON Endpoint (/api/status)</a>
  </div>

  <div class="card">
    <strong style="font-size:12px;text-transform:uppercase;color:#a1a1aa;">Exported Symbols / Runtime Surface</strong>
    <div class="pill-list">
      \${loadedExports.length ? loadedExports.map(e => '<span class="pill">' + e + '</span>').join('') : '<span class="pill">ESM / TypeScript Source Package</span>'}
    </div>
  </div>

  <div class="card">
    <strong style="font-size:12px;text-transform:uppercase;color:#a1a1aa;">Mounted Workspace Files (Edit any file on the left to update!)</strong>
    <div class="pill-list">
      \${fileList.map(f => '<span class="pill">' + f + '</span>').join('')}
    </div>
  </div>
</body>
</html>\`);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[CodeXray Sandbox] Live server listening on http://localhost:' + PORT);
});
`;
}

/**
 * Build a WebContainer-compatible FileSystemTree from a local directory
 */
function buildFileSystemTree(rootDir: string): {
  tree: WebContainerFileSystemTree;
  fileCount: number;
  totalBytes: number;
} {
  let fileCount = 0;
  let totalBytes = 0;

  function walkDir(currentDir: string): WebContainerFileSystemTree {
    const nodeMap: WebContainerFileSystemTree = {};
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return nodeMap;
    }

    // Always process files in the current directory BEFORE recursing into subdirectories
    entries.sort((a, b) => {
      const aIsFile = a.isFile() ? 0 : 1;
      const bIsFile = b.isFile() ? 0 : 1;
      if (aIsFile !== bIsFile) return aIsFile - bIsFile;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (fileCount >= MAX_SANDBOX_FILES || totalBytes >= MAX_TOTAL_BYTES) {
        break;
      }

      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        const childTree = walkDir(fullPath);
        if (Object.keys(childTree).length > 0) {
          nodeMap[entry.name] = {
            directory: childTree,
          };
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) continue;

        let stat: fs.Stats;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          continue;
        }

        if (LOCKFILE_NAMES.has(entry.name)) {
          if (stat.size > MAX_LOCKFILE_BYTES) continue;
        } else if (stat.size > MAX_SINGLE_FILE_BYTES) {
          continue;
        }

        if (totalBytes + stat.size > MAX_TOTAL_BYTES) {
          continue;
        }

        let buf: Buffer;
        try {
          buf = fs.readFileSync(fullPath);
        } catch {
          continue;
        }

        if (isProbablyBinary(buf)) continue;

        const contents = buf.toString('utf-8');
        nodeMap[entry.name] = {
          file: {
            contents,
          },
        };
        fileCount++;
        totalBytes += buf.byteLength;
      }
    }

    return nodeMap;
  }

  const tree = walkDir(rootDir);
  return { tree, fileCount, totalBytes };
}

interface DiscoveredPackageDir {
  dir: string;
  dirTree: WebContainerFileSystemTree;
}

function discoverPackageDirs(
  tree: WebContainerFileSystemTree,
  currentPath = '',
  depth = 0
): DiscoveredPackageDir[] {
  const results: DiscoveredPackageDir[] = [];
  if (depth > 2) return results;

  const pkgNode = tree['package.json'];
  if (pkgNode && 'file' in pkgNode) {
    results.push({ dir: currentPath, dirTree: tree });
  }

  for (const [name, node] of Object.entries(tree)) {
    if ('directory' in node) {
      const nextPath = currentPath ? `${currentPath}/${name}` : name;
      results.push(...discoverPackageDirs(node.directory, nextPath, depth + 1));
    }
  }

  return results;
}

interface RankedTarget {
  info: SandboxTargetInfo;
  dirTree: WebContainerFileSystemTree;
  rankScore: number;
}

function analyzeAndRankPackageTarget(
  fullName: string,
  dir: string,
  dirTree: WebContainerFileSystemTree,
  rootTree: WebContainerFileSystemTree,
  totalDiscoveredCount: number
): RankedTarget {
  const label = dir ? `/${dir}` : '/ (Root)';
  const hasEnvExample = Boolean(
    dirTree['.env.example'] ||
      dirTree['.env.local.example'] ||
      dirTree['.env.template'] ||
      dirTree['.env.sample']
  );

  const pkgNode = dirTree['package.json'];
  if (!pkgNode || !('file' in pkgNode)) {
    return {
      info: {
        dir,
        label,
        framework: 'Unknown',
        tier: 'UNSUPPORTED',
        warnings: ['No package.json found in target directory.'],
        scripts: [],
        hasEnvExample,
      },
      dirTree,
      rankScore: 999,
    };
  }

  let pkgJson: Record<string, unknown> = {};
  try {
    pkgJson = JSON.parse(pkgNode.file.contents) as Record<string, unknown>;
  } catch {
    return {
      info: {
        dir,
        label,
        framework: 'Invalid JSON',
        tier: 'UNSUPPORTED',
        warnings: ['package.json contains invalid JSON syntax.'],
        scripts: [],
        hasEnvExample,
      },
      dirTree,
      rankScore: 999,
    };
  }

  const deps = (pkgJson.dependencies as Record<string, string>) || {};
  const devDeps = (pkgJson.devDependencies as Record<string, string>) || {};
  const allDeps = { ...devDeps, ...deps };
  const rawScripts = (pkgJson.scripts as Record<string, string>) || {};

  const warnings: string[] = [];
  let tier: SandboxTargetTier = 'READY';

  // Detect Framework & base rank score (lower score = higher priority)
  let framework = 'Node.js';
  let rankScore = 45;

  if (allDeps['vite']) {
    framework = 'Vite';
    rankScore = 10;
  } else if (allDeps['next']) {
    framework = 'Next.js';
    rankScore = 14;
  } else if (allDeps['astro']) {
    framework = 'Astro';
    rankScore = 16;
  } else if (allDeps['svelte'] || allDeps['@sveltejs/kit']) {
    framework = 'SvelteKit';
    rankScore = 18;
  } else if (allDeps['nuxt'] || allDeps['vue']) {
    framework = 'Vue / Nuxt';
    rankScore = 19;
  } else if (allDeps['hono']) {
    framework = 'Hono';
    rankScore = 22;
  } else if (allDeps['fastify']) {
    framework = 'Fastify';
    rankScore = 24;
  } else if (allDeps['express'] || pkgJson.name === 'express') {
    framework = 'Express';
    rankScore = 26;
  } else if (allDeps['react-scripts']) {
    framework = 'Create React App';
    rankScore = 52;
  } else if (allDeps['@nestjs/core']) {
    framework = 'NestJS';
    rankScore = 58;
  } else if (allDeps['expo'] || allDeps['react-native']) {
    framework = 'React Native / Expo';
    rankScore = 95;
  } else if (allDeps['react'] || allDeps['react-dom']) {
    framework = 'React';
    rankScore = 32;
  }

  // Prefer dedicated frontend folders (client, frontend, web, apps/web) over backend folders
  const lowerDir = dir.toLowerCase();
  if (
    lowerDir === 'client' ||
    lowerDir === 'frontend' ||
    lowerDir === 'web' ||
    lowerDir.endsWith('/web')
  ) {
    rankScore -= 8;
  } else if (
    lowerDir === 'api' ||
    lowerDir === 'server' ||
    lowerDir === 'backend' ||
    lowerDir.endsWith('/api')
  ) {
    rankScore += 12;
  }

  // 1. Check native C++/OS binaries in runtime dependencies
  const detectedNative: string[] = [];
  for (const depName of Object.keys(deps)) {
    if (NATIVE_BINARY_PACKAGES.has(depName)) {
      detectedNative.push(depName);
    }
  }
  if (detectedNative.length > 0) {
    tier = 'UNSUPPORTED';
    warnings.push(
      `Requires native OS/C++ binary packages (${detectedNative.join(
        ', '
      )}) that cannot compile inside the browser WebAssembly sandbox.`
    );
    rankScore += 200;
  }

  // 2. Check Mobile Expo / React Native without web target
  if (
    tier !== 'UNSUPPORTED' &&
    (allDeps['expo'] || allDeps['react-native']) &&
    !allDeps['react-dom'] &&
    !allDeps['react-native-web']
  ) {
    tier = 'UNSUPPORTED';
    warnings.push(
      'Mobile React Native / Expo target — requires a native mobile simulator or Expo Go.'
    );
    rankScore += 200;
  }

  // 3. Check if this is a monorepo root workspace
  const isRootWorkspace =
    dir === '' &&
    Boolean(pkgJson.workspaces || rootTree['pnpm-workspace.yaml']);
  if (
    tier !== 'UNSUPPORTED' &&
    isRootWorkspace &&
    (totalDiscoveredCount > 1 || Object.keys(devDeps).length > 25) &&
    !dirTree['index.html'] &&
    !dirTree['vite.config.ts'] &&
    !dirTree['vite.config.js']
  ) {
    tier = 'UNSUPPORTED';
    warnings.push(
      `Multi-package monorepo root (${fullName}) — select a specific package target if available, or inspect source files in the Workspace Explorer.`
    );
    rankScore += 180;
  }

  // 4. Pre-Flight Warnings for Database dependencies
  const detectedDb: string[] = [];
  for (const depName of Object.keys(allDeps)) {
    if (DATABASE_PACKAGES.has(depName)) {
      detectedDb.push(depName);
    }
  }
  if (detectedDb.length > 0 && tier !== 'UNSUPPORTED') {
    tier = 'NEEDS_CONFIG';
    warnings.push(
      'Requires external database connection — provide test credentials in Env Vars (.env) before starting.'
    );
    rankScore += 30;
  }

  // 5. Pre-Flight Warning for Legacy Create React App (react-scripts)
  if (allDeps['react-scripts'] && tier !== 'UNSUPPORTED') {
    tier = 'NEEDS_CONFIG';
    warnings.push(
      'Legacy Create React App (webpack) — browser WASM install & build may take 45–60s.'
    );
    rankScore += 15;
  }

  // Sanitize package.json scripts for WebContainers
  const sanitizedScripts = { ...rawScripts };
  delete sanitizedScripts.preinstall;
  delete sanitizedScripts.postinstall;
  delete sanitizedScripts.prepare;

  let defaultScript: string | undefined;
  for (const candidate of ['dev', 'start', 'preview', 'serve']) {
    if (
      typeof sanitizedScripts[candidate] === 'string' &&
      sanitizedScripts[candidate].trim()
    ) {
      defaultScript = candidate;
      break;
    }
  }

  if (!defaultScript && tier !== 'UNSUPPORTED') {
    // Inject interactive Node HTTP showcase server for single-package JS/TS libraries
    const runnerCode = createInteractiveLibraryRunnerScript(fullName, pkgJson);
    dirTree['__codexray_live_runner.js'] = {
      file: { contents: runnerCode },
    };
    sanitizedScripts['dev'] = 'node __codexray_live_runner.js';
    defaultScript = 'dev';
    delete pkgJson.devDependencies;
  }

  const runnableScriptList = Object.keys(sanitizedScripts).filter(
    (k) =>
      k === 'dev' ||
      k === 'start' ||
      k === 'preview' ||
      k === 'serve' ||
      k === 'build'
  );
  const scripts =
    runnableScriptList.length > 0
      ? runnableScriptList
      : Object.keys(sanitizedScripts).slice(0, 5);

  pkgJson.scripts = sanitizedScripts;
  delete pkgJson.engines;

  dirTree['package.json'] = {
    file: {
      contents: JSON.stringify(pkgJson, null, 2),
    },
  };

  return {
    info: {
      dir,
      label,
      framework,
      tier,
      warnings,
      scripts,
      defaultScript,
      hasEnvExample,
    },
    dirTree,
    rankScore,
  };
}

/**
 * Evaluate compatibility, discover & rank all targets, and prepare WebContainer FileSystemTree
 */
export async function getOrBuildSandboxFiles(
  jobId: string
): Promise<SandboxFilesResponseDto> {
  const safeJobId = jobId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeJobId) {
    throw new Error('Invalid jobId');
  }

  const job = await prisma.analysisJob.findUnique({
    where: { id: jobId },
    include: { repository: true },
  });

  if (!job) {
    throw new Error('Analysis job not found');
  }

  const cacheRoot = path.resolve('/tmp/codexray-trees');
  const cacheJsonPath = path.join(cacheRoot, `${safeJobId}-v2.json`);
  const cloneDir = path.join(cacheRoot, safeJobId);

  if (fs.existsSync(cacheJsonPath)) {
    try {
      const raw = await fsp.readFile(cacheJsonPath, 'utf-8');
      return JSON.parse(raw) as SandboxFilesResponseDto;
    } catch {
      // rebuild if cache file corrupted
    }
  }

  const { fullName } = job.repository;
  const repoUrl = `https://github.com/${fullName}`;
  if (!GITHUB_REPO_REGEX.test(repoUrl)) {
    throw new Error(`Invalid repository URL: ${repoUrl}`);
  }

  await fsp.mkdir(cacheRoot, { recursive: true });
  await fsp.rm(cloneDir, { recursive: true, force: true });
  await fsp.mkdir(cloneDir, { recursive: true });

  try {
    const git = simpleGit({ timeout: { block: 60000 } });
    await git.clone(repoUrl, cloneDir, [
      '--depth',
      '1',
      '--single-branch',
      '--no-tags',
    ]);

    const { tree, fileCount, totalBytes } = buildFileSystemTree(cloneDir);

    const discovered = discoverPackageDirs(tree);
    const rootIndexHtml = tree['index.html'];

    // Static HTML fallback when zero package.json files exist in the repository
    if (discovered.length === 0) {
      if (rootIndexHtml && 'file' in rootIndexHtml) {
        const staticServerCode = `const http = require('http');
const fs = require('fs');
const path = require('path');
const server = http.createServer((req, res) => {
  const reqPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(__dirname, reqPath);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.writeHead(200);
    res.end(fs.readFileSync(filePath));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  }
});
server.listen(3000, () => console.log('Static server listening on http://localhost:3000'));`;

        tree['__codexray_static.js'] = {
          file: { contents: staticServerCode },
        };
        tree['package.json'] = {
          file: {
            contents: JSON.stringify(
              {
                name: 'codexray-static-sandbox',
                version: '1.0.0',
                scripts: { dev: 'node __codexray_static.js' },
              },
              null,
              2
            ),
          },
        };

        const staticTarget: SandboxTargetInfo = {
          dir: '',
          label: '/ (Root)',
          framework: 'Static HTML',
          tier: 'READY',
          warnings: [],
          scripts: ['dev'],
          defaultScript: 'dev',
          hasEnvExample: false,
        };

        const dto: SandboxFilesResponseDto = {
          jobId,
          fullName,
          supported: true,
          packageManager: 'npm',
          startScript: 'dev',
          availableTargets: [staticTarget],
          isStaticHtml: true,
          fileCount: fileCount + 2,
          totalBytes,
          tree,
        };
        await fsp.writeFile(cacheJsonPath, JSON.stringify(dto), 'utf-8');
        return dto;
      }

      const unsupportedTarget: SandboxTargetInfo = {
        dir: '',
        label: '/ (Root)',
        framework: 'Non-Node Repository',
        tier: 'UNSUPPORTED',
        warnings: [
          'No package.json or index.html found. The WebContainer browser sandbox runs JavaScript, TypeScript, and Node.js repositories.',
        ],
        scripts: [],
        hasEnvExample: false,
      };

      const unsupportedDto: SandboxFilesResponseDto = {
        jobId,
        fullName,
        supported: false,
        reason: unsupportedTarget.warnings[0],
        packageManager: 'npm',
        availableTargets: [unsupportedTarget],
        fileCount,
        totalBytes,
        tree,
      };
      await fsp.writeFile(cacheJsonPath, JSON.stringify(unsupportedDto), 'utf-8');
      return unsupportedDto;
    }

    // Analyze and smart-rank all discovered package.json targets
    const rankedTargets = discovered.map((d) =>
      analyzeAndRankPackageTarget(
        fullName,
        d.dir,
        d.dirTree,
        tree,
        discovered.length
      )
    );

    const tierWeight: Record<SandboxTargetTier, number> = {
      READY: 0,
      NEEDS_CONFIG: 1,
      UNSUPPORTED: 2,
    };

    rankedTargets.sort((a, b) => {
      const tw = tierWeight[a.info.tier] - tierWeight[b.info.tier];
      if (tw !== 0) return tw;
      return a.rankScore - b.rankScore;
    });

    const availableTargets = rankedTargets.map((r) => r.info);
    const primary = rankedTargets[0].info;
    const isSupported = primary.tier !== 'UNSUPPORTED';

    const hasPnpmLock = Boolean(tree['pnpm-lock.yaml']);
    const hasYarnLock = Boolean(tree['yarn.lock']);
    let packageManager: SandboxPackageManager = 'npm';
    if (hasPnpmLock) packageManager = 'pnpm';
    else if (hasYarnLock) packageManager = 'yarn';

    const resultDto: SandboxFilesResponseDto = {
      jobId,
      fullName,
      supported: isSupported,
      reason: !isSupported
        ? primary.warnings[0] ||
          'No runnable JavaScript/TypeScript web target detected.'
        : undefined,
      packageManager,
      startScript: primary.defaultScript || 'dev',
      workingDir: primary.dir ? primary.dir : undefined,
      availableTargets,
      isStaticHtml: false,
      fileCount,
      totalBytes,
      tree,
    };

    await fsp.writeFile(cacheJsonPath, JSON.stringify(resultDto), 'utf-8');
    return resultDto;
  } finally {
    try {
      await fsp.rm(cloneDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  }
}
