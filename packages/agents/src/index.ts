import {
  Server,
  routePartykitRequest,
  type PartyServerOptions,
  getServerByName,
  type Connection,
  type ConnectionContext,
  type WSMessage,
} from "partyserver";

import { parseCronExpression } from "cron-schedule";
import { nanoid } from "nanoid";

export type { Connection, WSMessage, ConnectionContext } from "partyserver";

import { WorkflowEntrypoint as CFWorkflowEntrypoint } from "cloudflare:workers";

export class WorkflowEntrypoint extends CFWorkflowEntrypoint {}

export type Schedule<T = string> = {
  id: string;
  callback: string;
  payload: T;
} & (
  | {
      type: "scheduled";
      time: number;
    }
  | {
      type: "delayed";
      time: number;
      delayInSeconds: number;
    }
  | {
      type: "cron";
      time: number;
      cron: string;
    }
);

function getNextCronTime(cron: string) {
  const interval = parseCronExpression(cron);
  return interval.getNextDate();
}

const STATE_ROW_ID = "cf_state_row_id";
const STATE_WAS_CHANGED = "cf_state_was_changed";

const DEFAULT_STATE = {} as unknown;

export class Agent<Env, State = unknown> extends Server<Env> {
  #state = DEFAULT_STATE as State;
  initialState: State = DEFAULT_STATE as State;

  get state(): State {
    if (this.#state !== DEFAULT_STATE) {
      // state was previously set, and populated internal state
      return this.#state;
    } else {
      // looks like this is the first time the state is being accessed
      // check if the state was set in a previous life
      const wasChanged = this.sql<{ state: "true" | undefined }>`
        SELECT state FROM cf_agents_state WHERE id = ${STATE_WAS_CHANGED}
      `;

      // ok, let's pick up the actual state from the db
      const result = this.sql<{ state: State | undefined }>`
      SELECT state FROM cf_agents_state WHERE id = ${STATE_ROW_ID}
    `;

      if (
        wasChanged[0]?.state === "true" ||
        // we do this check for people who updated their code before we shipped wasChanged
        result[0]?.state
      ) {
        const state = result[0]?.state as string; // could be null?

        this.#state = JSON.parse(state);
        return this.#state;
      }

      // ok, this is the first time the state is being accessed
      // and the state was not set in a previous life
      // so we need to set the initial state (if provided)
      if (this.initialState === DEFAULT_STATE) {
        // no initial state provided, so we return undefined
        return undefined as State;
      } else {
        // initial state provided, so we set the state,
        // update db and return the initial state
        this.setState(this.initialState);
        return this.initialState;
      }
    }
  }

