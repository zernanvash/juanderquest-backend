import { Router, Response } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { env } from '../config/env.js';
import { validateRequest } from '../middleware/validate.js';
import { authenticateToken, optionalAuthenticateToken, AuthRequest } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { randomUUID } from 'crypto';
import { getAddress, verifyMessage } from 'ethers';
import { clearSessionCookie, setSessionCookie } from '../auth/sessionCookie.js';
import { signSessionToken } from '../auth/tokens.js';

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

const issueToken = (user: (typeof db.users)[number], rememberMe = false) => signSessionToken(user, rememberMe);

const findOrCreateWalletUser = async (address: string): Promise<(typeof db.users)[number]> => {
  const normalized = address.toLowerCase();
  const seedId = `wallet:${normalized}`;

  // 1. Check if an account is already linked to this wallet address
  const existingByWallet = await db.findUserByWalletAddressDurable(address);
  if (existingByWallet) {
    return existingByWallet;
  }

  // 2. Check if an account already exists with seedId
  const existingBySeed = db.usersRepo.getPool()
    ? await db.findUserBySeedDurable(seedId)
    : db.findUserBySeed(seedId);

  if (existingBySeed) {
    if (!existingBySeed.wallet_address) {
      return await db.bindWalletAddress(existingBySeed.id, address);
    }
    return existingBySeed;
  }

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
    wallet_address: address,
  });
};

router.get('/auth/wallet/config', (_req, res) => res.status(200).json({
  success: true,
  data: { mode: env.WALLET_AUTH_MODE, guest_login_enabled: env.GUEST_LOGIN_ENABLED },
}));

// Unified authentication routes: email/password, Google verification, password recovery,
// durable challenge resolution, and guest retirement.

const registerSchema = z.object({
  body: z.object({
    email: z.string().trim().email().max(255),
    password: z.string().min(8, 'Password must be at least 8 characters').max(100),
    display_name: z.string().trim().min(2, 'Name must be at least 2 characters').max(100),
    age_eligibility_declared: z.boolean().refine((val) => val === true, {
      message: 'You must confirm that you meet the age eligibility requirement.',
    }),
    terms_accepted: z.boolean().refine((val) => val === true, {
      message: 'You must accept the terms of service and privacy notice.',
    }),
  }),
});

router.post(
  '/auth/register',
  rateLimit({ policyId: 'auth:register', windowMs: 60_000, max: 10 }),
  validateRequest(registerSchema),
  async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const { email, password, display_name } = req.body;
    const normalizedEmail = db.identityService.normalizeEmail(email);

    try {
      // 1. Check if email is already registered as an identity or account email
      const existingIdentity = await db.identityService.findIdentity('email', normalizedEmail);
      if (existingIdentity) {
        return res.status(409).json({
          success: false,
          error: { code: 'EMAIL_ALREADY_EXISTS', message: 'An account with this email address already exists. Please sign in.' },
        });
      }

      // 2. Create the user record
      const seedId = `usr-${randomUUID().slice(0, 12)}`;
      const user = await db.findOrCreateUserDurable({
        seed_id: seedId,
        display_name: display_name.trim(),
        email: normalizedEmail,
        role: 'user',
        demo_points: 100,
        mjdq_balance: 100000,
        jdq_governance_balance: 15,
        scout_reputation: 250,
        is_public: false,
      });

      // 3. Link email identity and record unverified email
      await db.identityService.linkIdentity(user.id, 'email', normalizedEmail);
      await db.identityService.setPassword(user.id, password);
      await db.identityService.recordAccountEmail(user.id, normalizedEmail, false);
      await db.identityService.declareOnboardingPolicy(user.id, '1.0.0');

      // 4. Issue OTP code for email verification
      const challenge = await db.challengeService.createChallenge({
        purpose: 'signup_verify',
        targetIdentifier: normalizedEmail,
        boundUserId: user.id,
        ttlSeconds: 600,
      });

      await db.mailerService.queueAuthEmail({
        id: randomUUID(),
        recipientEmail: normalizedEmail,
        templateType: 'signup_otp',
        code: challenge.code,
      });

      return res.status(201).json({
        success: true,
        data: {
          message: 'Account created. Verification code sent to your email.',
          email: normalizedEmail,
          user_id: user.id,
          dev_code: process.env.NODE_ENV !== 'production' ? challenge.code : undefined,
        },
      });
    } catch (err) {
      console.error('[auth] register error:', err);
      return res.status(503).json({
        success: false,
        error: { code: 'STORAGE_UNAVAILABLE', message: 'Failed to process registration. Please try again.' },
      });
    }
  }
);

