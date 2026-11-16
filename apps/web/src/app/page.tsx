'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  AnalysisJobDto,
  AnalysisJobStatus,
  AnalyzeResponseDto,
  JobProgressEvent,
} from '@codexray/shared';
import { DependencyGraphView } from '@/components/DependencyGraphView';
import { LiveTerminalProgress } from '@/components/LiveTerminalProgress';
import { AiReviewPanel } from '@/components/AiReviewPanel';
import { BadgeSnippetPanel } from '@/components/BadgeSnippetPanel';
import { LiveSandboxPanel } from '@/components/LiveSandboxPanel';
import {
  Activity,
  GitBranch,
  AlertTriangle,
  Cpu,
  FileCode2,
  Sparkles,
  Network,
  Award,
  History,
  Github,
  LogOut,
  Play,
  RefreshCw,
  Star,
  ArrowRight,
  Flame,
  CheckCircle2,
  TerminalSquare,
} from 'lucide-react';

const API_URL =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:4000';

const EXAMPLE_REPOS = [
  {
    label: 'expressjs/express',
    url: 'https://github.com/expressjs/express',
    tag: 'Run Live HTTP',
    runnable: true,
  },
  {
    label: 'pmndrs/zustand',
    url: 'https://github.com/pmndrs/zustand',
    tag: 'Run Live Store',
    runnable: true,
  },
  {
    label: 'lukeed/polka',
    url: 'https://github.com/lukeed/polka',
    tag: 'Fast Micro-Server',
    runnable: true,
  },
  {
    label: 'trpc/trpc',
    url: 'https://github.com/trpc/trpc',
    tag: 'Monorepo Graph',
    runnable: false,
  },
];

interface UserProfile {
  id: string;
  githubId: string;
  username: string;
  avatarUrl: string | null;
}

