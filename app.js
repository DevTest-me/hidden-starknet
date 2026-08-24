import { connect } from "@starknet-io/get-starknet";
import { StarknetInjectedWallet } from "@starknet-io/get-starknet-wallet-standard-v6";
import { WalletAccountV6, WalletAccount, wallet, RpcProvider, hash, shortString, ec, constants } from "starknet";
import {
  bytesToHexString,
  createSession,
  createSessionRequest,
  buildSessionAccount,
} from "@argent/x-sessions";
import { requestSessionAccount } from "starknet-sessions";

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
function toFelt(value){
  return '0x' + BigInt(value).toString(16);
}
function toCanonicalFelt(hexString){
  const stripped = hexString.replace(/^0x0+/, '0x');
  return stripped === '0x' ? '0x0' : stripped;
}

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
const CONTRACT_ADDRESS = '0x06ed9634d896c832c6cfe1570f772ab8e24ecc2d693b3aa801cadfd16742a599';
const STRK_ADDRESS = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const MAINNET_RPC_URL = `https://starknet-mainnet.g.alchemy.com/starknet/version/rpc/v0_8/${import.meta.env.VITE_ALCHEMY_KEY}`;

// ---------------------------------------------------------------
// Chain wiring
// ---------------------------------------------------------------

const starknetRpc = new RpcProvider({ nodeUrl: MAINNET_RPC_URL });
const GAME_TYPE_INDEX = { rps:0, pd:1, bluff:2, assassin:3 };
const STRK_DECIMALS_FACTOR = 10n ** 18n;

const MOVE_TAG_FELT = shortString.encodeShortString('HIDDEN_MOVE_TAG:V1');
const CLAIM_TAG_FELT = shortString.encodeShortString('HIDDEN_CLAIM_TAG:V1');
const ACTION_TAG_FELT = shortString.encodeShortString('HIDDEN_ACTION_TAG:V1');
const CARD_TAG_FELT = shortString.encodeShortString('HIDDEN_CARD_TAG:V1');
const CASE_CREATED_SELECTOR = hash.getSelectorFromName('CaseCreated');

function packTiles(t1, t2, t3){ return BigInt(t1) + BigInt(t2)*16n + BigInt(t3)*256n; }

function randomFelt(){
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  let hexStr = '0x';
  for(const b of bytes) hexStr += b.toString(16).padStart(2,'0');
  return BigInt(hexStr);
}

// Reveal material (moveValue + salt) only ever exists client-side —
// the chain never sees it until reveal. If a commit tx's RPC response
// is flaky (throws even though the tx landed) or the tab reloads
// before auto-reveal fires, losing this in memory permanently stalls
// the case for both players. Save it before sending anything.
function revealStorageKey(caseId, address){
  return `hidden_reveal_${normalizeAddress(address)}_${caseId}`;
}
function savePendingReveal(caseId, address, data){
  try { localStorage.setItem(revealStorageKey(caseId, address), JSON.stringify(data)); }
  catch(err){ logError('savePendingReveal failed', err); }
}
function loadPendingReveal(caseId, address){
  try {
    const raw = localStorage.getItem(revealStorageKey(caseId, address));
    return raw ? JSON.parse(raw) : null;
  } catch(err){ logError('loadPendingReveal failed', err); return null; }
}
function clearPendingReveal(caseId, address){
  try { localStorage.removeItem(revealStorageKey(caseId, address)); }
  catch(err){ logError('clearPendingReveal failed', err); }
}
function claimSecretStorageKey(caseId, address){
  return `hidden_claimsecret_${normalizeAddress(address)}_${caseId}`;
}
function saveClaimSecret(caseId, address, secret){
  try { localStorage.setItem(claimSecretStorageKey(caseId, address), secret.toString()); }
  catch(err){ logError('saveClaimSecret failed', err); }
}
function loadClaimSecret(caseId, address){
  try {
    const raw = localStorage.getItem(claimSecretStorageKey(caseId, address));
    return raw ? BigInt(raw) : null;
  } catch(err){ logError('loadClaimSecret failed', err); return null; }
}
function clearClaimSecret(caseId, address){
  try { localStorage.removeItem(claimSecretStorageKey(caseId, address)); }
  catch(err){ logError('clearClaimSecret failed', err); }
}

