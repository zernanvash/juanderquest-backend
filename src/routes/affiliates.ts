import { Router, Response } from 'express';
import { z } from 'zod';
import { db, AffiliateApplicationStatus } from '../db/index.js';
import { authenticateToken, requireAdmin, AuthRequest } from '../middleware/auth.js';
import { assertInScope, auditOnSuccess, requireAreaAdmin, resolveTownAreaId } from '../admin/scope.js';
import { getPool } from '../db/pool.js';
import { validateRequest } from '../middleware/validate.js';
import { rateLimit } from '../middleware/rateLimit.js';

export const affiliatesRouter = Router();

type PlaceResult = { name: string; subtitle: string; lat: number; lng: number; type: string };
const placeCache = new Map<string, { expires: number; results: PlaceResult[] }>();
let nextPlaceLookupAt = 0;

// Authenticated, bounded Philippine place lookup for native affiliate map picking.
affiliatesRouter.get('/affiliate/places', authenticateToken,
  rateLimit({ policyId: 'affiliate:places', windowMs: 60_000, max: 10, keyStrategy: 'actor' }),
  async (req: AuthRequest, res: Response) => {
    const parsed = z.string().trim().min(2).max(100).safeParse(req.query.q);
    if (!parsed.success) return res.status(400).json({ success: false, error: { code: 'INVALID_QUERY', message: 'Enter 2–100 characters.' } });
    const key = parsed.data.toLowerCase();
    const cached = placeCache.get(key);
    if (cached && cached.expires > Date.now()) return res.json({ success: true, data: cached.results });
    if (Date.now() < nextPlaceLookupAt) return res.status(429).json({ success: false, error: { code: 'SEARCH_BUSY', message: 'Please retry place search shortly.' } });
    nextPlaceLookupAt = Date.now() + 1100;
    try {
      const url = new URL('https://nominatim.openstreetmap.org/search');
      url.search = new URLSearchParams({ q: parsed.data, format: 'json', countrycodes: 'ph', limit: '4', addressdetails: '1' }).toString();
      const upstream = await fetch(url, {
        headers: { 'User-Agent': 'JuanDerQuest/1.0 (travel@juanderquest.app; +https://juanderquest.app)', Accept: 'application/json' },
        signal: AbortSignal.timeout(4500),
      });
      if (!upstream.ok) throw new Error('Place provider unavailable');
      const raw = await upstream.json() as Array<{ name?: string; display_name?: string; lat: string; lon: string; addresstype?: string }>;
      const results = raw.flatMap((item): PlaceResult[] => {
        const lat = Number(item.lat);
        const lng = Number(item.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return [];
        return [{ name: item.name || item.display_name?.split(',')[0]?.trim() || parsed.data,
          subtitle: item.display_name || '', lat, lng, type: item.addresstype || 'place' }];
      });
      if (placeCache.size >= 200) placeCache.delete(placeCache.keys().next().value!);
      placeCache.set(key, { expires: Date.now() + 2 * 60 * 60 * 1000, results });
      return res.json({ success: true, data: results });
    } catch {
      return res.status(502).json({ success: false, error: { code: 'PLACE_SEARCH_UNAVAILABLE', message: 'Place search is temporarily unavailable. You can still place a pin manually.' } });
    }
  });

// Starter options catalog; locality selection is not limited to this province.
export const AFFILIATE_CATEGORIES = [
  { id: 'dining', label: 'Dining & Native Delicacies', description: 'Restaurants, grills, seafood shacks, and native food pasalubong' },
  { id: 'hospitality', label: 'Lodging & Hospitality', description: 'Resorts, transient homes, eco-lodges, beachfront stays' },
  { id: 'souvenirs', label: 'Handicrafts & Souvenirs', description: 'Local weaving, pottery, artisanal crafts, and regional keepsakes' },
  { id: 'activities', label: 'Tours & Coastal Activities', description: 'Island boatmen, kayak rentals, surf schools, guided heritage walks' },
  { id: 'wellness', label: 'Eco-Farm & Agritourism', description: 'Salt farms, mango orchards, aquaculture ponds, farm-to-table stops' },
];

export const PANGASINAN_MUNICIPALITIES = [
  'Agno', 'Aguilar', 'Alaminos City', 'Alcala', 'Anda', 'Asingan', 'Balungao', 'Bani', 'Basista', 'Bautista',
  'Bayambang', 'Binalonan', 'Binmaley', 'Bolinao', 'Bugallon', 'Burgos', 'Calasiao', 'Dasol', 'Infanta',
  'Labrador', 'Laoac', 'Lingayen', 'Mabini', 'Malasiqui', 'Manaoag', 'Mangaldan', 'Mangatarem', 'Mapandan',
  'Natividad', 'Pozorrubio', 'Rosales', 'San Carlos City', 'San Fabian', 'San Jacinto', 'San Manuel',
  'San Nicolas', 'San Quintin', 'Santa Barbara', 'Santa Maria', 'Santo Tomas', 'Sison', 'Sual', 'Tayug',
  'Umingan', 'Urbiztondo', 'Urdaneta City', 'Villasis', 'Dagupan City'
];

export const SPONSORSHIP_GOALS = [
  { id: 'quest_stop', label: 'Host a Quest Checkpoint', description: 'Feature as a GPS discovery or verification waypoint' },
  { id: 'voucher_perk', label: 'Offer In-Store Traveler Perks', description: 'Provide special discounts or welcome gifts for quest completers' },
  { id: 'storytelling', label: 'Cultural & Heritage Storytelling', description: 'Share local history and traditional craftsmanship' },
  { id: 'event_sponsor', label: 'Community Eco-Raid Co-Host', description: 'Partner with local youth and LGU environmental cleanups' },
];

// GET /api/v1/affiliate/options (Public options lookup)
affiliatesRouter.get('/affiliate/options', (_req, res: Response) => {
  return res.status(200).json({
    success: true,
    data: {
      categories: AFFILIATE_CATEGORIES,
      municipalities: PANGASINAN_MUNICIPALITIES,
      sponsorship_goals: SPONSORSHIP_GOALS,
      declaration_version: '1.0',
      terms_summary: 'Participation in JuanDerQuest promotes sustainable local tourism. Applications are reviewed and do not create speculative token obligations.'
    },
  });
});

// Draft validation schema
const saveDraftSchema = z.object({
  body: z.object({
    draft_data: z.record(z.any()),
    current_step: z.number().int().min(1).max(5).default(1),
    expected_revision: z.number().int().optional(),
  }),
});

// GET /api/v1/affiliate/application-draft (Applicant load draft)
affiliatesRouter.get(
  '/affiliate/application-draft',
  authenticateToken,
  async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const draft = db.getAffiliateDraft(userId);
    return res.status(200).json({
      success: true,
      data: draft || null,
    });
  }
);

