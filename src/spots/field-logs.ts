import { randomUUID } from 'crypto';
import { getPool } from '../db/pool.js';

export type FieldLogTag =
  'local_tip' | 'gear_alert' | 'tide_condition' | 'food_find' | 'heritage' | 'eco_watch' | 'general';

export interface SpotFieldLog {
  id: string;
  spot_id: string;
  user_id: string;
  author_name: string;
  author_badge?: string;
  author_avatar?: string;
  tag?: FieldLogTag;
  content: string;
  image_url?: string;
  location_pin?: {
    name: string;
    lat?: number;
    lng?: number;
  };
  helpful_count: number;
  helpful_user_ids: string[];
  created_at: string;
  is_verified_visit?: boolean;
  /** v0.3.1: set when the author edits the note. */
  edited_at?: string;
}

/** v0.3.1: a note hides once this many different people report it. */
export const NOTE_REPORT_HIDE_THRESHOLD = 3;
export const NOTE_REPORT_REASONS = ['spam', 'offensive', 'false_info', 'other'] as const;
export type NoteReportReason = (typeof NOTE_REPORT_REASONS)[number];

export type NoteActionResult<T> =
  { ok: true; value: T } | { ok: false; code: 'NOT_FOUND' | 'FORBIDDEN' | 'ALREADY_REPORTED' };

export type SpotReportReason =
  | 'inaccurate_location'
  | 'site_closed_or_hazard'
  | 'misleading_photo'
  | 'spam_or_scam'
  | 'environmental_concern'
  | 'other';

export interface SpotReport {
  id: string;
  spot_id: string;
  user_id?: string;
  reporter_name?: string;
  reason: SpotReportReason;
  details?: string;
  weight?: number;
  status: 'pending' | 'reviewed' | 'dismissed';
  created_at: string;
  resolved_by?: string;
  resolved_at?: string;
  resolution_note?: string;
}

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value ? String(value) : undefined);

// Plan 92b: spot_reports rows (migration 088) in the same shape as the in-memory reports.
const reportFromRow = (row: Record<string, unknown>): SpotReport => ({
  id: String(row.id),
  spot_id: String(row.spot_id),
  user_id: row.user_id ? String(row.user_id) : undefined,
  reporter_name: String(row.reporter_name),
  reason: row.reason as SpotReportReason,
  details: row.details ? String(row.details) : undefined,
  weight: row.weight !== undefined && row.weight !== null ? Number(row.weight) : 1,
  status: row.status as SpotReport['status'],
  created_at: iso(row.created_at)!,
  resolved_by: row.resolved_by ? String(row.resolved_by) : undefined,
  resolved_at: iso(row.resolved_at),
  resolution_note: row.resolution_note ? String(row.resolution_note) : undefined,
});

