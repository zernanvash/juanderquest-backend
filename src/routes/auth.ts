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

const findOrCreateWalletUser = (address: string) => {
  const normalized = address.toLowerCase();
  const seedId = `wallet:${normalized}`;
  let user = db.findUserBySeed(seedId);
  if (user) return user;

  const now = new Date().toISOString();
  user = {
    id: randomUUID(),
    seed_id: seedId,
    display_name: `Traveler ${address.slice(0, 6)}…${address.slice(-4)}`,
    email: `${normalized.slice(2, 12)}@wallet.juanderquest.local`,
    avatar_url: `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(normalized)}`,
    role: 'user',
    demo_points: 100,
    mjdq_balance: 100000,
    jdq_governance_balance: 15,
    scout_reputation: 250,
    created_at: now,
    updated_at: now,
  };
  db.users.push(user);
  return user;
};

router.get('/auth/wallet/config', (_req, res) => res.status(200).json({
  success: true,
  data: { mode: env.WALLET_AUTH_MODE },
}));

router.post(
  '/auth/wallet/challenge',
  rateLimit({ windowMs: 60_000, max: 20 }),
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
  rateLimit({ windowMs: 60_000, max: 20 }),
  validateRequest(z.object({ body: z.object({ address: walletAddressSchema, signature: z.string().min(1) }) })),
  (req, res) => {
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
    const user = findOrCreateWalletUser(address);
    return res.status(200).json({ success: true, data: { token: issueToken(user), user, wallet_address: address } });
  }
);

router.post(
  '/auth/wallet/local-login',
  rateLimit({ windowMs: 60_000, max: 20 }),
  validateRequest(z.object({ body: z.object({ address: localWalletIdentifierSchema }) })),
  (req, res) => {
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
    const user = findOrCreateWalletUser(address);
    return res.status(200).json({
      success: true,
      data: { token: issueToken(user), user, wallet_address: address, auth_method: 'local_bypass' },
    });
  }
);

const loginSchema = z.object({
  body: z.object({
    seed_id: z.enum(['user-1', 'admin-1']),
  }),
});

router.post('/auth/demo-login', rateLimit({ windowMs: 60_000, max: 20 }), validateRequest(loginSchema), (req, res) => {
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

router.post('/auth/simulated-wallet-login', validateRequest(simulatedWalletLoginSchema), (req, res) => {
  const { username } = req.body;
  const cleanUsername = username.trim();

  let user = db.users.find(
    (u) =>
      u.display_name.toLowerCase() === cleanUsername.toLowerCase() ||
      u.seed_id.toLowerCase() === cleanUsername.toLowerCase()
  );

  if (!user) {
    // Create new simulated Web3 wallet user with Starter Demo Assets!
    user = {
      id: `usr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      seed_id: `user-${cleanUsername.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
      display_name: cleanUsername,
      email: `${cleanUsername.toLowerCase().replace(/\s+/g, '')}@juanderquest.ph`,
      avatar_url: `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(cleanUsername)}`,
      role: 'user',
      demo_points: 100,
      mjdq_balance: 100000,          // Starter 100,000 mJDQ (100.00 JDQ value)
      jdq_governance_balance: 15,    // Starter 15 JDQ Governance
      scout_reputation: 250,         // Starter 250 Scout Rep
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    db.users.push(user);

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
