'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { FileSystemTree, WebContainer } from '@webcontainer/api';
import { io, Socket } from 'socket.io-client';
import {
  SandboxFilesResponseDto,
  SandboxTargetInfo,
  WebContainerFileSystemTree,
  DockerStatusResponseDto,
  DockerSandboxStartResponseDto,
  DockerSandboxLogEvent,
  DockerSandboxReadyEvent,
} from '@codexray/shared';
import {
  getWebContainerSingleton,
  resetAndMountWorkspace,
  setActiveServerProcess,
  stripAnsiCodes,
} from '@/lib/webcontainer-singleton';
import {
  Play,
  RotateCw,
  Folder,
  FolderOpen,
  FileCode2,
  Terminal,
  Globe,
  ExternalLink,
  CheckCircle2,
  Loader2,
  AlertTriangle,
  Cpu,
  Save,
  Sparkles,
  ChevronRight,
  ChevronDown,
  ShieldAlert,
  Columns,
  Maximize2,
  Minimize2,
  Sliders,
  X,
  LayoutPanelLeft,
  Container,
  Square,
  Database,
} from 'lucide-react';

export type SandboxBootStage =
  | 'IDLE'
  | 'BOOTING_WASM'
  | 'INSTALLING_DEPS'
  | 'STARTING_SERVER'
  | 'SERVER_READY'
  | 'ERROR';

export type SandboxLayoutMode = 'IDE_SPLIT' | 'PREVIEW_FOCUS' | 'FULLSCREEN';
export type SandboxRuntimeMode = 'WASM' | 'DOCKER';

interface FlatFileItem {
  path: string;
  name: string;
  depth: number;
  isDir: boolean;
}

const FATAL_WASM_OUTPUT_PATTERNS = [
  /app crashed/i,
  /ECONNREFUSED/i,
  /MODULE_NOT_FOUND/i,
  /Cannot find module/i,
  /\bnot found\b/i,
  /Error: P1001/i,
  /PrismaClientInitializationError/i,
];

function flattenFileTree(
  tree: WebContainerFileSystemTree,
  parentPath = '',
  depth = 0
): FlatFileItem[] {
  const items: FlatFileItem[] = [];
  const entries = Object.entries(tree).sort(([aName, aNode], [bName, bNode]) => {
    const aIsDir = 'directory' in aNode;
    const bIsDir = 'directory' in bNode;
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return aName.localeCompare(bName);
  });

  for (const [name, node] of entries) {
    const fullPath = parentPath ? `${parentPath}/${name}` : name;
    if ('directory' in node) {
      items.push({ path: fullPath, name, depth, isDir: true });
      items.push(...flattenFileTree(node.directory, fullPath, depth + 1));
    } else {
      items.push({ path: fullPath, name, depth, isDir: false });
    }
  }
  return items;
}

function readFileFromTree(
  tree: WebContainerFileSystemTree,
  targetPath: string
): string | null {
  const parts = targetPath.split('/').filter(Boolean);
  let current: WebContainerFileSystemTree = tree;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const node = current[part];
    if (!node) return null;
    if (i === parts.length - 1) {
      return 'file' in node ? node.file.contents : null;
    }
    if ('directory' in node) {
      current = node.directory;
    } else {
      return null;
    }
  }
  return null;
}

function writeFileInTree(
  tree: WebContainerFileSystemTree,
  targetPath: string,
  newContents: string
): void {
  const parts = targetPath.split('/').filter(Boolean);
  let current: WebContainerFileSystemTree = tree;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i === parts.length - 1) {
      current[part] = {
        file: {
          contents: newContents,
        },
      };
      return;
    }
    const existing = current[part];
    if (existing && 'directory' in existing) {
      current = existing.directory;
    } else {
      const nextDir: WebContainerFileSystemTree = {};
      current[part] = { directory: nextDir };
      current = nextDir;
    }
  }
}

interface LiveSandboxPanelProps {
  jobId: string;
  fullName: string;
  apiUrl: string;
}

