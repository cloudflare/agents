declare namespace Cloudflare {
  interface Env {
    SCAFFOLD_AGENT: DurableObjectNamespace;
    STORE_TEST_AGENT: DurableObjectNamespace;
    FACET_PROBE_ROOT: DurableObjectNamespace;
    FACET_PROBE_CHILD: DurableObjectNamespace;
    CHAT_AGENT_DO: DurableObjectNamespace;
    CHILD_AGENT_DO: DurableObjectNamespace;
    CAPABILITY_WORKFLOW: Workflow;
  }
}
