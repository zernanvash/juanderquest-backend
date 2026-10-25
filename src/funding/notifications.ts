import type { PoolClient } from 'pg';
import { runIsolatedProducer } from '../social/activity.js';
import { enqueuePush } from '../push/enqueue.js';

export type FundingNotificationKind = 'quest_funding' | 'sponsorship' | 'quest_reward';

export interface FundingNotificationInput {
  userId: string;
  isTest: boolean;
  eventKey: string;
  kind: FundingNotificationKind;
  title: string;
  message: string;
  href: string;
}

const safeHref = (href: string) => /^\/(?!\/)[^\u0000-\u001f\\]*$/.test(href) && href.length <= 500;

/** Insert inside the business transaction so users never receive an alert for a rolled-back action. */
export async function insertFundingNotification(client: Pick<PoolClient, 'query'>, input: FundingNotificationInput) {
  if (!input.userId || input.eventKey.length < 1 || input.eventKey.length > 240 ||
      input.title.length < 1 || input.title.length > 120 || input.message.length < 1 || input.message.length > 500 ||
      !safeHref(input.href)) return;
  const inserted = await client.query(
    `INSERT INTO user_notifications(id,user_id,event_key,kind,title,message,href,is_test)
     SELECT gen_random_uuid()::text,$1,$2,$3,$4,$5,$6,$7
       WHERE EXISTS (SELECT 1 FROM users u WHERE u.id=$1 AND u.is_test=$7)
     ON CONFLICT(user_id,event_key) DO NOTHING
     RETURNING id`,
    [input.userId,input.eventKey,input.kind,input.title,input.message,input.href,input.isTest]);
  const notificationId = inserted.rows?.[0]?.id as string | undefined;
  if (!notificationId) return; // duplicate event: no second push either
  // Same transaction (sent only if the business action commits), but isolated
  // in a savepoint so a push-queue problem can never roll back the action.
  await runIsolatedProducer(client as any, '[funding:push] Failed to enqueue push:', async () => {
    await enqueuePush(client as any, {
      userId: input.userId,
      category: 'account',
      collapseKey: `account:${input.eventKey}`,
      notificationId,
      title: input.title,
      body: input.message,
      href: input.href,
      isTest: input.isTest,
    });
  });
}

export async function notifyMerchantOwners(client: Pick<PoolClient, 'query'>, merchantId: string, isTest: boolean,
  eventKey: string, kind: FundingNotificationKind, title: string, message: string, href: string) {
  const owners = await client.query(
    `SELECT DISTINCT u.id FROM merchant_memberships mm JOIN users u ON u.id=mm.user_id
      WHERE mm.merchant_id=$1 AND mm.role='owner' AND mm.status='active' AND u.is_test=$2 ORDER BY u.id`,
    [merchantId,isTest]);
  for (const owner of owners.rows) await insertFundingNotification(client, {
    userId: owner.id, isTest, eventKey, kind, title, message, href,
  });
}

/** Notify the author and all point-contributing merchant owners once per plan event. */
export async function notifyPlanStakeholders(client: Pick<PoolClient, 'query'>, plan: any, eventKey: string,
  title: string, message: string) {
  const recipients = await client.query(
    `SELECT p.created_by AS user_id
       FROM quest_funding_plans p WHERE p.id=$1 AND p.is_test=$2
     UNION
     SELECT c.funder_user_id AS user_id
       FROM quest_funding_contributions c
      WHERE c.plan_id=$1 AND c.is_test=$2 AND c.funder_kind='author' AND c.funder_user_id IS NOT NULL
     UNION
     SELECT mm.user_id
       FROM quest_funding_contributions c JOIN merchant_memberships mm ON mm.merchant_id=c.merchant_id
      WHERE c.plan_id=$1 AND c.is_test=$2 AND c.funder_kind='merchant'
        AND mm.role='owner' AND mm.status='active'
     ORDER BY user_id`, [plan.id,plan.is_test]);
  const href = `/quests/${encodeURIComponent(plan.quest_id)}`;
  for (const recipient of recipients.rows) await insertFundingNotification(client, {
    userId: recipient.user_id, isTest: Boolean(plan.is_test), eventKey, kind: 'quest_funding', title, message, href,
  });
}
