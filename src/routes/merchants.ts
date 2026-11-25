import { randomUUID } from 'crypto';
import { Router, Response } from 'express';
import { z } from 'zod';
import { httpUrl } from '../utils/http-url.js';
import { db } from '../db/index.js';
import { getPool } from '../db/pool.js';
import { authenticateToken, optionalAuthenticateToken, AuthRequest } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validate.js';
import { loadSukiSettings, rewardTag } from '../suki/service.js';
import { resolveMerchantMember, WorkspaceError } from '../merchants/workspace.js';

export const merchantsRouter = Router();

interface HydratedLinkedSpot {
  id: string;
  slug: string;
  name: string;
  municipality: string;
  gps_lat: number;
  gps_lng: number;
  image_url: string | null;
}

interface HydratedPendingClaim {
  id: string;
  spot_id: string;
  spot_name: string;
  status: string;
  created_at: string;
}

async function hydrateMerchantLocation(
  merchantId: string,
  fallbackSpotId?: string | null,
): Promise<{
  spot_id: string | null;
  linked_spot: HydratedLinkedSpot | null;
  pending_claim: HydratedPendingClaim | null;
}> {
  const pool = getPool();
  if (!pool) {
    return { spot_id: fallbackSpotId ?? null, linked_spot: null, pending_claim: null };
  }
  const [mRes, claimRes] = await Promise.all([
    pool
      .query(
        `SELECT m.spot_id,
                s.id AS s_id, s.slug AS s_slug, s.name AS s_name, s.municipality AS s_municipality,
                s.gps_lat AS s_lat, s.gps_lng AS s_lng, s.image_url AS s_image_url
           FROM merchants m
           LEFT JOIN spots s ON s.id = m.spot_id
          WHERE m.id = $1
          LIMIT 1`,
        [merchantId],
      )
      .catch(() => ({ rows: [] as any[] })),
    pool
      .query(
        `SELECT c.id, c.spot_id, s.name AS spot_name, c.status, c.created_at
           FROM merchant_spot_claim_requests c
           JOIN spots s ON s.id = c.spot_id
          WHERE c.merchant_id = $1 AND c.status = 'pending'
          ORDER BY c.created_at DESC
          LIMIT 1`,
        [merchantId],
      )
      .catch(() => ({ rows: [] as any[] })),
  ]);
  const row = mRes.rows[0];
  const spotId = row?.spot_id ? String(row.spot_id) : null;
  const linkedSpot: HydratedLinkedSpot | null =
    spotId && row?.s_id
      ? {
          id: String(row.s_id),
          slug: String(row.s_slug),
          name: String(row.s_name),
          municipality: String(row.s_municipality ?? ''),
          gps_lat: Number(row.s_lat),
          gps_lng: Number(row.s_lng),
          image_url: row.s_image_url ? String(row.s_image_url) : null,
        }
      : null;
  const c = claimRes.rows[0];
  const pendingClaim: HydratedPendingClaim | null = c
    ? {
        id: String(c.id),
        spot_id: String(c.spot_id),
        spot_name: String(c.spot_name),
        status: String(c.status),
        created_at: new Date(c.created_at).toISOString(),
      }
    : null;
  return { spot_id: spotId, linked_spot: linkedSpot, pending_claim: pendingClaim };
}

function handleWorkspaceError(res: Response, err: unknown) {
  if (err instanceof WorkspaceError) {
    return res.status(err.status).json({
      success: false,
      error: { code: err.code, message: err.message },
    });
  }
  return res.status(503).json({
    success: false,
    error: { code: 'MERCHANT_UNAVAILABLE', message: 'Merchant location service is unavailable right now.' },
  });
}

// Middleware: Require Caller to be an active owner of a merchant
async function requireMerchantOwner(req: AuthRequest, res: Response, next: () => void) {
  const userId = req.user?.id;
  if (!userId) {
    return res
      .status(401)
      .json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
  }

  const membershipInfo = db.getMerchantMembershipForUser(userId);
  if (!membershipInfo) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'MERCHANT_ACCESS_REQUIRED',
        message: 'No active merchant membership associated with this account.',
      },
    });
  }

  (req as any).merchant = membershipInfo.merchant;
  (req as any).membership = membershipInfo.membership;
  next();
}

