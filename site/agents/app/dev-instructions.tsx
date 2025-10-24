import { codeToHtml } from "shiki";
import { BackgroundDots } from "./_components/background";
import { InstallCommand } from "./_components/install-command";

const codeExampleChat = `import { Agent, unstable_callable as callable } from 'agents';
import { searchMenusByAgent, chooseWinners } from '../utils';

export class LunchAgent extends Agent<Env, LunchState> {
	onStart() {
		this.schedule('weekdays at 11:30pm', 'chooseLunch');
		this.schedule('daily at 5pm', 'resetLunch');
	}

	@callable()
	async nominateRestaurant(restaurantName: string) {
		// Uses a Browser Search tool to find restaurant info
		// Finds menu and stores it into Vectorize
		// On success updates Agent state with available restaurants
		await this.env.RESTAURANT_RESEARCHER_WORKFLOW.create({
			restaurantName,
			agent: this.name,
			near: this.state.officeAddress,
		});
	}

	@callable()
	async searchRestaurants(query: string) {
		// Uses Vector store results filtered by Metadata limited
		// To this agent
		const results = await searchMenusByAgent(query, this.name);
		return results.map((result) => result.metadata.restaurantName);
	}

	@callable()
	async vote(username: string, restaurantName: string) {
		const votes = this.state.todaysVotes;
		votes.push({
			username,
			restaurantName,
		});
		// Send update to all connected eaters
		this.setState({
			...this.state,
			todaysVotes: votes,
		});
	}

	async resetLunch() {
		const state = this.state;
		state.todaysVotes = [];
		state.todaysRuling = undefined;
		this.setState(state);
	}

	async chooseLunch() {
		const restaurantWinners = chooseWinners(this.state.todaysVotes);
		const { response } = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
			messages: [
				{role: "system", content: \`
					You help deliver results to a bunch of co-workers who are choosing lunch together.
					The user is going to provide you with the options.
					Your task is to make the choice sound exciting so people who voted for something
                    else feel validated.
					\`},
				{role: "user", content: restaurantWinners?.join(", ") as string}
			],
		});
		this.setState({
			...this.state,
			todaysRuling: response
		})
	}
}

export type Restaurant = {
	cuisine: string;
	name: string;
	address: string;
};

export type Vote = {
	username: string;
	restaurantName: string;
};

export type LunchState = {
	officeAddress: string;
	todaysVotes: Vote[];
	todaysRuling?: string;
	restaurants: Restaurant[];
};`;

export async function DevInstructions() {
  const chatExample = await codeToHtml(codeExampleChat, {
    lang: "js",
    theme: "gruvbox-light-medium",
    colorReplacements: {
      "#fbf1c7": "#fff",
      "#076678": "oklch(.408 .123 38.172)",
      "#3c3836": "var(--color-orange-700)",
      "#B57614": "var(--color-orange-600)"
    }
  });
  return (
    <>
      <div className="pt-24">
        <header className="p-6 pt-0 border-b border-orange-400 border-dashed">
          <h3
            className="text-sm text-orange-600"
            id="developer-instructions"
            style={{
              scrollMarginTop: 90
            }}
          >
            <span className="tabular-nums">03</span> | Code Example
          </h3>
        </header>
        <div className="relative">
          <div className="absolute inset-3 bottom-0 text-orange-400">
            <BackgroundDots />
          </div>
          <div className="p-6 pt-10 md:p-12 md:pb-0 pb-0 flex items-center flex-col">
            <div className="border border-orange-400 border-b-0 p-6 rounded-t-lg bg-white relative">
              <header className="flex gap-1 mb-2 lg:mb-6">
                <div className="w-4 h-4 border border-orange-400 rounded-full" />
                <div className="w-4 h-4 border border-orange-400 rounded-full" />
                <div className="w-4 h-4 border border-orange-400 rounded-full" />
              </header>
              <div className="font-mono text-2xl lg:text-4xl">
                <InstallCommand />
              </div>
            </div>
          </div>
          <div className="divide-y divide-orange-400 border-t lg:border border-orange-400 w-full lg:max-w-[950px] bg-white relative lg:border-b-0 lg:rounded-t-xl mx-auto">
            <header className="flex flex-col md:flex-row items-baseline gap-2 py-4 ml-6 mr-3">
              <h3 className="text-xl font-semibold">
                <span>Lunch Agent</span>
              </h3>
              <p>An agent that helps pick lunch for coworkers in an office.</p>
            </header>
            <pre
              className="text-sm leading-normal pl-6 pr-3 py-5 overflow-x-auto"
              dangerouslySetInnerHTML={{ __html: chatExample }}
            />
          </div>
        </div>
      </div>
    </>
  );
}
