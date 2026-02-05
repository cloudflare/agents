# How to run

1. Install pnpm if you haven't already: `npm install -g pnpm`
2. Run `pnpm install`.
3. Run `pnpm build`. THIS WILL FAIL. Don't worry it did what it needed to before failing.
4. Start the server: `pnpm run dev-server`
5. Start the client: `pnpm run dev-client`
6. Visit `localhost:3000`
7. Create an account and log in.
8. In the UI, go to your user profile and configure one or more AI models. (At present I recommend Claude, it performs better than any others in this environment.)
9. Make a gadget. Have fun.

Hint: Try "Make me a tic tac toe game."

# Enabling external APIs

To enable support for external APIs, you must do further configuration to register credentials to access each API. This is described in the README.md files in various gatekeeper packages:

- [Google API](packages/gatekeeper-google/README.md)

# FAQ

Q: Why are there no AI models available to select?

A: You skipped step 8.

Q: Workers AI models don't work?

A: Edit packages/workshop-backend/wrangler.jsonc and enable the WORKERS_AI binding. You will be forced to log in when you run `wrangler dev`. Unfortunately Workers AI still won't work, because there are currently bugs in Workers AI that prevent Kimi K2 and Qwen 3 Coder from using tool calls properly, and none of the other models are competent to write code.