router.post(
  '/auth/email/verify',
  rateLimit({ policyId: 'auth:email-verify', windowMs: 60_000, max: 20 }),
  validateRequest(
    z.object({
      body: z.object({
        email: z.string().email(),
        code: z.string().trim().length(6),
        remember_me: z.boolean().optional(),
      }),
    })
  ),
  async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const { email, code, remember_me } = req.body;
    const normalizedEmail = db.identityService.normalizeEmail(email);

    try {
      const result = await db.challengeService.consumeChallenge({
        purpose: 'signup_verify',
        targetIdentifier: normalizedEmail,
        code,
      });

      if (!result.valid) {
        return res.status(400).json({
          success: false,
          error: { code: result.error || 'INVALID_CODE', message: 'Verification code is invalid or has expired.' },
        });
      }

      await db.identityService.markEmailVerified(normalizedEmail);

      const identity = await db.identityService.findIdentity('email', normalizedEmail);
      if (!identity) {
        return res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User identity not found.' } });
      }

      const user = db.usersRepo.getPool() ? await db.usersRepo.findById(identity.user_id) : db.findUserById(identity.user_id);
      if (!user) {
        return res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found.' } });
      }

      const remember = remember_me === true;
      const token = issueToken(user, remember);
      setSessionCookie(res, token, remember);

      return res.status(200).json({
        success: true,
        data: { token, user, message: 'Email verified successfully.' },
      });
    } catch (err) {
      console.error('[auth] email verify error:', err);
      return res.status(503).json({ success: false, error: { code: 'STORAGE_UNAVAILABLE', message: 'Verification unavailable.' } });
    }
  }
);

router.post(
  '/auth/email/resend',
  rateLimit({ policyId: 'auth:email-resend', windowMs: 60_000, max: 5 }),
  validateRequest(z.object({ body: z.object({ email: z.string().email() }) })),
  async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const { email } = req.body;
    const normalizedEmail = db.identityService.normalizeEmail(email);

    try {
      const identity = await db.identityService.findIdentity('email', normalizedEmail);
      if (!identity) {
        // Uniform response to prevent enumeration
        return res.status(200).json({
          success: true,
          data: { message: 'If an account exists, a new verification code has been dispatched.' },
        });
      }

      const challenge = await db.challengeService.createChallenge({
        purpose: 'signup_verify',
        targetIdentifier: normalizedEmail,
        boundUserId: identity.user_id,
        ttlSeconds: 600,
      });

      await db.mailerService.queueAuthEmail({
        id: randomUUID(),
        recipientEmail: normalizedEmail,
        templateType: 'signup_otp',
        code: challenge.code,
      });

      return res.status(200).json({
        success: true,
        data: {
          message: 'If an account exists, a new verification code has been dispatched.',
          dev_code: process.env.NODE_ENV !== 'production' ? challenge.code : undefined,
        },
      });
    } catch (err) {
      console.error('[auth] resend error:', err);
      return res.status(503).json({ success: false, error: { code: 'STORAGE_UNAVAILABLE', message: 'Resend service unavailable.' } });
    }
  }
);