export function LiveSandboxPanel({
  jobId,
  fullName,
  apiUrl,
}: LiveSandboxPanelProps) {
  const [loadingTree, setLoadingTree] = useState(true);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [sandboxData, setSandboxData] = useState<SandboxFilesResponseDto | null>(
    null
  );

  // Target & Script selection
  const [selectedTargetDir, setSelectedTargetDir] = useState<string>('');
  const [selectedScript, setSelectedScript] = useState<string>('dev');

  // Hybrid Runtime Mode: WASM vs DOCKER
  const [dockerAvailable, setDockerAvailable] = useState<boolean>(false);
  const [dockerStatusChecked, setDockerStatusChecked] = useState<boolean>(false);
  const [runtimeMode, setRuntimeMode] = useState<SandboxRuntimeMode>('WASM');
  const [activeDockerSandboxId, setActiveDockerSandboxId] = useState<string | null>(
    null
  );
  const [activeDockerDbType, setActiveDockerDbType] = useState<
    'postgres' | 'mongo' | 'none'
  >('none');
  const [stoppingDocker, setStoppingDocker] = useState<boolean>(false);
  const [lastCrashReason, setLastCrashReason] = useState<string | null>(null);

  // Layout mode switcher: IDE_SPLIT | PREVIEW_FOCUS | FULLSCREEN
  const [layoutMode, setLayoutMode] = useState<SandboxLayoutMode>('IDE_SPLIT');

  // File Explorer & Code Editor state
  const [selectedFilePath, setSelectedFilePath] = useState<string>('package.json');
  const [editorContent, setEditorContent] = useState<string>('');
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const [hmrSynced, setHmrSynced] = useState(false);

  // Env Vars (.env) Drawer / Modal state
  const [envModalOpen, setEnvModalOpen] = useState(false);
  const [envDraftContent, setEnvDraftContent] = useState('');
  const [envSavedToast, setEnvSavedToast] = useState(false);

  // Sandbox runtime state
  const [stage, setStage] = useState<SandboxBootStage>('IDLE');
  const [terminalLines, setTerminalLines] = useState<string[]>([]);
  const [ports, setPorts] = useState<
    Array<{ port: number; url: string; label?: string }>
  >([]);
  const [activePort, setActivePort] = useState<number | null>(null);
  const [iframeKey, setIframeKey] = useState(0);

  const wcRef = useRef<WebContainer | null>(null);
  const terminalPreRef = useRef<HTMLPreElement | null>(null);
  const envDialogRef = useRef<HTMLDialogElement | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const activeDockerSandboxIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeDockerSandboxIdRef.current = activeDockerSandboxId;
  }, [activeDockerSandboxId]);

  const appendTerminal = useCallback((chunk: string) => {
    const cleaned = stripAnsiCodes(chunk);
    if (!cleaned.trim()) return;
    const lines = cleaned.split('\n');
    setTerminalLines((prev) => [...prev.slice(-300), ...lines]);
  }, []);

  useEffect(() => {
    if (terminalPreRef.current) {
      terminalPreRef.current.scrollTop = terminalPreRef.current.scrollHeight;
    }
  }, [terminalLines]);

  // Check Docker Engine status on mount
  useEffect(() => {
    let cancelled = false;
    fetch(`${apiUrl}/api/sandbox/docker/status`)
      .then((res) => res.json() as Promise<DockerStatusResponseDto>)
      .then((data) => {
        if (cancelled) return;
        setDockerAvailable(Boolean(data.available));
        setDockerStatusChecked(true);
      })
      .catch(() => {
        if (cancelled) return;
        setDockerAvailable(false);
        setDockerStatusChecked(true);
      });

    return () => {
      cancelled = true;
    };
  }, [apiUrl]);

  // Cleanup active Docker container & socket on unmount
  useEffect(() => {
    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      const runningId = activeDockerSandboxIdRef.current;
      if (runningId) {
        fetch(`${apiUrl}/api/sandbox/docker/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sandboxId: runningId }),
        }).catch(() => {});
      }
    };
  }, [apiUrl]);

  const availableTargets: SandboxTargetInfo[] = useMemo(() => {
    return sandboxData?.availableTargets || [];
  }, [sandboxData]);

  const currentTarget: SandboxTargetInfo | null = useMemo(() => {
    if (!availableTargets.length) return null;
    return (
      availableTargets.find((t) => t.dir === selectedTargetDir) ||
      availableTargets[0]
    );
  }, [availableTargets, selectedTargetDir]);

  // Auto-recommend / switch to Docker Sandbox when Docker is available and target has NEEDS_CONFIG
  useEffect(() => {
    if (
      dockerStatusChecked &&
      dockerAvailable &&
      currentTarget?.tier === 'NEEDS_CONFIG' &&
      stage === 'IDLE'
    ) {
      setRuntimeMode('DOCKER');
    }
  }, [dockerStatusChecked, dockerAvailable, currentTarget, stage]);

  const envFilePath = useMemo(() => {
    return selectedTargetDir ? `${selectedTargetDir}/.env` : '.env';
  }, [selectedTargetDir]);

  // Helper to auto-provision .env from .env.example if .env does not exist
  const ensureEnvFromExample = useCallback(
    (tree: WebContainerFileSystemTree, targetDir: string): boolean => {
      const prefix = targetDir ? `${targetDir}/` : '';
      const dotEnvPath = `${prefix}.env`;
      const existingEnv = readFileFromTree(tree, dotEnvPath);
      if (existingEnv !== null) return false;

      const exampleCandidates = [
        `${prefix}.env.example`,
        `${prefix}.env.local.example`,
        `${prefix}.env.template`,
        `${prefix}.env.sample`,
      ];

      for (const candidate of exampleCandidates) {
        const exampleContent = readFileFromTree(tree, candidate);
        if (exampleContent !== null) {
          writeFileInTree(tree, dotEnvPath, exampleContent);
          return true;
        }
      }
      return false;
    },
    []
  );

  // Fetch FileSystemTree from GET /api/jobs/:jobId/files
  useEffect(() => {
    let cancelled = false;
    setLoadingTree(true);
    setTreeError(null);
    setStage('IDLE');
    setPorts([]);
    setActivePort(null);
    setTerminalLines([]);
    setLastCrashReason(null);

    fetch(`${apiUrl}/api/jobs/${jobId}/files`)
      .then(async (res) => {
        if (!res.ok) {
          const errData = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(errData.error || `HTTP ${res.status}`);
        }
        return res.json() as Promise<SandboxFilesResponseDto>;
      })
      .then((data) => {
        if (cancelled) return;

        const initialTarget = data.availableTargets?.[0];
        const initDir =
          initialTarget?.dir !== undefined
            ? initialTarget.dir
            : data.workingDir || '';
        const initScript =
          initialTarget?.defaultScript || data.startScript || 'dev';

        ensureEnvFromExample(data.tree, initDir);

        setSandboxData(data);
        setSelectedTargetDir(initDir);
        setSelectedScript(initScript);

        const flat = flattenFileTree(data.tree).filter((i) => !i.isDir);
        const prefix = initDir ? `${initDir}/` : '';
        const preferred =
          flat.find((f) => f.path === `${prefix}src/App.tsx`) ||
          flat.find((f) => f.path === `${prefix}src/App.jsx`) ||
          flat.find((f) => f.path === `${prefix}src/App.js`) ||
          flat.find((f) => f.path === `${prefix}src/index.ts`) ||
          flat.find((f) => f.path === `${prefix}src/index.js`) ||
          flat.find((f) => f.path === `${prefix}index.js`) ||
          flat.find((f) => f.path === `${prefix}package.json`) ||
          flat.find((f) => f.path === 'package.json') ||
          flat[0];

        if (preferred) {
          setSelectedFilePath(preferred.path);
          setEditorContent(readFileFromTree(data.tree, preferred.path) ?? '');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setTreeError(
          err instanceof Error ? err.message : 'Failed to load repository files'
        );
      })
      .finally(() => {
        if (!cancelled) setLoadingTree(false);
      });

    return () => {
      cancelled = true;
    };
  }, [jobId, apiUrl, ensureEnvFromExample]);

  const handleTargetChange = (newDir: string) => {
    setSelectedTargetDir(newDir);
    setLastCrashReason(null);
    if (!sandboxData) return;

    ensureEnvFromExample(sandboxData.tree, newDir);

    const tgt = availableTargets.find((t) => t.dir === newDir);
    if (tgt) {
      setSelectedScript(tgt.defaultScript || tgt.scripts[0] || 'dev');
      if (dockerAvailable && tgt.tier === 'NEEDS_CONFIG' && stage === 'IDLE') {
        setRuntimeMode('DOCKER');
      }
    }

    const prefix = newDir ? `${newDir}/` : '';
    const pkgPath = `${prefix}package.json`;
    if (readFileFromTree(sandboxData.tree, pkgPath) !== null) {
      setSelectedFilePath(pkgPath);
      setEditorContent(readFileFromTree(sandboxData.tree, pkgPath) ?? '');
    }
  };

  const openEnvModal = () => {
    if (!sandboxData) return;
    ensureEnvFromExample(sandboxData.tree, selectedTargetDir);
    const currentEnv =
      readFileFromTree(sandboxData.tree, envFilePath) ??
      `# Environment Variables for ${selectedTargetDir || 'root'}\nPORT=3000\n`;
    setEnvDraftContent(currentEnv);
    setEnvModalOpen(true);
    setTimeout(() => {
      if (envDialogRef.current && !envDialogRef.current.open) {
        envDialogRef.current.showModal();
      }
    }, 0);
  };

  const closeEnvModal = () => {
    if (envDialogRef.current?.open) {
      envDialogRef.current.close();
    }
    setEnvModalOpen(false);
  };

  const saveEnvChanges = async (restartAfterSave = false) => {
    if (!sandboxData) return;
    writeFileInTree(sandboxData.tree, envFilePath, envDraftContent);
    if (selectedFilePath === envFilePath) {
      setEditorContent(envDraftContent);
    }

    if (wcRef.current) {
      try {
        await wcRef.current.fs.writeFile(`/${envFilePath}`, envDraftContent);
        appendTerminal(`[CodeXray Sandbox] Updated /${envFilePath} in WebContainer FS.`);
      } catch {
        // ignore if not mounted yet
      }
    }

    setEnvSavedToast(true);
    setTimeout(() => setEnvSavedToast(false), 1800);

    if (restartAfterSave) {
      closeEnvModal();
      void bootAndRunSandbox();
    }
  };

  const flatItems = useMemo(() => {
    if (!sandboxData) return [];
    return flattenFileTree(sandboxData.tree);
  }, [sandboxData]);

  const visibleItems = useMemo(() => {
    return flatItems.filter((item) => {
      for (const collapsed of collapsedDirs) {
        if (item.path !== collapsed && item.path.startsWith(`${collapsed}/`)) {
          return false;
        }
      }
      return true;
    });
  }, [flatItems, collapsedDirs]);

  const handleSelectFile = (filePath: string) => {
    if (!sandboxData) return;
    setSelectedFilePath(filePath);
    const content = readFileFromTree(sandboxData.tree, filePath);
    setEditorContent(content ?? '');
  };

  const toggleDir = (dirPath: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  };

  const handleEditorChange = async (newValue: string) => {
    setEditorContent(newValue);
    if (sandboxData && selectedFilePath) {
      writeFileInTree(sandboxData.tree, selectedFilePath, newValue);
    }

    if (wcRef.current && selectedFilePath && runtimeMode === 'WASM') {
      try {
        await wcRef.current.fs.writeFile(`/${selectedFilePath}`, newValue);
        setHmrSynced(true);
        setTimeout(() => setHmrSynced(false), 1200);
      } catch {
        // ignore write error before mount
      }
    }
  };

  const isCurrentTargetRunnable = useMemo(() => {
    if (currentTarget) {
      return currentTarget.tier !== 'UNSUPPORTED';
    }
    return Boolean(sandboxData?.supported);
  }, [currentTarget, sandboxData]);

  // Stop active Docker Sandbox container
  const stopActiveDockerSandbox = useCallback(
    async (silent = false) => {
      const idToStop = activeDockerSandboxIdRef.current;
      if (!idToStop) return;

      if (!silent) {
        setStoppingDocker(true);
        appendTerminal(
          `[CodeXray Docker Runner] Stopping container & cleaning up sidecars (${idToStop})...`
        );
      }

      if (socketRef.current) {
        socketRef.current.emit('unsubscribe:sandbox', idToStop);
        socketRef.current.disconnect();
        socketRef.current = null;
      }

      try {
        await fetch(`${apiUrl}/api/sandbox/docker/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sandboxId: idToStop }),
        });
      } catch {
        // ignore network errors on stop
      } finally {
        setActiveDockerSandboxId(null);
        setActiveDockerDbType('none');
        setStoppingDocker(false);
        if (!silent) {
          setStage('IDLE');
          setPorts([]);
          setActivePort(null);
          appendTerminal(
            `[CodeXray Docker Runner] 🛑 Container & ephemeral network removed cleanly.`
          );
        }
      }
    },
    [apiUrl, appendTerminal]
  );

  // Boot & Run via Docker Ephemeral Sandbox Runner
  const bootAndRunDockerSandbox = async () => {
    if (!sandboxData || !isCurrentTargetRunnable) return;

    try {
      if (activeDockerSandboxIdRef.current) {
        await stopActiveDockerSandbox(true);
      }

      setLastCrashReason(null);
      setStage('BOOTING_WASM');
      setPorts([]);
      setActivePort(null);
      setTerminalLines([
        `[CodeXray Docker Runner] Initializing isolated Docker container for ${fullName}...`,
      ]);

      ensureEnvFromExample(sandboxData.tree, selectedTargetDir);
      const currentEnvContent =
        readFileFromTree(sandboxData.tree, envFilePath) ?? undefined;
      const scriptToRun =
        selectedScript ||
        currentTarget?.defaultScript ||
        sandboxData.startScript ||
        'dev';

      const res = await fetch(`${apiUrl}/api/sandbox/docker/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId,
          workingDir: selectedTargetDir,
          script: scriptToRun,
          envVars: currentEnvContent,
        }),
      });

      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }

      const startInfo = (await res.json()) as DockerSandboxStartResponseDto;
      setActiveDockerSandboxId(startInfo.sandboxId);
      setActiveDockerDbType(
        startInfo.hasPostgresSidecar
          ? 'postgres'
          : startInfo.hasMongoSidecar
          ? 'mongo'
          : 'none'
      );

      const socket = io(apiUrl, {
        transports: ['websocket', 'polling'],
      });
      socketRef.current = socket;

      socket.on('connect', () => {
        socket.emit('subscribe:sandbox', startInfo.sandboxId);
      });

      socket.on('sandbox:log', (evt: DockerSandboxLogEvent) => {
        if (evt.sandboxId !== startInfo.sandboxId) return;
        appendTerminal(evt.line);
        setStage((prev) => {
          if (prev === 'SERVER_READY' && evt.stage !== 'ERROR') {
            return prev;
          }
          return evt.stage;
        });
        if (evt.stage === 'ERROR') {
          setLastCrashReason(evt.line);
        }
      });

      socket.on('sandbox:ready', (evt: DockerSandboxReadyEvent) => {
        if (evt.sandboxId !== startInfo.sandboxId) return;
        const sameOriginProxyUrl = `/docker-preview/${evt.sandboxId}/`;
        setPorts([
          {
            port: evt.hostPort,
            url: sameOriginProxyUrl,
            label: `:${evt.hostPort} (Proxy)`,
          },
          {
            port: evt.hostPort + 10000,
            url: evt.previewUrl,
            label: `:${evt.hostPort} (Direct)`,
          },
        ]);
        setActivePort(evt.hostPort);
        setStage('SERVER_READY');
      });
    } catch (err) {
      setStage('ERROR');
      const msg = err instanceof Error ? err.message : String(err);
      setLastCrashReason(msg);
      appendTerminal(`[Docker Sandbox Error] ${msg}`);
    }
  };

  // Boot & Run via Browser WASM (@webcontainer/api)
  const bootAndRunWasmSandbox = async () => {
    if (!sandboxData || !isCurrentTargetRunnable) return;

    try {
      if (activeDockerSandboxIdRef.current) {
        await stopActiveDockerSandbox(true);
      }

      setLastCrashReason(null);
      setStage('BOOTING_WASM');
      setPorts([]);
      setActivePort(null);
      setTerminalLines([
        `[CodeXray Sandbox] Initializing WebContainer WASM runtime for ${fullName}...`,
      ]);

      // Auto-provision .env from .env.example if needed
      const autoCreatedEnv = ensureEnvFromExample(
        sandboxData.tree,
        selectedTargetDir
      );

      const wc = await getWebContainerSingleton();
      wcRef.current = wc;

      let serverReachedReady = false;

      wc.on('server-ready', (port, url) => {
        serverReachedReady = true;
        appendTerminal(
          `[WebContainer] 🚀 Server Ready on port ${port} -> ${url}`
        );
        setPorts((prev) => {
          const filtered = prev.filter((p) => p.port !== port);
          return [...filtered, { port, url, label: `:${port}` }];
        });
        setActivePort((prev) => prev ?? port);
        setStage('SERVER_READY');
      });

      wc.on('error', (err) => {
        appendTerminal(`[WebContainer Error] ${err.message}`);
      });

      appendTerminal(
        `[CodeXray Sandbox] Mounting ${sandboxData.fileCount} files (${Math.round(
          sandboxData.totalBytes / 1024
        )} KB) into virtual file system...`
      );
      await resetAndMountWorkspace(
        wc,
        sandboxData.tree as unknown as FileSystemTree
      );

      const prefix = selectedTargetDir ? `${selectedTargetDir}/` : '';
      if (
        autoCreatedEnv ||
        (readFileFromTree(sandboxData.tree, `${prefix}.env`) !== null &&
          (readFileFromTree(sandboxData.tree, `${prefix}.env.example`) !==
            null ||
            readFileFromTree(
              sandboxData.tree,
              `${prefix}.env.local.example`
            ) !== null))
      ) {
        appendTerminal(
          `[CodeXray Sandbox] Auto-created .env from .env.example`
        );
      }

      const spawnCwd = selectedTargetDir ? `/${selectedTargetDir}` : '/';

      setStage('INSTALLING_DEPS');
      appendTerminal(
        `$ ${
          selectedTargetDir ? `cd ${selectedTargetDir} && ` : ''
        }npm install --legacy-peer-deps --no-audit --no-fund --prefer-offline`
      );

      const installProc = await wc.spawn(
        'npm',
        [
          'install',
          '--legacy-peer-deps',
          '--no-audit',
          '--no-fund',
          '--prefer-offline',
        ],
        {
          cwd: spawnCwd,
          env: { BROWSER: 'none' },
        }
      );

      installProc.output.pipeTo(
        new WritableStream({
          write(chunk) {
            appendTerminal(chunk);
          },
        })
      );

      const installExit = await installProc.exit;
      if (installExit !== 0) {
        setStage('ERROR');
        const reason = `npm install failed with exit code ${installExit}.`;
        setLastCrashReason(reason);
        appendTerminal(`[Sandbox Error] ${reason} Halting startup.`);
        return;
      }
      appendTerminal(`[CodeXray Sandbox] ✅ Dependencies installed.`);

      // If prisma/schema.prisma exists in workingDir, run npx prisma generate before starting dev server
      const hasPrismaSchema =
        readFileFromTree(sandboxData.tree, `${prefix}prisma/schema.prisma`) !==
        null;
      if (hasPrismaSchema) {
        appendTerminal(
          `$ ${
            selectedTargetDir ? `(in /${selectedTargetDir}) ` : ''
          }npx prisma generate`
        );
        const prismaProc = await wc.spawn('npx', ['prisma', 'generate'], {
          cwd: spawnCwd,
          env: { BROWSER: 'none' },
        });
        prismaProc.output.pipeTo(
          new WritableStream({
            write(chunk) {
              appendTerminal(chunk);
            },
          })
        );
        const prismaExit = await prismaProc.exit;
        if (prismaExit === 0) {
          appendTerminal(`[CodeXray Sandbox] ✅ Prisma Client generated.`);
        } else {
          appendTerminal(
            `[CodeXray Sandbox] ⚠️ npx prisma generate exited with code ${prismaExit}.`
          );
        }
      }

      setStage('STARTING_SERVER');
      const scriptToRun =
        selectedScript ||
        currentTarget?.defaultScript ||
        sandboxData.startScript ||
        'dev';
      appendTerminal(
        `$ ${
          selectedTargetDir ? `(in /${selectedTargetDir}) ` : ''
        }npm run ${scriptToRun}`
      );

      const serverProc = await wc.spawn('npm', ['run', scriptToRun], {
        cwd: spawnCwd,
        env: { BROWSER: 'none' },
      });
      setActiveServerProcess(serverProc);

      serverProc.output.pipeTo(
        new WritableStream({
          write(chunk) {
            appendTerminal(chunk);
            const cleaned = stripAnsiCodes(chunk);
            if (
              !serverReachedReady &&
              FATAL_WASM_OUTPUT_PATTERNS.some((pattern) => pattern.test(cleaned))
            ) {
              const matchedLine =
                cleaned
                  .split('\n')
                  .find((l) =>
                    FATAL_WASM_OUTPUT_PATTERNS.some((p) => p.test(l))
                  )
                  ?.trim() || 'Application server crashed or failed to start.';
              setStage('ERROR');
              setLastCrashReason(matchedLine);
            }
          },
        })
      );

      void serverProc.exit.then((exitCode) => {
        if (!serverReachedReady || exitCode !== 0) {
          setStage('ERROR');
          setLastCrashReason(
            (prev) =>
              prev ||
              `Dev server process exited prematurely with code ${exitCode} inside Browser WASM.`
          );
          appendTerminal(
            `[Sandbox Error] Dev server exited with code ${exitCode}.`
          );
        }
      });
    } catch (err) {
      setStage('ERROR');
      const msg = err instanceof Error ? err.message : String(err);
      setLastCrashReason(msg);
      appendTerminal(`[Sandbox Fatal Error] ${msg}`);
    }
  };

  const bootAndRunSandbox = async (overrideMode?: SandboxRuntimeMode) => {
    const modeToUse = overrideMode || runtimeMode;
    if (overrideMode && overrideMode !== runtimeMode) {
      setRuntimeMode(overrideMode);
    }
    if (modeToUse === 'DOCKER') {
      await bootAndRunDockerSandbox();
    } else {
      await bootAndRunWasmSandbox();
    }
  };

  const activePreviewUrl = useMemo(() => {
    if (!activePort) return ports[0]?.url || null;
    return ports.find((p) => p.port === activePort)?.url || ports[0]?.url || null;
  }, [ports, activePort]);

  if (loadingTree) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-12 flex flex-col items-center justify-center gap-3 text-center min-h-[700px]">
        <Loader2
          className="w-8 h-8 text-cyan-400 animate-spin"
          aria-hidden="true"
        />
        <p className="font-mono text-sm font-semibold text-zinc-200">
          Preparing Hybrid Sandbox FileSystemTree &amp; Pre-Flight Diagnostics for{' '}
          {fullName}...
        </p>
        <p className="font-mono text-xs text-zinc-400">
          Scanning package targets, framework tiers, Docker engine status, and
          environment templates
        </p>
      </div>
    );
  }

  if (treeError || !sandboxData) {
    return (
      <div className="rounded-2xl border border-red-500/40 bg-red-950/30 p-6 text-red-200 flex items-center gap-3 font-mono text-xs">
        <AlertTriangle className="w-5 h-5 text-red-400 shrink-0" aria-hidden="true" />
        <span>Failed to load sandbox file tree: {treeError}</span>
      </div>
    );
  }

  const tierBadge =
    currentTarget?.tier === 'READY' ? (
      <span className="px-2.5 py-0.5 text-[10px] font-mono font-bold uppercase rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/40">
        ● Ready ({currentTarget.framework})
      </span>
    ) : currentTarget?.tier === 'NEEDS_CONFIG' ? (
      <span className="px-2.5 py-0.5 text-[10px] font-mono font-bold uppercase rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/40">
        ▲ Needs Config ({currentTarget.framework})
      </span>
    ) : (
      <span className="px-2.5 py-0.5 text-[10px] font-mono font-bold uppercase rounded-full bg-rose-500/15 text-rose-300 border border-rose-500/40">
        ■ Explorer Only ({currentTarget?.framework || 'Unsupported'})
      </span>
    );

  const isDockerRecommended =
    dockerAvailable && currentTarget?.tier === 'NEEDS_CONFIG';

  return (
    <div className="w-full max-w-[1600px] mx-auto space-y-4">
      {/* Top Sandbox Control, Hybrid Runtime Switcher, Target Selector & Layout Mode Bar */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/85 p-4 flex flex-col gap-3.5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          {/* Left: Title & Tier Badge */}
          <div className="flex flex-wrap items-center gap-3">
            <div
              className={`p-2 rounded-xl border ${
                runtimeMode === 'DOCKER'
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                  : 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400'
              }`}
            >
              {runtimeMode === 'DOCKER' ? (
                <Container className="w-5 h-5" aria-hidden="true" />
              ) : (
                <Cpu className="w-5 h-5" aria-hidden="true" />
              )}
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-mono text-sm font-bold text-zinc-100">
                  {runtimeMode === 'DOCKER'
                    ? 'Docker Ephemeral Sandbox Runner'
                    : 'WebContainer Live Browser Sandbox'}
                </h3>
                <span className="px-2 py-0.5 text-[10px] font-mono rounded bg-zinc-800 text-zinc-300">
                  {sandboxData.fileCount} files •{' '}
                  {Math.round(sandboxData.totalBytes / 1024)} KB
                </span>
                {tierBadge}
                {activeDockerSandboxId && activeDockerDbType !== 'none' && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono font-bold uppercase rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/40">
                    <Database className="w-3 h-3" aria-hidden="true" />
                    Auto {activeDockerDbType} Sidecar
                  </span>
                )}
              </div>
              <p className="text-xs text-zinc-400 font-mono mt-0.5">
                {runtimeMode === 'DOCKER'
                  ? 'Isolated node:20-alpine container • Automatic Postgres/MongoDB sidecars & Prisma push'
                  : 'Zero-server-cost Node.js WebAssembly runtime • Instant HMR & Auto .env Provisioning'}
              </p>
            </div>
          </div>

          {/* Right: Hybrid Runtime Switcher, Layout Mode Switcher, Env Vars (.env), & Boot/Stop Buttons */}
          <div className="flex flex-wrap items-center gap-2.5">
            {/* Hybrid Runtime Switcher Pill */}
            <div
              role="group"
              aria-label="Sandbox runtime engine switcher"
              className="inline-flex items-center rounded-xl bg-zinc-950 p-1 border border-zinc-800 text-xs font-mono"
            >
              <button
                type="button"
                onClick={() => setRuntimeMode('WASM')}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg transition ${
                  runtimeMode === 'WASM'
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-semibold'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Cpu className="w-3.5 h-3.5" aria-hidden="true" />
                Browser WASM (Instant)
              </button>
              <button
                type="button"
                disabled={!dockerAvailable}
                title={
                  dockerAvailable
                    ? 'Run in isolated ephemeral Docker container with automatic PostgreSQL/MongoDB sidecar provisioning'
                    : 'Docker daemon is not available on this host'
                }
                onClick={() => {
                  if (dockerAvailable) setRuntimeMode('DOCKER');
                }}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg transition ${
                  !dockerAvailable
                    ? 'opacity-40 cursor-not-allowed text-zinc-500'
                    : runtimeMode === 'DOCKER'
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-semibold'
                    : isDockerRecommended
                    ? 'text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 animate-pulse'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Container className="w-3.5 h-3.5" aria-hidden="true" />
                Docker Sandbox (Full-Stack &amp; DB)
                {isDockerRecommended && runtimeMode !== 'DOCKER' && (
                  <span className="px-1.5 py-0.2 text-[9px] uppercase rounded bg-emerald-500 text-zinc-950 font-bold">
                    Recommended
                  </span>
                )}
              </button>
            </div>

            {/* Layout Mode Switcher */}
            <div
              role="group"
              aria-label="Sandbox layout mode switcher"
              className="inline-flex items-center rounded-xl bg-zinc-950 p-1 border border-zinc-800 text-xs font-mono"
            >
              <button
                type="button"
                onClick={() => setLayoutMode('IDE_SPLIT')}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg transition ${
                  layoutMode === 'IDE_SPLIT'
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Columns className="w-3.5 h-3.5" aria-hidden="true" />
                IDE Split
              </button>
              <button
                type="button"
                onClick={() => setLayoutMode('PREVIEW_FOCUS')}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg transition ${
                  layoutMode === 'PREVIEW_FOCUS'
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <LayoutPanelLeft className="w-3.5 h-3.5" aria-hidden="true" />
                Preview Focus
              </button>
              <button
                type="button"
                onClick={() => setLayoutMode('FULLSCREEN')}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg transition ${
                  layoutMode === 'FULLSCREEN'
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Maximize2 className="w-3.5 h-3.5" aria-hidden="true" />
                Fullscreen
              </button>
            </div>

            {/* Env Vars (.env) Button */}
            <button
              type="button"
              onClick={openEnvModal}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-950 hover:bg-zinc-800 border border-zinc-700 text-xs font-mono text-zinc-200 transition"
            >
              <Sliders className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
              Env Vars (.env)
            </button>

            {/* Stop Container Button (Shown when Docker Sandbox is active) */}
            {activeDockerSandboxId && (
              <button
                type="button"
                disabled={stoppingDocker}
                onClick={() => void stopActiveDockerSandbox(false)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-200 font-mono text-xs font-bold transition disabled:opacity-50"
              >
                {stoppingDocker ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Square className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
                )}
                Stop Container
              </button>
            )}

            {/* Boot & Run Repo Button */}
            {isCurrentTargetRunnable && (
              <button
                type="button"
                onClick={() => void bootAndRunSandbox()}
                disabled={
                  stage === 'BOOTING_WASM' ||
                  stage === 'INSTALLING_DEPS' ||
                  stage === 'STARTING_SERVER'
                }
                className="inline-flex items-center gap-2 px-5 py-2 rounded-xl bg-gradient-to-r from-cyan-500 to-emerald-500 hover:from-cyan-400 hover:to-emerald-400 disabled:opacity-50 text-zinc-950 font-mono text-xs font-bold shadow-[0_0_20px_rgba(34,211,238,0.3)] transition"
              >
                {stage === 'BOOTING_WASM' ||
                stage === 'INSTALLING_DEPS' ||
                stage === 'STARTING_SERVER' ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                    {stage === 'BOOTING_WASM'
                      ? runtimeMode === 'DOCKER'
                        ? 'Provisioning Docker...'
                        : 'Booting WASM...'
                      : stage === 'INSTALLING_DEPS'
                      ? 'Installing Deps...'
                      : 'Starting Server...'}
                  </>
                ) : stage === 'SERVER_READY' ? (
                  <>
                    <RotateCw className="w-4 h-4" aria-hidden="true" />
                    Restart Sandbox
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4 fill-current" aria-hidden="true" />
                    {runtimeMode === 'DOCKER'
                      ? 'Run in Docker Sandbox'
                      : 'Boot & Run Repo'}
                  </>
                )}
              </button>
            )}
          </div>
        </div>

        {/* Target Folder & Script Selector Row */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-zinc-800/80 text-xs font-mono">
          <div className="flex flex-wrap items-center gap-3">
            {availableTargets.length > 0 && (
              <div className="flex items-center gap-2">
                <label htmlFor="sandbox-target-select" className="text-zinc-400">
                  Target Directory:
                </label>
                <select
                  id="sandbox-target-select"
                  value={selectedTargetDir}
                  onChange={(e) => handleTargetChange(e.target.value)}
                  className="px-3 py-1.5 rounded-lg bg-zinc-950 border border-zinc-700 text-zinc-100 focus:outline-none focus:border-cyan-400"
                >
                  {availableTargets.map((t) => (
                    <option key={t.dir || 'root'} value={t.dir}>
                      {t.label} — {t.framework} [{t.tier}]
                    </option>
                  ))}
                </select>
              </div>
            )}

            {currentTarget && currentTarget.scripts.length > 0 && (
              <div className="flex items-center gap-2">
                <label htmlFor="sandbox-script-select" className="text-zinc-400">
                  Start Script:
                </label>
                <select
                  id="sandbox-script-select"
                  value={selectedScript}
                  onChange={(e) => setSelectedScript(e.target.value)}
                  className="px-3 py-1.5 rounded-lg bg-zinc-950 border border-zinc-700 text-emerald-300 focus:outline-none focus:border-cyan-400"
                >
                  {currentTarget.scripts.map((s) => (
                    <option key={s} value={s}>
                      npm run {s}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* External Cloud IDE Fallbacks */}
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={`https://github.dev/${fullName}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-950 hover:bg-zinc-800 border border-zinc-800 text-[11px] text-zinc-300 transition"
            >
              <ExternalLink className="w-3 h-3 text-cyan-400" aria-hidden="true" />
              Open in GitHub.dev
            </a>
            <a
              href={`https://codesandbox.io/s/github/${fullName}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-950 hover:bg-zinc-800 border border-zinc-800 text-[11px] text-zinc-300 transition"
            >
              <ExternalLink className="w-3 h-3 text-emerald-400" aria-hidden="true" />
              Open in CodeSandbox
            </a>
          </div>
        </div>
      </div>

      {/* Crash / Error Recovery Banner with "Switch to Docker Sandbox" CTA */}
      {stage === 'ERROR' && (
        <div
          role="alert"
          className="rounded-2xl border border-rose-500/50 bg-rose-950/35 p-4 flex flex-wrap items-center justify-between gap-4 text-rose-200 font-mono text-xs"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle
              className="w-5 h-5 text-rose-400 shrink-0 mt-0.5"
              aria-hidden="true"
            />
            <div className="space-y-1">
              <p className="font-bold text-rose-100">
                Sandbox Process Exited or Encountered a Fatal Error (
                {runtimeMode === 'DOCKER' ? 'Docker Container' : 'Browser WASM'})
              </p>
              <p className="text-rose-200/90">
                {lastCrashReason ||
                  'The server process failed to bind or crashed during startup. Inspect the terminal output below for details.'}
              </p>
              {runtimeMode === 'WASM' && dockerAvailable && (
                <p className="text-emerald-300">
                  Tip: Full-stack backends, Prisma/PostgreSQL/MongoDB apps, and
                  heavy CRA builds run natively in Docker Sandbox with automatic
                  database sidecar provisioning.
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {runtimeMode === 'WASM' && dockerAvailable && (
              <button
                type="button"
                onClick={() => void bootAndRunSandbox('DOCKER')}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-mono text-xs font-bold shadow-lg transition"
              >
                <Container className="w-4 h-4" aria-hidden="true" />
                Switch to Docker Sandbox
              </button>
            )}
            <button
              type="button"
              onClick={openEnvModal}
              className="px-3 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs font-mono transition"
            >
              Edit .env
            </button>
          </div>
        </div>
      )}

      {/* Pre-Flight Warnings & Unsupported Diagnostic Banner */}
      {currentTarget && currentTarget.warnings.length > 0 && (
        <div
          role="status"
          className={`rounded-2xl border p-4 flex flex-wrap items-start justify-between gap-4 ${
            currentTarget.tier === 'UNSUPPORTED'
              ? 'border-rose-500/40 bg-rose-950/25 text-rose-200'
              : 'border-amber-500/40 bg-amber-950/25 text-amber-200'
          }`}
        >
          <div className="flex items-start gap-3">
            <ShieldAlert
              className={`w-5 h-5 shrink-0 mt-0.5 ${
                currentTarget.tier === 'UNSUPPORTED'
                  ? 'text-rose-400'
                  : 'text-amber-400'
              }`}
              aria-hidden="true"
            />
            <div className="space-y-1 text-xs font-mono">
              <p className="font-bold">
                Pre-Flight Diagnostics for {currentTarget.label} (
                {currentTarget.framework}):
              </p>
              <ul className="list-disc list-inside space-y-0.5 text-zinc-200">
                {currentTarget.warnings.map((w, idx) => (
                  <li key={idx}>{w}</li>
                ))}
              </ul>
              {currentTarget.tier === 'NEEDS_CONFIG' && dockerAvailable && (
                <p className="text-emerald-300 pt-1">
                  ✦ Docker Sandbox Available: Ephemeral PostgreSQL/MongoDB
                  sidecars and native Linux containers are ready for this target.
                </p>
              )}
            </div>
          </div>

          {currentTarget.tier === 'NEEDS_CONFIG' && (
            <div className="flex items-center gap-2 shrink-0">
              {dockerAvailable && runtimeMode !== 'DOCKER' && (
                <button
                  type="button"
                  onClick={() => setRuntimeMode('DOCKER')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-200 text-xs font-mono font-semibold transition"
                >
                  <Container className="w-3.5 h-3.5" aria-hidden="true" />
                  Use Docker Sandbox
                </button>
              )}
              <button
                type="button"
                onClick={openEnvModal}
                className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-200 text-xs font-mono font-semibold shrink-0 transition"
              >
                Configure .env
              </button>
            </div>
          )}
        </div>
      )}

      {/* Fullscreen Preview Overlay Mode */}
      {layoutMode === 'FULLSCREEN' && (
        <div className="fixed inset-0 z-50 bg-zinc-950 flex flex-col">
          <div className="px-4 py-3 border-b border-zinc-800 bg-zinc-900 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <span className="font-mono text-xs font-bold text-cyan-400 shrink-0">
                CodeXray Fullscreen Preview — {fullName}
              </span>
              {ports.length > 1 && (
                <select
                  aria-label="Select sandbox preview port"
                  value={activePort ?? ''}
                  onChange={(e) => setActivePort(Number(e.target.value))}
                  className="px-2 py-1 rounded bg-zinc-950 border border-zinc-800 font-mono text-xs text-cyan-300"
                >
                  {ports.map((p) => (
                    <option key={p.port} value={p.port}>
                      {p.label || `:${p.port}`}
                    </option>
                  ))}
                </select>
              )}
              <div className="flex-1 max-w-xl px-3 py-1 rounded-lg bg-zinc-950 border border-zinc-800 font-mono text-xs text-zinc-400 truncate flex items-center gap-2">
                <Globe className="w-3.5 h-3.5 text-emerald-400 shrink-0" aria-hidden="true" />
                <span className="truncate">
                  {activePreviewUrl || 'https://localhost:3000 (awaiting server)'}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIframeKey((k) => k + 1)}
                disabled={!activePreviewUrl}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-xs font-mono text-zinc-200 transition"
              >
                <RotateCw className="w-3.5 h-3.5" aria-hidden="true" />
                Refresh
              </button>
              {activePreviewUrl && (
                <a
                  href={activePreviewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-mono text-cyan-300 transition"
                >
                  <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                  Open in New Tab
                </a>
              )}
              <button
                type="button"
                onClick={() => setLayoutMode('IDE_SPLIT')}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-cyan-500 text-zinc-950 font-mono text-xs font-bold transition"
              >
                <Minimize2 className="w-3.5 h-3.5" aria-hidden="true" />
                Exit Fullscreen
              </button>
            </div>
          </div>

          <div className="flex-1 bg-zinc-950 flex flex-col">
            {activePreviewUrl ? (
              <iframe
                key={iframeKey}
                src={activePreviewUrl}
                title={`Fullscreen Live Preview for ${fullName}`}
                allow="cross-origin-isolated; focus-without-user-activation 'none'"
                className="w-full h-full border-0 bg-white"
              />
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-3">
                <Sparkles className="w-8 h-8 text-cyan-400" aria-hidden="true" />
                <p className="font-mono text-sm text-zinc-300">
                  No active sandbox preview server running yet. Exit fullscreen
                  or click Run first.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Main Sandbox Grid (700px+ height) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 min-h-[700px]">
        {/* Pane 1: File Explorer Tree (Shown in IDE_SPLIT mode - 3 cols) */}
        {layoutMode === 'IDE_SPLIT' && (
          <div className="lg:col-span-3 rounded-2xl border border-zinc-800 bg-zinc-900/75 flex flex-col overflow-hidden h-[700px]">
            <div className="px-3.5 py-2.5 border-b border-zinc-800 bg-zinc-950/60 flex items-center justify-between">
              <span className="font-mono text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                <Folder className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
                Workspace Explorer
              </span>
              <span className="text-[10px] font-mono text-zinc-500">
                {sandboxData.fileCount} files
              </span>
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-0.5 font-mono text-xs">
              {visibleItems.map((item) => {
                const isSelected = !item.isDir && item.path === selectedFilePath;
                const isCollapsed = collapsedDirs.has(item.path);

                return (
                  <button
                    key={item.path}
                    type="button"
                    onClick={() =>
                      item.isDir
                        ? toggleDir(item.path)
                        : handleSelectFile(item.path)
                    }
                    style={{ paddingLeft: `${item.depth * 12 + 8}px` }}
                    className={`w-full text-left py-1.5 pr-2 rounded-lg flex items-center gap-1.5 truncate transition ${
                      isSelected
                        ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 font-semibold'
                        : 'text-zinc-300 hover:bg-zinc-800/70 hover:text-zinc-100'
                    }`}
                  >
                    {item.isDir ? (
                      <>
                        {isCollapsed ? (
                          <ChevronRight
                            className="w-3.5 h-3.5 text-zinc-500 shrink-0"
                            aria-hidden="true"
                          />
                        ) : (
                          <ChevronDown
                            className="w-3.5 h-3.5 text-zinc-500 shrink-0"
                            aria-hidden="true"
                          />
                        )}
                        {isCollapsed ? (
                          <Folder
                            className="w-3.5 h-3.5 text-amber-400 shrink-0"
                            aria-hidden="true"
                          />
                        ) : (
                          <FolderOpen
                            className="w-3.5 h-3.5 text-amber-400 shrink-0"
                            aria-hidden="true"
                          />
                        )}
                      </>
                    ) : (
                      <FileCode2
                        className="w-3.5 h-3.5 text-cyan-400 shrink-0 ml-3"
                        aria-hidden="true"
                      />
                    )}
                    <span className="truncate">{item.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Pane 2: Code Editor + Terminal Console (5 cols in IDE_SPLIT, 3 cols in PREVIEW_FOCUS) */}
        <div
          className={`${
            layoutMode === 'PREVIEW_FOCUS' ? 'lg:col-span-3' : 'lg:col-span-5'
          } flex flex-col gap-4 h-[700px]`}
        >
          {/* In-Memory Code Editor (Hidden in PREVIEW_FOCUS so Terminal gets full vertical height) */}
          {layoutMode === 'IDE_SPLIT' && (
            <div className="flex-1 rounded-2xl border border-zinc-800 bg-zinc-900/75 flex flex-col overflow-hidden min-h-0">
              <div className="px-3.5 py-2 border-b border-zinc-800 bg-zinc-950/60 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <FileCode2
                    className="w-3.5 h-3.5 text-cyan-400 shrink-0"
                    aria-hidden="true"
                  />
                  <span className="font-mono text-xs text-zinc-200 truncate">
                    {selectedFilePath}
                  </span>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {hmrSynced && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-mono text-emerald-400">
                      <CheckCircle2 className="w-3 h-3" aria-hidden="true" />
                      Synced to WebContainer FS
                    </span>
                  )}
                  {stage === 'SERVER_READY' && (
                    <button
                      type="button"
                      onClick={() => setIframeKey((k) => k + 1)}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-[10px] font-mono text-zinc-200 transition"
                    >
                      <Save className="w-3 h-3 text-cyan-400" aria-hidden="true" />
                      Reload Preview
                    </button>
                  )}
                </div>
              </div>

              <textarea
                value={editorContent}
                onChange={(e) => void handleEditorChange(e.target.value)}
                spellCheck={false}
                aria-label={`Source code editor for ${selectedFilePath}`}
                className="flex-1 w-full p-3.5 bg-zinc-950 font-mono text-xs leading-relaxed text-zinc-200 resize-none focus:outline-none"
              />
            </div>
          )}

          {/* Boot & Terminal Console */}
          <div
            className={`${
              layoutMode === 'PREVIEW_FOCUS' ? 'flex-1' : 'h-[250px]'
            } rounded-2xl border border-zinc-800 bg-zinc-950 flex flex-col overflow-hidden shrink-0`}
          >
            <div className="px-3.5 py-2 border-b border-zinc-800 bg-zinc-900/80 flex items-center justify-between">
              <span
                id="sandbox-terminal-label"
                className="font-mono text-xs font-semibold text-zinc-300 flex items-center gap-1.5 truncate"
              >
                <Terminal
                  className="w-3.5 h-3.5 text-emerald-400 shrink-0"
                  aria-hidden="true"
                />
                {runtimeMode === 'DOCKER'
                  ? 'Docker Container Shell'
                  : 'WebContainer Shell'}{' '}
                ({selectedTargetDir ? `/${selectedTargetDir}` : '/'} &rarr; npm run{' '}
                {selectedScript || 'dev'})
              </span>
              <span
                className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded shrink-0 ${
                  stage === 'ERROR'
                    ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                    : stage === 'SERVER_READY'
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                    : 'bg-zinc-800 text-cyan-300'
                }`}
              >
                {stage}
              </span>
            </div>

            <pre
              ref={terminalPreRef}
              role="region"
              aria-labelledby="sandbox-terminal-label"
              tabIndex={0}
              className="flex-1 p-3 overflow-y-auto font-mono text-[11px] leading-relaxed text-zinc-300 bg-black/90 focus:outline-none"
            >
              <code>
                {terminalLines.length === 0 ? (
                  <span className="text-zinc-500">
                    {isCurrentTargetRunnable
                      ? runtimeMode === 'DOCKER'
                        ? 'Click "Run in Docker Sandbox" above to provision an isolated node:20-alpine container (plus Postgres/MongoDB sidecar if needed) and stream live logs.'
                        : 'Click "Boot & Run Repo" above to boot WebContainer WASM, install dependencies, and start the live server.'
                      : 'Sandbox execution disabled for this target. Select another target directory or inspect source files in the Workspace Explorer.'}
                  </span>
                ) : (
                  terminalLines.map((line, idx) => (
                    <div key={idx} className="whitespace-pre-wrap break-all">
                      {line}
                    </div>
                  ))
                )}
              </code>
            </pre>
          </div>
        </div>

        {/* Pane 3: Live Browser Preview (4 cols in IDE_SPLIT, 9 cols / 75% width in PREVIEW_FOCUS) */}
        <div
          className={`${
            layoutMode === 'PREVIEW_FOCUS' ? 'lg:col-span-9' : 'lg:col-span-4'
          } rounded-2xl border border-zinc-800 bg-zinc-900/75 flex flex-col overflow-hidden h-[700px]`}
        >
          {/* Browser Chrome & Address Bar */}
          <div className="px-3 py-2 border-b border-zinc-800 bg-zinc-950/80 flex items-center gap-2">
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="w-2.5 h-2.5 rounded-full bg-red-500/70" />
              <span className="w-2.5 h-2.5 rounded-full bg-amber-500/70" />
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/70" />
            </div>

            {ports.length > 1 && (
              <select
                aria-label="Select sandbox preview port"
                value={activePort ?? ''}
                onChange={(e) => setActivePort(Number(e.target.value))}
                className="px-2 py-1 rounded bg-zinc-900 border border-zinc-800 font-mono text-[11px] text-cyan-300"
              >
                {ports.map((p) => (
                  <option key={p.port} value={p.port}>
                    {p.label || `:${p.port}`}
                  </option>
                ))}
              </select>
            )}

            <div className="flex-1 px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 font-mono text-[11px] text-zinc-400 truncate flex items-center gap-1.5">
              <Globe
                className="w-3 h-3 text-emerald-400 shrink-0"
                aria-hidden="true"
              />
              <span className="truncate">
                {activePreviewUrl || 'https://localhost:3000 (awaiting server)'}
              </span>
            </div>

            <button
              type="button"
              onClick={() => setIframeKey((k) => k + 1)}
              disabled={!activePreviewUrl}
              aria-label="Refresh live preview"
              className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 border border-zinc-800 text-zinc-300 transition"
            >
              <RotateCw className="w-3.5 h-3.5" aria-hidden="true" />
            </button>

            <button
              type="button"
              onClick={() => setLayoutMode('FULLSCREEN')}
              aria-label="Expand preview to fullscreen"
              className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 transition"
            >
              <Maximize2 className="w-3.5 h-3.5" aria-hidden="true" />
            </button>

            {activePreviewUrl && (
              <a
                href={activePreviewUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open preview in new tab"
                className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-cyan-400 transition"
              >
                <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
              </a>
            )}
          </div>

          {/* Embedded Preview Canvas */}
          <div className="flex-1 bg-zinc-950 relative flex flex-col">
            {activePreviewUrl ? (
              <iframe
                key={iframeKey}
                src={activePreviewUrl}
                title={`Live Sandbox Preview for ${fullName}`}
                allow="cross-origin-isolated; focus-without-user-activation 'none'"
                className="w-full h-full border-0 bg-white"
              />
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center p-6 text-center space-y-3">
                <div
                  className={`w-12 h-12 rounded-2xl border flex items-center justify-center ${
                    stage === 'ERROR'
                      ? 'bg-rose-500/10 border-rose-500/30 text-rose-400'
                      : 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400'
                  }`}
                >
                  {stage === 'ERROR' ? (
                    <AlertTriangle className="w-6 h-6" aria-hidden="true" />
                  ) : (
                    <Sparkles className="w-6 h-6" aria-hidden="true" />
                  )}
                </div>
                <h4 className="font-mono text-sm font-bold text-zinc-200">
                  {stage === 'IDLE'
                    ? 'Live Browser Preview Ready'
                    : stage === 'ERROR'
                    ? 'Server Startup Halted'
                    : runtimeMode === 'DOCKER'
                    ? 'Starting Docker Sandbox Container...'
                    : 'Starting WebContainer Server...'}
                </h4>
                <p className="text-xs text-zinc-400 max-w-xs leading-relaxed">
                  {isCurrentTargetRunnable
                    ? stage === 'IDLE'
                      ? runtimeMode === 'DOCKER'
                        ? 'Click "Run in Docker Sandbox" to launch an isolated container with automatic DB sidecars and preview the live app here.'
                        : 'Click "Boot & Run Repo" to launch an isolated Node.js WebContainer inside your browser and preview the live application here.'
                      : stage === 'ERROR'
                      ? lastCrashReason ||
                        'The application process exited before binding to a port. Check the terminal logs or switch to Docker Sandbox.'
                      : 'Installing dependencies and waiting for the application server to bind to a local port...'
                    : 'Live preview is disabled for this target. Use GitHub.dev / CodeSandbox above or inspect files in the Explorer.'}
                </p>
                {stage === 'ERROR' &&
                  runtimeMode === 'WASM' &&
                  dockerAvailable && (
                    <button
                      type="button"
                      onClick={() => void bootAndRunSandbox('DOCKER')}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-mono text-xs font-bold shadow-lg transition"
                    >
                      <Container className="w-4 h-4" aria-hidden="true" />
                      Switch to Docker Sandbox
                    </button>
                  )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Native <dialog> Modal for Environment Variables (.env) */}
      {envModalOpen && (
        <dialog
          ref={envDialogRef}
          onClose={() => setEnvModalOpen(false)}
          className="w-full max-w-2xl rounded-2xl bg-zinc-900 border border-zinc-700 text-zinc-100 p-0 shadow-2xl backdrop:bg-black/75"
        >
          <div className="p-5 border-b border-zinc-800 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <Sliders className="w-4 h-4 text-amber-400" aria-hidden="true" />
              <div>
                <h4 className="font-mono text-sm font-bold text-zinc-100">
                  Environment Variables ({envFilePath})
                </h4>
                <p className="text-xs text-zinc-400 font-mono">
                  In-memory .env editor • Injected into both Browser WASM and
                  Docker Sandbox containers
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={closeEnvModal}
              aria-label="Close environment variables dialog"
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition"
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>

          <div className="p-5 space-y-3">
            <label
              htmlFor="env-editor-textarea"
              className="block text-xs font-mono text-zinc-300"
            >
              Edit KEY=VALUE pairs for <code>/{envFilePath}</code>:
            </label>
            <textarea
              id="env-editor-textarea"
              value={envDraftContent}
              onChange={(e) => setEnvDraftContent(e.target.value)}
              rows={10}
              spellCheck={false}
              className="w-full p-3.5 rounded-xl bg-zinc-950 border border-zinc-800 font-mono text-xs text-emerald-300 focus:outline-none focus:border-cyan-400"
            />
            {envSavedToast && (
              <p className="text-xs font-mono text-emerald-400 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                Saved to /{envFilePath} in virtual filesystem!
              </p>
            )}
          </div>

          <div className="px-5 py-4 border-t border-zinc-800 bg-zinc-950/60 flex flex-wrap items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={closeEnvModal}
              className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs font-mono text-zinc-300 transition"
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => void saveEnvChanges(false)}
              className="px-4 py-2 rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-xs font-mono font-semibold text-cyan-300 transition"
            >
              Save to FS
            </button>
            {isCurrentTargetRunnable && (
              <button
                type="button"
                onClick={() => void saveEnvChanges(true)}
                className="px-4 py-2 rounded-xl bg-gradient-to-r from-cyan-500 to-emerald-500 hover:from-cyan-400 hover:to-emerald-400 text-zinc-950 text-xs font-mono font-bold transition"
              >
                Save &amp; Restart Server
              </button>
            )}
          </div>
        </dialog>
      )}
    </div>
  );
}
