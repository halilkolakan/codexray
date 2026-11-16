import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import {
  AnalysisMetrics,
  GraphData,
  GraphEdge,
  GraphNode,
  HotspotFile,
  RiskLevel,
} from '@codexray/shared';

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  '.turbo',
  '.cache',
  'vendor',
  '.vercel',
  '.output',
  '__snapshots__',
]);

const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const MAX_FILES_CAP = 1500;
const MAX_VISUAL_NODES = 140;

export interface ParsedFileInfo {
  filePath: string; // normalized POSIX relative path, e.g. "src/index.ts"
  absPath: string;
  folder: string;
  loc: number;
  rawImports: string[];
  resolvedImports: string[]; // internal relative paths
  importedBy: string[];
  exports: string[];
}

export interface StructuralSummary {
  fileCount: number;
  totalLoc: number;
  folderTree: string[];
  topHubFiles: HotspotFile[];
  circularDependencies: string[][];
  packageDependencies: Record<string, string>;
  readmeExcerpt: string;
}

export interface AstAnalysisOutput {
  healthScore: number;
  metrics: AnalysisMetrics;
  graph: GraphData;
  structuralSummary: StructuralSummary;
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Walk directory recursively and collect up to MAX_FILES_CAP source files
 */
export function walkRepositoryFiles(
  rootDir: string,
  onProgress?: (count: number) => void
): string[] {
  const results: string[] = [];

  function walk(currentDir: string) {
    if (results.length >= MAX_FILES_CAP) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    // Sort entries deterministically, prioritizing src/lib/app/packages over test/examples
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (results.length >= MAX_FILES_CAP) break;

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) {
          continue;
        }
        walk(path.join(currentDir, entry.name));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
        if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.min.js')) {
          continue;
        }
        results.push(path.join(currentDir, entry.name));
        if (onProgress && results.length % 100 === 0) {
          onProgress(results.length);
        }
      }
    }
  }

  walk(rootDir);
  return results;
}

/**
 * Extract imports and exports from a file using TypeScript Compiler API
 */