router.post(
  '/auth/login',
  rateLimit({ policyId: 'auth:login', windowMs: 60_000, max: 15 }),
  validateRequest(
    z.object({
      body: z.object({
        email: z.string().email(),
        password: z.string().min(1),
        remember_me: z.boolean().optional(),
      }),
    })
  ),
  async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const { email, password, remember_me } = req.body;
    const normalizedEmail = db.identityService.normalizeEmail(email);

    try {
      const identity = await db.identityService.findIdentity('email', normalizedEmail);
      if (!identity) {
        return res.status(401).json({
          success: false,
          error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' },
        });
      }

      const valid = await db.identityService.verifyUserPassword(identity.user_id, password);
      if (!valid) {
        return res.status(401).json({
          success: false,
          error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' },
        });
      }

      const user = db.usersRepo.getPool() ? await db.usersRepo.findById(identity.user_id) : db.findUserById(identity.user_id);
      if (!user) {
        return res.status(401).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'Account no longer exists.' } });
      }

      const remember = remember_me === true;
      const token = issueToken(user, remember);
      setSessionCookie(res, token, remember);

      return res.status(200).json({
        success: true,
        data: { token, user },
      });
    } catch (err) {
      console.error('[auth] email login error:', err);
      return res.status(503).json({ success: false, error: { code: 'STORAGE_UNAVAILABLE', message: 'Login service unavailable.' } });
    }
  }
);

router.post(
  '/auth/password/forgot',
  rateLimit({ policyId: 'auth:password-forgot', windowMs: 60_000, max: 5 }),
  validateRequest(z.object({ body: z.object({ email: z.string().email() }) })),
  async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const { email } = req.body;
    const normalizedEmail = db.identityService.normalizeEmail(email);

    try {
      const identity = await db.identityService.findIdentity('email', normalizedEmail);
      if (identity) {
        const challenge = await db.challengeService.createChallenge({
          purpose: 'password_reset',
          targetIdentifier: normalizedEmail,
          boundUserId: identity.user_id,
          ttlSeconds: 600,
        });

        await db.mailerService.queueAuthEmail({
          id: randomUUID(),
          recipientEmail: normalizedEmail,
          templateType: 'password_reset_otp',
          code: challenge.code,
        });

        return res.status(200).json({
          success: true,
          data: {
            message: 'If an account exists with this email, a recovery code has been sent.',
            dev_code: process.env.NODE_ENV !== 'production' ? challenge.code : undefined,
          },
        });
      }

      // Consistent return to avoid enumeration
      return res.status(200).json({
        success: true,
        data: { message: 'If an account exists with this email, a recovery code has been sent.' },
      });
    } catch (err) {
      console.error('[auth] forgot password error:', err);
      return res.status(503).json({ success: false, error: { code: 'STORAGE_UNAVAILABLE', message: 'Password recovery unavailable.' } });
    }
  }
);

router.post(
  '/auth/password/verify-code',
  rateLimit({ policyId: 'auth:password-verify-code', windowMs: 60_000, max: 15 }),
  validateRequest(
    z.object({
      body: z.object({
        email: z.string().email(),
        code: z.string().trim().length(6),
      }),
    })
  ),
  async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const { email, code } = req.body;
    const normalizedEmail = db.identityService.normalizeEmail(email);

    try {
      const result = await db.challengeService.consumeChallenge({
        purpose: 'password_reset',
        targetIdentifier: normalizedEmail,
        code,
      });

      if (!result.valid) {
        return res.status(400).json({
          success: false,
          error: { code: result.error || 'INVALID_CODE', message: 'Recovery code is invalid or has expired.' },
        });
      }

      // Create a short-lived reset grant token
      const resetGrant = randomUUID();
      await db.challengeService.createChallenge({
        purpose: 'password_reset_grant',
        targetIdentifier: resetGrant,
        boundUserId: result.boundUserId,
        ttlSeconds: 300,
        customCode: 'VALID_GRANT',
      });

      return res.status(200).json({
        success: true,
        data: { reset_grant: resetGrant, message: 'Recovery code verified.' },
      });
    } catch (err) {
      console.error('[auth] verify code error:', err);
      return res.status(503).json({ success: false, error: { code: 'STORAGE_UNAVAILABLE', message: 'Verification unavailable.' } });
    }
  }
);

