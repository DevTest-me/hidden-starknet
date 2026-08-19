import { connect } from "get-starknet";
import { WalletAccountV6, RpcProvider, hash, shortString } from "starknet";

// Main workflow (create/join/commit/reveal/resolve) is wired to the real
// deployed Sepolia contract. privacy_invoke (Deposit/Claim) is still a
// stub, that needs the live STRK20 pool. See the MAINNET POOL comments.
//
// DEBUG=true logs every chain interaction to the console with a
// [HIDDEN] prefix, open devtools before testing anything. Flip to
// false once things are working reliably and the noise isn't needed.
const DEBUG = true;
function log(...args){ if(DEBUG) console.log('[HIDDEN]', ...args); }
function logError(...args){ if(DEBUG) console.error('[HIDDEN]', ...args); }

const ICON_SVGS = {
  rock: `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 3 L18 7 L20 14 L15 20 L9 20 L4 14 L6 7 Z"/></svg>`,
  paper: `<svg viewBox="0 0 24 24"><polygon fill="currentColor" points="5,3 16,3 19,6 19,21 5,21"/></svg>`,
  scissors: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><circle cx="6" cy="7" r="2.6"/><circle cx="6" cy="17" r="2.6"/><line x1="8" y1="8.4" x2="20" y2="19"/><line x1="8" y1="15.6" x2="20" y2="5"/></svg>`,
  handshake: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12 L9 12 L11 8.5 L13 15.5 L15 8.5 L17 12 L22 12"/></svg>`,
  dagger: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 L13.4 14 L12 16.2 L10.6 14 Z"/><rect x="10.3" y="16.2" width="3.4" height="2"/><rect x="11" y="18.2" width="2" height="4" rx="1"/></svg>`,
  spade: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3 C17 8 20 11 20 15 C20 18.5 17 20.5 14 19.5 L15 22 L9 22 L10 19.5 C7 20.5 4 18.5 4 15 C4 11 7 8 12 3 Z"/></svg>`,
  crosshair: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8"><circle cx="12" cy="12" r="7"/><line x1="12" y1="1" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="1" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="23" y2="12"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>`,
};
function iconSpan(name, size){ return `<span class="ic" style="width:${size}px;height:${size}px;">${ICON_SVGS[name]}</span>`; }

const GAMES = {
  rps:      { name:'Rock / Paper / Scissors', short:'RPS',      icon:'rock',      engine:'simul' },
  pd:       { name:'Prisoner\u2019s Dilemma',  short:'TRUST',    icon:'handshake', engine:'simul' },
  bluff:    { name:'Bluff',                    short:'BLUFF',    icon:'spade',     engine:'bluff' },
  assassin: { name:'Assassin vs Target',       short:'ASSASSIN', icon:'crosshair', engine:'assassin' },
};

const SIMUL_CONFIG = {
  rps: {
    options: [
      {id:'rock', icon:'rock', label:'ROCK'},
      {id:'paper', icon:'paper', label:'PAPER'},
      {id:'scissors', icon:'scissors', label:'SCISSORS'},
    ],
    cols:3,
    chooseCopy:'Choose \u2014 this gets hashed with a random salt before it ever touches the chain.',
    lockCopy:'Locking submits only a commitment hash. Nobody \u2014 not your opponent, not the pool \u2014 can see the move underneath until reveal.',
  },
  pd: {
    options: [
      {id:'trust', icon:'handshake', label:'TRUST', sub:'cooperate'},
      {id:'betray', icon:'dagger', label:'BETRAY', sub:'defect'},
    ],
    cols:2,
    chooseCopy:'Neither of you will know the other\u2019s choice until both are committed.',
    lockCopy:'Your choice is sealed as a commitment hash. Trust is a bet on someone you cannot currently see.',
  },
};

const RANKS = [2,3,4,5,6,7,8,9,10,'J','Q','K','A'];
function rankValue(r){ return typeof r==='number' ? r : {J:11,Q:12,K:13,A:14}[r]; }
function drawCard(){ return RANKS[Math.floor(Math.random()*RANKS.length)]; }

const NAME_ADJ = ['Hidden','Silent','Shadow','Masked','Quiet','Cloaked','Unseen','Veiled','Ghost','Sealed','Faceless','Muted'];
const NAME_NOUN = ['Cat','Fox','Wolf','Owl','Raven','Hawk','Lynx','Otter','Falcon','Panther','Crow','Viper'];
function generateUsername(){
  const a = NAME_ADJ[Math.floor(Math.random()*NAME_ADJ.length)];
  const n = NAME_NOUN[Math.floor(Math.random()*NAME_NOUN.length)];
  const num = Math.floor(Math.random()*90)+10;
  return `${a} ${n} ${num}`;
}

const SLUG_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function randomSlug(len=11){ let s=''; for(let i=0;i<len;i++) s+=SLUG_CHARS[Math.floor(Math.random()*SLUG_CHARS.length)]; return s; }
function caseLink(caseId){ return `${window.location.origin}/?case=${caseId}`; }

