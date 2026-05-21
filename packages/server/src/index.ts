import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import { GameManager } from './gameManager.js';
import { GameState, HandPhase, PokerAction, PokerActionType, ShopItemType, Card, getCardPrice, ShopSlotItem, resolveJokersForShowdown, isJokerCard, TimerSettings } from '@poker/shared';

const app = express();
const httpServer = createServer(app);

const allowedOrigins = (process.env.FRONTEND_URLS || process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

function normalizeOrigin(origin: string): string {
  // Strip trailing slash and lowercase for consistent comparison
  return origin.replace(/\/$/, '').toLowerCase();
}

function isOriginAllowed(origin?: string): boolean {
  // During debugging — log all origins so we can see what's hitting the server
  console.log(`[CORS] Origin received: "${origin ?? 'none'}". Allowed list: ${allowedOrigins.join(', ')}`);
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  const allowed = allowedOrigins.map(normalizeOrigin).some(o => o === normalized);
  if (!allowed) {
    console.warn(`[CORS] Blocked origin: "${origin}". Allowed: ${allowedOrigins.join(', ')}`);
  }
  return allowed;
}

const corsOriginValidator = (
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void
): void => {
  if (isOriginAllowed(origin)) {
    callback(null, true);
    return;
  }
  callback(new Error(`Origin not allowed by CORS: ${origin ?? 'unknown'}`));
};

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: '*',  // DEBUG: open to all — tighten after confirming connection works
    methods: ['GET', 'POST'],
  },
  // Fly.io proxy: skip polling, use WebSocket only to avoid sticky session 400s
  transports: ['websocket'],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(cors({ origin: '*' }));  // DEBUG: open to all
app.use(express.json());

const gameManager = new GameManager();
const playerSessions = new Map<string, number>(); // socketId -> playerId
let lastGamePhase = 0; // Track last phase to detect showdown

// ─── Turn timer state ─────────────────────────────────────────────────────────
let currentTimer: NodeJS.Timeout | null = null;
let timerContextKey: string | null = null;

function rescheduleTimer(state: GameState): void {
  if (currentTimer) {
    clearTimeout(currentTimer);
    currentTimer = null;
  }

  if (state.gameMode !== 'multiplayer') return;

  // Determine timer context for this state
  let newContextKey: string | null = null;
  let seconds = 0;

  if (state.phase === HandPhase.Betting) {
    const activePlayer = state.players.find(p => p.id === state.activePlayerId);
    if (activePlayer && !activePlayer.isBot) {
      newContextKey = `betting-${state.activePlayerId}-${state.round}`;
      seconds = state.timerSettings.bettingSeconds;
    }
  } else if (state.phase === HandPhase.Showdown || state.phase === HandPhase.ItemShop) {
    const hasUnreadyHuman = state.players.some(p => !p.isBot && !p.isEliminated && !p.isReady);
    if (hasUnreadyHuman) {
      newContextKey = `shop-${state.phase}`;
      seconds = state.timerSettings.shopSeconds;
    }
  }

  if (newContextKey === null) {
    timerContextKey = null;
    return;
  }

  // Only set a fresh deadline when context changes (new turn / new phase)
  if (newContextKey !== timerContextKey) {
    timerContextKey = newContextKey;
    gameManager.setTurnDeadline(seconds);
    // Push the updated deadline to all clients
    io.emit('game-state-updated', gameManager.getGameState());
  }

  const deadline = gameManager.getGameState().turnDeadline;
  if (deadline === null) return;
  const delay = Math.max(0, deadline - Date.now());

  currentTimer = setTimeout(() => {
    currentTimer = null;
    timerContextKey = null;
    const s = gameManager.getGameState();

    if (s.phase === HandPhase.Betting) {
      const acted = gameManager.autoFoldOrCheck(s.activePlayerId);
      if (acted) {
        const newState = gameManager.getGameState();
        if (newState.phase === HandPhase.Showdown && lastGamePhase !== HandPhase.Showdown) {
          lastGamePhase = HandPhase.Showdown;
          handleShowdown();
        } else {
          io.emit('game-state-updated', newState);
          if (newState.phase === HandPhase.Betting) {
            const nextPlayer = newState.players.find(p => p.id === newState.activePlayerId);
            if (nextPlayer?.isBot) {
              executeBotTurns().catch(err => console.error('[Timer] bot turns error:', err));
            } else {
              rescheduleTimer(newState);
            }
          }
        }
      }
    } else if (s.phase === HandPhase.Showdown || s.phase === HandPhase.ItemShop) {
      gameManager.autoReadyAllHumans();
      triggerReadyTransition(s.phase);
    }
  }, delay);
}

