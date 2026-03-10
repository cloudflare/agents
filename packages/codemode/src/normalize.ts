import * as acorn from "acorn";

export function normalizeCode(code: string): string {
  const trimmed = code.trim();
  if (!trimmed) return "async () => {}";

  try {
    const ast = acorn.parse(trimmed, {
      ecmaVersion: "latest",
      sourceType: "module"
    });

    // Already an arrow function — pass through
    if (ast.body.length === 1 && ast.body[0].type === "ExpressionStatement") {
      const expr = (ast.body[0] as acorn.ExpressionStatement).expression;
      if (expr.type === "ArrowFunctionExpression") return trimmed;
    }

    // Last statement is expression → splice in return
    const last = ast.body[ast.body.length - 1];
    if (last?.type === "ExpressionStatement") {
      const exprStmt = last as acorn.ExpressionStatement;
      const before = trimmed.slice(0, last.start);
      const exprText = trimmed.slice(
        exprStmt.expression.start,
        exprStmt.expression.end
      );
      return `async () => {\n${before}return (${exprText})\n}`;
    }

    return `async () => {\n${trimmed}\n}`;
  } catch {
    return `async () => {\n${trimmed}\n}`;
  }
}