export default function CodeXrayPage() {
  const [repoUrl, setRepoUrl] = useState('https://github.com/expressjs/express');
  const [forceReanalyze, setForceReanalyze] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<AnalysisJobStatus | null>(null);
  const [progressPercent, setProgressPercent] = useState<number>(0);
  const [logs, setLogs] = useState<JobProgressEvent[]>([]);
  const [activeJob, setActiveJob] = useState<AnalysisJobDto | null>(null);

  const [activeTab, setActiveTab] = useState<
    'graph' | 'sandbox' | 'ai' | 'hotspots' | 'badge'
  >('graph');

  const [historyJobs, setHistoryJobs] = useState<AnalysisJobDto[]>([]);
  const [compareJob, setCompareJob] = useState<AnalysisJobDto | null>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const announcerRef = useRef<HTMLDivElement | null>(null);

  // Sync ARIA attributes for :user-invalid following modern-web-guidance
  const syncInputAria = useCallback(
    (el: HTMLInputElement | null, announce = false) => {
      if (!el) return;
      let isUserInvalid = false;
      try {
        isUserInvalid = el.matches(':user-invalid');
      } catch {
        isUserInvalid =
          !el.validity.valid && el.classList.contains('user-invalid-fallback');
      }

      const errorId = el.dataset.error || 'repo-url-error';
      const currentDesc = (el.getAttribute('aria-describedby') || '')
        .split(/\s+/)
        .filter((id) => id && id !== errorId);

      if (isUserInvalid) {
        el.setAttribute('aria-invalid', 'true');
        currentDesc.push(errorId);
        el.setAttribute('aria-describedby', currentDesc.join(' '));
        if (announce && announcerRef.current) {
          announcerRef.current.textContent =
            'Repository URL: Error: Enter a GitHub repository URL in the format https://github.com/owner/repo.';
        }
      } else {
        el.setAttribute('aria-invalid', 'false');
        if (currentDesc.length > 0) {
          el.setAttribute('aria-describedby', currentDesc.join(' '));
        } else {
          el.removeAttribute('aria-describedby');
        }
        if (announcerRef.current) {
          announcerRef.current.textContent = '';
        }
      }
    },
    []
  );

  const fetchHistory = useCallback(async (token?: string | null) => {
    try {
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(`${API_URL}/api/history`, {
        headers,
        credentials: 'include',
      });
      if (!res.ok) return;
      const data = (await res.json()) as { jobs?: AnalysisJobDto[] };
      if (data.jobs) {
        setHistoryJobs(data.jobs);
      }
    } catch {
      // ignore offline history fetch
    }
  }, []);

  const fetchJobResult = useCallback(
    async (jobId: string) => {
      try {
        const res = await fetch(`${API_URL}/api/jobs/${jobId}`);
        if (!res.ok) return;
        const job = (await res.json()) as AnalysisJobDto;
        setActiveJob(job);
        setJobStatus(job.status);
        if (job.status === 'COMPLETED') {
          setProgressPercent(100);
          void fetchHistory(authToken);
        } else if (job.status === 'FAILED') {
          setSubmitError(job.errorMessage || 'Repository analysis failed');
        }
      } catch (err) {
        console.error('Failed to fetch job details:', err);
      }
    },
    [authToken, fetchHistory]
  );

  // Initialize Auth & load most recent completed analysis on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tokenFromUrl = params.get('authToken');
    if (tokenFromUrl) {
      localStorage.setItem('codexray_token', tokenFromUrl);
      setAuthToken(tokenFromUrl);
      window.history.replaceState({}, '', window.location.pathname);
    } else {
      const saved = localStorage.getItem('codexray_token');
      if (saved) setAuthToken(saved);
    }

    const activeTok = tokenFromUrl || localStorage.getItem('codexray_token');
    const headers: Record<string, string> = {};
    if (activeTok) headers.Authorization = `Bearer ${activeTok}`;

    fetch(`${API_URL}/api/auth/me`, { headers, credentials: 'include' })
      .then((r) => r.json())
      .then((d: { user?: UserProfile | null }) => {
        if (d.user) setUser(d.user);
      })
      .catch(() => {});

    fetch(`${API_URL}/api/history`, { headers, credentials: 'include' })
      .then((r) => r.json())
      .then((d: { jobs?: AnalysisJobDto[] }) => {
        if (d.jobs && d.jobs.length > 0) {
          setHistoryJobs(d.jobs);
          void fetchJobResult(d.jobs[0].id);
        }
      })
      .catch(() => {});
  }, [fetchJobResult]);

  // Manage Socket.io connection & room subscription
  useEffect(() => {
    if (!activeJobId) return;

    const socket = io(WS_URL, {
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('subscribe:job', activeJobId);
    });

    socket.on('job:progress', (event: JobProgressEvent) => {
      if (event.jobId !== activeJobId) return;
      setJobStatus(event.status);
      setProgressPercent(event.progressPercent);
      setLogs((prev) => [...prev, event]);

      if (event.status === 'COMPLETED' || event.status === 'FAILED') {
        void fetchJobResult(event.jobId);
      }
    });

    return () => {
      socket.emit('unsubscribe:job', activeJobId);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [activeJobId, fetchJobResult]);

  const startAnalysis = async (
    targetUrl: string,
    force = false,
    switchToSandbox = false
  ) => {
    setSubmitError(null);
    setIsSubmitting(true);
    setRepoUrl(targetUrl);
    if (switchToSandbox) {
      setActiveTab('sandbox');
    }

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (authToken) {
        headers.Authorization = `Bearer ${authToken}`;
      }

      const res = await fetch(`${API_URL}/api/analyze`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify({
          repoUrl: targetUrl.trim(),
          force,
        }),
      });

      const data = (await res.json()) as AnalyzeResponseDto & { error?: string };
      if (!res.ok) {
        throw new Error(data.error || 'Failed to start repository analysis');
      }

      if (data.cached && data.job) {
        setActiveJob(data.job);
        setActiveJobId(null);
        setJobStatus('COMPLETED');
        setProgressPercent(100);
        setLogs([
          {
            jobId: data.job.id,
            status: 'COMPLETED',
            step: 'Loaded from Cache (<10m)',
            logLine: `Served recent cached analysis for ${data.job.repository.fullName}. Enable "Force fresh run" to re-clone.`,
            progressPercent: 100,
            timestamp: new Date().toISOString(),
          },
        ]);
        void fetchHistory(authToken);
      } else {
        setActiveJob(null);
        setLogs([
          {
            jobId: data.jobId,
            status: 'QUEUED',
            step: 'Queued in BullMQ',
            logLine: `Job ${data.jobId} enqueued to BullMQ repo-analysis queue...`,
            progressPercent: 5,
            timestamp: new Date().toISOString(),
          },
        ]);
        setJobStatus('QUEUED');
        setProgressPercent(5);
        setActiveJobId(data.jobId);
      }
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : 'Unexpected error submitting URL'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFormSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (inputRef.current && !inputRef.current.checkValidity()) {
      inputRef.current.classList.add('user-invalid-fallback');
      syncInputAria(inputRef.current, true);
      inputRef.current.focus();
      return;
    }
    void startAnalysis(repoUrl, forceReanalyze);
  };

  const handleLogout = async () => {
    localStorage.removeItem('codexray_token');
    setAuthToken(null);
    setUser(null);
    try {
      await fetch(`${API_URL}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // ignore
    }
  };

  const handleSelectTab = (
    tab: 'graph' | 'sandbox' | 'ai' | 'hotspots' | 'badge',
    e: React.MouseEvent<HTMLButtonElement>
  ) => {
    setActiveTab(tab);
    e.currentTarget.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    });
  };

  const isRunning =
    jobStatus === 'QUEUED' ||
    jobStatus === 'CLONING' ||
    jobStatus === 'PARSING' ||
    jobStatus === 'AI_REVIEW';

  const scoreColor =
    (activeJob?.healthScore ?? 0) >= 80
      ? 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10'
      : (activeJob?.healthScore ?? 0) >= 60
      ? 'text-amber-400 border-amber-500/40 bg-amber-500/10'
      : 'text-red-400 border-red-500/40 bg-red-500/10';

  return (
    <div className="min-h-screen flex flex-col bg-zinc-950 text-zinc-100">
      {/* Polite Live Region for Accessible Form Validation */}
      <div
        ref={announcerRef}
        aria-live="polite"
        className="visually-hidden"
      />

      {/* Top Navigation Bar */}
      <header className="sticky top-0 z-30 border-b border-zinc-800/80 bg-zinc-950/85 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-cyan-500/20 to-emerald-500/20 border border-cyan-500/40 flex items-center justify-center shadow-[0_0_20px_rgba(34,211,238,0.2)]">
              <Activity
                className="w-5 h-5 text-cyan-400"
                aria-hidden="true"
              />
            </div>
            <div>
              <span className="font-mono text-base font-bold tracking-tight text-zinc-100">
                Code<span className="text-cyan-400">Xray</span>
              </span>
              <span className="hidden sm:inline-block ml-2.5 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider rounded bg-zinc-900 border border-zinc-800 text-emerald-400">
                AST + WebContainers + Gemini AI
              </span>
            </div>
          </div>

          <nav
            aria-label="Primary navigation"
            className="flex items-center gap-3"
          >
            {historyJobs.length > 0 && (
              <div className="hidden md:flex items-center gap-2 bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5">
                <History
                  className="w-3.5 h-3.5 text-cyan-400"
                  aria-hidden="true"
                />
                <label
                  htmlFor="history-select"
                  className="text-xs font-mono text-zinc-400"
                >
                  Recent:
                </label>
                <select
                  id="history-select"
                  value={activeJob?.id || ''}
                  onChange={(e) => {
                    if (e.target.value) {
                      void fetchJobResult(e.target.value);
                    }
                  }}
                  className="bg-transparent text-xs font-mono text-zinc-100 focus:outline-none cursor-pointer"
                >
                  {historyJobs.map((h) => (
                    <option
                      key={h.id}
                      value={h.id}
                      className="bg-zinc-900 text-zinc-100"
                    >
                      {h.repository.fullName} ({h.healthScore}/100)
                    </option>
                  ))}
                </select>
              </div>
            )}

            {user ? (
              <div className="flex items-center gap-2.5 pl-2">
                {user.avatarUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={user.avatarUrl}
                    alt={user.username}
                    width={28}
                    height={28}
                    className="w-7 h-7 rounded-full border border-zinc-700"
                  />
                )}
                <span className="text-xs font-mono text-zinc-300 hidden sm:inline">
                  {user.username}
                </span>
                <button
                  type="button"
                  onClick={handleLogout}
                  aria-label="Sign out"
                  className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-400 hover:text-zinc-200 transition"
                >
                  <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            ) : (
              <a
                href={`${API_URL}/api/auth/github`}
                className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs font-mono font-medium text-zinc-200 transition"
              >
                <Github className="w-3.5 h-3.5" aria-hidden="true" />
                Sign in with GitHub
              </a>
            )}
          </nav>
        </div>
      </header>

      <main className="flex-1 max-w-[1600px] w-full mx-auto px-4 sm:px-6 py-8 space-y-8">
        {/* Landing / Analyzer Hero */}
        <section
          aria-labelledby="hero-heading"
          className="relative rounded-3xl border border-zinc-800/90 bg-gradient-to-b from-zinc-900/90 via-zinc-900/50 to-zinc-950 p-6 sm:p-10 overflow-hidden shadow-2xl"
        >
          <div className="max-w-3xl mx-auto text-center space-y-4">
            {/* Scannable Capability Pill Banner */}
            <div className="flex flex-wrap items-center justify-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-xs font-mono">
                <Network className="w-3.5 h-3.5" aria-hidden="true" />
                1. AST Dependency Graph
              </span>
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-xs font-mono font-semibold">
                <TerminalSquare className="w-3.5 h-3.5" aria-hidden="true" />
                2. Live Browser Sandbox (WebContainers)
              </span>
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-purple-500/10 border border-purple-500/30 text-purple-300 text-xs font-mono">
                <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                3. Gemini Principal AI Audit
              </span>
            </div>

            <h1
              id="hero-heading"
              className="text-2xl sm:text-4xl font-extrabold tracking-tight text-zinc-100"
            >
              X-Ray Architecture &amp; Run GitHub Repos Live in Your Browser
            </h1>

            <p className="text-sm sm:text-base text-zinc-400 max-w-2xl mx-auto">
              Visualizes TypeScript/JavaScript AST module dependencies, detects
              DFS circular chains, generates a Gemini Principal Engineer review,
              and boots an interactive Node.js WebContainer sandbox with zero
              local setup.
            </p>

            {/* Analyzer Form with Deferred :user-invalid Validation */}
            <form
              onSubmit={handleFormSubmit}
              noValidate
              className="pt-3 text-left max-w-2xl mx-auto space-y-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label
                  htmlFor="repo-url-input"
                  className="text-xs font-mono font-semibold text-zinc-300"
                >
                  Public GitHub Repository URL
                </label>
                <span
                  id="repo-url-hint"
                  className="text-[11px] font-mono text-zinc-400"
                >
                  Format: https://github.com/owner/repo
                </span>
              </div>

              <div className="flex flex-col sm:flex-row gap-2.5">
                <input
                  ref={inputRef}
                  type="url"
                  id="repo-url-input"
                  name="repoUrl"
                  value={repoUrl}
                  onChange={(e) => {
                    setRepoUrl(e.target.value);
                    syncInputAria(e.currentTarget, false);
                  }}
                  onBlur={(e) => syncInputAria(e.currentTarget, true)}
                  required
                  pattern="https://github\.com/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+"
                  placeholder="https://github.com/owner/repo"
                  aria-describedby="repo-url-hint"
                  aria-invalid="false"
                  data-error="repo-url-error"
                  className="repo-url-input flex-1 px-4 py-3 rounded-xl bg-zinc-950 border border-zinc-700 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-cyan-400 transition"
                />

                <button
                  type="submit"
                  disabled={isSubmitting || isRunning}
                  className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-emerald-500 hover:from-cyan-400 hover:to-emerald-400 disabled:opacity-50 text-zinc-950 font-mono text-sm font-bold shadow-[0_0_25px_rgba(34,211,238,0.3)] transition shrink-0"
                >
                  {isSubmitting || isRunning ? (
                    <>
                      <RefreshCw
                        className="w-4 h-4 animate-spin"
                        aria-hidden="true"
                      />
                      Analyzing...
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4 fill-current" aria-hidden="true" />
                      Analyze Repo
                    </>
                  )}
                </button>
              </div>

              <div
                id="repo-url-error"
                className="repo-error-msg items-center gap-2 text-xs font-mono text-red-400 pt-1"
              >
                <span role="img" aria-label="Error">
                  ❌
                </span>
                <span>
                  Enter a valid GitHub repository URL in the format
                  https://github.com/owner/repo.
                </span>
              </div>

              {submitError && (
                <div
                  role="alert"
                  className="p-3 rounded-xl bg-red-950/60 border border-red-500/40 text-xs font-mono text-red-200 flex items-center gap-2"
                >
                  <AlertTriangle
                    className="w-4 h-4 text-red-400 shrink-0"
                    aria-hidden="true"
                  />
                  <span>{submitError}</span>
                </div>
              )}

              {/* One-Click "Try & Run Live" Example Repo Chips & Force Toggle */}
              <div className="pt-3 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-mono text-zinc-400">
                    Try &amp; Run Live:
                  </span>
                  {EXAMPLE_REPOS.map((ex) => (
                    <button
                      key={ex.label}
                      type="button"
                      disabled={isSubmitting || isRunning}
                      onClick={() => {
                        setRepoUrl(ex.url);
                        void startAnalysis(ex.url, forceReanalyze, ex.runnable);
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-zinc-950 hover:bg-zinc-800 border border-zinc-800 hover:border-cyan-500/50 text-xs font-mono text-zinc-200 transition"
                    >
                      <GitBranch
                        className={`w-3 h-3 ${
                          ex.runnable ? 'text-emerald-400' : 'text-cyan-400'
                        }`}
                        aria-hidden="true"
                      />
                      <span>{ex.label}</span>
                      <span
                        className={`text-[10px] ${
                          ex.runnable ? 'text-emerald-400/90' : 'text-zinc-500'
                        }`}
                      >
                        ({ex.tag})
                      </span>
                    </button>
                  ))}
                </div>

                <label className="inline-flex items-center gap-2 text-xs font-mono text-zinc-400 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={forceReanalyze}
                    onChange={(e) => setForceReanalyze(e.target.checked)}
                    className="rounded border-zinc-700 bg-zinc-900"
                  />
                  Force fresh run (bypass 10m cache)
                </label>
              </div>
            </form>
          </div>
        </section>

        {/* Live Terminal Progress View (Shown while job is running) */}
        {isRunning && (
          <LiveTerminalProgress
            status={jobStatus}
            progressPercent={progressPercent}
            logs={logs}
            repoName={repoUrl.replace('https://github.com/', '')}
          />
        )}

        {/* Interactive Architecture Dashboard */}
        {activeJob && activeJob.status === 'COMPLETED' && activeJob.metricsJson && (
          <section
            aria-label="Repository Architecture Analysis Dashboard"
            className="space-y-6"
          >
            {/* Repo Banner & Status Strip */}
            <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 rounded-2xl border border-zinc-800 bg-zinc-900/60">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="font-mono text-lg font-bold text-zinc-100 flex items-center gap-2">
                  <GitBranch
                    className="w-5 h-5 text-cyan-400"
                    aria-hidden="true"
                  />
                  {activeJob.repository.fullName}
                </h2>
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-mono bg-amber-500/10 text-amber-300 border border-amber-500/30">
                  <Star className="w-3 h-3 fill-current" aria-hidden="true" />
                  {activeJob.repository.stars.toLocaleString()}
                </span>
                <span className="px-2.5 py-0.5 rounded-full text-xs font-mono bg-zinc-800 text-zinc-300">
                  branch: {activeJob.repository.defaultBranch}
                </span>
              </div>

              <div className="flex items-center gap-3 text-xs font-mono text-zinc-400">
                <button
                  type="button"
                  onClick={() => setActiveTab('sandbox')}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/40 font-semibold transition"
                >
                  <TerminalSquare className="w-3.5 h-3.5" aria-hidden="true" />
                  Open Live Sandbox
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void startAnalysis(
                      `https://github.com/${activeJob.repository.fullName}`,
                      true
                    )
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition"
                >
                  <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                  Re-run
                </button>
              </div>
            </div>

            {/* Health Score & KPI Strip */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div
                className={`rounded-2xl border p-5 flex items-center justify-between ${scoreColor}`}
              >
                <div>
                  <span className="text-xs font-mono uppercase tracking-wider opacity-80 block">
                    Architecture Health Score
                  </span>
                  <div className="text-3xl font-extrabold font-mono mt-1">
                    {activeJob.healthScore ?? 0}
                    <span className="text-base font-normal opacity-75">
                      /100
                    </span>
                  </div>
                  <span className="text-[11px] font-mono opacity-85 mt-1 block">
                    {(activeJob.healthScore ?? 0) >= 80
                      ? 'Low coupling • Production Grade'
                      : (activeJob.healthScore ?? 0) >= 60
                      ? 'Moderate hub/cycle coupling'
                      : 'High cyclic / hub complexity'}
                  </span>
                </div>
                <Activity className="w-10 h-10 opacity-80" aria-hidden="true" />
              </div>

              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 flex items-center justify-between">
                <div>
                  <span className="text-xs font-mono uppercase tracking-wider text-zinc-400 block">
                    Total Modules Analyzed
                  </span>
                  <div className="text-3xl font-extrabold font-mono text-zinc-100 mt-1">
                    {activeJob.metricsJson.fileCount.toLocaleString()}
                  </div>
                  <span className="text-[11px] font-mono text-cyan-400 mt-1 block">
                    {activeJob.metricsJson.totalLoc.toLocaleString()} total LOC
                    (avg {activeJob.metricsJson.avgLoc} LOC/file)
                  </span>
                </div>
                <FileCode2
                  className="w-9 h-9 text-cyan-400/80"
                  aria-hidden="true"
                />
              </div>

              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 flex items-center justify-between">
                <div>
                  <span className="text-xs font-mono uppercase tracking-wider text-zinc-400 block">
                    Circular Dependencies
                  </span>
                  <div
                    className={`text-3xl font-extrabold font-mono mt-1 ${
                      activeJob.metricsJson.circularDependencyCount === 0
                        ? 'text-emerald-400'
                        : 'text-red-400'
                    }`}
                  >
                    {activeJob.metricsJson.circularDependencyCount}
                  </div>
                  <span className="text-[11px] font-mono text-zinc-400 mt-1 block">
                    {activeJob.metricsJson.circularDependencyCount === 0
                      ? 'Strict Acyclic Graph (DAG)'
                      : 'Mutual import cycles detected'}
                  </span>
                </div>
                {activeJob.metricsJson.circularDependencyCount === 0 ? (
                  <CheckCircle2
                    className="w-9 h-9 text-emerald-400/80"
                    aria-hidden="true"
                  />
                ) : (
                  <AlertTriangle
                    className="w-9 h-9 text-red-400/80"
                    aria-hidden="true"
                  />
                )}
              </div>

              <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 flex items-center justify-between min-w-0">
                <div className="min-w-0 pr-2">
                  <span className="text-xs font-mono uppercase tracking-wider text-zinc-400 block">
                    Most Coupled Hub File
                  </span>
                  <div
                    className="text-sm font-bold font-mono text-amber-300 truncate mt-2"
                    title={activeJob.metricsJson.mostCoupledFile || 'N/A'}
                  >
                    {activeJob.metricsJson.mostCoupledFile || 'N/A'}
                  </div>
                  <span className="text-[11px] font-mono text-zinc-400 mt-1.5 block">
                    Max Fan-In: {activeJob.metricsJson.maxFanIn} • Max Fan-Out:{' '}
                    {activeJob.metricsJson.maxFanOut}
                  </span>
                </div>
                <Cpu
                  className="w-9 h-9 text-amber-400/80 shrink-0"
                  aria-hidden="true"
                />
              </div>
            </div>

            {/* Clean Wrapping Dashboard Tablist */}
            <div
              role="tablist"
              aria-label="Architecture analysis and live sandbox views"
              className="flex flex-wrap items-center gap-2 border-b border-zinc-800 pb-3"
            >
              <button
                type="button"
                role="tab"
                id="tab-graph"
                aria-selected={activeTab === 'graph'}
                onClick={(e) => handleSelectTab('graph', e)}
                className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl font-mono text-xs font-semibold transition ${
                  activeTab === 'graph'
                    ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/40'
                    : 'bg-zinc-900/60 text-zinc-400 hover:text-zinc-200 border border-zinc-800'
                }`}
              >
                <Network className="w-4 h-4" aria-hidden="true" />
                Interactive Dependency Graph (
                {activeJob.graphJson?.nodes.length || 0} Nodes)
              </button>

              <button
                type="button"
                role="tab"
                id="tab-sandbox"
                aria-selected={activeTab === 'sandbox'}
                onClick={(e) => handleSelectTab('sandbox', e)}
                className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl font-mono text-xs font-semibold transition ${
                  activeTab === 'sandbox'
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/50 shadow-[0_0_18px_rgba(16,185,129,0.2)]'
                    : 'bg-emerald-950/30 text-emerald-300/90 hover:text-emerald-200 border border-emerald-500/30'
                }`}
              >
                <TerminalSquare className="w-4 h-4" aria-hidden="true" />
                Live Sandbox (Run in Browser)
                <span className="px-1.5 py-0.5 text-[10px] rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                  WebContainers
                </span>
              </button>

              <button
                type="button"
                role="tab"
                id="tab-ai"
                aria-selected={activeTab === 'ai'}
                onClick={(e) => handleSelectTab('ai', e)}
                className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl font-mono text-xs font-semibold transition ${
                  activeTab === 'ai'
                    ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/40'
                    : 'bg-zinc-900/60 text-zinc-400 hover:text-zinc-200 border border-zinc-800'
                }`}
              >
                <Sparkles className="w-4 h-4" aria-hidden="true" />
                AI Senior Engineer Review
              </button>

              <button
                type="button"
                role="tab"
                id="tab-hotspots"
                aria-selected={activeTab === 'hotspots'}
                onClick={(e) => handleSelectTab('hotspots', e)}
                className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl font-mono text-xs font-semibold transition ${
                  activeTab === 'hotspots'
                    ? 'bg-amber-500/15 text-amber-300 border border-amber-500/40'
                    : 'bg-zinc-900/60 text-zinc-400 hover:text-zinc-200 border border-zinc-800'
                }`}
              >
                <Flame className="w-4 h-4" aria-hidden="true" />
                Hotspots &amp; Circular Chains
              </button>

              <button
                type="button"
                role="tab"
                id="tab-badge"
                aria-selected={activeTab === 'badge'}
                onClick={(e) => handleSelectTab('badge', e)}
                className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl font-mono text-xs font-semibold transition ${
                  activeTab === 'badge'
                    ? 'bg-purple-500/15 text-purple-300 border border-purple-500/40'
                    : 'bg-zinc-900/60 text-zinc-400 hover:text-zinc-200 border border-zinc-800'
                }`}
              >
                <Award className="w-4 h-4" aria-hidden="true" />
                README Badge &amp; Compare History
              </button>
            </div>

            {/* Tab 1: Interactive React Flow Dependency Graph */}
            {activeTab === 'graph' && activeJob.graphJson && (
              <div role="tabpanel" aria-labelledby="tab-graph">
                <DependencyGraphView
                  key={activeJob.id}
                  graph={activeJob.graphJson}
                />
              </div>
            )}

            {/* Tab 2: Live Browser Sandbox (WebContainers) */}
            {activeTab === 'sandbox' && (
              <div role="tabpanel" aria-labelledby="tab-sandbox">
                <LiveSandboxPanel
                  key={activeJob.id}
                  jobId={activeJob.id}
                  fullName={activeJob.repository.fullName}
                  apiUrl={API_URL}
                />
              </div>
            )}

            {/* Tab 3: AI Senior Engineer Review */}
            {activeTab === 'ai' && activeJob.aiReviewJson && (
              <div role="tabpanel" aria-labelledby="tab-ai">
                <AiReviewPanel review={activeJob.aiReviewJson} />
              </div>
            )}

            {/* Tab 4: Hotspots & Circular Dependencies Table */}
            {activeTab === 'hotspots' && (
              <div
                role="tabpanel"
                aria-labelledby="tab-hotspots"
                className="grid grid-cols-1 lg:grid-cols-3 gap-6"
              >
                <div className="lg:col-span-2 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6">
                  <h3 className="text-base font-bold text-zinc-100 mb-4 flex items-center gap-2">
                    <Flame
                      className="w-4 h-4 text-amber-400"
                      aria-hidden="true"
                    />
                    Top Coupled Hotspot Modules
                  </h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse font-mono text-xs">
                      <thead>
                        <tr className="border-b border-zinc-800 text-zinc-400">
                          <th className="py-2.5 px-3">Module Path</th>
                          <th className="py-2.5 px-3">LOC</th>
                          <th className="py-2.5 px-3">Fan-In</th>
                          <th className="py-2.5 px-3">Fan-Out</th>
                          <th className="py-2.5 px-3">Coupling</th>
                          <th className="py-2.5 px-3">Cycle</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-800/60">
                        {activeJob.metricsJson.hotspotFiles.map((h) => (
                          <tr
                            key={h.filePath}
                            className="hover:bg-zinc-800/40 transition"
                          >
                            <td className="py-2.5 px-3 text-cyan-300 font-medium">
                              {h.filePath}
                            </td>
                            <td className="py-2.5 px-3 text-zinc-300">
                              {h.loc}
                            </td>
                            <td className="py-2.5 px-3 text-emerald-400">
                              {h.fanIn}
                            </td>
                            <td className="py-2.5 px-3 text-cyan-400">
                              {h.fanOut}
                            </td>
                            <td className="py-2.5 px-3 text-amber-300 font-bold">
                              {h.couplingScore}
                            </td>
                            <td className="py-2.5 px-3">
                              {h.inCycle ? (
                                <span className="px-2 py-0.5 rounded bg-red-500/20 text-red-300 border border-red-500/40 text-[10px]">
                                  CYCLE
                                </span>
                              ) : (
                                <span className="text-zinc-500">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 space-y-4">
                  <h3 className="text-base font-bold text-zinc-100 flex items-center gap-2">
                    <AlertTriangle
                      className="w-4 h-4 text-red-400"
                      aria-hidden="true"
                    />
                    Circular Dependency Chains (
                    {activeJob.metricsJson.circularDependencyCount})
                  </h3>
                  {activeJob.metricsJson.circularDependencies.length === 0 ? (
                    <div className="p-4 rounded-xl bg-emerald-950/30 border border-emerald-500/30 text-xs font-mono text-emerald-300">
                      Zero circular dependencies detected! Every module import
                      forms a clean Directed Acyclic Graph (DAG).
                    </div>
                  ) : (
                    <ul className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
                      {activeJob.metricsJson.circularDependencies.map(
                        (cycle, idx) => (
                          <li
                            key={idx}
                            className="p-3 rounded-xl bg-red-950/30 border border-red-500/30 font-mono text-xs text-red-200 space-y-1"
                          >
                            <span className="text-[10px] uppercase text-red-400 font-bold block">
                              Cycle #{idx + 1}
                            </span>
                            <div className="flex flex-wrap items-center gap-1">
                              {cycle.map((node, nIdx) => (
                                <React.Fragment key={`${node}-${nIdx}`}>
                                  <code className="px-1.5 py-0.5 rounded bg-zinc-950 text-red-300">
                                    {node}
                                  </code>
                                  {nIdx < cycle.length - 1 && (
                                    <ArrowRight
                                      className="w-3 h-3 text-red-400"
                                      aria-hidden="true"
                                    />
                                  )}
                                </React.Fragment>
                              ))}
                            </div>
                          </li>
                        )
                      )}
                    </ul>
                  )}
                </div>
              </div>
            )}

            {/* Tab 5: Shareable README Badge & Past Analyses Comparison */}
            {activeTab === 'badge' && (
              <div
                role="tabpanel"
                aria-labelledby="tab-badge"
                className="space-y-6"
              >
                <BadgeSnippetPanel
                  fullName={activeJob.repository.fullName}
                  apiUrl={API_URL}
                  healthScore={activeJob.healthScore}
                />

                <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-4">
                    <div>
                      <h3 className="text-base font-bold text-zinc-100">
                        Compare Against Past Repository Analyses
                      </h3>
                      <p className="text-xs text-zinc-400">
                        Select any previously analyzed repository to benchmark
                        architectural health and coupling metrics side-by-side
                      </p>
                    </div>
                    <select
                      aria-label="Select past analysis to compare"
                      value={compareJob?.id || ''}
                      onChange={async (e) => {
                        const id = e.target.value;
                        if (!id) {
                          setCompareJob(null);
                          return;
                        }
                        const res = await fetch(`${API_URL}/api/jobs/${id}`);
                        if (res.ok) {
                          setCompareJob((await res.json()) as AnalysisJobDto);
                        }
                      }}
                      className="px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-xs font-mono text-zinc-200"
                    >
                      <option value="">Select repository to compare...</option>
                      {historyJobs
                        .filter((h) => h.id !== activeJob.id)
                        .map((h) => (
                          <option key={h.id} value={h.id}>
                            {h.repository.fullName} — Score {h.healthScore}/100
                          </option>
                        ))}
                    </select>
                  </div>

                  {compareJob && compareJob.metricsJson ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 font-mono text-xs">
                      <div className="p-4 rounded-xl bg-zinc-950 border border-cyan-500/40 space-y-2">
                        <span className="text-[10px] uppercase text-cyan-400">
                          Current Repository
                        </span>
                        <h4 className="text-base font-bold text-zinc-100">
                          {activeJob.repository.fullName}
                        </h4>
                        <div className="grid grid-cols-2 gap-2 pt-2">
                          <div>
                            Health Score:{' '}
                            <strong className="text-emerald-400">
                              {activeJob.healthScore}/100
                            </strong>
                          </div>
                          <div>
                            Files:{' '}
                            <strong>{activeJob.metricsJson.fileCount}</strong>
                          </div>
                          <div>
                            Total LOC:{' '}
                            <strong>
                              {activeJob.metricsJson.totalLoc.toLocaleString()}
                            </strong>
                          </div>
                          <div>
                            Cycles:{' '}
                            <strong>
                              {activeJob.metricsJson.circularDependencyCount}
                            </strong>
                          </div>
                        </div>
                      </div>

                      <div className="p-4 rounded-xl bg-zinc-950 border border-purple-500/40 space-y-2">
                        <span className="text-[10px] uppercase text-purple-400">
                          Comparison Benchmark
                        </span>
                        <h4 className="text-base font-bold text-zinc-100">
                          {compareJob.repository.fullName}
                        </h4>
                        <div className="grid grid-cols-2 gap-2 pt-2">
                          <div>
                            Health Score:{' '}
                            <strong className="text-purple-300">
                              {compareJob.healthScore}/100
                            </strong>
                          </div>
                          <div>
                            Files:{' '}
                            <strong>{compareJob.metricsJson.fileCount}</strong>
                          </div>
                          <div>
                            Total LOC:{' '}
                            <strong>
                              {compareJob.metricsJson.totalLoc.toLocaleString()}
                            </strong>
                          </div>
                          <div>
                            Cycles:{' '}
                            <strong>
                              {compareJob.metricsJson.circularDependencyCount}
                            </strong>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs font-mono text-zinc-500">
                      Analyze two or more repositories and select one from the
                      dropdown above to compare metrics side-by-side.
                    </p>
                  )}
                </div>
              </div>
            )}
          </section>
        )}
      </main>

      <footer className="border-t border-zinc-900 py-6 text-center text-xs font-mono text-zinc-500">
        CodeXray — Real-Time AST Dependency Graph Visualizer, WebContainers Live
        Sandbox &amp; Gemini AI Architecture Reviewer
      </footer>
    </div>
  );
}