// PUT /api/v1/affiliate/application-draft (Applicant auto-save draft)
affiliatesRouter.put(
  '/affiliate/application-draft',
  authenticateToken,
  validateRequest(saveDraftSchema),
  async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    try {
      const saved = db.saveAffiliateDraft(
        userId,
        req.body.draft_data,
        req.body.current_step,
        req.body.expected_revision
      );
      return res.status(200).json({
        success: true,
        data: saved,
      });
    } catch (err: any) {
      if (err.code === 'VERSION_CONFLICT') {
        return res.status(409).json({
          success: false,
          error: {
            code: 'VERSION_CONFLICT',
            message: 'Draft was updated in another session.',
            current_revision: err.currentRevision,
          },
        });
      }
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_SERVER_ERROR', message: err.message },
      });
    }
  }
);

// DELETE /api/v1/affiliate/application-draft (Clear draft)
affiliatesRouter.delete(
  '/affiliate/application-draft',
  authenticateToken,
  async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    db.deleteAffiliateDraft(userId);
    return res.status(200).json({ success: true, message: 'Draft discarded' });
  }
);

const createApplicationSchema = z.object({
  body: z.object({
    business_name: z.string().trim().min(2, 'Business name must be at least 2 characters').max(200),
    category: z.string().trim().min(2).max(50),
    municipality: z.string().trim().min(2).max(100),
    business_address: z.string().trim().max(500).optional(),
    business_province: z.string().trim().max(100).optional().default('Pangasinan'),
    gps_lat: z.number().min(-90).max(90).optional().nullable(),
    gps_lng: z.number().min(-180).max(180).optional().nullable(),
    contact_name: z.string().trim().min(2, 'Contact name must be at least 2 characters').max(100),
    contact_email: z.string().trim().email('Invalid contact email address').max(255),
    contact_phone: z.string().trim().min(7, 'Phone number must be at least 7 characters').max(50),
    preferred_contact_method: z.enum(['email', 'phone', 'sms']).optional().default('email'),
    sponsorship_goals: z.array(z.string().min(1)).min(1, 'Select at least one sponsorship goal'),
    proposal_details: z.string().max(2000).optional(),
    declaration_version: z.string().optional().default('1.0'),
  }),
});