// GET /api/v1/merchant/me (Caller check merchant status & identity)
merchantsRouter.get('/merchant/me', authenticateToken, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const info = db.getMerchantMembershipForUser(userId);
  if (!info) {
    return res.status(200).json({
      success: true,
      data: {
        has_merchant: false,
        merchant: null,
        membership: null,
      },
    });
  }

  const loc = await hydrateMerchantLocation(info.merchant.id, info.merchant.spot_id ?? null);
  return res.status(200).json({
    success: true,
    data: {
      has_merchant: true,
      merchant: {
        ...info.merchant,
        spot_id: loc.spot_id,
        linked_spot: loc.linked_spot,
      },
      linked_spot: loc.linked_spot,
      pending_claim: loc.pending_claim,
      membership: {
        role: info.membership.role,
        status: info.membership.status,
        created_at: info.membership.created_at,
      },
    },
  });
});

// GET /api/v1/merchant/dashboard (Setup checklist, truthful counts, and recent activity)
merchantsRouter.get(
  '/merchant/dashboard',
  authenticateToken,
  requireMerchantOwner,
  async (req: AuthRequest, res: Response) => {
    const merchant = (req as any).merchant;
    const products = db.listMerchantProducts(merchant.id, false);
    const archivedProducts = db.listMerchantProducts(merchant.id, true).filter((p) => p.is_archived);

    // Setup checklist calculation
    const _hasDescription = Boolean(merchant.description && merchant.description.length > 10);
    const hasContact = Boolean(merchant.contact_email || merchant.contact_phone);
    const hasPhoto = Boolean(merchant.logo_url || merchant.banner_url);
    const hasProducts = products.length > 0;
    const isPublished = Boolean(merchant.is_published);

    const checklist = [
      { id: 'profile_info', title: 'Review business info & address', completed: true },
      { id: 'profile_contact', title: 'Confirm contact details', completed: hasContact },
      { id: 'profile_photo', title: 'Upload logo or banner photo', completed: hasPhoto },
      { id: 'catalog_item', title: 'Add your first product or specialty', completed: hasProducts },
      { id: 'publish_profile', title: 'Publish merchant showcase profile', completed: isPublished },
    ];

    const completedCount = checklist.filter((c) => c.completed).length;

    return res.status(200).json({
      success: true,
      data: {
        merchant: {
          id: merchant.id,
          name: merchant.name,
          category: merchant.category,
          municipality: merchant.municipality,
          location: merchant.location,
          is_published: merchant.is_published,
          status: merchant.status,
        },
        counts: {
          active_products: products.length,
          archived_products: archivedProducts.length,
        },
        checklist: {
          items: checklist,
          completed_count: completedCount,
          total_count: checklist.length,
          ready_to_publish: hasContact && merchant.name.length > 0,
        },
        truthful_notice: {
          mode: 'sovereign_informational',
          statement:
            'Visitor engagement metrics, point staking, and live automated checkout are deferred. All product cards serve as informational local showcases.',
        },
      },
    });
  },
);

// v0.3.10: a logo / cover photo is an http(s) URL or a photo uploaded through POST /spot-media
// (local storage answers a root-relative /api/v1/uploads/spot-photos/<file> path).
const photoUrl = httpUrl()
  .or(z.string().regex(/^\/api\/v1\/uploads\/spot-photos\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/))
  .or(z.literal(''));

// Profile schemas
const updateProfileSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(200).optional(),
    description: z.string().max(2000).optional(),
    location: z.string().max(200).optional(),
    municipality: z.string().max(100).optional(),
    contact_email: z.string().trim().email().max(255).optional(),
    contact_phone: z.string().trim().min(7).max(50).optional(),
    logo_url: photoUrl.optional().nullable(),
    banner_url: photoUrl.optional().nullable(),
  }),
});

// GET /api/v1/merchant/profile (Get owner's merchant profile)
merchantsRouter.get(
  '/merchant/profile',
  authenticateToken,
  requireMerchantOwner,
  async (req: AuthRequest, res: Response) => {
    const merchant = (req as any).merchant;
    const loc = await hydrateMerchantLocation(merchant.id, merchant.spot_id ?? null);
    return res.status(200).json({
      success: true,
      data: {
        ...merchant,
        spot_id: loc.spot_id,
        linked_spot: loc.linked_spot,
        pending_claim: loc.pending_claim,
      },
    });
  },
);

