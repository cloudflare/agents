/**
 * AWK Abstract Syntax Tree Types
 *
 * Follows the same discriminated union pattern as the main bash AST.
 */

// ─── Expressions ───────────────────────────────────────────

export type AwkExpr =
  | AwkNumberLiteral
  | AwkStringLiteral
  | AwkRegexLiteral
  | AwkFieldRef
  | AwkVariable
  | AwkArrayAccess
  | AwkBinaryOp
  | AwkUnaryOp
  | AwkTernaryOp
  | AwkFunctionCall
  | AwkAssignment
  | AwkPreIncrement
  | AwkPreDecrement
  | AwkPostIncrement
  | AwkPostDecrement
  | AwkGetline
  | AwkInExpr
  | AwkTuple;

export interface AwkNumberLiteral {
  type: "number";
  value: number;
}

export interface AwkStringLiteral {
  type: "string";
  value: string;
}

export interface AwkRegexLiteral {
  type: "regex";
  pattern: string;
}

export interface AwkFieldRef {
  type: "field";
  index: AwkExpr;
}

export interface AwkVariable {
  type: "variable";
  name: string;
}

export interface AwkArrayAccess {
  type: "array_access";
  array: string;
  key: AwkExpr;
}

export interface AwkBinaryOp {
  type: "binary";
  operator:
    | "+"
    | "-"
    | "*"
    | "/"
    | "%"
    | "^"
    | "=="
    | "!="
    | "<"
    | ">"
    | "<="
    | ">="
    | "~"
    | "!~"
    | "&&"
    | "||"
    | " "; // concatenation
  left: AwkExpr;
  right: AwkExpr;
}

export interface AwkUnaryOp {
  type: "unary";
  operator: "!" | "-" | "+";
  operand: AwkExpr;
}

export interface AwkPreIncrement {
  type: "pre_increment";
  operand: AwkVariable | AwkArrayAccess | AwkFieldRef;
}

export interface AwkPreDecrement {
  type: "pre_decrement";
  operand: AwkVariable | AwkArrayAccess | AwkFieldRef;
}

export interface AwkPostIncrement {
  type: "post_increment";
  operand: AwkVariable | AwkArrayAccess | AwkFieldRef;
}

export interface AwkPostDecrement {
  type: "post_decrement";
  operand: AwkVariable | AwkArrayAccess | AwkFieldRef;
}

export interface AwkTernaryOp {
  type: "ternary";
  condition: AwkExpr;
  consequent: AwkExpr;
  alternate: AwkExpr;
}

export interface AwkFunctionCall {
  type: "call";
  name: string;
  args: AwkExpr[];
}

export interface AwkAssignment {
  type: "assignment";
  operator: "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "^=";
  target: AwkFieldRef | AwkVariable | AwkArrayAccess;
  value: AwkExpr;
}

export interface AwkInExpr {
  type: "in";
  key: AwkExpr;
  array: string;
}

export interface AwkGetline {
  type: "getline";
  variable?: string;
  file?: AwkExpr;
  command?: AwkExpr; // For "cmd" | getline [var]
}

export interface AwkTuple {
  type: "tuple";
  elements: AwkExpr[];
}

// ─── Statements ────────────────────────────────────────────

export type AwkStmt =
  | AwkExpressionStmt
  | AwkPrintStmt
  | AwkPrintfStmt
  | AwkIfStmt
  | AwkWhileStmt
  | AwkDoWhileStmt
  | AwkForStmt
  | AwkForInStmt
  | AwkBreakStmt
  | AwkContinueStmt
  | AwkNextStmt
  | AwkNextFileStmt
  | AwkExitStmt
  | AwkReturnStmt
  | AwkDeleteStmt
  | AwkBlock;

export interface AwkExpressionStmt {
  type: "expr_stmt";
  expression: AwkExpr;
}

export interface AwkPrintStmt {
  type: "print";
  args: AwkExpr[];
  output?: { redirect: ">" | ">>"; file: AwkExpr };
}

export interface AwkPrintfStmt {
  type: "printf";
  format: AwkExpr;
  args: AwkExpr[];
  output?: { redirect: ">" | ">>"; file: AwkExpr };
}

export interface AwkIfStmt {
  type: "if";
  condition: AwkExpr;
  consequent: AwkStmt;
  alternate?: AwkStmt;
}

export interface AwkWhileStmt {
  type: "while";
  condition: AwkExpr;
  body: AwkStmt;
}

export interface AwkDoWhileStmt {
  type: "do_while";
  body: AwkStmt;
  condition: AwkExpr;
}

export interface AwkForStmt {
  type: "for";
  init?: AwkExpr;
  condition?: AwkExpr;
  update?: AwkExpr;
  body: AwkStmt;
}

export interface AwkForInStmt {
  type: "for_in";
  variable: string;
  array: string;
  body: AwkStmt;
}

export interface AwkBlock {
  type: "block";
  statements: AwkStmt[];
}

export interface AwkBreakStmt {
  type: "break";
}
export interface AwkContinueStmt {
  type: "continue";
}
export interface AwkNextStmt {
  type: "next";
}
export interface AwkNextFileStmt {
  type: "nextfile";
}
export interface AwkExitStmt {
  type: "exit";
  code?: AwkExpr;
}
export interface AwkReturnStmt {
  type: "return";
  value?: AwkExpr;
}
export interface AwkDeleteStmt {
  type: "delete";
  target: AwkArrayAccess | AwkVariable;
}

// ─── Program Structure ─────────────────────────────────────

export type AwkPattern =
  | AwkBeginPattern
  | AwkEndPattern
  | AwkExprPattern
  | AwkRegexPattern
  | AwkRangePattern;

export interface AwkBeginPattern {
  type: "begin";
}
export interface AwkEndPattern {
  type: "end";
}
export interface AwkExprPattern {
  type: "expr_pattern";
  expression: AwkExpr;
}
export interface AwkRegexPattern {
  type: "regex_pattern";
  pattern: string;
}
export interface AwkRangePattern {
  type: "range";
  start: AwkPattern;
  end: AwkPattern;
}

export interface AwkRule {
  pattern?: AwkPattern;
  action: AwkBlock;
}

export interface AwkFunctionDef {
  name: string;
  params: string[];
  body: AwkBlock;
}

export interface AwkProgram {
  functions: AwkFunctionDef[];
  rules: AwkRule[];
}
