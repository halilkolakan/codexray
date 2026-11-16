import { Request, Router } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '@codexray/shared';
import { env } from './env';

export interface AuthTokenPayload {
  userId: string;
  githubId: string;
  username: string;
}

export function getOptionalUserFromRequest(req: Request): AuthTokenPayload | null {
  try {
    let token: string | undefined = req.cookies?.codexray_token;
    if (!token && req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.slice(7);
    }
    if (!token) return null;

    const decoded = jwt.verify(token, env.JWT_SECRET) as AuthTokenPayload;
    return decoded;
  } catch {
    return null;
  }
}

export const authRouter = Router();

authRouter.get('/github', (_req, res) => {
  if (!env.GITHUB_CLIENT_ID) {
    res.status(500).json({ error: 'GITHUB_CLIENT_ID is not configured' });
    return;
  }
  const redirectUri = `${env.API_URL}/api/auth/github/callback`;
  const url = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(
    env.GITHUB_CLIENT_ID
  )}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=read:user`;
  res.redirect(url);
});

authRouter.get('/github/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  if (!code) {
    res.redirect(`${env.WEB_URL}?authError=missing_code`);
    return;
  }

  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    const tokenData = (await tokenRes.json()) as { access_token?: string };
    if (!tokenData.access_token) {
      res.redirect(`${env.WEB_URL}?authError=token_exchange_failed`);
      return;
    }

    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'CodeXray-OAuth/1.0',
      },
    });

    if (!userRes.ok) {
      res.redirect(`${env.WEB_URL}?authError=github_user_failed`);
      return;
    }

    const ghUser = (await userRes.json()) as {
      id: number;
      login: string;
      avatar_url?: string;
    };

    const user = await prisma.user.upsert({
      where: { githubId: String(ghUser.id) },
      update: {
        username: ghUser.login,
        avatarUrl: ghUser.avatar_url || null,
      },
      create: {
        githubId: String(ghUser.id),
        username: ghUser.login,
        avatarUrl: ghUser.avatar_url || null,
      },
    });

    const token = jwt.sign(
      {
        userId: user.id,
        githubId: user.githubId,
        username: user.username,
      } satisfies AuthTokenPayload,
      env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.cookie('codexray_token', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.redirect(`${env.WEB_URL}?authToken=${encodeURIComponent(token)}`);
  } catch (err) {
    console.error('[OAuth Callback Error]:', err);
    res.redirect(`${env.WEB_URL}?authError=server_error`);
  }
});

authRouter.get('/me', async (req, res) => {
  const payload = getOptionalUserFromRequest(req);
  if (!payload) {
    res.json({ user: null });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: {
      id: true,
      githubId: true,
      username: true,
      avatarUrl: true,
      createdAt: true,
    },
  });

  res.json({ user });
});

authRouter.post('/logout', (_req, res) => {
  res.setHeader('Clear-Site-Data', '"cookies", "storage", "cache"');
  res.clearCookie('codexray_token');
  res.json({ ok: true });
});
