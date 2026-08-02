import type { Pool } from 'pg';
import type { MemoryDb } from '../db/index.js';

export const MJDQ_PER_JDQ = 1000;

export type GovernanceState =
  | 'draft'
  | 'screening'
  | 'voting'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'scheduled'
  | 'active'
  | 'feedback'
  | 'payout_pending'
  | 'disputed'
  | 'completed'
  | 'cancelled';

export interface PayoutRecipient {
  user_id: string;
  display_name: string;
  role: 'organizer' | 'manager' | 'merchant';
  duty: string;
  share_bps: number;
}

export interface GovernanceProposal {
  id: string;
  title: string;
  location_name: string;
  category: 'eco' | 'cultural' | 'food_trade';
  description: string;
  proposed_lat?: number;
  proposed_lng?: number;
  submitted_by: string;
  submitted_by_id: string;
  state: GovernanceState;
  recipients: PayoutRecipient[];
  organizer_bond_mjdq: number;
  bond_status: 'not_locked' | 'locked' | 'refunded' | 'slashed_50' | 'slashed_100';
  eligible_voter_snapshot: number;
  // Snapshot of eligible voter ids captured when voting opens (one eligible user, one vote).
  eligible_voter_ids?: string[];
  quorum_required: number;
  yes_votes: number;
  no_votes: number;
  votes: number;
  vote_fee_mjdq: number;
  escrow_mjdq: number;
  voting_opens_at?: string;
  voting_closes_at?: string;
  quest_starts_at?: string;
  quest_ends_at?: string;
  feedback_opens_at?: string;
  feedback_closes_at?: string;
  feedback_eligible_snapshot: number;
  feedback_quorum_required: number;
  approve_feedback: number;
  disapprove_feedback: number;
  feedback_escrow_mjdq: number;
  screening_reason?: string;
  evidence_reference?: string;
  created_at: string;
  updated_at: string;
}

export interface LedgerEntry {
  id: string;
  transaction_group_id: string;
  type: string;
  account: string;
  amount_mjdq: number;
  reference_type: string;
  reference_id: string;
  actor_id: string;
  idempotency_key?: string;
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface AuditEvent {
  id: string;
  action: string;
  actor_id: string;
  subject_type: string;
  subject_id: string;
  reason?: string;
  evidence_reference?: string;
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface GovernanceControls {
  pause_votes: boolean;
  pause_payouts: boolean;
  pause_vouchers: boolean;
  pause_all_financial: boolean;
  updated_by: string;
  updated_at: string;
}

interface VoteRecord {
  proposal_id: string;
  user_id: string;
  choice: 'yes' | 'no';
  idempotency_key: string;
}

interface FeedbackRecord {
  proposal_id: string;
  user_id: string;
  choice: 'approve' | 'disapprove';
  rating?: number;
  comment?: string;
  idempotency_key: string;
}

const now = () => new Date().toISOString();
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 86_400_000).toISOString();
const id = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

export class GovernanceStore {
  readonly proposalVoteFee = 5 * MJDQ_PER_JDQ;
  readonly feedbackVoteFee = 2 * MJDQ_PER_JDQ;
  readonly organizerBond = 25 * MJDQ_PER_JDQ;
  readonly burnBps = 2000;
  readonly voteWindowDays = 7;
  readonly defaultQuestDays = 30;
  readonly feedbackWindowDays = 7;
  // ponytail: quorum floor is 1 so the single seeded eligible user can demonstrate the full vote lifecycle.
  readonly quorumFloor = 1;

  private proposals: GovernanceProposal[] = [];
  private votes: VoteRecord[] = [];
  private feedbackVotes: FeedbackRecord[] = [];
  private balances = new Map<string, number>();
  private ledger: LedgerEntry[] = [];
  private audit: AuditEvent[] = [];
  private burnedMjdq = 0;
  private treasuryMjdq = 0;
  private issuedMjdq = 0;
  private idempotency = new Map<string, { fingerprint: string; response: unknown }>();
  private controls: GovernanceControls = {
    pause_votes: false,
    pause_payouts: false,
    pause_vouchers: false,
    pause_all_financial: false,
    updated_by: 'system',
    updated_at: now(),
  };
  private pg: Pool | null = null;

  constructor(private readonly db: MemoryDb) {
    for (const user of db.users) {
      const balance = user.demo_points * MJDQ_PER_JDQ;
      this.balances.set(user.id, balance);
      this.issuedMjdq += balance;
    }
    this.seedProposals();
  }

