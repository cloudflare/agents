declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./src/server");
    durableNamespaces: "SkillsAgent";
  }
  interface Env {
    AI: Ai;
    SKILLS_BUCKET: R2Bucket;
    SkillsAgent: DurableObjectNamespace<import("./src/server").SkillsAgent>;
  }
}
interface Env extends Cloudflare.Env {}
