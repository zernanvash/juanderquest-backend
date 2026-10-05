import { randomUUID } from 'crypto';

export type FieldLogTag = 
  | 'local_tip' 
  | 'gear_alert' 
  | 'tide_condition' 
  | 'food_find' 
  | 'heritage' 
  | 'eco_watch' 
  | 'general';

export interface SpotFieldLog {
  id: string;
  spot_id: string;
  user_id: string;
  author_name: string;
  author_badge: string;
  tag: FieldLogTag;
  content: string;
  helpful_count: number;
  helpful_user_ids: string[];
  created_at: string;
  is_verified_visit?: boolean;
}

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
  status: 'pending' | 'reviewed' | 'dismissed';
  created_at: string;
}

const SEED_LOGS: SpotFieldLog[] = [
  // Hundred Islands National Park
  {
    id: 'log-hi-01',
    spot_id: 'spot-hundred-islands',
    user_id: 'qa-sim-20260927-u01',
    author_name: 'Scout Aira',
    author_badge: 'Verified Scout • Lvl 4',
    tag: 'local_tip',
    content: 'Rent the kayak at Governor Island early morning! The hidden cave connection to Virgin Island is calmest before 9:00 AM before tour boat swells pick up.',
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
    content: 'Definitely bring aqua reef shoes! The limestone steps near Quezon Island view deck can be sharp when wet from high tide spray.',
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
    content: 'Golden hour sunset peaks at 5:45 PM. Low tide reveals natural tidal pools on the southern coral shelf where colorful hermit crabs and small reef fish gather.',
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
    content: 'Please carry all single-use plastics and drink containers back to the main parking lot disposal bins. Let’s keep Bolinao’s creamy sand clean for nesting turtles!',
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
    content: 'Freshly grilled hot Tupig wrapped in scorched banana leaves is available right outside the north gate (₱10 each). Pairs amazingly with hot Kapeng Barako!',
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
    content: 'Life vests are strictly required for cliff jumping into the freshwater pool (₱50 rental at entrance). The spring water is approx 18-20ft deep and invigoratingly cold!',
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
    content: 'The Capitol baywalk features historical bronze plaques detailing the 1945 Allied landing. Best jogged from 5:00 AM to 6:30 AM before the coastal sun heats up.',
    helpful_count: 17,
    helpful_user_ids: ['u-auto-11', 'u-auto-12'],
    created_at: '2026-10-04T16:00:00Z',
    is_verified_visit: true,
  },
];

class FieldLogStore {
  private logs: SpotFieldLog[] = [...SEED_LOGS];
  private reports: SpotReport[] = [];

  list(spotId: string): SpotFieldLog[] {
    return this.logs
      .filter((l) => l.spot_id === spotId)
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
    isVerifiedVisit = false
  ): SpotFieldLog {
    const log: SpotFieldLog = {
      id: `log-${randomUUID().slice(0, 8)}`,
      spot_id: spotId,
      user_id: userId,
      author_name: authorName || 'Fellow Scout',
      author_badge: authorBadge || 'Explorer',
      tag: tag || 'local_tip',
      content: content.trim(),
      helpful_count: 0,
      helpful_user_ids: [],
      created_at: new Date().toISOString(),
      is_verified_visit: isVerifiedVisit,
    };

    this.logs.unshift(log);
    return log;
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

  createReport(
    spotId: string,
    reason: SpotReportReason,
    userId?: string,
    reporterName?: string,
    details?: string
  ): SpotReport {
    const report: SpotReport = {
      id: `rep-${randomUUID().slice(0, 8)}`,
      spot_id: spotId,
      user_id: userId,
      reporter_name: reporterName || 'Anonymous Scout',
      reason,
      details: details ? details.trim() : undefined,
      status: 'pending',
      created_at: new Date().toISOString(),
    };

    this.reports.unshift(report);
    return report;
  }

  listReports(spotId?: string): SpotReport[] {
    if (spotId) {
      return this.reports.filter((r) => r.spot_id === spotId);
    }
    return [...this.reports];
  }
}

export const fieldLogStore = new FieldLogStore();