  static options = {
    hibernate: true, // default to hibernate
  };
  sql<T = Record<string, any>>(
    strings: TemplateStringsArray,
    ...values: any[]
  ) {
    let query = "";
    try {
      // Construct the SQL query with placeholders
      query = strings.reduce(
        (acc, str, i) => acc + str + (i < values.length ? "?" : ""),
        ""
      );

      // Execute the SQL query with the provided values
      return [...this.ctx.storage.sql.exec(query, ...values)] as T[];
    } catch (e) {
      console.error(`failed to execute sql query: ${query}`, e);
      throw e;
    }
  }
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);

    this.sql`
      CREATE TABLE IF NOT EXISTS cf_agents_state (
        id TEXT PRIMARY KEY NOT NULL,
        state TEXT
      )
    `;

    void this.ctx.blockConcurrencyWhile(async () => {
      try {
        // Create alarms table if it doesn't exist
        this.sql`
        CREATE TABLE IF NOT EXISTS cf_agents_schedules (
          id TEXT PRIMARY KEY NOT NULL DEFAULT (randomblob(9)),
          callback TEXT,
          payload TEXT,
          type TEXT NOT NULL CHECK(type IN ('scheduled', 'delayed', 'cron')),
          time INTEGER,
          delayInSeconds INTEGER,
          cron TEXT,
          created_at INTEGER DEFAULT (unixepoch())
        )
      `;

        // execute any pending alarms and schedule the next alarm
        await this.alarm();
      } catch (e) {
        console.error(e);
        throw e;
      }
    });

    const _onMessage = this.onMessage.bind(this);
    this.onMessage = (connection: Connection, message: WSMessage) => {
      if (
        typeof message === "string" &&
        message.startsWith("cf_agent_state:")
      ) {
        const parsed = JSON.parse(message.slice(15));
        this.#setStateInternal(parsed.state, connection);
        return;
      }
      _onMessage(connection, message);
    };

    const _onConnect = this.onConnect.bind(this);
    this.onConnect = (connection: Connection, ctx: ConnectionContext) => {
      // TODO: This is a hack to ensure the state is sent after the connection is established
      // must fix this
      setTimeout(() => {
        if (this.state) {
          connection.send(
            `cf_agent_state:` +
              JSON.stringify({ type: "cf_agent_state", state: this.state })
          );
        }
        _onConnect(connection, ctx);
      }, 20);
    };
  }

  #setStateInternal(state: State, source: Connection | "server" = "server") {
    this.#state = state;
    this.sql`
    INSERT OR REPLACE INTO cf_agents_state (id, state)
    VALUES (${STATE_ROW_ID}, ${JSON.stringify(state)})
  `;
    this.sql`
    INSERT OR REPLACE INTO cf_agents_state (id, state)
    VALUES (${STATE_WAS_CHANGED}, ${JSON.stringify(true)})
  `;
    this.broadcast(
      `cf_agent_state:` +
        JSON.stringify({
          type: "cf_agent_state",
          state: state,
        }),
      source !== "server" ? [source.id] : []
    );
    this.onStateUpdate(state, source);
  }

  setState(state: State) {
    this.#setStateInternal(state, "server");
  }

  onStateUpdate(state: State | undefined, source: Connection | "server") {
    // override this to handle state updates
  }

  onEmail(email: ForwardableEmailMessage) {
    throw new Error("Not implemented");
  }
  render() {
    throw new Error("Not implemented");
  }

  async schedule<T = string>(
    when: Date | string | number,
    callback: keyof this,
    payload?: T
  ): Promise<Schedule<T>> {
    const id = nanoid(9);

    if (typeof callback !== "string") {
      throw new Error("Callback must be a string");
    }

    if (typeof this[callback] !== "function") {
      throw new Error(`this.${callback} is not a function`);
    }

    if (when instanceof Date) {
      const timestamp = Math.floor(when.getTime() / 1000);
      this.sql`
        INSERT OR REPLACE INTO cf_agents_schedules (id, callback, payload, type, time)
        VALUES (${id}, ${callback}, ${JSON.stringify(
        payload
      )}, 'scheduled', ${timestamp})
      `;

      await this.scheduleNextAlarm();

      return {
        id,
        callback: callback,
        payload: payload as T,
        time: timestamp,
        type: "scheduled",
      };
    } else if (typeof when === "number") {
      const time = new Date(Date.now() + when * 1000);
      const timestamp = Math.floor(time.getTime() / 1000);

      this.sql`
        INSERT OR REPLACE INTO cf_agents_schedules (id, callback, payload, type, delayInSeconds, time)
        VALUES (${id}, ${callback}, ${JSON.stringify(
        payload
      )}, 'delayed', ${when}, ${timestamp})
      `;

      await this.scheduleNextAlarm();

      return {
        id,
        callback: callback,
        payload: payload as T,
        delayInSeconds: when,
        time: timestamp,
        type: "delayed",
      };
    } else if (typeof when === "string") {
      const nextExecutionTime = getNextCronTime(when);
      const timestamp = Math.floor(nextExecutionTime.getTime() / 1000);

      this.sql`
        INSERT OR REPLACE INTO cf_agents_schedules (id, callback, payload, type, cron, time)
        VALUES (${id}, ${callback}, ${JSON.stringify(
        payload
      )}, 'cron', ${when}, ${timestamp})
      `;

      await this.scheduleNextAlarm();

      return {
        id,
        callback: callback,
        payload: payload as T,
        cron: when,
        time: timestamp,
        type: "cron",
      };
    } else {
      throw new Error("Invalid schedule type");
    }
  }
  async getSchedule<T = string>(id: string): Promise<Schedule<T> | undefined> {
    const result = this.sql<Schedule<string>>`
      SELECT * FROM cf_agents_schedules WHERE id = ${id}
    `;
    if (!result) return undefined;

    return { ...result[0], payload: JSON.parse(result[0].payload) as T };
  }
  getSchedules<T = string>(
    criteria: {
      description?: string;
      id?: string;
      type?: "scheduled" | "delayed" | "cron";
      timeRange?: { start?: Date; end?: Date };
    } = {}
  ): Schedule<T>[] {
    let query = "SELECT * FROM cf_agents_schedules WHERE 1=1";
    const params = [];

    if (criteria.id) {
      query += " AND id = ?";
      params.push(criteria.id);
    }

    if (criteria.description) {
      query += " AND description = ?";
      params.push(criteria.description);
    }

    if (criteria.type) {
      query += " AND type = ?";
      params.push(criteria.type);
    }

    if (criteria.timeRange) {
      query += " AND time >= ? AND time <= ?";
      const start = criteria.timeRange.start || new Date(0);
      const end = criteria.timeRange.end || new Date(999999999999999);
      params.push(
        Math.floor(start.getTime() / 1000),
        Math.floor(end.getTime() / 1000)
      );
    }

    const result = this.ctx.storage.sql
      .exec(query, ...params)
      .toArray()
      .map((row) => ({
        ...row,
        payload: JSON.parse(row.payload as string) as T,
      })) as Schedule<T>[];

    return result;
  }

  async cancelSchedule(id: string): Promise<boolean> {
    this.sql`DELETE FROM cf_agents_schedules WHERE id = ${id}`;

    await this.scheduleNextAlarm();
    return true;
  }

  private async scheduleNextAlarm() {
    // Find the next schedule that needs to be executed
    const result = this.sql`
      SELECT time FROM cf_agents_schedules 
      WHERE time > ${Math.floor(Date.now() / 1000)}
      ORDER BY time ASC 
      LIMIT 1
    `;
    if (!result) return;

    if (result.length > 0 && "time" in result[0]) {
      const nextTime = result[0].time * 1000;
      await this.ctx.storage.setAlarm(nextTime);
    }
  }

  async alarm() {
    const now = Math.floor(Date.now() / 1000);

    // Get all schedules that should be executed now
    const result = this.sql<Schedule<string>>`
      SELECT * FROM cf_agents_schedules WHERE time <= ${now}
    `;

    for (const row of result || []) {
      const callback = this[row.callback as keyof Agent<Env>];
      if (!callback) {
        console.error(`callback ${row.callback} not found`);
        continue;
      }
      try {
        (
          callback as (
            payload: unknown,
            schedule: Schedule<unknown>
          ) => Promise<void>
        ).bind(this)(JSON.parse(row.payload as string), row);
      } catch (e) {
        console.error(`error executing callback ${row.callback}`, e);
      }
      if (row.type === "cron") {
        // Update next execution time for cron schedules
        const nextExecutionTime = getNextCronTime(row.cron);
        const nextTimestamp = Math.floor(nextExecutionTime.getTime() / 1000);

        this.sql`
          UPDATE cf_agents_schedules SET time = ${nextTimestamp} WHERE id = ${row.id}
        `;
      } else {
        // Delete one-time schedules after execution
        this.sql`
          DELETE FROM cf_agents_schedules WHERE id = ${row.id}
        `;
      }
    }

    // Schedule the next alarm
    await this.scheduleNextAlarm();
  }

  async destroy() {
    // drop all tables
    this.sql`DROP TABLE IF EXISTS cf_agents_state`;
    this.sql`DROP TABLE IF EXISTS cf_agents_schedules`;

    // delete all alarms
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

export type AgentNamespace<Agentic extends Agent<unknown>> =
  DurableObjectNamespace<Agentic>;

export type AgentContext = DurableObjectState;

export type AgentOptions<Env> = PartyServerOptions<Env>;

export function routeAgentRequest<Env>(
  request: Request,
  env: Env,
  options?: AgentOptions<Env>
) {
  return routePartykitRequest(request, env as Record<string, unknown>, {
    prefix: "agents",
    ...(options as PartyServerOptions<Record<string, unknown>>),
  });
}

export async function routeAgentEmail<Env>(
  email: ForwardableEmailMessage,
  env: Env,
  options?: AgentOptions<Env>
): Promise<void> {}

export function getAgentByName<Env, T extends Agent<Env>>(
  namespace: AgentNamespace<T>,
  name: string,
  options?: {
    jurisdiction?: DurableObjectJurisdiction;
    locationHint?: DurableObjectLocationHint;
  }
) {
  return getServerByName<Env, T>(namespace, name, options);
}
