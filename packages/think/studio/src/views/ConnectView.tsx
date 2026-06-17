import { useMemo, useState } from "react";
import {
  Button,
  Input,
  Select,
  SensitiveInput,
  Surface,
  Text
} from "@cloudflare/kumo";
import { PlugsConnectedIcon } from "@phosphor-icons/react";
import type { StudioConfig } from "../lib/config";
import type { StudioConnection } from "../types";
import { ThemeToggle } from "../components/ThemeToggle";

const OTHER = "__other__";

export function ConnectView({
  config,
  onConnect
}: {
  config: StudioConfig;
  onConnect: (connection: StudioConnection) => void;
}) {
  const hasManifestAgents = config.agents.length > 0;

  const [mode, setMode] = useState<"local" | "remote">(
    config.target.url ? "remote" : "local"
  );
  const [host, setHost] = useState(config.target.host ?? "localhost:5173");
  const [url, setUrl] = useState(config.target.url ?? "https://");
  const [token, setToken] = useState(config.target.token ?? "");
  const [instance, setInstance] = useState(config.target.instance ?? "default");

  const initialAgent = useMemo(() => {
    if (config.target.agent) {
      const matches = config.agents.some((a) => a.id === config.target.agent);
      return matches ? config.target.agent : OTHER;
    }
    return hasManifestAgents ? config.agents[0].id : OTHER;
  }, [config, hasManifestAgents]);

  const [agentChoice, setAgentChoice] = useState(initialAgent);
  const [customAgent, setCustomAgent] = useState(
    initialAgent === OTHER ? (config.target.agent ?? "") : ""
  );

  const effectiveAgent =
    agentChoice === OTHER ? customAgent.trim() : agentChoice;
  const canonicalAgent =
    agentChoice !== OTHER && config.agents.some((a) => a.id === agentChoice);

  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (!effectiveAgent) {
      setError("Enter an agent id.");
      return;
    }
    if (mode === "remote" && !/^https?:\/\/.+/.test(url.trim())) {
      setError("Enter a full remote URL (https://…).");
      return;
    }
    if (mode === "local" && !host.trim()) {
      setError("Enter a host (e.g. localhost:5173).");
      return;
    }
    setError(null);
    onConnect({
      url: mode === "remote" ? url.trim() : undefined,
      host: mode === "local" ? host.trim() : undefined,
      protocol: config.target.protocol,
      token: token.trim() || undefined,
      agent: effectiveAgent,
      instance: instance.trim() || "default",
      routePrefix: config.target.routePrefix,
      canonicalAgent
    });
  };

  return (
    <div className="flex h-full items-center justify-center p-6">
      <Surface className="w-full max-w-md rounded-2xl p-6 ring ring-kumo-line">
        <div className="mb-5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <PlugsConnectedIcon size={22} className="text-kumo-accent" />
            <Text size="lg" bold>
              Connect to a Think instance
            </Text>
          </div>
          <ThemeToggle />
        </div>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Select
            label="Connection"
            value={mode}
            onValueChange={(value) => setMode(value as "local" | "remote")}
          >
            <Select.Option value="local">Local dev server</Select.Option>
            <Select.Option value="remote">Remote (deployed)</Select.Option>
          </Select>

          {mode === "local" ? (
            <Input
              label="Host"
              placeholder="localhost:5173"
              value={host}
              onChange={(e) => setHost(e.target.value)}
            />
          ) : (
            <Input
              label="URL"
              placeholder="https://app.example.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          )}

          {hasManifestAgents ? (
            <Select
              label="Agent"
              value={agentChoice}
              onValueChange={(value) => setAgentChoice(value as string)}
            >
              {config.agents.map((agent) => (
                <Select.Option key={agent.id} value={agent.id}>
                  {agent.label}
                </Select.Option>
              ))}
              <Select.Option value={OTHER}>Other…</Select.Option>
            </Select>
          ) : null}

          {agentChoice === OTHER ? (
            <Input
              label="Agent id"
              placeholder="support"
              value={customAgent}
              onChange={(e) => setCustomAgent(e.target.value)}
            />
          ) : null}

          <Input
            label="Instance"
            placeholder="default"
            value={instance}
            onChange={(e) => setInstance(e.target.value)}
          />

          <SensitiveInput
            label="Token (optional)"
            placeholder="Sent as the token query param"
            value={token}
            onValueChange={setToken}
          />

          {error ? <p className="text-sm text-kumo-danger">{error}</p> : null}

          <Button type="submit" variant="primary" className="w-full">
            Connect
          </Button>
        </form>
      </Surface>
    </div>
  );
}
