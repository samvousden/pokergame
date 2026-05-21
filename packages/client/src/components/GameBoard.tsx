import React, { useMemo } from 'react';
import { useGame } from '../context/GameContext';
import { CardDisplay } from './CardDisplay';
import { PlayerSeat } from './PlayerSeat';
import { CommunityCards } from './CommunityCards';
import { ActionPanel } from './ActionPanel';
import { ItemBag } from './ItemBag';
import { evaluateBestHandWithCards, getHandRankingName } from '@poker/shared';

export const GameBoard: React.FC = () => {
  const { gameState, playerId, holeCards } = useGame();

  if (!gameState || !playerId) {
    return <div>Loading...</div>;
  }

  // Compute current player's best hand rank when they have hole cards + at least some board
  const myHandRankName = useMemo(() => {
    if (!holeCards || holeCards.length < 2 || gameState.board.length < 3) return null;
    try {
      const result = evaluateBestHandWithCards(holeCards, gameState.board);
      return getHandRankingName(result.ranking);
    } catch {
      return null;
    }
  }, [holeCards, gameState.board]);

  return (
    <div className="game-board-layout">
      <ItemBag section="active" />

      <div className="game-board">
        <div className="pot-display">
          <h2>Pot: ${gameState.pot}</h2>
        </div>

        <div className="player-hole-cards">
          <h3>Your Cards</h3>
          {holeCards && holeCards.length > 0 ? (
            <div className="hole-cards">
              {holeCards.map((card, i) => (
                <CardDisplay key={i} card={card} className="hole-card" mode="display" />
              ))}
            </div>
          ) : (
            <div className="cards">Waiting for cards...</div>
          )}
        </div>

        <CommunityCards cards={gameState.board} />        <div className="players-table">
          {gameState.players.map(player => (
            <PlayerSeat
              key={player.id}
              player={player}
              isYou={player.id === playerId}
              isActive={player.id === gameState.activePlayerId}
              turnDeadline={gameState.turnDeadline}
              totalSeconds={gameState.timerSettings?.bettingSeconds ?? 30}
              isMultiplayer={gameState.gameMode === 'multiplayer'}
              handRankName={player.id === playerId ? myHandRankName : null}
            />
          ))}
        </div>

        <ActionPanel />

        <div className="game-info">
          <p>Phase: {gameState.phase}</p>
          <p>Betting Round: {gameState.round}</p>
          <p>Dealer: Player {gameState.dealerPlayerId}</p>
        </div>
      </div>

      <ItemBag section="passive" />
    </div>
  );
};
