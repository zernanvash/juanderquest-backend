# JuanderQuest — AGENTS.md

## What this is

Flutter mobile app for "JuanDerQuest: A Gamified Blockchain-based System for Promoting Tourist Destinations in Pangasinan." Starting fresh (no legacy code), but recycled from an existing prototype. Paper (Chapter 1) is ongoing. Linear development: finish documentation before writing code.

## Authors

- Ana Victoria V. Alentajan, Zernan Vash L. Arive, Clarissa Angel A. Gutlay, Carl Jacob Lavaro, Alyana Soriano
- School of Information Technology Education, Universidad de Dagupan

## Key facts about the proposed system

- **Gamified mobile app** with GPS-verified eco-quests, cultural quizzes, digital wallet, NFT achievement badges, leaderboards
- **Blockchain layer**: Base Layer 2 network, smart contracts for automated JDQ token rewards, DAO-based community governance
- **Three user roles**: Users (earn rewards), Administrators (manage events/verify), Merchants (provide incentives)
- **No fiat payment processing**; offline-first reads and queued proofs are supported, but blockchain settlement requires connectivity
- **SDLC**: Waterfall-Sashimi methodology

## Directory layout

```
JuanderQuest/
├── AGENTS.md              ← this file
├── docs/                  ← system design documentation (written first)
│   ├── 01-requirements/
│   ├── 02-architecture/
│   ├── 03-ui-ux/
│   ├── 04-api/
│   ├── 05-database/
│   ├── 06-blockchain/
│   ├── 07-testing/
│   └── 08-security/
├── .brain/                ← Obsidian second brain vault (agentic reference)
│   ├── .obsidian/         ← Obsidian vault config
│   ├── Architecture/
│   ├── Flutter/
│   ├── Blockchain/
│   ├── Backend/
│   ├── Database/
│   ├── Testing/
│   ├── Security/
│   └── Workflow/
├── juanderquest_app/      ← Flutter project root (created after docs)
├── backend/               ← cloud backend (created after docs)
└── contracts/             ← Solidity smart contracts (created after docs)
```

## Documentation-first workflow

1. Complete docs in `docs/` before writing any code.
2. As code is implemented, mirror knowledge into `.brain/` for agentic reference. Agents read `.brain/` instead of scanning the codebase.
3. Keep `.brain/` notes up to date when code changes.

## `docs/` vs `.brain/`

| Path | Purpose |
|------|---------|
| `docs/` | System design specs written upfront (waterfall docs) |
| `.brain/` | Second-brain vault for agents — code summaries, architecture decisions, module maps, gotchas. Updated continuously during dev. |

## Repo conventions

- Flutter project goes in `juanderquest_app/`
- Backend in `backend/`
- Smart contracts in `contracts/`
- All documentation is Markdown (Obsidian-compatible)
- `.brain/` is an Obsidian vault — open it directly in Obsidian