const SEED_LOGS: SpotFieldLog[] = [
  // Hundred Islands National Park
  {
    id: 'log-hi-01',
    spot_id: 'spot-hundred-islands',
    user_id: 'qa-sim-20260927-u01',
    author_name: 'Scout Aira',
    author_badge: 'Verified Scout • Lvl 4',
    author_avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=150&q=80',
    tag: 'local_tip',
    content:
      'Rent the kayak at Governor Island early morning! 🚣🌊 The hidden cave connection to Virgin Island is calmest before 9:00 AM before tour boat swells pick up. Absolutely breathtaking! ✨',
    location_pin: {
      name: 'Governor Island Kayak Dock, Alaminos',
      lat: 16.2023,
      lng: 120.0435,
    },
    image_url: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=700&q=80',
    helpful_count: 16,
    helpful_user_ids: ['u-auto-01', 'u-auto-02'],
    created_at: '2026-09-28T07:30:00Z',
    is_verified_visit: true,
  },
  {
    id: 'log-hi-02',
    spot_id: 'spot-hundred-islands',
    user_id: 'qa-sim-20260927-u02',
    author_name: 'Scout Ben',
    author_badge: 'Pangasinan Pioneer',
    tag: 'gear_alert',
    content:
      'Definitely bring aqua reef shoes! 👟 The limestone steps near Quezon Island view deck can be sharp when wet from high tide spray. 🌊',
    location_pin: {
      name: 'Quezon Island View Deck, Alaminos',
    },
    helpful_count: 11,
    helpful_user_ids: ['u-auto-03'],
    created_at: '2026-09-30T10:15:00Z',
    is_verified_visit: true,
  },

  // Patar White Beach
  {
    id: 'log-patar-01',
    spot_id: 'spot-patar',
    user_id: 'qa-sim-20260927-u06',
    author_name: 'Scout Franco',
    author_badge: 'Coastal Scout • Lvl 3',
    tag: 'tide_condition',
    content:
      'Golden hour sunset peaks at 5:45 PM. Low tide reveals natural tidal pools on the southern coral shelf where colorful hermit crabs and small reef fish gather.',
    helpful_count: 19,
    helpful_user_ids: ['u-auto-04', 'u-auto-05', 'u-auto-06'],
    created_at: '2026-10-01T14:20:00Z',
    is_verified_visit: true,
  },
  {
    id: 'log-patar-02',
    spot_id: 'spot-patar',
    user_id: 'qa-sim-20260927-u03',
    author_name: 'Scout Celine',
    author_badge: 'Conservation Guardian',
    tag: 'eco_watch',
    content:
      'Please carry all single-use plastics and drink containers back to the main parking lot disposal bins. Let’s keep Bolinao’s creamy sand clean for nesting turtles!',
    helpful_count: 14,
    helpful_user_ids: ['u-auto-07'],
    created_at: '2026-10-02T09:00:00Z',
    is_verified_visit: false,
  },

  // Minor Basilica of Manaoag
  {
    id: 'log-manaoag-01',
    spot_id: 'spot-manaoag',
    user_id: 'qa-sim-20260927-u04',
    author_name: 'Scout Diego',
    author_badge: 'Heritage Scout • Lvl 5',
    tag: 'food_find',
    content:
      'Freshly grilled hot Tupig wrapped in scorched banana leaves is available right outside the north gate (₱10 each). Pairs amazingly with hot Kapeng Barako!',
    helpful_count: 24,
    helpful_user_ids: ['u-auto-08', 'u-auto-09'],
    created_at: '2026-10-03T11:45:00Z',
    is_verified_visit: true,
  },

  // Bolinao Falls 1
  {
    id: 'log-falls-01',
    spot_id: 'spot-bolinao-falls',
    user_id: 'qa-sim-20260927-u05',
    author_name: 'Scout Ella',
    author_badge: 'Wilderness Explorer',
    tag: 'gear_alert',
    content:
      'Life vests are strictly required for cliff jumping into the freshwater pool (₱50 rental at entrance). The spring water is approx 18-20ft deep and invigoratingly cold!',
    helpful_count: 13,
    helpful_user_ids: ['u-auto-10'],
    created_at: '2026-10-04T08:10:00Z',
    is_verified_visit: true,
  },

  // Lingayen Baywalk
  {
    id: 'log-lingayen-01',
    spot_id: 'spot-lingayen',
    user_id: 'user-patricia',
    author_name: 'Patricia Santos',
    author_badge: 'Tourism Officer',
    tag: 'heritage',
    content:
      'The Capitol baywalk features historical bronze plaques detailing the 1945 Allied landing. Best jogged from 5:00 AM to 6:30 AM before the coastal sun heats up.',
    helpful_count: 17,
    helpful_user_ids: ['u-auto-11', 'u-auto-12'],
    created_at: '2026-10-04T16:00:00Z',
    is_verified_visit: true,
  },
];

export class FieldLogStore {
  private logs: SpotFieldLog[] = [...SEED_LOGS];
  private reports: SpotReport[] = [];
  /** v0.3.1: note id → reporter ids (and reasons), kept with the notes. */
  private noteReports = new Map<string, Map<string, NoteReportReason>>();
  private hiddenNotes = new Set<string>();

