import { Router, Response } from 'express';
import { z } from 'zod';
import { db, AffiliateApplicationStatus } from '../db/index.js';
import { authenticateToken, requireAdmin, AuthRequest } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validate.js';

export const affiliatesRouter = Router();

const createApplicationSchema = z.object({
  body: z.object({
    business_name: z.string().trim().min(2, 'Business name must be at least 2 characters').max(200),
    category: z.string().trim().min(2).max(50),
    municipality: z.string().trim().min(2).max(100),
    contact_name: z.string().trim().min(2, 'Contact name must be at least 2 characters').max(100),
    contact_email: z.string().trim().email('Invalid contact email address').max(255),
    contact_phone: z.string().trim().min(7, 'Phone number must be at least 7 characters').max(50),
    sponsorship_goals: z.array(z.string().min(1)).min(1, 'Select at least one sponsorship goal'),
    proposal_details: z.string().max(2000).optional(),
  }),
});

const updateApplicationSchema = z.object({
  body: z.object({
    status: z.enum(['in_review', 'approved', 'rejected'] as const),
    reviewer_notes: z.string().max(1000).optional(),
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
      const application = db.createAffiliateApplication({
        user_id: userId,
        business_name: req.body.business_name,
        category: req.body.category,
        municipality: req.body.municipality,
        contact_name: req.body.contact_name,
        contact_email: req.body.contact_email,
        contact_phone: req.body.contact_phone,
        sponsorship_goals: req.body.sponsorship_goals,
        proposal_details: req.body.proposal_details || '',
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

// GET /api/v1/affiliate/applications/me (Authenticated applicant self-status lookup)
affiliatesRouter.get(
  '/affiliate/applications/me',
  authenticateToken,
  async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const application = db.findAffiliateApplicationByUser(userId);

    return res.status(200).json({
      success: true,
      data: application || null,
    });
  }
);

// GET /api/v1/admin/affiliate/applications (Admin review queue)
affiliatesRouter.get(
  '/admin/affiliate/applications',
  authenticateToken,
  requireAdmin,
  async (req: AuthRequest, res: Response) => {
    const status = req.query.status as AffiliateApplicationStatus | undefined;
    const applications = db.listAffiliateApplications(status);

    return res.status(200).json({
      success: true,
      data: applications,
    });
  }
);

// PATCH /api/v1/admin/affiliate/applications/:id (Admin review decision)
affiliatesRouter.patch(
  '/admin/affiliate/applications/:id',
  authenticateToken,
  requireAdmin,
  validateRequest(updateApplicationSchema),
  async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const { status, reviewer_notes } = req.body;
    const adminId = req.user!.id;

    const existing = db.findAffiliateApplicationById(id);
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'APPLICATION_NOT_FOUND',
          message: 'Affiliate application not found.',
        },
      });
    }

    const updated = db.updateAffiliateApplicationStatus(id, {
      status,
      reviewer_id: adminId,
      reviewer_notes,
    });

    return res.status(200).json({
      success: true,
      data: updated,
    });
  }
);