function formatCountdown(ms){
  if(ms<=0) return 'expired';
  const s = Math.floor(ms/1000);
  const d = Math.floor(s/86400), h=Math.floor((s%86400)/3600), m=Math.floor((s%3600)/60), sec=s%60;
  if(d>0) return `${d}d ${h}h`;
  if(h>0) return `${h}h ${m}m`;
  if(m>0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

const JOIN_PRESETS = [
  {label:'15 min', ms:15*60*1000},
  {label:'1 hour', ms:60*60*1000},
  {label:'6 hours', ms:6*60*60*1000},
  {label:'24 hours', ms:24*60*60*1000},
];
const MOVE_WINDOW_MS = 4*60*60*1000;
const CONTRACT_ADDRESS = '0x028ac1fac46e7334fe1bf40bb4011072366e52c8553d4b87c059faa5de3daf92';
const SEPOLIA_STRK_ADDRESS = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const SEPOLIA_RPC_URL = `https://starknet-sepolia.g.alchemy.com/starknet/version/rpc/v0_8/${import.meta.env.VITE_ALCHEMY_KEY}`;

// ---------------------------------------------------------------
// Chain wiring
// ---------------------------------------------------------------

const sepoliaRpc = new RpcProvider({ nodeUrl: SEPOLIA_RPC_URL });
const GAME_TYPE_INDEX = { rps:0, pd:1, bluff:2, assassin:3 };
const STRK_DECIMALS_FACTOR = 10n ** 18n;

const MOVE_TAG_FELT = shortString.encodeShortString('HIDDEN_MOVE_TAG:V1');
const CLAIM_TAG_FELT = shortString.encodeShortString('HIDDEN_CLAIM_TAG:V1');
const CASE_CREATED_SELECTOR = hash.getSelectorFromName('CaseCreated');

function packTiles(t1, t2, t3){ return BigInt(t1) + BigInt(t2)*16n + BigInt(t3)*256n; }
function packBluffAction(action, cardIndex){ return BigInt(action) + BigInt(cardIndex)*2n; }

function randomFelt(){
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  let hexStr = '0x';
  for(const b of bytes) hexStr += b.toString(16).padStart(2,'0');
  return BigInt(hexStr);
}

function computeMoveHash(moveValue, salt){
  return hash.computePoseidonHashOnElements([MOVE_TAG_FELT, BigInt(moveValue), salt]);
}
function computeClaimHash(secret){
  return hash.computePoseidonHashOnElements([CLAIM_TAG_FELT, secret]);
}

function toStakeFelt(stakeDecimal){
  const micro = BigInt(Math.round(stakeDecimal * 1e6));
  return micro * (STRK_DECIMALS_FACTOR / 1000000n);
}

function feltToBigInt(v){ return typeof v === 'bigint' ? v : BigInt(v); }
function feltToBool(v){ return feltToBigInt(v) !== 0n; }

async function sendInvoke(provider, calls){
  const request = walletApiRequest(provider);
  if(!request) throw new Error('wallet provider cannot send transactions');
  log('sendInvoke: sending', calls);
  const result = await request({ type:'wallet_addInvokeTransaction', params:{ calls } });
  log('sendInvoke: wallet responded', result);
  const txHash = result?.transaction_hash ?? result?.transactionHash ?? result;
  if(!txHash) throw new Error('wallet did not return a transaction hash, see console for the raw response');
  return txHash;
}

async function waitForReceipt(txHash){
  log('waitForReceipt: waiting on', txHash);
  for(let i=0;i<40;i++){
    try {
      const receipt = await sepoliaRpc.getTransactionReceipt(txHash);
      if(receipt){ log('waitForReceipt: confirmed', receipt); return receipt; }
    } catch(err) { /* not indexed yet, keep polling */ }
    await new Promise(r=>setTimeout(r, 3000));
  }
  throw new Error('timed out waiting for the transaction to confirm');
}

async function readCase(caseId){
  const raw = await sepoliaRpc.callContract({
    contractAddress: CONTRACT_ADDRESS,
    entrypoint: 'get_case',
    calldata: [String(caseId)],
  });
  const f = raw.map(feltToBigInt);
  let i = 0;
  const next = () => f[i++];
  const entry = {
    creator: next(), opponent: next(), gameType: Number(next()), token: next(),
    stakeAmount: next(), joinDeadline: Number(next()), moveDeadline: Number(next()),
    commitHashA: next(), commitHashB: next(), revealedMoveA: next(), revealedMoveB: next(),
    hasCommittedA: feltToBool(next()), hasCommittedB: feltToBool(next()),
    hasRevealedA: feltToBool(next()), hasRevealedB: feltToBool(next()),
    claimHashA: next(), claimHashB: next(),
    fundedA: feltToBool(next()), fundedB: feltToBool(next()),
    outcome: Number(next()), claimedA: feltToBool(next()), claimedB: feltToBool(next()),
    assassinIsA: feltToBool(next()),
  };
  log('readCase', caseId, entry);
  return entry;
}

async function submitCreateCase({ provider, gameKey, stakeDecimal, joinWindowSecs }){
  const calldata = [
    String(GAME_TYPE_INDEX[gameKey]),
    SEPOLIA_STRK_ADDRESS,
    toStakeFelt(stakeDecimal).toString(),
    String(joinWindowSecs),
  ];
  log('submitCreateCase: calldata', calldata);
  const txHash = await sendInvoke(provider, [{ contract_address: CONTRACT_ADDRESS, entry_point: 'create_case', calldata }]);
  const receipt = await waitForReceipt(txHash);
  const events = receipt.events || receipt.value?.events || [];
  log('submitCreateCase: receipt events', events);
  const created = events.find(e => (e.keys||[])[0] === CASE_CREATED_SELECTOR);
  if(!created) throw new Error('create_case confirmed but no CaseCreated event was found, check the contract address and see console for the receipt');
  const caseId = feltToBigInt(created.keys[1]);
  log('submitCreateCase: new case id', caseId);
  return { caseId, txHash };
  // MAINNET POOL: bundle privacy_invoke(Deposit, ...) in the same
  // multicall here once the pool is live. funded_a stays false without it.
}

async function submitJoinCase({ provider, caseId }){
  const txHash = await sendInvoke(provider, [{ contract_address: CONTRACT_ADDRESS, entry_point: 'join_case', calldata: [String(caseId)] }]);
  await waitForReceipt(txHash);
  return txHash;
  // MAINNET POOL: bundle the opponent's Deposit here too, once live.
}

async function submitCommitMove({ provider, caseId, moveValue, salt, claimSecret }){
  const commitHash = computeMoveHash(moveValue, salt);
  const claimHash = computeClaimHash(claimSecret);
  log('submitCommitMove', { caseId, moveValue, commitHash, claimHash });
  const txHash = await sendInvoke(provider, [{
    contract_address: CONTRACT_ADDRESS, entry_point: 'commit_move',
    calldata: [String(caseId), commitHash.toString(), claimHash.toString()],
  }]);
  await waitForReceipt(txHash);
  return { txHash, commitHash, claimHash };
}

async function submitRevealMove({ provider, caseId, moveValue, salt }){
  log('submitRevealMove', { caseId, moveValue });
  const txHash = await sendInvoke(provider, [{
    contract_address: CONTRACT_ADDRESS, entry_point: 'reveal_move',
    calldata: [String(caseId), String(moveValue), salt.toString()],
  }]);
  await waitForReceipt(txHash);
  return txHash;
}

async function submitResolve({ provider, caseId }){
  log('submitResolve', { caseId });
  const txHash = await sendInvoke(provider, [{ contract_address: CONTRACT_ADDRESS, entry_point: 'resolve', calldata: [String(caseId)] }]);
  await waitForReceipt(txHash);
  return txHash;
}

// MAINNET POOL, not built yet: goes through privacy_invoke(Claim, ...)
// on the pool side using the claimSecret from submitCommitMove.
async function submitClaim(){
  throw new Error('claiming requires the live STRK20 pool, not wired yet on Sepolia');
}

async function queryPublicStrkBalance(address){
  // Testnet-only stand-in, swap for a real STRK20 shielded balance query
  // before mainnet.
  const response = await sepoliaRpc.callContract({
    contractAddress: SEPOLIA_STRK_ADDRESS,
    entrypoint: 'balanceOf',
    calldata: [address],
  });
  log('queryPublicStrkBalance: raw response', response);
  // callContract's return shape varies by starknet.js version. This was
  // the actual balance bug last time: the old code assumed response was
  // always a plain array and read response[0] directly.
  const result = Array.isArray(response) ? response : (response?.result ?? []);
  const low = BigInt(result[0] ?? 0);
  const high = BigInt(result[1] ?? 0);
  const value = Number((high << 128n) + low) / 1e18;
  log('queryPublicStrkBalance: parsed value', value);
  return value;
}

// ---------------------------------------------------------------
// Shared open cases board, built from CaseCreated events. There's no
// real indexer here, this scans events directly from the RPC node,
// fine at hackathon scale, worth replacing with a proper indexer if
// case volume grows a lot before mainnet.
// ---------------------------------------------------------------

async function fetchOpenCases(gameKey){
  const gameIndex = GAME_TYPE_INDEX[gameKey];
  const now = Math.floor(Date.now()/1000);
  const open = [];
  const MAX_PROBE = 200; // safety cap, plenty above expected case volume
  for(let id = 1; id <= MAX_PROBE; id++){
    let entry;
    try { entry = await readCase(BigInt(id)); }
    catch(err){ log('fetchOpenCases: stopped probing at case', id, err); break; }
    if(entry.creator === 0n) break; // past the last real case, stop here
    if(entry.gameType === gameIndex && entry.opponent === 0n && entry.joinDeadline > now){
      open.push({ caseId: BigInt(id), stakeDecimal: Number(entry.stakeAmount)/1e18 });
    }
  }
  log('fetchOpenCases: open cases for', gameKey, open);
  return open;
}

// ---------------------------------------------------------------
// Round state and polling
// ---------------------------------------------------------------

let MY_ROUNDS = {};

function newRound({game, stake, role, joinMs, caseId}){
  const slug = randomSlug();
  const round = {
    slug, game, stake, role, caseId,
    stage: role==='creator' ? 'share' : 'matched',
    createdAt: Date.now(),
    joinDeadline: Date.now() + (joinMs||0),
    filledAt: role==='joiner' ? Date.now() : null,
    moveDeadline: role==='joiner' ? Date.now()+MOVE_WINDOW_MS : null,
    myMoved:false, oppMoved:false, myRevealed:false, oppRevealed:false,
    myMove:null, oppMove:null,
    myCard:null, oppCard:null, pot:stake*2, betLog:[], outcomeKind:null,
    myRole:null, myPicks:[], oppPicks:[],
    outcome:null, recorded:false,
    pendingReveal:null, claimSecret:null, pollTimer:null,
  };
  MY_ROUNDS[slug] = round;
  return round;
}

function startCasePolling(round){
  round.pollTimer = setInterval(async ()=>{
    if(round.stage==='expired' || round.stage==='result'){ clearInterval(round.pollTimer); return; }
    try {
      const entry = await readCase(round.caseId);
      await applyChainState(round, entry);
    } catch(err) { logError('case poll failed', err); }
  }, 4000);
}

function outcomeFromChain(entry, iAmA){
  if(entry.outcome === 1) return iAmA ? 'win' : 'lose';
  if(entry.outcome === 2) return iAmA ? 'lose' : 'win';
  return 'tie';
}

function applyRevealedMoves(round, entry){
  const iAmA = round.role==='creator';
  const oppValue = iAmA ? entry.revealedMoveB : entry.revealedMoveA;

  if(round.game==='rps' || round.game==='pd'){
    const opts = SIMUL_CONFIG[round.game].options;
    const idx = Number(oppValue);
    if(opts[idx]) round.oppMove = opts[idx].id;
  } else if(round.game==='assassin'){
    const v = Number(oppValue);
    round.oppPicks = [v % 16, Math.floor(v/16) % 16, Math.floor(v/256) % 16];
  } else if(round.game==='bluff'){
    const v = Number(oppValue);
    const action = v % 2;
    const cardIdx = Math.floor(v/2);
    round.oppCard = RANKS[cardIdx];
    if(round.role==='creator') round.outcomeKind = action===0 ? 'fold-opp' : null;
    else round.outcomeKind = action===0 ? 'creator-folded' : null;
  }
}

function finalizeFromChain(round, entry){
  if(round.recorded) return;
  applyRevealedMoves(round, entry);
  const iAmA = round.role==='creator';
  const outcome = outcomeFromChain(entry, iAmA);
  round.outcome = outcome;
  round.stage = 'result';
  round.recorded = true;
  const delta = outcome==='win' ? round.stake : outcome==='lose' ? -round.stake : 0;
  recordResult(round.game, round.stake, outcome, delta);
  if(round.pollTimer) clearInterval(round.pollTimer);
  log('finalizeFromChain', round.slug, outcome);
}

async function applyChainState(round, entry){
  let changed = false;
  const iAmA = round.role==='creator';

  if((round.stage==='share' || round.stage==='waiting') && entry.opponent !== 0n){
    round.stage = 'matched';
    round.moveDeadline = entry.moveDeadline*1000;
    changed = true;
    log('applyChainState: opponent joined', round.slug);
  }

  const oppCommitted = iAmA ? entry.hasCommittedB : entry.hasCommittedA;
  const oppRevealedNow = iAmA ? entry.hasRevealedB : entry.hasRevealedA;
  if(oppCommitted && !round.oppMoved){ round.oppMoved = true; changed = true; }
  if(oppRevealedNow && !round.oppRevealed){ round.oppRevealed = true; changed = true; }

  const bothCommitted = entry.hasCommittedA && entry.hasCommittedB;
  if(round.game!=='bluff' && bothCommitted && round.pendingReveal && !round.myRevealed){
    round.myRevealed = true;
    try {
      await submitRevealMove({ provider: account.provider, caseId: round.caseId, moveValue: round.pendingReveal.moveValue, salt: round.pendingReveal.salt });
    } catch(err){ logError('auto-reveal failed', err); round.myRevealed = false; }
    changed = true;
  }

  const bothRevealed = entry.hasRevealedA && entry.hasRevealedB;
  if(entry.outcome === 0 && bothRevealed){
    try { await submitResolve({ provider: account.provider, caseId: round.caseId }); }
    catch(err){ log('resolve call failed, will retry on next poll', err); }
  }

  if(entry.outcome !== 0){
    finalizeFromChain(round, entry);
    changed = true;
  }

  if(changed) touch(round.slug);
}

function resolveOnTimeout(round){
  if(round.recorded) return;
  if(round.myMoved && !round.oppMoved){
    round.outcome = 'win'; round.stage='result'; round.recorded=true;
    recordResult(round.game, round.stake, 'win', round.stake);
    round.timeoutNote = 'Opponent never moved \u2014 pot forfeited to you.';
  } else if(round.oppMoved && !round.myMoved){
    round.outcome = 'lose'; round.stage='result'; round.recorded=true;
    recordResult(round.game, round.stake, 'lose', -round.stake);
    round.timeoutNote = 'You didn\u2019t move in time \u2014 pot forfeited to your opponent.';
  } else if(!round.myMoved && !round.oppMoved){
    round.outcome = 'tie'; round.stage='result'; round.recorded=true;
    recordResult(round.game, round.stake, 'tie', 0);
    round.timeoutNote = 'Neither side moved in time \u2014 no-fault refund, stakes returned.';
  }
}

function expireRound(round){ round.stage = 'expired'; }

setInterval(()=>{
  let needsRender = false;
  Object.values(MY_ROUNDS).forEach(round=>{
    if(round.stage==='waiting' && Date.now()>=round.joinDeadline){
      expireRound(round);
      if(state.activeSlug===round.slug) needsRender = true;
    } else if(round.stage==='matched' && round.moveDeadline && Date.now()>=round.moveDeadline){
      resolveOnTimeout(round);
      if(state.activeSlug===round.slug) needsRender = true;
    }
  });
  if(needsRender) render();
  updateLiveCountdowns();
  updateMyCasesBadge();
}, 1000);

function updateLiveCountdowns(){
  const jc = document.getElementById('joinCountdown');
  const mc = document.getElementById('moveCountdown');
  if(jc){ const r = MY_ROUNDS[state.activeSlug]; if(r) jc.textContent = formatCountdown(r.joinDeadline-Date.now()); }
  if(mc){ const r = MY_ROUNDS[state.activeSlug]; if(r && r.moveDeadline) mc.textContent = formatCountdown(r.moveDeadline-Date.now()); }
  document.querySelectorAll('[data-cd]').forEach(elx=>{
    const round = MY_ROUNDS[elx.dataset.cd];
    if(!round) return;
    const deadline = round.stage==='waiting' ? round.joinDeadline : round.moveDeadline;
    if(deadline) elx.textContent = formatCountdown(deadline-Date.now());
  });
}

function needsMyAttention(round){ return round.stage==='matched' && round.oppMoved && !round.myMoved; }
function updateMyCasesBadge(){
  const n = Object.values(MY_ROUNDS).filter(needsMyAttention).length;
  const badge = document.getElementById('myCasesBadge');
  if(!badge) return;
  if(n>0){ badge.style.display='flex'; badge.textContent = n; } else { badge.style.display='none'; }
}

function touch(slug){ if(state.activeSlug===slug) render(); updateMyCasesBadge(); if(document.getElementById('myCasesOverlay').classList.contains('open')) openMyCases(); }

let account = null;

let state = {
  game:'rps',
  view:'board',
  activeSlug:null,
  draft:{ stake:1, joinMs:JOIN_PRESETS[1].ms, customOn:false, customVal:1, customUnit:'hours' },
};

function goToBoard(sameGame){
  state.game = sameGame || state.game;
  state.view = 'board';
  state.activeSlug = null;
  render();
}
function goToCreate(){
  state.view='lobby';
  state.activeSlug=null;
  state.draft = { stake:1, joinMs:JOIN_PRESETS[1].ms, customOn:false, customVal:1, customUnit:'hours' };
  render();
}
function openRound(slug){ state.activeSlug = slug; state.game = MY_ROUNDS[slug].game; closeMyCases(); render(); }

function detectWallets() {
  const wallets = [];
  if (window.starknet_argentX) wallets.push({ id: 'argentX', name: 'Ready X', provider: window.starknet_argentX });
  if (window.starknet_braavos) wallets.push({ id: 'braavos', name: 'Braavos', provider: window.starknet_braavos });
  if (window.starknet_xverse) wallets.push({ id: 'xverse', name: 'Xverse', provider: window.starknet_xverse });
  if (wallets.length === 0 && window.starknet) wallets.push({ id: 'starknet', name: window.starknet.name || 'Starknet Wallet', provider: window.starknet });
  log('detectWallets', wallets.map(w=>w.name));
  return wallets;
}

function walletApiRequest(provider) {
  const walletApi = provider?.features?.['starknet:walletApi'];
  if (walletApi && typeof walletApi.request === 'function') return walletApi.request.bind(walletApi);
  if (provider && typeof provider.request === 'function') return provider.request.bind(provider);
  return null;
}

function isNotRegisteredError(err) {
  const code = err?.code ?? err?.error?.code;
  const message = String(err?.message ?? err?.error?.message ?? err ?? '').toUpperCase();
  return code === 'NOT_REGISTERED' || message.includes('NOT_REGISTERED') || message.includes('NOT REGISTERED');
}

async function supportsStrk20(provider) {
  if (typeof provider?.strk20Balances === 'function') {
    try {
      const res = await provider.strk20Balances([]);
      log('supportsStrk20: direct strk20Balances() succeeded', res);
      return true;
    } catch (err) {
      log('supportsStrk20: direct strk20Balances() threw, checking if it means NOT_REGISTERED', err);
      return isNotRegisteredError(err);
    }
  }

  const request = walletApiRequest(provider);
  if (!request) {
    log('supportsStrk20: no request() function found on this provider at all, see window.starknet_argentX in the console to check what it actually exposes');
    return false;
  }

  try {
    const res = await request({ type: 'wallet_strk20Balances', params: { tokens: [] } });
    log('supportsStrk20: wallet_strk20Balances succeeded', res);
    return true;
  } catch (err) {
    const registered = isNotRegisteredError(err);
    log('supportsStrk20: wallet_strk20Balances threw', { code: err?.code, message: err?.message, raw: err }, 'treating as supported?', registered);
    if (!registered) {
      log('supportsStrk20: this error was not recognized as NOT_REGISTERED. If Ready X genuinely does support STRK20, the method name or params shape here may not match this wallet version. Run window.starknet_argentX in the console and compare its real methods against what this function assumes.');
    }
    return registered;
  }
}

async function connectAccount(){
  const wallets = detectWallets();
  if(wallets.length === 0){
    alert('no starknet wallet found, install Ready X or Xverse');
    return null;
  }
  const provider = wallets[0].provider;
  log('connectAccount: using', wallets[0].name);
  try {
    const accounts = await Promise.race([
      provider.request({ type: 'wallet_requestAccounts' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('wallet did not respond within 15s, its approval popup may not have opened')), 15000)),
    ]);
    log('connectAccount: accounts', accounts);
    const address = Array.isArray(accounts) ? accounts[0] : accounts;
    if(!address) return null;

    const supported = await supportsStrk20(provider);
    log('connectAccount: supportsStrk20 result', supported);
    if(!supported){
     // not blocking on this yet, staking isn't wired up regardless of what
     // this check says. revisit once privacy_invoke is actually used
     log('connectAccount: STRK20 check failed, proceeding anyway since staking is stubbed');
    }

    let publicBalance = null;
    try { publicBalance = await queryPublicStrkBalance(address); }
    catch (balanceErr) { logError('could not read public Sepolia STRK balance', balanceErr); }
    log('connectAccount: connected', { address, publicBalance });
    return { address, provider, publicBalance };
  } catch (err) {
    logError('connectAccount failed', err);
    alert('could not connect, make sure your wallet is unlocked and try again');
    return null;
  }
}

let PROFILE = {
  username: generateUsername(),
  balance: 0,
  gamesPlayed:0, wins:0, losses:0, ties:0,
  totalStaked:0, totalWon:0,
  currentStreak:0, bestStreak:0,
  gameCounts:{ rps:0, pd:0, bluff:0, assassin:0 },
};

function saveProfile(){ if(account) localStorage.setItem(`hidden_profile_${account.address}`, JSON.stringify(PROFILE)); }
function loadProfile(){
  const raw = localStorage.getItem(`hidden_profile_${account.address}`);
  if(raw) PROFILE = JSON.parse(raw);
  else PROFILE.username = generateUsername();
  if(account.publicBalance != null) PROFILE.balance = account.publicBalance;
}

function profileTitle(){
  if(PROFILE.gamesPlayed < 3) return 'Newcomer';
  const winRate = PROFILE.wins / PROFILE.gamesPlayed;
  const fav = Object.entries(PROFILE.gameCounts).sort((a,b)=>b[1]-a[1])[0][0];
  if(winRate >= 0.65) return fav==='bluff' ? 'The Bluffer' : fav==='assassin' ? 'The Menace' : fav==='pd' ? 'The Betrayer' : 'Mind Reader';
  if(winRate <= 0.35) return 'Still Learning';
  return 'Steady Hand';
}

function recordResult(gameKey, stake, label, deltaStrk){
  PROFILE.gamesPlayed++;
  PROFILE.gameCounts[gameKey] = (PROFILE.gameCounts[gameKey]||0)+1;
  PROFILE.totalStaked += stake;
  PROFILE.balance += deltaStrk;
  if(deltaStrk > 0) PROFILE.totalWon += deltaStrk;
  if(label==='win'){ PROFILE.wins++; PROFILE.currentStreak = PROFILE.currentStreak>0?PROFILE.currentStreak+1:1; }
  else if(label==='lose'){ PROFILE.losses++; PROFILE.currentStreak = PROFILE.currentStreak<0?PROFILE.currentStreak-1:-1; }
  else { PROFILE.ties++; PROFILE.currentStreak = 0; }
  if(Math.abs(PROFILE.currentStreak) > Math.abs(PROFILE.bestStreak)) PROFILE.bestStreak = PROFILE.currentStreak;
  saveProfile();
}

function renderSideProfile(){
  const el = document.getElementById('sideProfile');
  if(!el) return;
  if(!account){
    el.innerHTML = `
      <div class="profile-card torn">
        <div class="panel-hint">connect your wallet to see your profile</div>
        <button class="btn3 wide" id="sideConnectBtn" style="margin-top:12px;">Connect wallet</button>
      </div>
    `;
    document.getElementById('sideConnectBtn').onclick = async ()=>{ account = await connectAccount(); if(account) loadProfile(); render(); };
    return;
  }
  const winRate = PROFILE.gamesPlayed ? Math.round((PROFILE.wins/PROFILE.gamesPlayed)*100) : 0;
  el.innerHTML = `
    <div class="profile-card torn" id="sideProfileCard">
      <div class="p-name">${PROFILE.username}</div>
      <div class="p-title">${profileTitle()}</div>
      <div class="p-balance">${PROFILE.balance.toFixed(2)}<span class="p-balance-unit">STRK</span></div>
      <div class="p-stats">
        <div><div class="p-stat-val">${PROFILE.gamesPlayed}</div><div class="p-stat-lbl">Played</div></div>
        <div><div class="p-stat-val">${winRate}%</div><div class="p-stat-lbl">Win rate</div></div>
        <div><div class="p-stat-val">${PROFILE.totalWon.toFixed(1)}</div><div class="p-stat-lbl">Total won</div></div>
        <div><div class="p-stat-val">${PROFILE.currentStreak}</div><div class="p-stat-lbl">Streak</div></div>
        <div><div class="p-stat-val">${PROFILE.totalStaked.toFixed(1)}</div><div class="p-stat-lbl">Staked</div></div>
        <div><div class="p-stat-val">${PROFILE.bestStreak}</div><div class="p-stat-lbl">Best streak</div></div>
      </div>
      <button class="btn3 wide small" id="viewProfileBtn" style="margin-top:12px;">View profile</button>
    </div>
  `;
  document.getElementById('viewProfileBtn').onclick = openProfile;
}

function openProfile(){
  const overlay = document.getElementById('profileOverlay');
  if(!account){
    overlay.innerHTML = `
      <div class="panel torn profile-full">
        <button class="close-x" id="closeProfileBtn">CLOSE &times;</button>
        <div class="panel-hint">connect your wallet to see your profile</div>
        <button class="btn3 wide" id="fullConnectBtn" style="margin-top:12px;">Connect wallet</button>
      </div>
    `;
    document.getElementById('closeProfileBtn').onclick = closeProfile;
    document.getElementById('fullConnectBtn').onclick = async ()=>{ account = await connectAccount(); if(account) loadProfile(); openProfile(); };
    overlay.classList.add('open');
    return;
  }
  const winRate = PROFILE.gamesPlayed ? Math.round((PROFILE.wins/PROFILE.gamesPlayed)*100) : 0;
  const favEntry = Object.entries(PROFILE.gameCounts).sort((a,b)=>b[1]-a[1])[0];
  const favName = favEntry && favEntry[1]>0 ? GAMES[favEntry[0]].name : '\u2014';
  const shareText = PROFILE.gamesPlayed ? `${PROFILE.wins}-${PROFILE.losses}-${PROFILE.ties} on HIDDEN \u00b7 ${winRate}% win rate \u00b7 ${profileTitle()}` : 'Just getting started on HIDDEN';

  overlay.innerHTML = `
    <div class="panel torn profile-full">
      <button class="close-x" id="closeProfileBtn">CLOSE &times;</button>
      <div class="p-name" style="font-size:24px;">${PROFILE.username}</div>
      <div class="p-title">${profileTitle()}</div>
      <div class="p-balance" style="font-size:38px;">${PROFILE.balance.toFixed(2)}<span class="p-balance-unit">STRK shielded balance</span></div>
      <div class="p-stats-full">
        <div><div class="stat-val">${PROFILE.gamesPlayed}</div><div class="stat-lbl">Games played</div></div>
        <div><div class="stat-val">${winRate}%</div><div class="stat-lbl">Win rate</div></div>
        <div><div class="stat-val">${PROFILE.wins}-${PROFILE.losses}-${PROFILE.ties}</div><div class="stat-lbl">W-L-T</div></div>
        <div><div class="stat-val">${PROFILE.bestStreak}</div><div class="stat-lbl">Best streak</div></div>
        <div><div class="stat-val">${PROFILE.totalStaked.toFixed(2)}</div><div class="stat-lbl">Total staked</div></div>
        <div><div class="stat-val">${PROFILE.totalWon.toFixed(2)}</div><div class="stat-lbl">Total won</div></div>
        <div><div class="stat-val" style="font-size:15px;">${favName}</div><div class="stat-lbl">Favorite game</div></div>
      </div>
      <div class="game-breakdown">
        ${Object.entries(PROFILE.gameCounts).map(([k,v])=>`<div class="game-breakdown-row"><span>${GAMES[k].name}</span><span>${v}</span></div>`).join('')}
      </div>
      <div class="panel-hint">Only visible to you \u2014 nothing here is derived from a public leaderboard or tied to your wallet address on-chain.</div>
      <button class="btn3 wide" id="shareProfileBtn" style="margin-top:14px;">Share stats</button>
    </div>
  `;
  document.getElementById('closeProfileBtn').onclick = closeProfile;
  document.getElementById('shareProfileBtn').onclick = async (e)=>{
    if(navigator.share){ try{ await navigator.share({ text: shareText, title:'HIDDEN' }); return; }catch(err){} }
    navigator.clipboard?.writeText(shareText).catch(()=>{});
    e.target.textContent = 'Copied to clipboard';
    setTimeout(()=>{ e.target.textContent = 'Share stats'; }, 1600);
  };
  overlay.classList.add('open');
}
function closeProfile(){ document.getElementById('profileOverlay').classList.remove('open'); }

function caseRowStatus(round){
  if(round.stage==='share' || round.stage==='waiting') return { text:`Waiting for opponent \u2014 ${formatCountdown(round.joinDeadline-Date.now())} left`, urgent:false };
  if(round.stage==='matched'){
    if(round.oppMoved && !round.myMoved) return { text:`Opponent moved \u2014 you have ${formatCountdown(round.moveDeadline-Date.now())} to move`, urgent:true };
    if(round.myMoved && !round.oppMoved) return { text:`You moved \u2014 waiting on opponent (${formatCountdown(round.moveDeadline-Date.now())} left)`, urgent:false };
    return { text:`Opponent connected \u2014 make your move (${formatCountdown(round.moveDeadline-Date.now())} left)`, urgent:false };
  }
  if(['choose','locked','dealt','pending-call','showdown','picking','resolving'].includes(round.stage)) return { text:'In progress \u2014 resume to continue', urgent:false };
  if(round.stage==='result') return { text: round.outcome==='win' ? 'Resolved \u2014 you won' : round.outcome==='lose' ? 'Resolved \u2014 you lost' : 'Resolved \u2014 tie/refund', urgent:false };
  if(round.stage==='expired') return { text:'Expired \u2014 refunded', urgent:false };
  return { text:round.stage, urgent:false };
}

function openMyCases(){
  const overlay = document.getElementById('myCasesOverlay');
  const rounds = Object.values(MY_ROUNDS).sort((a,b)=>b.createdAt-a.createdAt);
  const active = rounds.filter(r=>!['result','expired'].includes(r.stage));
  const done = rounds.filter(r=>['result','expired'].includes(r.stage));

  function rowHtml(round){
    const st = caseRowStatus(round);
    return `
      <div class="mycase-row ${st.urgent?'needs-action':''}">
        <div class="mycase-top">
          <div class="mycase-game">${GAMES[round.game].name}</div>
          <div class="mycase-stake">${round.stake} STRK</div>
        </div>
        <div class="mycase-status ${st.urgent?'urgent':''}">${st.text}</div>
        <button class="btn3 small wide" data-open="${round.slug}">${st.urgent ? 'Move now' : ['result','expired'].includes(round.stage) ? 'View' : 'Resume'}</button>
      </div>
    `;
  }

  overlay.innerHTML = `
    <div class="panel torn mycases-full">
      <button class="close-x" id="closeMyCasesBtn">CLOSE &times;</button>
      <div class="panel-title">My Cases</div>
      ${rounds.length===0 ? `<div class="mycases-empty">No cases yet \u2014 create or join one from any game tab.</div>` : ''}
      ${active.length ? `<div class="mycases-section-label">Active</div>${active.map(rowHtml).join('')}` : ''}
      ${done.length ? `<div class="mycases-section-label">History</div>${done.slice(0,10).map(rowHtml).join('')}` : ''}
    </div>
  `;
  document.getElementById('closeMyCasesBtn').onclick = closeMyCases;
  overlay.querySelectorAll('[data-open]').forEach(b=>{ b.onclick = ()=> openRound(b.dataset.open); });
  overlay.classList.add('open');
}
function closeMyCases(){ document.getElementById('myCasesOverlay').classList.remove('open'); }

function render(){
  renderTabs();
  renderSideProfile();
  updateMyCasesBadge();
  const el = document.getElementById('stage');
  if(state.activeSlug){
    const round = MY_ROUNDS[state.activeSlug];
    if(!round){ state.activeSlug=null; state.view='board'; renderBoard(el); return; }
    renderRound(el, round);
    return;
  }
  if(state.view==='lobby'){ renderLobby(el); return; }
  renderBoard(el);
}

function renderTabs(){
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = Object.entries(GAMES).map(([id,g])=>`
    <button class="tab ${state.game===id && !state.activeSlug ? 'active':''}" data-id="${id}">${iconSpan(g.icon,20)} ${g.short}</button>
  `).join('');
  tabs.querySelectorAll('.tab').forEach(b=>{
    b.onclick = ()=>{ if(b.dataset.id===state.game && !state.activeSlug) return; goToBoard(b.dataset.id); };
  });
}

// Real shared board, built from CaseCreated events across all wallets.
function renderBoard(el){
  el.innerHTML = `
    <div class="section-label">open cases \u2014 ${GAMES[state.game].name}</div>
    <div class="panel-hint" id="boardStatus" style="margin-bottom:16px;">Loading open cases from the chain...</div>
    <div class="board" id="boardGrid"></div>
    <div class="section-label" style="margin-top:24px;">Have a specific case ID?</div>
    <div class="stake-input-row">
      <input type="text" id="joinCaseIdInput" placeholder="case id">
    </div>
    <button class="btn3 wide" id="joinByIdBtn" style="margin-top:10px;">Join by ID</button>
  `;
  document.getElementById('joinByIdBtn').onclick = ()=> joinCaseById(document.getElementById('joinCaseIdInput').value.trim());
  loadBoard();
}

async function loadBoard(){
  const grid = document.getElementById('boardGrid');
  const status = document.getElementById('boardStatus');
  if(!grid) return;
  try {
    const cases = await fetchOpenCases(state.game);
    if(document.getElementById('boardGrid') !== grid) return; // navigated away already
    status.textContent = cases.length
      ? 'Live from the chain.'
      : 'No open cases right now. Post one below, or join a specific case by ID.';
    grid.innerHTML = `
      ${cases.map((c,i)=>`
        <div class="case-card torn enter" style="animation-delay:${Math.min(i,6)*45}ms;">
          <div class="pin"></div>
          <div class="stake-big">${c.stakeDecimal}<span class="stake-unit">STRK</span></div>
          <div class="case-sub">case #${c.caseId}</div>
          <button class="btn3 wide small" style="margin-top:14px;" data-case="${c.caseId}">Join</button>
        </div>
      `).join('')}
      <div class="create-card enter" id="createCard" style="animation-delay:${Math.min(cases.length,6)*45}ms;">
        <div class="plus">+</div>
        <div class="lbl">POST NEW CASE</div>
      </div>
    `;
    grid.querySelectorAll('[data-case]').forEach(b=>{ b.onclick = ()=> joinCaseById(b.dataset.case); });
    document.getElementById('createCard').onclick = goToCreate;
  } catch(err) {
    logError('loadBoard failed', err);
    if(status) status.textContent = 'Could not load the board, check console for details.';
  }
}

async function joinCaseById(caseIdRaw){
  if(!caseIdRaw) return;
  if(!account){
    account = await connectAccount();
    if(!account) return;
    loadProfile();
  }
  const btn = document.getElementById('joinByIdBtn');
  if(btn){ btn.textContent='Joining...'; btn.disabled=true; }
  try {
    const caseId = BigInt(caseIdRaw);
    const entry = await readCase(caseId);
    if(entry.opponent !== 0n) throw new Error('this case has already been joined');
    await submitJoinCase({ provider: account.provider, caseId });
    const round = newRound({ game: state.game, stake: Number(entry.stakeAmount)/1e18, role:'joiner', caseId });
    round.moveDeadline = Date.now() + MOVE_WINDOW_MS;
    if(state.game==='assassin') await startAssassinRole(round);
    startCasePolling(round);
    openRound(round.slug);
  } catch(err) {
    logError('joinCaseById failed', err);
    alert('could not join that case, double check the ID and try again');
  } finally {
    if(btn){ btn.textContent='Join by ID'; btn.disabled=false; }
  }
}

async function startAssassinRole(round){
  if(round.myRole) return round.myRole;
  const entry = await readCase(round.caseId);
  const creatorIsMe = round.role === 'creator';
  round.myRole = entry.assassinIsA === creatorIsMe ? 'assassin' : 'target';
  return round.myRole;
}

function renderLobby(el){
  if(!account){
    el.innerHTML = `
      <div class="panel torn enter">
        <div class="panel-hint">connect your wallet first to post a case</div>
        <button class="btn3 wide" id="lobbyConnectBtn" style="margin-top:12px;">Connect wallet</button>
      </div>
    `;
    document.getElementById('lobbyConnectBtn').onclick = async ()=>{ account = await connectAccount(); if(account) loadProfile(); render(); };
    return;
  }

  const d = state.draft;
  el.innerHTML = `
    <div class="panel torn enter">
      <button class="back-link" id="backBtn">&larr; back to open cases</button>
      <div class="panel-title">New case \u2014 ${GAMES[state.game].name}</div>

      <div class="section-label" style="margin-top:16px;">Stake</div>
      <div class="stake-input-row">
        <input type="number" id="stakeInput" min="0.01" step="0.01" value="${d.stake}">
        <span class="unit">STRK</span>
      </div>
      <div id="stakeWarning" class="panel-hint" style="display:none; color:var(--stamp);">this is more than your current balance</div>

      <div class="section-label">How long should this stay open for someone to join?</div>
      <div class="chip-row" id="joinChips">
        ${JOIN_PRESETS.map(p=>`<button class="chip ${!d.customOn && d.joinMs===p.ms?'active':''}" data-ms="${p.ms}">${p.label}</button>`).join('')}
        <button class="chip ${d.customOn?'active':''}" id="customChip">Custom</button>
      </div>
      ${d.customOn ? `
        <div class="custom-timer-row">
          <input type="number" id="customVal" min="1" value="${d.customVal}">
          <select id="customUnit">
            <option value="minutes" ${d.customUnit==='minutes'?'selected':''}>Minutes</option>
            <option value="hours" ${d.customUnit==='hours'?'selected':''}>Hours</option>
          </select>
        </div>
      ` : ''}

      <button class="btn3 wide" id="createBtn" style="margin-top:20px;">Post case</button>
      <div class="panel-hint">This creates a real case on Sepolia and appears on the shared board for anyone to join. Stake movement through the privacy pool isn't wired yet, so nothing actually moves out of your wallet on this pass.</div>
    </div>
  `;
  document.getElementById('backBtn').onclick = ()=> goToBoard();
  document.getElementById('stakeInput').oninput = (e)=>{
  d.stake = parseFloat(e.target.value)||0;
  const warn = document.getElementById('stakeWarning');
  if(warn) warn.style.display = (account?.publicBalance != null && d.stake > account.publicBalance) ? 'block' : 'none';
  };
  el.querySelectorAll('#joinChips .chip[data-ms]').forEach(c=>{
    c.onclick = ()=>{ d.customOn=false; d.joinMs=parseInt(c.dataset.ms,10); render(); };
  });
  document.getElementById('customChip').onclick = ()=>{ d.customOn=true; render(); };
  if(d.customOn){
    document.getElementById('customVal').oninput = (e)=>{ d.customVal = parseFloat(e.target.value)||1; };
    document.getElementById('customUnit').onchange = (e)=>{ d.customUnit = e.target.value; };
  }
  document.getElementById('createBtn').onclick = createCaseNow;
}

function renderRound(el, round){
  if(round.stage==='share'){ renderSharePanel(el, round); return; }
  if(round.stage==='waiting'){ renderWaitingPanel(el, round); return; }
  if(round.stage==='matched'){ renderMatchedPanel(el, round); return; }
  if(round.stage==='resolving'){ renderResolvingPanel(el); return; }
  if(round.stage==='expired'){ renderExpiredPanel(el, round); return; }

  const engine = GAMES[round.game].engine;
  if(engine==='simul') renderSimulPlay(el, round);
  else if(engine==='bluff') renderBluffPlay(el, round);
  else renderAssassinPlay(el, round);
}

function renderResolvingPanel(el){
  el.innerHTML = `
    <div class="panel torn enter">
      <div class="panel-title">Resolving</div>
      <div class="panel-hint" style="text-align:center;">Your move is in, waiting for the chain to confirm the result...</div>
    </div>
  `;
}

function renderSharePanel(el, round){
  el.innerHTML = `
    <div class="panel torn enter">
      <div class="panel-title">Case is live</div>
      <div class="share-hero">
        <div class="panel-hint" style="text-align:center;">Anyone can find this on the open board now, or you can send the case ID directly.</div>
        <div class="big-link">${caseLink(round.caseId)}</div>
        <div class="share-actions">
          <button class="btn3 wide" id="shareBtn">Share link</button>
          <button class="btn3 outline wide" id="waitBtn">I'll wait for them here</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById('shareBtn').onclick = async (e)=>{
  if(navigator.share){ try{ await navigator.share({ url: caseLink(round.caseId), title:'HIDDEN', text:`Join my ${GAMES[round.game].name} case on HIDDEN, case #${round.caseId}` }); }catch(err){} }
  else { navigator.clipboard?.writeText(caseLink(round.caseId)).catch(()=>{}); e.target.textContent='Copied'; setTimeout(()=>{e.target.textContent='Share link';},1400); }
  };
  document.getElementById('waitBtn').onclick = ()=>{ round.stage='waiting'; render(); };
}

