// HIDDEN — game logic + UI. Chain calls at the bottom are still stubbed,
// swap them for real strk20InvokeTransaction calls once contracts are live.
// (placeholder-calldata pattern: strk20-by-example.org/starknet-wallet-api/private-defi)

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

// public board, seeded with a couple rows so it's not empty in the demo —
// swap for real data once there's a backend/indexer behind it
const SLUG_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function randomSlug(len=11){ let s=''; for(let i=0;i<len;i++) s+=SLUG_CHARS[Math.floor(Math.random()*SLUG_CHARS.length)]; return s; }
function caseLink(slug){ return `hidden.app/c/${slug}`; }

const CASES = {
  rps:      [ {slug:randomSlug(), stake:1}, {slug:randomSlug(), stake:0.5} ],
  pd:       [ {slug:randomSlug(), stake:1} ],
  bluff:    [ {slug:randomSlug(), stake:5}, {slug:randomSlug(), stake:1} ],
  assassin: [ {slug:randomSlug(), stake:1} ],
};

let state = {
  game:'rps',
  stage:'board',
  stake:1,
  mySlug:null,
  myMove:null, oppMove:null,
  myCard:null, oppCard:null, pot:0, betLog:[],
  myRole:null, myPicks:[], oppPicks:[], recorded:false,
};

function freshState(sameGame){
  return {
    game: sameGame || state.game, stage:'board', stake: state.stake,
    mySlug:null, myMove:null, oppMove:null,
    myCard:null, oppCard:null, pot:0, betLog:[],
    myRole:null, myPicks:[], oppPicks:[], recorded:false,
  };
}
function resetToBoard(sameGame){ state = freshState(sameGame); render(); }
function goToCreate(){ state.stage='lobby'; render(); }

// profile is in-memory only and resets on reload, no wallet/backend wired up
// yet. once that's in, this should read off the connected wallet's own
// history (or an indexer over it) — never a server that links identity to
// play history, that'd defeat the point of shielding balances in the first place
let PROFILE = {
  username: 'agent_' + randomSlug(5).toLowerCase(),
  balance: 12.4,
  gamesPlayed: 0, wins: 0, losses: 0, ties: 0,
  totalStaked: 0,
  currentStreak: 0, bestStreak: 0,
  gameCounts: { rps:0, pd:0, bluff:0, assassin:0 },
};

function profileTitle(){
  if(PROFILE.gamesPlayed < 3) return 'Newcomer';
  const winRate = PROFILE.wins / PROFILE.gamesPlayed;
  const fav = Object.entries(PROFILE.gameCounts).sort((a,b)=>b[1]-a[1])[0][0];
  if(winRate >= 0.65) return fav==='bluff' ? 'The Bluffer' : fav==='assassin' ? 'The Menace' : fav==='pd' ? 'The Betrayer' : 'Mind Reader';
  if(winRate <= 0.35) return 'Still Learning';
  return 'Steady Hand';
}

// label is 'win' | 'lose' | 'tie' — assassin's 'graze' tier gets mapped to
// 'tie' here for streak/winrate purposes, its partial payout is passed
// separately as deltaStrk
function recordResult(gameKey, stake, label, deltaStrk){
  PROFILE.gamesPlayed++;
  PROFILE.gameCounts[gameKey] = (PROFILE.gameCounts[gameKey]||0) + 1;
  PROFILE.totalStaked += stake;
  PROFILE.balance += deltaStrk;

  if(label==='win'){ PROFILE.wins++; PROFILE.currentStreak = PROFILE.currentStreak>0 ? PROFILE.currentStreak+1 : 1; }
  else if(label==='lose'){ PROFILE.losses++; PROFILE.currentStreak = PROFILE.currentStreak<0 ? PROFILE.currentStreak-1 : -1; }
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
        <div><div class="p-stat-val">${PROFILE.currentStreak}</div><div class="p-stat-lbl">Streak</div></div>
        <div><div class="p-stat-val">${PROFILE.totalStaked.toFixed(1)}</div><div class="p-stat-lbl">Staked</div></div>
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
  const shareText = `${PROFILE.gamesPlayed ? `${PROFILE.wins}-${PROFILE.losses}-${PROFILE.ties} on HIDDEN \u00b7 ${winRate}% win rate \u00b7 ${profileTitle()}` : 'Just getting started on HIDDEN'}`;

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
    if(navigator.share){
      try{ await navigator.share({ text: shareText, title:'HIDDEN' }); return; }catch(err){ /* cancelled or unsupported, fall through to clipboard */ }
    }
    navigator.clipboard?.writeText(shareText).catch(()=>{});
    e.target.textContent = 'Copied to clipboard';
    setTimeout(()=>{ e.target.textContent = 'Share stats'; }, 1600);
  };
  overlay.classList.add('open');
}
function closeProfile(){
  document.getElementById('profileOverlay').classList.remove('open');
}

