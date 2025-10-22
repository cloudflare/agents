import { Agent, callable, getCurrentAgent } from "agents";
import { Chess } from "chess.js";

type Color = "w" | "b";

type ConnectionState = {
  playerId: string;
};

export type State = {
  board: string;
  players: { w?: string; b?: string }; // sessionId per seat
  status: "waiting" | "active" | "mate" | "draw" | "resigned";
  winner?: Color;
  lastSan?: string;
};

export class ChessGame extends Agent<Env, State> {
  initialState: State = {
    board: new Chess().fen(),
    players: {},
    status: "waiting"
  };

  game = new Chess();

  constructor(
    ctx: DurableObjectState,
    public env: Env
  ) {
    super(ctx, env);
    this.game.load(this.state.board);
  }

  private colorOf(playerId: string): Color | undefined {
    const { players } = this.state;
    if (players.w === playerId) return "w";
    if (players.b === playerId) return "b";
    return undefined;
  }

  @callable()
  join(params: { playerId: string; preferred?: Color | "any" }) {
    const { playerId, preferred = "any" } = params;
    const { connection } = getCurrentAgent();
    if (!connection) throw new Error("Not connected");

    // TODO: we could store the color directly
    connection.setState({ playerId });
    const s = this.state;

    // already seated? return seat
    const already = this.colorOf(playerId);
    if (already) {
      return { ok: true, role: already as Color, state: s };
    }

    // choose a seat
    const free: Color[] = (["w", "b"] as const).filter((c) => !s.players[c]);
    if (free.length === 0) {
      return { ok: true, role: "spectator" as const, state: s };
    }

    let seat: Color = free[0];
    if (preferred === "w" && free.includes("w")) seat = "w";
    if (preferred === "b" && free.includes("b")) seat = "b";

    s.players[seat] = playerId;
    s.status = s.players.w && s.players.b ? "active" : "waiting";
    this.setState(s);
    return { ok: true, role: seat, state: s };
  }

  @callable()
  leave() {
    const { connection } = getCurrentAgent();
    if (!connection) throw new Error("Not connected");

    const { playerId } = connection.state as ConnectionState;

    const seat = this.colorOf(playerId);
    if (!seat) return { ok: true, state: this.state };
    this.state.players[seat] = undefined;
    this.state.status = "waiting";
    this.setState(this.state);
    return { ok: true, state: this.state };
  }

  @callable()
  move(
    move: { from: string; to: string; promotion?: string },
    expectedFen?: string
  ): {
    ok: boolean;
    reason?: string;
    fen: string;
    san?: string;
    status: State["status"];
  } {
    // check there are 2 players
    if (this.state.status === "waiting") {
      return {
        ok: false,
        reason: "not-in-game",
        fen: this.game.fen(),
        status: this.state.status
      };
    }

    const { connection } = getCurrentAgent();
    if (!connection) throw new Error("Not connected");
    const { playerId } = connection.state as ConnectionState;
    // must be seated
    const seat = this.colorOf(playerId);
    if (!seat)
      return {
        ok: false,
        reason: "not-in-game",
        fen: this.game.fen(),
        status: this.state.status
      };

    // must be your turn
    if (seat !== this.game.turn()) {
      return {
        ok: false,
        reason: "not-your-turn",
        fen: this.game.fen(),
        status: this.state.status
      };
    }

    // optimistic-sync guard
    if (expectedFen && expectedFen !== this.game.fen()) {
      return {
        ok: false,
        reason: "stale",
        fen: this.game.fen(),
        status: this.state.status
      };
    }

    const res = this.game.move(move);
    if (!res) {
      return {
        ok: false,
        reason: "illegal",
        fen: this.game.fen(),
        status: this.state.status
      };
    }

    // update state & terminal checks
    const fen = this.game.fen();
    let status: State["status"] = "active";
    if (this.game.isCheckmate()) status = "mate";
    else if (this.game.isDraw()) status = "draw";

    this.setState({
      ...this.state,
      board: fen,
      lastSan: res.san,
      status,
      winner:
        status === "mate" ? (this.game.turn() === "w" ? "b" : "w") : undefined
    });

    return { ok: true, fen, san: res.san, status };
  }

  @callable()
  resign() {
    const { connection } = getCurrentAgent();
    if (!connection) throw new Error("Not connected");
    const { playerId } = connection.state as ConnectionState;

    const seat = this.colorOf(playerId);
    if (!seat) return { ok: false, reason: "not-in-game", state: this.state };
    const winner = seat === "w" ? "b" : "w";
    this.setState({ ...this.state, status: "resigned", winner });
    return { ok: true, state: this.state };
  }
}
