# Email Service Agent Example

This example shows how to combine the new Cloudflare Email Service sending binding with Agents SDK email routing in one full-stack app.

## What this demonstrates

- Send transactional email from an agent with `env.EMAIL.send()`
- Route inbound email into an agent with `routeAgentEmail()`
- Parse MIME content with `postal-mime`
- Optionally sign follow-up replies with `replyToEmail()` and `EMAIL_SECRET`
- Keep inbox and outbox state synced to a React client with `useAgent()`
- Simulate inbound email locally with `/api/simulate-email` before you deploy routing

## Running it

```bash
npm install
cp .env.example .env
npm start
```

Before you send real email, review `examples/email-agent/wrangler.jsonc`:

1. The example defaults `vars.EMAIL_FROM` to `meetme@inboxbuddy.dev`; change it if you want to use a different verified sender
2. Optional: add `EMAIL_SECRET` if you want signed reply routing:

```bash
wrangler secret put EMAIL_SECRET
```

The `send_email` binding is configured with `remote: true`, so `npm start` can call the real Email Service API from local development.

If `EMAIL_SECRET` is missing, the example still runs. Inbound mail uses address-based routing only, and auto-replies are sent unsigned.

## How to use it

1. Open the app in your browser
2. Use **Send outbound email** to send a real message through Email Service
3. Use **Simulate inbound email** to exercise the inbound routing path locally
4. Deploy the Worker and route `EMAIL_FROM` to it to receive live email

## Key patterns

### Send with the Workers binding

```ts
const response = await this.env.EMAIL.send({
  to,
  from: { email: this.env.EMAIL_FROM, name: "Email Service Agent" },
  replyTo: this.env.EMAIL_FROM,
  subject,
  text: body,
  html: body.replace(/\n/g, "<br />")
});
```

### Route inbound mail into the agent

```ts
const addressResolver = createAddressBasedEmailResolver("EmailServiceAgent");

await routeAgentEmail(message, env, {
  resolver: async (email, env) => {
    if (env.EMAIL_SECRET) {
      const secureResolver = createSecureReplyEmailResolver(env.EMAIL_SECRET);
      const secureReply = await secureResolver(email, env);
      if (secureReply) return secureReply;
    }

    return addressResolver(email, env);
  }
});
```

With `EMAIL_FROM="meetme@inboxbuddy.dev"`, replies to `meetme@inboxbuddy.dev` route to the `EmailServiceAgent` instance named `meetme`.

## Local simulation endpoint

The app includes a small HTTP helper so the example is still useful before you deploy routing:

```bash
curl -X POST http://localhost:8787/api/simulate-email \
  -H "Content-Type: application/json" \
  -d '{
    "from": "customer@example.com",
    "subject": "Question about my account",
    "body": "Can you confirm my renewal date?"
  }'
```

That request creates a mock `ForwardableEmailMessage` and runs it through the same resolver chain as a real routed email.

## Deploying for real email

1. Onboard your domain in Cloudflare Email Service for both sending and routing
2. Verify the sender address used by `EMAIL_FROM`
3. Deploy this Worker with `npm run deploy`
4. Add an Email Service routing rule that sends `EMAIL_FROM` to this Worker

## Related docs

- [`../../docs/email.md`](../../docs/email.md) — Email Service with agents
- [`../playground`](../playground) — larger email routing demos inside the playground
