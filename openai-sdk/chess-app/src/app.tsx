import { useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { createRoot } from "react-dom/client";
import { Chess, type Square } from "chess.js";
import {
  Chessboard,
  type ChessboardOptions,
  type PieceDropHandlerArgs
} from "react-chessboard";

import type { State as ServerState } from "./chess";

function usePlayerId() {
  const [pid] = useState(() => {
    const existing = localStorage.getItem("playerId");
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem("playerId", id);
    return id;
  });
  return pid;
}

type JoinReply =
  | { ok: true; role: "w" | "b"; state: ServerState }
  | { ok: true; role: "spectator"; state: ServerState };

function describeGameStatus(state: ServerState | null): string {
  if (!state) return "Connecting to game...";
  switch (state.status) {
    case "waiting":
      return "Waiting for players";
    case "active":
      return "In progress";
    case "mate":
      return state.winner === "w"
        ? "Checkmate · White wins"
        : "Checkmate · Black wins";
    case "draw":
      return "Draw";
    case "resigned":
      return state.winner
        ? `${state.winner === "w" ? "White" : "Black"} wins by resignation`
        : "Game ended by resignation";
    default:
      return state.status;
  }
}

type PlayerSlotProps = {
  label: string;
  playerId?: string;
  isCurrent: boolean;
};

function PlayerSlot({ label, playerId, isCurrent }: PlayerSlotProps) {
  const connected = Boolean(playerId);
  const highlight = isCurrent
    ? "rgba(37, 99, 235, 0.12)"
    : connected
      ? "rgba(59, 130, 246, 0.1)"
      : "rgba(15, 23, 42, 0.04)";
  const border = isCurrent
    ? "1px solid rgba(37, 99, 235, 0.6)"
    : "1px solid rgba(15, 23, 42, 0.12)";

  return (
    <div
      style={{
        width: "100%",
        borderRadius: "12px",
        padding: "12px 14px",
        backgroundColor: highlight,
        border
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: "4px" }}>{label}</div>
      <div style={{ fontSize: "0.85rem", color: "#475569" }}>
        {connected ? (
          <>
            {isCurrent ? "You" : "Player"} · <code>{playerId!.slice(-8)}</code>
          </>
        ) : (
          "Waiting for player"
        )}
      </div>
    </div>
  );
}

/** --------------------------
 *  Main App
 *  -------------------------- */
function App() {
  const widgetGameId =
    typeof window.openai?.widgetState?.gameId === "string" &&
    `${window.openai?.widgetState?.gameId === "string"}`.trim()
      ? `${window.openai?.widgetState?.gameId}`.trim()
      : "";
  const playerId = usePlayerId();

  const [gameId, setGameId] = useState<string | null>(
    widgetGameId ? widgetGameId : null
  );
  const [gameIdInput, setGameIdInput] = useState(widgetGameId);
  const [menuError, setMenuError] = useState<string | null>(null);

  const gameRef = useRef(new Chess());
  const [fen, setFen] = useState(gameRef.current.fen());
  const [myColor, setMyColor] = useState<"w" | "b" | "spectator">("spectator");
  const [pending, setPending] = useState(false);
  const [serverState, setServerState] = useState<ServerState | null>(null);
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    if (!gameId && widgetGameId) {
      setGameId(widgetGameId);
    }
    if (!gameIdInput && widgetGameId) {
      setGameIdInput(widgetGameId);
    }
  }, [widgetGameId, gameId, gameIdInput]);

  function resetLocalGame() {
    gameRef.current.reset();
    setFen(gameRef.current.fen());
    setPending(false);
    setMyColor("spectator");
    setServerState(null);
  }

  const activeGameName = gameId ?? "__lobby__";

  const { stub } = useAgent<ServerState>({
    host: "https://chess-app.agents-b8a.workers.dev",
    name: activeGameName,
    agent: "chess",
    onStateUpdate: (s) => {
      if (!gameId) return;
      gameRef.current.load(s.board);
      setFen(s.board);
      setServerState(s);
    }
  });

  useEffect(() => {
    if (!gameId || joined) return;

    (async () => {
      try {
        const res = (await stub.join({
          playerId,
          preferred: "any"
        })) as JoinReply;

        if (!res?.ok) return;

        setMyColor(res.role);
        gameRef.current.load(res.state.board);
        setFen(res.state.board);
        setServerState(res.state);
        setJoined(true);
      } catch (error) {
        console.error("Failed to join game", error);
      }
    })();
  }, [playerId, gameId, stub, joined]);

  async function handleStartNewGame() {
    const newId = crypto.randomUUID();
    await window.openai?.setWidgetState({ gameId: newId });
    resetLocalGame();
    setMenuError(null);
    setGameIdInput(newId);
    setGameId(newId);
  }

  async function handleJoinGame() {
    const trimmed = gameIdInput.trim();
    if (!trimmed) {
      setMenuError("Enter a game ID to join.");
      return;
    }
    resetLocalGame();
    setMenuError(null);
    await window.openai?.setWidgetState({ gameId: trimmed });
    setGameId(trimmed);
  }

  // Trigger a message on the ChatGPT conversation to help with the current board state
  const handleHelpClick = () => {
    window.openai?.sendFollowUpMessage?.({
      prompt: `Help me with my chess game. I am playing as ${myColor} and the board is: ${fen}. Please only offer written advice as there are no tools for you to use.`
    });
  };

  const handleResign = async () => {
    await stub.resign();
  };

  // Local-then-server move with reconcile
  function onPieceDrop({
    sourceSquare,
    targetSquare
  }: PieceDropHandlerArgs): boolean {
    if (!gameId || !sourceSquare || !targetSquare || pending) return false;

    const game = gameRef.current;

    // must be seated and your turn
    if (myColor === "spectator") return false;
    if (game.turn() !== myColor) return false;

    // must be your piece
    const piece = game.get(sourceSquare as Square);
    if (!piece || piece.color !== myColor) return false;

    const prevFen = game.fen();

    try {
      const local = game.move({
        from: sourceSquare,
        to: targetSquare,
        promotion: "q"
      });
      if (!local) return false;
    } catch {
      return false;
    }

    const nextFen = game.fen();
    setFen(nextFen);
    setPending(true);

    // reconcile with server
    stub
      .move({ from: sourceSquare, to: targetSquare, promotion: "q" }, prevFen)
      .then((r: { ok: boolean; fen: string }) => {
        if (!r.ok) {
          // rollback to server position
          game.load(r.fen);
          setFen(r.fen);
        }
      })
      .finally(() => setPending(false));

    return true;
  }

  const chessboardOptions: ChessboardOptions = {
    id: `pvp-${activeGameName}`,
    position: fen,
    onPieceDrop,
    boardOrientation: myColor === "b" ? "black" : "white",
    allowDragging: !pending && myColor !== "spectator"
  };

  const maxSize = window.openai?.maxHeight ?? 650;
  const boardSize = Math.max(Math.min(maxSize - 120, 560), 320);
  const statusText = describeGameStatus(serverState);
  const whiteId = serverState?.players?.w;
  const blackId = serverState?.players?.b;

  return (
    <div
      style={{
        padding: "20px 16px",
        background: "linear-gradient(180deg, #f8fafc 0%, #e2e8f0 100%)",
        minHeight: "100%",
        boxSizing: "border-box"
      }}
    >
      <div style={{ maxWidth: "960px", margin: "0 auto" }}>
        {!gameId ? (
          <div
            style={{
              maxWidth: "420px",
              margin: "0 auto",
              backgroundColor: "#ffffff",
              borderRadius: "16px",
              padding: "24px",
              boxShadow: "0 12px 30px rgba(15, 23, 42, 0.12)",
              display: "flex",
              flexDirection: "column",
              gap: "16px"
            }}
          >
            <h1 style={{ fontSize: "1.5rem", margin: 0 }}>Ready to play?</h1>
            <p style={{ margin: 0, color: "#475569", lineHeight: 1.4 }}>
              Start a new match to generate a shareable game code or join an
              existing game by pasting its ID below.
            </p>
            <button
              type="button"
              style={{
                padding: "12px 16px",
                borderRadius: "12px",
                border: "none",
                background: "#2563eb",
                color: "#ffffff",
                fontWeight: 600,
                cursor: "pointer"
              }}
              onClick={handleStartNewGame}
            >
              Start a new game
            </button>
            <div
              style={{ display: "flex", flexDirection: "column", gap: "8px" }}
            >
              <label
                htmlFor="gameId"
                style={{ fontSize: "0.85rem", color: "#475569" }}
              >
                Join with game ID
              </label>
              <div style={{ display: "flex", gap: "8px" }}>
                <input
                  name="gameId"
                  style={{
                    flex: 1,
                    padding: "10px 12px",
                    borderRadius: "10px",
                    border: "1px solid rgba(15, 23, 42, 0.2)",
                    fontSize: "0.95rem"
                  }}
                  placeholder="Paste a game ID"
                  value={gameIdInput}
                  onChange={(event) => {
                    setGameIdInput(event.target.value);
                    if (menuError) setMenuError(null);
                  }}
                />
                <button
                  type="button"
                  style={{
                    padding: "10px 16px",
                    borderRadius: "10px",
                    border: "none",
                    background: "#0f172a",
                    color: "#ffffff",
                    fontWeight: 600,
                    cursor: "pointer"
                  }}
                  onClick={handleJoinGame}
                >
                  Join
                </button>
              </div>
              {menuError ? (
                <span style={{ color: "#b91c1c", fontSize: "0.8rem" }}>
                  {menuError}
                </span>
              ) : null}
            </div>
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "16px"
            }}
          >
            <div
              style={{
                backgroundColor: "#ffffff",
                padding: "18px 20px",
                borderRadius: "16px",
                boxShadow: "0 10px 24px rgba(15, 23, 42, 0.12)",
                display: "flex",
                flexWrap: "wrap",
                gap: "16px",
                justifyContent: "space-between",
                alignItems: "center"
              }}
            >
              <div>
                <div style={{ fontSize: "1.1rem", fontWeight: 600 }}>
                  Game {gameId}
                </div>
                <div style={{ fontSize: "0.9rem", color: "#475569" }}>
                  {statusText}
                </div>
                <div style={{ fontSize: "0.9rem", color: "#475569" }}>
                  {myColor === "spectator"
                    ? "You are watching as a spectator"
                    : playerId === serverState?.players[gameRef.current.turn()]
                      ? "Your turn"
                      : `Waiting for ${myColor === "w" ? "Black" : "White"}`}
                </div>
              </div>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <button
                  type="button"
                  style={{
                    padding: "10px 16px",
                    borderRadius: "10px",
                    border: "none",
                    background: "red",
                    color: "#ffffff",
                    fontWeight: 600,
                    cursor: "pointer"
                  }}
                  onClick={handleResign}
                >
                  Resign
                </button>
                <button
                  type="button"
                  style={{
                    padding: "10px 16px",
                    borderRadius: "10px",
                    border: "none",
                    background: "#2563eb",
                    color: "#ffffff",
                    fontWeight: 600,
                    cursor: "pointer"
                  }}
                  onClick={handleHelpClick}
                >
                  Ask for help
                </button>
              </div>
            </div>
            <div
              style={{
                backgroundColor: "#ffffff",
                borderRadius: "16px",
                padding: "16px",
                boxShadow: "0 10px 24px rgba(15, 23, 42, 0.1)",
                display: "flex",
                flexDirection: "column",
                gap: "12px"
              }}
            >
              <div style={{ fontWeight: 600, fontSize: "1rem" }}>Players</div>
              <div
                style={{
                  display: "flex",
                  gap: "12px"
                }}
              >
                <PlayerSlot
                  label="White"
                  playerId={whiteId}
                  isCurrent={whiteId === playerId}
                />
                <PlayerSlot
                  label="Black"
                  playerId={blackId}
                  isCurrent={blackId === playerId}
                />
              </div>
              {myColor === "spectator" ? (
                <div style={{ fontSize: "0.85rem", color: "#475569" }}>
                  You're observing for now. We'll seat you automatically if a
                  spot opens up.
                </div>
              ) : null}
            </div>

            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "16px",
                alignItems: "flex-start",
                justifyContent: "center"
              }}
            >
              <div
                style={{
                  flex: "1 1 360px",
                  display: "flex",
                  justifyContent: "center",
                  backgroundColor: "#ffffff",
                  borderRadius: "16px",
                  padding: "16px",
                  boxShadow: "0 10px 24px rgba(15, 23, 42, 0.1)"
                }}
              >
                <div
                  style={{
                    width: `${boardSize}px`,
                    height: `${boardSize}px`
                  }}
                >
                  <Chessboard
                    options={{
                      ...chessboardOptions,
                      id: `pvp-${gameId}-${myColor}`
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
