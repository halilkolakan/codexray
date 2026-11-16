'use client';

import React, { useEffect, useRef } from 'react';
import { AnalysisJobStatus, JobProgressEvent } from '@codexray/shared';
import {
  Terminal,
  GitBranch,
  Cpu,
  Sparkles,
  CheckCircle2,
  Loader2,
} from 'lucide-react';

const PIPELINE_STEPS: Array<{
  key: AnalysisJobStatus;
  label: string;
  desc: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  {
    key: 'CLONING',
    label: 'Shallow Clone',
    desc: 'simple-git --depth 1',
    icon: GitBranch,
  },
  {
    key: 'PARSING',
    label: 'AST & Cycle Graph',
    desc: 'TS Compiler API + DFS',
    icon: Cpu,
  },
  {
    key: 'AI_REVIEW',
    label: 'Gemini AI Review',
    desc: 'Structured Architecture Audit',
    icon: Sparkles,
  },
  {
    key: 'COMPLETED',
    label: 'Telemetry Ready',
    desc: 'Persisted to PostgreSQL',
    icon: CheckCircle2,
  },
];

const STATUS_ORDER: Record<AnalysisJobStatus, number> = {
  QUEUED: 0,
  CLONING: 1,
  PARSING: 2,
  AI_REVIEW: 3,
  COMPLETED: 4,
  FAILED: 4,
};

interface LiveTerminalProgressProps {
  status: AnalysisJobStatus;
  progressPercent: number;
  logs: JobProgressEvent[];
  repoName: string;
}

export function LiveTerminalProgress({
  status,
  progressPercent,
  logs,
  repoName,
}: LiveTerminalProgressProps) {
  const preRef = useRef<HTMLPreElement | null>(null);
  const currentOrder = STATUS_ORDER[status] ?? 0;

  useEffect(() => {
    if (preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <section
      aria-label="Live analysis pipeline progress"
      className="w-full max-w-4xl mx-auto my-8 rounded-2xl border border-zinc-800 bg-zinc-900/75 backdrop-blur-xl shadow-2xl overflow-hidden"
    >
      {/* Header Bar */}
      <div className="px-6 py-4 border-b border-zinc-800 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-ping" />
          <div>
            <h2 className="text-sm font-mono font-bold text-zinc-100">
              Analyzing {repoName || 'Repository'}
            </h2>
            <p className="text-xs text-zinc-400 font-mono">
              Real-time Socket.io + Redis Pub/Sub Worker Stream
            </p>
          </div>
        </div>
        <span className="font-mono text-sm font-bold text-cyan-400 bg-cyan-500/10 border border-cyan-500/30 px-3 py-1 rounded-full">
          {progressPercent}%
        </span>
      </div>

      {/* Animated Progress Bar */}
      <div className="w-full h-1.5 bg-zinc-950 overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-cyan-500 via-emerald-400 to-cyan-300 transition-all duration-300"
          style={{ width: `${Math.max(5, progressPercent)}%` }}
        />
      </div>

      {/* Pipeline Stepper */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-6 border-b border-zinc-800/80 bg-zinc-950/40">
        {PIPELINE_STEPS.map((step, index) => {
          const stepNumber = index + 1;
          const isDone = currentOrder > stepNumber || status === 'COMPLETED';
          const isActive = currentOrder === stepNumber && status !== 'COMPLETED';
          const Icon = step.icon;

          return (
            <div
              key={step.key}
              className={`rounded-xl p-3.5 border transition-all ${
                isActive
                  ? 'border-cyan-500/60 bg-cyan-500/10 shadow-[0_0_20px_rgba(34,211,238,0.12)]'
                  : isDone
                  ? 'border-emerald-500/40 bg-emerald-500/5'
                  : 'border-zinc-800/80 bg-zinc-900/40 opacity-60'
              }`}
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400">
                  Step 0{stepNumber}
                </span>
                {isActive ? (
                  <Loader2
                    className="w-4 h-4 text-cyan-400 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Icon
                    className={`w-4 h-4 ${
                      isDone ? 'text-emerald-400' : 'text-zinc-500'
                    }`}
                    aria-hidden="true"
                  />
                )}
              </div>
              <p className="font-mono text-xs font-semibold text-zinc-100">
                {step.label}
              </p>
              <p className="font-mono text-[11px] text-zinc-400 mt-0.5">
                {step.desc}
              </p>
            </div>
          );
        })}
      </div>

      {/* Live Streaming Terminal Logs */}
      <div className="p-5 bg-zinc-950">
        <div className="flex items-center gap-2 text-xs font-mono text-zinc-400 mb-2.5">
          <Terminal className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
          <span id="live-terminal-heading">
            worker@codexray:~# tail -f /var/log/codexray-events.stream
          </span>
        </div>
        <pre
          ref={preRef}
          role="region"
          aria-labelledby="live-terminal-heading"
          tabIndex={0}
          className="h-48 overflow-y-auto rounded-xl bg-black/80 border border-zinc-800/90 p-4 font-mono text-xs leading-relaxed text-zinc-300 focus:outline-none focus:border-cyan-500"
        >
          <code>
            {logs.length === 0 ? (
              <span className="text-zinc-500">
                [SYSTEM] Waiting for BullMQ worker stream...
              </span>
            ) : (
              logs.map((entry, idx) => (
                <div key={`${entry.timestamp}-${idx}`} className="py-0.5">
                  <span className="text-zinc-500">
                    [{new Date(entry.timestamp).toLocaleTimeString()}]
                  </span>{' '}
                  <span className="text-cyan-400 font-semibold">
                    [{entry.status}]
                  </span>{' '}
                  <span className="text-zinc-200">{entry.logLine}</span>
                </div>
              ))
            )}
          </code>
        </pre>
      </div>
    </section>
  );
}
