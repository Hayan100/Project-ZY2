import assert from "node:assert/strict";
import test from "node:test";
import { buildApi } from "../src/api.ts";

test("catalog coalesces concurrent reads, retries failures and skips DB on cache hits", async (t) => {
  let calls = 0;
  const programs = [{ code: "mdcat", name: "MDCAT" }];
  const app = buildApi(async () => {
    if (++calls === 1) throw new Error("private database details");
    await new Promise(resolve => setTimeout(resolve, 10));
    return programs;
  });
  t.after(() => app.close());
  const get = () => app.inject("/api/v1/programs");
  assert.equal((await app.inject("/health/live")).statusCode, 200);
  assert.equal(calls, 0);
  const failure = await get();
  assert.equal(failure.statusCode, 503);
  assert.equal(failure.headers["cache-control"], "no-store");
  assert.deepEqual(failure.json(), { error: "Service unavailable" });
  for (const res of await Promise.all([get(), get(), get()])) {
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { programs });
  }
  assert.equal((await get()).statusCode, 200);
  assert.equal(calls, 2);
});
