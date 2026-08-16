// HIDDEN — app.js
// Chain calls are stubbed — see connectWallet/commitMove/resolvePot near
// the bottom. Swap for real strk20InvokeTransaction calls once contracts
// are deployed. (placeholder-calldata pattern: strk20-by-example.org/
// starknet-wallet-api/private-defi)
//
// Timers use real wall-clock durations (a 24h join window really counts
// down 24h if you leave the tab open), but since there's no backend yet,
// the "opponent" on every round is simulated locally and acts within
// seconds so the demo stays testable — see scheduleMockOpponent() below.
// None of this survives a page reload; that needs the real contract or a
// backend behind it, not this mock.

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
    resolve(my,opp){ if(my===opp) return 'tie'; const beats={rock:'scissors',paper:'rock',scissors:'paper'}; return beats[my]===opp?'win':'lose'; },
    resultCopy(outcome,my,opp){ const l=id=>SIMUL_CONFIG.rps.options.find(o=>o.id===id).label; return `${l(my)} vs ${l(opp)}`; },
  },
  pd: {
    options: [
      {id:'trust', icon:'handshake', label:'TRUST', sub:'cooperate'},
      {id:'betray', icon:'dagger', label:'BETRAY', sub:'defect'},
    ],
    cols:2,
    chooseCopy:'Neither of you will know the other\u2019s choice until both are committed.',
    lockCopy:'Your choice is sealed as a commitment hash. Trust is a bet on someone you cannot currently see.',
    resolve(my,opp){ if(my===opp) return 'tie'; return my==='betray'?'win':'lose'; },
    resultCopy(outcome,my,opp){
      if(my===opp && my==='trust') return 'Both parties trusted. Stakes returned in full.';
      if(my===opp && my==='betray') return 'Both parties betrayed. Pot split \u2014 nobody got the edge.';
      return outcome==='win' ? 'You betrayed a trusting opponent.' : 'You trusted, and were betrayed.';
    },
  },
};

const RANKS = [2,3,4,5,6,7,8,9,10,'J','Q','K','A'];
function rankValue(r){ return typeof r==='number' ? r : {J:11,Q:12,K:13,A:14}[r]; }
function drawCard(){ return RANKS[Math.floor(Math.random()*RANKS.length)]; }

// generated handle, not "agent_xyz" — word list is demo-scale (a few
// hundred combos), a real version needs a bigger list and/or longer
// suffix to stay collision-resistant
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
function caseLink(slug){ return `hidden.app/c/${slug}`; }

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
// fixed once matched, not creator-configurable in v1 — only the join
// window is (per spec). easy to expose as a setting later
const MOVE_WINDOW_MS = 24*60*60*1000;

// public board, seeded with a couple placeholder rows so it's not empty
// in this mock — replace with real backend data before launch
const CASES = {
  rps:      [ {slug:randomSlug(), stake:1}, {slug:randomSlug(), stake:0.5} ],
  pd:       [ {slug:randomSlug(), stake:1} ],
  bluff:    [ {slug:randomSlug(), stake:5}, {slug:randomSlug(), stake:1} ],
  assassin: [ {slug:randomSlug(), stake:1} ],
};

// every case the current user has created or joined, kept for this
// session and resumable via My Cases
let MY_ROUNDS = {}; // slug -> round

function newRound({game, stake, role, joinMs}){
  const slug = randomSlug();
  const round = {
    slug, game, stake, role, // role: 'creator' | 'joiner'
    stage: role==='creator' ? 'share' : 'matched',
    createdAt: Date.now(),
    joinDeadline: Date.now() + (joinMs||0),
    filledAt: role==='joiner' ? Date.now() : null,
    moveDeadline: role==='joiner' ? Date.now()+MOVE_WINDOW_MS : null,
    myMoved:false, oppMoved:false,
    myMove:null, oppMove:null,               // simul
    myCard:null, oppCard:null, pot:0, betLog:[], outcomeKind:null, // bluff
    myRole:null, myPicks:[], oppPicks:[],     // assassin
    outcome:null, recorded:false,
  };
  MY_ROUNDS[slug] = round;
  return round;
}