  list(spotId: string): SpotFieldLog[] {
    return this.logs
      .filter((l) => l.spot_id === spotId && !this.hiddenNotes.has(l.id))
      .sort((a, b) => {
        // Helpful count primary, then recency
        if (b.helpful_count !== a.helpful_count) {
          return b.helpful_count - a.helpful_count;
        }
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
  }

  create(
    spotId: string,
    userId: string,
    authorName: string,
    authorBadge: string,
    tag: FieldLogTag,
    content: string,
    isVerifiedVisit = false,
    imageUrl?: string,
    locationPin?: { name: string; lat?: number; lng?: number },
    authorAvatar?: string,
  ): SpotFieldLog {
    const log: SpotFieldLog = {
      id: `log-${randomUUID().slice(0, 8)}`,
      spot_id: spotId,
      user_id: userId,
      author_name: authorName || 'Fellow Scout',
      author_badge: authorBadge || 'Explorer',
      author_avatar: authorAvatar,
      tag: tag || 'general',
      content: content.trim(),
      image_url: imageUrl,
      location_pin: locationPin,
      helpful_count: 0,
      helpful_user_ids: [],
      created_at: new Date().toISOString(),
      is_verified_visit: isVerifiedVisit,
    };

    this.logs.unshift(log);
    return log;
  }

  private findNote(spotId: string, logId: string) {
    return this.logs.find((l) => l.spot_id === spotId && l.id === logId && !this.hiddenNotes.has(l.id));
  }

  /** v0.3.1: only the author edits their note. */
  update(spotId: string, logId: string, userId: string, content: string): NoteActionResult<SpotFieldLog> {
    const log = this.findNote(spotId, logId);
    if (!log) return { ok: false, code: 'NOT_FOUND' };
    if (log.user_id !== userId) return { ok: false, code: 'FORBIDDEN' };
    log.content = content.trim();
    log.edited_at = new Date().toISOString();
    return { ok: true, value: log };
  }

  /** v0.3.1: the author (or an admin) deletes a note. */
  remove(spotId: string, logId: string, userId: string, isAdmin = false): NoteActionResult<string> {
    const log = this.findNote(spotId, logId);
    if (!log) return { ok: false, code: 'NOT_FOUND' };
    if (log.user_id !== userId && !isAdmin) return { ok: false, code: 'FORBIDDEN' };
    this.logs = this.logs.filter((l) => l.id !== logId);
    this.noteReports.delete(logId);
    return { ok: true, value: logId };
  }

  /** v0.3.1: any signed-in traveler except the author reports a note, once. */
  reportNote(
    spotId: string,
    logId: string,
    userId: string,
    reason: NoteReportReason,
  ): NoteActionResult<{ reports: number; hidden: boolean }> {
    const log = this.findNote(spotId, logId);
    if (!log) return { ok: false, code: 'NOT_FOUND' };
    if (log.user_id === userId) return { ok: false, code: 'FORBIDDEN' };
    const reporters = this.noteReports.get(logId) ?? new Map<string, NoteReportReason>();
    if (reporters.has(userId)) return { ok: false, code: 'ALREADY_REPORTED' };
    reporters.set(userId, reason);
    this.noteReports.set(logId, reporters);
    const hidden = reporters.size >= NOTE_REPORT_HIDE_THRESHOLD;
    if (hidden) this.hiddenNotes.add(logId);
    return { ok: true, value: { reports: reporters.size, hidden } };
  }

  toggleHelpful(spotId: string, logId: string, userId: string): { helpful_count: number; is_helpful: boolean } | null {
    const log = this.logs.find((l) => l.spot_id === spotId && l.id === logId);
    if (!log) return null;

    const existingIndex = log.helpful_user_ids.indexOf(userId);
    let isHelpful = false;

    if (existingIndex >= 0) {
      log.helpful_user_ids.splice(existingIndex, 1);
      log.helpful_count = Math.max(0, log.helpful_count - 1);
      isHelpful = false;
    } else {
      log.helpful_user_ids.push(userId);
      log.helpful_count += 1;
      isHelpful = true;
    }

    return {
      helpful_count: log.helpful_count,
      is_helpful: isHelpful,
    };
  }

  async createReport(
    spotId: string,
    reason: SpotReportReason,
    userId?: string,
    reporterName?: string,
    details?: string,
    weight = 1,
  ): Promise<SpotReport> {
    const report: SpotReport = {
      id: `rep-${randomUUID().slice(0, 8)}`,
      spot_id: spotId,
      user_id: userId,
      reporter_name: reporterName || 'Anonymous Scout',
      reason,
      details: details ? details.trim() : undefined,
      weight,
      status: 'pending',
      created_at: new Date().toISOString(),
    };

    const pool = getPool();
    if (pool) {
      await pool.query(
        `INSERT INTO spot_reports(id, spot_id, user_id, reporter_name, reason, details, weight, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          report.id,
          report.spot_id,
          report.user_id ?? null,
          report.reporter_name,
          report.reason,
          report.details ?? null,
          report.weight ?? 1,
          report.status,
          report.created_at,
        ],
      );
      return report;
    }
    this.reports.unshift(report);
    return report;
  }

  async hasUserReportedSpot(spotId: string, userId: string): Promise<boolean> {
    const pool = getPool();
    if (pool) {
      const result = await pool.query(`SELECT 1 FROM spot_reports WHERE spot_id = $1 AND user_id = $2 LIMIT 1`, [
        spotId,
        userId,
      ]);
      return Boolean(result.rows.length);
    }
    return this.reports.some((r) => r.spot_id === spotId && r.user_id === userId);
  }

  async sumPendingReportWeight(spotId: string): Promise<number> {
    const pool = getPool();
    if (pool) {
      const result = await pool.query(
        `SELECT COALESCE(SUM(weight), 0) AS total
           FROM spot_reports
          WHERE spot_id = $1 AND status = 'pending' AND weight > 0`,
        [spotId],
      );
      return Number(result.rows[0]?.total ?? 0);
    }
    return this.reports
      .filter((r) => r.spot_id === spotId && r.status === 'pending' && (r.weight ?? 1) > 0)
      .reduce((sum, r) => sum + (r.weight ?? 1), 0);
  }

  async resolvePendingReportsForSpot(
    spotId: string,
    status: 'reviewed' | 'dismissed',
    resolvedBy: string,
    note: string,
  ): Promise<void> {
    const pool = getPool();
    if (pool) {
      await pool.query(
        `UPDATE spot_reports
            SET status = $2, resolved_by = $3, resolved_at = NOW(), resolution_note = $4, updated_at = NOW()
          WHERE spot_id = $1 AND status = 'pending'`,
        [spotId, status, resolvedBy, note],
      );
      return;
    }
    const now = new Date().toISOString();
    for (const report of this.reports) {
      if (report.spot_id === spotId && report.status === 'pending') {
        report.status = status;
        report.resolved_by = resolvedBy;
        report.resolved_at = now;
        report.resolution_note = note;
      }
    }
  }

  async listReports(spotId?: string): Promise<SpotReport[]> {
    const pool = getPool();
    if (pool) {
      const result = await pool.query(
        `SELECT * FROM spot_reports WHERE ($1::text IS NULL OR spot_id = $1) ORDER BY created_at DESC, id`,
        [spotId ?? null],
      );
      return result.rows.map(reportFromRow);
    }
    if (spotId) {
      return this.reports.filter((r) => r.spot_id === spotId);
    }
    return [...this.reports];
  }

  async findReport(id: string): Promise<SpotReport | undefined> {
    const pool = getPool();
    if (pool) {
      const result = await pool.query('SELECT * FROM spot_reports WHERE id = $1', [id]);
      return result.rows[0] ? reportFromRow(result.rows[0]) : undefined;
    }
    return this.reports.find((r) => r.id === id);
  }

  async resolveReport(
    id: string,
    input: { status: 'reviewed' | 'dismissed'; resolvedBy: string; note: string },
  ): Promise<SpotReport | undefined> {
    const pool = getPool();
    if (pool) {
      const result = await pool.query(
        `UPDATE spot_reports
            SET status = $2, resolved_by = $3, resolved_at = NOW(), resolution_note = $4, updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [id, input.status, input.resolvedBy, input.note],
      );
      return result.rows[0] ? reportFromRow(result.rows[0]) : undefined;
    }
    const report = this.reports.find((r) => r.id === id);
    if (!report) return undefined;
    Object.assign(report, {
      status: input.status,
      resolved_by: input.resolvedBy,
      resolved_at: new Date().toISOString(),
      resolution_note: input.note,
    });
    return report;
  }
}

export const fieldLogStore = new FieldLogStore();
