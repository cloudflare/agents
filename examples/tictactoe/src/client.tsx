import { useAgent } from "agents/react";
import {
  ArrowsClockwiseIcon,
  ChartBarIcon,
  CircleIcon,
  GameControllerIcon,
  HandshakeIcon,
  XIcon
} from "@phosphor-icons/react";
import { Button, Surface, Switch, Text } from "@cloudflare/kumo";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { TicTacToeState } from "./server";
import "./styles.css";

function App() {
  const [state, setState] = useState<TicTacToeState>({
    board: [
      [null, null, null],
      [null, null, null],
      [null, null, null]
    ],
    currentPlayer: "X",
    winner: null
  });
  const [gamesPlayed, setGamesPlayed] = useState(0);
  const [autoPlayEnabled, setAutoPlayEnabled] = useState(true);
  const [stats, setStats] = useState({
    draws: 0,
    oWins: 0,
    xWins: 0
  });

  const agent = useAgent<TicTacToeState>({
    agent: "tic-tac-toe",
    onStateUpdate: (newState) => {
      setState(newState);
    },
    prefix: "some/prefix"
  });

  const handleCellClick = useCallback(
    async (row: number, col: number) => {
      if (state.board[row][col] !== null || state.winner) return;
      try {
        await agent.call("makeMove", [[row, col], state.currentPlayer]);
      } catch (error) {
        console.error("Error making move:", error);
      }
    },
    [agent, state.board, state.winner, state.currentPlayer]
  );

  const handleNewGame = useCallback(async () => {
    try {
      await agent.call("clearBoard");
      setGamesPlayed((prev) => prev + 1);
    } catch (error) {
      console.error("Error clearing board:", error);
    }
  }, [agent]);

  // Make random move when new game starts
  useEffect(() => {
    const isBoardEmpty = state.board.every((row) =>
      row.every((cell) => cell === null)
    );

    if (isBoardEmpty && gamesPlayed > 0 && autoPlayEnabled) {
      const timer = setTimeout(() => {
        const row = Math.floor(Math.random() * 3);
        const col = Math.floor(Math.random() * 3);
        handleCellClick(row, col);
      }, 1000);

      return () => clearTimeout(timer);
    }
  }, [state.board, gamesPlayed, autoPlayEnabled, handleCellClick]);

  // Check for game over and start new game after delay
  useEffect(() => {
    const isGameOver =
      state.winner ||
      state.board.every((row) => row.every((cell) => cell !== null));

    if (isGameOver) {
      if (state.winner === "X") {
        setStats((prev) => ({ ...prev, xWins: prev.xWins + 1 }));
      } else if (state.winner === "O") {
        setStats((prev) => ({ ...prev, oWins: prev.oWins + 1 }));
      } else {
        setStats((prev) => ({ ...prev, draws: prev.draws + 1 }));
      }

      const timer = setTimeout(() => {
        handleNewGame();
      }, 3000);

      return () => clearTimeout(timer);
    }
  }, [state.winner, state.board, handleNewGame]);

  const renderCell = (row: number, col: number) => {
    const value = state.board[row][col];
    return (
      // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- game board cell
      <div
        className={`cell ${value ? "played" : ""}`}
        onClick={() => handleCellClick(row, col)}
        key={`${row}-${col}`}
      >
        {value === "X" && (
          <XIcon size={40} weight="bold" className="text-kumo-info" />
        )}
        {value === "O" && (
          <CircleIcon size={36} weight="bold" className="text-kumo-danger" />
        )}
      </div>
    );
  };

  const playerSymbol = (player: "X" | "O") =>
    player === "X" ? "\u2A09" : "\u25EF";

  const getGameStatus = () => {
    if (state.winner) {
      const isX = state.winner === "X";
      return (
        <Surface className="rounded-xl px-4 py-3 text-center ring ring-kumo-line">
          <Text size="lg">
            Winner:{" "}
            <span
              className={`font-bold ${isX ? "text-kumo-info" : "text-kumo-danger"}`}
            >
              {playerSymbol(state.winner)}
            </span>
            !
          </Text>
        </Surface>
      );
    }

    if (state.board.every((row) => row.every((cell) => cell !== null))) {
      return (
        <Surface className="rounded-xl px-4 py-3 text-center ring ring-kumo-line">
          <Text size="lg">Game Draw!</Text>
        </Surface>
      );
    }

    return (
      <Surface className="rounded-xl px-4 py-3 text-center ring ring-kumo-line">
        <Text size="lg">
          Current Player:{" "}
          <span
            className={`font-bold ${
              state.currentPlayer === "X"
                ? "text-kumo-info"
                : "text-kumo-danger"
            }`}
          >
            {playerSymbol(state.currentPlayer)}
          </span>
        </Text>
      </Surface>
    );
  };

  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <Surface className="w-full max-w-md rounded-2xl p-8 ring ring-kumo-line">
        {/* Title */}
        <div className="flex items-center justify-center gap-3 mb-6">
          <GameControllerIcon
            size={32}
            weight="duotone"
            className="text-kumo-brand"
          />
          <Text variant="heading1">Tic Tac Toe</Text>
        </div>

        {/* Game status */}
        {getGameStatus()}

        {/* Board */}
        <div className="grid grid-cols-3 gap-3 my-6 max-w-xs mx-auto">
          {state.board.map((row, rowIndex) =>
            row.map((_cell, colIndex) => renderCell(rowIndex, colIndex))
          )}
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          <Surface className="rounded-xl p-4 text-center ring ring-kumo-line bg-blue-500/10">
            <div className="text-2xl font-semibold text-kumo-info">
              {stats.xWins}
            </div>
            <div className="flex items-center justify-center gap-1 text-sm text-kumo-secondary mt-1">
              <XIcon size={14} weight="bold" />
              Wins
            </div>
          </Surface>
          <Surface className="rounded-xl p-4 text-center ring ring-kumo-line bg-red-500/10">
            <div className="text-2xl font-semibold text-kumo-danger">
              {stats.oWins}
            </div>
            <div className="flex items-center justify-center gap-1 text-sm text-kumo-secondary mt-1">
              <CircleIcon size={14} weight="bold" />
              Wins
            </div>
          </Surface>
          <Surface className="rounded-xl p-4 text-center ring ring-kumo-line bg-kumo-brand/10">
            <div className="text-2xl font-semibold text-kumo-brand">
              {stats.draws}
            </div>
            <div className="flex items-center justify-center gap-1 text-sm text-kumo-secondary mt-1">
              <HandshakeIcon size={14} weight="bold" />
              Draws
            </div>
          </Surface>
        </div>

        {/* Controls */}
        <div className="space-y-3 mb-6">
          <Button
            onClick={handleNewGame}
            className="w-full justify-center"
            icon={<ArrowsClockwiseIcon size={16} />}
          >
            New Game
          </Button>

          <div className="rounded-lg bg-kumo-control px-4 h-[36px] flex items-center justify-center">
            <Switch
              checked={autoPlayEnabled}
              onCheckedChange={(checked) => setAutoPlayEnabled(checked)}
              label="Random First Move"
              controlFirst={false}
            />
          </div>
        </div>

        {/* Games counter */}
        <div className="flex items-center justify-center gap-2 text-sm text-kumo-secondary">
          <ChartBarIcon size={16} />
          Games played: {gamesPlayed}
        </div>
      </Surface>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
