import { Router, Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { db } from '../db/index.js';
import { env } from '../config/env.js';
import { validateRequest } from '../middleware/validate.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { randomUUID } from 'crypto';
import { getAddress, verifyMessage } from 'ethers';

const router = Router();

const walletChallenges = new Map<string, { nonce: string; message: string; expiresAt: number }>();
const WALLET_CHALLENGE_TTL_MS = 5 * 60_000;

const walletAddressSchema = z.string().transform((value, ctx) => {
  try {
    return getAddress(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A valid EVM wallet address is required' });
    return z.NEVER;
  }
});
const localWalletIdentifierSchema = z.coerce.string().trim().min(1, 'A local wallet identifier is required').max(100);

const issueToken = (user: (typeof db.users)[number]) => jwt.sign(
  { id: user.id, seed_id: user.seed_id, role: user.role },
  env.JWT_SECRET,
  { expiresIn: '24h' }
);

const findOrCreateWalletUser = async (address: string): Promise<(typeof db.users)[number]> => {
  const normalized = address.toLowerCase();
  const seedId = `wallet:${normalized}`;

  return await db.findOrCreateUserDurable({
    seed_id: seedId,
    display_name: `Traveler ${address.slice(0, 6)}…${address.slice(-4)}`,
    email: `${normalized.slice(2)}@wallet.juanderquest.local`,
    avatar_url: `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(normalized)}`,
    role: 'user',
    demo_points: 100,
    mjdq_balance: 100000,
    jdq_governance_balance: 15,
    scout_reputation: 250,
    is_public: false,
    handle: null,
    bio: null,
    status_text: null,
  });
};

router.get('/auth/wallet/config', (_req, res) => res.status(200).json({
  success: true,
  data: { mode: env.WALLET_AUTH_MODE },
}));

router.post(
  '/auth/wallet/challenge',
  rateLimit({ policyId: 'auth:wallet-challenge', windowMs: 60_000, max: 20 }),
  validateRequest(z.object({ body: z.object({ address: walletAddressSchema }) })),
  (req, res) => {
    if (env.WALLET_AUTH_MODE !== 'signature') {
      return res.status(409).json({
        success: false,
        error: { code: 'AUTH_MODE_MISMATCH', message: 'Wallet signatures are disabled in local auth mode.' },
      });
    }
    const address = getAddress(req.body.address);
    const nonce = randomUUID();
    const message = [
      'Sign in to JuanDerQuest',
      '',
      `Wallet: ${address}`,
      `Nonce: ${nonce}`,
      'This request does not trigger a blockchain transaction or cost gas.',
    ].join('\n');
    walletChallenges.set(address.toLowerCase(), { nonce, message, expiresAt: Date.now() + WALLET_CHALLENGE_TTL_MS });
    return res.status(200).json({ success: true, data: { message, expires_in_seconds: 300 } });
  }
);

router.post(
  '/auth/wallet/login',
  rateLimit({ policyId: 'auth:wallet-login', windowMs: 60_000, max: 20 }),
  validateRequest(z.object({ body: z.object({ address: walletAddressSchema, signature: z.string().min(1) }) })),
  async (req, res) => {
    if (env.WALLET_AUTH_MODE !== 'signature') {
      return res.status(409).json({
        success: false,
        error: { code: 'AUTH_MODE_MISMATCH', message: 'Use the local wallet bypass in local auth mode.' },
      });
    }
    const address = getAddress(req.body.address);
    const key = address.toLowerCase();
    const challenge = walletChallenges.get(key);
    walletChallenges.delete(key);
    if (!challenge || challenge.expiresAt <= Date.now()) {
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_CHALLENGE', message: 'Wallet challenge is missing, expired, or already used.' },
      });
    }
    try {
      const recovered = getAddress(verifyMessage(challenge.message, req.body.signature));
      if (recovered !== address) throw new Error('Address mismatch');
    } catch {
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_SIGNATURE', message: 'The wallet signature could not be verified.' },
      });
    }
    try {
      const user = await findOrCreateWalletUser(address);
      return res.status(200).json({ success: true, data: { token: issueToken(user), user, wallet_address: address } });
    } catch (err) {
      console.error('[auth] durable user creation failed in wallet login:', err);
      return res.status(503).json({
        success: false,
        error: { code: 'STORAGE_UNAVAILABLE', message: 'Durable user storage is unavailable. Please try again later.' },
      });
    }
  }
);

