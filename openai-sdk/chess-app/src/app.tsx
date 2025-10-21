import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Chess, type Square } from "chess.js";
import {
  Chessboard,
  type ChessboardOptions,
  type PieceDropHandlerArgs
} from "react-chessboard";
import { useAgent } from "agents/react";
import { useToolResponseMetadata, useOpenAiGlobal } from "./react-utils";

/** --------------------------
 *  Player / Game ID helpers
 *  -------------------------- */
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

/**
 * Keep a local gameId state that:
 * - initializes from widgetState.gameId or creates a new one
 * - pushes to widgetState when it changes
 * - listens for external widgetState changes and pulls them in
 */
function useGameId(): readonly [string | null, (v: string) => void] {
  const meta = useToolResponseMetadata();
  const [gameId, setGameId] = useState<string | null>(null);

  // Adopt meta.gameId once when it appears; fall back to a random id
  useEffect(() => {
    if (!gameId) {
      const incoming =
        (meta?.gameId as string | undefined) ?? crypto.randomUUID();
      setGameId(incoming);
    }
  }, [meta?.gameId, gameId]);

  return [gameId, setGameId] as const;
}

/** --------------------------
 *  Types from server
 *  -------------------------- */
type ServerState = {
  board: string; // FEN
  players: { w?: string; b?: string };
  status: "waiting" | "active" | "mate" | "draw" | "resigned";
  winner?: "w" | "b";
};

type JoinReply =
  | { ok: true; role: "w" | "b"; state: ServerState }
  | { ok: true; role: "spectator"; state: ServerState };

/** --------------------------
 *  Main App
 *  -------------------------- */
function App() {
  const [gameId, setGameId] = useGameId();
  const playerId = usePlayerId();

  const gameRef = useRef(new Chess());
  const [fen, setFen] = useState(gameRef.current.fen());
  const [myColor, setMyColor] = useState<"w" | "b" | "spectator">("spectator");
  const [pending, setPending] = useState(false);

  // Server agent keyed by gameId
  const { stub } = useAgent<ServerState>({
    host: "https://chess-app.agents-b8a.workers.dev",
    name: gameId ?? "default",
    agent: "chess",
    onStateUpdate: (s) => {
      gameRef.current.load(s.board);
      setFen(s.board);
    }
  });

  // Join/seat the player whenever stub (i.e., gameId) or playerId changes
  useEffect(() => {
    let alive = true;
    (async () => {
      const res = (await stub.join({
        playerId,
        preferred: "any"
      })) as JoinReply;

      if (!alive || !res?.ok) return;

      setMyColor(res.role);
      gameRef.current.load(res.state.board);
      setFen(res.state.board);
    })();
    return () => {
      alive = false;
    };
  }, [stub, playerId]);

  // Local-then-server move with reconcile
  function onPieceDrop({
    sourceSquare,
    targetSquare
  }: PieceDropHandlerArgs): boolean {
    if (!sourceSquare || !targetSquare || pending) return false;

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

  const chessboardOptions: ChessboardOptions = useMemo(
    () =>
      ({
        id: "pvp",
        position: fen,
        onPieceDrop,
        boardOrientation: myColor === "b" ? "black" : "white",
        allowDragging: !pending && myColor !== "spectator"
      }) as ChessboardOptions,
    [fen, onPieceDrop, myColor, pending]
  );

  const maxSize = window.openai?.maxHeight ?? 750;

  if (!gameId) return <h1>Loading...</h1>;
  return (
    <div
      style={{
        backgroundColor: "#f0f0f0",
        borderRadius: "10px",
        padding: "12px"
      }}
    >
      <div
        style={{
          padding: "5px",
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between"
        }}
      >
        <div>
          <span>
            <strong>Game:</strong> {gameId}
          </span>
          <span> | </span>
          <span>
            <strong>You:</strong>{" "}
            {myColor === "spectator"
              ? "Spectator"
              : myColor === "w"
                ? "White"
                : "Black"}
          </span>
        </div>
        <button
          style={{
            padding: "5px 10px",
            borderRadius: "5px",
            backgroundColor: "#007bff",
            color: "white",
            border: "none",
            cursor: "pointer"
          }}
          onClick={() =>
            window.openai?.sendFollowUpMessage?.({
              prompt:
                "Help me with my chess game. I am playing as " +
                myColor +
                " and the board is: " +
                fen +
                ". Please only offer written advice as there are no tools for you to use."
            })
          }
        >
          Help
        </button>
      </div>

      <div
        style={{
          height: `${maxSize - 50}px`,
          width: `${maxSize - 50}px`,
          margin: "auto"
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
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
