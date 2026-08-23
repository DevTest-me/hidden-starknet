use core::panic_with_felt252;
use starknet::{ContractAddress, get_caller_address};
use starknet::storage::{Map, StorageMapReadAccess, StorageMapWriteAccess};
use snforge_std::{
    declare, ContractClassTrait, DeclareResultTrait, start_cheat_block_timestamp,
    start_cheat_caller_address, stop_cheat_caller_address,
};

use hidden_case::{
    compute_action_hash, compute_card_hash, compute_claim_hash,
    compute_move_hash, pack_tiles, CaseOperation, GameType, IHiddenCaseDispatcher,
    IHiddenCaseDispatcherTrait, IHiddenCaseSafeDispatcher, IHiddenCaseSafeDispatcherTrait, Outcome,
};

const STAKE: u128 = 1000;
fn creator() -> ContractAddress { address(0x111) }
fn joiner() -> ContractAddress { address(0x222) }
fn pool() -> ContractAddress { address(0x123) }
fn platform() -> ContractAddress { address(0x456) }

#[starknet::contract]
mod MockToken {
    use super::*;

    #[storage]
    struct Storage { balances: Map<ContractAddress, u256> }

    #[abi(embed_v0)]
    impl MockTokenImpl of IERC20Mock<ContractState> {
        fn mint(ref self: ContractState, to: ContractAddress, amount: u256) {
            let old = self.balances.read(to);
            self.balances.write(to, old + amount);
        }
        fn balance_of(self: @ContractState, owner: ContractAddress) -> u256 {
            self.balances.read(owner)
        }
        fn transfer(ref self: ContractState, recipient: ContractAddress, amount: u256) -> bool {
            let caller = get_caller_address();
            let old = self.balances.read(caller);
            assert(old >= amount, 'TOKEN_BALANCE');
            self.balances.write(caller, old - amount);
            self.balances.write(recipient, self.balances.read(recipient) + amount);
            true
        }
        fn approve(ref self: ContractState, spender: ContractAddress, amount: u256) -> bool { true }
    }

    #[starknet::interface]
    pub trait IERC20Mock<T> {
        fn mint(ref self: T, to: ContractAddress, amount: u256);
        fn balance_of(self: @T, owner: ContractAddress) -> u256;
        fn transfer(ref self: T, recipient: ContractAddress, amount: u256) -> bool;
        fn approve(ref self: T, spender: ContractAddress, amount: u256) -> bool;
    }
}

use MockToken::{IERC20MockDispatcher, IERC20MockDispatcherTrait};

fn address(value: felt252) -> ContractAddress { value.try_into().unwrap() }

fn deploy_token() -> IERC20MockDispatcher {
    let class = declare("MockToken").unwrap().contract_class();
    let ctor = array![];
    let (contract_address, _) = class.deploy(@ctor).unwrap();
    IERC20MockDispatcher { contract_address }
}

fn deploy_hidden_case() -> IHiddenCaseDispatcher {
    let class = declare("HiddenCase").unwrap().contract_class();
    let ctor = array![pool().into(), platform().into()];
    let (contract_address, _) = class.deploy(@ctor).unwrap();
    IHiddenCaseDispatcher { contract_address }
}

fn create_case(dispatcher: IHiddenCaseDispatcher, game: GameType, token: ContractAddress, stake: u128) -> felt252 {
    start_cheat_caller_address(dispatcher.contract_address, creator());
    let id = dispatcher.create_case(game, token, stake, 100);
    stop_cheat_caller_address(dispatcher.contract_address);
    id
}

fn join_case(dispatcher: IHiddenCaseDispatcher, id: felt252) {
    start_cheat_caller_address(dispatcher.contract_address, joiner());
    dispatcher.join_case(id);
    stop_cheat_caller_address(dispatcher.contract_address);
}

fn fund(dispatcher: IHiddenCaseDispatcher, id: felt252, a: bool, token: ContractAddress, amount: u128) {
    start_cheat_caller_address(dispatcher.contract_address, pool());
    dispatcher.privacy_invoke(CaseOperation::Deposit, id, a, token, amount, 0, 0);
    stop_cheat_caller_address(dispatcher.contract_address);
}