function renderWaitingPanel(el, round){
  el.innerHTML = `
    <div class="panel torn enter">
      <div class="pulse-wrap">
        <div class="pulse-dot"></div>
        <div class="waiting-msg">Watching case #${round.caseId} for an opponent...<br><span class="countdown" id="joinCountdown">${formatCountdown(round.joinDeadline-Date.now())}</span> left to join</div>
      </div>
      <div class="link-box">
        <code>${caseLink(round.caseId)}</code>
        <button class="btn3 small" id="copyBtn">Copy</button>
      </div>
      <div class="panel-hint">This case is visible on the open board to anyone right now. Checking the chain every few seconds.</div>
    </div>
  `;
  document.getElementById('copyBtn').onclick = (e)=>{
    navigator.clipboard?.writeText(caseLink(round.caseId)).catch(()=>{});
    e.target.textContent='Copied'; setTimeout(()=>{e.target.textContent='Copy';},1400);
  };
}

function renderExpiredPanel(el, round){
  el.innerHTML = `
    <div class="panel torn enter">
      <div class="panel-title">Case expired</div>
      <div class="panel-hint">Nobody joined in time.</div>
      <button class="btn3 wide" id="backBoardBtn" style="margin-top:16px;">Back to open cases</button>
    </div>
  `;
  document.getElementById('backBoardBtn').onclick = ()=> goToBoard();
}