function dealBluffCards(round){ round.myCard=drawCard(); round.oppCard=drawCard(); round.pot=round.stake*2; }
function startAssassinRole(round){
  // real version should derive role from the first bit of
  // poseidon(commitmentA, commitmentB) — neither player controls both
  // commitments, so neither can bias their own role. coin flip for now
  // since there's no real commitment yet
  round.myRole = Math.random()<0.5 ? 'assassin' : 'target';
}

// simulates the other side of a round acting on its own schedule, so My
// Cases has something real to resume into even if you switch tabs
function scheduleMockOpponent(round){
  if(round.role==='creator'){
    const joinDelay = 2500 + Math.random()*4000;
    setTimeout(()=>{
      if(round.stage==='expired' || round.stage==='resolved') return;
      const list = CASES[round.game];
      const i = list.findIndex(c=>c.slug===round.slug);
      if(i>-1) list.splice(i,1);
      round.filledAt = Date.now();
      round.moveDeadline = Date.now() + MOVE_WINDOW_MS;
      if(round.stage==='waiting' || round.stage==='share') round.stage='matched';
      maybeScheduleOpponentMove(round, 2000 + Math.random()*5000);
      touch(round.slug);
    }, joinDelay);
  } else {
    // joiner: the creator may realistically have already moved while
    // waiting for someone to join, so simulate that split
    if(Math.random() < 0.4){ setOpponentMove(round); }
    else { maybeScheduleOpponentMove(round, 3000 + Math.random()*6000); }
  }
}

function maybeScheduleOpponentMove(round, delay){
  setTimeout(()=>{
    if(round.stage==='expired' || round.stage==='resolved' || round.oppMoved) return;
    setOpponentMove(round);
    touch(round.slug);
  }, delay);
}

function setOpponentMove(round){
  round.oppMoved = true;
  const engine = GAMES[round.game].engine;
  if(engine==='simul'){
    const opts = SIMUL_CONFIG[round.game].options;
    round.oppMove = opts[Math.floor(Math.random()*opts.length)].id;
  } else if(engine==='bluff'){
    if(!round.oppCard) dealBluffCards(round);
  } else if(engine==='assassin'){
    const all=[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15];
    round.oppPicks = all.sort(()=>Math.random()-0.5).slice(0,3);
  }
  if(round.myMoved) resolveRound(round);
}

// re-render if the round currently on screen just changed underneath us
function touch(slug){ if(state.activeSlug===slug) render(); updateMyCasesBadge(); if(document.getElementById('myCasesOverlay').classList.contains('open')) openMyCases(); }

// resolution logic shared across all four engines
function resolveRound(round){
  if(round.recorded) return;
  const engine = GAMES[round.game].engine;
  let label, delta;

  if(engine==='simul'){
    const outcome = SIMUL_CONFIG[round.game].resolve(round.myMove, round.oppMove);
    round.outcome = outcome;
    label = outcome;
    delta = outcome==='win' ? round.stake : outcome==='lose' ? -round.stake : 0;
  } else if(engine==='bluff'){
    const mine=rankValue(round.myCard), theirs=rankValue(round.oppCard);
    const outcome = mine===theirs?'tie':mine>theirs?'win':'lose';
    round.outcome = outcome;
    label = outcome;
    delta = outcome==='win' ? round.stake : outcome==='lose' ? -round.stake : 0;
  } else {
    const assassinPicks = round.myRole==='assassin' ? round.myPicks : round.oppPicks;
    const targetPicks = round.myRole==='target' ? round.myPicks : round.oppPicks;
    const overlap = assassinPicks.filter(t=>targetPicks.includes(t));
    const tier = overlap.length===0 ? 'escape' : overlap.length===1 ? 'graze' : 'kill';
    const outcome = round.myRole==='assassin' ? (tier==='escape'?'lose':tier==='graze'?'partial':'win') : (tier==='escape'?'win':tier==='graze'?'partial':'lose');
    round.outcome = outcome;
    round.tier = tier;
    const myShare = tier==='escape' ? (round.myRole==='target'?1:0) : tier==='kill' ? (round.myRole==='assassin'?1:0) : (round.myRole==='assassin'?0.65:0.35);
    round.myShare = myShare;
    label = outcome==='partial' ? 'tie' : outcome;
    delta = (round.stake*2*myShare) - round.stake;
  }

  round.stage = 'result';
  round.recorded = true;
  recordResult(round.game, round.stake, label, delta);
}