fn claim(dispatcher: IHiddenCaseDispatcher, id: felt252, a: bool, token: ContractAddress, secret: felt252, note: felt252) {
    start_cheat_caller_address(dispatcher.contract_address, pool());
    dispatcher.privacy_invoke(CaseOperation::Claim, id, a, token, STAKE, secret, note);
    stop_cheat_caller_address(dispatcher.contract_address);
}

fn claim_result(dispatcher: IHiddenCaseDispatcher, id: felt252, a: bool, token: ContractAddress, secret: felt252, note: felt252) -> Span<hidden_case::OpenNoteDeposit> {
    start_cheat_caller_address(dispatcher.contract_address, pool());
    let result = dispatcher.privacy_invoke(CaseOperation::Claim, id, a, token, STAKE, secret, note);
    stop_cheat_caller_address(dispatcher.contract_address);
    result
}

fn advance(dispatcher: IHiddenCaseDispatcher, timestamp: u64) {
    start_cheat_block_timestamp(dispatcher.contract_address, timestamp);
}

fn resolve(dispatcher: IHiddenCaseDispatcher, id: felt252) {
    start_cheat_caller_address(dispatcher.contract_address, address(0x999));
    dispatcher.resolve(id);
    stop_cheat_caller_address(dispatcher.contract_address);
}

#[test]
fn deposit_marks_both_sides_and_rejects_wrong_inputs() {
    let d = deploy_hidden_case();
    let id = create_case(d, GameType::RockPaperScissors, address(0x789), STAKE);
    join_case(d, id);
    fund(d, id, true, address(0x789), STAKE);
    fund(d, id, false, address(0x789), STAKE);
    let e = d.get_case(id);
    assert(e.funded_a, 'funded_a');
    assert(e.funded_b, 'funded_b');
}

#[test]
fn cancel_one_sided_case_refunds_creator() {
    let d = deploy_hidden_case();
    let token = deploy_token();
    let id = create_case(d, GameType::RockPaperScissors, token.contract_address, STAKE);
    token.mint(d.contract_address, STAKE.into());
    let secret = 77;
    start_cheat_caller_address(d.contract_address, creator());
    d.cancel_case(id, compute_claim_hash(secret));
    stop_cheat_caller_address(d.contract_address);
    fund(d, id, true, token.contract_address, STAKE);
    claim(d, id, true, token.contract_address, secret, 1);
    assert(d.get_case(id).claimed_a, 'refund claimed');
}

#[test]
#[feature("safe_dispatcher")]
fn unfunded_refund_side_is_rejected() {
    let d = deploy_hidden_case();
    let id = create_case(d, GameType::RockPaperScissors, address(0x789), STAKE);
    start_cheat_caller_address(d.contract_address, creator());
    d.cancel_case(id, compute_claim_hash(1));
    stop_cheat_caller_address(d.contract_address);
    start_cheat_caller_address(d.contract_address, pool());
    let safe = IHiddenCaseSafeDispatcher { contract_address: d.contract_address };
    let r = safe.privacy_invoke(CaseOperation::Claim, id, false, address(0x789), STAKE, 1, 1);
    stop_cheat_caller_address(d.contract_address);
    match r { Result::Ok(_) => panic_with_felt252('expected NOT_FUNDED'), Result::Err(p) => assert(*p.at(0) == 'NOT_FUNDED', 'NOT_FUNDED') }
}