function renderMatchedPanel(el, round){
  const urgent = needsMyAttention(round);
  const bluffJoinerWaiting = round.game==='bluff' && round.role==='joiner' && !round.oppRevealed;
  let statusHtml;
  if(bluffJoinerWaiting){
    statusHtml = `<div class="status-banner">Waiting for the other player to bet or fold before you can act.</div>`;
  } else if(urgent){
    statusHtml = `<div class="status-banner urgent">Opponent has made their move. You have <span class="countdown" id="moveCountdown">${formatCountdown(round.moveDeadline-Date.now())}</span> left to move, or you forfeit the pot.</div>`;
  } else if(round.myMoved && !round.oppMoved){
    statusHtml = `
      <div class="status-row"><span class="status-dot"></span>You've moved</div>
      <div class="status-row"><span class="status-dot pending"></span>Waiting on opponent</div>
      <div class="status-banner">Round resolves the moment they move, or in <span class="countdown" id="moveCountdown">${formatCountdown(round.moveDeadline-Date.now())}</span> if they don't.</div>
    `;
  } else {
    statusHtml = `
      <div class="status-row"><span class="status-dot"></span>Opponent connected</div>
      <div class="panel-hint">You don't have to move right now \u2014 come back anytime via My Cases. But if your opponent moves first, you'll only have until <span class="countdown" id="moveCountdown">${formatCountdown(round.moveDeadline-Date.now())}</span> from now to respond before you forfeit.</div>
    `;
  }

  el.innerHTML = `
    <div class="panel torn enter">
      <div class="panel-title">Opponent connected</div>
      ${statusHtml}
      ${!round.myMoved && !bluffJoinerWaiting ? `<button class="btn3 wide" id="moveBtn" style="margin-top:14px;">Make your move</button>` : ''}
      <button class="btn3 outline wide" id="laterBtn" style="margin-top:${round.myMoved?'14':'10'}px;">Back to board (resume later)</button>
    </div>
  `;
  if(!round.myMoved && !bluffJoinerWaiting){
    document.getElementById('moveBtn').onclick = async ()=>{
      const engine = GAMES[round.game].engine;
      if(engine==='simul') round.stage='choose';
      else if(engine==='bluff'){ if(!round.myCard) round.myCard = drawCard(); round.stage='dealt'; }
      else { if(!round.myRole) await startAssassinRole(round); round.stage='picking'; }
      render();
    };
  }
  document.getElementById('laterBtn').onclick = ()=> goToBoard();
}

