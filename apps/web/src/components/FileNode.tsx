'use client';

import React, { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { ReactFlowNodeData } from '@codexray/shared';
import {
  FileCode2,
  AlertTriangle,
  Cpu,
  ArrowDownLeft,
  ArrowUpRight,
} from 'lucide-react';

function FileNodeComponent({ data, selected }: NodeProps<ReactFlowNodeData>) {
  const borderClass = data.inCycle
    ? 'border-red-500/80 shadow-[0_0_20px_rgba(239,68,68,0.28)]'
    : data.isHub
    ? 'border-amber-500/70 shadow-[0_0_16px_rgba(245,158,11,0.18)]'
    : selected
    ? 'border-cyan-400 shadow-[0_0_18px_rgba(34,211,238,0.3)]'
    : 'border-zinc-800 hover:border-zinc-700';

  const badgeBg = data.inCycle
    ? 'bg-red-500/15 text-red-300 border-red-500/40'
    : data.isHub
    ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
    : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';

  return (
    <div
      className={`w-[245px] rounded-xl bg-zinc-900/95 backdrop-blur-md border-2 transition-all duration-150 px-3.5 py-2.5 text-left ${borderClass}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2.5 !h-2.5 !bg-cyan-400 !border-2 !border-zinc-950"
      />

      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 truncate max-w-[140px]">
          {data.folder}
        </span>
        <span
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded border ${badgeBg}`}
        >
          {data.inCycle ? (
            <>
              <AlertTriangle className="w-2.5 h-2.5" aria-hidden="true" />
              CYCLE
            </>
          ) : data.isHub ? (
            <>
              <Cpu className="w-2.5 h-2.5" aria-hidden="true" />
              HUB
            </>
          ) : (
            'MODULE'
          )}
        </span>
      </div>

      <div className="flex items-center gap-2 mb-2">
        <FileCode2
          className={`w-4 h-4 shrink-0 ${
            data.inCycle
              ? 'text-red-400'
              : data.isHub
              ? 'text-amber-400'
              : 'text-cyan-400'
          }`}
          aria-hidden="true"
        />
        <span
          className="font-mono text-xs font-semibold text-zinc-100 truncate"
          title={data.filePath}
        >
          {data.label}
        </span>
      </div>

      <div className="flex items-center justify-between pt-1.5 border-t border-zinc-800/80 text-[11px] font-mono text-zinc-400">
        <span>{data.loc} LOC</span>
        <div className="flex items-center gap-2.5">
          <span
            className="inline-flex items-center gap-0.5 text-emerald-400"
            title="Fan-In (Dependents importing this module)"
          >
            <ArrowDownLeft className="w-3 h-3" aria-hidden="true" />
            {data.fanIn}
          </span>
          <span
            className="inline-flex items-center gap-0.5 text-cyan-400"
            title="Fan-Out (Internal modules imported by this file)"
          >
            <ArrowUpRight className="w-3 h-3" aria-hidden="true" />
            {data.fanOut}
          </span>
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!w-2.5 !h-2.5 !bg-emerald-400 !border-2 !border-zinc-950"
      />
    </div>
  );
}

export const FileNode = memo(FileNodeComponent);
