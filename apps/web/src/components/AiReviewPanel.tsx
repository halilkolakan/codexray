'use client';

import React from 'react';
import { AiReviewData } from '@codexray/shared';
import {
  Sparkles,
  ShieldCheck,
  AlertTriangle,
  Compass,
  BookOpen,
  CheckCircle2,
  FileCode,
} from 'lucide-react';

interface AiReviewPanelProps {
  review: AiReviewData;
}

export function AiReviewPanel({ review }: AiReviewPanelProps) {
  return (
    <div className="space-y-6">
      {/* Architecture Pattern & Executive Summary */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
              <Sparkles className="w-5 h-5" aria-hidden="true" />
            </div>
            <div>
              <span className="text-[11px] font-mono uppercase tracking-wider text-cyan-400 block">
                Detected Architectural Pattern
              </span>
              <h3 className="text-lg font-bold text-zinc-100 font-mono">
                {review.architecturePattern}
              </h3>
            </div>
          </div>
          <span className="px-3 py-1 rounded-full text-xs font-mono bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
            AI Principal Engineer Audit
          </span>
        </div>
        <p className="text-sm text-zinc-300 leading-relaxed">
          {review.architectureSummary}
        </p>
      </div>

      {/* Strengths & Risks Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top 3 Strengths */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 space-y-4">
          <div className="flex items-center gap-2.5 pb-3 border-b border-zinc-800">
            <ShieldCheck
              className="w-5 h-5 text-emerald-400"
              aria-hidden="true"
            />
            <h3 className="text-base font-bold text-zinc-100">
              Key Architectural Strengths
            </h3>
          </div>

          <div className="space-y-3.5">
            {review.strengths.map((item, idx) => (
              <div
                key={idx}
                className="p-4 rounded-xl bg-zinc-950/80 border border-zinc-800/90 space-y-1.5"
              >
                <div className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 font-mono text-xs flex items-center justify-center font-bold">
                    {idx + 1}
                  </span>
                  <h4 className="font-semibold text-sm text-zinc-100">
                    {item.title}
                  </h4>
                </div>
                <p className="text-xs text-zinc-300 leading-relaxed">
                  {item.description}
                </p>
                <p className="text-[11px] font-mono text-emerald-400 pt-1">
                  Impact: {item.impact}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* Top 3 Risk Hotspots */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 space-y-4">
          <div className="flex items-center gap-2.5 pb-3 border-b border-zinc-800">
            <AlertTriangle
              className="w-5 h-5 text-amber-400"
              aria-hidden="true"
            />
            <h3 className="text-base font-bold text-zinc-100">
              Architectural Risk Hotspots
            </h3>
          </div>

          <div className="space-y-3.5">
            {review.risks.map((risk, idx) => {
              const sevColor =
                risk.severity === 'HIGH'
                  ? 'bg-red-500/15 text-red-300 border-red-500/40'
                  : risk.severity === 'MEDIUM'
                  ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                  : 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40';

              return (
                <div
                  key={idx}
                  className="p-4 rounded-xl bg-zinc-950/80 border border-zinc-800/90 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="font-semibold text-sm text-zinc-100">
                      {risk.title}
                    </h4>
                    <span
                      className={`px-2 py-0.5 text-[10px] font-mono font-bold rounded border ${sevColor}`}
                    >
                      {risk.severity}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-300 leading-relaxed">
                    {risk.description}
                  </p>
                  {risk.affectedFiles.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {risk.affectedFiles.map((file) => (
                        <code
                          key={file}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 font-mono text-[11px] text-amber-300"
                        >
                          <FileCode className="w-3 h-3" aria-hidden="true" />
                          {file}
                        </code>
                      ))}
                    </div>
                  )}
                  <div className="pt-1.5 border-t border-zinc-800/80 text-[11px] text-cyan-300 font-mono">
                    Fix: {risk.recommendation}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* New Developer Onboarding Guide */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 space-y-5">
        <div className="flex items-center gap-2.5 pb-3 border-b border-zinc-800">
          <Compass className="w-5 h-5 text-cyan-400" aria-hidden="true" />
          <div>
            <h3 className="text-base font-bold text-zinc-100">
              New Developer Onboarding Guide
            </h3>
            <p className="text-xs text-zinc-400">
              {review.onboardingGuide.overview}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Recommended Reading Order */}
          <div className="lg:col-span-2 space-y-3">
            <h4 className="text-xs font-mono uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
              <BookOpen className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
              Recommended Codebase Reading Order
            </h4>
            <div className="space-y-2.5">
              {review.onboardingGuide.readingOrder.map((step) => (
                <div
                  key={step.step}
                  className="flex items-start gap-3 p-3.5 rounded-xl bg-zinc-950 border border-zinc-800"
                >
                  <span className="w-6 h-6 rounded-lg bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 font-mono text-xs font-bold flex items-center justify-center shrink-0">
                    {step.step}
                  </span>
                  <div>
                    <code className="font-mono text-xs font-bold text-emerald-300">
                      {step.fileOrDir}
                    </code>
                    <p className="text-xs text-zinc-300 mt-1">{step.reason}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Entrypoints & Conventions */}
          <div className="space-y-4">
            <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 space-y-2.5">
              <h4 className="text-xs font-mono uppercase tracking-wider text-zinc-400">
                Primary Entrypoints
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {review.onboardingGuide.entryPoints.map((ep) => (
                  <code
                    key={ep}
                    className="px-2.5 py-1 rounded-md bg-zinc-900 border border-zinc-800 font-mono text-xs text-cyan-300"
                  >
                    {ep}
                  </code>
                ))}
              </div>
            </div>

            <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 space-y-2.5">
              <h4 className="text-xs font-mono uppercase tracking-wider text-zinc-400">
                Key Conventions
              </h4>
              <ul className="space-y-2">
                {review.onboardingGuide.keyConventions.map((conv, idx) => (
                  <li
                    key={idx}
                    className="flex items-start gap-2 text-xs text-zinc-300"
                  >
                    <CheckCircle2
                      className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5"
                      aria-hidden="true"
                    />
                    <span>{conv}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