  private seedProposals() {
    const organizer = this.db.users.find((user) => user.role === 'user');
    if (!organizer) return;
    const seeds = [
      ['Patar White Beach Eco Trail', 'Bolinao, Pangasinan', 'eco', 'Feature the coast responsibly with cleanup, local guide, and safety activities.'],
      ['Tayug Sunflower Farm Quest', 'Tayug, Pangasinan', 'eco', 'Promote agri-tourism and local farm products through a seasonal visitor quest.'],
      ['San Fabian Heritage Trail', 'San Fabian, Pangasinan', 'cultural', 'Interpret local landing sites and community history with resident guides.'],
    ] as const;
    this.proposals = seeds.map(([title, location, category, description], index) => ({
      id: `prop_${index + 1}`,
      title,
      location_name: location,
      category,
      description,
      submitted_by: organizer.display_name,
      submitted_by_id: organizer.id,
      state: 'screening',
      recipients: [{
        user_id: organizer.id,
        display_name: organizer.display_name,
        role: 'organizer',
        duty: 'Quest planning, coordination, and reporting',
        share_bps: 10000,
      }],
      organizer_bond_mjdq: this.organizerBond,
      bond_status: 'not_locked',
      eligible_voter_snapshot: 0,
      quorum_required: 0,
      yes_votes: 0,
      no_votes: 0,
      votes: 0,
      vote_fee_mjdq: this.proposalVoteFee,
      escrow_mjdq: 0,
      feedback_eligible_snapshot: 0,
      feedback_quorum_required: 0,
      approve_feedback: 0,
      disapprove_feedback: 0,
      feedback_escrow_mjdq: 0,
      created_at: now(),
      updated_at: now(),
    }));
  }

  // ---- Durability: JSONB snapshot of the whole governance state, written after every mutation. ----
  attachPg(pool: Pool) {
    this.pg = pool;
  }

  snapshot() {
    return {
      proposals: this.proposals,
      votes: this.votes,
      feedbackVotes: this.feedbackVotes,
      balances: Object.fromEntries(this.balances),
      ledger: this.ledger,
      audit: this.audit,
      burnedMjdq: this.burnedMjdq,
      treasuryMjdq: this.treasuryMjdq,
      issuedMjdq: this.issuedMjdq,
      idempotency: [...this.idempotency.entries()],
      controls: this.controls,
    };
  }

  private restore(data: ReturnType<GovernanceStore['snapshot']>) {
    this.proposals = data.proposals;
    this.votes = data.votes;
    this.feedbackVotes = data.feedbackVotes;
    this.balances = new Map(Object.entries(data.balances));
    this.ledger = data.ledger;
    this.audit = data.audit;
    this.burnedMjdq = data.burnedMjdq;
    this.treasuryMjdq = data.treasuryMjdq;
    this.issuedMjdq = data.issuedMjdq;
    this.idempotency = new Map(data.idempotency);
    this.controls = data.controls;
  }

  // Rebuilds user balances from demo_points. Invariant: user balance always equals demo_points * MJDQ_PER_JDQ.
  refreshBalances() {
    this.balances.clear();
    this.issuedMjdq = 0;
    for (const user of this.db.users) {
      const balance = user.demo_points * MJDQ_PER_JDQ;
      this.balances.set(user.id, balance);
      this.issuedMjdq += balance;
    }
  }

  async hydrateFromPg(pool: Pool) {
    this.attachPg(pool);
    try {
      const { rows } = await pool.query<{ data: ReturnType<GovernanceStore['snapshot']> }>(
        'SELECT data FROM governance_snapshot WHERE id = 1'
      );
      if (rows[0]?.data) this.restore(rows[0].data);
    } catch (error) {
      console.warn('[governance] snapshot hydrate failed - starting fresh.', (error as Error).message);
    }
    this.refreshBalances();
  }

  private persist() {
    if (!this.pg) return;
    void this.pg
      .query('INSERT INTO governance_snapshot (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()', [
        JSON.stringify(this.snapshot()),
      ])
      .catch((error) => console.error('[governance] snapshot persist failed:', error.message));
  }

