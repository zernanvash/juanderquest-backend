import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validate.js';
import { forwardAsyncRouteErrors } from '../middleware/asyncRoutes.js';
import { getPool } from '../db/pool.js';
import { db } from '../db/index.js';
import { assertInScope, requireAreaAdmin, writeAdminAudit, type AdminScope } from '../admin/scope.js';
import { notify } from '../social/notify.js';

export const adminMerchantClaimsRouter = Router();

const listClaimsQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'all']).optional().default('pending'),
});

const reviewClaimSchema = z.object({
  body: z.object({
    decision: z.enum(['approve', 'reject']),
    review_note: z.string().trim().min(3, 'Review note must be 3-300 characters.').max(300),
  }),
});

function claimSpotInScope(
  scope: AdminScope,
  spot: { town_area_id?: string | null; barangay_area_id?: string | null },
): boolean {
  if (scope.platform) return true;
  return (
    assertInScope(scope, 'merchants_vouchers', spot.town_area_id) ||
    assertInScope(scope, 'merchants_vouchers', spot.barangay_area_id) ||
    assertInScope(scope, 'destinations', spot.town_area_id) ||
    assertInScope(scope, 'destinations', spot.barangay_area_id)
  );
}

// GET /api/v1/admin/merchant-spot-claims?status=pending|approved|rejected|cancelled|all
adminMerchantClaimsRouter.get(
  '/admin/merchant-spot-claims',
  authenticateToken,
  requireAreaAdmin(['merchants_vouchers', 'destinations']),
  async (req: AuthRequest, res: Response) => {
    const pool = getPool();
    if (!pool) {
      return res.status(503).json({
        success: false,
        error: { code: 'DATABASE_REQUIRED', message: 'Durable storage is required for claim review.' },
      });
    }
    const parsed = listClaimsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid status filter.' },
      });
    }
    const status = parsed.data.status;
    const scope = req.adminScope!;
    const params: unknown[] = [];
    const whereClause = status === 'all' ? '' : (params.push(status), `WHERE c.status = $${params.length}`);

    const result = await pool.query(
      `SELECT c.id, c.merchant_id, c.spot_id, c.requested_by, c.note, c.proof_url,
              c.status, c.reviewed_by, c.reviewed_at, c.review_note, c.is_test,
              c.created_at, c.updated_at,
              m.name AS merchant_name, m.category AS merchant_category,
              u.handle AS owner_handle, u.display_name AS owner_display_name,
              s.name AS spot_name, s.slug AS spot_slug, s.municipality AS spot_municipality,
              s.gps_lat AS spot_lat, s.gps_lng AS spot_lng, s.source_type AS spot_source_type,
              s.town_area_id, s.barangay_area_id,
              ru.handle AS reviewer_handle
         FROM merchant_spot_claim_requests c
         JOIN merchants m ON m.id = c.merchant_id
         JOIN spots s ON s.id = c.spot_id
         LEFT JOIN users u ON u.id = c.requested_by
         LEFT JOIN users ru ON ru.id = c.reviewed_by
        ${whereClause}
        ORDER BY (c.status = 'pending') DESC, c.created_at DESC
        LIMIT 200`,
      params,
    );

    const items = result.rows
      .filter((row: any) =>
        claimSpotInScope(scope, {
          town_area_id: row.town_area_id ? String(row.town_area_id) : null,
          barangay_area_id: row.barangay_area_id ? String(row.barangay_area_id) : null,
        }),
      )
      .map((row: any) => ({
        id: String(row.id),
        merchant_id: String(row.merchant_id),
        merchant_name: String(row.merchant_name),
        merchant_category: row.merchant_category ? String(row.merchant_category) : null,
        requested_by: String(row.requested_by),
        owner_username: row.owner_handle ? String(row.owner_handle) : null,
        owner_display_name: row.owner_display_name ? String(row.owner_display_name) : null,
        spot_id: String(row.spot_id),
        spot_name: String(row.spot_name),
        spot_slug: String(row.spot_slug),
        spot_municipality: String(row.spot_municipality ?? ''),
        spot_lat: Number(row.spot_lat),
        spot_lng: Number(row.spot_lng),
        spot_source_type: row.spot_source_type ? String(row.spot_source_type) : null,
        note: String(row.note),
        proof_url: row.proof_url ? String(row.proof_url) : null,
        status: String(row.status),
        reviewed_by: row.reviewed_by ? String(row.reviewed_by) : null,
        reviewer_username: row.reviewer_handle ? String(row.reviewer_handle) : null,
        reviewed_at: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
        review_note: row.review_note ? String(row.review_note) : null,
        is_test: Boolean(row.is_test),
        created_at: new Date(row.created_at).toISOString(),
        updated_at: new Date(row.updated_at).toISOString(),
      }));

    return res.status(200).json({
      success: true,
      data: items,
      meta: { count: items.length, status },
    });
  },
);

