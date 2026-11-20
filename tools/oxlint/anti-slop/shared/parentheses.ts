import type { ESTree } from "@oxlint/plugins";

export function unwrapParenthesizedExpression(expression: ESTree.Expression): ESTree.Expression {
	let current = expression;
	while (current.type === "ParenthesizedExpression") {
		current = current.expression;
	}
	return current;
}