// POST /api/v1/affiliate/applications (Authenticated applicant submission)
affiliatesRouter.post(
  '/affiliate/applications',
  authenticateToken,
  validateRequest(createApplicationSchema),
  async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    try {
      const application = await db.createAffiliateApplication({
        user_id: userId,
        business_name: req.body.business_name,
        category: req.body.category,
        municipality: req.body.municipality,
        business_address: req.body.business_address || '',
        business_province: req.body.business_province || 'Pangasinan',
        gps_lat: req.body.gps_lat ?? null,
        gps_lng: req.body.gps_lng ?? null,
        contact_name: req.body.contact_name,
        contact_email: req.body.contact_email,
        contact_phone: req.body.contact_phone,
        preferred_contact_method: req.body.preferred_contact_method || 'email',
        sponsorship_goals: req.body.sponsorship_goals,
        proposal_details: req.body.proposal_details || '',
        declaration_version: req.body.declaration_version || '1.0',
      });

      return res.status(201).json({
        success: true,
        data: application,
      });
    } catch (err: any) {
      if (err.code === 'ACTIVE_APPLICATION_EXISTS') {
        return res.status(409).json({
          success: false,
          error: {
            code: 'ACTIVE_APPLICATION_EXISTS',
            message: 'You already have an active application under review.',
          },
        });
      }
      if (err.code === 'STORAGE_UNAVAILABLE') {
        return res.status(503).json({
          success: false,
          error: {
            code: 'STORAGE_UNAVAILABLE',
            message: 'The application could not be saved durably. Nothing was submitted — please retry.',
          },
        });
      }
      return res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: err.message || 'Failed to submit affiliate application.',
        },
      });
    }
  }
);

// Resubmit schema for needs_changes applications
const resubmitApplicationSchema = z.object({
  body: z.object({
    business_name: z.string().trim().min(2).max(200).optional(),
    category: z.string().trim().min(2).max(50).optional(),
    municipality: z.string().trim().min(2).max(100).optional(),
    business_province: z.string().trim().min(2).max(100).optional(),
    business_address: z.string().trim().max(500).optional(),
    gps_lat: z.number().min(-90).max(90).optional().nullable(),
    gps_lng: z.number().min(-180).max(180).optional().nullable(),
    contact_name: z.string().trim().min(2).max(100).optional(),
    contact_email: z.string().trim().email().max(255).optional(),
    contact_phone: z.string().trim().min(7).max(50).optional(),
    preferred_contact_method: z.enum(['email', 'phone', 'sms']).optional(),
    sponsorship_goals: z.array(z.string().min(1)).min(1).optional(),
    proposal_details: z.string().max(2000).optional(),
  }),
});

// POST /api/v1/affiliate/applications/:id/resubmit (Owner resubmit after revision requested)
affiliatesRouter.post(
  '/affiliate/applications/:id/resubmit',
  authenticateToken,
  validateRequest(resubmitApplicationSchema),
  async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const userId = req.user!.id;
    try {
      const updated = await db.resubmitAffiliateApplication(id, userId, req.body);
      return res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (err: any) {
      if (err.code === 'APPLICATION_NOT_FOUND') {
        return res.status(404).json({ success: false, error: { code: 'APPLICATION_NOT_FOUND', message: 'Application not found' } });
      }
      if (err.code === 'FORBIDDEN') {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Not authorized to edit this application' } });
      }
      if (err.code === 'INVALID_STATE_TRANSITION') {
        return res.status(400).json({ success: false, error: { code: 'INVALID_STATE_TRANSITION', message: err.message } });
      }
      if (err.code === 'STORAGE_UNAVAILABLE') {
        return res.status(503).json({
          success: false,
          error: {
            code: 'STORAGE_UNAVAILABLE',
            message: 'The resubmission could not be saved durably. Nothing changed — please retry.',
          },
        });
      }
      return res.status(500).json({ success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: err.message } });
    }
  }
);

// GET /api/v1/affiliate/applications/me (Authenticated applicant self-status lookup)
affiliatesRouter.get(
  '/affiliate/applications/me',
  authenticateToken,
  async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const application = db.findAffiliateApplicationByUser(userId);

    // Also look up if caller already has an active merchant workspace
    const merchantInfo = db.getMerchantMembershipForUser(userId);

    return res.status(200).json({
      success: true,
      data: application || null,
      merchant: merchantInfo ? {
        id: merchantInfo.merchant.id,
        name: merchantInfo.merchant.name,
        role: merchantInfo.membership.role,
        is_published: merchantInfo.merchant.is_published,
      } : null,
    });
  }
);