function renderSimulPlay(el, round){
  const cfg = SIMUL_CONFIG[round.game];
  if(round.stage!=='choose') return;

  el.innerHTML = `
    <div class="panel torn enter">
      <div class="panel-title">Select your move</div>
      <div class="section-label" style="margin-top:14px;">${cfg.chooseCopy}</div>
      <div class="tiles c${cfg.cols}">
        ${cfg.options.map(m=>`<button class="tile" data-id="${m.id}">
          <div class="glyph">${iconSpan(m.icon,28)}</div><div class="label">${m.label}</div>
          ${m.sub?`<div class="sub">${m.sub}</div>`:''}
        </button>`).join('')}
      </div>
      <button class="btn3 wide" id="lockBtn" disabled>Lock move</button>
      <div class="panel-hint">${cfg.lockCopy}</div>
    </div>
  `;
  let picked=null;
  el.querySelectorAll('.tile').forEach(t=>{
    t.onclick = ()=>{
      el.querySelectorAll('.tile').forEach(x=>x.classList.remove('picked'));
      t.classList.add('picked'); picked=t.dataset.id;
      document.getElementById('lockBtn').disabled=false;
    };
  });
  document.getElementById('lockBtn').onclick = async ()=>{
    const btn = document.getElementById('lockBtn');
    btn.textContent = 'Submitting commitment...'; btn.disabled = true;
    try {
      const moveIndex = cfg.options.findIndex(o=>o.id===picked);
      const salt = randomFelt();
      const secret = randomFelt();
      await submitCommitMove({ provider: account.provider, caseId: round.caseId, moveValue: moveIndex, salt, claimSecret: secret });
      round.myMove = picked;
      round.myMoved = true;
      round.pendingReveal = { moveValue: moveIndex, salt };
      round.claimSecret = secret;
      round.stage = 'matched';
      render();
    } catch(err) {
      logError('commit failed', err);
      alert('could not submit your move, see console for details');
      btn.textContent='Lock move'; btn.disabled=false;
    }
  };
}