router.post(
  '/auth/password/reset',
  rateLimit({ policyId: 'auth:password-reset', windowMs: 60_000, max: 10 }),
  validateRequest(
    z.object({
      body: z.object({
        reset_grant: z.string().uuid(),
        new_password: z.string().min(8).max(100),
      }),
    })
  ),
  async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const { reset_grant, new_password } = req.body;

    try {
      const result = await db.challengeService.consumeChallenge({
        purpose: 'password_reset_grant',
        targetIdentifier: reset_grant,
        code: 'VALID_GRANT',
      });

      if (!result.valid || !result.boundUserId) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_RESET_GRANT', message: 'Password reset grant is invalid or expired.' },
        });
      }

      await db.identityService.setPassword(result.boundUserId, new_password);

      return res.status(200).json({
        success: true,
        data: { message: 'Password has been successfully reset. Please sign in with your new password.' },
      });
    } catch (err) {
      console.error('[auth] password reset error:', err);
      return res.status(503).json({ success: false, error: { code: 'STORAGE_UNAVAILABLE', message: 'Password reset unavailable.' } });
    }
  }
);

router.post(
  '/auth/google',
  rateLimit({ policyId: 'auth:google', windowMs: 60_000, max: 20 }),
  validateRequest(
    z.object({
      body: z.object({
        credential: z.string().min(1),
        remember_me: z.boolean().optional(),
      }),
    })
  ),
  async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    // Never trust an unverified ID token. Google sign-in stays unavailable until
    // signature, issuer, audience, expiry, and email verification are checked.
    return res.status(503).json({
      success: false,
      error: { code: 'GOOGLE_SIGNIN_UNAVAILABLE', message: 'Google sign-in is not available yet. Use email or wallet sign-in.' },
    });
  }
);

// Authenticated identities endpoint
router.get('/auth/identities', authenticateToken, async (req: AuthRequest, res: Response) => {
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    const identities = await db.identityService.listUserIdentities(req.user!.id);
    return res.status(200).json({
      success: true,
      data: { identities },
    });
  } catch (err) {
    return res.status(503).json({ success: false, error: { code: 'STORAGE_UNAVAILABLE', message: 'Could not load identities.' } });
  }
});

