/**
 * Query expression parser types
 *
 * AST node types and token types for jq-style filter expressions.
 */

// ============================================================================
// Token Types
// ============================================================================

export type TokenType =
  | "DOT"
  | "PIPE"
  | "COMMA"
  | "COLON"
  | "SEMICOLON"
  | "LPAREN"
  | "RPAREN"
  | "LBRACKET"
  | "RBRACKET"
  | "LBRACE"
  | "RBRACE"
  | "QUESTION"
  | "PLUS"
  | "MINUS"
  | "STAR"
  | "SLASH"
  | "PERCENT"
  | "EQ"
  | "NE"
  | "LT"
  | "LE"
  | "GT"
  | "GE"
  | "AND"
  | "OR"
  | "NOT"
  | "ALT"
  | "ASSIGN"
  | "UPDATE_ADD"
  | "UPDATE_SUB"
  | "UPDATE_MUL"
  | "UPDATE_DIV"
  | "UPDATE_MOD"
  | "UPDATE_ALT"
  | "UPDATE_PIPE"
  | "IDENT"
  | "NUMBER"
  | "STRING"
  | "IF"
  | "THEN"
  | "ELIF"
  | "ELSE"
  | "END"
  | "AS"
  | "TRY"
  | "CATCH"
  | "TRUE"
  | "FALSE"
  | "NULL"
  | "REDUCE"
  | "FOREACH"
  | "LABEL"
  | "BREAK"
  | "DEF"
  | "DOTDOT"
  | "EOF";

export interface Token {
  type: TokenType;
  value?: string | number;
  pos: number;
}

// ============================================================================
// AST Node Types
// ============================================================================

export type AstNode =
  | IdentityNode
  | FieldNode
  | IndexNode
  | SliceNode
  | IterateNode
  | PipeNode
  | CommaNode
  | LiteralNode
  | ArrayNode
  | ObjectNode
  | ParenNode
  | BinaryOpNode
  | UnaryOpNode
  | CondNode
  | TryNode
  | CallNode
  | VarBindNode
  | VarRefNode
  | RecurseNode
  | OptionalNode
  | StringInterpNode
  | UpdateOpNode
  | ReduceNode
  | ForeachNode
  | LabelNode
  | BreakNode
  | DefNode;

export interface IdentityNode {
  type: "Identity";
}

export interface FieldNode {
  type: "Field";
  name: string;
  base?: AstNode;
}

export interface IndexNode {
  type: "Index";
  index: AstNode;
  base?: AstNode;
}

export interface SliceNode {
  type: "Slice";
  start?: AstNode;
  end?: AstNode;
  base?: AstNode;
}

export interface IterateNode {
  type: "Iterate";
  base?: AstNode;
}

export interface PipeNode {
  type: "Pipe";
  left: AstNode;
  right: AstNode;
}

export interface CommaNode {
  type: "Comma";
  left: AstNode;
  right: AstNode;
}

export interface LiteralNode {
  type: "Literal";
  value: unknown;
}

export interface ArrayNode {
  type: "Array";
  elements?: AstNode;
}

export interface ObjectNode {
  type: "Object";
  entries: { key: AstNode | string; value: AstNode }[];
}

export interface ParenNode {
  type: "Paren";
  expr: AstNode;
}

export interface BinaryOpNode {
  type: "BinaryOp";
  op:
    | "+"
    | "-"
    | "*"
    | "/"
    | "%"
    | "=="
    | "!="
    | "<"
    | "<="
    | ">"
    | ">="
    | "and"
    | "or"
    | "//";
  left: AstNode;
  right: AstNode;
}

export interface UnaryOpNode {
  type: "UnaryOp";
  op: "-" | "not";
  operand: AstNode;
}

export interface CondNode {
  type: "Cond";
  cond: AstNode;
  then: AstNode;
  elifs: { cond: AstNode; then: AstNode }[];
  else?: AstNode;
}

export interface TryNode {
  type: "Try";
  body: AstNode;
  catch?: AstNode;
}

export interface CallNode {
  type: "Call";
  name: string;
  args: AstNode[];
}

export interface VarBindNode {
  type: "VarBind";
  name: string;
  value: AstNode;
  body: AstNode;
  pattern?: DestructurePattern;
  alternatives?: DestructurePattern[]; // For ?// alternative patterns
}

// Destructuring pattern for variable binding
export type DestructurePattern =
  | { type: "var"; name: string }
  | { type: "array"; elements: DestructurePattern[] }
  | {
      type: "object";
      fields: {
        key: string | AstNode;
        pattern: DestructurePattern;
        keyVar?: string;
      }[];
    };

export interface VarRefNode {
  type: "VarRef";
  name: string;
}

export interface RecurseNode {
  type: "Recurse";
}

export interface OptionalNode {
  type: "Optional";
  expr: AstNode;
}

export interface StringInterpNode {
  type: "StringInterp";
  parts: (string | AstNode)[];
}

export interface UpdateOpNode {
  type: "UpdateOp";
  op: "+=" | "-=" | "*=" | "/=" | "%=" | "//=" | "=" | "|=";
  path: AstNode;
  value: AstNode;
}

export interface ReduceNode {
  type: "Reduce";
  expr: AstNode;
  varName: string;
  pattern?: DestructurePattern;
  init: AstNode;
  update: AstNode;
}

export interface ForeachNode {
  type: "Foreach";
  expr: AstNode;
  varName: string;
  pattern?: DestructurePattern;
  init: AstNode;
  update: AstNode;
  extract?: AstNode;
}

export interface LabelNode {
  type: "Label";
  name: string;
  body: AstNode;
}

export interface BreakNode {
  type: "Break";
  name: string;
}

export interface DefNode {
  type: "Def";
  name: string;
  params: string[];
  funcBody: AstNode;
  body: AstNode;
}
