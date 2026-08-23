// SPDX-License-Identifier: MIT
//
// HIDDEN — one shared case/state contract for 4 hidden-move wager games:
// RockPaperScissors, PrisonersDilemma, Bluff, Assassin (binary overlap version).
// Design recap (unchanged from prior drafts):
//  - Game state (stake, deadlines, commits, reveals, resolution) lives HERE,
//    in plain public contract storage — NOT in the privacy pool.
//  - The pool only gets called at the two moments money actually moves:
//      * Deposit  — on create_case / join_case, funds get parked here
//        (empty-span pattern, exactly like the STRK20 escrow example).
//      * Claim    — on payout, whoever holds the matching claim secret
//        can pull the pot into their own open note.
//  - commit_move / reveal_move / reveal_action / reveal_card / resolve are
//    ordinary Starknet calls. They never touch the pool. Only
//    Deposit/Claim do.
//  - Assassin's assassin/target role is decided fairly in join_case via
//    compute_assassin_role — see that function's own doc comment for the
//    known (accepted-for-hackathon) grinding caveat.

use starknet::ContractAddress;
use core::poseidon::poseidon_hash_span;


// Shared types


#[derive(Serde, Copy, Drop, PartialEq, Debug, starknet::Store)]
pub enum GameType {
    #[default]
    RockPaperScissors,
    PrisonersDilemma,
    Bluff,
    Assassin,
}

// Who the pot went to, once resolved.
#[derive(Serde, Copy, Drop, PartialEq, Debug, starknet::Store)]
pub enum Outcome {
    #[default]
    Unresolved,
    PlayerA,
    PlayerB,
    Refund, // neither side committed in time
}

// Mirrors the pool's expected return type from `privacy_invoke`.
// From privacy::objects — keep this in sync with the real SDK type.
#[derive(Serde, Copy, Drop, Debug)]
pub struct OpenNoteDeposit {
    pub note_id: felt252,
    pub token: ContractAddress,
    pub amount: u128,
}

// Operation the pool is asking this contract to perform when it calls
// `privacy_invoke`. Mirrors the STRK20 escrow example's Deposit/Claim shape,
// extended with a case_id so one contract can host many concurrent cases.
#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub enum CaseOperation {
    Deposit,
    Claim,
}


// Case state


#[derive(Serde, Copy, Drop, Debug, starknet::Store)]
pub struct CaseEntry {
    pub creator: ContractAddress,
    pub opponent: ContractAddress, // zero() until someone joins
    pub game_type: GameType,
    pub token: ContractAddress,
    pub stake_amount: u128, // per player; pot = 2x this

    pub join_deadline: u64,
    pub move_deadline: u64,

    // RPS / PD / Assassin: the single move commit+reveal.
    // Bluff: this pair holds the ACTION commit+reveal only (0=Fold,
    // 1=Bet/Call). The card lives in its own separate pair below —
    // see the file header for why they had to be split.
    //
    // For Assassin, 3 tile picks (0..15 each, matching the frontend's
    // 4x4 grid) are packed into revealed_move via pack_tiles.
    pub commit_hash_a: felt252,
    pub commit_hash_b: felt252,
    pub revealed_move_a: felt252,
    pub revealed_move_b: felt252,
    pub has_committed_a: bool,
    pub has_committed_b: bool,
    pub has_revealed_a: bool, // Bluff: means "action revealed", not card
    pub has_revealed_b: bool,

    // Bluff only. Committed alongside commit_hash_* in the same
    // commit_move call (locked in before either player has acted), but
    // revealed separately and later, only at showdown — never before
    // both sides' actions are already locked in.
    pub card_commit_a: felt252,
    pub card_commit_b: felt252,
    pub revealed_card_a: felt252,
    pub revealed_card_b: felt252,
    pub has_revealed_card_a: bool,
    pub has_revealed_card_b: bool,

    // Claim-authorization secrets (submitted alongside commit, NOT reveal —
    // this is what lets a no-show's forfeited stake still be claimable,
    // since it doesn't depend on that player ever revealing anything).
    // Also settable via cancel_case, for the pre-match refund path.
    pub claim_hash_a: felt252,
    pub claim_hash_b: felt252,

    // Pool funding state — set true only by privacy_invoke(Deposit, ...).
    pub funded_a: bool,
    pub funded_b: bool,

    pub outcome: Outcome,
    pub claimed_a: bool,
    pub claimed_b: bool,

    // Only meaningful when game_type is Assassin. Set in join_case, once
    // the two players are known. true means the creator is the assassin,
    // false means the opponent is.
    pub assassin_is_a: bool,
}

