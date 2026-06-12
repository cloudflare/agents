import { Assistant, Think } from "../assistant";

const assistantConstructor: typeof Think = Assistant;
const thinkConstructor: typeof Assistant = Think;

class TestAssistant extends Assistant<Cloudflare.Env> {}
class TestThink extends Think<Cloudflare.Env> {}

void assistantConstructor;
void thinkConstructor;
void TestAssistant;
void TestThink;
