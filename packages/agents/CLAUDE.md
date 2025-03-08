# Agents SDK Development Guide

## Build Commands
- Build: `npm run build` (runs tsx ./scripts/build.ts)
- Test/Evals: `npm run evals` (cd evals; evalite)
- Run single eval: `cd evals && evalite path/to/eval.ts`

## Code Style Guidelines
- **Types**: Use TypeScript with proper type annotations, discriminated unions, and Zod schemas
- **Naming**: PascalCase for classes/types, camelCase for methods/variables
- **Imports**: Sort imports by external libraries first, then internal modules
- **Formatting**: Uses Prettier (prettier --write ./dist/*.d.ts)
- **Error Handling**: Throw errors with descriptive messages, use try/catch when appropriate
- **Documentation**: Document types and functions with JSDoc comments (/**/)
- **Structure**: Export all public API through index.ts, organize by feature
- **Prefix**: Use "cf_agent_" prefix for agent-related message types

## Architecture Notes
- Built on Party WebSockets (partysocket, partyserver)
- Uses nanoid for unique identifiers
- External dependencies: cloudflare:workers, @ai-sdk/react, ai, react, zod