export function parseFileAst(absPath: string, content: string): {
  rawImports: string[];
  exports: string[];
  loc: number;
} {
  const lines = content.split(/\r?\n/);
  const loc = lines.filter((line) => line.trim().length > 0).length;

  const rawImports = new Set<string>();
  const exportsSet = new Set<string>();

  const ext = path.extname(absPath).toLowerCase();
  const scriptKind =
    ext === '.tsx'
      ? ts.ScriptKind.TSX
      : ext === '.ts'
      ? ts.ScriptKind.TS
      : ext === '.jsx'
      ? ts.ScriptKind.JSX
      : ts.ScriptKind.JS;

  const sourceFile = ts.createSourceFile(
    absPath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );

  function visit(node: ts.Node) {
    // 1. ES Import: import ... from 'specifier'
    if (ts.isImportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        rawImports.add(node.moduleSpecifier.text);
      }
    }
    // 2. ES Re-export: export ... from 'specifier'
    else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        rawImports.add(node.moduleSpecifier.text);
      }
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          exportsSet.add(el.name.text);
        }
      }
    }
    // 3. Export assignment: export default ...
    else if (ts.isExportAssignment(node)) {
      exportsSet.add('default');
    }
    // 4. Dynamic import('...') or CommonJS require('...')
    else if (ts.isCallExpression(node)) {
      const expr = node.expression;
      const isRequire =
        ts.isIdentifier(expr) && expr.text === 'require' && node.arguments.length === 1;
      const isDynamicImport =
        expr.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length >= 1;

      if (isRequire || isDynamicImport) {
        const arg = node.arguments[0];
        if (ts.isStringLiteral(arg)) {
          rawImports.add(arg.text);
        }
      }
    }
    // 5. Exported functions, classes, interfaces, type aliases, variables
    else if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      const hasExport = node.modifiers?.some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword
      );
      if (hasExport && node.name) {
        exportsSet.add(node.name.text);
      }
    } else if (ts.isVariableStatement(node)) {
      const hasExport = node.modifiers?.some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword
      );
      if (hasExport) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            exportsSet.add(decl.name.text);
          }
        }
      }
    }
    // 6. CommonJS module.exports / exports.xyz
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (ts.isPropertyAccessExpression(node.left)) {
        const obj = node.left.expression;
        const prop = node.left.name.text;
        if (ts.isIdentifier(obj) && obj.text === 'module' && prop === 'exports') {
          exportsSet.add('module.exports');
        } else if (ts.isIdentifier(obj) && obj.text === 'exports') {
          exportsSet.add(prop);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return {
    rawImports: Array.from(rawImports),
    exports: Array.from(exportsSet).slice(0, 25),
    loc,
  };
}

/**
 * Resolve an import specifier to a normalized repo-relative file path if it exists in fileSet
 */
function resolveImportTarget(
  importerRelPath: string,
  specifier: string,
  fileSet: Set<string>,
  extensionlessMap: Map<string, string>
): string | null {
  if (!specifier) return null;

  const cleanSpec = specifier.split('?')[0].split('#')[0];
  const candidates: string[] = [];

  if (cleanSpec.startsWith('.')) {
    const importerDir = path.posix.dirname(importerRelPath);
    const joined = path.posix.normalize(path.posix.join(importerDir, cleanSpec));
    candidates.push(joined);
  } else if (cleanSpec.startsWith('@/') || cleanSpec.startsWith('~/')) {
    const stripped = cleanSpec.slice(2);
    candidates.push(`src/${stripped}`);
    candidates.push(stripped);
  } else if (cleanSpec.startsWith('src/')) {
    candidates.push(cleanSpec);
  } else {
    // External npm package or workspace package
    return null;
  }

  for (const base of candidates) {
    if (fileSet.has(base)) return base;

    // Strip .js extension if TypeScript ESM uses .js imports for .ts files
    const withoutJs = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
    if (extensionlessMap.has(withoutJs)) {
      return extensionlessMap.get(withoutJs)!;
    }

    if (extensionlessMap.has(base)) {
      return extensionlessMap.get(base)!;
    }

    const indexBase = `${base}/index`;
    if (extensionlessMap.has(indexBase)) {
      return extensionlessMap.get(indexBase)!;
    }
  }

  return null;
}

/**
 * Detect circular dependencies in a directed graph using DFS 3-color cycle detection
 */
export function detectCircularDependencies(
  adjacency: Map<string, string[]>
): {
  cycles: string[][];
  nodesInCycles: Set<string>;
  circularEdges: Set<string>;
} {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;

  const color = new Map<string, number>();
  const parentStack: string[] = [];
  const stackIndex = new Map<string, number>();
  const cycles: string[][] = [];
  const seenCycleKeys = new Set<string>();
  const nodesInCycles = new Set<string>();
  const circularEdges = new Set<string>();

  for (const node of adjacency.keys()) {
    color.set(node, WHITE);
  }

  function dfs(u: string) {
    color.set(u, GRAY);
    stackIndex.set(u, parentStack.length);
    parentStack.push(u);

    const neighbors = adjacency.get(u) || [];
    for (const v of neighbors) {
      const vColor = color.get(v) ?? WHITE;
      if (vColor === WHITE) {
        dfs(v);
      } else if (vColor === GRAY) {
        // Found a cycle! Extract cycle from stack
        const startIdx = stackIndex.get(v);
        if (startIdx !== undefined) {
          const cycleNodes = parentStack.slice(startIdx);
          // Normalize cycle key by rotating so lexicographically smallest node is first
          const minNode = [...cycleNodes].sort()[0];
          const minIdx = cycleNodes.indexOf(minNode);
          const normalized = [
            ...cycleNodes.slice(minIdx),
            ...cycleNodes.slice(0, minIdx),
          ];
          const key = normalized.join(' -> ');

          for (let i = 0; i < cycleNodes.length; i++) {
            const from = cycleNodes[i];
            const to = cycleNodes[(i + 1) % cycleNodes.length];
            nodesInCycles.add(from);
            nodesInCycles.add(to);
            circularEdges.add(`${from}->${to}`);
          }

          if (!seenCycleKeys.has(key) && cycles.length < 50) {
            seenCycleKeys.add(key);
            cycles.push([...normalized, normalized[0]]);
          }
        }
      }
    }

    parentStack.pop();
    stackIndex.delete(u);
    color.set(u, BLACK);
  }

  for (const node of adjacency.keys()) {
    if (color.get(node) === WHITE) {
      dfs(node);
    }
  }

  return { cycles, nodesInCycles, circularEdges };
}

/**
 * Compute deterministic 0-100 architecture health score
 */
export function computeHealthScore(params: {
  fileCount: number;
  avgLoc: number;
  cycleCount: number;
  nodesInCyclesCount: number;
  hotspots: HotspotFile[];
}): number {
  const { fileCount, avgLoc, cycleCount, nodesInCyclesCount, hotspots } = params;
  if (fileCount === 0) return 85;

  let score = 100;

  // 1. Circular dependency penalty (up to 35 points)
  const cyclePenalty = Math.min(
    35,
    cycleCount * 6 + Math.round((nodesInCyclesCount / Math.max(1, fileCount)) * 40)
  );
  score -= cyclePenalty;

  // 2. Overly coupled hub files & God files penalty (up to 25 points)
  const godFiles = hotspots.filter(
    (h) => h.loc > 500 || h.couplingScore > 25
  ).length;
  const highCouplingRatio = godFiles / Math.max(1, Math.min(fileCount, 100));
  const couplingPenalty = Math.min(25, Math.round(godFiles * 2.5 + highCouplingRatio * 20));
  score -= couplingPenalty;

  // 3. Average file size penalty (up to 20 points)
  if (avgLoc > 180) {
    const sizePenalty = Math.min(20, Math.round((avgLoc - 180) / 18));
    score -= sizePenalty;
  }

  return Math.max(18, Math.min(100, Math.round(score)));
}

/**
 * Perform full AST & dependency graph analysis on a cloned repository directory
 */
export function analyzeRepositoryAst(
  rootDir: string,
  onProgress?: (msg: string, pct: number) => void
): AstAnalysisOutput {
  const absFiles = walkRepositoryFiles(rootDir, (count) => {
    onProgress?.(`Discovered ${count} source files...`, 28);
  });

  const parsedMap = new Map<string, ParsedFileInfo>();
  const fileSet = new Set<string>();
  const extensionlessMap = new Map<string, string>();
  const languageBreakdown: Record<string, number> = {
    TypeScript: 0,
    TSX: 0,
    JavaScript: 0,
    JSX: 0,
  };

  for (const absPath of absFiles) {
    const relPath = toPosixPath(path.relative(rootDir, absPath));
    fileSet.add(relPath);

    const ext = path.extname(relPath).toLowerCase();
    const withoutExt = relPath.slice(0, relPath.length - ext.length);
    if (!extensionlessMap.has(withoutExt)) {
      extensionlessMap.set(withoutExt, relPath);
    }

    if (ext === '.ts') languageBreakdown.TypeScript++;
    else if (ext === '.tsx') languageBreakdown.TSX++;
    else if (ext === '.js') languageBreakdown.JavaScript++;
    else if (ext === '.jsx') languageBreakdown.JSX++;
  }

  let totalLoc = 0;
  let processed = 0;

  for (const absPath of absFiles) {
    const relPath = toPosixPath(path.relative(rootDir, absPath));
    let content = '';
    try {
      content = fs.readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }

    const { rawImports, exports, loc } = parseFileAst(absPath, content);
    totalLoc += loc;

    const folder = path.posix.dirname(relPath);
    parsedMap.set(relPath, {
      filePath: relPath,
      absPath,
      folder: folder === '.' ? 'root' : folder,
      loc,
      rawImports,
      resolvedImports: [],
      importedBy: [],
      exports,
    });

    processed++;
    if (processed % 150 === 0) {
      const pct = 30 + Math.min(25, Math.round((processed / absFiles.length) * 25));
      onProgress?.(`Parsed AST for ${processed}/${absFiles.length} files...`, pct);
    }
  }

  // Resolve internal imports and build adjacency list
  const adjacency = new Map<string, string[]>();
  for (const [relPath, info] of parsedMap.entries()) {
    const resolvedSet = new Set<string>();
    for (const rawSpec of info.rawImports) {
      const target = resolveImportTarget(relPath, rawSpec, fileSet, extensionlessMap);
      if (target && target !== relPath && parsedMap.has(target)) {
        resolvedSet.add(target);
      }
    }
    const resolvedList = Array.from(resolvedSet);
    info.resolvedImports = resolvedList;
    adjacency.set(relPath, resolvedList);

    for (const target of resolvedList) {
      const targetInfo = parsedMap.get(target);
      if (targetInfo) {
        targetInfo.importedBy.push(relPath);
      }
    }
  }

  onProgress?.('Running DFS cycle detection across module graph...', 58);
  const { cycles, nodesInCycles, circularEdges } =
    detectCircularDependencies(adjacency);

  // Build hotspots & metrics
  const allHotspots: HotspotFile[] = [];
  let maxFanIn = 0;
  let maxFanOut = 0;

  for (const info of parsedMap.values()) {
    const fanIn = info.importedBy.length;
    const fanOut = info.resolvedImports.length;
    if (fanIn > maxFanIn) maxFanIn = fanIn;
    if (fanOut > maxFanOut) maxFanOut = fanOut;

    const inCycle = nodesInCycles.has(info.filePath);
    const couplingScore =
      fanIn * 2 + fanOut * 1.5 + (inCycle ? 10 : 0) + Math.min(10, Math.round(info.loc / 100));

    allHotspots.push({
      filePath: info.filePath,
      loc: info.loc,
      fanIn,
      fanOut,
      couplingScore: Number(couplingScore.toFixed(1)),
      inCycle,
    });
  }

  allHotspots.sort((a, b) => b.couplingScore - a.couplingScore || b.loc - a.loc);

  const fileCount = parsedMap.size;
  const avgLoc = fileCount > 0 ? Math.round(totalLoc / fileCount) : 0;
  const topHotspots = allHotspots.slice(0, 15);
  const mostCoupledFile = topHotspots.length > 0 ? topHotspots[0].filePath : null;

  const healthScore = computeHealthScore({
    fileCount,
    avgLoc,
    cycleCount: cycles.length,
    nodesInCyclesCount: nodesInCycles.size,
    hotspots: allHotspots,
  });

  // Select nodes for React Flow interactive graph (all if <= MAX_VISUAL_NODES, else prioritize cycles + hubs)
  const selectedFilePaths = new Set<string>();
  for (const cycleNode of nodesInCycles) {
    if (selectedFilePaths.size < MAX_VISUAL_NODES) {
      selectedFilePaths.add(cycleNode);
    }
  }
  for (const hotspot of allHotspots) {
    if (selectedFilePaths.size >= MAX_VISUAL_NODES) break;
    selectedFilePaths.add(hotspot.filePath);
  }

  // Group selected nodes by architectural tier / fan-in depth for clean visual layout
  const selectedInfos = Array.from(selectedFilePaths)
    .map((fp) => parsedMap.get(fp)!)
    .filter(Boolean);

  // Determine layer (0 = entry points with fanIn=0, 1..4 = intermediate modules by folder/fanIn, 5 = core utility hubs with high fanIn)
  const layers: ParsedFileInfo[][] = [[], [], [], [], []];
  for (const info of selectedInfos) {
    const fanIn = info.importedBy.length;
    const fanOut = info.resolvedImports.length;
    if (fanIn === 0 && fanOut > 0) {
      layers[0].push(info);
    } else if (fanIn >= 6 && fanOut <= 2) {
      layers[4].push(info);
    } else if (fanIn >= 3) {
      layers[3].push(info);
    } else if (fanOut >= 3) {
      layers[1].push(info);
    } else {
      layers[2].push(info);
    }
  }

  const graphNodes: GraphNode[] = [];
  const X_GAP = 310;
  const Y_GAP = 135;

  let activeCol = 0;
  for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
    const group = layers[layerIdx];
    if (group.length === 0) continue;

    // Sort within layer by folder then filename so related files cluster vertically
    group.sort(
      (a, b) =>
        a.folder.localeCompare(b.folder) || a.filePath.localeCompare(b.filePath)
    );

    const maxPerCol = 10;
    const subCols = Math.ceil(group.length / maxPerCol);

    for (let sc = 0; sc < subCols; sc++) {
      const slice = group.slice(sc * maxPerCol, (sc + 1) * maxPerCol);
      const colHeight = slice.length * Y_GAP;
      const startY = -Math.round(colHeight / 2);

      slice.forEach((info, idx) => {
        const fanIn = info.importedBy.length;
        const fanOut = info.resolvedImports.length;
        const inCycle = nodesInCycles.has(info.filePath);
        const isHub = fanIn >= 4 || fanIn + fanOut >= 7;

        let riskLevel: RiskLevel = 'low';
        if (inCycle) riskLevel = 'critical';
        else if (isHub && info.loc > 300) riskLevel = 'high';
        else if (isHub || info.loc > 250) riskLevel = 'medium';

        graphNodes.push({
          id: info.filePath,
          type: 'fileNode',
          position: {
            x: activeCol * X_GAP,
            y: startY + idx * Y_GAP,
          },
          data: {
            label: path.posix.basename(info.filePath),
            filePath: info.filePath,
            folder: info.folder,
            loc: info.loc,
            fanIn,
            fanOut,
            inCycle,
            isHub,
            riskLevel,
            imports: info.resolvedImports,
            importedBy: info.importedBy,
            exports: info.exports,
          },
        });
      });

      activeCol++;
    }
  }

  const graphEdges: GraphEdge[] = [];
  for (const sourcePath of selectedFilePaths) {
    const info = parsedMap.get(sourcePath);
    if (!info) continue;
    for (const targetPath of info.resolvedImports) {
      if (!selectedFilePaths.has(targetPath)) continue;
      const edgeKey = `${sourcePath}->${targetPath}`;
      const isCircular = circularEdges.has(edgeKey);
      graphEdges.push({
        id: `e:${edgeKey}`,
        source: sourcePath,
        target: targetPath,
        animated: isCircular,
        data: {
          isCircular,
        },
      });
    }
  }

  // Extract package.json dependencies & folder tree for Gemini context
  let packageDependencies: Record<string, string> = {};
  const pkgJsonPath = path.join(rootDir, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      packageDependencies = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
      };
    } catch {
      // ignore invalid package.json
    }
  }

  let readmeExcerpt = '';
  for (const readmeName of ['README.md', 'readme.md', 'Readme.md']) {
    const p = path.join(rootDir, readmeName);
    if (fs.existsSync(p)) {
      try {
        readmeExcerpt = fs.readFileSync(p, 'utf-8').slice(0, 1500);
        break;
      } catch {
        // ignore
      }
    }
  }

  const foldersSet = new Set<string>();
  for (const info of parsedMap.values()) {
    if (info.folder !== 'root') {
      const parts = info.folder.split('/');
      foldersSet.add(parts.slice(0, 3).join('/'));
    }
  }

  const metrics: AnalysisMetrics = {
    fileCount,
    totalLoc,
    avgLoc,
    circularDependencyCount: cycles.length,
    circularDependencies: cycles,
    maxFanIn,
    maxFanOut,
    mostCoupledFile,
    hotspotFiles: topHotspots,
    languageBreakdown,
  };

  return {
    healthScore,
    metrics,
    graph: {
      nodes: graphNodes,
      edges: graphEdges,
    },
    structuralSummary: {
      fileCount,
      totalLoc,
      folderTree: Array.from(foldersSet).sort().slice(0, 40),
      topHubFiles: topHotspots.slice(0, 10),
      circularDependencies: cycles.slice(0, 10),
      packageDependencies,
      readmeExcerpt,
    },
  };
}