// forfeit/timeout resolution for the move window
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
  } else {
    resolveRound(round);
  }
}

function expireRound(round){
  round.stage = 'expired';
  PROFILE.balance += round.stake; // refund
  const list = CASES[round.game];
  const i = list.findIndex(c=>c.slug===round.slug);
  if(i>-1) list.splice(i,1);
}

// checks every round for expired join/move windows once a second
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

let state = {
  game:'rps',
  view:'board',       // 'board' | 'lobby'  (used when activeSlug is null)
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

// in-memory only, resets on reload since there's no wallet/backend wired
// up yet. real version should read/write against the connected wallet's
// own history, never a server that could link identity to play history —
// that'd defeat the point of shielding balances in the first place
let PROFILE = {
  username: generateUsername(),
  balance: 12.4,
  gamesPlayed:0, wins:0, losses:0, ties:0,
  totalStaked:0, totalWon:0,
  currentStreak:0, bestStreak:0,
  gameCounts:{ rps:0, pd:0, bluff:0, assassin:0 },
};

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
}

function renderSideProfile(){
  const el = document.getElementById('sideProfile');
  if(!el) return;
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
  if(['choose','locked','dealt','pending-call','showdown','picking'].includes(round.stage)) return { text:'In progress \u2014 resume to continue', urgent:false };
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

function renderBoard(el){
  const cases = CASES[state.game];
  el.innerHTML = `
    <div class="section-label">open cases \u2014 ${GAMES[state.game].name}</div>
    <div class="board">
      ${cases.map((c,i)=>`
        <div class="case-card torn enter" style="animation-delay:${Math.min(i,6)*45}ms;">
          <div class="pin"></div>
          <div class="stake-big">${c.stake}<span class="stake-unit">STRK</span></div>
          <div class="case-sub">stake \u00b7 open case</div>
          <button class="btn3 wide small" style="margin-top:14px;" data-i="${i}">Join</button>
        </div>
      `).join('')}
      <div class="create-card enter" id="createCard" style="animation-delay:${Math.min(cases.length,6)*45}ms;">
        <div class="plus">+</div>
        <div class="lbl">POST NEW CASE</div>
      </div>
    </div>
  `;
  el.querySelectorAll('[data-i]').forEach(b=>{ b.onclick = ()=> joinBoardCase(parseInt(b.dataset.i,10)); });
  document.getElementById('createCard').onclick = goToCreate;
}

function joinBoardCase(index){
  const list = CASES[state.game];
  const c = list[index];
  if(!c) return;
  list.splice(index,1);
  const round = newRound({ game: state.game, stake: c.stake, role:'joiner' });
  const engine = GAMES[state.game].engine;
  if(engine==='assassin') startAssassinRole(round);
  scheduleMockOpponent(round);
  openRound(round.slug);
}

function renderLobby(el){
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

      <button class="btn3 wide" id="createBtn" style="margin-top:20px;">Connect wallet &amp; post case</button>
      <div class="panel-hint">Stake shields on deposit \u2014 the pool sees an amount arrive, not which wallet sent it. If nobody joins before your timer runs out, you're refunded automatically.</div>
    </div>
  `;
  document.getElementById('backBtn').onclick = ()=> goToBoard();
  document.getElementById('stakeInput').oninput = (e)=>{ d.stake = parseFloat(e.target.value)||0; };
  el.querySelectorAll('#joinChips .chip[data-ms]').forEach(c=>{
    c.onclick = ()=>{ d.customOn=false; d.joinMs=parseInt(c.dataset.ms,10); render(); };
  });
  document.getElementById('customChip').onclick = ()=>{ d.customOn=true; render(); };
  if(d.customOn){
    document.getElementById('customVal').oninput = (e)=>{ d.customVal = parseFloat(e.target.value)||1; };
    document.getElementById('customUnit').onchange = (e)=>{ d.customUnit = e.target.value; };
  }
  document.getElementById('createBtn').onclick = connectWallet;
}

// dispatches on round.stage
function renderRound(el, round){
  if(round.stage==='share'){ renderSharePanel(el, round); return; }
  if(round.stage==='waiting'){ renderWaitingPanel(el, round); return; }
  if(round.stage==='matched'){ renderMatchedPanel(el, round); return; }
  if(round.stage==='expired'){ renderExpiredPanel(el, round); return; }

  const engine = GAMES[round.game].engine;
  if(engine==='simul') renderSimulPlay(el, round);
  else if(engine==='bluff') renderBluffPlay(el, round);
  else renderAssassinPlay(el, round);
}

function renderSharePanel(el, round){
  el.innerHTML = `
    <div class="panel torn enter">
      <div class="panel-title">Case is live</div>
      <div class="share-hero">
        <div class="panel-hint" style="text-align:center;">Share this directly with someone to fill it fast \u2014 or leave it on the open board and wait.</div>
        <div class="big-link">${caseLink(round.slug)}</div>
        <div class="share-actions">
          <button class="btn3 wide" id="shareBtn">Share link</button>
          <button class="btn3 outline wide" id="waitBtn">I'll wait on the board</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById('shareBtn').onclick = async (e)=>{
    if(navigator.share){ try{ await navigator.share({ url:'https://'+caseLink(round.slug), title:'HIDDEN', text:`Join my ${GAMES[round.game].name} case on HIDDEN` }); }catch(err){} }
    else { navigator.clipboard?.writeText(caseLink(round.slug)).catch(()=>{}); e.target.textContent='Copied'; setTimeout(()=>{e.target.textContent='Share link';},1400); }
  };
  document.getElementById('waitBtn').onclick = ()=>{ round.stage='waiting'; render(); };
}

