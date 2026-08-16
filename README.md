<div align="center">
  <img src="./icon.svg" width="88" height="88" alt="HIDDEN logo" />

  # HIDDEN

  **Games where your opponent can't see your move.**

  Built on Starknet mainnet with **STRK20** — shielded balances, private transfers, zero visibility into your opponent's move until reveal.

  ![Starknet](https://img.shields.io/badge/Starknet-mainnet-0C0C4E?style=flat-square)
  ![STRK20](https://img.shields.io/badge/STRK20-privacy%20pool-6E56CF?style=flat-square)
  ![License](https://img.shields.io/badge/license-MIT-brightgreen?style=flat-square)
  ![Status](https://img.shields.io/badge/status-in%20development-orange?style=flat-square)
</div>

<br/>

## What it is

HIDDEN is a suite of 1v1 wagered games where privacy isn't cosmetic — it's the core mechanic. Every match ("case") is posted to an open board with a stake in STRK. Anyone can join, or you can send a direct link. Moves are locked as commitment hashes before they're ever revealed, and stakes flow through STRK20's shielded pool — no wallet, no history, no tells.

<br/>

<table>
<tr>
<td width="50%" valign="top">

### 🪨 Rock / Paper / Scissors
Classic simultaneous reveal. Nobody sees a move until both sides are locked.

### 🤝 Prisoner's Dilemma
Trust or betray a stranger you can't identify.

</td>
<td width="50%" valign="top">

### 🃏 Bluff
Hidden-card betting. Bet or fold without ever seeing your opponent's hand.

### 🎯 Assassin vs Target
Pick tiles to attack or hide across. Roles and picks stay sealed until reveal.

</td>
</tr>
</table>

<br/>

## Why privacy matters here

Public blockchains expose every wager, every fold, every hesitation. STRK20 changes that:

- **Stakes are unlinkable** — a deposit entering the pool can't be tied back to the wallet that sent it.
- **Moves are sealed, not just secret** — your locked move is a commitment hash, not the move itself, until both sides commit.
- **Payouts stay shielded** — winnings land in a shielded balance, not a public one.

<br/>

## Status: early build

The frontend — game rules, commit/reveal flow, UI, all four engines — is fully implemented and playable. Chain calls are currently **stubbed**: `connectWallet`, `commitMove`, and `resolvePot` in [`app.js`](./app.js) are placeholders standing in for real STRK20 Privacy SDK calls (see the comment block at the top of the file). No contracts are deployed yet and no mainnet transactions have been made.

**Done:** game logic, commit/reveal design, UI/UX, all four game engines
**Next:** wire `commitMove` / `resolvePot` to real STRK20 shielded transfers, deploy the match/escrow contract, replace the mocked open-cases board with live on-chain state

Tracking progress in [Issues](../../issues).

<br/>

## Running it locally

Static frontend, no build step.

```bash
git clone https://github.com/<your-username>/hidden.git
cd hidden
python3 -m http.server 8000
# open http://localhost:8000
```

<br/>

## Project structure

```
.
├── index.html      # shell + game tabs
├── style.css       # visual design
├── app.js          # game engines, board state, render loop, chain-call stubs
├── icon.svg / icon.jpg
└── strk20.json     # mainnet transaction record (added once live txs exist)
```

<br/>

## Roadmap

- [ ] Integrate STRK20 Privacy SDK for real shielded deposits/withdrawals
- [ ] Deploy match escrow contract to Starknet mainnet
- [ ] Replace mocked open-cases board with live on-chain state
- [ ] Record 3+ verified mainnet transactions in `strk20.json`
- [ ] Record demo video

<br/>

<div align="center">

**License:** MIT — see [LICENSE](./LICENSE)

Built for the [STRK20 Private Sprint](https://strk20.starknet.io/hackathon)

</div>