function renderBluffPlay(el, round){
  if(round.stage==='dealt'){
    const actionLabel = round.role==='creator' ? 'BET' : 'CALL';
    el.innerHTML = `
      <div class="panel torn enter">
        <div class="panel-title">Your hand</div>
        <div class="your-card">
          <div class="playing-card">${round.myCard}</div>
          <div class="card-caption">only you can see this</div>
        </div>
        <div class="pot-strip"><span>ANTE</span><b>${round.stake.toFixed(2)} STRK each</b></div>
        <div class="btn-row">
          <button class="btn3 outline" id="foldBtn">FOLD</button>
          <button class="btn3" id="betBtn">${actionLabel}</button>
        </div>
        <div class="panel-hint">${round.role==='creator' ? 'Bet, and your opponent has to decide whether to call without seeing your card. Fold, and you forfeit your ante now.' : 'Call to compare cards, or fold and forfeit your ante now.'}</div>
      </div>
    `;
    document.getElementById('foldBtn').onclick = async ()=>{
      const foldBtn = document.getElementById('foldBtn');
      foldBtn.disabled = true;
      try {
        const moveValue = packBluffAction(0, RANKS.indexOf(round.myCard));
        const salt = randomFelt();
        const secret = randomFelt();
        await submitCommitMove({ provider: account.provider, caseId: round.caseId, moveValue, salt, claimSecret: secret });
        await submitRevealMove({ provider: account.provider, caseId: round.caseId, moveValue, salt });
        round.claimSecret = secret;
        round.betLog.push({who:'you',action:'FOLD'});
        round.myMoved = true; round.myRevealed = true;
        round.stage = 'resolving';
        render();
      } catch(err) {
        logError('bluff fold failed', err);
        alert('could not submit fold, see console for details');
        foldBtn.disabled = false;
      }
    };
    document.getElementById('betBtn').onclick = async ()=>{
      const betBtn = document.getElementById('betBtn');
      betBtn.disabled = true;
      try {
        const moveValue = packBluffAction(1, RANKS.indexOf(round.myCard));
        const salt = randomFelt();
        const secret = randomFelt();
        await submitCommitMove({ provider: account.provider, caseId: round.caseId, moveValue, salt, claimSecret: secret });
        await submitRevealMove({ provider: account.provider, caseId: round.caseId, moveValue, salt });
        round.claimSecret = secret;
        round.betLog.push({who:'you',action: actionLabel});
        round.myMoved = true; round.myRevealed = true;
        round.stage = round.role==='creator' ? 'pending-call' : 'resolving';
        render();
      } catch(err) {
        logError('bluff bet/call failed', err);
        alert('could not submit your action, see console for details');
        betBtn.disabled = false;
      }
    };
  }
  else if(round.stage==='pending-call'){
    el.innerHTML = `
      <div class="panel torn enter">
        <div class="panel-title">Opponent deciding</div>
        <div class="bet-log">${renderBetLog(round)}</div>
        <div class="pulse-wrap">
          <div class="pulse-dot"></div>
          <div class="waiting-msg">Waiting for the other player to call or fold on-chain...</div>
        </div>
      </div>
    `;
  }
  else if(round.stage==='result'){ renderBluffResult(el, round); }
}

