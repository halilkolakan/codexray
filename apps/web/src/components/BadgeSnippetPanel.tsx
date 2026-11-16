'use client';

import React, { useState } from 'react';
import { Copy, Check, Award } from 'lucide-react';

interface BadgeSnippetPanelProps {
  fullName: string;
  apiUrl: string;
  healthScore: number | null;
}

export function BadgeSnippetPanel({
  fullName,
  apiUrl,
  healthScore,
}: BadgeSnippetPanelProps) {
  const [copiedMd, setCopiedMd] = useState(false);
  const [copiedHtml, setCopiedHtml] = useState(false);

  const badgeUrl = `${apiUrl}/api/badge/${fullName}.svg`;
  const markdownSnippet = `![CodeXray](${badgeUrl})`;
  const htmlSnippet = `<img src="${badgeUrl}" alt="CodeXray Health Score" />`;

  const copyText = async (text: string, type: 'md' | 'html') => {
    try {
      await navigator.clipboard.writeText(text);
      if (type === 'md') {
        setCopiedMd(true);
        setTimeout(() => setCopiedMd(false), 2000);
      } else {
        setCopiedHtml(true);
        setTimeout(() => setCopiedHtml(false), 2000);
      }
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-800 pb-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
            <Award className="w-5 h-5" aria-hidden="true" />
          </div>
          <div>
            <h3 className="text-base font-bold text-zinc-100">
              Dynamic GitHub README Health Badge
            </h3>
            <p className="text-xs text-zinc-400">
              Embed your live CodeXray architecture score ({healthScore ?? 0}/100)
              directly in your repository README.md
            </p>
          </div>
        </div>

        {/* Live Rendered SVG Badge Preview */}
        <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl bg-zinc-950 border border-zinc-800">
          <span className="text-xs font-mono text-zinc-400">Live Preview:</span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={badgeUrl}
            alt={`CodeXray Score ${healthScore ?? 0}/100`}
            width={156}
            height={20}
            className="h-5 w-auto"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Markdown Snippet */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span
              id="badge-markdown-label"
              className="text-xs font-mono uppercase tracking-wider text-zinc-400"
            >
              Markdown (README.md)
            </span>
            <button
              type="button"
              onClick={() => copyText(markdownSnippet, 'md')}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-mono bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/30 transition"
            >
              {copiedMd ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                  Copied!
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                  Copy Markdown
                </>
              )}
            </button>
          </div>
          <pre
            role="region"
            aria-labelledby="badge-markdown-label"
            tabIndex={0}
            className="p-3.5 rounded-xl bg-zinc-950 border border-zinc-800 font-mono text-xs text-emerald-300 overflow-x-auto focus:outline-none focus:border-cyan-500"
          >
            <code>{markdownSnippet}</code>
          </pre>
        </div>

        {/* HTML Snippet */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span
              id="badge-html-label"
              className="text-xs font-mono uppercase tracking-wider text-zinc-400"
            >
              HTML Embed
            </span>
            <button
              type="button"
              onClick={() => copyText(htmlSnippet, 'html')}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-mono bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 transition"
            >
              {copiedHtml ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                  Copied!
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                  Copy HTML
                </>
              )}
            </button>
          </div>
          <pre
            role="region"
            aria-labelledby="badge-html-label"
            tabIndex={0}
            className="p-3.5 rounded-xl bg-zinc-950 border border-zinc-800 font-mono text-xs text-cyan-300 overflow-x-auto focus:outline-none focus:border-cyan-500"
          >
            <code>{htmlSnippet}</code>
          </pre>
        </div>
      </div>
    </div>
  );
}
