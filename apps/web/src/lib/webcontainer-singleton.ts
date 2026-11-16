'use client';

import { WebContainer, FileSystemTree, WebContainerProcess } from '@webcontainer/api';

let bootPromise: Promise<WebContainer> | null = null;
let wcInstance: WebContainer | null = null;
let activeServerProcess: WebContainerProcess | null = null;

/**
 * Return the singleton WebContainer instance.
 * Ensures WebContainer.boot() is only ever invoked once per browser tab lifetime.
 */
export async function getWebContainerSingleton(): Promise<WebContainer> {
  if (wcInstance) {
    return wcInstance;
  }

  if (typeof window !== 'undefined' && !window.crossOriginIsolated) {
    throw new Error(
      'Cross-Origin Isolation (SharedArrayBuffer) is not enabled. Ensure COOP/COEP headers are active.'
    );
  }

  if (!bootPromise) {
    bootPromise = WebContainer.boot({
      coep: 'credentialless',
    })
      .then((instance) => {
        wcInstance = instance;
        return instance;
      })
      .catch((err) => {
        bootPromise = null;
        throw err;
      });
  }

  return bootPromise;
}

export function setActiveServerProcess(proc: WebContainerProcess | null): void {
  if (activeServerProcess) {
    try {
      activeServerProcess.kill();
    } catch {
      // ignore
    }
  }
  activeServerProcess = proc;
}

/**
 * Clean existing root entries in the singleton WebContainer and mount a fresh FileSystemTree
 */
export async function resetAndMountWorkspace(
  wc: WebContainer,
  tree: FileSystemTree
): Promise<void> {
  setActiveServerProcess(null);

  try {
    const entries = await wc.fs.readdir('/');
    for (const entry of entries) {
      if (entry === 'home' || entry === 'tmp' || entry === 'dev' || entry === 'proc') {
        continue;
      }
      try {
        await wc.fs.rm(`/${entry}`, { recursive: true });
      } catch {
        // ignore protected virtual paths
      }
    }
  } catch {
    // ignore readdir error on fresh boot
  }

  await wc.mount(tree);
}

/**
 * Strip ANSI escape codes and terminal spinner control characters for clean log display
 */
export function stripAnsiCodes(input: string): string {
  return input
    .replace(
      // eslint-disable-next-line no-control-regex
      /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g,
      ''
    )
    .replace(/\r/g, '');
}