// PATCH /api/v1/merchant/profile (Update owner's merchant profile)
merchantsRouter.patch(
  '/merchant/profile',
  authenticateToken,
  requireMerchantOwner,
  validateRequest(updateProfileSchema),
  async (req: AuthRequest, res: Response) => {
    const merchant = (req as any).merchant;
    const updated = db.updateMerchantProfile(merchant.id, req.body);
    return res.status(200).json({
      success: true,
      data: updated,
    });
  },
);

// POST /api/v1/merchant/profile/publish (Explicit publish action)
merchantsRouter.post(
  '/merchant/profile/publish',
  authenticateToken,
  requireMerchantOwner,
  async (req: AuthRequest, res: Response) => {
    const merchant = (req as any).merchant;
    if (!merchant.contact_email && !merchant.contact_phone) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INCOMPLETE_PROFILE',
          message: 'Please provide at least a contact email or phone number before publishing.',
        },
      });
    }

    const updated = db.updateMerchantProfile(merchant.id, { is_published: true });
    return res.status(200).json({
      success: true,
      data: updated,
      message: 'Your merchant profile is now visible to Pangasinan travelers.',
    });
  },
);

// POST /api/v1/merchant/profile/unpublish (Revert to draft)
merchantsRouter.post(
  '/merchant/profile/unpublish',
  authenticateToken,
  requireMerchantOwner,
  async (req: AuthRequest, res: Response) => {
    const merchant = (req as any).merchant;
    const updated = db.updateMerchantProfile(merchant.id, { is_published: false });
    return res.status(200).json({
      success: true,
      data: updated,
      message: 'Your merchant profile has been set to draft mode.',
    });
  },
);

// Products schemas
const createProductSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2, 'Product name must be at least 2 characters').max(200),
    description: z.string().max(1000).optional().default(''),
    price: z.number().nonnegative().optional().nullable(),
    currency: z.string().max(10).optional().default('PHP'),
    image_url: httpUrl().or(z.literal('')).optional().nullable(),
    is_published: z.boolean().optional().default(true),
    display_order: z.number().int().optional().default(0),
  }),
});

const updateProductSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(200).optional(),
    description: z.string().max(1000).optional(),
    price: z.number().nonnegative().optional().nullable(),
    currency: z.string().max(10).optional(),
    image_url: httpUrl().or(z.literal('')).optional().nullable(),
    is_published: z.boolean().optional(),
    display_order: z.number().int().optional(),
  }),
});

// GET /api/v1/merchant/products (List products for caller's merchant)
merchantsRouter.get(
  '/merchant/products',
  authenticateToken,
  requireMerchantOwner,
  async (req: AuthRequest, res: Response) => {
    const merchant = (req as any).merchant;
    const includeArchived = req.query.include_archived === 'true';
    const products = db.listMerchantProducts(merchant.id, includeArchived);
    return res.status(200).json({
      success: true,
      data: products,
    });
  },
);

// POST /api/v1/merchant/products (Create product)
merchantsRouter.post(
  '/merchant/products',
  authenticateToken,
  requireMerchantOwner,
  validateRequest(createProductSchema),
  async (req: AuthRequest, res: Response) => {
    const merchant = (req as any).merchant;
    const product = db.createMerchantProduct({
      merchant_id: merchant.id,
      name: req.body.name,
      description: req.body.description || '',
      price: req.body.price ?? null,
      currency: req.body.currency || 'PHP',
      image_url: req.body.image_url ?? null,
      is_published: req.body.is_published ?? true,
      is_archived: false,
      display_order: req.body.display_order ?? 0,
    });

    return res.status(201).json({
      success: true,
      data: product,
    });
  },
);

// PATCH /api/v1/merchant/products/:id (Update product)
merchantsRouter.patch(
  '/merchant/products/:id',
  authenticateToken,
  requireMerchantOwner,
  validateRequest(updateProductSchema),
  async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const merchant = (req as any).merchant;

    const existing = db.findMerchantProductById(id);
    if (!existing || existing.merchant_id !== merchant.id) {
      return res.status(404).json({
        success: false,
        error: { code: 'PRODUCT_NOT_FOUND', message: 'Product not found' },
      });
    }

    const updated = db.updateMerchantProduct(id, req.body);
    return res.status(200).json({
      success: true,
      data: updated,
    });
  },
);

