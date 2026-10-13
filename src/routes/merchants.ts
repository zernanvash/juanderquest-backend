import { Router, Response } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validate.js';

export const merchantsRouter = Router();

// Middleware: Require Caller to be an active owner of a merchant
async function requireMerchantOwner(req: AuthRequest, res: Response, next: () => void) {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
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
merchantsRouter.get(
  '/merchant/me',
  authenticateToken,
  async (req: AuthRequest, res: Response) => {
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
  }
);

// GET /api/v1/merchant/dashboard (Setup checklist, truthful counts, and recent activity)
merchantsRouter.get(
  '/merchant/dashboard',
  authenticateToken,
  requireMerchantOwner,
  async (req: AuthRequest, res: Response) => {
    const merchant = (req as any).merchant;
    const products = db.listMerchantProducts(merchant.id, false);
    const archivedProducts = db.listMerchantProducts(merchant.id, true).filter(p => p.is_archived);

    // Setup checklist calculation
    const hasDescription = Boolean(merchant.description && merchant.description.length > 10);
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

    const completedCount = checklist.filter(c => c.completed).length;

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
          ready_to_publish: hasContact && (merchant.name.length > 0),
        },
        truthful_notice: {
          mode: 'sovereign_informational',
          statement: 'Visitor engagement metrics, point staking, and live automated checkout are deferred. All product cards serve as informational local showcases.',
        },
      },
    });
  }
);

// Profile schemas
const updateProfileSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(200).optional(),
    description: z.string().max(2000).optional(),
    location: z.string().max(200).optional(),
    municipality: z.string().max(100).optional(),
    contact_email: z.string().trim().email().max(255).optional(),
    contact_phone: z.string().trim().min(7).max(50).optional(),
    logo_url: z.string().url().or(z.literal('')).optional().nullable(),
    banner_url: z.string().url().or(z.literal('')).optional().nullable(),
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
  }
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
  }
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
  }
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
  }
);

// Products schemas
const createProductSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2, 'Product name must be at least 2 characters').max(200),
    description: z.string().max(1000).optional().default(''),
    price: z.number().nonnegative().optional().nullable(),
    currency: z.string().max(10).optional().default('PHP'),
    image_url: z.string().url().or(z.literal('')).optional().nullable(),
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
    image_url: z.string().url().or(z.literal('')).optional().nullable(),
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
  }
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
  }
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
  }
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
  }
);