function renderWaitingPanel(el, round){
  el.innerHTML = `
    <div class="panel torn enter">
      <div class="pulse-wrap">
        <div class="pulse-dot"></div>
        <div class="waiting-msg">Watching for someone to join case ${round.slug.slice(0,6)}...<br><span class="countdown" id="joinCountdown">${formatCountdown(round.joinDeadline-Date.now())}</span> left to join</div>
      </div>
      <div class="link-box">
        <code>${caseLink(round.slug)}</code>
        <button class="btn3 small" id="copyBtn">Copy</button>
      </div>
      <div class="panel-hint">If nobody joins before the timer runs out, you're refunded automatically \u2014 no action needed.</div>
      <button class="btn3 outline wide" id="cancelBtn" style="margin-top:16px;">Cancel &amp; reclaim stake now</button>
    </div>
  `;
  document.getElementById('copyBtn').onclick = (e)=>{
    navigator.clipboard?.writeText(caseLink(round.slug)).catch(()=>{});
    e.target.textContent='Copied'; setTimeout(()=>{e.target.textContent='Copy';},1400);
  };
  document.getElementById('cancelBtn').onclick = ()=>{ expireRound(round); goToBoard(); };
}

function renderExpiredPanel(el, round){
  el.innerHTML = `
    <div class="panel torn enter">
      <div class="panel-title">Case expired</div>
      <div class="panel-hint">Nobody joined in time. Your ${round.stake} STRK stake has been refunded to your shielded balance.</div>
      <button class="btn3 wide" id="backBoardBtn" style="margin-top:16px;">Back to open cases</button>
    </div>
  `;
  document.getElementById('backBoardBtn').onclick = ()=> goToBoard();
}