router.post(
  '/auth/wallet/local-login',
  rateLimit({ policyId: 'auth:wallet-local-login', windowMs: 60_000, max: 20 }),
  validateRequest(z.object({ body: z.object({ address: localWalletIdentifierSchema }) })),
  async (req, res) => {
    if (
      env.WALLET_AUTH_MODE !== 'local' ||
      (env.NODE_ENV === 'production' && !env.ALLOW_INSECURE_LOCAL_WALLET_AUTH)
    ) {
      return res.status(403).json({
        success: false,
        error: { code: 'LOCAL_AUTH_DISABLED', message: 'Local wallet bypass is disabled.' },
      });
    }
    const address = String(req.body.address).trim();
    try {
      const user = await findOrCreateWalletUser(address);
      return res.status(200).json({
        success: true,
        data: { token: issueToken(user), user, wallet_address: address, auth_method: 'local_bypass' },
      });
    } catch (err) {
      console.error('[auth] durable user creation failed in local wallet login:', err);
      return res.status(503).json({
        success: false,
        error: { code: 'STORAGE_UNAVAILABLE', message: 'Durable user storage is unavailable. Please try again later.' },
      });
    }
  }
);

const loginSchema = z.object({
  body: z.object({
    seed_id: z.enum(['user-1', 'admin-1']),
  }),
});

router.post('/auth/demo-login', rateLimit({ policyId: 'auth:demo-login', windowMs: 60_000, max: 20 }), validateRequest(loginSchema), (req, res) => {
  if (env.NODE_ENV === 'production') {
    return res.status(403).json({
      success: false,
      error: {
        code: 'DEMO_LOGIN_DISABLED',
        message: 'Demo login is strictly disabled in production environments.',
      },
    });
  }

  const { seed_id } = req.body;
  const user = db.findUserBySeed(seed_id);

  if (!user) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `Seed user with ID '${seed_id}' not found.`,
      },
    });
  }

  const token = jwt.sign(
    {
      id: user.id,
      seed_id: user.seed_id,
      role: user.role,
    },
    env.JWT_SECRET,
    { expiresIn: '24h' }
  );

  return res.status(200).json({
    success: true,
    data: {
      token,
      user,
    },
  });
});

const simulatedWalletLoginSchema = z.object({
  body: z.object({
    username: z.string().min(2, 'Username must be at least 2 characters'),
    password: z.string().min(2, 'Password must be at least 2 characters'),
  }),
});

router.post('/auth/simulated-wallet-login', validateRequest(simulatedWalletLoginSchema), async (req, res) => {
  const { username } = req.body;
  const cleanUsername = username.trim();
  const seedId = `user-${cleanUsername.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;

  let user = await db.findUserBySeedDurable(seedId);
  if (!user) {
    user = db.users.find(
      (u) =>
        u.display_name.toLowerCase() === cleanUsername.toLowerCase() ||
        u.seed_id.toLowerCase() === cleanUsername.toLowerCase()
    );
  }

  if (!user) {
    try {
      user = await db.findOrCreateUserDurable({
        seed_id: seedId,
        display_name: cleanUsername,
        email: `${cleanUsername.toLowerCase().replace(/[^a-z0-9]/g, '')}@juanderquest.local`,
        avatar_url: `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(cleanUsername)}`,
        role: 'user',
        demo_points: 100,
        mjdq_balance: 100000,
        jdq_governance_balance: 15,
        scout_reputation: 250,
        is_public: false,
        handle: null,
        bio: null,
        status_text: null,
      });

      db.ledger.push({
        id: `ledg_welcome_${Date.now()}`,
        user_id: user.id,
        entry_type: 'poa_reward',
        mjdq_delta: 100000,
        jdq_delta: 15,
        burned_mjdq: 0,
        description: 'MetaMask Starter Pack: 100,000 mJDQ + 15 JDQ + 250 Scout Rep',
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[auth] durable user creation failed in simulated login:', err);
      return res.status(503).json({
        success: false,
        error: { code: 'STORAGE_UNAVAILABLE', message: 'Durable user storage is unavailable. Please try again later.' },
      });
    }
  }

  const token = jwt.sign(
    {
      id: user.id,
      seed_id: user.seed_id,
      role: user.role,
    },
    env.JWT_SECRET,
    { expiresIn: '24h' }
  );

  const simulatedAddress = `0x${Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}`;

  return res.status(200).json({
    success: true,
    data: {
      token,
      user,
      simulated_wallet_address: simulatedAddress,
      message: 'Simulated MetaMask Wallet Connected Successfully! Starter Demo Pack Credited.',
    },
  });
});

router.get('/auth/me', authenticateToken, (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const user = db.findUserById(userId!);

  if (!user) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'User profile not found.',
      },
    });
  }

  return res.status(200).json({
    success: true,
    data: user,
  });
});

export default router;