function render(){
  renderTabs();
  renderSideProfile();
  const el = document.getElementById('stage');
  if(state.stage === 'board'){ renderBoard(el); return; }
  const engine = GAMES[state.game].engine;
  if(engine==='simul') renderSimul(el);
  else if(engine==='bluff') renderBluffStage(el);
  else renderAssassin(el);
}

function renderTabs(){
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = Object.entries(GAMES).map(([id,g])=>`
    <button class="tab ${state.game===id?'active':''}" data-id="${id}">${iconSpan(g.icon,20)} ${g.short}</button>
  `).join('');
  tabs.querySelectorAll('.tab').forEach(b=>{
    b.onclick = ()=>{ if(b.dataset.id===state.game) return; resetToBoard(b.dataset.id); };
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
  el.querySelectorAll('[data-i]').forEach(b=>{
    b.onclick = ()=> joinCase(parseInt(b.dataset.i,10));
  });
  document.getElementById('createCard').onclick = goToCreate;
}

function joinCase(index){
  const list = CASES[state.game];
  const c = list[index];
  if(!c) return;
  list.splice(index,1);
  state.stake = c.stake;
  state.mySlug = c.slug;

  const engine = GAMES[state.game].engine;
  if(engine==='bluff'){
    state.myCard = drawCard(); state.oppCard = drawCard(); state.pot = state.stake*2;
    state.stage='dealt';
  } else if(engine==='assassin'){
    startAssassinRound();
  } else {
    state.stage='choose';
  }
  render();
}

// shared by simul + bluff; assassin gets its own thin wrapper below since
// the copy differs slightly
function renderLobbyPanel(el, {title, hint}){
  el.innerHTML = `
    <div class="panel torn enter">
      <button class="back-link" id="backBtn">&larr; back to open cases</button>
      <div class="panel-title">${title}</div>
      <div class="section-label" style="margin-top:18px;">Stake (STRK)</div>
      <div class="stake-row">
        ${[0.5,1,5].map(v=>`<button class="stake-opt ${v===state.stake?'active':''}" data-v="${v}">${v}</button>`).join('')}
      </div>
      <button class="btn3 wide" id="connectBtn">Connect wallet &amp; open case</button>
      <div class="panel-hint">${hint}</div>
    </div>
  `;
  document.getElementById('backBtn').onclick = ()=> resetToBoard();
  el.querySelectorAll('.stake-opt').forEach(b=>{
    b.onclick = ()=>{ state.stake = parseFloat(b.dataset.v); render(); };
  });
  document.getElementById('connectBtn').onclick = connectWallet;
}

function renderWaitingPanel(el, msg){
  el.innerHTML = `
    <div class="panel torn enter">
      <div class="pulse-wrap">
        <div class="pulse-dot"></div>
        <div class="waiting-msg">${msg}</div>
      </div>
      <div class="link-box">
        <code>${caseLink(state.mySlug)}</code>
        <button class="btn3 small" id="copyBtn">Copy</button>
      </div>
      <div class="panel-hint">Anyone can take this from the board, or send this link straight to someone \u2014 it only resolves to a game and a stake once opened, nothing else.</div>
      <button class="btn3 outline wide" id="cancelBtn" style="margin-top:16px;">Cancel &amp; reclaim stake</button>
    </div>
  `;
  document.getElementById('copyBtn').onclick = (e)=>{
    navigator.clipboard?.writeText(caseLink(state.mySlug)).catch(()=>{});
    e.target.textContent='Copied';
    setTimeout(()=>{ e.target.textContent='Copy'; }, 1400);
  };
  document.getElementById('cancelBtn').onclick = ()=>{
    const list = CASES[state.game];
    const i = list.findIndex(c=>c.slug===state.mySlug);
    if(i>-1) list.splice(i,1);
    resetToBoard();
  };
}

// simultaneous-reveal engine, used for RPS and Prisoner's Dilemma
function renderSimul(el){
  const cfg = SIMUL_CONFIG[state.game];

  if(state.stage==='lobby'){
    renderLobbyPanel(el, {
      title:`New case \u2014 ${GAMES[state.game].name}`,
      hint:'Stake shields on deposit \u2014 the pool sees an amount arrive, not which wallet sent it. Your case posts to the open board.',
    });
  }

  else if(state.stage==='waiting'){
    renderWaitingPanel(el, `Your stake is locked and posted to the open board. Watching for someone to join case ${state.mySlug.slice(0,6)}...`);
    setTimeout(()=>{
      if(state.stage==='waiting'){
        const list = CASES[state.game];
        const i = list.findIndex(c=>c.slug===state.mySlug);
        if(i>-1) list.splice(i,1);
        state.stage='choose'; render();
      }
    }, 1400);
  }

  else if(state.stage==='choose'){
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
    el.querySelectorAll('.tile').forEach(t=>{
      t.onclick = ()=>{
        el.querySelectorAll('.tile').forEach(x=>x.classList.remove('picked'));
        t.classList.add('picked');
        state.myMove = t.dataset.id;
        document.getElementById('lockBtn').disabled = false;
      };
    });
    document.getElementById('lockBtn').onclick = ()=> commitMove(()=>{ state.stage='locked'; render(); });
  }

  else if(state.stage==='locked'){
    el.innerHTML = `
      <div class="panel torn enter">
        <div class="panel-title">Both parties sealed</div>
        <div class="parties">
          <div class="party"><div class="who">YOU</div><div class="redaction"><span class="lockglyph">LOCKED</span></div></div>
          <div class="party"><div class="who">OPPONENT</div><div class="redaction"><span class="lockglyph">LOCKED</span></div></div>
        </div>
        <div class="panel-hint" style="text-align:center;">Resolving on-chain...</div>
      </div>
    `;
    setTimeout(()=>{
      state.oppMove = cfg.options[Math.floor(Math.random()*cfg.options.length)].id;
      const outcome = cfg.resolve(state.myMove, state.oppMove);
      const delta = outcome==='win' ? state.stake : outcome==='lose' ? -state.stake : 0;
      recordResult(state.game, state.stake, outcome, delta);
      state.stage='result'; render();
    }, 1300);
  }

  else if(state.stage==='result'){
    const outcome = cfg.resolve(state.myMove, state.oppMove);
    const stampText = outcome==='win' ? 'CLEARED' : outcome==='tie' ? 'STALEMATE' : 'CASE LOST';
    const stampCls = outcome==='win' ? '' : outcome==='tie' ? 'tie' : 'lose';
    const potLine = outcome==='win' ? '&rarr; credited to your shielded balance' : outcome==='tie' ? '&rarr; both stakes refunded' : '&rarr; credited to opponent\u2019s shielded balance';
    el.innerHTML = `
      <div class="panel torn enter">
        <div class="panel-title">Reveal</div>
        <div class="parties">
          <div class="party"><div class="who">YOU</div><div class="reveal-glyph">${iconSpan(cfg.options.find(o=>o.id===state.myMove).icon,32)}</div></div>
          <div class="party"><div class="who">OPPONENT</div><div class="reveal-glyph" style="animation-delay:150ms;">${iconSpan(cfg.options.find(o=>o.id===state.oppMove).icon,32)}</div></div>
        </div>
        <div class="stamp-zone"><div class="stamp ${stampCls}" style="animation-delay:480ms;">${stampText}</div></div>
        <div class="result-line enter" style="animation-delay:750ms;">
          ${cfg.resultCopy(outcome,state.myMove,state.oppMove)}<br/>
          Pot: <b>${(state.stake*2).toFixed(2)} STRK</b> ${potLine}
        </div>
        <button class="btn3 wide enter" id="claimBtn" style="margin-top:16px; animation-delay:820ms;">${outcome==='lose'?'Open a new case':'Claim &amp; open a new case'}</button>
      </div>
    `;
    document.getElementById('claimBtn').onclick = ()=>{
      if(outcome==='lose'){ resetToBoard(); } else { resolvePot(()=> resetToBoard()); }
    };
  }
}

function renderBluffStage(el){
  if(state.stage==='lobby'){
    renderLobbyPanel(el, { title:'New case \u2014 Bluff', hint:'Each side antes in privately. You\u2019ll be dealt a hidden card only you can see.' });
  }

  else if(state.stage==='waiting'){
    renderWaitingPanel(el, `Ante locked and posted to the open board. Watching for someone to join case ${state.mySlug.slice(0,6)}...`);
    setTimeout(()=>{
      if(state.stage==='waiting'){
        const list = CASES[state.game];
        const i = list.findIndex(c=>c.slug===state.mySlug);
        if(i>-1) list.splice(i,1);
        state.myCard=drawCard(); state.oppCard=drawCard(); state.pot=state.stake*2;
        state.stage='dealt'; render();
      }
    }, 1400);
  }

  else if(state.stage==='dealt'){
    el.innerHTML = `
      <div class="panel torn enter">
        <div class="panel-title">Your hand</div>
        <div class="your-card">
          <div class="playing-card">${state.myCard}</div>
          <div class="card-caption">only you can see this</div>
        </div>
        <div class="pot-strip"><span>ANTE</span><b>${state.stake.toFixed(2)} STRK each</b></div>
        <div class="btn-row">
          <button class="btn3 outline" id="foldBtn">FOLD</button>
          <button class="btn3" id="betBtn">BET</button>
        </div>
        <div class="panel-hint">Bet, and your opponent has to decide whether to call without seeing your card. Fold, and you forfeit your ante now.</div>
      </div>
    `;
    document.getElementById('foldBtn').onclick = ()=>{ state.betLog.push({who:'you',action:'FOLD'}); finishBluff('fold-self'); };
    document.getElementById('betBtn').onclick = ()=>{ state.betLog.push({who:'you',action:'BET'}); state.stage='pending-call'; render(); };
  }

  else if(state.stage==='pending-call'){
    el.innerHTML = `
      <div class="panel torn enter">
        <div class="panel-title">Opponent deciding</div>
        <div class="bet-log">${renderBetLog()}</div>
        <div class="pulse-wrap">
          <div class="pulse-dot"></div>
          <div class="waiting-msg">Opponent is deciding whether to call your bet...</div>
        </div>
      </div>
    `;
    setTimeout(()=>{
      const oppStrength = rankValue(state.oppCard);
      const callChance = 0.35 + (oppStrength/14)*0.5;
      const calls = Math.random() < callChance;
      state.betLog.push({who:'them', action: calls?'CALL':'FOLD'});
      if(calls){ state.stage='showdown'; render(); } else { finishBluff('fold-opp'); }
    }, 1500);
  }

  else if(state.stage==='showdown' || state.stage==='result'){ renderBluffResult(el); }
}

function renderBetLog(){
  return state.betLog.map(b=>`<div class="${b.who==='them'?'them':''}">${b.who==='them'?'OPPONENT':'YOU'} &rarr; ${b.action}</div>`).join('');
}
function finishBluff(kind){ state.outcomeKind = kind; state.stage='result'; render(); }

function renderBluffResult(el){
  let outcome, cardsHtml;
  if(state.stage==='showdown'){
    const mine=rankValue(state.myCard), theirs=rankValue(state.oppCard);
    outcome = mine===theirs?'tie':mine>theirs?'win':'lose';
    cardsHtml = `<div class="parties">
      <div class="party"><div class="who">YOU</div><div class="reveal-glyph">${state.myCard}</div></div>
      <div class="party"><div class="who">OPPONENT</div><div class="reveal-glyph" style="animation-delay:150ms;">${state.oppCard}</div></div>
    </div>`;
  } else if(state.outcomeKind==='fold-opp'){
    outcome='win';
    cardsHtml = `<div class="parties">
      <div class="party"><div class="who">YOU</div><div class="reveal-glyph">${state.myCard}</div></div>
      <div class="party"><div class="who">OPPONENT</div><div class="redaction"><span class="lockglyph">FOLDED</span></div></div>
    </div>`;
  } else {
    outcome='lose';
    cardsHtml = `<div class="parties">
      <div class="party"><div class="who">YOU</div><div class="reveal-glyph">${state.myCard}</div></div>
      <div class="party"><div class="who">OPPONENT</div><div class="redaction"><span class="lockglyph">HIDDEN</span></div></div>
    </div>`;
  }
  const stampText = outcome==='win'?'CLEARED':outcome==='tie'?'STALEMATE':'CASE LOST';
  const stampCls = outcome==='win'?'':outcome==='tie'?'tie':'lose';
  const potLine = outcome==='win'?'&rarr; credited to your shielded balance':outcome==='tie'?'&rarr; both antes refunded':'&rarr; credited to opponent\u2019s shielded balance';

  if(!state.recorded){
    state.recorded = true;
    const delta = outcome==='win' ? state.stake : outcome==='lose' ? -state.stake : 0;
    recordResult(state.game, state.stake, outcome, delta);
    renderSideProfile();
  }

  document.getElementById('stage').innerHTML = `
    <div class="panel torn enter">
      <div class="panel-title">Showdown</div>
      <div class="bet-log">${renderBetLog()}</div>
      ${cardsHtml}
      <div class="stamp-zone"><div class="stamp ${stampCls}" style="animation-delay:480ms;">${stampText}</div></div>
      <div class="result-line enter" style="animation-delay:750ms;">Pot: <b>${state.pot.toFixed(2)} STRK</b> ${potLine}</div>
      <button class="btn3 wide enter" id="claimBtn" style="margin-top:16px; animation-delay:820ms;">${outcome==='lose'?'Open a new case':'Claim &amp; open a new case'}</button>
    </div>
  `;
  document.getElementById('claimBtn').onclick = ()=>{
    if(outcome==='lose'){ resetToBoard(); } else { resolvePot(()=> resetToBoard()); }
  };
}

function startAssassinRound(){
  // role = coin flip for now. real version should derive it from the first
  // bit of poseidon(commitmentA, commitmentB) so neither player controls
  // both commitments and neither can bias their own role
  state.myRole = Math.random() < 0.5 ? 'assassin' : 'target';
  state.myPicks = [];
  state.stage = 'picking';
}

function renderAssassin(el){
  if(state.stage==='lobby'){
    renderLobbyPanel(el, { title:'New case \u2014 Assassin vs Target', hint:'One of you attacks, one of you hides. Neither of you knows which role the other got until reveal.' });
  }

  else if(state.stage==='waiting'){
    renderWaitingPanel(el, `Stake locked and posted to the open board. Watching for someone to join case ${state.mySlug.slice(0,6)}...`);
    setTimeout(()=>{
      if(state.stage==='waiting'){
        const list = CASES[state.game];
        const i = list.findIndex(c=>c.slug===state.mySlug);
        if(i>-1) list.splice(i,1);
        startAssassinRound(); render();
      }
    }, 1400);
  }

  else if(state.stage==='picking'){
    const roleCopy = state.myRole==='assassin'
      ? 'Pick 3 tiles to attack. Land on your opponent\u2019s hiding tile and you catch them.'
      : 'Pick 3 tiles to hide across. Avoid every tile your opponent attacks.';
    el.innerHTML = `
      <div class="panel torn enter">
        <div class="panel-title">Your assignment</div>
        <div class="assassin-wrap">
          <div class="role-tag">YOU ARE THE ${state.myRole.toUpperCase()}</div>
          <div class="panel-hint" style="text-align:center;">${roleCopy}</div>
          <div class="grid16" id="grid16">
            ${Array.from({length:16},(_,i)=>`<button class="gtile" data-i="${i}"></button>`).join('')}
          </div>
          <div class="pick-counter" id="pickCounter">0 / 3 selected</div>
          <button class="btn3 wide" id="lockBtn" disabled>Lock selection</button>
        </div>
      </div>
    `;
    const counter = document.getElementById('pickCounter');
    const lockBtn = document.getElementById('lockBtn');
    el.querySelectorAll('.gtile').forEach(t=>{
      t.onclick = ()=>{
        const i = parseInt(t.dataset.i,10);
        const idx = state.myPicks.indexOf(i);
        if(idx>-1){ state.myPicks.splice(idx,1); t.classList.remove('picked'); }
        else if(state.myPicks.length<3){ state.myPicks.push(i); t.classList.add('picked'); }
        counter.textContent = `${state.myPicks.length} / 3 selected`;
        lockBtn.disabled = state.myPicks.length !== 3;
      };
    });
    lockBtn.onclick = ()=> commitMove(()=>{ state.stage='locked'; render(); });
  }

  else if(state.stage==='locked'){
    el.innerHTML = `
      <div class="panel torn enter">
        <div class="panel-title">Both parties sealed</div>
        <div class="parties">
          <div class="party"><div class="who">YOU</div><div class="redaction"><span class="lockglyph">LOCKED</span></div></div>
          <div class="party"><div class="who">OPPONENT</div><div class="redaction"><span class="lockglyph">LOCKED</span></div></div>
        </div>
        <div class="panel-hint" style="text-align:center;">Resolving on-chain...</div>
      </div>
    `;
    setTimeout(()=>{
      const picks = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15];
      state.oppPicks = picks.sort(()=>Math.random()-0.5).slice(0,3);
      state.stage='result'; render();
    }, 1300);
  }

  else if(state.stage==='result'){
    const assassinPicks = state.myRole==='assassin' ? state.myPicks : state.oppPicks;
    const targetPicks = state.myRole==='target' ? state.myPicks : state.oppPicks;
    const overlap = assassinPicks.filter(t=>targetPicks.includes(t));
    const tier = overlap.length===0 ? 'escape' : overlap.length===1 ? 'graze' : 'kill';

    let outcome; // from my perspective
    if(state.myRole==='assassin') outcome = tier==='escape' ? 'lose' : tier==='graze' ? 'partial' : 'win';
    else outcome = tier==='escape' ? 'win' : tier==='graze' ? 'partial' : 'lose';

    const stampText = tier==='escape' ? 'ESCAPED' : tier==='graze' ? 'GRAZED' : 'CAUGHT';
    const stampCls = outcome==='win' ? '' : outcome==='lose' ? 'lose' : 'tie';

    const myShare = tier==='escape' ? (state.myRole==='target'?1:0)
                   : tier==='kill'  ? (state.myRole==='assassin'?1:0)
                   : (state.myRole==='assassin'?0.65:0.35); // graze favors the assassin
    const myPayout = (state.stake*2*myShare).toFixed(2);

    if(!state.recorded){
      state.recorded = true;
      const label = outcome==='partial' ? 'tie' : outcome;
      const delta = (state.stake*2*myShare) - state.stake; // net vs what you staked
      recordResult(state.game, state.stake, label, delta);
      renderSideProfile();
    }

    let markedCount = 0;
    el.innerHTML = `
      <div class="panel torn enter">
        <div class="panel-title">Reveal</div>
        <div class="assassin-wrap">
          <div class="grid16">
            ${Array.from({length:16},(_,i)=>{
              const isA = assassinPicks.includes(i), isT = targetPicks.includes(i);
              const cls = isA&&isT ? 'mark-both' : isA ? 'mark-a' : isT ? 'mark-t' : '';
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
          You were the ${state.myRole.toUpperCase()} \u2014 ${overlap.length} overlapping tile${overlap.length===1?'':'s'}<br/>
          Your share: <b>${myPayout} STRK</b> of a ${(state.stake*2).toFixed(2)} STRK pot
        </div>
        <button class="btn3 wide enter" id="claimBtn" style="margin-top:16px; animation-delay:850ms;">${myShare===0?'Open a new case':'Claim &amp; open a new case'}</button>
      </div>
    `;
    document.getElementById('claimBtn').onclick = ()=>{
      if(myShare===0){ resetToBoard(); } else { resolvePot(()=> resetToBoard()); }
    };
  }
}

// stubbed chain calls, wire these up to real STRK20 SDK calls once contracts are deployed
function connectWallet(){
  const btn = document.getElementById('connectBtn');
  btn.textContent = 'Connecting...'; btn.disabled = true;
  setTimeout(()=>{
    const slug = randomSlug();
    CASES[state.game].push({slug, stake: state.stake});
    state.mySlug = slug;
    state.stage = 'waiting';
    render();
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
document.getElementById('profileOverlay').addEventListener('click', (e)=>{
  if(e.target.id === 'profileOverlay') closeProfile();
});
document.addEventListener('keydown', (e)=>{
  if(e.key === 'Escape') closeProfile();
});

render();
