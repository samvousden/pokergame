import React from 'react';
import { PlayerPublicState, PokerActionType } from '@poker/shared';
import { TurnTimer } from './TurnTimer';

const formatLastAction = (lastAction?: { type: number; amount?: number }): string => {
  if (!lastAction) return '';
  switch (lastAction.type) {
    case PokerActionType.Fold:   return 'Fold';
    case PokerActionType.Check:  return 'Check';
    case PokerActionType.Call:   return `Call${lastAction.amount ? `: $${lastAction.amount}` : ''}`;
    case PokerActionType.RaiseTo: return `Raise: $${lastAction.amount}`;
    default: return '';
  }
};

interface PlayerSeatProps {
  player: PlayerPublicState;
  isYou: boolean;
  isActive: boolean;
  turnDeadline?: number | null;
  totalSeconds?: number;
  isMultiplayer?: boolean;
  handRankName?: string | null;
}

export const PlayerSeat: React.FC<PlayerSeatProps> = ({
  player,
  isYou,
  isActive,
  turnDeadline,
  totalSeconds = 30,
  isMultiplayer = false,
  handRankName,
}) => (
  <div className={`player-seat ${isYou ? 'is-you' : ''} ${isActive ? 'active-player' : ''} ${player.isEliminated ? 'eliminated' : ''}`}>
    {isActive && <div className="active-indicator">●</div>}
    {isActive && isMultiplayer && !isYou && (
      <TurnTimer deadline={turnDeadline ?? null} totalSeconds={totalSeconds} compact />
    )}
    <h4>{player.name}</h4>    {player.isEliminated ? (
      <p className="stack-eliminated">Eliminated</p>
    ) : (
      <p>Stack: ${player.stack}</p>
    )}
    {isYou && handRankName && (
      <p className="hand-rank-label">🃏 {handRankName}</p>
    )}
    {player.lastAction && !player.isEliminated && (
      <p className="last-action">{formatLastAction(player.lastAction)}</p>
    )}
    {player.isReady && <span className="badge ready">Ready</span>}
    {player.hasFolded && <span className="badge folded">Folded</span>}
    {player.isAllIn && <span className="badge all-in">All In</span>}
    {player.isEliminated && <span className="badge eliminated-badge">☠️ Out</span>}
  </div>
);