// POST /api/v1/admin/merchant-spot-claims/:id/review
adminMerchantClaimsRouter.post(
  '/admin/merchant-spot-claims/:id/review',
  authenticateToken,
  requireAreaAdmin(['merchants_vouchers', 'destinations']),
  validateRequest(reviewClaimSchema),
  async (req: AuthRequest, res: Response) => {
    const pool = getPool();
    if (!pool) {
      return res.status(503).json({
        success: false,
        error: { code: 'DATABASE_REQUIRED', message: 'Durable storage is required for claim review.' },
      });
    }
    const claimId = String(req.params.id);
    const { decision, review_note } = req.body as { decision: 'approve' | 'reject'; review_note: string };
    const scope = req.adminScope!;
    const actorRole = scope.platform ? 'admin' : 'area_admin';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const claimRes = await client.query(
        `SELECT id, merchant_id, spot_id, requested_by, status, is_test
           FROM merchant_spot_claim_requests
          WHERE id = $1
          FOR UPDATE`,
        [claimId],
      );
      const claim = claimRes.rows[0];
      if (!claim) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          error: { code: 'CLAIM_NOT_FOUND', message: 'Location claim request not found.' },
        });
      }

      const spotRes = await client.query(
        `SELECT id, name, status, gps_lat, gps_lng, town_area_id, barangay_area_id
           FROM spots
          WHERE id = $1
          LIMIT 1`,
        [claim.spot_id],
      );
      const spot = spotRes.rows[0];
      if (!spot) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          error: { code: 'SPOT_NOT_FOUND', message: 'Claimed destination no longer exists.' },
        });
      }

      if (
        !claimSpotInScope(scope, {
          town_area_id: spot.town_area_id ? String(spot.town_area_id) : null,
          barangay_area_id: spot.barangay_area_id ? String(spot.barangay_area_id) : null,
        })
      ) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          success: false,
          error: { code: 'AREA_SCOPE_FORBIDDEN', message: 'This destination is outside your assigned admin area.' },
        });
      }

      if (claim.status !== 'pending') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          success: false,
          error: { code: 'CLAIM_ALREADY_REVIEWED', message: `Claim is already ${claim.status}.` },
        });
      }

      let competingRejected = 0;
      if (decision === 'approve') {
        if (spot.status !== 'published') {
          await client.query('ROLLBACK');
          return res.status(409).json({
            success: false,
            error: {
              code: 'SPOT_NOT_PUBLISHED',
              message: 'Only published destinations can be linked to a Local Partner.',
            },
          });
        }
        const alreadyLinked = await client.query(
          `SELECT id FROM merchants WHERE spot_id = $1 AND id <> $2 AND status = 'active' LIMIT 1`,
          [claim.spot_id, claim.merchant_id],
        );
        if (alreadyLinked.rowCount) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            success: false,
            error: {
              code: 'SPOT_ALREADY_LINKED_TO_MERCHANT',
              message: 'This destination is already linked to another active Local Partner.',
            },
          });
        }

        await client.query(
          `UPDATE merchants
              SET spot_id = $1, gps_lat = $2, gps_lng = $3
            WHERE id = $4`,
          [claim.spot_id, Number(spot.gps_lat), Number(spot.gps_lng), claim.merchant_id],
        );

        await client.query(
          `UPDATE merchant_spot_claim_requests
              SET status = 'approved',
                  reviewed_by = $1,
                  reviewed_at = NOW(),
                  review_note = $2,
                  updated_at = NOW()
            WHERE id = $3`,
          [req.user!.id, review_note, claimId],
        );

        const competing = await client.query(
          `UPDATE merchant_spot_claim_requests
              SET status = 'rejected',
                  reviewed_by = $1,
                  reviewed_at = NOW(),
                  review_note = 'Auto-rejected: another claim for this destination was approved.',
                  updated_at = NOW()
            WHERE spot_id = $2
              AND id <> $3
              AND status = 'pending'
            RETURNING id, requested_by, is_test`,
          [req.user!.id, claim.spot_id, claimId],
        );
        competingRejected = competing.rowCount ?? 0;

        await notify(client, {
          userId: String(claim.requested_by),
          kind: 'spot_moderation',
          eventKey: `merchant_spot_claim:${claimId}:approved`,
          title: 'Local Partner location approved',
          message: `Your location claim for ${spot.name} was approved: ${review_note}`,
          href: '/merchant/location',
          isTest: Boolean(claim.is_test),
        });

        for (const other of competing.rows) {
          await notify(client, {
            userId: String(other.requested_by),
            kind: 'spot_moderation',
            eventKey: `merchant_spot_claim:${other.id}:auto_rejected`,
            title: 'Location claim closed',
            message: `Your location claim for ${spot.name} was closed because another claim was approved.`,
            href: '/merchant/location',
            isTest: Boolean(other.is_test),
          });
        }
      } else {
        await client.query(
          `UPDATE merchant_spot_claim_requests
              SET status = 'rejected',
                  reviewed_by = $1,
                  reviewed_at = NOW(),
                  review_note = $2,
                  updated_at = NOW()
            WHERE id = $3`,
          [req.user!.id, review_note, claimId],
        );

        await notify(client, {
          userId: String(claim.requested_by),
          kind: 'spot_moderation',
          eventKey: `merchant_spot_claim:${claimId}:rejected`,
          title: 'Local Partner location claim rejected',
          message: `Your location claim for ${spot.name} was rejected: ${review_note}`,
          href: '/merchant/location',
          isTest: Boolean(claim.is_test),
        });
      }

      await client.query('COMMIT');

      if (decision === 'approve') {
        db.syncMerchantSpotCache(
          String(claim.merchant_id),
          String(claim.spot_id),
          Number(spot.gps_lat),
          Number(spot.gps_lng),
        );
      }

      await writeAdminAudit({
        actorId: req.user!.id,
        actorRole,
        areaId: spot.town_area_id ? String(spot.town_area_id) : null,
        action: `merchant_spot_claim.${decision}`,
        subjectType: 'merchant_spot_claim_request',
        subjectId: claimId,
        before: { status: 'pending', merchant_id: claim.merchant_id, spot_id: claim.spot_id },
        after: {
          status: decision === 'approve' ? 'approved' : 'rejected',
          review_note,
          competing_rejected: competingRejected,
        },
      }).catch(() => undefined);

      return res.status(200).json({
        success: true,
        data: {
          id: claimId,
          merchant_id: String(claim.merchant_id),
          spot_id: String(claim.spot_id),
          status: decision === 'approve' ? 'approved' : 'rejected',
          review_note,
          competing_rejected: competingRejected,
        },
      });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (err?.code === '23505') {
        return res.status(409).json({
          success: false,
          error: {
            code: 'SPOT_ALREADY_LINKED_TO_MERCHANT',
            message: 'This destination is already linked to another active Local Partner.',
          },
        });
      }
      return res.status(503).json({
        success: false,
        error: { code: 'CLAIM_REVIEW_UNAVAILABLE', message: 'Could not review location claim right now.' },
      });
    } finally {
      client.release();
    }
  },
);

forwardAsyncRouteErrors(adminMerchantClaimsRouter);