// Plan 59: area admins with merchants_vouchers review applications from their area only. An application's
// town comes from its municipality + province (exactly one match); unmatched applications stay platform-only.
const requireMerchantPower = requireAreaAdmin('merchants_vouchers');
const applicationArea = (application: { municipality?: string | null; business_province?: string | null }) =>
  resolveTownAreaId(application.municipality, application.business_province);
const applicationNotFound = (res: Response) =>
  res.status(404).json({ success: false, error: { code: 'APPLICATION_NOT_FOUND', message: 'Application not found' } });

// GET /api/v1/admin/affiliate/applications (Admin review queue)
affiliatesRouter.get(
  '/admin/affiliate/applications',
  authenticateToken,
  requireMerchantPower,
  async (req: AuthRequest, res: Response) => {
    const status = req.query.status as AffiliateApplicationStatus | undefined;
    const all = db.listAffiliateApplications(status);
    const scope = req.adminScope!;
    const applications = scope.platform
      ? all
      : (await Promise.all(all.map(async (application) =>
          assertInScope(scope, 'merchants_vouchers', await applicationArea(application)) ? application : null)))
          .filter((application): application is NonNullable<typeof application> => application !== null);

    return res.status(200).json({
      success: true,
      data: applications,
    });
  }
);

// GET /api/v1/admin/affiliate/applications/:id (Admin get application detail with audits)
affiliatesRouter.get(
  '/admin/affiliate/applications/:id',
  authenticateToken,
  requireMerchantPower,
  async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const application = db.findAffiliateApplicationById(id);
    if (application && !req.adminScope!.platform && !assertInScope(req.adminScope!, 'merchants_vouchers', await applicationArea(application))) {
      return applicationNotFound(res);
    }
    if (!application) {
      return res.status(404).json({
        success: false,
        error: { code: 'APPLICATION_NOT_FOUND', message: 'Application not found' },
      });
    }

    const audits = db.getApplicationAudits(id);

    return res.status(200).json({
      success: true,
      data: {
        ...application,
        audits,
      },
    });
  }
);

const updateApplicationSchema = z.object({
  body: z.object({
    status: z.enum(['in_review', 'approved', 'rejected', 'needs_changes'] as const),
    reviewer_notes: z.string().max(1000).optional(),
    applicant_feedback: z.string().max(1000).optional(),
    expected_version: z.number().int().optional(),
  }),
});

// PATCH /api/v1/admin/affiliate/applications/:id (Admin review decision & atomic provisioning)
affiliatesRouter.patch(
  '/admin/affiliate/applications/:id',
  authenticateToken,
  requireMerchantPower,
  validateRequest(updateApplicationSchema),
  async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const { status, reviewer_notes, applicant_feedback, expected_version } = req.body;
    const adminId = req.user!.id;

    const existing = db.findAffiliateApplicationById(id);
    const areaId = existing ? await applicationArea(existing) : null;
    if (existing && !req.adminScope!.platform && !assertInScope(req.adminScope!, 'merchants_vouchers', areaId)) {
      return applicationNotFound(res);
    }
    if (existing) {
      auditOnSuccess(req, res, { action: `merchant_application.${status}`, subjectType: 'affiliate_application', subjectId: existing.id,
        areaId, before: { status: existing.status } });
    }
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'APPLICATION_NOT_FOUND',
          message: 'Affiliate application not found.',
        },
      });
    }

    // Prohibit self-approval (Admin reviewing their own application)
    if (status === 'approved' && existing.user_id === adminId) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'SELF_APPROVAL_FORBIDDEN',
          message: 'Administrators cannot approve their own affiliate application.',
        },
      });
    }

    try {
      const updated = await db.updateAffiliateApplicationStatus(id, {
        status,
        reviewer_id: adminId,
        reviewer_notes,
        applicant_feedback,
        expected_version,
      });

      // A merchant provisioned on approval belongs to the application's town (Plan 59), so its area admins can see it.
      const pool = getPool();
      if (status === 'approved' && areaId && pool) {
        await pool.query('UPDATE merchants SET town_area_id = $1 WHERE source_application_id = $2 AND town_area_id IS NULL', [areaId, id]);
      }

      return res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (err: any) {
      if (err.code === 'VERSION_CONFLICT') {
        return res.status(409).json({
          success: false,
          error: {
            code: 'VERSION_CONFLICT',
            message: 'Application has been modified by another reviewer or applicant.',
          },
        });
      }
      if (err.code === 'STORAGE_UNAVAILABLE') {
        return res.status(503).json({
          success: false,
          error: {
            code: 'STORAGE_UNAVAILABLE',
            message: 'The review decision could not be saved durably. Nothing changed — please retry.',
          },
        });
      }
      return res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: err.message,
        },
      });
    }
  }
);
