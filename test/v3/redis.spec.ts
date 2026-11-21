import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { RedisStore, type RedisClient, type RedisStoreOptions } from "../../src/redis.js";
import { StoreCapacityError, StoreDataError } from "../../src/v3/errors.js";
import type { Store } from "../../src/v3/types.js";
import { CONTRACT_KEY, FINGERPRINT, response } from "../helpers/store-contract.js";

describe("RedisStore configuration and protocol validation", () => {
  it.each([undefined, null, [], {}, { client: null }, { client: {} }, { client: { eval: 42 } }])("rejects invalid client configuration %j", (options) => {
    expect(() => new RedisStore(options as unknown as RedisStoreOptions)).toThrow(TypeError);
  });

  it("does not own or invoke the client at construction", () => {
    const evalScript = vi.fn(async () => []);
    const store = new RedisStore({ client: { eval: evalScript } });

    expect(store.protocolVersion).toBe(3);
    expect(evalScript).not.toHaveBeenCalled();
    expectTypeOf<RedisStore>().toExtend<Store>();
    expectTypeOf<RedisStoreOptions["client"]>().toEqualTypeOf<RedisClient>();
    for (const name of ["get", "abort", "release", "connect", "disconnect"]) expect(name in store).toBe(false);
  });

  it.each([undefined, null, [], ["bogus"], [42], ["entry", "corrupt"], ["started", "owner", "0"], ["invalid"]])("rejects malformed eval replies %j", async (value) => {
    const store = new RedisStore({ client: { eval: async () => value } });

    await expect(store.begin(CONTRACT_KEY, FINGERPRINT, 1000)).rejects.toBeInstanceOf(StoreDataError);
    await expect(store.read(CONTRACT_KEY)).rejects.toBeInstanceOf(StoreDataError);
    await expect(store.commit(CONTRACT_KEY, response(), "owner")).rejects.toBeInstanceOf(StoreDataError);
  });

  it("classifies a Redis OOM on begin as capacity without a retry", async () => {
    const evalScript = vi.fn(async () => { throw new Error("OOM command not allowed"); });
    const store = new RedisStore({ client: { eval: evalScript } });

    await expect(store.begin(CONTRACT_KEY, FINGERPRINT, 1000)).rejects.toBeInstanceOf(StoreCapacityError);
    expect(evalScript).toHaveBeenCalledTimes(1);
  });
});
