import { env } from './env';

export interface GitHubRepoMetadata {
  stars: number;
  defaultBranch: string;
}

export async function fetchGitHubRepoMetadata(
  owner: string,
  name: string
): Promise<GitHubRepoMetadata> {
  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'CodeXray-Analyzer/1.0',
    };
    if (env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
    }

    const res = await fetch(`https://api.github.com/repos/${owner}/${name}`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      return { stars: 0, defaultBranch: 'main' };
    }

    const data = (await res.json()) as {
      stargazers_count?: number;
      default_branch?: string;
    };

    return {
      stars:
        typeof data.stargazers_count === 'number' ? data.stargazers_count : 0,
      defaultBranch:
        typeof data.default_branch === 'string' ? data.default_branch : 'main',
    };
  } catch {
    return { stars: 0, defaultBranch: 'main' };
  }
}