  listProposals() {
    return [...this.proposals].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  getProposal(proposalId: string) {
    return this.proposals.find((proposal) => proposal.id === proposalId);
  }

  createProposal(payload: {
    title: string;
    location_name: string;
    category: GovernanceProposal['category'];
    description: string;
    proposed_lat?: number;
    proposed_lng?: number;
    submitted_by_id: string;
    recipients?: PayoutRecipient[];
  }) {
    const user = this.db.findUserById(payload.submitted_by_id);
    if (!user) throw new Error('USER_NOT_FOUND');
    const recipients = payload.recipients?.length
      ? payload.recipients
      : [{
          user_id: user.id,
          display_name: user.display_name,
          role: 'organizer' as const,
          duty: 'Quest planning, coordination, and reporting',
          share_bps: 10000,
        }];
    for (const recipient of recipients) {
      if (!this.db.findUserById(recipient.user_id)) throw new Error('RECIPIENT_NOT_FOUND');
    }
    const organizers = recipients.filter((recipient) => recipient.role === 'organizer' && recipient.user_id === user.id);
    if (recipients.reduce((sum, recipient) => sum + recipient.share_bps, 0) !== 10000 || organizers.length !== 1) {
      throw new Error('INVALID_PAYOUT_SHARES');
    }
    const timestamp = now();
    const proposal: GovernanceProposal = {
      ...payload,
      id: id('prop'),
      submitted_by: user.display_name,
      state: 'draft',
      recipients,
      organizer_bond_mjdq: this.organizerBond,
      bond_status: 'not_locked',
      eligible_voter_snapshot: 0,
      quorum_required: 0,
      yes_votes: 0,
      no_votes: 0,
      votes: 0,
      vote_fee_mjdq: this.proposalVoteFee,
      escrow_mjdq: 0,
      feedback_eligible_snapshot: 0,
      feedback_quorum_required: 0,
      approve_feedback: 0,
      disapprove_feedback: 0,
      feedback_escrow_mjdq: 0,
      created_at: timestamp,
      updated_at: timestamp,
    };
    this.proposals.push(proposal);
    this.addAudit('proposal.created', user.id, 'proposal', proposal.id);
    this.persist();
    return proposal;
  }

  submitProposal(proposalId: string, userId: string) {
    const proposal = this.requireProposal(proposalId);
    if (proposal.submitted_by_id !== userId || proposal.state !== 'draft') throw new Error('INVALID_TRANSITION');
    proposal.state = 'screening';
    proposal.updated_at = now();
    this.addAudit('proposal.submitted', userId, 'proposal', proposal.id);
    this.persist();
    return proposal;
  }

  screenProposal(
    proposalId: string,
    adminId: string,
    decision: 'approve' | 'reject',
    reason: string,
    evidenceReference: string,
    checklistComplete: boolean,
  ) {
    const proposal = this.requireProposal(proposalId);
    if (proposal.state !== 'screening') throw new Error('INVALID_TRANSITION');
    if (!reason || !evidenceReference) throw new Error('SCREENING_EVIDENCE_REQUIRED');
    if (decision === 'approve' && !checklistComplete) throw new Error('CHECKLIST_INCOMPLETE');

    if (decision === 'reject') {
      proposal.state = 'rejected';
      proposal.screening_reason = reason;
      proposal.evidence_reference = evidenceReference;
    } else {
      this.requireFinancialActive();
      this.debitUser(proposal.submitted_by_id, this.organizerBond);
      this.recordTransfer('bond_lock', proposal.submitted_by_id, 'bond_escrow', this.organizerBond, 'proposal', proposal.id, adminId);
      proposal.bond_status = 'locked';
      proposal.state = 'voting';
      const eligible = this.eligibleGovernanceUsers();
      proposal.eligible_voter_snapshot = eligible.length;
      proposal.eligible_voter_ids = eligible.map((eligibleUser) => eligibleUser.id);
      proposal.quorum_required = Math.max(this.quorumFloor, Math.ceil(proposal.eligible_voter_snapshot * 0.1));
      proposal.voting_opens_at = now();
      proposal.voting_closes_at = addDays(new Date(), this.voteWindowDays);
      proposal.screening_reason = reason;
      proposal.evidence_reference = evidenceReference;
    }
    proposal.updated_at = now();
    this.addAudit(`proposal.screened.${decision}`, adminId, 'proposal', proposal.id, reason, evidenceReference, { checklist_complete: checklistComplete });
    this.persist();
    return proposal;
  }

  castProposalVote(proposalId: string, userId: string, choice: 'yes' | 'no', idempotencyKey: string) {
    const fingerprint = `${proposalId}:${userId}:${choice}`;
    const cached = this.getIdempotent(idempotencyKey, fingerprint);
    if (cached) return cached;
    this.requireVotesActive();
    const proposal = this.requireProposal(proposalId);
    if (proposal.state !== 'voting' || !proposal.voting_closes_at || new Date(proposal.voting_closes_at) <= new Date()) {
      throw new Error('VOTING_CLOSED');
    }
    if (!proposal.eligible_voter_ids?.includes(userId)) throw new Error('NOT_ELIGIBLE');
    if (this.votes.some((vote) => vote.proposal_id === proposalId && vote.user_id === userId)) throw new Error('ALREADY_VOTED');

    const burn = Math.floor(this.proposalVoteFee * this.burnBps / 10000);
    const escrow = this.proposalVoteFee - burn;
    this.debitUser(userId, this.proposalVoteFee);
    this.burnedMjdq += burn;
    proposal.escrow_mjdq += escrow;
    this.recordTransfer('proposal_vote_debit', userId, 'governance_fee', this.proposalVoteFee, 'proposal', proposal.id, userId, idempotencyKey);
    this.recordTransfer('token_burn', 'governance_fee', 'burn', burn, 'proposal', proposal.id, userId, idempotencyKey);
    this.recordTransfer('proposal_escrow_credit', 'governance_fee', `escrow:${proposal.id}`, escrow, 'proposal', proposal.id, userId, idempotencyKey);
    this.votes.push({ proposal_id: proposal.id, user_id: userId, choice, idempotency_key: idempotencyKey });
    if (choice === 'yes') proposal.yes_votes += 1;
    else proposal.no_votes += 1;
    proposal.votes += 1;
    proposal.updated_at = now();
    this.addAudit('proposal.vote_cast', userId, 'proposal', proposal.id, undefined, undefined, { choice: 'private', fee_mjdq: this.proposalVoteFee });

    const response = { proposal, charged_mjdq: this.proposalVoteFee, burned_mjdq: burn, escrowed_mjdq: escrow, balance_mjdq: this.balanceOf(userId) };
    this.idempotency.set(idempotencyKey, { fingerprint, response });
    this.persist();
    return response;
  }

  castFeedback(
    proposalId: string,
    userId: string,
    choice: 'approve' | 'disapprove',
    idempotencyKey: string,
    rating?: number,
    comment?: string,
  ) {
    const fingerprint = `${proposalId}:${userId}:${choice}:${rating || ''}:${comment || ''}`;
    const cached = this.getIdempotent(idempotencyKey, fingerprint);
    if (cached) return cached;
    this.requireVotesActive();
    const proposal = this.requireProposal(proposalId);
    if (proposal.state !== 'feedback' || !proposal.feedback_closes_at || new Date(proposal.feedback_closes_at) <= new Date()) {
      throw new Error('FEEDBACK_CLOSED');
    }
    const eligible = this.db.submissions.some(
      (submission) => submission.quest_id === proposal.id && submission.user_id === userId && submission.status === 'approved',
    );
    if (!eligible) throw new Error('NOT_ELIGIBLE');
    if (this.feedbackVotes.some((vote) => vote.proposal_id === proposal.id && vote.user_id === userId)) throw new Error('ALREADY_VOTED');

    const burn = Math.floor(this.feedbackVoteFee * this.burnBps / 10000);
    const escrow = this.feedbackVoteFee - burn;
    this.debitUser(userId, this.feedbackVoteFee);
    this.burnedMjdq += burn;
    proposal.feedback_escrow_mjdq += escrow;
    this.recordTransfer('feedback_vote_debit', userId, 'governance_fee', this.feedbackVoteFee, 'proposal', proposal.id, userId, idempotencyKey);
    this.recordTransfer('token_burn', 'governance_fee', 'burn', burn, 'proposal', proposal.id, userId, idempotencyKey);
    this.recordTransfer('feedback_escrow_credit', 'governance_fee', `escrow:${proposal.id}`, escrow, 'proposal', proposal.id, userId, idempotencyKey);
    this.feedbackVotes.push({ proposal_id: proposal.id, user_id: userId, choice, rating, comment, idempotency_key: idempotencyKey });
    if (choice === 'approve') proposal.approve_feedback += 1;
    else proposal.disapprove_feedback += 1;
    proposal.updated_at = now();
    this.addAudit('proposal.feedback_cast', userId, 'proposal', proposal.id, undefined, undefined, { choice: 'private', rating, fee_mjdq: this.feedbackVoteFee });
    const response = { proposal, charged_mjdq: this.feedbackVoteFee, burned_mjdq: burn, escrowed_mjdq: escrow, balance_mjdq: this.balanceOf(userId) };
    this.idempotency.set(idempotencyKey, { fingerprint, response });
    this.persist();
    return response;
  }

  closeVoting(proposalId: string, adminId: string, force = false) {
    const proposal = this.requireProposal(proposalId);
    if (proposal.state !== 'voting') throw new Error('INVALID_TRANSITION');
    if (!force && proposal.voting_closes_at && new Date(proposal.voting_closes_at) > new Date()) throw new Error('WINDOW_OPEN');
    const passedQuorum = proposal.votes >= proposal.quorum_required;
    const passed = passedQuorum && proposal.yes_votes > proposal.no_votes;
    if (passed) {
      proposal.state = 'approved';
    } else {
      proposal.state = passedQuorum ? 'rejected' : 'expired';
      this.treasuryMjdq += proposal.escrow_mjdq;
      this.recordTransfer('treasury_credit', `escrow:${proposal.id}`, 'community_treasury', proposal.escrow_mjdq, 'proposal', proposal.id, adminId);
      proposal.escrow_mjdq = 0;
      this.refundBond(proposal, adminId);
    }
    proposal.updated_at = now();
    this.addAudit('proposal.voting_closed', adminId, 'proposal', proposal.id, undefined, undefined, { passed, force, quorum_met: passedQuorum });
    this.persist();
    return proposal;
  }

  closeFeedback(proposalId: string, adminId: string, force = false) {
    const proposal = this.requireProposal(proposalId);
    if (proposal.state !== 'feedback') throw new Error('INVALID_TRANSITION');
    if (!force && proposal.feedback_closes_at && new Date(proposal.feedback_closes_at) > new Date()) throw new Error('WINDOW_OPEN');
    const total = proposal.approve_feedback + proposal.disapprove_feedback;
    const quorumMet = total >= proposal.feedback_quorum_required;
    const passed = quorumMet && proposal.approve_feedback > proposal.disapprove_feedback;
    proposal.state = passed ? 'payout_pending' : 'disputed';
    proposal.updated_at = now();
    this.addAudit('proposal.feedback_closed', adminId, 'proposal', proposal.id, undefined, undefined, { passed, force, quorum_met: quorumMet });
    this.persist();
    return proposal;
  }

  finalizePayout(proposalId: string, adminId: string) {
    this.requireFinancialActive();
    if (this.controls.pause_payouts) throw new Error('PAYOUTS_PAUSED');
    const proposal = this.requireProposal(proposalId);
    if (proposal.state !== 'payout_pending') throw new Error('INVALID_TRANSITION');
    const pool = proposal.escrow_mjdq + proposal.feedback_escrow_mjdq;
    this.distributeToRecipients(proposal, pool, adminId);
    proposal.escrow_mjdq = 0;
    proposal.feedback_escrow_mjdq = 0;
    this.refundBond(proposal, adminId);
    proposal.state = 'completed';
    proposal.updated_at = now();
    this.addAudit('proposal.payout_finalized', adminId, 'proposal', proposal.id, 'Community feedback passed; full locked payout released.');
    this.persist();
    return proposal;
  }

  transitionProposal(proposalId: string, adminId: string, target: GovernanceState) {
    const proposal = this.requireProposal(proposalId);
    const allowed: Partial<Record<GovernanceState, GovernanceState[]>> = {
      approved: ['scheduled'],
      scheduled: ['active', 'cancelled'],
      active: ['feedback', 'cancelled'],
      feedback: ['payout_pending', 'disputed'],
      payout_pending: ['completed', 'disputed'],
    };
    if (!allowed[proposal.state]?.includes(target)) throw new Error('INVALID_TRANSITION');
    const timestamp = new Date();
    if (target === 'scheduled') {
      proposal.quest_starts_at = timestamp.toISOString();
      proposal.quest_ends_at = addDays(timestamp, this.defaultQuestDays);
      if (!this.db.quests.some((quest) => quest.id === proposal.id)) {
        this.db.upsertQuest({
          id: proposal.id,
          title: proposal.title,
          description: proposal.description,
          category: proposal.category,
          location_name: proposal.location_name,
          gps_lat: proposal.proposed_lat || 0,
          gps_lng: proposal.proposed_lng || 0,
          radius_meters: 150,
          reward_points: 50,
          marker_code: `COMMUNITY_${proposal.id.toUpperCase()}`,
          marker_image_url: '',
          is_active: false,
          created_at: now(),
          updated_at: now(),
        });
      }
    }
    if (target === 'active') {
      const quest = this.db.quests.find((item) => item.id === proposal.id);
      if (quest) {
        quest.is_active = true;
        quest.updated_at = now();
        this.db.upsertQuest(quest);
      }
    }
    if (target === 'feedback') {
      const quest = this.db.quests.find((item) => item.id === proposal.id);
      if (quest) {
        quest.is_active = false;
        quest.updated_at = now();
        this.db.upsertQuest(quest);
      }
      proposal.feedback_opens_at = timestamp.toISOString();
      proposal.feedback_closes_at = addDays(timestamp, this.feedbackWindowDays);
      const participants = this.db.submissions.filter((submission) => submission.quest_id === proposal.id && submission.status === 'approved');
      proposal.feedback_eligible_snapshot = new Set(participants.map((submission) => submission.user_id)).size;
      proposal.feedback_quorum_required = Math.max(this.quorumFloor, Math.ceil(proposal.feedback_eligible_snapshot * 0.1));
    }
    proposal.state = target;
    proposal.updated_at = now();
    this.addAudit(`proposal.transition.${target}`, adminId, 'proposal', proposal.id);
    this.persist();
    return proposal;
  }

  resolveDispute(
    proposalId: string,
    adminId: string,
    releasePercent: number,
    bondAction: 'refund' | 'slash_50' | 'slash_100',
    reason: string,
    evidenceReference: string,
  ) {
    this.requireFinancialActive();
    if (this.controls.pause_payouts) throw new Error('PAYOUTS_PAUSED');
    const proposal = this.requireProposal(proposalId);
    if (!['disputed', 'payout_pending'].includes(proposal.state)) throw new Error('INVALID_TRANSITION');
    if (!reason || !evidenceReference) throw new Error('RESOLUTION_EVIDENCE_REQUIRED');
    const pool = proposal.escrow_mjdq + proposal.feedback_escrow_mjdq;
    const released = Math.floor(pool * releasePercent / 100);
    const treasury = pool - released;
    this.distributeToRecipients(proposal, released, adminId);
    if (treasury > 0) {
      this.treasuryMjdq += treasury;
      this.recordTransfer('treasury_credit', `escrow:${proposal.id}`, 'community_treasury', treasury, 'proposal', proposal.id, adminId);
    }
    proposal.escrow_mjdq = 0;
    proposal.feedback_escrow_mjdq = 0;
    this.resolveBond(proposal, adminId, bondAction);
    proposal.state = 'completed';
    proposal.updated_at = now();
    this.addAudit('proposal.dispute_resolved', adminId, 'proposal', proposal.id, reason, evidenceReference, { release_percent: releasePercent, bond_action: bondAction });
    this.persist();
    return proposal;
  }

  getOverview() {
    const states = this.proposals.reduce<Record<string, number>>((acc, proposal) => {
      acc[proposal.state] = (acc[proposal.state] || 0) + 1;
      return acc;
    }, {});
    return {
      states,
      screening_backlog: states.screening || 0,
      active_votes: states.voting || 0,
      active_quests: states.active || 0,
      feedback_rounds: states.feedback || 0,
      disputed: states.disputed || 0,
      payout_pending: states.payout_pending || 0,
      configuration: this.getConfig(),
      controls: this.controls,
      alerts: this.getAlerts(),
    };
  }

  getTokenomics() {
    const circulating = [...this.balances.values()].reduce((sum, value) => sum + value, 0);
    const lockedBonds = this.proposals.filter((proposal) => proposal.bond_status === 'locked').reduce((sum, proposal) => sum + proposal.organizer_bond_mjdq, 0);
    const escrow = this.proposals.reduce((sum, proposal) => sum + proposal.escrow_mjdq + proposal.feedback_escrow_mjdq, 0);
    const accounted = circulating + lockedBonds + escrow + this.treasuryMjdq + this.burnedMjdq;
    return {
      unit: 'mJDQ',
      total_issued_mjdq: this.issuedMjdq,
      circulating_mjdq: circulating,
      burned_mjdq: this.burnedMjdq,
      locked_bonds_mjdq: lockedBonds,
      escrow_mjdq: escrow,
      treasury_mjdq: this.treasuryMjdq,
      merchant_held_mjdq: 0,
      rewards_distributed_mjdq: this.ledger.filter((entry) => entry.type === 'quest_reward_credit' && entry.amount_mjdq > 0).reduce((sum, entry) => sum + entry.amount_mjdq, 0),
      payouts_distributed_mjdq: this.ledger.filter((entry) => entry.type === 'recipient_credit' && entry.amount_mjdq > 0).reduce((sum, entry) => sum + entry.amount_mjdq, 0),
      reconciliation_difference_mjdq: this.issuedMjdq - accounted,
      governance_fee_volume_mjdq: this.votes.length * this.proposalVoteFee + this.feedbackVotes.length * this.feedbackVoteFee,
      burn_rate_percent: 20,
      top_balances: this.db.users.map((user) => ({ user_id: user.id, display_name: user.display_name, balance_mjdq: this.balanceOf(user.id) })).sort((a, b) => b.balance_mjdq - a.balance_mjdq),
    };
  }

  getLedger() {
    return [...this.ledger].reverse();
  }

  getAudit() {
    return [...this.audit].reverse();
  }

  getControls() {
    return { ...this.controls };
  }

  updateControls(adminId: string, updates: Partial<Pick<GovernanceControls, 'pause_votes' | 'pause_payouts' | 'pause_vouchers' | 'pause_all_financial'>>, reason: string) {
    if (!reason) throw new Error('REASON_REQUIRED');
    this.controls = { ...this.controls, ...updates, updated_by: adminId, updated_at: now() };
    this.addAudit('governance.controls_updated', adminId, 'system', 'governance', reason, undefined, updates);
    this.persist();
    return this.controls;
  }

  getConfig() {
    return {
      proposal_vote_fee_mjdq: this.proposalVoteFee,
      feedback_vote_fee_mjdq: this.feedbackVoteFee,
      burn_bps: this.burnBps,
      organizer_bond_mjdq: this.organizerBond,
      vote_window_days: this.voteWindowDays,
      default_quest_days: this.defaultQuestDays,
      feedback_window_days: this.feedbackWindowDays,
      quorum_percent: 10,
      quorum_floor: this.quorumFloor,
      vote_power: 'one_eligible_user_one_vote',
      settlement: 'off_chain_prototype',
    };
  }

  balanceOf(userId: string) {
    return this.balances.get(userId) || 0;
  }

  getWallet(userId: string) {
    return {
      settlement: 'off_chain_prototype',
      unit: 'mJDQ',
      balance_mjdq: this.balanceOf(userId),
      balance_jdq: this.balanceOf(userId) / MJDQ_PER_JDQ,
      ledger: this.getLedger().filter((entry) => entry.account === userId),
    };
  }

  creditQuestReward(userId: string, questId: string, submissionId: string, rewardPoints: number, actorId: string) {
    const amount = rewardPoints * MJDQ_PER_JDQ;
    if (amount <= 0 || this.ledger.some((entry) => entry.type === 'quest_reward_credit' && entry.reference_id === submissionId && entry.amount_mjdq > 0)) return;
    this.balances.set(userId, this.balanceOf(userId) + amount);
    this.issuedMjdq += amount;
    this.recordTransfer('quest_reward_credit', 'reward_issuance', userId, amount, 'submission', submissionId, actorId);
    this.addAudit('quest.reward_issued', actorId, 'quest', questId, undefined, undefined, { submission_id: submissionId, amount_mjdq: amount });
    this.persist();
  }

  // Consumes demo points for an off-chain voucher redemption and records the ledger debit.
  consumePoints(userId: string, points: number, voucherId: string, redemptionId: string) {
    const amount = points * MJDQ_PER_JDQ;
    if (this.balanceOf(userId) < amount) throw new Error('INSUFFICIENT_JDQ');
    this.balances.set(userId, this.balanceOf(userId) - amount);
    const user = this.db.findUserById(userId);
    if (user) user.demo_points = Math.floor(this.balanceOf(userId) / MJDQ_PER_JDQ);
    this.recordTransfer('voucher_redemption_debit', userId, 'merchant_settlement', amount, 'voucher', voucherId, userId);
    this.addAudit('voucher.redeemed', userId, 'voucher', voucherId, undefined, undefined, { redemption_id: redemptionId, points });
    this.persist();
  }

  private eligibleGovernanceUsers() {
    return this.db.users.filter(
      (user) => user.role === 'user'
        && this.db.submissions.some((submission) => submission.user_id === user.id && submission.status === 'approved'),
    );
  }

  private requireProposal(proposalId: string) {
    const proposal = this.getProposal(proposalId);
    if (!proposal) throw new Error('PROPOSAL_NOT_FOUND');
    return proposal;
  }

  private requireVotesActive() {
    this.requireFinancialActive();
    if (this.controls.pause_votes) throw new Error('VOTES_PAUSED');
  }

  private requireFinancialActive() {
    if (this.controls.pause_all_financial) throw new Error('FINANCIAL_ACTIVITY_PAUSED');
  }

  private debitUser(userId: string, amount: number) {
    const balance = this.balanceOf(userId);
    if (balance < amount) throw new Error('INSUFFICIENT_JDQ');
    this.balances.set(userId, balance - amount);
    const user = this.db.findUserById(userId);
    if (user) user.demo_points = Math.floor((balance - amount) / MJDQ_PER_JDQ);
  }

  private creditUser(userId: string, amount: number) {
    const balance = this.balanceOf(userId) + amount;
    this.balances.set(userId, balance);
    const user = this.db.findUserById(userId);
    if (user) user.demo_points = Math.floor(balance / MJDQ_PER_JDQ);
  }

  private refundBond(proposal: GovernanceProposal, actorId: string) {
    if (proposal.bond_status !== 'locked') return;
    this.creditUser(proposal.submitted_by_id, proposal.organizer_bond_mjdq);
    proposal.bond_status = 'refunded';
    this.recordTransfer('bond_refund', 'bond_escrow', proposal.submitted_by_id, proposal.organizer_bond_mjdq, 'proposal', proposal.id, actorId);
  }

  private resolveBond(proposal: GovernanceProposal, actorId: string, action: 'refund' | 'slash_50' | 'slash_100') {
    if (proposal.bond_status !== 'locked') return;
    const slash = action === 'refund' ? 0 : action === 'slash_50' ? Math.floor(proposal.organizer_bond_mjdq / 2) : proposal.organizer_bond_mjdq;
    const refund = proposal.organizer_bond_mjdq - slash;
    if (refund > 0) {
      this.creditUser(proposal.submitted_by_id, refund);
      this.recordTransfer('bond_refund', 'bond_escrow', proposal.submitted_by_id, refund, 'proposal', proposal.id, actorId);
    }
    if (slash > 0) {
      this.treasuryMjdq += slash;
      this.recordTransfer('bond_slash', 'bond_escrow', 'community_treasury', slash, 'proposal', proposal.id, actorId);
    }
    proposal.bond_status = action === 'refund' ? 'refunded' : action === 'slash_50' ? 'slashed_50' : 'slashed_100';
  }

  private distributeToRecipients(proposal: GovernanceProposal, amount: number, actorId: string) {
    if (amount <= 0) return;
    const organizer = proposal.recipients.find((recipient) => recipient.role === 'organizer' && recipient.user_id === proposal.submitted_by_id);
    if (!organizer) throw new Error('INVALID_PAYOUT_SHARES');
    let distributed = 0;
    proposal.recipients.filter((recipient) => recipient !== organizer).forEach((recipient) => {
      const share = Math.floor(amount * recipient.share_bps / 10000);
      this.creditUser(recipient.user_id, share);
      distributed += share;
      this.recordTransfer('recipient_credit', `escrow:${proposal.id}`, recipient.user_id, share, 'proposal', proposal.id, actorId);
    });
    const organizerShare = amount - distributed;
    this.creditUser(organizer.user_id, organizerShare);
    this.recordTransfer('recipient_credit', `escrow:${proposal.id}`, organizer.user_id, organizerShare, 'proposal', proposal.id, actorId);
  }

  private recordTransfer(
    type: string,
    from: string,
    to: string,
    amount: number,
    referenceType: string,
    referenceId: string,
    actorId: string,
    idempotencyKey?: string,
  ) {
    const groupId = id('txg');
    const timestamp = now();
    this.ledger.push(
      { id: id('led'), transaction_group_id: groupId, type, account: from, amount_mjdq: -amount, reference_type: referenceType, reference_id: referenceId, actor_id: actorId, idempotency_key: idempotencyKey, metadata: { counterparty: to }, created_at: timestamp },
      { id: id('led'), transaction_group_id: groupId, type, account: to, amount_mjdq: amount, reference_type: referenceType, reference_id: referenceId, actor_id: actorId, idempotency_key: idempotencyKey, metadata: { counterparty: from }, created_at: timestamp },
    );
  }

  private addAudit(
    action: string,
    actorId: string,
    subjectType: string,
    subjectId: string,
    reason?: string,
    evidenceReference?: string,
    metadata?: Record<string, unknown>,
  ) {
    this.audit.push({ id: id('audit'), action, actor_id: actorId, subject_type: subjectType, subject_id: subjectId, reason, evidence_reference: evidenceReference, metadata, created_at: now() });
  }

  private getIdempotent(key: string, fingerprint: string) {
    const existing = this.idempotency.get(key);
    if (!existing) return undefined;
    if (existing.fingerprint !== fingerprint) throw new Error('IDEMPOTENCY_CONFLICT');
    return existing.response;
  }

  private getAlerts() {
    const tokenomics = this.getTokenomics();
    const alerts: Array<{ severity: 'critical' | 'warning' | 'info'; code: string; message: string }> = [];
    if (tokenomics.reconciliation_difference_mjdq !== 0) alerts.push({ severity: 'critical', code: 'LEDGER_MISMATCH', message: 'JDQ ledger does not reconcile.' });
    if (this.controls.pause_all_financial) alerts.push({ severity: 'warning', code: 'FINANCIAL_PAUSE', message: 'All financial activity is paused.' });
    if (!alerts.length) alerts.push({ severity: 'info', code: 'CONTROLS_HEALTHY', message: 'No active governance control alerts.' });
    return alerts;
  }
}
