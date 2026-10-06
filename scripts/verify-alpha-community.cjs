// Read-only public/QA isolation smoke test for the dedicated home-alpha runtime.
// Uses the operator's private local QA wallet; never logs its key or JWT.
const fs = require('node:fs');
const path = require('node:path');
const { Wallet } = require('ethers');

const baseUrl = process.env.JDQ_ALPHA_API_BASE_URL || 'http://127.0.0.1:4000/api/v1';
const keyPath = path.join(process.env.HOME, '.config', 'juanderquest-alpha', 'qa-wallet.key');
const privateKey = fs.readFileSync(keyPath, 'utf8').trim();
if (!/^[a-f0-9]{64}$/i.test(privateKey)) throw new Error('Invalid local QA wallet key');
const wallet = new Wallet(`0x${privateKey}`);

async function request(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, options);
  const body = await response.json();
  return { response, body };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function items(result) {
  return Array.isArray(result.body.data) ? result.body.data : result.body.data?.items || [];
}

async function main() {
  const publicSpots = await request('/spots');
  const publicFeed = await request('/feed?limit=50');
  const publicUsers = await request('/users?limit=6');
  const publicCampaigns = await request('/juanchoice/campaigns');
  const publicSearch = await request('/search?q=sim_aira_coast&type=people&mode=preview');
  assert(publicSpots.response.ok && items(publicSpots).length === 14, 'Public editorial catalog must contain 14 real destination listings');
  assert(publicFeed.response.ok && items(publicFeed).length === 14, 'Synthetic posts leaked into the public feed');
  assert(publicUsers.response.ok && items(publicUsers).length === 0, 'Synthetic travelers leaked to public users');
  assert(publicCampaigns.response.ok && items(publicCampaigns).length === 0, 'Synthetic campaign leaked to public');
  assert(publicSearch.response.ok && (publicSearch.body.data?.groups || []).every((group) => group.items.length === 0), 'Synthetic traveler leaked into public search');

  const challenge = await request('/auth/wallet/challenge', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: wallet.address }),
  });
  assert(challenge.response.ok, 'QA wallet challenge failed');
  const signature = await wallet.signMessage(challenge.body.data.message);
  const login = await request('/auth/wallet/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: wallet.address, signature }),
  });
  assert(login.response.ok && login.body.data?.token, 'QA wallet login failed');
  const setCookie = login.response.headers.get('set-cookie') || '';
  assert(setCookie.startsWith('__Host-jdq_session=') && setCookie.includes('HttpOnly') && setCookie.includes('Secure') && setCookie.includes('SameSite=Lax'), 'Secure session cookie was not issued');
  const cookie = setCookie.split(';', 1)[0];
  const restored = await request('/auth/me', { headers: { Cookie: cookie } });
  assert(restored.response.ok && restored.body.data?.seed_id?.startsWith('wallet:'), 'Cookie session restore failed');
  const walletFeed = await request('/feed?limit=50', { headers: { Cookie: cookie } });
  assert(walletFeed.response.ok && items(walletFeed).length === 23, 'Wallet feed must contain the 14 editorial and nine labeled simulation posts without evaluator controls');
  assert((walletFeed.response.headers.get('x-robots-tag') || '').includes('noindex'), 'Wallet simulation feed must be noindex');
  const walletTravelers = await request('/users?limit=6', { headers: { Cookie: cookie } });
  assert(walletTravelers.response.ok && items(walletTravelers).length === 6 && items(walletTravelers).every((user) => user.is_test === true), 'Wallet traveler rail must show labeled fictional profiles');
  const walletSearch = await request('/search?q=sim_aira_coast&type=people&mode=preview', { headers: { Cookie: cookie } });
  assert(walletSearch.response.ok && (walletSearch.body.data?.groups || []).some((group) => group.type === 'people' && group.items.some((person) => person.id === 'qa-sim-20260927-u01')), 'Wallet search must find a seeded traveler');
  const walletProfile = await request('/users/qa-sim-20260927-u01/profile', { headers: { Cookie: cookie } });
  assert(walletProfile.response.ok && walletProfile.body.data?.is_test === true, 'Wallet profile must expose a labeled fictional traveler');
  const walletCampaigns = await request('/juanchoice/campaigns', { headers: { Cookie: cookie } });
  assert(walletCampaigns.response.ok && items(walletCampaigns).length === 1, 'Wallet campaign list must include the seeded simulation round');
  const blockedSyntheticSave = await request('/spots/qa-sim-20260927-p01/save', { method: 'PUT', headers: { Cookie: cookie, Origin: 'https://juanderquest.app' } });
  assert(blockedSyntheticSave.response.status === 403 && blockedSyntheticSave.body.error?.code === 'SCOPE_MISMATCH', 'Real wallets must not write to fictional posts');
  const logout = await request('/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://juanderquest.app' } });
  assert(logout.response.ok && (logout.response.headers.get('set-cookie') || '').startsWith('__Host-jdq_session=;'), 'Cookie logout failed');
  const headers = { Authorization: `Bearer ${login.body.data.token}`, 'x-include-test': 'true' };
  const capability = await request('/qa/capabilities', { headers });
  assert(capability.response.ok && capability.body.data?.can_preview_test_data, 'QA privilege was not accepted');

  const qaSpots = await request('/spots?include_test=true', { headers });
  const qaFeed = await request('/feed?include_test=true&limit=50', { headers });
  const qaUsers = await request('/users?limit=6&include_test=true', { headers });
  const qaCampaigns = await request('/juanchoice/campaigns?include_test=true', { headers });
  const qaSearch = await request('/search?q=sim_aira_coast&type=people&mode=preview&include_test=true', { headers });
  assert(qaSpots.response.ok && items(qaSpots).length === 23, 'QA spots count mismatch');
  assert(qaFeed.response.ok && items(qaFeed).length === 23, 'QA feed count mismatch');
  assert(qaUsers.response.ok && items(qaUsers).length === 6, 'QA users count mismatch');
  assert(qaCampaigns.response.ok && items(qaCampaigns).length === 1, 'QA campaign count mismatch');
  assert(qaSearch.response.ok && (qaSearch.body.data?.groups || []).some((group) => group.type === 'people' && group.items.some((person) => person.id === 'qa-sim-20260927-u01')), 'Synthetic traveler missing from QA search');
  assert((qaSpots.response.headers.get('x-robots-tag') || '').includes('noindex'), 'QA response must be noindex');

  const hiddenSpot = await request('/spots/qa-sim-patar-weekend-plan');
  assert(hiddenSpot.response.status === 404, 'Synthetic spot leaked by direct public URL');
  const visibleSpot = await request('/spots/qa-sim-patar-weekend-plan?include_test=true', { headers });
  assert(visibleSpot.response.ok, 'Synthetic spot missing in QA preview');

  const hiddenProfile = await request('/users/qa-sim-20260927-u01/profile');
  assert(hiddenProfile.response.status === 404, 'Synthetic traveler profile leaked publicly');
  const visibleProfile = await request('/users/qa-sim-20260927-u01/profile?include_test=true', { headers });
  assert(visibleProfile.response.ok && visibleProfile.body.data?.follower_count === 4, 'QA profile follower count mismatch');
  const followers = await request('/users/qa-sim-20260927-u01/followers?include_test=true', { headers });
  assert(followers.response.ok && items(followers).length === 4, 'QA follower list mismatch');

  const campaignId = 'ef000001-0000-4000-8000-000000000001';
  const hiddenRound = await request(`/juanchoice/campaigns/${campaignId}`);
  assert(hiddenRound.response.status === 404, 'Synthetic voting round leaked publicly');
  const round = await request(`/juanchoice/campaigns/${campaignId}?include_test=true`, { headers });
  const voteCounts = round.body.data?.standings?.map((row) => Number(row.votes)).sort((a, b) => b - a);
  assert(round.response.ok && JSON.stringify(voteCounts) === '[3,2,1]', 'QA voting standings mismatch');

  process.stdout.write('Alpha catalog verified: anonymous public 14 editorial destinations; ordinary wallet 23 posts (14 editorial + 9 fictional), 6 labeled fictional users, and 1 seeded round; QA isolation intact.\n');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
