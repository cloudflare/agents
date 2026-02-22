import { openai } from "@ai-sdk/openai";
import { Agent, callable, routeAgentRequest } from "agents";

import { generateObject } from "ai";
import { z } from "zod";

type Player = "X" | "O";

type played = Player | null;

export type TicTacToeState = {
  board: [
    [played, played, played],
    [played, played, played],
    [played, played, played]
  ];
  currentPlayer: Player;
  winner: Player | null;
};

export class TicTacToe extends Agent<Env, TicTacToeState> {
  initialState: TicTacToeState = {
    board: [
      [null, null, null],
      [null, null, null],
      [null, null, null]
    ],
    currentPlayer: "X",
    winner: null
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
      winner: this.checkWinner(board)
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
      model: openai("gpt-4o"),
      prompt: `You are playing Tic-tac-toe as player ${player === "X" ? "O" : "X"}. Here's the current board state:

${JSON.stringify(board, null, 2)}

Game rules and context:
- You are playing against ${player}
- Empty cells are null, X's are "X", O's are "O"
- Board positions are [row, col] from 0-2
- You need to respond with a single move as [row, col]
- Winning patterns: 3 in a row horizontally, vertically, or diagonally

Strategic priorities (in order):
1. If you can win in one move, take it
2. If opponent can win in one move, block it
3. If center is open, take it
4. If you can create a fork (two potential winning moves), do it
5. If opponent can create a fork next turn, block it
6. Take a corner if available
7. Take any edge

Analyze the board carefully and make the optimal move following these priorities.
Return only the [row, col] coordinates for your chosen move.`,
      schema: z.object({
        move: z.array(z.number())
      })
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
        [0, 2]
      ],
      [
        [1, 0],
        [1, 1],
        [1, 2]
      ],
      [
        [2, 0],
        [2, 1],
        [2, 2]
      ],
      // columns
      [
        [0, 0],
        [1, 0],
        [2, 0]
      ],
      [
        [0, 1],
        [1, 1],
        [2, 1]
      ],
      [
        [0, 2],
        [1, 2],
        [2, 2]
      ],
      // diagonals
      [
        [0, 0],
        [1, 1],
        [2, 2]
      ],
      [
        [0, 2],
        [1, 1],
        [2, 0]
      ]
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
      (await routeAgentRequest(request, env, { prefix: "some/prefix" })) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
