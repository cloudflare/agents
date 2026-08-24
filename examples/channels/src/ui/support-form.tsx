import { useState, type FormEvent } from "react";
import {
  Banner,
  Button,
  Field,
  Input,
  InputArea,
  LayerCard,
  Text
} from "@cloudflare/kumo";
import {
  ArrowLeftIcon,
  ClipboardTextIcon,
  PaperPlaneRightIcon
} from "@phosphor-icons/react";
import { api } from "./api";
import { ModeToggle, errorMessage } from "./shared";

/** The customer-facing form behind the example's own custom Channel. */
export function SupportFormPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    try {
      await api.submitSupportForm({ message, email, name });
      setMessage("");
      setSubmitted(true);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  return (
    <div className="flex min-h-dvh flex-col bg-kumo-canvas">
      <header className="border-b border-kumo-line bg-kumo-base px-5 py-3">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <ClipboardTextIcon
              size={20}
              weight="fill"
              className="text-kumo-brand"
            />
            <Text size="base" bold as="h1">
              Contact support
            </Text>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => window.location.assign("/")}
              icon={<ArrowLeftIcon size={15} />}
            >
              Support app
            </Button>
            <ModeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 space-y-4 px-5 py-6">
        {error && (
          <Banner
            variant="error"
            role="alert"
            title="Could not submit"
            description={error}
          />
        )}
        {submitted && (
          <Banner
            variant="default"
            title="Request accepted"
            description="It is now visible in the support app."
          />
        )}

        <LayerCard className="p-5">
          <form className="space-y-4" onSubmit={submit}>
            <Field label="Name" required={false}>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Ada Lovelace"
              />
            </Field>
            <Field
              label="Email"
              description="Becomes a reusable channel identity for this person."
            >
              <Input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="ada@example.com"
                required
              />
            </Field>
            <Field label="Message">
              <InputArea
                value={message}
                onValueChange={setMessage}
                rows={8}
                required
                className="!min-h-44"
              />
            </Field>
            <Button
              type="submit"
              variant="primary"
              disabled={
                message.trim().length === 0 || email.trim().length === 0
              }
              icon={<PaperPlaneRightIcon size={15} weight="fill" />}
            >
              Submit support request
            </Button>
          </form>
        </LayerCard>
      </main>
    </div>
  );
}
