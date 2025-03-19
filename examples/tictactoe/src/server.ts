import { createOpenAI } from "@ai-sdk/openai";
import {
  Agent,
  routeAgentRequest,
  unstable_callable as callable,
  type AgentNamespace,
  type Connection,
} from "agents";

import { generateObject } from "ai";
import { z } from "zod";

type Env = {
  OPENAI_API_KEY: string;
  TicTacToe: AgentNamespace<TicTacToe>;
};

type Player = "X" | "O";

type played = Player | null;

export type TicTacToeState = {
  board: [
    [played, played, played],
    [played, played, played],
    [played, played, played],
  ];
  currentPlayer: Player;
  winner: Player | null;
};

export class TicTacToe extends Agent<Env, TicTacToeState> {
  openai = createOpenAI({
    apiKey: this.env.OPENAI_API_KEY,
  });
  initialState: TicTacToeState = {
    board: [
      [null, null, null],
      [null, null, null],
      [null, null, null],
    ],
    currentPlayer: "X",
    winner: null,
  };

  @callable()
  async makeMove(move: [number, number], player: Player) {
    if (this.state.currentPlayer !== player) {
      throw new Error("It's not your turn");
    }
    const [row, col] = move;
    if (this.state.board[row][col] !== null) {
      throw new Error("Cell already played");
    }
    const board: TicTacToeState["board"] = this.state.board.map((row) =>
      row.map((cell) => cell)
    ) as TicTacToeState["board"];
    board[row][col] = player;
    this.setState({
      ...this.state,
      board,
      currentPlayer: player === "X" ? "O" : "X",
      winner: this.checkWinner(board),
    });

    if (this.state.winner) {
      return;
    }
    // also return if the board is full
    if (this.state.board.every((row) => row.every((cell) => cell !== null))) {
      return;
    }

    // now use AI to make a move
    const { object } = await generateObject({
      model: this.openai("gpt-4o"),
      schema: z.object({
        move: z.array(z.number()),
      }),
      prompt: `The current board is ${JSON.stringify(board)}. The current player is ${player === "X" ? "O" : "X"}. The other player is ${player}.`,
    });
    await this.makeMove(
      object.move as [number, number],
      player === "X" ? "O" : "X"
    );
  }

  checkWinner(board: TicTacToeState["board"]): Player | null {
    const winningLines = [
      // rows
      [
        [0, 0],
        [0, 1],
        [0, 2],
      ],
      [
        [1, 0],
        [1, 1],
        [1, 2],
      ],
      [
        [2, 0],
        [2, 1],
        [2, 2],
      ],
      // columns
      [
        [0, 0],
        [1, 0],
        [2, 0],
      ],
      [
        [0, 1],
        [1, 1],
        [2, 1],
      ],
      [
        [0, 2],
        [1, 2],
        [2, 2],
      ],
      // diagonals
      [
        [0, 0],
        [1, 1],
        [2, 2],
      ],
      [
        [0, 2],
        [1, 1],
        [2, 0],
      ],
    ];
    for (const line of winningLines) {
      const [a, b, c] = line;
      if (
        board[a[0]][a[1]] &&
        board[a[0]][a[1]] === board[b[0]][b[1]] &&
        board[a[0]][a[1]] === board[c[0]][c[1]]
      ) {
        return board[a[0]][a[1]] as Player;
      }
    }
    return null;
  }

  @callable()
  async clearBoard() {
    this.setState(this.initialState);
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