pub mod errors {
    pub const CASE_NOT_FOUND: felt252 = 'CASE_NOT_FOUND';
    pub const ALREADY_JOINED: felt252 = 'ALREADY_JOINED';
    pub const JOIN_WINDOW_CLOSED: felt252 = 'JOIN_WINDOW_CLOSED';
    pub const NOT_MATCHED: felt252 = 'NOT_MATCHED';
    pub const ALREADY_COMMITTED: felt252 = 'ALREADY_COMMITTED';
    pub const NOT_A_PLAYER: felt252 = 'NOT_A_PLAYER';
    pub const MOVE_WINDOW_OPEN: felt252 = 'MOVE_WINDOW_OPEN';
    pub const MOVE_WINDOW_CLOSED: felt252 = 'MOVE_WINDOW_CLOSED';
    pub const HASH_MISMATCH: felt252 = 'HASH_MISMATCH';
    pub const NOT_COMMITTED: felt252 = 'NOT_COMMITTED';
    pub const ALREADY_RESOLVED: felt252 = 'ALREADY_RESOLVED';
    pub const NOT_RESOLVED: felt252 = 'NOT_RESOLVED';
    pub const NOT_FUNDED: felt252 = 'NOT_FUNDED';
    pub const CALLER_NOT_POOL: felt252 = 'CALLER_NOT_POOL';
    pub const CLAIM_HASH_MISMATCH: felt252 = 'CLAIM_HASH_MISMATCH';
    pub const ALREADY_CLAIMED: felt252 = 'ALREADY_CLAIMED';
    pub const NOTHING_TO_CLAIM: felt252 = 'NOTHING_TO_CLAIM';
    pub const WRONG_REVEAL_FUNCTION: felt252 = 'WRONG_REVEAL_FUNCTION';
    pub const ACTION_NOT_REVEALED: felt252 = 'ACTION_NOT_REVEALED';
    pub const ACTION_ALREADY_REVEALED: felt252 = 'ACTION_ALREADY_REVEALED';
    pub const CARD_ALREADY_REVEALED: felt252 = 'CARD_ALREADY_REVEALED';
    pub const CARD_HASH_MISMATCH: felt252 = 'CARD_HASH_MISMATCH';
    pub const WRONG_TOKEN: felt252 = 'WRONG_TOKEN';
    pub const WRONG_AMOUNT: felt252 = 'WRONG_AMOUNT';
}

// Domain-separation tags. Each phase gets its own tag so an action-commit
// hash and a card-commit hash can never collide even if the same salt
// were accidentally reused across them.
pub const CLAIM_TAG: felt252 = 'HIDDEN_CLAIM_TAG:V1';
pub const MOVE_TAG: felt252 = 'HIDDEN_MOVE_TAG:V1';
pub const ACTION_TAG: felt252 = 'HIDDEN_ACTION_TAG:V1';
pub const CARD_TAG: felt252 = 'HIDDEN_CARD_TAG:V1';

pub fn compute_claim_hash(secret: felt252) -> felt252 {
    poseidon_hash_span([CLAIM_TAG, secret].span())
}

// RPS / PD / Assassin move commitments.
pub fn compute_move_hash(move_value: felt252, salt: felt252) -> felt252 {
    poseidon_hash_span([MOVE_TAG, move_value, salt].span())
}

// Bluff action (0=Fold, 1=Bet/Call) commitment. Separate tag from
// compute_move_hash even though the shape is identical — keeps the two
// phases cryptographically distinct, not just distinct by storage field.
pub fn compute_action_hash(action: felt252, salt: felt252) -> felt252 {
    poseidon_hash_span([ACTION_TAG, action, salt].span())
}

// Bluff card commitment — the piece that must stay hidden until showdown.
pub fn compute_card_hash(card_index: felt252, salt: felt252) -> felt252 {
    poseidon_hash_span([CARD_TAG, card_index, salt].span())
}

pub const ROLE_TAG: felt252 = 'HIDDEN_ROLE_TAG:V1';

// Decides who's the assassin the moment a case gets matched. Neither
// player controls this alone: it depends on both addresses plus the
// exact block timestamp of the join, which nobody can predict ahead of
// time. Returns true if the creator (player A) is the assassin.
//
// Worth knowing for later: a player could in theory simulate join_case
// locally, see which role they'd get, and only actually send the
// transaction on a timestamp that favors them. Fine for a hackathon,
// not something to ship as-is once real money is on the line. A proper
// fix is a separate commit-reveal round just for this coin flip, done
// before either player picks tiles.
pub fn compute_assassin_role(
    creator: ContractAddress, opponent: ContractAddress, timestamp: u64,
) -> bool {
    let creator_felt: felt252 = creator.into();
    let opponent_felt: felt252 = opponent.into();
    let timestamp_felt: felt252 = timestamp.into();
    let hash = poseidon_hash_span(
        [ROLE_TAG, creator_felt, opponent_felt, timestamp_felt].span(),
    );
    let hash_u256: u256 = hash.into();
    (hash_u256 % 2) == 0
}

// Assassin helper: pack 3 tile indices (0..15, matching the frontend's 4x4
// grid) into one felt, unpack for comparison.
pub fn pack_tiles(t1: felt252, t2: felt252, t3: felt252) -> felt252 {
    t1 + t2 * 16 + t3 * 256
}

