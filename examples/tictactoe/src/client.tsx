/** biome-ignore-all lint/a11y/noStaticElementInteractions: it's fine */
import { useAgent } from "agents/react";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { TicTacToeState } from "./server";
import "./styles.css";

// Add Material Icons font
const MaterialIconsLink = () => (
  <link
    href="https://fonts.googleapis.com/icon?family=Material+Icons+Round"
    rel="stylesheet"
  />
);

function App() {
  const [state, setState] = useState<TicTacToeState>({
    board: [
      [null, null, null],
      [null, null, null],
      [null, null, null],
    ],
    currentPlayer: "X",
    winner: null,
  });
  const [gamesPlayed, setGamesPlayed] = useState(0);
  const [autoPlayEnabled, setAutoPlayEnabled] = useState(true);
  const [stats, setStats] = useState({
    draws: 0,
    oWins: 0,
    xWins: 0,
  });
  const agent = useAgent<TicTacToeState>({
    agent: "tic-tac-toe",
    onStateUpdate: (state) => {
      setState(state);
    },
    prefix: "some/prefix",
  });

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
  }, [state.board, gamesPlayed, autoPlayEnabled]);

  // Check for game over and start new game after delay
  useEffect(() => {
    const isGameOver =
      state.winner ||
      state.board.every((row) => row.every((cell) => cell !== null));

    if (isGameOver) {
      // Update stats
      if (state.winner === "X") {
        setStats((prev) => ({ ...prev, xWins: prev.xWins + 1 }));
      } else if (state.winner === "O") {
        setStats((prev) => ({ ...prev, oWins: prev.oWins + 1 }));
      } else if (isGameOver) {
        setStats((prev) => ({ ...prev, draws: prev.draws + 1 }));
      }

      const timer = setTimeout(() => {
        handleNewGame();
      }, 3000);

      return () => clearTimeout(timer);
    }
  }, [state.winner, state.board]);

  const handleCellClick = async (row: number, col: number) => {
    if (state.board[row][col] !== null || state.winner) return;

    try {
      await agent.call("makeMove", [[row, col], state.currentPlayer]);
    } catch (error) {
      console.error("Error making move:", error);
    }
  };

  const handleNewGame = async () => {
    try {
      await agent.call("clearBoard");
      setGamesPlayed((prev) => prev + 1);
    } catch (error) {
      console.error("Error clearing board:", error);
    }
  };

  const renderCell = (row: number, col: number) => {
    const value = state.board[row][col];
    return (
      <div
        className={`cell ${value ? "played" : ""}`}
        onClick={() => handleCellClick(row, col)}
        key={`${row}-${col}`}
      >
        {value && (
          <span className={value === "X" ? "player-x" : "player-o"}>
            {value === "X" ? (
              <span className="material-icons-round">close</span>
            ) : (
              <span className="material-icons-round">circle</span>
            )}
          </span>
        )}
      </div>
    );
  };

  const getGameStatus = () => {
    if (state.winner) {
      return (
        <div className="status">
          Winner:{" "}
          <span className={`player-${state.winner.toLowerCase()}`}>
            {state.winner}
          </span>
          !
        </div>
      );
    }
    if (state.board.every((row) => row.every((cell) => cell !== null))) {
      return <div className="status">Game Draw!</div>;
    }
    return (
      <div className="status">
        Current Player:{" "}
        <span className={`player-${state.currentPlayer.toLowerCase()}`}>
          {state.currentPlayer}
        </span>
      </div>
    );
  };

  return (
    <>
      <MaterialIconsLink />
      <div className="game-container">
        <h1>
          <span className="material-icons-round game-icon">sports_esports</span>
          Tic Tac Toe
        </h1>
        {getGameStatus()}
        <div className="board">
          {state.board.map((row, rowIndex) =>
            row.map((_cell, colIndex) => renderCell(rowIndex, colIndex))
          )}
        </div>
        <div className="stats">
          <div className="stat-card player-x-stats">
            <div className="stat-value">{stats.xWins}</div>
            <div className="stat-label">
              <span className="material-icons-round">close</span>
              Wins
            </div>
          </div>
          <div className="stat-card player-o-stats">
            <div className="stat-value">{stats.oWins}</div>
            <div className="stat-label">
              <span className="material-icons-round">circle</span>
              Wins
            </div>
          </div>
          <div className="stat-card draw-stats">
            <div className="stat-value">{stats.draws}</div>
            <div className="stat-label">
              <span className="material-icons-round">handshake</span>
              Draws
            </div>
          </div>
        </div>
        <div className="controls">
          <button
            type="button"
            onClick={handleNewGame}
            className="new-game-button"
          >
            <span className="material-icons-round">refresh</span>
            New Game
          </button>
          <button
            type="button"
            onClick={() => setAutoPlayEnabled((prev) => !prev)}
            className={`toggle-button ${autoPlayEnabled ? "active" : ""}`}
          >
            <span className="material-icons-round">
              {autoPlayEnabled ? "smart_toy" : "psychology_alt"}
            </span>
            {autoPlayEnabled
              ? "Random First Move: On"
              : "Random First Move: Off"}
          </button>
        </div>
        <div className="games-counter">
          <span className="material-icons-round">analytics</span>
          Games played: {gamesPlayed}
        </div>
      </div>
    </>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