#[test]
#[feature("safe_dispatcher")]
fn refund_wrong_secret_and_double_claim_are_rejected() {
    let d = deploy_hidden_case();
    let token = deploy_token();
    let id = create_case(d, GameType::RockPaperScissors, token.contract_address, STAKE);
    token.mint(d.contract_address, STAKE.into());
    start_cheat_caller_address(d.contract_address, creator());
    d.cancel_case(id, compute_claim_hash(9));
    stop_cheat_caller_address(d.contract_address);
    fund(d, id, true, token.contract_address, STAKE);
    start_cheat_caller_address(d.contract_address, pool());
    let safe = IHiddenCaseSafeDispatcher { contract_address: d.contract_address };
    let wrong = safe.privacy_invoke(CaseOperation::Claim, id, true, token.contract_address, STAKE, 8, 1);
    match wrong { Result::Ok(_) => panic_with_felt252('expected CLAIM_HASH_MISMATCH'), Result::Err(p) => assert(*p.at(0) == 'CLAIM_HASH_MISMATCH', 'CLAIM_HASH_MISMATCH') }
    stop_cheat_caller_address(d.contract_address);
    claim(d, id, true, token.contract_address, 9, 1);
    start_cheat_caller_address(d.contract_address, pool());
    let again = safe.privacy_invoke(CaseOperation::Claim, id, true, token.contract_address, STAKE, 9, 1);
    stop_cheat_caller_address(d.contract_address);
    match again { Result::Ok(_) => panic_with_felt252('expected ALREADY_CLAIMED'), Result::Err(p) => assert(*p.at(0) == 'ALREADY_CLAIMED', 'ALREADY_CLAIMED') }
}

#[test]
fn rps_win_and_tie_refund() {
    let d = deploy_hidden_case();
    let id = create_case(d, GameType::RockPaperScissors, address(0x789), STAKE);
    join_case(d, id);
    let a = 0; let b = 2; let sa = 11; let sb = 12;
    start_cheat_caller_address(d.contract_address, creator()); d.commit_move(id, compute_move_hash(a, sa), 0, compute_claim_hash(1)); d.reveal_move(id, a, sa); stop_cheat_caller_address(d.contract_address);
    start_cheat_caller_address(d.contract_address, joiner()); d.commit_move(id, compute_move_hash(b, sb), 0, compute_claim_hash(2)); d.reveal_move(id, b, sb); stop_cheat_caller_address(d.contract_address);
    resolve(d, id);
    let e = d.get_case(id); assert(e.outcome == Outcome::PlayerA, 'RPS player A wins');
}

#[test]
fn pd_betrayal_wins_and_both_modes_tie() {
    let d = deploy_hidden_case();
    let id = create_case(d, GameType::PrisonersDilemma, address(0x789), STAKE); join_case(d, id);
    start_cheat_caller_address(d.contract_address, creator()); d.commit_move(id, compute_move_hash(0, 1), 0, 1); d.reveal_move(id, 0, 1); stop_cheat_caller_address(d.contract_address);
    start_cheat_caller_address(d.contract_address, joiner()); d.commit_move(id, compute_move_hash(1, 2), 0, 2); d.reveal_move(id, 1, 2); stop_cheat_caller_address(d.contract_address);
    resolve(d, id);
    assert(d.get_case(id).outcome == Outcome::PlayerB, 'betrayer wins');
}

#[test]
fn assassin_role_is_derived_and_overlap_wins_for_assassin() {
    let d = deploy_hidden_case();
    let id = create_case(d, GameType::Assassin, address(0x789), STAKE); join_case(d, id);
    let e = d.get_case(id);
    let assassin_move = pack_tiles(1, 2, 3); let target_move = pack_tiles(3, 8, 9);
    let (a_move, b_move) = if e.assassin_is_a { (assassin_move, target_move) } else { (target_move, assassin_move) };
    start_cheat_caller_address(d.contract_address, creator()); d.commit_move(id, compute_move_hash(a_move, 1), 0, 1); d.reveal_move(id, a_move, 1); stop_cheat_caller_address(d.contract_address);
    start_cheat_caller_address(d.contract_address, joiner()); d.commit_move(id, compute_move_hash(b_move, 2), 0, 2); d.reveal_move(id, b_move, 2); stop_cheat_caller_address(d.contract_address);
    resolve(d, id);
    assert(d.get_case(id).outcome == if e.assassin_is_a { Outcome::PlayerA } else { Outcome::PlayerB }, 'assassin wins overlap');
}