function renderMatchedPanel(el, round){
  const urgent = needsMyAttention(round);
  let statusHtml;
  if(urgent){
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
      ${!round.myMoved ? `<button class="btn3 wide" id="moveBtn" style="margin-top:14px;">Make your move</button>` : ''}
      <button class="btn3 outline wide" id="laterBtn" style="margin-top:${round.myMoved?'14':'10'}px;">Back to board (resume later)</button>
    </div>
  `;
  if(!round.myMoved){
    document.getElementById('moveBtn').onclick = ()=>{
      const engine = GAMES[round.game].engine;
      if(engine==='simul') round.stage='choose';
      else if(engine==='bluff'){ if(!round.myCard) dealBluffCards(round); round.stage='dealt'; }
      else { if(!round.myRole) startAssassinRole(round); round.stage='picking'; }
      render();
    };
  }
  document.getElementById('laterBtn').onclick = ()=> goToBoard();
}

// RPS + Prisoner's Dilemma
function renderSimulPlay(el, round){
  const cfg = SIMUL_CONFIG[round.game];

  if(round.stage==='choose'){
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
    document.getElementById('lockBtn').onclick = ()=> commitMove(()=>{
      round.myMove = picked; round.myMoved = true;
      if(round.oppMoved) resolveRound(round); else round.stage='matched';
      render();
    });
  }
}

function renderBluffPlay(el, round){
  if(round.stage==='dealt'){
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
          <button class="btn3" id="betBtn">BET</button>
        </div>
        <div class="panel-hint">Bet, and your opponent has to decide whether to call without seeing your card. Fold, and you forfeit your ante now.</div>
      </div>
    `;
    document.getElementById('foldBtn').onclick = ()=>{
      round.betLog.push({who:'you',action:'FOLD'});
      round.myMoved = true; round.outcomeKind='fold-self';
      round.stage='result'; recordBluffResult(round); render();
    };
    document.getElementById('betBtn').onclick = ()=>{
      round.betLog.push({who:'you',action:'BET'});
      round.myMoved = true;
      round.stage='pending-call'; render();
      // opponent's call/fold response, kept as a short simulated exchange
      // rather than its own async window
      setTimeout(()=>{
        const oppStrength = rankValue(round.oppCard || (round.oppCard=drawCard()));
        const callChance = 0.35 + (oppStrength/14)*0.5;
        const calls = Math.random() < callChance;
        round.betLog.push({who:'them', action: calls?'CALL':'FOLD'});
        if(calls){ round.stage='showdown'; } else { round.outcomeKind='fold-opp'; round.stage='result'; }
        recordBluffResult(round);
        render();
      }, 1500);
    };
  }
  else if(round.stage==='pending-call'){
    el.innerHTML = `
      <div class="panel torn enter">
        <div class="panel-title">Opponent deciding</div>
        <div class="bet-log">${renderBetLog(round)}</div>
        <div class="pulse-wrap">
          <div class="pulse-dot"></div>
          <div class="waiting-msg">Opponent is deciding whether to call your bet...</div>
        </div>
      </div>
    `;
  }
  else if(round.stage==='result'){ renderBluffResult(el, round); }
}

function renderBetLog(round){
  return round.betLog.map(b=>`<div class="${b.who==='them'?'them':''}">${b.who==='them'?'OPPONENT':'YOU'} &rarr; ${b.action}</div>`).join('');
}

function recordBluffResult(round){
  if(round.recorded) return;
  let outcome;
  if(round.stage==='showdown'){
    const mine=rankValue(round.myCard), theirs=rankValue(round.oppCard);
    outcome = mine===theirs?'tie':mine>theirs?'win':'lose';
  } else if(round.outcomeKind==='fold-opp'){ outcome='win'; }
  else { outcome='lose'; }
  round.outcome = outcome;
  round.recorded = true;
  const delta = outcome==='win'?round.stake:outcome==='lose'?-round.stake:0;
  recordResult(round.game, round.stake, outcome, delta);
}

