'use client';

import React, { useMemo, useState, useCallback } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Node,
  Edge,
  MarkerType,
  useNodesState,
  useEdgesState,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { GraphData, ReactFlowNodeData } from '@codexray/shared';
import { FileNode } from './FileNode';
import {
  Search,
  X,
  FileCode2,
  ArrowDownLeft,
  ArrowUpRight,
  AlertTriangle,
  Box,
  Layers,
  Filter,
} from 'lucide-react';

const nodeTypes = {
  fileNode: FileNode,
};

interface DependencyGraphViewProps {
  graph: GraphData;
}

export function DependencyGraphView({ graph }: DependencyGraphViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'cycles' | 'hubs'>('all');
  const [selectedNodeData, setSelectedNodeData] =
    useState<ReactFlowNodeData | null>(null);

  const styledInitialEdges: Edge[] = useMemo(() => {
    return (graph.edges || []).map((edge) => {
      const isCircular = Boolean(edge.data?.isCircular);
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        animated: isCircular,
        style: {
          stroke: isCircular ? '#ef4444' : '#3f3f46',
          strokeWidth: isCircular ? 2.5 : 1.5,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: isCircular ? '#ef4444' : '#52525b',
          width: 16,
          height: 16,
        },
        data: edge.data,
      };
    });
  }, [graph.edges]);

  const [nodes, , onNodesChange] = useNodesState<ReactFlowNodeData>(
    (graph.nodes || []) as Node<ReactFlowNodeData>[]
  );
  const [edges, , onEdgesChange] = useEdgesState(styledInitialEdges);

  const filteredNodes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return nodes.filter((n) => {
      const d = n.data;
      if (filterMode === 'cycles' && !d.inCycle) return false;
      if (filterMode === 'hubs' && !d.isHub) return false;
      if (q && !d.filePath.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [nodes, searchQuery, filterMode]);

  const visibleNodeIds = useMemo(
    () => new Set(filteredNodes.map((n) => n.id)),
    [filteredNodes]
  );

  const filteredEdges = useMemo(() => {
    return edges.filter(
      (e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target)
    );
  }, [edges, visibleNodeIds]);

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node<ReactFlowNodeData>) => {
      setSelectedNodeData(node.data);
    },
    []
  );

  const selectFileByPath = useCallback(
    (filePath: string) => {
      const found = nodes.find((n) => n.data.filePath === filePath);
      if (found) {
        setSelectedNodeData(found.data);
      }
    },
    [nodes]
  );

  return (
    <div className="relative w-full h-[680px] rounded-2xl border border-zinc-800 bg-zinc-950 overflow-hidden flex flex-col">
      {/* Top Graph Toolbar */}
      <div className="z-10 flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-zinc-900/90 backdrop-blur-md border-b border-zinc-800">
        <search className="flex items-center gap-2 flex-1 min-w-[240px] max-w-md">
          <div className="relative w-full">
            <Search
              className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter modules by path (e.g. router, index.ts)..."
              aria-label="Filter dependency graph modules by path"
              className="w-full pl-9 pr-8 py-1.5 text-xs font-mono bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-cyan-400"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Clear module filter"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-200"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        </search>

        {/* Filter Pills & Legend */}
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="inline-flex items-center rounded-lg bg-zinc-950 p-0.5 border border-zinc-800 text-xs font-mono"
            role="group"
            aria-label="Filter nodes by risk category"
          >
            <button
              type="button"
              onClick={() => setFilterMode('all')}
              className={`px-2.5 py-1 rounded-md transition ${
                filterMode === 'all'
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              All ({nodes.length})
            </button>
            <button
              type="button"
              onClick={() => setFilterMode('hubs')}
              className={`px-2.5 py-1 rounded-md transition flex items-center gap-1 ${
                filterMode === 'hubs'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Filter className="w-3 h-3" aria-hidden="true" />
              Hubs ({nodes.filter((n) => n.data.isHub).length})
            </button>
            <button
              type="button"
              onClick={() => setFilterMode('cycles')}
              className={`px-2.5 py-1 rounded-md transition flex items-center gap-1 ${
                filterMode === 'cycles'
                  ? 'bg-red-500/20 text-red-300 border border-red-500/40'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <AlertTriangle className="w-3 h-3" aria-hidden="true" />
              In Cycle ({nodes.filter((n) => n.data.inCycle).length})
            </button>
          </div>

          <div className="hidden lg:flex items-center gap-3 text-[11px] font-mono text-zinc-400 pl-2 border-l border-zinc-800">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 inline-block" />
              Standard
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block" />
              Coupled Hub
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block animate-pulse" />
              Circular Edge
            </span>
          </div>
        </div>
      </div>

      {/* Main Graph Canvas */}
      <div className="relative flex-1 w-full h-full">
        <ReactFlow
          nodes={filteredNodes}
          edges={filteredEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.15}
          maxZoom={1.75}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#27272a" gap={22} size={1.5} />
          <Controls position="bottom-left" />
          <MiniMap
            position="bottom-right"
            nodeColor={(n) => {
              const d = n.data as ReactFlowNodeData;
              if (d?.inCycle) return '#ef4444';
              if (d?.isHub) return '#f59e0b';
              return '#22d3ee';
            }}
            maskColor="rgba(9, 9, 11, 0.78)"
            style={{
              backgroundColor: '#18181b',
              border: '1px solid #27272a',
              borderRadius: '0.75rem',
            }}
          />
        </ReactFlow>

        {/* Side Inspector Drawer on Node Click */}
        {selectedNodeData && (
          <aside
            aria-label={`Module inspector for ${selectedNodeData.filePath}`}
            className="absolute top-3 right-3 bottom-3 w-full max-w-sm rounded-xl bg-zinc-900/95 backdrop-blur-xl border border-zinc-700/80 shadow-2xl z-20 flex flex-col overflow-hidden"
          >
            <div className="flex items-start justify-between gap-3 p-4 border-b border-zinc-800">
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <FileCode2
                    className="w-4 h-4 text-cyan-400 shrink-0"
                    aria-hidden="true"
                  />
                  <h3 className="font-mono text-sm font-bold text-zinc-100 truncate">
                    {selectedNodeData.label}
                  </h3>
                </div>
                <p className="font-mono text-xs text-zinc-400 break-all">
                  {selectedNodeData.filePath}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedNodeData(null)}
                aria-label="Close module inspector"
                className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>

            <div className="p-4 space-y-4 overflow-y-auto flex-1 text-xs">
              {/* Telemetry Pills */}
              <div className="grid grid-cols-3 gap-2">
                <div className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800">
                  <span className="text-[10px] font-mono uppercase text-zinc-400 block">
                    Lines of Code
                  </span>
                  <span className="font-mono text-base font-bold text-zinc-100">
                    {selectedNodeData.loc}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800">
                  <span className="text-[10px] font-mono uppercase text-emerald-400 block">
                    Fan-In (Used By)
                  </span>
                  <span className="font-mono text-base font-bold text-emerald-300">
                    {selectedNodeData.fanIn}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800">
                  <span className="text-[10px] font-mono uppercase text-cyan-400 block">
                    Fan-Out (Imports)
                  </span>
                  <span className="font-mono text-base font-bold text-cyan-300">
                    {selectedNodeData.fanOut}
                  </span>
                </div>
              </div>

              {selectedNodeData.inCycle && (
                <div className="p-3 rounded-lg bg-red-950/50 border border-red-500/40 text-red-200 flex items-start gap-2.5">
                  <AlertTriangle
                    className="w-4 h-4 text-red-400 shrink-0 mt-0.5"
                    aria-hidden="true"
                  />
                  <div>
                    <p className="font-semibold text-red-300">
                      Circular Dependency Participant
                    </p>
                    <p className="text-[11px] text-red-200/80 mt-0.5">
                      This file is part of a mutual import cycle. Consider extracting
                      shared contracts into a leaf module.
                    </p>
                  </div>
                </div>
              )}

              {/* Dependents (Imported By) */}
              <div>
                <h4 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-2 flex items-center gap-1.5">
                  <ArrowDownLeft
                    className="w-3.5 h-3.5 text-emerald-400"
                    aria-hidden="true"
                  />
                  Dependents / Imported By ({selectedNodeData.importedBy.length})
                </h4>
                {selectedNodeData.importedBy.length === 0 ? (
                  <p className="text-zinc-500 font-mono text-[11px] italic">
                    No internal modules import this file (Root / Entrypoint).
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {selectedNodeData.importedBy.map((depPath) => (
                      <li key={depPath}>
                        <button
                          type="button"
                          onClick={() => selectFileByPath(depPath)}
                          className="w-full text-left px-2.5 py-1.5 rounded-md bg-zinc-950 hover:bg-zinc-800 border border-zinc-800/80 font-mono text-[11px] text-emerald-300 truncate transition"
                        >
                          {depPath}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Outgoing Internal Imports */}
              <div>
                <h4 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-2 flex items-center gap-1.5">
                  <ArrowUpRight
                    className="w-3.5 h-3.5 text-cyan-400"
                    aria-hidden="true"
                  />
                  Internal Imports ({selectedNodeData.imports.length})
                </h4>
                {selectedNodeData.imports.length === 0 ? (
                  <p className="text-zinc-500 font-mono text-[11px] italic">
                    No internal module imports (Leaf utility module).
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {selectedNodeData.imports.map((impPath) => (
                      <li key={impPath}>
                        <button
                          type="button"
                          onClick={() => selectFileByPath(impPath)}
                          className="w-full text-left px-2.5 py-1.5 rounded-md bg-zinc-950 hover:bg-zinc-800 border border-zinc-800/80 font-mono text-[11px] text-cyan-300 truncate transition"
                        >
                          {impPath}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Exported Symbols */}
              <div>
                <h4 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-2 flex items-center gap-1.5">
                  <Box
                    className="w-3.5 h-3.5 text-purple-400"
                    aria-hidden="true"
                  />
                  AST Exported Symbols ({selectedNodeData.exports.length})
                </h4>
                {selectedNodeData.exports.length === 0 ? (
                  <p className="text-zinc-500 font-mono text-[11px] italic">
                    No named exports detected.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {selectedNodeData.exports.map((sym) => (
                      <code
                        key={sym}
                        className="px-2 py-0.5 rounded bg-zinc-950 border border-zinc-800 font-mono text-[11px] text-purple-300"
                      >
                        {sym}
                      </code>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </aside>
        )}

        {/* Helper Hint Pill */}
        {!selectedNodeData && (
          <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-zinc-900/90 border border-zinc-800 text-[11px] font-mono text-zinc-400 flex items-center gap-1.5 shadow-lg">
            <Layers className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
            Click any module node to inspect AST imports, dependents, and exports
          </div>
        )}
      </div>
    </div>
  );
}
