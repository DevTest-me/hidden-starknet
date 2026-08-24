<div align="center">
  <img src="./icon.svg" width="88" height="88" alt="HIDDEN logo" />

  # HIDDEN

  **Games where your opponent can't see your move.**

  Built on Starknet mainnet with **STRK20** — shielded balances, private transfers, zero visibility into your opponent's move until reveal.

  ![Starknet](https://img.shields.io/badge/Starknet-mainnet-0C0C4E?style=flat-square)
  ![STRK20](https://img.shields.io/badge/STRK20-privacy%20pool-6E56CF?style=flat-square)
  ![License](https://img.shields.io/badge/license-MIT-brightgreen?style=flat-square)
  ![Status](https://img.shields.io/badge/status-live%20on%20mainnet-success?style=flat-square)
</div>

<br/>

## What it is

HIDDEN is a suite of 1v1 wagered games where privacy is the core mechanic, split across two different layers: the contract's own commit-reveal scheme keeps your move hidden from your opponent, and the STRK20 pool keeps your stake and payout unlinked from your wallet. Every match ("case") is posted to an open board with a stake in STRK. Anyone can join, or you can send a direct link.

<br/>

<table>
<tr>
<td width="50%" valign="top">

### 🪨 Rock / Paper / Scissors
Classic simultaneous reveal. Nobody sees a move until both sides are locked.

### 🤝 Prisoner's Dilemma
Trust or betray, without either side seeing the other's choice first.

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

## What's actually private, and what isn't

Two separate mechanisms, two separate jobs — worth being precise about which does what:

- **Move privacy comes from the contract, not STRK20.** Each move is locked on-chain as a commitment hash before it's ever revealed. This is the `HiddenCase` contract's own commit-reveal logic — STRK20 has nothing to do with hiding what you played.
- **Stake and payout privacy comes from STRK20.** Deposits and payouts move through STRK20's shielded pool, so a stake entering or leaving a case isn't trivially linkable back to the wallet that sent or received it.
- **Opponent identity is a separate question from both of the above.** If you match through the open board, you don't know who you're playing. If you send someone a direct case link, you obviously already know who you sent it to — the privacy here is about the move and the money, not about concealing who you're playing against when you chose to tell them yourself.

<br/>

## Status: live on Starknet mainnet

Everything below runs against a deployed contract and the live STRK20 pool — no stubs, no testnet, no mocked board.

**Confirmed working, end to end:**

- Wallet connect for Ready X (Argent X), Braavos, and Xverse, via each wallet's injected `wallet-standard` provider
- The full case lifecycle for all four games — `create_case` → `join_case` → `commit_move` → `reveal_move` / `reveal_action` / `reveal_card` → `resolve` — against the deployed `HiddenCase` contract
- Real stake transfers through the STRK20 pool's `privacy_invoke` (Deposit on create/join, Claim on payout or refund), sent via `WalletAccountV6.strk20InvokeTransaction`
- Shielded STRK balance reads, refreshed periodically and after every claim
- Pre-match cancellation, with an immediately claimable refund
- Reveal secrets and claim secrets persisted to `localStorage`, so a closed tab or a reload mid-match doesn't strand either player
- Automatic timeout handling: a no-show forfeits the pot to the player who did move; a double no-show refunds both sides
- The open-cases board and "My Cases" list are read live from the chain (see the scanning caveat below — it's not event-indexed)

**Not working yet:**

- **Session keys.** Gasless-feeling commit/reveal via Argent X and Braavos session accounts is implemented but doesn't function correctly yet. The session packages for both wallets (`@argent/x-sessions`, `starknet-sessions`) build their session account against an older `starknet.js` account-construction shape than the version this project is on, so the two don't line up. Every commit/reveal currently falls back to a normal wallet popup and signature instead of running through a session key — functionally fine, just an extra signature per action instead of a smoother flow.

<br/>

## Known limitations

Being direct about what's not airtight yet, rather than papering over it:

### 1. `Deposit` doesn't guard against being called twice for the same side

In `privacy_invoke`:

```cairo
CaseOperation::Deposit => {
    assert(token == entry.token, errors::WRONG_TOKEN);
    assert(amount == entry.stake_amount, errors::WRONG_AMOUNT);
    if is_player_a {
        entry.funded_a = true;   // ← no check that funded_a was false first
    }
    ...
```

If `Deposit` ever fires twice for the same side (a bug upstream in the pool, a retried transaction, anything), the contract holds 2x that player's stake with no way to claim the extra back out — `Claim` always pays exactly `stake_amount` (or the fixed pot), never "whatever is actually sitting here." This is **not attacker-exploitable** — nobody profits from it — but real money can get permanently stuck.

**Current mitigation:** don't sign the deposit step twice for the same case. In practice this means: if a deposit transaction appears to fail or hang, check the case state (or your wallet's transaction history) before retrying, rather than immediately resubmitting.

**Fix, not yet shipped:** a one-line `assert(!entry.funded_a, errors::ALREADY_FUNDED)` (and the `_b` equivalent), same pattern already used for `claimed_a` / `claimed_b` a few lines down. Small change, but it touches the live contract, so it's queued for the next deployment rather than rushed in.

### 2. Session keys don't work yet

Covered above — falls back to a normal signature per action. No funds-safety impact, just a UX rough edge.

### 3. Assassin's role assignment is timestamp-derived, not committed

`compute_assassin_role` decides who's the assassin from both addresses plus the exact block timestamp of the `join_case` call. Neither player controls the outcome directly, but a sufficiently motivated player could simulate the join locally, see which role they'd land, and only broadcast the transaction on a timestamp that favors them. This is called out directly in the contract's own doc comment as an accepted, not-fixed-for-launch caveat. A proper fix is a separate commit-reveal round dedicated to the coin flip, run before tile-picking starts.

### 4. The board isn't event-indexed

The open-cases board and "My Cases" rehydration both work by linearly probing case IDs 1 through 200 via `get_case`, not by scanning `CaseCreated` events through an indexer. Fine at current case volume; will need a real indexer (or at minimum, event-based lookups) if volume grows meaningfully.

### 5. Fixed fee, fixed pool address

The 2% platform fee, the STRK20 pool address, and the platform fee wallet are all set once at deploy time in the constructor and can't be changed afterward. Any change requires a new deployment.

### 6. Stats are local to your browser

Games played, win rate, streaks, and total staked/won are stored in `localStorage`, not on any shared leaderboard. Your on-chain shielded balance is always read live from your wallet; everything else in the profile card is just this browser's memory of your play.

### 7. Debug logging is on by default

`DEBUG = true` at the top of `app.js` logs every chain interaction to the console with a `[HIDDEN] ` prefix. Left on for now while activity is still being watched closely right after launch; worth flipping to `false` once things have settled.

<br/>

## Running it locally

```bash
git clone https://github.com/<your-username>/hidden.git
cd hidden
npm install
```

You'll need an RPC key for mainnet reads (used via `import.meta.env.VITE_ALCHEMY_KEY`). Create a `.env` file:

```
VITE_ALCHEMY_KEY=your_alchemy_key_here
```

Then run whichever dev script your `package.json` defines (typically `npm run dev` for a Vite project). Check `package.json` directly if the script name differs.

<br/>

## Project structure

```
.
├── index.html          # shell + game tabs
├── style.css            # visual design
├── app.js                # game engines, chain wiring, session-key setup, render loop
├── contracts/
│   └── hidden_case.cairo # the deployed HiddenCase contract (Cairo)
├── icon.svg / icon.jpg
└── strk20.json           # mainnet transaction record
```

<br/>

## Roadmap

**Before submission:**

- [ ] Record demo video
- [ ] Turn off default debug logging

**After the hackathon:**

- [ ] Ship the `ALREADY_FUNDED` guard on `Deposit` (see Known limitations #1)
- [ ] Fix session-key account construction so Argent X / Braavos sessions actually work
- [ ] Move Assassin's role assignment to a dedicated commit-reveal round
- [ ] Replace the linear case-ID probe with event-indexed lookups if volume grows

<br/>

<div align="center">

**License:** MIT — see [LICENSE](./LICENSE)

Built for the [STRK20 Private Sprint](https://strk20.starknet.io/hackathon)

</div>
