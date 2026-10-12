#!/usr/bin/env node
// Replays one funded start before/after local API or PostgreSQL restart.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
const [database, marker] = process.argv.slice(2);
if (!/^jdq_economy_lab_[a-f0-9]{12}_dev$/.test(database || '') || !/^[a-f0-9-]{36}$/i.test(marker || '')) throw new Error('Exact fixture identity required');
const check = spawnSync('node', ['scripts/economy-browser-fixture.mjs', '--check', database, marker], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
if (check.status !== 0) throw new Error('Fixture preflight failed');
const profile = dotenv.parse(readFileSync(new URL('../.env.dev', import.meta.url)));
const token = jwt.sign({ id: 'lab-economy-traveler', seed_id: 'wallet:lab-traveler', role: 'user' }, process.env.JWT_SECRET || profile.JWT_SECRET || 'dev_only_jwt_secret_do_not_use_in_production', { expiresIn: '5m' });
const base = 'http://127.0.0.1:4300/api/v1';
async function call(path, method = 'GET') {
  const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error(`Restart probe failed: ${response.status} ${body.error?.code}`);
  return body.data;
}
await call('/quests/lab-economy-reviewed-quest/attempts', 'POST');
const reservations = await call('/economy/me/reservations');
const wallet = await call('/economy/me');
if (reservations.items.length !== 1 || reservations.items[0].status !== 'reserved' || wallet.balance_minor !== '0') throw new Error('Restart/retry changed reservation or issued coins');
console.log(JSON.stringify({ result: 'PASS', reservations: 1, status: 'reserved', balance_minor: '0', asset: wallet.asset }));
