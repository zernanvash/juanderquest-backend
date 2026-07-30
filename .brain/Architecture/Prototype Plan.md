# Prototype Architecture & Scaffold Notes

**Active Specification:** [01-prototype-scaffold-plan.md](file:///C:/Users/HP/Desktop/Code/JuanderQuest/implementation_plans/01-prototype-scaffold-plan.md)  
**Detailed Scope:** [prototype-scope.md](file:///C:/Users/HP/Desktop/Code/JuanderQuest/docs/01-requirements/prototype-scope.md)  

## Showcase Boundary
- **Included:** Seeded login, Pangasinan quest list/detail, AR marker tracking + static 3D coin overlay, real-time GPS capture, proof submission with idempotency key, React web admin review (Approve/Reject), off-chain demo points.
- **Excluded (Deferred):** Base L2 contracts, JDQ ERC-20, Soulbound NFTs, WalletConnect/SIWE, DAO voting, merchant redemptions, offline queueing.

## State Transitions
`PENDING` → `APPROVED` (Awards demo points) or `REJECTED` (with reason).

## Prototype Documentation References
- API Spec: `docs/04-api/prototype-api.md`
- Database DDL & Seeds: `docs/05-database/prototype-schema.md`
- UI/UX Map & AR Specs: `docs/03-ui-ux/prototype-ui-ux.md`
- Security Specs: `docs/08-security/prototype-security.md`
- Acceptance Test Plan: `docs/07-testing/prototype-acceptance.md`
