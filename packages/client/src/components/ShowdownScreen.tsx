import React, { useMemo } from 'react';
import { useGame } from '../context/GameContext';
import { evaluateBestHandWithCards, getHandRankingName } from '@poker/shared';
import { CardDisplay } from './CardDisplay';
import { CommunityCards } from './CommunityCards';

export const ShowdownScreen: React.FC = () => {
  const { gameState, playerId, allPlayerCards, winnerId, winnerIds, foldedOut, setReady, hasGun, bullets, shootPlayer, shotFiredEvent } = useGame();

  if (!gameState) {
    return <div>Loading...</div>;
  }

  const winner = gameState.players.find(p => p.id === winnerId);
  const isTie = winnerIds.length > 1;
  const currentPlayer = gameState.players.find(p => p.id === playerId);
  const isReady = currentPlayer?.isReady ?? false;
  const nonEliminated = gameState.players.filter(p => !p.isEliminated);
  const readyCount = nonEliminated.filter(p => p.isReady).length;
  const allReady = nonEliminated.length >= 1 && nonEliminated.every(p => p.isReady);

  const winningHand = useMemo(() => {
    if (!winner || !allPlayerCards?.get(winner.id) || foldedOut) return null;
    
    const holeCards = allPlayerCards.get(winner.id)!;
    try {
      return evaluateBestHandWithCards(holeCards, gameState.board);
    } catch (e) {
      console.error('Error evaluating hand:', e);
      return null;
    }
  }, [winner, allPlayerCards, gameState.board, foldedOut]);

  return (
    <div className="showdown-screen">
      <div className="showdown-header">
        <h1>{foldedOut ? 'Hand Won!' : 'Hand Complete!'}</h1>
        {isTie ? (
          <h2 className="winner-announcement">🏆 Tie Between {winnerIds.length} Players! 🏆</h2>
        ) : (
          <h2 className="winner-announcement">🏆 {winner?.name} wins! 🏆</h2>
        )}
      </div>

      {!foldedOut && (
        <>
          <CommunityCards cards={gameState.board} />

          {winningHand && (
            <div className="winning-hand-display">
              <h3>{getHandRankingName(winningHand.ranking)}</h3>
              <div className="cards">
                {winningHand.cards.map((card, i) => (
                  <CardDisplay key={i} card={card} mode="string" />
                ))}
              </div>
            </div>
          )}          <div className="all-players-cards">
            <h3>Hands Revealed</h3>
            <div className="players-hands-grid">
              {gameState.players
                .filter(player => allPlayerCards?.has(player.id))
                .map(player => {
                  const cards = allPlayerCards!.get(player.id)!;
                  const isWinner = winnerIds.includes(player.id);
                  let handName: string | null = null;
                  try {
                    const result = evaluateBestHandWithCards(cards, gameState.board);
                    handName = getHandRankingName(result.ranking);
                  } catch { /* ignore */ }
                  return (
                    <div key={player.id} className={`player-hand ${isWinner ? 'winner' : ''}`}>
                      <h4>{player.name}</h4>
                      <div className="hole-cards-display">
                        {cards.map((card, i) => (
                          <CardDisplay key={i} card={card} className="hole-card" mode="string" />
                        ))}
                      </div>
                      {handName && <p className="hand-rank-label">{handName}</p>}
                      <p className="stack-info">Stack: ${player.stack}</p>
                      {isWinner && <p className="winner-badge">WINNER</p>}
                    </div>
                  );
                })}
            </div>
          </div>
        </>
      )}

      {shotFiredEvent && (
        <div className={`shot-result ${shotFiredEvent.backfired ? 'backfired' : 'hit'}`}>
          {shotFiredEvent.backfired
            ? `💥 ${gameState.players.find(p => p.id === shotFiredEvent.shooterId)?.name} accused ${gameState.players.find(p => p.id === shotFiredEvent.targetId)?.name} of cheating — but they were INNOCENT! Backfire!`
            : `🔫 ${gameState.players.find(p => p.id === shotFiredEvent.shooterId)?.name} caught ${gameState.players.find(p => p.id === shotFiredEvent.targetId)?.name} CHEATING! All their money is seized!`}
        </div>
      )}

      {hasGun && bullets > 0 && !currentPlayer?.isEliminated && (
        <div className="gun-section">
          <h3>🔫 Accuse a Player of Cheating ({bullets} bullet{bullets !== 1 ? 's' : ''})</h3>
          <p className="gun-warning">⚠️ If they cheated, you take all their money. If they're innocent, they take all of yours!</p>
          <div className="gun-targets">
            {gameState.players
              .filter(p => p.id !== playerId && !p.isEliminated)
              .map(p => (
                <button key={p.id} className="shoot-btn" onClick={() => shootPlayer(p.id)}>
                  🎯 Accuse {p.name}
                </button>
              ))}
          </div>
        </div>
      )}

      <div className="pot-final">
        <p className="final-pot">Final Pot: ${gameState.pot}</p>
        <div className="ready-section">
          {!isReady ? (
            <button onClick={() => setReady(true)} className="return-btn">Ready for Item Shop</button>
          ) : (
            <p className="waiting-message">Waiting for players... ({readyCount}/{nonEliminated.length} ready)</p>
          )}
        </div>
      </div>
    </div>
  );
};
