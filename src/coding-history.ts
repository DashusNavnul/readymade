import {isDeepStrictEqual} from 'node:util';
import type {ShipClient} from './ship-client';
import {isInteger, isUx, type CodingSnapshot} from './protocol';

// The native state cursor commits the complete history and authority view.
// Retain at most one completed scan per client in memory. This grants no actions.
const completed = new WeakMap<object, {origin: string; first: CodingSnapshot; tail: CodingSnapshot; tailAfter: number; result: CodingSnapshot}>();

/** Follow retained history with GETs only. Never replay a command to obtain its result. */
export async function codingHistory(client: Pick<ShipClient, 'origin' | 'codingState'>, initial: CodingSnapshot): Promise<CodingSnapshot> {
  const retained = completed.get(client);
  completed.delete(client);
  if (initial.more !== true) return initial;
  const origin = client.origin, session = initial.session;
  if (retained?.origin === origin && initial.reset === false && isUx(initial.cursor) && initial.cursor !== '0x0' &&
      isDeepStrictEqual(initial, retained.first)) {
    // Preserve the client's final-page observation for callers inspecting its
    // snapshot, and detect state changes between the fresh head and this tail.
    const tail = await client.codingState(session, retained.tailAfter);
    if (client.origin === origin && isDeepStrictEqual(tail, retained.tail)) {
      completed.set(client, retained);
      return structuredClone(retained.result);
    }
    return codingHistory(client, await client.codingState(session));
  }
  const first = structuredClone(initial);
  let stable = initial.reset === false && isUx(initial.cursor) && initial.cursor !== '0x0';
  const identity = (state: CodingSnapshot) => state.sessions.filter(row => row.id === session).map(row => ({project: row.project, source: row.source}));
  const expected = identity(initial);
  if (expected.length !== 1) throw new Error('History session unavailable.');
  const records: CodingSnapshot['records'] = [];
  let state = initial, after = 0;
  for (let page = 0; page < 128; page++) {
    if (client.origin !== origin || state.owner !== initial.owner || state.session !== session || state.reset !== false ||
        typeof state.more !== 'boolean' || !isDeepStrictEqual(identity(state), expected) ||
        !isInteger(state.after, after, 4096) || state.records.length > 32) throw new Error('History context changed.');
    let previous = after - 1;
    for (const row of state.records) {
      if (!isInteger(row.sequence, previous + 1, state.after - 1)) throw new Error('History records did not advance.');
      previous = row.sequence; records.push(row);
    }
    stable = stable && state.cursor === first.cursor;
    if (!state.more) {
      const result = {...state, records};
      if (stable && client.origin === origin) completed.set(client, {origin, first, tail: structuredClone(state), tailAfter: after, result: structuredClone(result)});
      return result;
    }
    if (state.after <= after || !state.records.length) throw new Error('History pagination did not advance.');
    after = state.after; state = await client.codingState(session, after);
  }
  throw new Error('History exceeds the 4,096-record presentation limit.');
}