function renderBluffResult(el, round){
  const outcome = round.outcome;
  let cardsHtml;
  if(round.outcomeKind==='fold-opp'){
    cardsHtml = `<div class="parties">
      <div class="party"><div class="who">YOU</div><div class="reveal-glyph">${round.myCard}</div></div>
      <div class="party"><div class="who">OPPONENT</div><div class="redaction"><span class="lockglyph">FOLDED</span></div></div>
    </div>`;
  } else if(round.outcomeKind==='fold-self'){
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
  const potLine = outcome==='win'?'&rarr; credited to your shielded balance':outcome==='tie'?'&rarr; both antes refunded':'&rarr; credited to opponent\u2019s shielded balance';

  el.innerHTML = `
    <div class="panel torn enter">
      <div class="panel-title">Showdown</div>
      <div class="bet-log">${renderBetLog(round)}</div>
      ${cardsHtml}
      <div class="stamp-zone"><div class="stamp ${stampCls}" style="animation-delay:480ms;">${stampText}</div></div>
      <div class="result-line enter" style="animation-delay:750ms;">Pot: <b>${round.pot.toFixed(2)} STRK</b> ${potLine}</div>
      <button class="btn3 wide enter" id="claimBtn" style="margin-top:16px; animation-delay:820ms;">${outcome==='lose'?'Back to board':'Claim &amp; back to board'}</button>
    </div>
  `;
  document.getElementById('claimBtn').onclick = ()=>{
    if(outcome==='lose'){ goToBoard(); } else { resolvePot(()=> goToBoard()); }
  };
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
    lockBtn.onclick = ()=> commitMove(()=>{
      round.myPicks = picks.slice(); round.myMoved = true;
      if(round.oppMoved) resolveRound(round); else round.stage='matched';
      render();
    });
  }
  else if(round.stage==='result'){ renderAssassinResult(el, round); }
}

function renderAssassinResult(el, round){
  const assassinPicks = round.myRole==='assassin' ? round.myPicks : round.oppPicks;
  const targetPicks = round.myRole==='target' ? round.myPicks : round.oppPicks;
  const overlap = assassinPicks.filter(t=>targetPicks.includes(t));
  const tier = round.tier;
  const outcome = round.outcome;
  const stampText = tier==='escape'?'ESCAPED':tier==='graze'?'GRAZED':'CAUGHT';
  const stampCls = outcome==='win'?'':outcome==='lose'?'lose':'tie';
  const myPayout = (round.stake*2*round.myShare).toFixed(2);

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
        Your share: <b>${myPayout} STRK</b> of a ${(round.stake*2).toFixed(2)} STRK pot
      </div>
      <button class="btn3 wide enter" id="claimBtn" style="margin-top:16px; animation-delay:850ms;">${round.myShare===0?'Back to board':'Claim &amp; back to board'}</button>
    </div>
  `;
  document.getElementById('claimBtn').onclick = ()=>{
    if(round.myShare===0){ goToBoard(); } else { resolvePot(()=> goToBoard()); }
  };
}

// stubbed chain calls, wire these up to real STRK20 SDK calls once contracts are deployed
function connectWallet(){
  const btn = document.getElementById('createBtn');
  btn.textContent = 'Connecting...'; btn.disabled = true;
  setTimeout(()=>{
    const d = state.draft;
    const joinMs = d.customOn ? d.customVal*(d.customUnit==='hours'?3600000:60000) : d.joinMs;
    const round = newRound({ game: state.game, stake: d.stake, role:'creator', joinMs });
    CASES[state.game].push({ slug: round.slug, stake: round.stake });
    scheduleMockOpponent(round);
    openRound(round.slug);
  }, 700);
}
function commitMove(done){
  const btn = document.getElementById('lockBtn');
  if(btn){ btn.textContent='Submitting commitment...'; btn.disabled=true; }
  setTimeout(done, 700);
}
function resolvePot(done){
  const btn = document.getElementById('claimBtn');
  if(btn){ btn.textContent='Claiming into shielded balance...'; btn.disabled=true; }
  setTimeout(done, 700);
}

document.getElementById('profileTrigger').onclick = openProfile;
document.getElementById('myCasesTrigger').onclick = openMyCases;
document.getElementById('profileOverlay').addEventListener('click', (e)=>{ if(e.target.id==='profileOverlay') closeProfile(); });
document.getElementById('myCasesOverlay').addEventListener('click', (e)=>{ if(e.target.id==='myCasesOverlay') closeMyCases(); });
document.addEventListener('keydown', (e)=>{ if(e.key==='Escape'){ closeProfile(); closeMyCases(); } });

render();