function renderBetLog(round){
  return round.betLog.map(b=>`<div class="${b.who==='them'?'them':''}">${b.who==='them'?'OPPONENT':'YOU'} &rarr; ${b.action}</div>`).join('');
}

function renderBluffResult(el, round){
  const outcome = round.outcome;
  let cardsHtml;
  if(round.outcomeKind==='fold-opp'){
    cardsHtml = `<div class="parties">
      <div class="party"><div class="who">YOU</div><div class="reveal-glyph">${round.myCard}</div></div>
      <div class="party"><div class="who">OPPONENT</div><div class="redaction"><span class="lockglyph">FOLDED</span></div></div>
    </div>`;
  } else if(round.outcomeKind==='creator-folded'){
    cardsHtml = `<div class="parties">
      <div class="party"><div class="who">YOU</div><div class="redaction"><span class="lockglyph">NOT NEEDED</span></div></div>
      <div class="party"><div class="who">OPPONENT</div><div class="redaction"><span class="lockglyph">FOLDED</span></div></div>
    </div>`;
  } else if(round.myMoved && !round.oppCard){
    cardsHtml = `<div class="parties">
      <div class="party"><div class="who">YOU</div><div class="reveal-glyph">${round.myCard}</div></div>
      <div class="party"><div class="who">OPPONENT</div><div class="redaction"><span class="lockglyph">HIDDEN</span></div></div>
    </div>`;
  } else {
    cardsHtml = `<div class="parties">
      <div class="party"><div class="who">YOU</div><div class="reveal-glyph">${round.myCard}</div></div>
      <div class="party"><div class="who">OPPONENT</div><div class="reveal-glyph" style="animation-delay:150ms;">${round.oppCard}</div></div>
    </div>`;
  }
  const stampText = outcome==='win'?'CLEARED':outcome==='tie'?'STALEMATE':'CASE LOST';
  const stampCls = outcome==='win'?'':outcome==='tie'?'tie':'lose';

  el.innerHTML = `
    <div class="panel torn enter">
      <div class="panel-title">Showdown</div>
      <div class="bet-log">${renderBetLog(round)}</div>
      ${cardsHtml}
      <div class="stamp-zone"><div class="stamp ${stampCls}" style="animation-delay:480ms;">${stampText}</div></div>
      <div class="result-line enter" style="animation-delay:750ms;">Pot: <b>${round.pot.toFixed(2)} STRK</b> \u2014 outcome recorded on-chain</div>
      <button class="btn3 wide enter" id="backBtn2" style="margin-top:16px; animation-delay:820ms;">Back to board</button>
    </div>
  `;
  document.getElementById('backBtn2').onclick = ()=> goToBoard();
}