fn tiles_overlap(packed_a: felt252, packed_b: felt252) -> bool {
    let a1: u32 = (packed_a.try_into().unwrap()) % 16_u32;
    let a_rem1: u32 = (packed_a.try_into().unwrap()) / 16_u32;
    let a2: u32 = a_rem1 % 16_u32;
    let a3: u32 = a_rem1 / 16_u32;

    let b1: u32 = (packed_b.try_into().unwrap()) % 16_u32;
    let b_rem1: u32 = (packed_b.try_into().unwrap()) / 16_u32;
    let b2: u32 = b_rem1 % 16_u32;
    let b3: u32 = b_rem1 / 16_u32;

    (a1 == b1) || (a1 == b2) || (a1 == b3)
        || (a2 == b1) || (a2 == b2) || (a2 == b3)
        || (a3 == b1) || (a3 == b2) || (a3 == b3)
}


// Minimal ERC20 interface — just the two functions this contract needs
// (transfer, for paying out the platform fee).


#[starknet::interface]
pub trait IERC20<T> {
    fn transfer(ref self: T, recipient: ContractAddress, amount: u256) -> bool;
    fn balance_of(self: @T, account: ContractAddress) -> u256;
    fn approve(ref self: T, spender: ContractAddress, amount: u256) -> bool;
}


// Interface

#[starknet::interface]
pub trait IHiddenCase<T> {
    fn create_case(
        ref self: T,
        game_type: GameType,
        token: ContractAddress,
        stake_amount: u128,
        join_window_secs: u64,
    ) -> felt252;

    fn join_case(ref self: T, case_id: felt252);

    // Creator-only, only while unmatched. Refunds via the normal Claim
    // path — claim_hash is required here for the same reason it's
    // required in commit_move: without it, the refund would be
    // permanently unclaimable once Deposit is live.
    fn cancel_case(ref self: T, case_id: felt252, claim_hash: felt252);

    // `card_commit` is only meaningful for Bluff — pass 0 for RPS/PD/
    // Assassin. For Bluff, `commit_hash` is the ACTION commitment
    // (compute_action_hash) and `card_commit` is the CARD commitment
    // (compute_card_hash), submitted together, revealed separately later.
    fn commit_move(
        ref self: T,
        case_id: felt252,
        commit_hash: felt252,
        card_commit: felt252,
        claim_hash: felt252,
    );

    // RPS/PD/Assassin only. For Assassin, pass `pack_tiles(t1, t2, t3)`
    // as move_value. Reverts if called on a Bluff case — use
    // reveal_action / reveal_card instead.
    fn reveal_move(ref self: T, case_id: felt252, move_value: felt252, salt: felt252);

    // Bluff only, phase 1. action is 0=Fold or 1=Bet(A)/Call(B). A Fold
    // ends the case immediately — the card never needs to be revealed.
    fn reveal_action(ref self: T, case_id: felt252, action: felt252, salt: felt252);

    // Bluff only, phase 2 — showdown. Only reachable if both sides
    // bet/called (i.e. neither folded in reveal_action). card_index is
    // 0..12, matching the frontend's RANKS array.
    fn reveal_card(ref self: T, case_id: felt252, card_index: felt252, salt: felt252);

    // Permissionless — anyone can trigger resolution once conditions are met.
    fn resolve(ref self: T, case_id: felt252);

    fn get_case(self: @T, case_id: felt252) -> CaseEntry;

    // Called by the STRK20 pool via INVOKE_SELECTOR. Signature is ours to
    // design past `operation` per the STRK20 anonymizer-contract spec.
    fn privacy_invoke(
        ref self: T,
        operation: CaseOperation,
        case_id: felt252,
        is_player_a: bool, // which side this call is funding/claiming for
        token: ContractAddress, // ERC20 token; validated against entry.token on Deposit
        amount: u128,            // amount funded; validated against entry.stake_amount on Deposit
        secret: felt252,   // claim secret; ignored on Deposit
        note_id: felt252,  // destination open note; ignored on Deposit
    ) -> Span<OpenNoteDeposit>;
}


// Contract