// Retired guest login endpoint
router.post(
  '/auth/guest-login',
  rateLimit({ policyId: 'auth:guest-login', windowMs: 60_000, max: 5 }),
  validateRequest(z.object({ body: z.object({ remember_me: z.boolean().optional() }).strict() })),
  optionalAuthenticateToken,
  async (req: AuthRequest, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-store');
    // Enforce retirement: return stable GUEST_LOGIN_RETIRED error with guidance
    if (!env.GUEST_LOGIN_ENABLED) {
      return res.status(410).json({
        success: false,
        error: {
          code: 'GUEST_LOGIN_RETIRED',
          message: 'Guest login has been retired. Please create an account with email, Google, or wallet.',
        },
      });
    }

    try {
      if (env.NODE_ENV === 'production' && !db.usersRepo.getPool()) throw new Error('Durable storage required');
      let user;
      if (req.user) {
        user = db.usersRepo.getPool() ? await db.usersRepo.findById(req.user.id) : db.findUserById(req.user.id);
        if (!user || user.seed_id !== req.user.seed_id) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Session account no longer exists.' } });
        if (!user.seed_id.startsWith('guest:') || user.role !== 'user') return res.status(409).json({ success: false, error: { code: 'SESSION_EXISTS', message: 'Sign out before starting a guest account.' } });
      } else {
        const identity = randomUUID();
        user = await db.findOrCreateUserDurable({
          seed_id: `guest:${identity}`, display_name: `Guest ${identity.slice(0, 8)}`,
          email: `${identity}@guest.invalid`, role: 'user', is_public: false,
          demo_points: 0, mjdq_balance: 0, jdq_governance_balance: 0, scout_reputation: 0,
        });
      }
      const remember = req.body.remember_me !== false;
      const token = issueToken(user, remember);
      setSessionCookie(res, token, remember);
      return res.json({ success: true, data: { user, auth_method: 'guest' } });
    } catch {
      return res.status(503).json({ success: false, error: { code: 'STORAGE_UNAVAILABLE', message: 'Guest account storage is unavailable. Please try again.' } });
    }
  }
);

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
  validateRequest(z.object({ body: z.object({ address: walletAddressSchema, signature: z.string().min(1), remember_me: z.boolean().optional() }) })),
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
      const token = issueToken(user, req.body.remember_me === true);
      setSessionCookie(res, token, req.body.remember_me === true);
      return res.status(200).json({ success: true, data: { token, user, wallet_address: address } });
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
  validateRequest(z.object({ body: z.object({ address: localWalletIdentifierSchema, remember_me: z.boolean().optional() }) })),
  async (req, res) => {
    if (
      env.NODE_ENV === 'production' ||
      env.WALLET_AUTH_MODE !== 'local' ||
      (env.NODE_ENV !== 'test' && !env.ALLOW_INSECURE_LOCAL_WALLET_AUTH)
    ) {
      return res.status(403).json({
        success: false,
        error: { code: 'LOCAL_AUTH_DISABLED', message: 'Local wallet bypass is disabled.' },
      });
    }
    const address = String(req.body.address).trim();
    try {
      const user = await findOrCreateWalletUser(address);
      const token = issueToken(user, req.body.remember_me === true);
      setSessionCookie(res, token, req.body.remember_me === true);
      return res.status(200).json({
        success: true,
        data: { token, user, wallet_address: address, auth_method: 'local_bypass' },
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

router.post(
  '/auth/wallet/bind',
  rateLimit({ policyId: 'auth:wallet-bind', windowMs: 60_000, max: 20 }),
  authenticateToken,
  validateRequest(z.object({ body: z.object({ address: walletAddressSchema, signature: z.string().min(1) }) })),
  async (req: AuthRequest, res: Response) => {
    const address = getAddress(req.body.address);
    const key = address.toLowerCase();

    if (env.WALLET_AUTH_MODE === 'signature') {
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
    } else {
      const challenge = walletChallenges.get(key);
      if (challenge) {
        walletChallenges.delete(key);
        try {
          const recovered = getAddress(verifyMessage(challenge.message, req.body.signature));
          if (recovered !== address) throw new Error('Address mismatch');
        } catch {
          if (!env.ALLOW_INSECURE_LOCAL_WALLET_AUTH && env.NODE_ENV !== 'test') {
            return res.status(401).json({
              success: false,
              error: { code: 'INVALID_SIGNATURE', message: 'The wallet signature could not be verified.' },
            });
          }
        }
      }
    }

    try {
      const existingUser = await db.findUserByWalletAddressDurable(address);
      if (existingUser && existingUser.id !== req.user!.id) {
        return res.status(409).json({
          success: false,
          error: {
            code: 'WALLET_ALREADY_BOUND',
            message: 'This wallet address is already linked to another JuanDerQuest traveler account.',
          },
        });
      }

      const updatedUser = await db.bindWalletAddress(req.user!.id, address);
      return res.status(200).json({
        success: true,
        data: {
          user: updatedUser,
          wallet_address: address,
          message: 'Wallet successfully linked to your traveler passport.',
        },
      });
    } catch (err: any) {
      if (err?.code === 'WALLET_ALREADY_BOUND') {
        return res.status(409).json({
          success: false,
          error: {
            code: 'WALLET_ALREADY_BOUND',
            message: 'This wallet address is already linked to another JuanDerQuest traveler account.',
          },
        });
      }
      if (err?.code === 'USER_NOT_FOUND') {
        return res.status(404).json({
          success: false,
          error: { code: 'USER_NOT_FOUND', message: 'Traveler account not found.' },
        });
      }
      console.error('[auth] wallet binding failed:', err);
      return res.status(503).json({
        success: false,
        error: { code: 'STORAGE_UNAVAILABLE', message: 'Durable user storage is unavailable. Please try again later.' },
      });
    }
  }
);

router.delete(
  '/auth/wallet/unbind',
  rateLimit({ policyId: 'auth:wallet-unbind', windowMs: 60_000, max: 20 }),
  authenticateToken,
  async (req: AuthRequest, res: Response) => {
    try {
      const user = db.usersRepo.getPool()
        ? await db.usersRepo.findById(req.user!.id)
        : db.findUserById(req.user!.id);

      if (!user) {
        return res.status(404).json({
          success: false,
          error: { code: 'USER_NOT_FOUND', message: 'Traveler account not found.' },
        });
      }

      if (!user.wallet_address) {
        return res.status(400).json({
          success: false,
          error: { code: 'WALLET_NOT_BOUND', message: 'No wallet address is currently bound to this account.' },
        });
      }

      const updatedUser = await db.unbindWalletAddress(req.user!.id);
      return res.status(200).json({
        success: true,
        data: {
          user: updatedUser,
          message: 'Wallet unlinked successfully.',
        },
      });
    } catch (err: any) {
      console.error('[auth] wallet unbinding failed:', err);
      return res.status(503).json({
        success: false,
        error: { code: 'STORAGE_UNAVAILABLE', message: 'Durable user storage is unavailable. Please try again later.' },
      });
    }
  }
);

const loginSchema = z.object({
  body: z.object({
    seed_id: z.string().trim().min(1).max(100),
  }),
});

router.post('/auth/demo-login', rateLimit({ policyId: 'auth:demo-login', windowMs: 60_000, max: 20 }), validateRequest(loginSchema), async (req, res) => {
  if (!env.ALLOW_DEMO_LOGIN || (env.NODE_ENV === 'production' && !env.ALPHA_WALLET_SIMULATION_ENABLED)) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'DEMO_LOGIN_DISABLED',
        message: 'Demo login is disabled for this environment.',
      },
    });
  }

  const { seed_id } = req.body;
  let user;
  try {
    // Never issue a JWT for a process-local seed when protected routes read
    // identities from PostgreSQL. A missing durable seed is not a login.
    user = db.usersRepo.getPool()
      ? await db.findUserBySeedDurable(seed_id)
      : db.findUserBySeed(seed_id);
  } catch {
    return res.status(503).json({ success: false, error: {
      code: 'STORAGE_UNAVAILABLE', message: 'Durable user storage is unavailable. Please try again later.',
    } });
  }

  // Production hardening (2026-10-17 incident): demo login must never create accounts
  // or hand out privileged sessions there, even when the flag is switched on for a
  // presentation. Development keeps the canonical auto-provisioned demo users.
  const isProduction = env.NODE_ENV === 'production';

  if (!user && !isProduction && (seed_id === 'user-1' || seed_id === 'admin-1')) {
    try {
      if (seed_id === 'user-1') {
        user = await db.findOrCreateUserDurable({
          id: '11111111-1111-1111-1111-111111111111',
          seed_id: 'user-1',
          display_name: 'Juan Dela Cruz',
          email: 'juan@juanderquest.ph',
          avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Juan',
          role: 'user',
          demo_points: 100,
          scout_reputation: 250,
          is_public: true,
          handle: 'juandelacruz',
          bio: 'Pangasinan explorer & cultural heritage scout.',
          status_text: 'Exploring Hundred Islands & Bolinao 🌊',
        });
      } else if (seed_id === 'admin-1') {
        user = await db.findOrCreateUserDurable({
          id: '22222222-2222-2222-2222-222222222222',
          seed_id: 'admin-1',
          display_name: 'Tourism Officer Admin',
          email: 'admin@pangasinan.gov.ph',
          avatar_url: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Admin',
          role: 'admin',
          demo_points: 0,
          scout_reputation: 1000,
          is_public: false,
        });
      }
    } catch (err) {
      console.warn('[auth] Auto-provision of canonical demo user failed:', err);
    }
  }

  if (!user) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `Seed user with ID '${seed_id}' not found.`,
      },
    });
  }

  if (isProduction && user.role !== 'user') {
    return res.status(403).json({
      success: false,
      error: {
        code: 'DEMO_LOGIN_RESERVED',
        message: 'Demo login is limited to traveler accounts.',
      },
    });
  }

  const token = signSessionToken(user);
  setSessionCookie(res, token, false);

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