function renderAssassinPlay(el, round){
  if(round.stage==='picking'){
    const roleCopy = round.myRole==='assassin'
      ? 'Pick 3 tiles to attack. Land on your opponent\u2019s hiding tile and you catch them.'
      : 'Pick 3 tiles to hide across. Avoid every tile your opponent attacks.';
    el.innerHTML = `
      <div class="panel torn enter">
        <div class="panel-title">Your assignment</div>
        <div class="assassin-wrap">
          <div class="role-tag">YOU ARE THE ${round.myRole.toUpperCase()}</div>
          <div class="panel-hint" style="text-align:center;">${roleCopy}</div>
          <div class="grid16" id="grid16">${Array.from({length:16},(_,i)=>`<button class="gtile" data-i="${i}"></button>`).join('')}</div>
          <div class="pick-counter" id="pickCounter">0 / 3 selected</div>
          <button class="btn3 wide" id="lockBtn" disabled>Lock selection</button>
        </div>
      </div>
    `;
    const picks=[];
    const counter = document.getElementById('pickCounter');
    const lockBtn = document.getElementById('lockBtn');
    el.querySelectorAll('.gtile').forEach(t=>{
      t.onclick = ()=>{
        const i = parseInt(t.dataset.i,10);
        const idx = picks.indexOf(i);
        if(idx>-1){ picks.splice(idx,1); t.classList.remove('picked'); }
        else if(picks.length<3){ picks.push(i); t.classList.add('picked'); }
        counter.textContent = `${picks.length} / 3 selected`;
        lockBtn.disabled = picks.length!==3;
      };
    });
    lockBtn.onclick = async ()=>{
      lockBtn.textContent = 'Submitting commitment...'; lockBtn.disabled = true;
      try {
        const moveValue = packTiles(picks[0], picks[1], picks[2]);
        const salt = randomFelt();
        const secret = randomFelt();
        await submitCommitMove({ provider: account.provider, caseId: round.caseId, moveValue, salt, claimSecret: secret });
        round.myPicks = picks.slice();
        round.myMoved = true;
        round.pendingReveal = { moveValue, salt };
        round.claimSecret = secret;
        round.stage = 'matched';
        render();
      } catch(err) {
        logError('assassin commit failed', err);
        alert('could not submit your move, see console for details');
        lockBtn.textContent='Lock selection'; lockBtn.disabled=false;
      }
    };
  }
  else if(round.stage==='result'){ renderAssassinResult(el, round); }
}

function renderAssassinResult(el, round){
  const assassinPicks = round.myRole==='assassin' ? round.myPicks : round.oppPicks;
  const targetPicks = round.myRole==='target' ? round.myPicks : round.oppPicks;
  const overlap = assassinPicks.filter(t=>targetPicks.includes(t));
  const outcome = round.outcome;
  const stampText = outcome==='win' ? 'ESCAPED' : 'CAUGHT';
  const stampCls = outcome==='win'?'':outcome==='lose'?'lose':'tie';

  let markedCount=0;
  el.innerHTML = `
    <div class="panel torn enter">
      <div class="panel-title">Reveal</div>
      <div class="assassin-wrap">
        <div class="grid16">
          ${Array.from({length:16},(_,i)=>{
            const isA=assassinPicks.includes(i), isT=targetPicks.includes(i);
            const cls = isA&&isT?'mark-both':isA?'mark-a':isT?'mark-t':'';
            const delayAttr = cls ? ` enter" style="animation-delay:${(markedCount++)*55}ms;"` : '"';
            return `<div class="gtile ${cls}${delayAttr}></div>`;
          }).join('')}
        </div>
        <div class="grid-legend">
          <span><span class="legend-swatch" style="background:var(--stamp);"></span>Assassin</span>
          <span><span class="legend-swatch" style="background:var(--gold);"></span>Target</span>
          <span><span class="legend-swatch" style="background:repeating-linear-gradient(45deg,var(--stamp),var(--stamp) 3px,var(--gold) 3px,var(--gold) 6px);"></span>Overlap</span>
        </div>
      </div>
      <div class="stamp-zone"><div class="stamp ${stampCls}" style="animation-delay:520ms;">${stampText}</div></div>
      <div class="result-line enter" style="animation-delay:780ms;">
        You were the ${round.myRole.toUpperCase()} \u2014 ${overlap.length} overlapping tile${overlap.length===1?'':'s'}<br>
        Outcome recorded on-chain.
      </div>
      <button class="btn3 wide enter" id="backBtn2" style="margin-top:16px; animation-delay:850ms;">Back to board</button>
    </div>
  `;
  document.getElementById('backBtn2').onclick = ()=> goToBoard();
}

async function createCaseNow(){
  const btn = document.getElementById('createBtn');
  btn.textContent = 'Waiting for wallet approval...';
  btn.disabled = true;
  const d = state.draft;
  const joinSecs = d.customOn ? Math.round(d.customVal*(d.customUnit==='hours'?3600:60)) : Math.round(d.joinMs/1000);
  try {
    const { caseId } = await submitCreateCase({
      provider: account.provider,
      gameKey: state.game,
      stakeDecimal: d.stake,
      joinWindowSecs: joinSecs,
    });
    const round = newRound({ game: state.game, stake: d.stake, role:'creator', joinMs: joinSecs*1000, caseId });
    startCasePolling(round);
    openRound(round.slug);
  } catch(err) {
    logError('create case failed', err);
    alert('could not create the case, see console for details');
  } finally {
    btn.textContent = 'Post case';
    btn.disabled = false;
  }
}

document.getElementById('myCasesTrigger').onclick = openMyCases;
document.getElementById('profileTrigger').onclick = openProfile;
document.getElementById('profileOverlay').addEventListener('click', (e)=>{ if(e.target.id==='profileOverlay') closeProfile(); });
document.getElementById('myCasesOverlay').addEventListener('click', (e)=>{ if(e.target.id==='myCasesOverlay') closeMyCases(); });
document.addEventListener('keydown', (e)=>{ if(e.key==='Escape'){ closeProfile(); closeMyCases(); } });

async function checkUrlForCase(){
  const params = new URLSearchParams(window.location.search);
  const caseIdRaw = params.get('case');
  if(!caseIdRaw) return;
  try {
    const entry = await readCase(BigInt(caseIdRaw));
    const gameKey = Object.keys(GAME_TYPE_INDEX).find(k => GAME_TYPE_INDEX[k] === entry.gameType);
    if(gameKey) state.game = gameKey;
    state.view = 'board';
    render();
    const input = document.getElementById('joinCaseIdInput');
    if(input) input.value = caseIdRaw;
  } catch(err) {
    log('checkUrlForCase: could not preload case from URL', err);
  }
}

log('HIDDEN app loaded, contract:', CONTRACT_ADDRESS);
render();
checkUrlForCase();
