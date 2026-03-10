import * as acorn from "acorn";

/**
 * Strip markdown code fences that LLMs commonly wrap code in.
 * Handles ```js, ```javascript, ```typescript, ```ts, or bare ```.
 */
function stripCodeFences(code: string): string {
	const fenced = /^```(?:js|javascript|typescript|ts|tsx|jsx)?\s*\n([\s\S]*?)```\s*$/;
	const match = code.match(fenced);
	return match ? match[1] : code;
}

/**
 * Strip simple TypeScript type annotations that LLMs add despite being told
 * not to. Handles the most common patterns:
 * - Parameter annotations: (x: number, y: string) =>
 * - Return type annotations: () : Promise<void> =>
 * - `as Type` casts: foo as string
 * - Non-null assertions: foo!.bar
 *
 * This is best-effort — complex TS (generics in variable types, interfaces,
 * etc.) will still fail at parse time and fall through to the catch wrapper.
 */
function stripTypeAnnotations(code: string): string {
	// Strip `as Type` casts (handles dotted paths like `as Foo.Bar` and primitives like `as string`)
	let result = code.replace(/\s+as\s+[A-Za-z][\w.]*(?:<[^>]*>)?/g, "");
	// Strip non-null assertions (x!.foo or x!)
	result = result.replace(/(\w)!([.)\]},;\s])/g, "$1$2");
	// Strip return type annotations before =>: ): Type => or ) : Type =>
	result = result.replace(/\)\s*:\s*[A-Z][\w.]*(?:<[^>]*>)?\s*=>/g, ") =>");
	// Strip parameter type annotations: (x: type) — handle multiple params
	result = result.replace(
		/\(([^)]*)\)/g,
		(_match, params: string) =>
			"(" +
			params
				.split(",")
				.map((p: string) => p.replace(/:\s*[A-Za-z][\w.]*(?:<[^>]*>)?(?:\s*\[\s*\])?/, ""))
				.join(",") +
			")"
	);
	return result;
}

export function normalizeCode(code: string): string {
	const trimmed = stripCodeFences(code.trim());
	if (!trimmed.trim()) return "async () => {}";

	// Try to parse as-is first; if it fails due to TS syntax, try stripping
	// type annotations and re-parsing.
	const source = parseOrStrip(trimmed.trim());

	try {
		const ast = acorn.parse(source, {
			ecmaVersion: "latest",
			sourceType: "module"
		});

		// Already an arrow function — pass through
		if (ast.body.length === 1 && ast.body[0].type === "ExpressionStatement") {
			const expr = (ast.body[0] as acorn.ExpressionStatement).expression;
			if (expr.type === "ArrowFunctionExpression") return source;
		}

		// export default <expression> → unwrap to just the expression
		if (
			ast.body.length === 1 &&
			ast.body[0].type === "ExportDefaultDeclaration"
		) {
			const decl = (ast.body[0] as acorn.ExportDefaultDeclaration).declaration;
			const inner = source.slice(decl.start, decl.end);
			// Re-run normalizeCode on the unwrapped content
			return normalizeCode(inner);
		}

		// Single named function declaration → wrap and call it
		if (
			ast.body.length === 1 &&
			ast.body[0].type === "FunctionDeclaration"
		) {
			const fn = ast.body[0] as acorn.FunctionDeclaration;
			const name = fn.id?.name ?? "fn";
			return `async () => {\n${source}\nreturn ${name}();\n}`;
		}

		// Last statement is expression → splice in return
		const last = ast.body[ast.body.length - 1];
		if (last?.type === "ExpressionStatement") {
			const exprStmt = last as acorn.ExpressionStatement;
			const before = source.slice(0, last.start);
			const exprText = source.slice(
				exprStmt.expression.start,
				exprStmt.expression.end
			);
			return `async () => {\n${before}return (${exprText})\n}`;
		}

		return `async () => {\n${source}\n}`;
	} catch {
		return `async () => {\n${source}\n}`;
	}
}

/**
 * Try to parse with acorn. If it fails, attempt to strip TS annotations
 * and return the stripped version (only if it then parses successfully).
 */
function parseOrStrip(source: string): string {
	try {
		acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });
		return source;
	} catch {
		const stripped = stripTypeAnnotations(source);
		try {
			acorn.parse(stripped, { ecmaVersion: "latest", sourceType: "module" });
			return stripped;
		} catch {
			// Neither version parses — return original, will be wrapped as-is
			return source;
		}
	}
}
