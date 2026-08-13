/**
 * Single import site for the domain contracts. TYPE-ONLY on purpose: the
 * contract package contains `declare function` statements with no runtime
 * body, so any value import from it would resolve to nothing. Everything
 * callable is implemented in this package.
 */
export type * from "../../contract/src/index";