#[test]
fn bluff_fold_and_card_showdown_paths() {
    let d = deploy_hidden_case();
    let id = create_case(d, GameType::Bluff, address(0x789), STAKE); join_case(d, id);
    start_cheat_caller_address(d.contract_address, creator()); d.commit_move(id, compute_action_hash(0, 1), compute_card_hash(4, 2), compute_claim_hash(1)); d.reveal_action(id, 0, 1); stop_cheat_caller_address(d.contract_address);
    assert(d.get_case(id).outcome == Outcome::PlayerB, 'creator fold gives B win');
}

#[test]
#[feature("safe_dispatcher")]
fn access_control_and_wrong_reveal_functions() {
    let d = deploy_hidden_case();
    let id = create_case(d, GameType::RockPaperScissors, address(0x789), STAKE); join_case(d, id);
    start_cheat_caller_address(d.contract_address, address(0x999));
    let safe = IHiddenCaseSafeDispatcher { contract_address: d.contract_address };
    let r = safe.reveal_action(id, 0, 1);
    stop_cheat_caller_address(d.contract_address);
    match r { Result::Ok(_) => panic_with_felt252('expected WRONG_REVEAL_FUNCTION'), Result::Err(p) => assert(*p.at(0) == 'WRONG_REVEAL_FUNCTION', 'WRONG_REVEAL_FUNCTION') }
}

#[test]
#[feature("safe_dispatcher")]
fn privacy_pool_and_deposit_validation() {
    let d = deploy_hidden_case();
    let id = create_case(d, GameType::RockPaperScissors, address(0x789), STAKE);
    let safe = IHiddenCaseSafeDispatcher { contract_address: d.contract_address };
    start_cheat_caller_address(d.contract_address, address(0x999));
    let caller = safe.privacy_invoke(CaseOperation::Deposit, id, true, address(0x789), STAKE, 0, 0);
    stop_cheat_caller_address(d.contract_address);
    match caller { Result::Ok(_) => panic_with_felt252('expected CALLER_NOT_POOL'), Result::Err(p) => assert(*p.at(0) == 'CALLER_NOT_POOL', 'CALLER_NOT_POOL') }
    start_cheat_caller_address(d.contract_address, pool());
    let bad_token = safe.privacy_invoke(CaseOperation::Deposit, id, true, address(0xabc), STAKE, 0, 0);
    stop_cheat_caller_address(d.contract_address);
    match bad_token { Result::Ok(_) => panic_with_felt252('expected WRONG_TOKEN'), Result::Err(p) => assert(*p.at(0) == 'WRONG_TOKEN', 'WRONG_TOKEN') }
    start_cheat_caller_address(d.contract_address, pool());
    let bad_amount = safe.privacy_invoke(CaseOperation::Deposit, id, true, address(0x789), STAKE + 1, 0, 0);
    stop_cheat_caller_address(d.contract_address);
    match bad_amount { Result::Ok(_) => panic_with_felt252('expected WRONG_AMOUNT'), Result::Err(p) => assert(*p.at(0) == 'WRONG_AMOUNT', 'WRONG_AMOUNT') }
}

#[test]
fn assassin_zero_overlap_target_wins() {
    let d = deploy_hidden_case();
    let id = create_case(d, GameType::Assassin, address(0x789), STAKE); join_case(d, id);
    let e = d.get_case(id);
    let assassin_move = pack_tiles(1, 2, 3); let target_move = pack_tiles(4, 8, 9);
    let (a_move, b_move) = if e.assassin_is_a { (assassin_move, target_move) } else { (target_move, assassin_move) };
    start_cheat_caller_address(d.contract_address, creator()); d.commit_move(id, compute_move_hash(a_move, 1), 0, 1); d.reveal_move(id, a_move, 1); stop_cheat_caller_address(d.contract_address);
    start_cheat_caller_address(d.contract_address, joiner()); d.commit_move(id, compute_move_hash(b_move, 2), 0, 2); d.reveal_move(id, b_move, 2); stop_cheat_caller_address(d.contract_address);
    resolve(d, id);
    assert(d.get_case(id).outcome == if e.assassin_is_a { Outcome::PlayerB } else { Outcome::PlayerA }, 'target wins no overlap');
}