function computeMoveHash(moveValue, salt){
  return hash.computePoseidonHashOnElements([MOVE_TAG_FELT, BigInt(moveValue), salt]);
}
function computeClaimHash(secret){
  return hash.computePoseidonHashOnElements([CLAIM_TAG_FELT, secret]);
}
function computeActionHash(action, salt){
  return hash.computePoseidonHashOnElements([ACTION_TAG_FELT, BigInt(action), salt]);
}
function computeCardHash(cardIndex, salt){
  return hash.computePoseidonHashOnElements([CARD_TAG_FELT, BigInt(cardIndex), salt]);
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

const SESSION_METHODS = [
  { contractAddress: CONTRACT_ADDRESS, entrypoint: 'commit_move' },
  { contractAddress: CONTRACT_ADDRESS, entrypoint: 'reveal_move' },
];

function sessionExpiry(){
  return new Date(Date.now() + MOVE_WINDOW_MS * 2);
}

async function createArgentSession(provider, address){
  const sessionKeyBytes = ec.starkCurve.utils.randomPrivateKey();
  const sessionKey = {
    privateKey: bytesToHexString(sessionKeyBytes),
    publicKey: ec.starkCurve.getStarkKey(sessionKeyBytes),
  };
  const sessionParams = {
    sessionKey,
    allowedMethods: SESSION_METHODS.map(({ contractAddress, entrypoint }) => ({
      'Contract Address': contractAddress,
      selector: entrypoint,
    })),
    expiry: BigInt(Math.floor(sessionExpiry().getTime() / 1000)),
    metaData: {
      projectID: 'hidden',
      txFees: [{ tokenAddress: STRK_ADDRESS, maxAmount: '100000000000000000' }],
    },
  };
  const sessionRequest = createSessionRequest({
    chainId: constants.StarknetChainId.SN_MAIN,
    sessionParams,
  });
  const request = walletApiRequest(provider);
  if(!request) throw new Error('wallet provider cannot sign an Argent session');
  const authorisationSignature = await request({
    type: 'wallet_signTypedData',
    params: sessionRequest.sessionTypedData,
  });
  const session = await createSession({
    sessionRequest,
    address,
    chainId: constants.StarknetChainId.SN_MAIN,
    authorisationSignature,
  });
  log('createArgentSession: session object', session);
  return buildSessionAccount({
    useCacheAuthorisation: false,
    session,
    sessionKey,
    provider: starknetRpc,
  });
}

async function createBraavosSession(provider, address){
  const walletAccount = new WalletAccountV6({
    provider: starknetRpc,
    walletProvider: provider,
    address,
  });
  return requestSessionAccount(starknetRpc, walletAccount, {
    executeAfter: new Date(),
    executeBefore: sessionExpiry(),
    requestedMethods: SESSION_METHODS,
    spendingLimits: [],
    strkGasLimit: 10_000_000_000_000_000n,
  });
}

async function createSessionAccount(walletId, provider, address){
  if(walletId === 'argentX') return createArgentSession(provider, address);
  if(walletId === 'braavos') return createBraavosSession(provider, address);
  return null;
}

async function sendSessionInvoke(sessionAccount, calls){
  const result = await sessionAccount.execute(calls.map(call => ({
    contractAddress: call.contract_address,
    entrypoint: call.entry_point,
    calldata: call.calldata,
  })));
  const txHash = result?.transaction_hash ?? result?.transactionHash ?? result;
  if(!txHash) throw new Error('session account did not return a transaction hash');
  return txHash;
}

async function waitForReceipt(txHash){
  log('waitForReceipt: waiting on', txHash);
  for(let i=0;i<40;i++){
    try {
      const receipt = await starknetRpc.getTransactionReceipt(txHash);
      if(receipt){ log('waitForReceipt: confirmed', receipt); return receipt; }
    } catch(err) { /* not indexed yet, keep polling */ }
    await new Promise(r=>setTimeout(r, 3000));
  }
  throw new Error('timed out waiting for the transaction to confirm');
}

async function readCase(caseId){
  const raw = await starknetRpc.callContract({
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
    cardCommitA: next(), cardCommitB: next(),
    revealedCardA: next(), revealedCardB: next(),
    hasRevealedCardA: feltToBool(next()), hasRevealedCardB: feltToBool(next()),
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
    STRK_ADDRESS,
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

async function submitCancelCase({ provider, caseId, claimHash }){
  log('submitCancelCase', { caseId, claimHash });
  const txHash = await sendInvoke(provider, [{ contract_address: CONTRACT_ADDRESS, entry_point: 'cancel_case', calldata: [String(caseId), claimHash.toString()] }]);
  await waitForReceipt(txHash);
  return txHash;
}

async function submitCommitMove({ provider, caseId, commitHash, cardCommit = 0n, claimSecret }){
  const claimHash = computeClaimHash(claimSecret);
  log('submitCommitMove', { caseId, commitHash, cardCommit, claimHash });
  const calls = [{
    contract_address: CONTRACT_ADDRESS, entry_point: 'commit_move',
    calldata: [String(caseId), commitHash.toString(), cardCommit.toString(), claimHash.toString()],
  }];
  const txHash = account?.sessionAccount
    ? await sendSessionInvoke(account.sessionAccount, calls)
    : await sendInvoke(provider, calls);
  await waitForReceipt(txHash);
  return { txHash, commitHash, claimHash };
}

async function submitBundle({ provider, calls }){
  log('submitBundle', calls);
  const txHash = account?.sessionAccount
    ? await sendSessionInvoke(account.sessionAccount, calls)
    : await sendInvoke(provider, calls);
  await waitForReceipt(txHash);
  return txHash;
}

async function submitCommitAndReveal({ provider, caseId, commitHash, cardCommit = 0n, claimSecret, moveValue, salt }){
  const claimHash = computeClaimHash(claimSecret);
  log('submitCommitAndReveal', { caseId, commitHash, moveValue });
  const calls = [
    {
      contract_address: CONTRACT_ADDRESS, entry_point: 'commit_move',
      calldata: [String(caseId), commitHash.toString(), cardCommit.toString(), claimHash.toString()],
    },
    {
      contract_address: CONTRACT_ADDRESS, entry_point: 'reveal_move',
      calldata: [String(caseId), String(moveValue), salt.toString()],
    },
  ];
  const txHash = account?.sessionAccount
    ? await sendSessionInvoke(account.sessionAccount, calls)
    : await sendInvoke(provider, calls);
  await waitForReceipt(txHash);
  return { txHash, commitHash, claimHash };
}

async function submitRevealMove({ provider, caseId, moveValue, salt }){
  log('submitRevealMove', { caseId, moveValue });
  const calls = [{
    contract_address: CONTRACT_ADDRESS, entry_point: 'reveal_move',
    calldata: [String(caseId), String(moveValue), salt.toString()],
  }];
  const txHash = account?.sessionAccount
    ? await sendSessionInvoke(account.sessionAccount, calls)
    : await sendInvoke(provider, calls);
  await waitForReceipt(txHash);
  return txHash;
}

async function submitRevealAction({ provider, caseId, action, salt }){
  log('submitRevealAction', { caseId, action });
  const calls = [{
    contract_address: CONTRACT_ADDRESS, entry_point: 'reveal_action',
    calldata: [String(caseId), String(action), salt.toString()],
  }];
  const txHash = account?.sessionAccount
    ? await sendSessionInvoke(account.sessionAccount, calls)
    : await sendInvoke(provider, calls);
  await waitForReceipt(txHash);
  return txHash;
}

async function submitRevealCard({ provider, caseId, cardIndex, salt }){
  log('submitRevealCard', { caseId, cardIndex });
  const calls = [{
    contract_address: CONTRACT_ADDRESS, entry_point: 'reveal_card',
    calldata: [String(caseId), String(cardIndex), salt.toString()],
  }];
  const txHash = account?.sessionAccount
    ? await sendSessionInvoke(account.sessionAccount, calls)
    : await sendInvoke(provider, calls);
  await waitForReceipt(txHash);
  return txHash;
}

async function submitResolve({ provider, caseId }){
  log('submitResolve', { caseId });
  const txHash = await sendInvoke(provider, [{ contract_address: CONTRACT_ADDRESS, entry_point: 'resolve', calldata: [String(caseId)] }]);
  await waitForReceipt(txHash);
  return txHash;
}

async function buildWalletAccountV6(provider, address){
  // get-starknet's connect() returns a legacy StarknetWindowObject. WalletAccountV6
  // needs the wallet-standard V6 shape, so bridge legacy injected wallets first.
  const walletProvider = provider?.features?.['standard:events']
    ? provider
    : new StarknetInjectedWallet(provider);
  // Prime the adapter's wallet-standard account state without another popup.
  if(walletProvider?.features?.['standard:connect'] && !walletProvider.accounts?.length){
    await walletProvider.features['standard:connect'].connect({ silent: true });
  }
  return new WalletAccountV6({ provider: starknetRpc, walletProvider, address });
}

async function submitClaim({ provider, address, caseId, isPlayerA, claimSecret }){
  const walletAccount = await buildWalletAccountV6(provider, address);
  const actions = [
    { type: 'transfer', token: toCanonicalFelt(STRK_ADDRESS), amount: 'OPEN', recipient: toCanonicalFelt(address) },
    { type: 'invoke', contract: toCanonicalFelt(CONTRACT_ADDRESS), calldata: [
      toFelt(1),
      toFelt(caseId),
      toFelt(isPlayerA ? 1 : 0),
      toCanonicalFelt(STRK_ADDRESS),
      toFelt(0),
      toFelt(claimSecret),
      '${openNoteIds[0]}',
    ]},
  ];
  log('submitClaim: actions', actions);
  const { transaction_hash } = await walletAccount.strk20InvokeTransaction(actions);
  await waitForReceipt(transaction_hash);
  return transaction_hash;
}

async function submitPrivacyDeposit({ provider, address, caseId, isPlayerA, stakeWei }){
  const walletAccount = await buildWalletAccountV6(provider, address);
  const actions = [
    { type: 'withdraw', token: toCanonicalFelt(STRK_ADDRESS), amount: toFelt(stakeWei), recipient: toCanonicalFelt(CONTRACT_ADDRESS) },
    { type: 'invoke', contract: toCanonicalFelt(CONTRACT_ADDRESS), calldata: [
      toFelt(0),
      toFelt(caseId),
      toFelt(isPlayerA ? 1 : 0),
      toCanonicalFelt(STRK_ADDRESS),
      toFelt(stakeWei),
      toFelt(0),
      toFelt(0),
    ]},
  ];
  log('submitPrivacyDeposit: actions', actions);
  const { transaction_hash } = await walletAccount.strk20InvokeTransaction(actions);
  await waitForReceipt(transaction_hash);
  return transaction_hash;
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
    if(entry.gameType === gameIndex && entry.opponent === 0n && entry.outcome === 0 && entry.joinDeadline > now){
      open.push({ caseId: BigInt(id), stakeDecimal: Number(entry.stakeAmount)/1e18, creator: entry.creator });
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
    outcome:null, recorded:false, claimed:false,
    pendingReveal:null, claimSecret:null, pollTimer:null, resolvePending:false,
  };
  MY_ROUNDS[slug] = round;
  return round;
}

function normalizeAddress(value){
  try { return BigInt(value).toString(16).toLowerCase(); }
  catch { return String(value ?? '').replace(/^0x/i, '').replace(/^0+/, '').toLowerCase() || '0'; }
}

function roundIsClaimable(round){
  if(round.claimed) return false;
  if(!round.claimSecret) return false;
  return round.outcome === 'win' || round.outcome === 'tie';
}

function markClaimed(round){
  clearClaimSecret(round.caseId, account.address);
  round.claimed = true;
}

async function rehydrateMyRounds(address){
  const walletAddress = normalizeAddress(address);
  const gameByIndex = Object.fromEntries(Object.entries(GAME_TYPE_INDEX).map(([key, index]) => [index, key]));
  const MAX_PROBE = 200;

  for(let id = 1; id <= MAX_PROBE; id++){
    let entry;
    try { entry = await readCase(BigInt(id)); }
    catch(err){ logError('rehydrateMyRounds: stopped probing at case', id, err); break; }
    if(entry.creator === 0n) break;

    const creator = normalizeAddress(entry.creator);
    const opponent = normalizeAddress(entry.opponent);
    const isCreator = creator === walletAddress;
    const isOpponent = opponent === walletAddress;
    if(!isCreator && !isOpponent) continue;
    if(Object.values(MY_ROUNDS).some(round => BigInt(round.caseId) === BigInt(id))) continue;

    const role = isCreator ? 'creator' : 'joiner';
    if(!isCreator && entry.opponent === 0n) continue;
    const game = gameByIndex[entry.gameType];
    if(!game) { log('rehydrateMyRounds: unknown game type for case', id, entry.gameType); continue; }
    const joinMs = Math.max(0, entry.joinDeadline * 1000 - Date.now());
    const round = newRound({
      game,
      stake: Number(entry.stakeAmount) / 1e18,
      role,
      joinMs,
      caseId: BigInt(id),
    });
    round.joinDeadline = entry.joinDeadline * 1000;

      if(entry.opponent === 0n){
      if(entry.outcome !== 0){
        round.stage = 'expired';
        round.cancelledByMe = true;
        round.recorded = true;
        round.claimed = role==='creator' ? entry.claimedA : entry.claimedB;
        round.claimSecret = loadClaimSecret(BigInt(id), address);
        if(!round.claimed && round.claimSecret){
          // Fire-and-forget — don't block the rest of rehydration on
          // this, and don't let one failed claim stall other cases.
          submitClaim({ provider, address, caseId: BigInt(id), isPlayerA: true, claimSecret: round.claimSecret })
            .then(async ()=>{ markClaimed(round); await refreshShieldedBalance(); touch(round.slug); })
            .catch(err=>logError('auto-claim on rehydrate failed', err));
        }
        continue;
      }
      round.stage = 'share';
      startCasePolling(round);
      continue;
    }

    round.stage = 'matched';
    round.filledAt = entry.joinDeadline * 1000;
    round.moveDeadline = entry.moveDeadline * 1000;
    const iAmA = role === 'creator';
    round.claimed = iAmA ? entry.claimedA : entry.claimedB;
    round.myMoved = iAmA ? entry.hasCommittedA : entry.hasCommittedB;
    round.oppMoved = iAmA ? entry.hasCommittedB : entry.hasCommittedA;
    round.myRevealed = iAmA ? entry.hasRevealedA : entry.hasRevealedB;
    round.oppRevealed = iAmA ? entry.hasRevealedB : entry.hasRevealedA;

    if(entry.outcome === 0 && round.myMoved && !round.myRevealed){
     const saved = loadPendingReveal(round.caseId, address);
     if(saved && saved.kind === 'simul'){
       round.pendingReveal = { moveValue: saved.moveValue, salt: BigInt(saved.salt) };
       round.claimSecret = BigInt(saved.secret);
      }
    }
    if(entry.outcome === 0 && !round.claimSecret){
      round.claimSecret = loadClaimSecret(BigInt(id), address);
    }

    if(game === 'assassin'){
      round.myRole = entry.assassinIsA === iAmA ? 'assassin' : 'target';
    }

    if(entry.outcome !== 0){
      round.claimSecret = loadClaimSecret(BigInt(id), address);
      applyRevealedMoves(round, entry);
      finalizeFromChain(round, entry);
    } else {
      startCasePolling(round);
    }
  }
  log('rehydrateMyRounds: rebuilt rounds', Object.values(MY_ROUNDS).length);
}

function startCasePolling(round){
  round.pollTimer = setInterval(async ()=>{
    if(round.stage==='expired' || round.stage==='result'){ clearInterval(round.pollTimer); return; }
    if(Date.now() - lastShieldedBalanceRefreshAt >= 15000){
      lastShieldedBalanceRefreshAt = Date.now();
      refreshShieldedBalance();
    }
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
  const myValue = iAmA ? entry.revealedMoveA : entry.revealedMoveB;
  const oppValue = iAmA ? entry.revealedMoveB : entry.revealedMoveA;
  const myRevealed = iAmA ? entry.hasRevealedA : entry.hasRevealedB;
  const oppRevealed = iAmA ? entry.hasRevealedB : entry.hasRevealedA;

  if(round.game==='rps' || round.game==='pd'){
    const opts = SIMUL_CONFIG[round.game].options;
    const myOpt = opts[Number(myValue)];
    const oppOpt = opts[Number(oppValue)];
    if(myOpt) round.myMove = myOpt.id;
    if(oppOpt) round.oppMove = oppOpt.id;
  } else if(round.game==='assassin'){
    const mv = Number(myValue), ov = Number(oppValue);
    round.myPicks = [mv % 16, Math.floor(mv/16) % 16, Math.floor(mv/256) % 16];
    round.oppPicks = [ov % 16, Math.floor(ov/16) % 16, Math.floor(ov/256) % 16];
  } else if(round.game==='bluff'){
    // round.myCard is drawn client-side and never comes from chain data
    // at all. The contract doesn't expose the raw fold/bet action value
    // directly — only whether each side has revealed an action, and
    // separately, whether each side has revealed a card. A fold never
    // reveals a card, so "an action was revealed, the case is already
    // resolved, but no card followed" is how we know that reveal was a
    // fold rather than a call.
    const oppCardRevealed = iAmA ? entry.hasRevealedCardB : entry.hasRevealedCardA;
    const oppCardValue = iAmA ? entry.revealedCardB : entry.revealedCardA;
    const resolved = entry.outcome !== 0;

    if(oppCardRevealed){
      round.oppCard = RANKS[Number(oppCardValue)];
    }

    if(resolved && entry.hasRevealedA && !entry.hasRevealedB){
      // Creator folded before the opponent ever got a chance to commit.
      round.outcomeKind = iAmA ? null : 'creator-folded';
    } else if(resolved && iAmA && entry.hasRevealedB && !oppCardRevealed){
      // I'm the creator; the opponent revealed an action but no card
      // followed it — that action was a fold.
      round.outcomeKind = 'fold-opp';
    }
  }
}

function finalizeFromChain(round, entry){
  if(round.recorded) return;
  applyRevealedMoves(round, entry);
  const iAmA = round.role==='creator';
  const outcome = outcomeFromChain(entry, iAmA);
  round.outcome = outcome;
  round.claimed = iAmA ? entry.claimedA : entry.claimedB;
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
    try {
      await submitRevealMove({ provider: account.provider, caseId: round.caseId, moveValue: round.pendingReveal.moveValue, salt: round.pendingReveal.salt });
      round.myRevealed = true;
      round.revealError = null;
      clearPendingReveal(round.caseId, account.address);
    } catch(err){
      logError('auto-reveal failed', err);
      round.revealError = String(err?.message ?? err);
    }
    changed = true;
  }
    if(round.game==='bluff' && round.role==='creator' && round.stage==='pending-call' && entry.hasRevealedB && entry.outcome === 0){
    // B has revealed something, and the case is still Unresolved — a
    // fold would have resolved it immediately, so this means B called.
    // Set stage before awaiting so a second poll tick mid-flight can't
    // fire this twice.
    round.stage = 'resolving';
    try {
      await submitRevealCard({ provider: account.provider, caseId: round.caseId, cardIndex: RANKS.indexOf(round.myCard), salt: round.cardSalt });
    } catch(err){ logError('bluff auto card-reveal failed', err); round.stage = 'pending-call'; }
    changed = true;
  }

  const deadlinePassed = round.moveDeadline && Date.now() >= round.moveDeadline;
  // Bluff resolves itself inline, inside reveal_action (on a fold) and
  // reveal_card (once both cards are in) — see the contract. Calling
  // resolve() before both cards are revealed just reverts
  // (MOVE_WINDOW_OPEN), which is exactly the premature signing prompt
  // this was causing. Only fall back to manual resolve() for Bluff once
  // the deadline has genuinely passed (abandoned showdown).
  const genericBothRevealed = round.game !== 'bluff' && entry.hasRevealedA && entry.hasRevealedB;
  if(entry.outcome === 0 && (genericBothRevealed || deadlinePassed) && !round.resolvePending){
    round.resolvePending = true;
    try { await submitResolve({ provider: account.provider, caseId: round.caseId }); }
    catch(err){
     const msg = String(err?.message ?? '').toUpperCase();
     if(msg.includes('ALREADY_RESOLVED')){
       log('submitResolve: the other player already resolved it, that\'s fine');
      } else {
        log('resolve call failed, will retry on next poll', err);
        round.resolvePending = false;
      }
    }
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

async function expireRound(round){
  round.stage = 'expired';
  if(round.role !== 'creator' || round.cancelledByMe) return;
  try {
    const secret = randomFelt();
    const claimHash = computeClaimHash(secret);
    await submitCancelCase({ provider: account.provider, caseId: round.caseId, claimHash });
    saveClaimSecret(round.caseId, account.address, secret);
    round.cancelledByMe = true;
    round.claimSecret = secret;
    touch(round.slug);
    // Refund is immediately claimable — no reason to make the user
    // click a second button for money that's already theirs.
    try {
      await submitClaim({ provider: account.provider, address: account.address, caseId: round.caseId, isPlayerA: true, claimSecret: secret });
      markClaimed(round);
      await refreshShieldedBalance();
      touch(round.slug);
    } catch(claimErr) {
      logError('auto-claim refund after auto-cancel failed', claimErr);
      // claimSecret stays set — renderExpiredPanel's existing manual
      // button becomes the fallback if this silently failed.
    }
  } catch(err) { logError('auto-cancel on expiry failed', err); }
}

setInterval(()=>{
  let needsRender = false;
  Object.values(MY_ROUNDS).forEach(round=>{
    if((round.stage==='waiting' || round.stage==='share') && Date.now()>=round.joinDeadline){
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
  pendingJoinCaseId: null,
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

    let shieldedBalance = null;
    try {
      const walletAccount = await buildWalletAccountV6(provider, address);
      const balances = await walletAccount.strk20Balances([STRK_ADDRESS]);
      const entry = balances.find((item) => BigInt(item.token) === BigInt(STRK_ADDRESS));
      shieldedBalance = entry ? Number(BigInt(entry.balance)) / 1e18 : 0;
      log('connectAccount: shielded STRK balance', { balances, shieldedBalance });
    } catch (balanceErr) {
      logError('could not read shielded STRK balance', balanceErr);
    }
    let sessionAccount = null;
    try {
      sessionAccount = await createSessionAccount(wallets[0].id, provider, address);
      if(sessionAccount) log('connectAccount: session account ready', wallets[0].name);
    } catch(err) {
      logError('connectAccount: session setup failed, continuing without session key', err);
      if(account) account.sessionAccount = null;
    }
    try { await rehydrateMyRounds(address); }
    catch(err) { logError('connectAccount: failed to rehydrate My Cases', err); }
    log('connectAccount: connected', { address, shieldedBalance, sessionAccount:!!sessionAccount });
    return { address, provider, shieldedBalance, sessionAccount };
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

let lastShieldedBalanceRefreshAt = 0;
let shieldedBalanceRefreshInFlight = null;

function saveProfile(){ if(account) localStorage.setItem(`hidden_profile_${account.address}`, JSON.stringify(PROFILE)); }
function loadProfile(){
  const raw = localStorage.getItem(`hidden_profile_${account.address}`);
  if(raw) PROFILE = JSON.parse(raw);
  else PROFILE.username = generateUsername();
  // The displayed balance is always the current wallet-reported shielded value;
  // never fall back to a stale locally persisted public-balance value.
  PROFILE.balance = account.shieldedBalance ?? 0;
}

async function refreshShieldedBalance(){
  if(!account) return;
  if(shieldedBalanceRefreshInFlight) return shieldedBalanceRefreshInFlight;
  const refreshAccount = account;
  shieldedBalanceRefreshInFlight = (async ()=>{
    try {
      const walletAccount = await buildWalletAccountV6(refreshAccount.provider, refreshAccount.address);
      const balances = await walletAccount.strk20Balances([STRK_ADDRESS]);
      const entry = balances.find((item) => BigInt(item.token) === BigInt(STRK_ADDRESS));
      const shieldedBalance = entry ? Number(BigInt(entry.balance)) / 1e18 : 0;
      if(account === refreshAccount){
        account.shieldedBalance = shieldedBalance;
        PROFILE.balance = shieldedBalance;
        saveProfile();
        renderSideProfile();
      }
      log('refreshShieldedBalance: shielded STRK balance', { balances, shieldedBalance });
    } catch(err){
      logError('refreshShieldedBalance failed', err);
    } finally {
      shieldedBalanceRefreshInFlight = null;
    }
  })();
  return shieldedBalanceRefreshInFlight;
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
    document.getElementById('sideConnectBtn').onclick = async ()=>{ account = await connectAccount(); if(account) loadProfile(); render(); loadBoard(); };
    return;
  }
  const winRate = PROFILE.gamesPlayed ? Math.round((PROFILE.wins/PROFILE.gamesPlayed)*100) : 0;
  el.innerHTML = `
    <div class="profile-card torn" id="sideProfileCard">
      <div class="p-name">${PROFILE.username}</div>
      <div class="p-title">${profileTitle()}</div>
      <div class="p-balance">${PROFILE.balance.toFixed(2)}<span class="p-balance-unit">STRK</span></div>
      ${PROFILE.balance === 0 ? '<div class="panel-hint">No shielded STRK yet — shield STRK in your wallet first.</div>' : ''}
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
    document.getElementById('fullConnectBtn').onclick = async ()=>{ account = await connectAccount(); if(account) loadProfile(); openProfile(); loadBoard(); };
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
      ${PROFILE.balance === 0 ? '<div class="panel-hint">No shielded STRK yet — shield STRK in your wallet first.</div>' : ''}
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
      <div class="panel-hint">Your STRK balance is read live from your own shielded wallet. Play stats (games, streaks, win rate) are stored only in this browser \u2014 not shared to any public leaderboard.</div>
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
  if(round.stage==='expired') return { text: round.cancelledByMe ? 'Cancelled by you' : 'Expired \u2014 refunded', urgent:false };
  return { text:round.stage, urgent:false };
}

function openMyCases(){
  const overlay = document.getElementById('myCasesOverlay');
  const rounds = Object.values(MY_ROUNDS).sort((a,b)=>b.createdAt-a.createdAt);
  const active = rounds.filter(r=>!['result','expired'].includes(r.stage));
  const done = rounds.filter(r=>['result','expired'].includes(r.stage));

  function rowHtml(round){
    const st = caseRowStatus(round);
    const canCancel = round.role==='creator' && (round.stage==='share' || round.stage==='waiting');
    return `
      <div class="mycase-row ${st.urgent?'needs-action':''}">
        <div class="mycase-top">
          <div class="mycase-game">${GAMES[round.game].name}</div>
          <div class="mycase-stake">${round.stake} STRK</div>
        </div>
        <div class="mycase-status ${st.urgent?'urgent':''}">${st.text}</div>
        <div style="display:flex; gap:8px; margin-top:8px;">
          <button class="btn3 small wide" data-open="${round.slug}">${st.urgent ? 'Move now' : ['result','expired'].includes(round.stage) ? 'View' : 'Resume'}</button>
          ${canCancel ? `<button class="btn3 outline small wide" data-cancel="${round.slug}">Cancel case</button>` : ''}
        </div>
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
    overlay.querySelectorAll('[data-cancel]').forEach(b=>{
    b.onclick = async (e)=>{
      e.stopPropagation();
      const round = MY_ROUNDS[b.dataset.cancel];
      if(!round) return;
      if(!confirm('Cancel this case? Nobody has joined yet, so this just closes it.')) return;
      b.textContent = 'Cancelling...'; b.disabled = true;
      try {
        const secret = randomFelt();
        const claimHash = computeClaimHash(secret);
        await submitCancelCase({ provider: account.provider, caseId: round.caseId, claimHash });
        saveClaimSecret(round.caseId, account.address, secret);
        if(round.pollTimer) clearInterval(round.pollTimer);
        round.stage = 'expired';
        round.cancelledByMe = true;
        round.claimSecret = secret;
        b.textContent = 'Claiming refund...';
        try {
          await submitClaim({ provider: account.provider, address: account.address, caseId: round.caseId, isPlayerA: true, claimSecret: secret });
          markClaimed(round);
          await refreshShieldedBalance();
        } catch(claimErr) {
          logError('auto-claim refund after manual cancel failed', claimErr);
        }
        openMyCases();
        updateMyCasesBadge();
      } catch(err) {
        logError('cancel case failed', err);
        alert('could not cancel the case, see console for details');
        b.textContent = 'Cancel case'; b.disabled = false;
      }
    };
  });
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
  const pending = state.pendingJoinCaseId;
  el.innerHTML = `
    <div class="section-label" style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
      <span>open cases \u2014 ${GAMES[state.game].name}</span>
      <button id="refreshBoardBtn" type="button" aria-label="Refresh open cases" title="Refresh open cases"
        style="width:22px;height:22px;min-width:22px;padding:0;display:inline-flex;align-items:center;justify-content:center;font-size:13px;line-height:1;border-radius:50%;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;flex-shrink:0;">↻</button>
    </div>
    ${pending ? `
      <div class="panel torn enter" style="margin-bottom:20px;">
        <div class="panel-title">You were sent a case</div>
        <div class="panel-hint">Case #${pending} is waiting for you.</div>
        <button class="btn3 wide" id="joinPendingBtn" style="margin-top:12px;">Join case #${pending}</button>
      </div>
    ` : ''}
    <div class="panel-hint" id="boardStatus" style="margin-bottom:16px;">Loading open cases from the chain...</div>
    <div class="board" id="boardGrid"></div>
      `;
  loadBoard();
  document.getElementById('refreshBoardBtn').onclick = ()=>loadBoard();
  if(pending){
    document.getElementById('joinPendingBtn').onclick = ()=>{
      state.pendingJoinCaseId = null; // clear immediately, this button only fires once
      joinCaseById(pending);
    };
  }
}

let boardLoadToken = 0;

async function loadBoard(){
  const myToken = ++boardLoadToken;
  const grid = document.getElementById('boardGrid');
  const status = document.getElementById('boardStatus');
  if(!grid) return;
  const myAddr = account ? normalizeAddress(account.address) : null;
  try {
    const cases = await fetchOpenCases(state.game);
    if(myToken !== boardLoadToken) return;
    if(document.getElementById('boardGrid') !== grid) return; // navigated away already
    status.textContent = cases.length
      ? 'Live from the chain.'
      : 'No open cases right now.';
    grid.innerHTML = `
      ${cases.map((c,i)=>{
        const isMine = myAddr && normalizeAddress(c.creator) === myAddr;
        return `
        <div class="case-card torn enter" style="animation-delay:${Math.min(i,6)*45}ms;">
          <div class="pin"></div>
          <div class="stake-big">${c.stakeDecimal}<span class="stake-unit">STRK</span></div>
          <div class="case-sub">case #${c.caseId}</div>
          ${isMine
            ? `<div class="panel-hint" style="margin-top:14px;">Your case \u2014 waiting for someone to join</div>`
            : `<button class="btn3 wide small" style="margin-top:14px;" data-case="${c.caseId}">Join</button>`
          }
        </div>
      `;}).join('')}
      <div class="create-card enter" id="createCard" style="animation-delay:${Math.min(cases.length,6)*45}ms;">
        <div class="plus">+</div>
        <div class="lbl">POST NEW CASE</div>
      </div>
    `;
    grid.querySelectorAll('[data-case]').forEach(b=>{
  b.onclick = ()=>{
    b.textContent = 'Joining...'; b.disabled = true;
    joinCaseById(b.dataset.case).finally(()=>{ b.textContent='Join'; b.disabled=false; });
  };
});
    document.getElementById('createCard').onclick = goToCreate;
  } catch(err) {
    logError('loadBoard failed', err);
    if(status) status.textContent = 'Could not load the board, check console for details.';
  }
}

let joinInFlight = null;

async function joinCaseById(caseIdRaw){
  if(!caseIdRaw) return;
  const key = String(caseIdRaw);
  if(joinInFlight === key) return;
  joinInFlight = key;
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
    await submitPrivacyDeposit({
      provider: account.provider,
      address: account.address,
      caseId,
      isPlayerA: false,
      stakeWei: entry.stakeAmount,
    });
    window.history.replaceState({}, '', window.location.pathname);
    const round = newRound({ game: state.game, stake: Number(entry.stakeAmount)/1e18, role:'joiner', caseId });
    round.moveDeadline = Date.now() + MOVE_WINDOW_MS;
    if(state.game==='assassin') await startAssassinRole(round);
    startCasePolling(round);
    openRound(round.slug);
  } catch(err) {
    logError('joinCaseById failed', err);
    alert('could not join that case, double check the ID and try again');
  } finally {
    joinInFlight = null;
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
    document.getElementById('lobbyConnectBtn').onclick = async ()=>{ account = await connectAccount(); if(account) loadProfile(); render(); loadBoard(); };
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
      <div class="panel-hint">This creates a real case on Starknet mainnet and deposits your stake from your shielded balance into the case. Anyone can find and join it from the open board.</div>
    </div>
  `;
  document.getElementById('backBtn').onclick = ()=> goToBoard();
  document.getElementById('stakeInput').oninput = (e)=>{
  d.stake = parseFloat(e.target.value)||0;
  const warn = document.getElementById('stakeWarning');
  if(warn) warn.style.display = (account?.shieldedBalance != null && d.stake > account.shieldedBalance) ? 'block' : 'none';
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
  const refundClaimable = round.cancelledByMe && round.claimSecret && !round.claimed;
  el.innerHTML = `
    <div class="panel torn enter">
      <div class="panel-title">Case expired</div>
      <div class="panel-hint">Nobody joined in time.</div>
      ${refundClaimable ? '<button class="btn3 wide" id="claimRefundBtn" style="margin-top:16px;">Claim refund</button>' : ''}
      <button class="btn3 wide" id="backBoardBtn" style="margin-top:16px;">Back to open cases</button>
    </div>
  `;
  if(refundClaimable){
    const claimBtn = document.getElementById('claimRefundBtn');
    claimBtn.onclick = async ()=>{
      claimBtn.disabled = true;
      claimBtn.textContent = 'Claiming...';
      try {
        await submitClaim({
          provider: account.provider,
          address: account.address,
          caseId: round.caseId,
          isPlayerA: true,
          claimSecret: round.claimSecret,
        });
        markClaimed(round);
        renderExpiredPanel(el, round);
      } catch(err){
        logError('refund claim failed', err);
        claimBtn.disabled = false;
        claimBtn.textContent = 'Claim refund';
        alert(`could not claim refund: ${err?.message ?? err}`);
      }
    };
  }
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
  } else if(round.myMoved && round.oppMoved){
    if(!round.pendingReveal && !round.myRevealed){
      statusHtml = `
        <div class="status-row"><span class="status-dot"></span>Both sides locked in</div>
        <div class="panel-hint" style="color:var(--stamp);">This browser lost the secret needed to reveal your move (likely cleared storage). This case can't resolve normally \u2014 treat it as a loss for demo purposes and start a new case.</div>
      `;
    } else if(round.revealError){
      statusHtml = `
        <div class="status-row"><span class="status-dot"></span>Both sides locked in</div>
        <div class="panel-hint" style="color:var(--stamp);">Reveal failed: ${round.revealError}</div>
        <button class="btn3 wide" id="retryRevealBtn" style="margin-top:10px;">Try revealing again</button>
      `;
    } else {
      statusHtml = `
        <div class="status-row"><span class="status-dot"></span>Both sides locked in</div>
        <div class="pulse-wrap" style="padding:20px 0 6px;">
          <div class="pulse-dot"></div>
          <div class="waiting-msg">Finalizing on-chain \u2014 this can take a few seconds.</div>
        </div>
      `;
    }
  } else if(round.game==='bluff' && round.role==='creator'){
    statusHtml = `
      <div class="status-row"><span class="status-dot"></span>Opponent connected</div>
      <div class="panel-hint">Bluff needs you to act first \u2014 bet or fold \u2014 before your opponent can respond. Come back anytime, they're waiting on you.</div>
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

  const retryBtn = document.getElementById('retryRevealBtn');
  if(retryBtn){
    retryBtn.onclick = async ()=>{
      retryBtn.disabled = true; retryBtn.textContent = 'Retrying...';
      try {
        await submitRevealMove({ provider: account.provider, caseId: round.caseId, moveValue: round.pendingReveal.moveValue, salt: round.pendingReveal.salt });
        round.myRevealed = true;
        round.revealError = null;
        clearPendingReveal(round.caseId, account.address);
      } catch(err){
        logError('manual reveal retry failed', err);
        round.revealError = String(err?.message ?? err);
      }
      render();
    };
  }
}

function renderSimulPlay(el, round){
  if(round.stage==='result'){ renderSimulResult(el, round); return; }
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
    btn.textContent = 'Checking case...'; btn.disabled = true;
    const moveIndex = cfg.options.findIndex(o=>o.id===picked);
    const salt = randomFelt();
    const secret = randomFelt();
    savePendingReveal(round.caseId, account.address, {
      kind: 'simul', moveValue: moveIndex, salt: salt.toString(), secret: secret.toString(),
    });
    try {
      const entry = await readCase(round.caseId);
      const iAmA = round.role === 'creator';
      const oppAlreadyCommitted = iAmA ? entry.hasCommittedB : entry.hasCommittedA;
      const commitHash = computeMoveHash(moveIndex, salt);

      if(oppAlreadyCommitted){
        // Second mover — safe to bundle commit + reveal in one signature,
        // since the opponent's move is already locked and can't change.
        btn.textContent = 'Submitting move...';
        await submitCommitAndReveal({ provider: account.provider, caseId: round.caseId, commitHash, claimSecret: secret, moveValue: moveIndex, salt });
        round.myMoved = true;
        round.myRevealed = true;
        clearPendingReveal(round.caseId, account.address);
      } else {
        // First mover — must commit alone; reveal has to wait until
        // polling sees the opponent commit too.
        btn.textContent = 'Submitting commitment...';
        await submitCommitMove({ provider: account.provider, caseId: round.caseId, commitHash, claimSecret: secret });
        round.pendingReveal = { moveValue: moveIndex, salt };
      }
      round.myMove = picked;
      round.claimSecret = secret;
      saveClaimSecret(round.caseId, account.address, secret);
      round.stage = 'matched';
      render();
    } catch(err) {
      logError('commit failed', err);
      alert('could not submit your move \u2014 if this happens again after refreshing, it may already be on-chain; reopen this case from My Cases before retrying.');
      btn.textContent='Lock move'; btn.disabled=false;
    }
  };
}

function renderSimulResult(el, round){
  const cfg = SIMUL_CONFIG[round.game];
  const myOpt = cfg.options.find(o=>o.id===round.myMove);
  const oppOpt = cfg.options.find(o=>o.id===round.oppMove);
  const outcome = round.outcome;
  const stampText = outcome==='win' ? 'CLEARED' : outcome==='tie' ? 'STALEMATE' : 'CASE LOST';
  const stampCls = outcome==='win' ? '' : outcome==='tie' ? 'tie' : 'lose';
  const claimable = roundIsClaimable(round);
  const claimMissing = !claimable && !round.claimed && (outcome==='win' || outcome==='tie') && !round.claimSecret;

  el.innerHTML = `
    <div class="panel torn enter">
      <div class="panel-title">Reveal</div>
      <div class="parties">
        <div class="party">
          <div class="who">YOU</div>
          <div class="reveal-glyph">${myOpt ? iconSpan(myOpt.icon,40) : '?'}</div>
          <div class="card-caption">${myOpt ? myOpt.label : '\u2014'}</div>
        </div>
        <div class="party">
          <div class="who">OPPONENT</div>
          <div class="reveal-glyph" style="animation-delay:150ms;">${oppOpt ? iconSpan(oppOpt.icon,40) : '?'}</div>
          <div class="card-caption">${oppOpt ? oppOpt.label : '\u2014'}</div>
        </div>
      </div>
      <div class="stamp-zone"><div class="stamp ${stampCls}" style="animation-delay:480ms;">${stampText}</div></div>
      <div class="result-line enter" style="animation-delay:750ms;">Pot: <b>${round.pot.toFixed(2)} STRK</b> \u2014 outcome recorded on-chain</div>
      ${claimMissing ? `<div class="panel-hint">This browser doesn't have the secret needed to claim — try connecting from the device you played on.</div>` : ''}
      <button class="btn3 wide enter" id="backBtn2" style="margin-top:16px; animation-delay:820ms;">${claimable ? 'Claim' : 'Back to board'}</button>
    </div>
  `;
  const backBtn = document.getElementById('backBtn2');
  if(claimable){
    backBtn.onclick = async ()=>{
      backBtn.disabled = true; backBtn.textContent = 'Claiming...';
      try {
        await submitClaim({ provider: account.provider, address: account.address, caseId: round.caseId, isPlayerA: round.role==='creator', claimSecret: round.claimSecret });
        markClaimed(round);
        await refreshShieldedBalance();
        renderSimulResult(el, round);
      } catch(err){
        logError('claim failed', err);
        backBtn.disabled = false; backBtn.textContent = 'Claim';
        alert(`could not claim: ${err?.message ?? err}`);
      }
    };
  } else backBtn.onclick = ()=> goToBoard();
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
        const actionSalt = randomFelt();
        const cardSalt = randomFelt();
        const actionCommit = computeActionHash(0, actionSalt);
        const cardCommit = computeCardHash(RANKS.indexOf(round.myCard), cardSalt);
        const secret = randomFelt();
        const claimHash = computeClaimHash(secret);

        if(round.role === 'creator'){
          // A always bundles commit + reveal-action into 1 signature —
          // A never has to wait on anyone before acting.
          await submitBundle({ provider: account.provider, calls: [
            { contract_address: CONTRACT_ADDRESS, entry_point: 'commit_move',
              calldata: [String(round.caseId), actionCommit.toString(), cardCommit.toString(), claimHash.toString()] },
            { contract_address: CONTRACT_ADDRESS, entry_point: 'reveal_action',
              calldata: [String(round.caseId), '0', actionSalt.toString()] },
          ]});
        } else {
          await submitCommitMove({ provider: account.provider, caseId: round.caseId, commitHash: actionCommit, cardCommit, claimSecret: secret });
          await submitRevealAction({ provider: account.provider, caseId: round.caseId, action: 0, salt: actionSalt });
        }
        round.claimSecret = secret;
        saveClaimSecret(round.caseId, account.address, secret);
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
        const actionSalt = randomFelt();
        const cardSalt = randomFelt();
        const actionCommit = computeActionHash(1, actionSalt);
        const cardCommit = computeCardHash(RANKS.indexOf(round.myCard), cardSalt);
        const secret = randomFelt();
        const claimHash = computeClaimHash(secret);

        if(round.role === 'creator'){
          // A bundles commit + reveal-action. Card stays sealed —
          // nothing to bundle it with yet, since B hasn't acted.
          await submitBundle({ provider: account.provider, calls: [
            { contract_address: CONTRACT_ADDRESS, entry_point: 'commit_move',
              calldata: [String(round.caseId), actionCommit.toString(), cardCommit.toString(), claimHash.toString()] },
            { contract_address: CONTRACT_ADDRESS, entry_point: 'reveal_action',
              calldata: [String(round.caseId), '1', actionSalt.toString()] },
          ]});
          round.cardSalt = cardSalt;
          round.stage = 'pending-call';
        } else {
          // B: bundle commit + reveal-action + reveal-card in ONE
          // signature. Safe — A's action is already locked by the time
          // B is allowed to act at all (enforced on-chain in commit_move).
          await submitBundle({ provider: account.provider, calls: [
            { contract_address: CONTRACT_ADDRESS, entry_point: 'commit_move',
              calldata: [String(round.caseId), actionCommit.toString(), cardCommit.toString(), claimHash.toString()] },
            { contract_address: CONTRACT_ADDRESS, entry_point: 'reveal_action',
              calldata: [String(round.caseId), '1', actionSalt.toString()] },
            { contract_address: CONTRACT_ADDRESS, entry_point: 'reveal_card',
              calldata: [String(round.caseId), String(RANKS.indexOf(round.myCard)), cardSalt.toString()] },
          ]});
          round.stage = 'resolving';
        }
        round.claimSecret = secret;
        saveClaimSecret(round.caseId, account.address, secret);
        round.betLog.push({who:'you',action: actionLabel});
        round.myMoved = true; round.myRevealed = true;
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
  const claimable = roundIsClaimable(round);
  const claimMissing = !claimable && !round.claimed && (outcome==='win' || outcome==='tie') && !round.claimSecret;

  el.innerHTML = `
    <div class="panel torn enter">
      <div class="panel-title">Showdown</div>
      <div class="bet-log">${renderBetLog(round)}</div>
      ${cardsHtml}
      <div class="stamp-zone"><div class="stamp ${stampCls}" style="animation-delay:480ms;">${stampText}</div></div>
      <div class="result-line enter" style="animation-delay:750ms;">Pot: <b>${round.pot.toFixed(2)} STRK</b> \u2014 outcome recorded on-chain</div>
      ${claimMissing ? `<div class="panel-hint">This browser doesn't have the secret needed to claim — try connecting from the device you played on.</div>` : ''}
      <button class="btn3 wide enter" id="backBtn2" style="margin-top:16px; animation-delay:820ms;">${claimable ? 'Claim' : 'Back to board'}</button>
    </div>
  `;
  const backBtn = document.getElementById('backBtn2');
  if(claimable){
    backBtn.onclick = async ()=>{
      backBtn.disabled = true; backBtn.textContent = 'Claiming...';
      try {
        await submitClaim({ provider: account.provider, address: account.address, caseId: round.caseId, isPlayerA: round.role==='creator', claimSecret: round.claimSecret });
        markClaimed(round);
        await refreshShieldedBalance();
        renderBluffResult(el, round);
      } catch(err){
        logError('claim failed', err);
        backBtn.disabled = false; backBtn.textContent = 'Claim';
        alert(`could not claim: ${err?.message ?? err}`);
      }
    };
  } else backBtn.onclick = ()=> goToBoard();
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
      lockBtn.textContent = 'Checking case...'; lockBtn.disabled = true;
      const moveValue = packTiles(picks[0], picks[1], picks[2]);
      const salt = randomFelt();
      const secret = randomFelt();
      savePendingReveal(round.caseId, account.address, {
        kind: 'simul', moveValue: moveValue.toString(), salt: salt.toString(), secret: secret.toString(),
      });
      try {
        const entry = await readCase(round.caseId);
        const iAmA = round.role === 'creator';
        const oppAlreadyCommitted = iAmA ? entry.hasCommittedB : entry.hasCommittedA;
        const commitHash = computeMoveHash(moveValue, salt);

        if(oppAlreadyCommitted){
          lockBtn.textContent = 'Submitting move...';
          await submitCommitAndReveal({ provider: account.provider, caseId: round.caseId, commitHash, claimSecret: secret, moveValue, salt });
          round.myMoved = true;
          round.myRevealed = true;
          clearPendingReveal(round.caseId, account.address);
        } else {
          lockBtn.textContent = 'Submitting commitment...';
          await submitCommitMove({ provider: account.provider, caseId: round.caseId, commitHash, claimSecret: secret });
          round.pendingReveal = { moveValue, salt };
        }
        round.myPicks = picks.slice();
        round.claimSecret = secret;
        saveClaimSecret(round.caseId, account.address, secret);
        round.stage = 'matched';
        render();
      } catch(err) {
        logError('assassin commit failed', err);
        alert('could not submit your move \u2014 if this happens again after refreshing, it may already be on-chain; reopen this case from My Cases before retrying.');
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
    // Always describe what happened to the TARGET, regardless of which
    // role you played, so the stamp reads the same real-world event from
   // both sides instead of two generic, context-free words.
  const targetWasCaught = round.myRole==='assassin' ? outcome==='win' : outcome==='lose';
  const stampText = round.myRole==='assassin'
    ? (targetWasCaught ? 'TARGET CAUGHT' : 'TARGET ESCAPED')
    : (targetWasCaught ? 'CAUGHT BY ASSASSIN' : 'ESCAPED ASSASSIN');
  const stampCls = outcome==='win'?'':outcome==='lose'?'lose':'tie';
  const claimable = roundIsClaimable(round);
  const claimMissing = !claimable && !round.claimed && (outcome==='win' || outcome==='tie') && !round.claimSecret;

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
      ${claimMissing ? `<div class="panel-hint">This browser doesn't have the secret needed to claim — try connecting from the device you played on.</div>` : ''}
      <button class="btn3 wide enter" id="backBtn2" style="margin-top:16px; animation-delay:850ms;">${claimable ? 'Claim' : 'Back to board'}</button>
    </div>
  `;
  const backBtn = document.getElementById('backBtn2');
  if(claimable){
    backBtn.onclick = async ()=>{
      backBtn.disabled = true; backBtn.textContent = 'Claiming...';
      try {
        await submitClaim({ provider: account.provider, address: account.address, caseId: round.caseId, isPlayerA: round.role==='creator', claimSecret: round.claimSecret });
        markClaimed(round);
        await refreshShieldedBalance();
        renderAssassinResult(el, round);
      } catch(err){
        logError('claim failed', err);
        backBtn.disabled = false; backBtn.textContent = 'Claim';
        alert(`could not claim: ${err?.message ?? err}`);
      }
    };
  } else backBtn.onclick = ()=> goToBoard();
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
    const createdEntry = await readCase(caseId);
    await submitPrivacyDeposit({
      provider: account.provider,
      address: account.address,
      caseId,
      isPlayerA: true,
      stakeWei: createdEntry.stakeAmount,
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

window.tryDryRun = async function(caseId, stakeWei){
  if(!account){ console.log('connect a wallet through the app first'); return; }
  const walletAccount = await buildWalletAccountV6(account.provider, account.address);

  const actions = [
    { type: 'withdraw', token: toCanonicalFelt(STRK_ADDRESS), amount: toFelt(stakeWei), recipient: toCanonicalFelt(CONTRACT_ADDRESS) },
    { type: 'invoke', contract: toCanonicalFelt(CONTRACT_ADDRESS), calldata: [
      toFelt(0),
      toFelt(caseId),
      toFelt(1),
      toCanonicalFelt(STRK_ADDRESS),
      toFelt(stakeWei),
      toFelt(0),
      toFelt(0),
    ]},
  ];
  console.log('sending this to the pool:', actions);
  const result = await walletAccount.strk20PrepareInvoke(actions, true);
  console.log('RESULT:', result);
  return result;
};

window.debugCreateCase = submitCreateCase;
window.debugReadCase = readCase;
window.debugSubmitClaim = submitClaim;
window.debugLoadClaimSecret = loadClaimSecret;
window.debugGetAccount = () => account;

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

    // Already matched or resolved — this link no longer means "come
    // join an open case." Strip it so a reload/bookmark can't
    // re-trigger the join banner; My Cases (once wallet connects)
    // will surface it normally if it's actually this wallet's case.
    if(entry.opponent !== 0n || entry.outcome !== 0){
      window.history.replaceState({}, '', window.location.pathname);
      state.view = 'board';
      render();
      return;
    }

    state.view = 'board';
    state.pendingJoinCaseId = caseIdRaw;
    render();
  } catch(err) {
    log('checkUrlForCase: could not preload case from URL', err);
  }
}

log('HIDDEN app loaded, contract:', CONTRACT_ADDRESS);
render();
checkUrlForCase();