// DELETE /api/v1/merchant/products/:id (Archive product)
merchantsRouter.delete(
  '/merchant/products/:id',
  authenticateToken,
  requireMerchantOwner,
  async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const merchant = (req as any).merchant;

    const existing = db.findMerchantProductById(id);
    if (!existing || existing.merchant_id !== merchant.id) {
      return res.status(404).json({
        success: false,
        error: { code: 'PRODUCT_NOT_FOUND', message: 'Product not found' },
      });
    }

    db.archiveMerchantProduct(id);
    return res.status(200).json({
      success: true,
      message: 'Product archived successfully.',
    });
  },
);

// ---------- v0.3.10: specialty pins and the public merchant page ----------

/** At most this many products are pinned as the shop's specialty. */
export const MAX_SPECIALTY_PINS = 3;

const specialtySchema = z.object({ body: z.object({ pinned: z.boolean() }).strict() });

const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ success: false, error: { code, message } });

const publicProduct = (p: any) => ({
  id: p.id,
  name: p.name,
  description: p.description ?? '',
  price: p.price == null ? null : Number(p.price),
  currency: p.currency ?? 'PHP',
  image_url: p.image_url ?? null,
  is_specialty: p.specialty_at != null,
  specialty_at: p.specialty_at ? new Date(p.specialty_at).toISOString() : null,
});

// PUT /api/v1/merchant/products/:id/specialty (owner only): pin or unpin a published product.
merchantsRouter.put(
  '/merchant/products/:id/specialty',
  authenticateToken,
  validateRequest(specialtySchema),
  async (req: AuthRequest, res: Response) => {
    const pool = getPool();
    if (!pool) return fail(res, 503, 'DATABASE_REQUIRED', 'Durable storage is required for specialty pins.');
    const client = await pool.connect();
    const stop = async (status: number, code: string, message: string) => {
      await client.query('ROLLBACK');
      return fail(res, status, code, message);
    };
    try {
      await client.query('BEGIN');
      const member = (
        await client.query(
          `SELECT mm.merchant_id, mm.role FROM merchant_memberships mm JOIN merchants m ON m.id = mm.merchant_id
            WHERE mm.user_id = $1 AND mm.status = 'active' AND m.status = 'active'
            ORDER BY (mm.role = 'owner') DESC, mm.created_at LIMIT 1`,
          [req.user!.id],
        )
      ).rows[0];
      if (!member)
        return stop(403, 'MERCHANT_ACCESS_REQUIRED', 'No active merchant membership associated with this account.');
      if (member.role !== 'owner')
        return stop(403, 'MERCHANT_OWNER_REQUIRED', 'Only the shop owner can pin a specialty.');
      // Serialise pins per shop so two taps cannot pass the limit together.
      await client.query('SELECT id FROM merchants WHERE id = $1 FOR UPDATE', [member.merchant_id]);
      const product = (
        await client.query('SELECT * FROM merchant_products WHERE id = $1 AND merchant_id = $2', [
          req.params.id,
          member.merchant_id,
        ])
      ).rows[0];
      if (!product) return stop(404, 'PRODUCT_NOT_FOUND', 'Product not found');
      let updated = product;
      if (req.body.pinned) {
        if (!product.is_published || product.is_archived)
          return stop(409, 'PRODUCT_NOT_PUBLISHED', 'Publish the product before pinning it as a specialty.');
        if (product.specialty_at == null) {
          const pins = (
            await client.query(
              `SELECT COUNT(*)::int AS n FROM merchant_products
                WHERE merchant_id = $1 AND specialty_at IS NOT NULL AND is_published = TRUE AND is_archived = FALSE`,
              [member.merchant_id],
            )
          ).rows[0].n as number;
          if (pins >= MAX_SPECIALTY_PINS)
            return stop(
              409,
              'SPECIALTY_LIMIT',
              `You can pin up to ${MAX_SPECIALTY_PINS} specialties. Unpin one first.`,
            );
          updated = (
            await client.query(
              'UPDATE merchant_products SET specialty_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *',
              [product.id],
            )
          ).rows[0];
        }
      } else if (product.specialty_at != null) {
        updated = (
          await client.query(
            'UPDATE merchant_products SET specialty_at = NULL, updated_at = NOW() WHERE id = $1 RETURNING *',
            [product.id],
          )
        ).rows[0];
      }
      await client.query('COMMIT');
      // Keep the in-memory catalog (GET /merchant/products) in step.
      const cached = db.findMerchantProductById(product.id);
      if (cached) cached.specialty_at = updated.specialty_at ? new Date(updated.specialty_at).toISOString() : null;
      return res.status(200).json({ success: true, data: publicProduct(updated) });
    } catch {
      await client.query('ROLLBACK').catch(() => undefined);
      return fail(res, 503, 'MERCHANT_UNAVAILABLE', 'Could not update the specialty right now.');
    } finally {
      client.release();
    }
  },
);