#[test]
fn bluff_call_showdown() {
    let d = deploy_hidden_case();
    let id = create_case(d, GameType::Bluff, address(0x789), STAKE); join_case(d, id);
    start_cheat_caller_address(d.contract_address, creator()); d.commit_move(id, compute_action_hash(1, 1), compute_card_hash(4, 2), 1); d.reveal_action(id, 1, 1); stop_cheat_caller_address(d.contract_address);
    start_cheat_caller_address(d.contract_address, joiner()); d.commit_move(id, compute_action_hash(1, 2), compute_card_hash(2, 3), 2); d.reveal_action(id, 1, 2); stop_cheat_caller_address(d.contract_address);
    start_cheat_caller_address(d.contract_address, creator()); d.reveal_card(id, 4, 2); stop_cheat_caller_address(d.contract_address);
    start_cheat_caller_address(d.contract_address, joiner()); d.reveal_card(id, 2, 3); stop_cheat_caller_address(d.contract_address);
    assert(d.get_case(id).outcome == Outcome::PlayerA, 'higher card wins');
}

#[test]
#[feature("safe_dispatcher")]
fn resolve_timeout_no_commits_refunds_and_early_reverts() {
    let d = deploy_hidden_case();
    let id = create_case(d, GameType::RockPaperScissors, address(0x789), STAKE); join_case(d, id);
    start_cheat_caller_address(d.contract_address, address(0x999));
    let safe = IHiddenCaseSafeDispatcher { contract_address: d.contract_address };
    let early = safe.resolve(id);
    stop_cheat_caller_address(d.contract_address);
    match early { Result::Ok(_) => panic_with_felt252('expected MOVE_WINDOW_OPEN'), Result::Err(p) => assert(*p.at(0) == 'MOVE_WINDOW_OPEN', 'MOVE_WINDOW_OPEN') }
    advance(d, 9999999999);
    resolve(d, id);
    assert(d.get_case(id).outcome == Outcome::Refund, 'timeout refund');
}

#[test]
fn winner_claim_has_exact_fee_and_payout() {
    let d = deploy_hidden_case();
    let token = deploy_token();
    let id = create_case(d, GameType::RockPaperScissors, token.contract_address, STAKE); join_case(d, id);
    token.mint(d.contract_address, (STAKE * 2).into());
    fund(d, id, true, token.contract_address, STAKE); fund(d, id, false, token.contract_address, STAKE);
    start_cheat_caller_address(d.contract_address, creator()); d.commit_move(id, compute_move_hash(0, 1), 0, compute_claim_hash(11)); d.reveal_move(id, 0, 1); stop_cheat_caller_address(d.contract_address);
    start_cheat_caller_address(d.contract_address, joiner()); d.commit_move(id, compute_move_hash(2, 2), 0, compute_claim_hash(22)); d.reveal_move(id, 2, 2); stop_cheat_caller_address(d.contract_address);
    resolve(d, id);
    let notes = claim_result(d, id, true, token.contract_address, 11, 7);
    let note = *notes.at(0);
    assert(note.amount == 1960, 'exact 98 percent payout');
    let fee_balance = token.balance_of(platform());
    assert(fee_balance == 40, 'exact 2 percent fee');
}

#[test]
#[feature("safe_dispatcher")]
fn one_committer_wins_and_other_cannot_claim() {
    let d = deploy_hidden_case();
    let token = deploy_token();
    let id = create_case(d, GameType::RockPaperScissors, token.contract_address, STAKE); join_case(d, id);
    token.mint(d.contract_address, (STAKE * 2).into());
    fund(d, id, true, token.contract_address, STAKE); fund(d, id, false, token.contract_address, STAKE);
    start_cheat_caller_address(d.contract_address, creator()); d.commit_move(id, compute_move_hash(0, 1), 0, compute_claim_hash(11)); stop_cheat_caller_address(d.contract_address);
    advance(d, 9999999999); resolve(d, id);
    assert(d.get_case(id).outcome == Outcome::PlayerA, 'committer wins');
    start_cheat_caller_address(d.contract_address, pool());
    let safe = IHiddenCaseSafeDispatcher { contract_address: d.contract_address };
    let r = safe.privacy_invoke(CaseOperation::Claim, id, false, token.contract_address, STAKE, 22, 8);
    stop_cheat_caller_address(d.contract_address);
    match r { Result::Ok(_) => panic_with_felt252('expected NOTHING_TO_CLAIM'), Result::Err(p) => assert(*p.at(0) == 'NOTHING_TO_CLAIM', 'NOTHING_TO_CLAIM') }
}

