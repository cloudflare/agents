export type AgentStartContext<Props = unknown> = {
  props: Props | undefined;
};

export type AgentRequestContext = {
  request: Request;
};

export type AgentTurnReadiness = { timeout?: number } | undefined;

export type AgentTurnContext = {
  readiness?: AgentTurnReadiness;
  /** Whether components should contribute tools for this turn. Default true. */
  includeTools?: boolean;
};

export type AgentTurnContribution = {
  tools?: Record<string, unknown>;
};

export type AgentDestroyContext = Record<string, never>;

export interface AgentLifecycle<Props = unknown> {
  onStart?(context: AgentStartContext<Props>): void | Promise<void>;
  onRequest?(
    context: AgentRequestContext
  ): Response | undefined | Promise<Response | undefined>;
  onTurn?(
    context: AgentTurnContext
  ): AgentTurnContribution | void | Promise<AgentTurnContribution | void>;
  onDestroy?(context: AgentDestroyContext): void | Promise<void>;
}

/**
 * Runs lifecycle hooks for the components installed on an Agent.
 *
 * Components are resolved when each lifecycle phase begins rather than when
 * the runner is constructed. This lets subclass field initializers replace a
 * default component after `super()` without leaving the default registered.
 *
 * @internal
 */
export class AgentLifecycleRunner<Props = unknown> {
  constructor(
    private readonly resolveComponents: () =>
      | Iterable<AgentLifecycle<Props>>
      | ReadonlyArray<AgentLifecycle<Props>>
  ) {}

  async onStart(context: AgentStartContext<Props>): Promise<void> {
    for (const component of this.resolveComponents()) {
      await component.onStart?.(context);
    }
  }

  async onRequest(context: AgentRequestContext): Promise<Response | undefined> {
    for (const component of this.resolveComponents()) {
      const response = await component.onRequest?.(context);
      if (response !== undefined) return response;
    }
    return undefined;
  }

  async onTurn(context: AgentTurnContext): Promise<AgentTurnContribution> {
    const tools: Record<string, unknown> = {};
    for (const component of this.resolveComponents()) {
      const contribution = await component.onTurn?.(context);
      if (contribution?.tools) Object.assign(tools, contribution.tools);
    }
    return { tools };
  }

  async onDestroy(context: AgentDestroyContext): Promise<void> {
    // Destruction is best-effort: a failing component must not prevent the
    // components before it from releasing their resources. Errors are
    // collected and rethrown after every component has run.
    const errors: unknown[] = [];
    const components = [...this.resolveComponents()];
    for (let index = components.length - 1; index >= 0; index--) {
      try {
        await components[index].onDestroy?.(context);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Agent component destruction failed");
    }
  }
}