// GET /api/v1/merchants/:id: the public merchant page (signed-in viewers also get their Suki card status).
merchantsRouter.get('/merchants/:id', optionalAuthenticateToken, async (req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return fail(res, 503, 'DATABASE_REQUIRED', 'Durable storage is required for merchant pages.');
  try {
    const viewerId = req.user?.id ?? null;
    const merchant = (
      await pool.query(
        `SELECT m.id, m.name, m.category, m.municipality, m.location, m.description, m.logo_url, m.banner_url,
                m.contact_email, m.contact_phone, m.is_published, m.is_test, m.spot_id,
                COALESCE(m.gps_lat, a.gps_lat) AS gps_lat, COALESCE(m.gps_lng, a.gps_lng) AS gps_lng,
                s.id AS s_id, s.slug AS s_slug, s.name AS s_name, s.municipality AS s_municipality,
                s.gps_lat AS s_lat, s.gps_lng AS s_lng, s.image_url AS s_image_url,
                EXISTS (SELECT 1 FROM merchant_memberships mm
                         WHERE mm.merchant_id = m.id AND mm.user_id = $2 AND mm.status = 'active') AS is_member
           FROM merchants m
           LEFT JOIN merchant_affiliate_applications a ON a.id = m.source_application_id
           LEFT JOIN spots s ON s.id = m.spot_id
          WHERE m.id = $1 AND m.status = 'active'`,
        [String(req.params.id), viewerId ?? ''],
      )
    ).rows[0];
    const viewerIsTest = viewerId
      ? Boolean((await pool.query('SELECT is_test FROM users WHERE id = $1', [viewerId])).rows[0]?.is_test)
      : false;
    // A draft page is visible only to its own members (a preview); test shops only to test accounts.
    if (!merchant || (!merchant.is_member && (!merchant.is_published || Boolean(merchant.is_test) !== viewerIsTest)))
      return fail(res, 404, 'MERCHANT_NOT_FOUND', 'This shop was not found.');
    const [products, vouchers, settings, program] = await Promise.all([
      pool.query(
        `SELECT * FROM merchant_products WHERE merchant_id = $1 AND is_published = TRUE AND is_archived = FALSE
          ORDER BY specialty_at ASC NULLS LAST, display_order ASC, created_at DESC LIMIT 60`,
        [merchant.id],
      ),
      pool.query(
        `SELECT id, title, description, cost_points, availability FROM vouchers
          WHERE merchant_id = $1 AND is_active = TRUE ORDER BY sort_order, id LIMIT 30`,
        [merchant.id],
      ),
      loadSukiSettings(pool),
      pool.query(
        `SELECT id, title, reward_kind, reward_value, reward_text, visits_required, mode
           FROM suki_programs WHERE merchant_id = $1 AND status = 'active'`,
        [merchant.id],
      ),
    ]);
    const p = settings.enabled ? program.rows[0] : undefined;
    let myCard: { visits: number; required: number } | null = null;
    if (p && viewerId) {
      const card = (
        await pool.query('SELECT visits, cycle_required FROM suki_cards WHERE program_id = $1 AND user_id = $2', [
          p.id,
          viewerId,
        ])
      ).rows[0];
      if (card) myCard = { visits: Number(card.visits), required: Number(card.cycle_required) };
    }
    const value = p?.reward_value == null ? null : Number(p.reward_value);
    const items = products.rows.map(publicProduct);
    const linkedSpot: HydratedLinkedSpot | null =
      merchant.spot_id && merchant.s_id
        ? {
            id: String(merchant.s_id),
            slug: String(merchant.s_slug),
            name: String(merchant.s_name),
            municipality: String(merchant.s_municipality ?? ''),
            gps_lat: Number(merchant.s_lat),
            gps_lng: Number(merchant.s_lng),
            image_url: merchant.s_image_url ? String(merchant.s_image_url) : null,
          }
        : null;
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({
      success: true,
      data: {
        merchant: {
          id: merchant.id,
          name: merchant.name,
          category: merchant.category ?? null,
          municipality: merchant.municipality ?? null,
          location: merchant.location ?? null,
          description: merchant.description ?? '',
          logo_url: merchant.logo_url || null,
          banner_url: merchant.banner_url || null,
          contact_email: merchant.contact_email || null,
          contact_phone: merchant.contact_phone || null,
          gps_lat: merchant.gps_lat == null ? null : Number(merchant.gps_lat),
          gps_lng: merchant.gps_lng == null ? null : Number(merchant.gps_lng),
          spot_id: merchant.spot_id ? String(merchant.spot_id) : null,
          linked_spot: linkedSpot,
          is_published: Boolean(merchant.is_published),
        },
        specialties: items.filter((i) => i.is_specialty),
        products: items.filter((i) => !i.is_specialty),
        vouchers: vouchers.rows.map((v: any) => ({
          id: v.id,
          title: v.title,
          description: v.description ?? '',
          cost_points: Number(v.cost_points),
          availability: v.availability ?? 'live',
        })),
        suki: {
          enabled: settings.enabled,
          program: p
            ? {
                id: p.id,
                title: p.title,
                reward_text: p.reward_text,
                reward_tag: rewardTag(p.reward_kind, value),
                visits_required: Number(p.visits_required),
                mode: p.mode,
              }
            : null,
          my_card: myCard,
        },
        viewer: { is_member: Boolean(merchant.is_member) },
      },
    });
  } catch {
    return fail(res, 503, 'MERCHANT_UNAVAILABLE', 'This shop page is unavailable right now.');
  }
});