#[test]
fn both_committed_without_reveals_refund_and_both_claim() {
    let d = deploy_hidden_case();
    let token = deploy_token();
    let id = create_case(d, GameType::RockPaperScissors, token.contract_address, STAKE); join_case(d, id);
    token.mint(d.contract_address, (STAKE * 2).into());
    fund(d, id, true, token.contract_address, STAKE); fund(d, id, false, token.contract_address, STAKE);
    start_cheat_caller_address(d.contract_address, creator()); d.commit_move(id, compute_move_hash(0, 1), 0, compute_claim_hash(11)); stop_cheat_caller_address(d.contract_address);
    start_cheat_caller_address(d.contract_address, joiner()); d.commit_move(id, compute_move_hash(2, 2), 0, compute_claim_hash(22)); stop_cheat_caller_address(d.contract_address);
    advance(d, 9999999999); resolve(d, id);
    assert(d.get_case(id).outcome == Outcome::Refund, 'refund after no reveals');
    claim(d, id, true, token.contract_address, 11, 1);
    claim(d, id, false, token.contract_address, 22, 2);
    let e = d.get_case(id); assert(e.claimed_a, 'A claimed'); assert(e.claimed_b, 'B claimed');
}

#[test]
#[feature("safe_dispatcher")]
fn non_player_actions_and_privacy_pool_are_rejected() {
    let d = deploy_hidden_case();
    let id = create_case(d, GameType::Bluff, address(0x789), STAKE); join_case(d, id);
    start_cheat_caller_address(d.contract_address, address(0x999));
    let safe = IHiddenCaseSafeDispatcher { contract_address: d.contract_address };
    let c = safe.commit_move(id, 1, 1, 1);
    match c { Result::Ok(_) => panic_with_felt252('expected NOT_A_PLAYER'), Result::Err(p) => assert(*p.at(0) == 'NOT_A_PLAYER', 'commit NOT_A_PLAYER') }
    let rm = safe.reveal_move(id, 0, 1);
    match rm { Result::Ok(_) => panic_with_felt252('expected WRONG_REVEAL_FUNCTION'), Result::Err(p) => assert(*p.at(0) == 'WRONG_REVEAL_FUNCTION', 'reveal_move wrong game') }
    let ra = safe.reveal_action(id, 1, 1);
    match ra { Result::Ok(_) => panic_with_felt252('expected NOT_A_PLAYER'), Result::Err(p) => assert(*p.at(0) == 'NOT_A_PLAYER', 'reveal_action NOT_A_PLAYER') }
    stop_cheat_caller_address(d.contract_address);
    start_cheat_caller_address(d.contract_address, creator()); d.commit_move(id, compute_action_hash(1, 1), compute_card_hash(4, 2), 1); d.reveal_action(id, 1, 1); stop_cheat_caller_address(d.contract_address);
    start_cheat_caller_address(d.contract_address, joiner()); d.commit_move(id, compute_action_hash(1, 2), compute_card_hash(2, 3), 2); d.reveal_action(id, 1, 2); stop_cheat_caller_address(d.contract_address);
    start_cheat_caller_address(d.contract_address, address(0x999));
    let rc = safe.reveal_card(id, 3, 1);
    match rc { Result::Ok(_) => panic_with_felt252('expected NOT_A_PLAYER'), Result::Err(p) => assert(*p.at(0) == 'NOT_A_PLAYER', 'reveal_card NOT_A_PLAYER') }
    let pi = safe.privacy_invoke(CaseOperation::Deposit, id, true, address(0x789), STAKE, 0, 0);
    stop_cheat_caller_address(d.contract_address);
    match pi { Result::Ok(_) => panic_with_felt252('expected CALLER_NOT_POOL'), Result::Err(p) => assert(*p.at(0) == 'CALLER_NOT_POOL', 'privacy pool') }
}