#[starknet::contract]
pub mod HiddenCase {
    use core::num::traits::Zero;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_caller_address, get_block_timestamp};
    use super::{
        CaseEntry, CaseOperation, GameType, IERC20Dispatcher, IERC20DispatcherTrait, IHiddenCase,
        OpenNoteDeposit, Outcome, compute_action_hash, compute_assassin_role, compute_card_hash,
        compute_claim_hash, compute_move_hash, errors, tiles_overlap,
    };

    // MVP: fixed platform fee, 2% = 200 / 10000.
    const PLATFORM_FEE_BPS: u128 = 200;
    const BPS_DENOMINATOR: u128 = 10000;

    // Move/reveal window: 4 hours. Single source of truth — the frontend's
    // MOVE_WINDOW_MS must be kept at 4*60*60*1000 to match this. There is
    // no way to configure this per-case.
    const MOVE_WINDOW_SECS: u64 = 14400;

    #[storage]
    struct Storage {
        privacy_pool: ContractAddress, // TODO: set to the live STRK20 pool address
        platform_wallet: ContractAddress, // TODO: set to your real fee-recipient address
        case_counter: felt252,
        cases: Map<felt252, CaseEntry>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        CaseCreated: CaseCreated,
        CaseJoined: CaseJoined,
        MoveCommitted: MoveCommitted,
        MoveRevealed: MoveRevealed,
        CaseResolved: CaseResolved,
        StakeClaimed: StakeClaimed,
    }

    #[derive(Drop, starknet::Event)]
    pub struct CaseCreated {
        #[key]
        pub case_id: felt252,
        pub creator: ContractAddress,
        pub game_type: GameType,
        pub stake_amount: u128,
        pub join_deadline: u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct CaseJoined {
        #[key]
        pub case_id: felt252,
        pub creator: ContractAddress,
        pub opponent: ContractAddress,
        pub move_deadline: u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct MoveCommitted {
        #[key]
        pub case_id: felt252,
        pub is_player_a: bool,
    }

    // Reused for RPS/PD/Assassin's single reveal, Bluff's action reveal,
    // AND Bluff's card reveal — all three are "a player revealed
    // something for this case," which is all an off-chain watcher needs
    // to know which side to nudge next. Not split into separate event
    // types since none of the current consumers (notifier bot, my-cases
    // resume) need to distinguish which phase fired.
    #[derive(Drop, starknet::Event)]
    pub struct MoveRevealed {
        #[key]
        pub case_id: felt252,
        pub is_player_a: bool,
    }

    #[derive(Drop, starknet::Event)]
    pub struct CaseResolved {
        #[key]
        pub case_id: felt252,
        pub outcome: Outcome,
    }

    #[derive(Drop, starknet::Event)]
    pub struct StakeClaimed {
        #[key]
        pub case_id: felt252,
        pub is_player_a: bool,
        pub amount: u128,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        privacy_pool: ContractAddress,
        platform_wallet: ContractAddress,
    ) {
        self.privacy_pool.write(privacy_pool);
        self.platform_wallet.write(platform_wallet);
        self.case_counter.write(0);
    }

    #[abi(embed_v0)]
    pub impl HiddenCaseImpl of IHiddenCase<ContractState> {
        fn create_case(
            ref self: ContractState,
            game_type: GameType,
            token: ContractAddress,
            stake_amount: u128,
            join_window_secs: u64,
        ) -> felt252 {
            let caller = get_caller_address();
            let now = get_block_timestamp();

            let case_id = self.case_counter.read() + 1;
            self.case_counter.write(case_id);

            let join_deadline = now + join_window_secs;

            let entry = CaseEntry {
                creator: caller,
                opponent: Zero::zero(),
                game_type,
                token,
                stake_amount,
                join_deadline,
                move_deadline: 0, // set once matched, in join_case
                commit_hash_a: 0,
                commit_hash_b: 0,
                revealed_move_a: 0,
                revealed_move_b: 0,
                has_committed_a: false,
                has_committed_b: false,
                has_revealed_a: false,
                has_revealed_b: false,
                card_commit_a: 0,
                card_commit_b: 0,
                revealed_card_a: 0,
                revealed_card_b: 0,
                has_revealed_card_a: false,
                has_revealed_card_b: false,
                claim_hash_a: 0,
                claim_hash_b: 0,
                funded_a: false,
                funded_b: false,
                outcome: Outcome::Unresolved,
                claimed_a: false,
                claimed_b: false,
                assassin_is_a: false, // real value gets set in join_case
            };
            self.cases.write(case_id, entry);

            self.emit(
                CaseCreated { case_id, creator: caller, game_type, stake_amount, join_deadline },
            );

            // Actual stake transfer happens via a separate privacy_invoke(Deposit, ...)
            // call from the pool, bundled by the frontend in the same multicall as
            // this create_case call. This function only records case metadata.

            case_id
        }

        fn join_case(ref self: ContractState, case_id: felt252) {
            let caller = get_caller_address();
            let now = get_block_timestamp();
            let mut entry = self.cases.read(case_id);
            assert(entry.creator.is_non_zero(), errors::CASE_NOT_FOUND);
            assert(entry.opponent.is_zero(), errors::ALREADY_JOINED);
            assert(now <= entry.join_deadline, errors::JOIN_WINDOW_CLOSED);

            entry.opponent = caller;
            let move_deadline = now + MOVE_WINDOW_SECS;
            entry.move_deadline = move_deadline;

            if entry.game_type == GameType::Assassin {
                entry.assassin_is_a = compute_assassin_role(entry.creator, caller, now);
            }

            self.cases.write(case_id, entry);

            self.emit(
                CaseJoined { case_id, creator: entry.creator, opponent: caller, move_deadline },
            );

            // Stake B moves via a separate privacy_invoke(Deposit, ...) call,
            // same as create_case above.
        }

        fn cancel_case(ref self: ContractState, case_id: felt252, claim_hash: felt252) {
            let caller = get_caller_address();
            let mut entry = self.cases.read(case_id);
            assert(entry.creator.is_non_zero(), errors::CASE_NOT_FOUND);
            assert(caller == entry.creator, errors::NOT_A_PLAYER);
            assert(entry.opponent.is_zero(), errors::ALREADY_JOINED);

            entry.claim_hash_a = claim_hash;
            entry.outcome = Outcome::Refund;
            self.cases.write(case_id, entry);
            self.emit(CaseResolved { case_id, outcome: entry.outcome });
        }

        fn commit_move(
            ref self: ContractState,
            case_id: felt252,
            commit_hash: felt252,
            card_commit: felt252,
            claim_hash: felt252,
        ) {
            let caller = get_caller_address();
            let mut entry = self.cases.read(case_id);
            assert(entry.opponent.is_non_zero(), errors::NOT_MATCHED);

            let is_player_a = caller == entry.creator;

            if caller == entry.creator {
                assert(!entry.has_committed_a, errors::ALREADY_COMMITTED);
                entry.commit_hash_a = commit_hash;
                entry.card_commit_a = card_commit;
                entry.claim_hash_a = claim_hash;
                entry.has_committed_a = true;
            } else if caller == entry.opponent {
                assert(!entry.has_committed_b, errors::ALREADY_COMMITTED);
                // Bluff only: B (call/fold) can't act until A (bet/fold) has
                // already revealed their ACTION. If A folded, the case
                // already resolved and B has nothing to respond to.
                if entry.game_type == GameType::Bluff {
                    assert(entry.has_revealed_a, errors::NOT_COMMITTED);
                    assert(entry.outcome == Outcome::Unresolved, errors::ALREADY_RESOLVED);
                }
                entry.commit_hash_b = commit_hash;
                entry.card_commit_b = card_commit;
                entry.claim_hash_b = claim_hash;
                entry.has_committed_b = true;
            } else {
                assert(false, errors::NOT_A_PLAYER);
            }
            self.cases.write(case_id, entry);
            self.emit(MoveCommitted { case_id, is_player_a });
        }

        fn reveal_move(ref self: ContractState, case_id: felt252, move_value: felt252, salt: felt252) {
            let caller = get_caller_address();
            let now = get_block_timestamp();
            let mut entry = self.cases.read(case_id);
            assert(entry.game_type != GameType::Bluff, errors::WRONG_REVEAL_FUNCTION);
            assert(now <= entry.move_deadline, errors::MOVE_WINDOW_CLOSED);

            let expected_hash = compute_move_hash(move_value, salt);
            let is_player_a = caller == entry.creator;

            if caller == entry.creator {
                assert(entry.has_committed_a, errors::NOT_COMMITTED);
                assert(expected_hash == entry.commit_hash_a, errors::HASH_MISMATCH);
                entry.revealed_move_a = move_value;
                entry.has_revealed_a = true;
            } else if caller == entry.opponent {
                assert(entry.has_committed_b, errors::NOT_COMMITTED);
                assert(expected_hash == entry.commit_hash_b, errors::HASH_MISMATCH);
                entry.revealed_move_b = move_value;
                entry.has_revealed_b = true;
            } else {
                assert(false, errors::NOT_A_PLAYER);
            }
            self.cases.write(case_id, entry);
            self.emit(MoveRevealed { case_id, is_player_a });
        }

        fn reveal_action(ref self: ContractState, case_id: felt252, action: felt252, salt: felt252) {
            let caller = get_caller_address();
            let now = get_block_timestamp();
            let mut entry = self.cases.read(case_id);
            assert(entry.game_type == GameType::Bluff, errors::WRONG_REVEAL_FUNCTION);
            assert(now <= entry.move_deadline, errors::MOVE_WINDOW_CLOSED);

            let expected_hash = compute_action_hash(action, salt);
            let is_player_a = caller == entry.creator;
            let is_fold = action == 0_felt252;

            if caller == entry.creator {
                assert(entry.has_committed_a, errors::NOT_COMMITTED);
                assert(!entry.has_revealed_a, errors::ACTION_ALREADY_REVEALED);
                assert(expected_hash == entry.commit_hash_a, errors::HASH_MISMATCH);
                entry.has_revealed_a = true;
                // A fold ends the case immediately — B never has to act,
                // and A's card never has to surface.
                if is_fold {
                    entry.outcome = Outcome::PlayerB;
                }
            } else if caller == entry.opponent {
                assert(entry.has_committed_b, errors::NOT_COMMITTED);
                assert(!entry.has_revealed_b, errors::ACTION_ALREADY_REVEALED);
                assert(expected_hash == entry.commit_hash_b, errors::HASH_MISMATCH);
                entry.has_revealed_b = true;
                // B is always the last to act, since B could only commit
                // after A had already revealed a Bet (enforced in
                // commit_move). A fold here ends it; a call moves on to
                // the card-reveal showdown below.
                if is_fold {
                    entry.outcome = Outcome::PlayerA;
                }
            } else {
                assert(false, errors::NOT_A_PLAYER);
            }
            self.cases.write(case_id, entry);
            self.emit(MoveRevealed { case_id, is_player_a });
            if entry.outcome != Outcome::Unresolved {
                self.emit(CaseResolved { case_id, outcome: entry.outcome });
            }
        }

        fn reveal_card(ref self: ContractState, case_id: felt252, card_index: felt252, salt: felt252) {
            let caller = get_caller_address();
            let now = get_block_timestamp();
            let mut entry = self.cases.read(case_id);
            assert(entry.game_type == GameType::Bluff, errors::WRONG_REVEAL_FUNCTION);
            assert(entry.outcome == Outcome::Unresolved, errors::ALREADY_RESOLVED);
            assert(now <= entry.move_deadline, errors::MOVE_WINDOW_CLOSED);
            // Showdown only happens once both sides bet/called — if
            // either side's action isn't revealed yet, or was a fold,
            // the case already resolved (or shouldn't be here yet).
            assert(entry.has_revealed_a && entry.has_revealed_b, errors::ACTION_NOT_REVEALED);

            let expected_hash = compute_card_hash(card_index, salt);
            let is_player_a = caller == entry.creator;

            if caller == entry.creator {
                assert(!entry.has_revealed_card_a, errors::CARD_ALREADY_REVEALED);
                assert(expected_hash == entry.card_commit_a, errors::CARD_HASH_MISMATCH);
                entry.revealed_card_a = card_index;
                entry.has_revealed_card_a = true;
            } else if caller == entry.opponent {
                assert(!entry.has_revealed_card_b, errors::CARD_ALREADY_REVEALED);
                assert(expected_hash == entry.card_commit_b, errors::CARD_HASH_MISMATCH);
                entry.revealed_card_b = card_index;
                entry.has_revealed_card_b = true;
            } else {
                assert(false, errors::NOT_A_PLAYER);
            }

            // Once both cards are in, resolve right here — no separate
            // resolve() call needed for the happy path.
            if entry.has_revealed_card_a && entry.has_revealed_card_b {
                let card_a: u32 = entry.revealed_card_a.try_into().unwrap();
                let card_b: u32 = entry.revealed_card_b.try_into().unwrap();
                entry.outcome = if card_a == card_b {
                    Outcome::Refund
                } else if card_a > card_b {
                    Outcome::PlayerA
                } else {
                    Outcome::PlayerB
                };
            }

            self.cases.write(case_id, entry);
            self.emit(MoveRevealed { case_id, is_player_a });
            if entry.outcome != Outcome::Unresolved {
                self.emit(CaseResolved { case_id, outcome: entry.outcome });
            }
        }

        fn resolve(ref self: ContractState, case_id: felt252) {
            let now = get_block_timestamp();
            let mut entry = self.cases.read(case_id);
            // Bluff usually finishes inline already (a fold in
            // reveal_action, or a called showdown in reveal_card both
            // decide the outcome immediately). If so, resolve() has
            // nothing left to do — safe no-op rather than reverting,
            // since your frontend may call resolve() unconditionally
            // after every reveal.
            if entry.game_type == GameType::Bluff && entry.outcome != Outcome::Unresolved {
                return;
            }
            assert(entry.outcome == Outcome::Unresolved, errors::ALREADY_RESOLVED);
            assert(entry.opponent.is_non_zero(), errors::NOT_MATCHED);

            let a_committed = entry.has_committed_a;
            let b_committed = entry.has_committed_b;
            let a_revealed = entry.has_revealed_a;
            let b_revealed = entry.has_revealed_b;

            // --- Forfeit / refund paths: only after the move deadline passes ---
            if !a_committed && !b_committed {
                assert(now > entry.move_deadline, errors::MOVE_WINDOW_OPEN);
                entry.outcome = Outcome::Refund;
                self.cases.write(case_id, entry);
                self.emit(CaseResolved { case_id, outcome: entry.outcome });
                return;
            }
            if a_committed && !b_committed {
                assert(now > entry.move_deadline, errors::MOVE_WINDOW_OPEN);
                entry.outcome = Outcome::PlayerA;
                self.cases.write(case_id, entry);
                self.emit(CaseResolved { case_id, outcome: entry.outcome });
                return;
            }
            if b_committed && !a_committed {
                assert(now > entry.move_deadline, errors::MOVE_WINDOW_OPEN);
                entry.outcome = Outcome::PlayerB;
                self.cases.write(case_id, entry);
                self.emit(CaseResolved { case_id, outcome: entry.outcome });
                return;
            }

            // Both committed. Same rule extends to reveal: committed-but-never-
            // revealed by deadline is treated as a loss, not a refund.
            // For Bluff, "revealed" here means action-revealed.
            if !a_revealed && !b_revealed {
                assert(now > entry.move_deadline, errors::MOVE_WINDOW_OPEN);
                entry.outcome = Outcome::Refund;
                self.cases.write(case_id, entry);
                self.emit(CaseResolved { case_id, outcome: entry.outcome });
                return;
            }
            if a_revealed && !b_revealed {
                assert(now > entry.move_deadline, errors::MOVE_WINDOW_OPEN);
                entry.outcome = Outcome::PlayerA;
                self.cases.write(case_id, entry);
                self.emit(CaseResolved { case_id, outcome: entry.outcome });
                return;
            }
            if b_revealed && !a_revealed {
                assert(now > entry.move_deadline, errors::MOVE_WINDOW_OPEN);
                entry.outcome = Outcome::PlayerB;
                self.cases.write(case_id, entry);
                self.emit(CaseResolved { case_id, outcome: entry.outcome });
                return;
            }

            // Both sides revealed their action (i.e. both bet/called —
            // any fold would already have set outcome inside
            // reveal_action, and the early-return at the top of this
            // function would have caught it). For Bluff specifically,
            // that means we're stalled at the card-reveal / showdown
            // stage — handle its own no-show/timeout shape explicitly,
            // same pattern as the action-level checks just above, rather
            // than falling through to evaluate() (which has no card data
            // to compare for Bluff and would just always refund).
            if entry.game_type == GameType::Bluff {
                let a_card = entry.has_revealed_card_a;
                let b_card = entry.has_revealed_card_b;
                if !a_card && !b_card {
                    assert(now > entry.move_deadline, errors::MOVE_WINDOW_OPEN);
                    entry.outcome = Outcome::Refund;
                } else if a_card && !b_card {
                    assert(now > entry.move_deadline, errors::MOVE_WINDOW_OPEN);
                    entry.outcome = Outcome::PlayerA;
                } else if b_card && !a_card {
                    assert(now > entry.move_deadline, errors::MOVE_WINDOW_OPEN);
                    entry.outcome = Outcome::PlayerB;
                } else {
                    // Both cards already in — reveal_card's own inline
                    // resolution should have caught this already. Handled
                    // defensively here too so resolve() never panics if
                    // called in this state for any reason.
                    let card_a: u32 = entry.revealed_card_a.try_into().unwrap();
                    let card_b: u32 = entry.revealed_card_b.try_into().unwrap();
                    entry.outcome = if card_a == card_b {
                        Outcome::Refund
                    } else if card_a > card_b {
                        Outcome::PlayerA
                    } else {
                        Outcome::PlayerB
                    };
                }
                self.cases.write(case_id, entry);
                self.emit(CaseResolved { case_id, outcome: entry.outcome });
                return;
            }

            // --- RPS / PD / Assassin: both sides played fair and square ---
            entry.outcome = evaluate(entry.game_type, entry.revealed_move_a, entry.revealed_move_b, entry.assassin_is_a);
            self.cases.write(case_id, entry);
            self.emit(CaseResolved { case_id, outcome: entry.outcome });
        }

        fn get_case(self: @ContractState, case_id: felt252) -> CaseEntry {
            self.cases.read(case_id)
        }

        fn privacy_invoke(
            ref self: ContractState,
            operation: CaseOperation,
            case_id: felt252,
            is_player_a: bool,
            token: ContractAddress,
            amount: u128,
            secret: felt252,
            note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            let pool = self.privacy_pool.read();
            assert(get_caller_address() == pool, errors::CALLER_NOT_POOL);

            let mut entry = self.cases.read(case_id);

            match operation {
                CaseOperation::Deposit => {
                    assert(token == entry.token, errors::WRONG_TOKEN);
                    assert(amount == entry.stake_amount, errors::WRONG_AMOUNT);
                    // Funds already arrived here via the pool's Withdraw step.
                    // We just mark this side as funded. Nothing to credit yet.
                    if is_player_a {
                        entry.funded_a = true;
                    } else {
                        entry.funded_b = true;
                    }
                    self.cases.write(case_id, entry);
                    [].span()
                },
                CaseOperation::Claim => {
                    assert(entry.outcome != Outcome::Unresolved, errors::NOT_RESOLVED);

                    let claim_hash = compute_claim_hash(secret);

                    // Refund path: each side can only claim their own stake back, and
                    // only needs to have funded their OWN side. Requiring both sides
                    // funded here was a bug — it made a one-sided deposit (a
                    // cancelled or expired never-joined case) permanently stuck,
                    // since the other side was never going to fund it by definition.
                    if entry.outcome == Outcome::Refund {
                        if is_player_a {
                            assert(entry.funded_a, errors::NOT_FUNDED);
                            assert(!entry.claimed_a, errors::ALREADY_CLAIMED);
                            assert(claim_hash == entry.claim_hash_a, errors::CLAIM_HASH_MISMATCH);
                            entry.claimed_a = true;
                            self.cases.write(case_id, entry);
                            self.emit(
                                StakeClaimed {
                                    case_id, is_player_a, amount: entry.stake_amount,
                                },
                            );
                            IERC20Dispatcher { contract_address: entry.token }
                                .approve(pool, entry.stake_amount.into());
                            return [
                                OpenNoteDeposit {
                                    note_id, token: entry.token, amount: entry.stake_amount,
                                },
                            ]
                                .span();
                        } else {
                            assert(entry.funded_b, errors::NOT_FUNDED);
                            assert(!entry.claimed_b, errors::ALREADY_CLAIMED);
                            assert(claim_hash == entry.claim_hash_b, errors::CLAIM_HASH_MISMATCH);
                            entry.claimed_b = true;
                            self.cases.write(case_id, entry);
                            self.emit(
                                StakeClaimed {
                                    case_id, is_player_a, amount: entry.stake_amount,
                                },
                            );
                            IERC20Dispatcher { contract_address: entry.token }
                                .approve(pool, entry.stake_amount.into());
                            return [
                                OpenNoteDeposit {
                                    note_id, token: entry.token, amount: entry.stake_amount,
                                },
                            ]
                                .span();
                        }
                    }

                    // Winner-take-all path genuinely needs both sides funded —
                    // the pot being paid out is stake_amount * 2, so both
                    // stakes actually need to be sitting in the contract.
                    assert(entry.funded_a && entry.funded_b, errors::NOT_FUNDED);

                    // Winner-take-all path: only the winning side's claim_hash
                    // unlocks the full (fee-adjusted) pot.
                    let caller_is_winner = (entry.outcome == Outcome::PlayerA && is_player_a)
                        || (entry.outcome == Outcome::PlayerB && !is_player_a);
                    assert(caller_is_winner, errors::NOTHING_TO_CLAIM);

                    if is_player_a {
                        assert(!entry.claimed_a, errors::ALREADY_CLAIMED);
                        assert(claim_hash == entry.claim_hash_a, errors::CLAIM_HASH_MISMATCH);
                        entry.claimed_a = true;
                    } else {
                        assert(!entry.claimed_b, errors::ALREADY_CLAIMED);
                        assert(claim_hash == entry.claim_hash_b, errors::CLAIM_HASH_MISMATCH);
                        entry.claimed_b = true;
                    }
                    self.cases.write(case_id, entry);

                    let pot: u128 = entry.stake_amount * 2;
                    let fee: u128 = (pot * PLATFORM_FEE_BPS) / BPS_DENOMINATOR;
                    let payout: u128 = pot - fee;

                    // Fee transfer: plain public ERC20 transfer out of this
                    // contract's own balance (both stakes already sit here
                    // from the two earlier Deposit calls) straight to the
                    // platform wallet. Done here, not through the pool —
                    // this leg was never private to begin with.
                    if fee > 0 {
                        IERC20Dispatcher { contract_address: entry.token }
                            .transfer(self.platform_wallet.read(), fee.into());
                    }

                    self.emit(StakeClaimed { case_id, is_player_a, amount: payout });

                    IERC20Dispatcher { contract_address: entry.token }
                        .approve(pool, payout.into());

                    [OpenNoteDeposit { note_id, token: entry.token, amount: payout }].span()
                },
            }
        }
    }

    // Win/lose/tie check for RPS / PD / Assassin. Bluff is NOT handled
    // here — it resolves inline inside reveal_action (on a fold) or
    // reveal_card (on a called showdown), and resolve() has its own
    // dedicated Bluff timeout branch above. This function is never
    // called with GameType::Bluff.
    fn evaluate(
        game_type: GameType, move_a: felt252, move_b: felt252, assassin_is_a: bool,
    ) -> Outcome {
        match game_type {
            GameType::RockPaperScissors => {
                // 0 = rock, 1 = paper, 2 = scissors.
                if move_a == move_b {
                    return Outcome::Refund; // tie — both stakes go back
                }
                let a: u32 = move_a.try_into().unwrap();
                let b: u32 = move_b.try_into().unwrap();
                // A's move beats B's move when B is exactly one step behind
                // A in the cycle (rock beats scissors, paper beats rock,
                // scissors beats paper).
                if (b + 1) % 3_u32 == a {
                    Outcome::PlayerA
                } else {
                    Outcome::PlayerB
                }
            },
            GameType::PrisonersDilemma => {
                // 0 = trust, 1 = betray.
                // Symmetric outcomes refund: both trust -> nobody exploited
                // anybody, refund. Both betray -> mutual defection, refund.
                // Only a one-sided betrayal produces a winner: the betrayer
                // takes the whole pot from the player who trusted them.
                if move_a == 1_felt252 && move_b == 0_felt252 {
                    Outcome::PlayerA // A betrayed, B trusted
                } else if move_a == 0_felt252 && move_b == 1_felt252 {
                    Outcome::PlayerB // B betrayed, A trusted
                } else {
                    Outcome::Refund // both trusted, or both betrayed
                }
            },
            GameType::Bluff => Outcome::Refund, // unreachable — see note above
            GameType::Assassin => {
                // Who's the assassin was decided fairly back in join_case,
                // not assumed here. Figure out which move belongs to the
                // assassin and which to the target before comparing.
                let assassin_tiles = if assassin_is_a { move_a } else { move_b };
                let target_tiles = if assassin_is_a { move_b } else { move_a };

                // ANY overlap => assassin wins the whole pot. Zero overlap
                // => target wins. No tie state, 3v3 either overlaps or not.
                let assassin_wins = tiles_overlap(assassin_tiles, target_tiles);
                if assassin_is_a {
                    if assassin_wins { Outcome::PlayerA } else { Outcome::PlayerB }
                } else {
                    if assassin_wins { Outcome::PlayerB } else { Outcome::PlayerA }
                }
            },
        }
    }
}