// ============================================================================
// Plan 122a: Merchant Hub Destination Linking & Claim Submission (owner-only)
// ============================================================================

const linkLocationSchema = z.object({
  body: z.object({
    spot_id: z.string().trim().min(1).max(180),
  }),
});

const claimLocationSchema = z.object({
  body: z.object({
    spot_id: z.string().trim().min(1).max(180),
    note: z.string().trim().min(10, 'Note must be between 10 and 500 characters.').max(500),
    proof_url: photoUrl.optional().nullable(),
  }),
});

// GET /api/v1/merchant/location/candidates (owner-only)
merchantsRouter.get('/merchant/location/candidates', authenticateToken, async (req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return fail(res, 503, 'DATABASE_REQUIRED', 'Durable storage is required for merchant locations.');
  try {
    const ctx = await resolveMerchantMember(pool, req.user!.id, true);
    const [loc, authoredRes] = await Promise.all([
      hydrateMerchantLocation(ctx.merchantId),
      pool.query(
        `SELECT s.id, s.slug, s.name, s.municipality, s.category, s.gps_lat, s.gps_lng, s.image_url
           FROM spots s
          WHERE s.created_by = $1
            AND s.status = 'published'
            AND s.is_test = $2
            AND NOT EXISTS (
              SELECT 1 FROM merchants m
               WHERE m.spot_id = s.id
                 AND m.id <> $3
                 AND m.status = 'active'
            )
          ORDER BY s.created_at DESC, s.id ASC
          LIMIT 100`,
        [req.user!.id, ctx.isTest, ctx.merchantId],
      ),
    ]);
    return res.status(200).json({
      success: true,
      data: {
        authored_spots: authoredRes.rows.map((s: any) => ({
          id: String(s.id),
          slug: String(s.slug),
          name: String(s.name),
          municipality: String(s.municipality ?? ''),
          category: String(s.category ?? ''),
          gps_lat: Number(s.gps_lat),
          gps_lng: Number(s.gps_lng),
          image_url: s.image_url ? String(s.image_url) : null,
        })),
        linked_spot: loc.linked_spot,
        pending_claim: loc.pending_claim,
      },
    });
  } catch (err) {
    return handleWorkspaceError(res, err);
  }
});

