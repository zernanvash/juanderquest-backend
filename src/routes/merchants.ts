import { Router, Response } from 'express';
import { z } from 'zod';
import { httpUrl } from '../utils/http-url.js';
import { db } from '../db/index.js';
import { getPool } from '../db/pool.js';
import { authenticateToken, optionalAuthenticateToken, AuthRequest } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validate.js';
import { loadSukiSettings, rewardTag } from '../suki/service.js';

export const merchantsRouter = Router();

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

  return res.status(200).json({
    success: true,
    data: {
      has_merchant: true,
      merchant: info.merchant,
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
    return res.status(200).json({
      success: true,
      data: merchant,
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
                m.contact_email, m.contact_phone, m.is_published, m.is_test,
                COALESCE(m.gps_lat, a.gps_lat) AS gps_lat, COALESCE(m.gps_lng, a.gps_lng) AS gps_lng,
                EXISTS (SELECT 1 FROM merchant_memberships mm
                         WHERE mm.merchant_id = m.id AND mm.user_id = $2 AND mm.status = 'active') AS is_member
           FROM merchants m LEFT JOIN merchant_affiliate_applications a ON a.id = m.source_application_id
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
