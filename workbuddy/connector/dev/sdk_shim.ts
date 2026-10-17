/** Local stand-in for `@gety-ai/connector-sdk`, used by tests and the dev runner only. */

export type DocUpdate =
  | { kind: "upsert"; doc: Record<string, unknown> }
  | { kind: "delete"; id: string };

export type PollResult = {
  updates: DocUpdate[];
  state?: unknown;
};

export function upsert(doc: Record<string, unknown>): DocUpdate {
  return { kind: "upsert", doc };
}

export function del(id: string): DocUpdate {
  return { kind: "delete", id };
}

export abstract class Connector<
  Config extends object = Record<string, unknown>,
  State = unknown,
> {
  public config: Config = {} as Config;
  public lastState: State | null = null;
  public signal: AbortSignal = new AbortController().signal;

  abstract poll(): AsyncGenerator<PollResult, void, unknown>;
}