// These IDs belong to deterministic development/demo fixtures, not accounts
// created through simulated login. Never let a public username claim them.
const reservedSimulatedSeeds = new Set([
  'user-1', 'user-2', 'user-3', 'admin-1',
  'coastal', 'maya', 'pao', 'user-coastal', 'user-maya', 'user-pao',
]);

router.post('/auth/simulated-wallet-login', rateLimit({ policyId: 'auth:simulated-wallet-login', windowMs: 60_000, max: 20 }), validateRequest(simulatedWalletLoginSchema), async (req, res) => {
  if (env.NODE_ENV === 'production' || (env.NODE_ENV !== 'test' && !env.ALLOW_INSECURE_LOCAL_WALLET_AUTH)) return res.status(403).json({ success: false, error: { code: 'SIMULATED_LOGIN_DISABLED', message: 'Simulated login is unavailable on this server. Connect a wallet instead.' } });
  const { username } = req.body;
  const cleanUsername = username.trim();
  const seedId = `user-${cleanUsername.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;

  if (reservedSimulatedSeeds.has(cleanUsername.toLowerCase()) || reservedSimulatedSeeds.has(seedId)) {
    return res.status(403).json({ success: false, error: { code: 'SIMULATED_LOGIN_RESERVED', message: 'Simulated login is unavailable on this server. Connect a wallet instead.' } });
  }

  // Passwordless by design: anyone who knows a simulated username can enter
  // that simulated account. Never expose this route on a public host.
  let user = db.usersRepo.getPool()
    ? await db.findUserBySeedDurable(seedId)
    : db.findUserBySeed(seedId);

  if (user && (user.role !== 'user' || Boolean(user.is_test))) {
    return res.status(403).json({ success: false, error: { code: 'SIMULATED_LOGIN_RESERVED', message: 'Simulated login is unavailable on this server. Connect a wallet instead.' } });
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

  const token = signSessionToken(user);
  setSessionCookie(res, token, false);

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

router.post('/auth/session/upgrade', authenticateToken, async (req: AuthRequest, res: Response) => {
  if (!req.headers.authorization) return res.status(400).json({ success: false, error: { code: 'BEARER_REQUIRED', message: 'A legacy bearer session is required.' } });
  try {
    const user = db.usersRepo.getPool() ? await db.usersRepo.findById(req.user!.id) : db.findUserById(req.user!.id);
    if (!user) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Session account no longer exists.' } });
    const rememberMe = req.body?.remember_me === true;
    setSessionCookie(res, issueToken(user, rememberMe), rememberMe);
    return res.json({ success: true, data: user });
  } catch {
    return res.status(503).json({ success: false, error: { code: 'DATABASE_OUTAGE', message: 'Session could not be upgraded.' } });
  }
});

router.post('/auth/logout', (_req, res) => {
  clearSessionCookie(res);
  return res.json({ success: true });
});

router.get('/auth/me', authenticateToken, async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  let user;
  try { user = db.usersRepo.getPool() ? await db.usersRepo.findById(userId!) : db.findUserById(userId!); }
  catch { return res.status(503).json({ success: false, error: { code: 'DATABASE_OUTAGE', message: 'Session could not be validated.' } }); }

  if (!user) {
    clearSessionCookie(res);
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Session account no longer exists.',
      },
    });
  }

  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({
    success: true,
    data: user,
  });
});

export default router;
