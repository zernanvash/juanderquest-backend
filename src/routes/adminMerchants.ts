import { Router, Response } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { assertInScope, merchantTownAreas, requireAreaAdmin } from '../admin/scope.js';
import { db } from '../db/index.js';

// Admin merchant directory and inspection.
//
// Read-only by policy: staff suspend/hide/restore requires a dedicated reasoned,
// audited API and an explicit ownership-visibility policy. Until that exists,
// this router exposes projections for oversight only — owner publish/edit
// actions continue to live under /merchant/*.
export const adminMerchantsRouter = Router();

// Plan 59: area admins with merchants_vouchers see only merchants whose town is in their area
// (merchants.town_area_id; unassigned merchants stay platform-only).
const requireMerchantPower = requireAreaAdmin('merchants_vouchers');
const storageUnavailable = (res: Response) =>
  res.status(503).json({ success: false, error: { code: 'DATABASE_OUTAGE', message: 'Merchant area data is unavailable.' } });

const displayNameFor = (userId: string): string | null =>
  db.findUserById(userId)?.display_name ?? null;

adminMerchantsRouter.get('/admin/merchants', authenticateToken, requireMerchantPower, async (req: AuthRequest, res: Response) => {
  const scope = req.adminScope!;
  let areas: Map<string, string | null> | null = null;
  if (!scope.platform) {
    try { areas = await merchantTownAreas(); } catch { return storageUnavailable(res); }
  }
  const data = db.listMerchants()
    .filter((merchant) => !areas || assertInScope(scope, 'merchants_vouchers', areas.get(merchant.id) ?? null))
    .map((merchant) => {
    const memberships = db.listMerchantMemberships(merchant.id);
    const products = db.listMerchantProducts(merchant.id, true);
    const owner = memberships.find((membership) => membership.role === 'owner');

    return {
      id: merchant.id,
      name: merchant.name,
      category: merchant.category ?? null,
      municipality: merchant.municipality ?? null,
      location: merchant.location ?? null,
      status: merchant.status ?? 'active',
      is_published: Boolean(merchant.is_published),
      source_application_id: merchant.source_application_id ?? null,
      owner_display_name: owner ? displayNameFor(owner.user_id) : null,
      membership_count: memberships.length,
      active_product_count: products.filter((product) => !product.is_archived).length,
      archived_product_count: products.filter((product) => product.is_archived).length,
      created_at: merchant.created_at,
    };
  });

  return res.status(200).json({ success: true, data });
});

adminMerchantsRouter.get('/admin/merchants/:id', authenticateToken, requireMerchantPower, async (req: AuthRequest, res: Response) => {
  const merchant = db.findMerchantById(req.params.id);
  let inScope = true;
  if (merchant && !req.adminScope!.platform) {
    try {
      inScope = assertInScope(req.adminScope!, 'merchants_vouchers', (await merchantTownAreas([merchant.id])).get(merchant.id) ?? null);
    } catch { return storageUnavailable(res); }
  }
  if (!merchant || !inScope) {
    return res.status(404).json({
      success: false,
      error: { code: 'MERCHANT_NOT_FOUND', message: 'Merchant not found.' },
    });
  }

  const memberships = db.listMerchantMemberships(merchant.id).map((membership) => ({
    id: membership.id,
    role: membership.role,
    status: membership.status,
    created_at: membership.created_at,
    member_display_name: displayNameFor(membership.user_id),
  }));

  const products = db.listMerchantProducts(merchant.id, true);

  const application = merchant.source_application_id
    ? db.findAffiliateApplicationById(merchant.source_application_id) ?? null
    : null;

  return res.status(200).json({
    success: true,
    data: {
      merchant,
      memberships,
      products,
      application: application
        ? {
            id: application.id,
            status: application.status,
            business_name: application.business_name,
            category: application.category,
            municipality: application.municipality,
            business_province: application.business_province ?? null,
            created_at: application.created_at,
            reviewed_at: application.reviewed_at ?? null,
          }
        : null,
    },
  });
});

export default adminMerchantsRouter;