// PUT /api/v1/merchant/location (owner-only instant link for authored published spots)
merchantsRouter.put(
  '/merchant/location',
  authenticateToken,
  validateRequest(linkLocationSchema),
  async (req: AuthRequest, res: Response) => {
    const pool = getPool();
    if (!pool) return fail(res, 503, 'DATABASE_REQUIRED', 'Durable storage is required for merchant locations.');
    try {
      const ctx = await resolveMerchantMember(pool, req.user!.id, true);
      const { spot_id } = req.body as { spot_id: string };
      const spotRes = await pool.query(
        `SELECT id, slug, name, municipality, gps_lat, gps_lng, image_url, status, created_by, is_test
           FROM spots
          WHERE id = $1
          LIMIT 1`,
        [spot_id],
      );
      const spot = spotRes.rows[0];
      if (!spot || spot.status !== 'published' || Boolean(spot.is_test) !== ctx.isTest) {
        return fail(res, 404, 'SPOT_NOT_FOUND', 'Published destination not found.');
      }
      if (spot.created_by !== req.user!.id) {
        return fail(
          res,
          403,
          'SPOT_AUTHORSHIP_REQUIRED',
          'You can only link destinations you authored directly. Submit a location claim for existing places.',
        );
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const conflict = await client.query(
          `SELECT id FROM merchants WHERE spot_id = $1 AND id <> $2 AND status = 'active' LIMIT 1`,
          [spot.id, ctx.merchantId],
        );
        if (conflict.rowCount) {
          await client.query('ROLLBACK');
          return fail(
            res,
            409,
            'SPOT_ALREADY_LINKED_TO_MERCHANT',
            'This destination is already linked to another Local Partner.',
          );
        }

        const updatedRes = await client.query(
          `UPDATE merchants
              SET spot_id = $1, gps_lat = $2, gps_lng = $3
            WHERE id = $4
            RETURNING *`,
          [spot.id, Number(spot.gps_lat), Number(spot.gps_lng), ctx.merchantId],
        );
        await client.query(
          `UPDATE merchant_spot_claim_requests
              SET status = 'cancelled', updated_at = NOW()
            WHERE merchant_id = $1 AND status = 'pending'`,
          [ctx.merchantId],
        );
        await client.query('COMMIT');

        db.syncMerchantSpotCache(ctx.merchantId, String(spot.id), Number(spot.gps_lat), Number(spot.gps_lng));
        const linkedSpot: HydratedLinkedSpot = {
          id: String(spot.id),
          slug: String(spot.slug),
          name: String(spot.name),
          municipality: String(spot.municipality ?? ''),
          gps_lat: Number(spot.gps_lat),
          gps_lng: Number(spot.gps_lng),
          image_url: spot.image_url ? String(spot.image_url) : null,
        };
        return res.status(200).json({
          success: true,
          data: {
            merchant: updatedRes.rows[0],
            linked_spot: linkedSpot,
          },
        });
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (err?.code === '23505') {
          return fail(
            res,
            409,
            'SPOT_ALREADY_LINKED_TO_MERCHANT',
            'This destination is already linked to another Local Partner.',
          );
        }
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      return handleWorkspaceError(res, err);
    }
  },
);

// DELETE /api/v1/merchant/location (owner-only unlink)
merchantsRouter.delete('/merchant/location', authenticateToken, async (req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return fail(res, 503, 'DATABASE_REQUIRED', 'Durable storage is required for merchant locations.');
  try {
    const ctx = await resolveMerchantMember(pool, req.user!.id, true);
    await pool.query(`UPDATE merchants SET spot_id = NULL WHERE id = $1`, [ctx.merchantId]);
    db.syncMerchantSpotCache(ctx.merchantId, null);
    return res.status(200).json({
      success: true,
      data: {
        merchant_id: ctx.merchantId,
        spot_id: null,
        linked_spot: null,
      },
    });
  } catch (err) {
    return handleWorkspaceError(res, err);
  }
});

// POST /api/v1/merchant/location/claim (owner-only claim for non-authored published spot)
merchantsRouter.post(
  '/merchant/location/claim',
  authenticateToken,
  validateRequest(claimLocationSchema),
  async (req: AuthRequest, res: Response) => {
    const pool = getPool();
    if (!pool) return fail(res, 503, 'DATABASE_REQUIRED', 'Durable storage is required for merchant locations.');
    try {
      const ctx = await resolveMerchantMember(pool, req.user!.id, true);
      const { spot_id, note, proof_url } = req.body as { spot_id: string; note: string; proof_url?: string | null };
      const spotRes = await pool.query(`SELECT id, name, status, is_test FROM spots WHERE id = $1 LIMIT 1`, [spot_id]);
      const spot = spotRes.rows[0];
      if (!spot || spot.status !== 'published' || Boolean(spot.is_test) !== ctx.isTest) {
        return fail(res, 404, 'SPOT_NOT_FOUND', 'Published destination not found.');
      }

      const [linkedRes, pendingRes] = await Promise.all([
        pool.query(`SELECT id FROM merchants WHERE spot_id = $1 AND status = 'active' LIMIT 1`, [spot.id]),
        pool.query(
          `SELECT id FROM merchant_spot_claim_requests WHERE merchant_id = $1 AND status = 'pending' LIMIT 1`,
          [ctx.merchantId],
        ),
      ]);
      if (linkedRes.rowCount) {
        return fail(
          res,
          409,
          'SPOT_ALREADY_LINKED_TO_MERCHANT',
          'This destination is already linked to a Local Partner.',
        );
      }
      if (pendingRes.rowCount) {
        return fail(res, 409, 'CLAIM_ALREADY_PENDING', 'You already have a pending location claim under review.');
      }

      const id = `msc_${randomUUID()}`;
      const cleanProof = proof_url && proof_url.trim().length > 0 ? proof_url.trim() : null;
      try {
        const inserted = await pool.query(
          `INSERT INTO merchant_spot_claim_requests
             (id, merchant_id, spot_id, requested_by, note, proof_url, status, is_test, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, NOW(), NOW())
           RETURNING *`,
          [id, ctx.merchantId, spot.id, req.user!.id, note.trim(), cleanProof, ctx.isTest],
        );
        const row = inserted.rows[0];
        return res.status(201).json({
          success: true,
          data: {
            id: String(row.id),
            merchant_id: String(row.merchant_id),
            spot_id: String(row.spot_id),
            spot_name: String(spot.name),
            note: String(row.note),
            proof_url: row.proof_url ? String(row.proof_url) : null,
            status: String(row.status),
            created_at: new Date(row.created_at).toISOString(),
          },
        });
      } catch (err: any) {
        if (err?.code === '23505') {
          return fail(res, 409, 'CLAIM_ALREADY_PENDING', 'You already have a pending location claim under review.');
        }
        throw err;
      }
    } catch (err) {
      return handleWorkspaceError(res, err);
    }
  },
);

// DELETE /api/v1/merchant/location/claim/:id (owner-only cancel own pending claim)
merchantsRouter.delete('/merchant/location/claim/:id', authenticateToken, async (req: AuthRequest, res: Response) => {
  const pool = getPool();
  if (!pool) return fail(res, 503, 'DATABASE_REQUIRED', 'Durable storage is required for merchant locations.');
  try {
    const ctx = await resolveMerchantMember(pool, req.user!.id, true);
    const updated = await pool.query(
      `UPDATE merchant_spot_claim_requests
          SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1 AND merchant_id = $2 AND status = 'pending'
        RETURNING id, merchant_id, spot_id, status, updated_at`,
      [String(req.params.id), ctx.merchantId],
    );
    if (!updated.rowCount) {
      return fail(res, 404, 'CLAIM_NOT_FOUND', 'Pending location claim not found.');
    }
    const row = updated.rows[0];
    return res.status(200).json({
      success: true,
      data: {
        id: String(row.id),
        merchant_id: String(row.merchant_id),
        spot_id: String(row.spot_id),
        status: String(row.status),
        updated_at: new Date(row.updated_at).toISOString(),
      },
    });
  } catch (err) {
    return handleWorkspaceError(res, err);
  }
});