/** Shared logic: check all-ready condition and advance phase after readying. */
function triggerReadyTransition(phase: HandPhase): void {
  const currentState = gameManager.getGameState();

  if (phase === HandPhase.Showdown) {
    const activePlayers = currentState.players.filter(p => !p.isEliminated);
    const allReady = activePlayers.length >= 1 && activePlayers.every(p => p.isReady);
    if (allReady) {
      for (const player of currentState.players) player.isReady = false;
      gameManager.tickLuckBuffs();
      currentState.phase = HandPhase.ItemShop;
      io.emit('game-state-updated', currentState);
      rescheduleTimer(gameManager.getGameState());
    }
  } else if (phase === HandPhase.ItemShop) {
    const nonEliminated = currentState.players.filter(p => !p.isEliminated);
    const allReady = nonEliminated.length >= 2 && nonEliminated.every(p => p.isReady);
    if (allReady) {
      gameManager.startHand();
      lastGamePhase = 0;
      io.emit('hand-started', gameManager.getGameState());

      gameManager.getGameState().players.forEach(player => {
        const holeCards = gameManager.getHoleCards(player.id);
        if (holeCards) {
          io.to(
            Array.from(playerSessions.entries())
              .find(([_, pid]) => pid === player.id)?.[0] || ''
          ).emit('hole-cards', holeCards);
        }
      });

      const initialState = gameManager.getGameState();
      rescheduleTimer(initialState);
      if (initialState.phase === HandPhase.Betting) {
        const activePlayer = initialState.players.find(p => p.id === initialState.activePlayerId);
        if (activePlayer?.isBot) {
          executeBotTurns().catch(err => console.error('[Timer] bot turns error after shop:', err));
        }
      }
    }
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// Helper function to execute bot turns with delays
async function executeBotTurns(): Promise<void> {
  const BOT_DELAY_MS = 1000; // 1 second
  let iterations = 0; // Prevent infinite loops
  const MAX_ITERATIONS = 100; // Safety limit (enough for raises across all 4 streets)
  
  let currentState = gameManager.getGameState();
  
  while (currentState.phase === 2 && iterations < MAX_ITERATIONS) { // HandPhase.Betting = 2
    iterations++;
    const activePlayer = currentState.players.find(p => p.id === currentState.activePlayerId);
    
    console.log(`[Bot Turn ${iterations}] Active: ${activePlayer?.name || 'NONE'} (ID: ${activePlayer?.id}), Phase: ${currentState.phase}`);
    
    if (!activePlayer) {
      console.error('[Bot Error] No active player found');
      break;
    }
    
    // If it's not a bot, the human needs to act
    if (!activePlayer.isBot) {
      console.log('[Bot] Human player turn - stopping bot execution');
      break;
    }
    
    // If bot is folded or all-in, handle gracefully
    if (activePlayer.hasFolded || activePlayer.isAllIn) {
      if (!activePlayer.hasFolded && activePlayer.isAllIn) {
        // All-in bots submit Check to release their item-only turn
        console.log(`[Bot] ${activePlayer.name} all-in, submitting check to pass item turn`);
        const checkSuccess = gameManager.submitAction(activePlayer.id, { type: PokerActionType.Check });
        if (checkSuccess) {
          currentState = gameManager.getGameState();
          io.emit('game-state-updated', currentState);
          if (currentState.phase === 3 && lastGamePhase !== 3) {
            lastGamePhase = 3;
            handleShowdown();
            return;
          }
        } else {
          console.error(`[Bot Error] ${activePlayer.name} all-in check failed`);
          currentState = gameManager.getGameState();
        }
      } else {
        console.log(`[Bot] ${activePlayer.name} folded, skipping`);
        currentState = gameManager.getGameState();
      }
      continue;
    }
    
    // Execute bot action with delay
    try {
      console.log(`[Bot] ${activePlayer.name} thinking...`);
      await new Promise(resolve => setTimeout(resolve, BOT_DELAY_MS));
      
    // Execute item rules (e.g., cash out stock option) before betting action
      const usedItem = gameManager.executeBotItemRules(activePlayer.id);
      if (usedItem) {
        currentState = gameManager.getGameState();
        io.emit('game-state-updated', currentState);
        console.log(`[Bot] ${activePlayer.name} used an item (rule triggered)`);
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      const botAction = gameManager.getBotAction(activePlayer.id);
      const actionName = botAction.type === 1 ? 'CHECK' : botAction.type === 2 ? 'CALL' : 'UNKNOWN';
      console.log(`[Bot] ${activePlayer.name} ${actionName}`);
      
      const actionSuccess = gameManager.submitAction(activePlayer.id, botAction);
      if (!actionSuccess) {
        console.error(`[Bot Error] ${activePlayer.name} action failed`);
        break;
      }
      
      // Emit the updated state after bot action
      currentState = gameManager.getGameState();
      io.emit('game-state-updated', currentState);
      console.log(`[Game] Next active: ${currentState.players.find(p => p.id === currentState.activePlayerId)?.name || 'NONE'}`);
      
      // Check for showdown transition
      if (currentState.phase === 3 && lastGamePhase !== 3) {
        console.log('[Game] Transitioned to showdown');
        lastGamePhase = 3;
        handleShowdown();
        return;
      }
    } catch (err) {
      console.error('[Bot Error]', err);
      break;
    }
  }
  
  if (iterations >= MAX_ITERATIONS) {
    console.error('[Bot Error] Max iterations reached - possible infinite loop');
  }
  console.log('[Bot] Execution complete');
}

function handleShowdown(): void {
  const currentState = gameManager.getGameState();
  const foldedOut = gameManager.isFoldedOut();
  
  // Reset all ready states when entering showdown so players can click ready
  for (const player of currentState.players) {
    player.isReady = false;
  }
  
  // Emit the reset game state so client knows players aren't ready
  io.emit('game-state-updated', currentState);
  rescheduleTimer(currentState);
  
  if (foldedOut) {
    // Fold-out win: don't send hole cards
    io.emit('showdown', { cards: {}, winnerId: gameManager.getWinnerId(), winnerIds: gameManager.getWinnerIds(), foldedOut: true });
  } else {
    // Regular showdown: send all hole cards, resolving jokers to their optimal card
    const allCards: { [playerId: number]: any[] } = {};
    const boardCards = currentState.board;
    const allHoleCards = gameManager.getAllHoleCards();
    allHoleCards.forEach((cards, pid) => {
      const hasJoker = cards.some(c => isJokerCard(c));
      allCards[pid] = hasJoker ? resolveJokersForShowdown(cards, boardCards) : cards;
    });
    io.emit('showdown', { cards: allCards, winnerId: gameManager.getWinnerId(), winnerIds: gameManager.getWinnerIds(), foldedOut: false });
  }
}

// REST endpoints
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'pokergame-server' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/game-state', (req, res) => {
  const gameState = gameManager.getGameState();
  res.json(gameState);
});

// Socket.io events
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  socket.on('join-table', (playerName: string, callback) => {
    const playerId = gameManager.joinTable(playerName);
    playerSessions.set(socket.id, playerId);

    console.log(`Player ${playerName} (ID: ${playerId}) joined the table`);

    // Notify all players of the updated game state
    io.emit('game-state-updated', gameManager.getGameState());

    callback({ playerId, success: true });
  });

  socket.on('play-vs-bots', (playerName: string, callback) => {
    const playerId = gameManager.playVsBots(playerName);
    playerSessions.set(socket.id, playerId);
    lastGamePhase = 0;

    console.log(`Player ${playerName} (ID: ${playerId}) started game vs bots`);

    // Notify all players of the updated game state
    io.emit('game-state-updated', gameManager.getGameState());

    callback({ playerId, success: true });
  });

  socket.on('set-ready', (playerId: number, isReady: boolean) => {
    const currentState = gameManager.getGameState();
    
    // Handle Showdown phase: wait for all players to ready up, then transition to ItemShop
    if (currentState.phase === HandPhase.Showdown) {
      gameManager.setReady(playerId, isReady);
      io.emit('player-ready', { playerId, isReady });
      
      // In bot mode, auto-ready bots when human clicks ready
      const hasBots = currentState.players.some(p => p.isBot);
      if (hasBots && isReady) {
        for (const player of currentState.players) {
          if (player.isBot && !player.isEliminated) {
            player.isReady = true;
          }
        }
        io.emit('game-state-updated', currentState);
        rescheduleTimer(currentState);
      }

      triggerReadyTransition(HandPhase.Showdown);
    } 
    // Handle ItemShop phase: transition to next hand when all ready
    else if (currentState.phase === HandPhase.ItemShop) {
      gameManager.setReady(playerId, isReady);
      io.emit('player-ready', { playerId, isReady });
      
      // In bot mode, auto-ready bots when human clicks ready
      const hasBots = currentState.players.some(p => p.isBot);
      if (hasBots) {
        for (const player of currentState.players) {
          if (player.isBot) {
            player.isReady = true;
          }
        }
      }

      triggerReadyTransition(HandPhase.ItemShop);
    }
    // Default: handle other phases (Lobby, etc.)
    else {
      gameManager.setReady(playerId, isReady);
      io.emit('player-ready', { playerId, isReady });
    }
  });

  socket.on('start-hand', (playerId: number) => {
    if (gameManager.canStartHand(playerId)) {
      gameManager.startHand();
      lastGamePhase = 0;
      io.emit('hand-started', gameManager.getGameState());
      
      // Send hole cards to each player
      gameManager.getGameState().players.forEach(player => {
        const holeCards = gameManager.getHoleCards(player.id);
        if (holeCards) {
          io.to(
            Array.from(playerSessions.entries())
              .find(([_, pid]) => pid === player.id)?.[0] || ''
          ).emit('hole-cards', holeCards);
        }
      });

      const initialState = gameManager.getGameState();
      rescheduleTimer(initialState);
      if (initialState.phase === HandPhase.Betting) {
        const activePlayer = initialState.players.find(p => p.id === initialState.activePlayerId);
        if (activePlayer?.isBot) {
          executeBotTurns().catch(err => console.error('Error executing bot turns:', err));
        }
      }
    }
  });

  socket.on('submit-action', (playerId: number, action: PokerAction, callback) => {
    const success = gameManager.submitAction(playerId, action);
    
    if (success) {
      const currentState = gameManager.getGameState();
      io.emit('game-state-updated', currentState);
      
      // Check for showdown transition
      if (currentState.phase === HandPhase.Showdown && lastGamePhase !== HandPhase.Showdown) {
        lastGamePhase = HandPhase.Showdown;
        handleShowdown();
      } else if (currentState.phase !== lastGamePhase) {
        lastGamePhase = currentState.phase;
      }
      
      // If it's a bot's turn, execute bot turns with delays
      if (currentState.phase === HandPhase.Betting) {
        const activePlayer = currentState.players.find(p => p.id === currentState.activePlayerId);
        if (activePlayer?.isBot) {
          executeBotTurns().catch(err => console.error('Error executing bot turns:', err));
        } else {
          rescheduleTimer(currentState);
        }
      }
      
      callback({ success: true });
    } else {
      callback({ success: false, error: 'Invalid action' });
    }
  });

  socket.on('use-item', (playerId: number, useType: number, targetPlayerId?: number) => {
    const success = gameManager.useItem(playerId, useType, targetPlayerId);
    
    if (success) {
      io.emit('game-state-updated', gameManager.getGameState());
      
      // Send updated sleeve card info to the player who used the item
      const { sleeveCard, sleeveCard2 } = gameManager.getPlayerSleeveCards(playerId);
      socket.emit('sleeve-card-updated', { sleeveCard, sleeveCard2, sleeveUsedThisHand: gameManager.hasUsedSleeveThisHand(playerId) });

      // If this was a sleeve card swap, re-send updated hole cards so UI reflects immediately
      if (useType === 21 || useType === 22 || useType === 23 || useType === 24) { // sleeve swap types (A/B for slot 1 and slot 2)
        const updatedHoleCards = gameManager.getHoleCards(playerId);
        if (updatedHoleCards) {
          socket.emit('hole-cards', updatedHoleCards);
        }
      }
    }
  });

  socket.on('get-sleeve-card', (playerId: number, callback) => {
    const { sleeveCard, sleeveCard2 } = gameManager.getPlayerSleeveCards(playerId);
    const hasUnlock = gameManager.hasCardSleeveUnlock(playerId);
    const ps = gameManager.getPlayerPrivateState(playerId);
    callback({
      success: true,
      sleeveCard,
      sleeveCard2,
      hasUnlock,
      xrayCharges: ps?.xrayCharges ?? 0,
      loadedDeckCharges: ps?.loadedDeckCharges ?? 0,
      cardRerollCharges: ps?.cardRerollCharges ?? 0,
      stickyFingersCharges: ps?.stickyFingersCharges ?? 0,
      hiddenCameraCharges: ps?.hiddenCameraCharges ?? 0,
      hasGun: ps?.hasGun ?? false,
      bullets: ps?.bullets ?? 0,
      sleeveUsedThisHand: gameManager.hasUsedSleeveThisHand(playerId),
      bonds: ps?.bonds ?? [],
      stockOptions: ps?.stockOptions ?? [],
      totalLuck: ps ? (ps.permanentLuck + ps.luckBuffs.reduce((s, b) => s + b.amount, 0)) : 0,
      luckBuffs: ps?.luckBuffs ?? [],
      spadeOfSpadesBonus: ps?.spadeOfSpadesBonus ?? 5,
    });
  });

  socket.on('cash-out-bond', (playerId: number, bondIndex: number, callback) => {
    const result = gameManager.cashOutBond(playerId, bondIndex);
    if (result.success) {
      io.emit('game-state-updated', gameManager.getGameState());
    }
    callback(result);
  });

  socket.on('cash-out-stock-option', (playerId: number, optionIndex: number, callback) => {
    const result = gameManager.cashOutStockOption(playerId, optionIndex);
    if (result.success) {
      io.emit('game-state-updated', gameManager.getGameState());
    }
    callback(result);
  });

  socket.on('unlock-shop-slot', (playerId: number, callback) => {
    const result = gameManager.unlockShopSlot(playerId);
    if (result.success) {
      io.emit('game-state-updated', gameManager.getGameState());
      const slots = gameManager.getShopSlots(playerId);
      callback({ success: true, slots });
    } else {
      callback({ success: false, error: result.error });
    }
  });

  socket.on('get-shop-slots', (playerId: number, callback) => {
    const slots = gameManager.generateShopSlots(playerId);
    callback({ success: true, slots });
  });

  socket.on('refresh-shop', (playerId: number, callback) => {
    const player = gameManager.getGameState().players.find(p => p.id === playerId);
    if (!player) { callback({ success: false, error: 'Player not found' }); return; }
    const cost = 50;
    if (player.stack < cost) { callback({ success: false, error: 'Not enough chips' }); return; }
    player.stack -= cost;
    io.emit('game-state-updated', gameManager.getGameState());
    const slots = gameManager.generateShopSlots(playerId);
    callback({ success: true, slots });
  });

  socket.on('refresh-extra-card-preview', (playerId: number, callback) => {
    const slot = gameManager.refreshExtraCardPreview(playerId);
    if (slot) {
      callback({ success: true, slot });
    } else {
      callback({ success: false, error: 'No extra card slot found' });
    }
  });

  socket.on('get-extra-card-preview', (playerId: number, callback) => {
    const player = gameManager.getGameState().players.find(p => p.id === playerId);
    if (!player) {
      callback({ success: false, error: 'Player not found' });
      return;
    }

    // Get a random available card for preview
    const card = gameManager.getRandomAvailableCardFor(playerId);
    if (!card) {
      callback({ success: false, error: 'No cards available' });
      return;
    }

    const price = getCardPrice(card);
    callback({ success: true, card, price });
  });

  socket.on('buy-extra-card', (playerId: number, card: Card, targetSlotOrCallback: any, callbackArg?: any) => {
    const targetSlot: 0 | 1 | undefined =
      (targetSlotOrCallback === 0 || targetSlotOrCallback === 1) ? targetSlotOrCallback : undefined;
    const callback = typeof targetSlotOrCallback === 'function' ? targetSlotOrCallback : callbackArg;
    const success = gameManager.buyExtraCard(playerId, card, targetSlot);
    
    if (success) {
      io.emit('game-state-updated', gameManager.getGameState());
      
      // Send updated sleeve card info to the player who bought the card
      const { sleeveCard, sleeveCard2 } = gameManager.getPlayerSleeveCards(playerId);
      const playerSocketId = Array.from(playerSessions.entries())
        .find(([_, pid]) => pid === playerId)?.[0];
      if (playerSocketId) {
        io.to(playerSocketId).emit('sleeve-card-updated', { sleeveCard, sleeveCard2 });
      }
      
      callback({ success: true });
    } else {
      callback({ success: false, error: 'Unable to purchase card' });
    }
  });

  socket.on('use-xray', (playerId: number, callback) => {
    const card = gameManager.useXRayGoggles(playerId);
    if (card) {
      const ps = gameManager.getPlayerPrivateState(playerId);
      callback({ success: true, card, chargesLeft: ps?.xrayCharges ?? 0 });
    } else {
      callback({ success: false, error: 'Cannot use X-Ray Goggles now' });
    }
  });

  socket.on('use-loaded-deck', (playerId: number, callback) => {
    const success = gameManager.useLoadedDeck(playerId);
    if (success) {
      const ps = gameManager.getPlayerPrivateState(playerId);
      callback({ success: true, chargesLeft: ps?.loadedDeckCharges ?? 0 });
    } else {
      callback({ success: false, error: 'Cannot use Loaded Deck now' });
    }
  });

  socket.on('use-card-reroll', (playerId: number, callback) => {
    const success = gameManager.rerollHoleCards(playerId);
    if (success) {
      const ps = gameManager.getPlayerPrivateState(playerId);
      const newCards = gameManager.getHoleCards(playerId);
      callback({ success: true, chargesLeft: ps?.cardRerollCharges ?? 0 });
      if (newCards) {
        socket.emit('hole-cards', newCards);
      }
    } else {
      callback({ success: false, error: 'Cannot reroll cards now' });
    }
  });

  socket.on('use-sticky-fingers', (playerId: number, targetPlayerId: number, callback) => {
    const success = gameManager.useStickyFingers(playerId, targetPlayerId);
    if (success) {
      const ps = gameManager.getPlayerPrivateState(playerId);
      callback({ success: true, chargesLeft: ps?.stickyFingersCharges ?? 0 });
      // Update thief's sleeve with the stolen card
      const { sleeveCard, sleeveCard2 } = gameManager.getPlayerSleeveCards(playerId);
      socket.emit('sleeve-card-updated', { sleeveCard, sleeveCard2, sleeveUsedThisHand: gameManager.hasUsedSleeveThisHand(playerId) });
      // Update target's hole cards
      const targetCards = gameManager.getHoleCards(targetPlayerId);
      if (targetCards) {
        const targetSocketId = Array.from(playerSessions.entries())
          .find(([_, pid]) => pid === targetPlayerId)?.[0];
        if (targetSocketId) {
          io.to(targetSocketId).emit('hole-cards', targetCards);
        }
      }
    } else {
      callback({ success: false, error: 'Cannot use Sticky Fingers now' });
    }
  });

  socket.on('use-hidden-camera', (playerId: number, targetPlayerId: number, callback) => {
    const card = gameManager.useHiddenCamera(playerId, targetPlayerId);
    if (card) {
      const ps = gameManager.getPlayerPrivateState(playerId);
      callback({ success: true, card, chargesLeft: ps?.hiddenCameraCharges ?? 0 });
    } else {
      callback({ success: false, error: 'Cannot use Hidden Camera on that player' });
    }
  });

  socket.on('buy-item', (playerId: number, itemType: number, targetSlotOrCallback: any, callbackArg?: any) => {
    const targetSlot: 0 | 1 | undefined =
      (targetSlotOrCallback === 0 || targetSlotOrCallback === 1) ? targetSlotOrCallback : undefined;
    const callback = typeof targetSlotOrCallback === 'function' ? targetSlotOrCallback : callbackArg;
    const success = gameManager.buyItem(playerId, itemType, targetSlot);
    
    if (success) {
      io.emit('game-state-updated', gameManager.getGameState());
      // Update sleeve state if needed (Joker goes to sleeve, SleeveExtender unlocks slot 2)
      if (itemType === ShopItemType.Joker || itemType === ShopItemType.SleeveExtender) {
        const { sleeveCard, sleeveCard2 } = gameManager.getPlayerSleeveCards(playerId);
        socket.emit('sleeve-card-updated', { sleeveCard, sleeveCard2 });
      }
      callback({ success: true });
    } else {
      callback({ success: false, error: 'Unable to purchase item' });
    }
  });

  socket.on('shoot-player', (playerId: number, targetId: number, callback) => {
    const result = gameManager.shootPlayer(playerId, targetId);
    if (result.success) {
      io.emit('game-state-updated', gameManager.getGameState());
      io.emit('shot-fired', { shooterId: playerId, targetId, backfired: result.backfired });
      const ps = gameManager.getPlayerPrivateState(playerId);
      callback({ success: true, backfired: result.backfired, bulletsLeft: ps?.bullets ?? 0 });
    } else {
      callback({ success: false, error: result.error });
    }
  });

  socket.on('set-timer-settings', (playerId: number, settings: TimerSettings, callback: (res: { success: boolean; error?: string }) => void) => {
    if (playerId !== gameManager.getHostPlayerId()) {
      callback({ success: false, error: 'Only the host can change timer settings' });
      return;
    }
    gameManager.setTimerSettings(settings);
    const updatedState = gameManager.getGameState();
    io.emit('game-state-updated', updatedState);
    callback({ success: true });
  });

  socket.on('disconnect', () => {
    const playerId = playerSessions.get(socket.id);
    if (playerId !== undefined) {
      gameManager.playerDisconnected(playerId);
      playerSessions.delete(socket.id);
      io.emit('player-disconnected', { playerId });
      console.log(`Player ${playerId} disconnected`);
    }
  });
});

const PORT = Number(process.env.PORT) || 5000;
const HOST = process.env.HOST || '0.0.0.0';

httpServer.listen(PORT, HOST, () => {
  console.log(`Poker server running on ${HOST}:${PORT}`);
  console.log(`Allowed frontend origins: ${allowedOrigins.join(', ')}`);
});
