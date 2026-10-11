import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  assertPersistedClosingInputs,
  createMonthlyService,
  type ClosingMonthSnapshot,
  MonthlyOperationError,
  type AuditEntry,
  type MonthPeriod,
  type MonthlyActor,
  type MonthlyChange,
  type MonthlyRepository,
  type MonthlyTransaction,
} from "./monthly-service-core.ts";
import { ROLES } from "./roles.ts";

const period = { year: 2026, month: 8 };
const fixedTime = new Date("2026-09-01T00:00:00.000Z");

function fixture(options: {
  closed?: boolean;
  failAudit?: boolean;
  missingTarget?: boolean;
  revenueEntries?: ClosingMonthSnapshot["revenueEntries"];
  expenseEntries?: ClosingMonthSnapshot["expenseEntries"];
  membershipStats?: ClosingMonthSnapshot["membershipStats"];
} = {}) {
  const defaultClosing = options.closed
    ? { id: "closing-existing", closedAt: fixedTime, closedByUserId: "closer-1" }
    : null;
  let state = {
    closed: options.closed ?? false,
    closing: defaultClosing,
    nextClosingId: 0,
    updatedBy: null as string | null,
    change: null as unknown,
    audits: [] as AuditEntry[],
    revenueEntries: options.revenueEntries ?? [{ id: "revenue-1", description: "Receipt", amount: 100 }],
    expenseEntries: options.expenseEntries ?? [{ id: "expense-1", categoryId: "category-1", description: "Rent", amount: 25 }],
    membershipStats: options.membershipStats === undefined
      ? { memberCount: 60, newMembers: 2, cancellations: 1 }
      : options.membershipStats,
  };
  const repository: MonthlyRepository = {
    async transaction(work) {
      const staged = structuredClone(state);
      const tx: MonthlyTransaction = {
        async loadForClosing(target) {
          if (target.year !== period.year || target.month !== period.month) return null;
          return {
            id: "monthly-record-1",
            year: period.year,
            month: period.month,
            revenueEntries: staged.revenueEntries,
            expenseEntries: staged.expenseEntries,
            membershipStats: staged.membershipStats,
            closing: staged.closing,
          };
        },
        async guardOpenPeriod(target: MonthPeriod, actorId: string) {
          if (target.year !== period.year || target.month !== period.month) throw new MonthlyOperationError("NOT_FOUND");
          if (staged.closed) throw new MonthlyOperationError("CLOSED");
          staged.updatedBy = actorId;
          return { id: "monthly-record-1" };
        },
        async createClosing(_recordId, closedAt, actorId) {
          if (staged.closed) throw new MonthlyOperationError("CLOSED");
          staged.nextClosingId += 1;
          staged.closed = true;
          staged.closing = { id: `closing-${staged.nextClosingId}`, closedAt, closedByUserId: actorId };
          return { id: staged.closing.id };
        },
        async applyChange(_recordId, change) {
          if (options.missingTarget && "id" in change) throw new MonthlyOperationError("NOT_FOUND");
          const before = staged.change;
          staged.change = change;
          return { entityType: change.type, entityId: "entity-1", before, after: change };
        },
        async findClosing(target) {
          if (target.year !== period.year || target.month !== period.month || !staged.closing) return null;
          return { recordId: "monthly-record-1", closedAt: staged.closing.closedAt, closedByUserId: staged.closing.closedByUserId };
        },
        async removeClosing(_recordId, actorId) {
          if (!staged.closed) throw new MonthlyOperationError("NOT_FOUND");
          staged.closed = false;
          staged.closing = null;
          staged.updatedBy = actorId;
        },
        async appendAudit(entry) {
          if (options.failAudit) throw new Error("simulated audit failure");
          staged.audits.push(entry);
        },
      };
      const result = await work(tx);
      state = staged;
      return result;
    },
  };
  const actor: { current: MonthlyActor } = { current: { id: "earnes-user", role: ROLES.EARNES } };
  const service = createMonthlyService({
    currentUser: async () => actor.current,
    repository,
    now: () => new Date(fixedTime),
  });
  return { service, actor, get state() { return state; } };
}

test("membership edits audit before/after, server actor, and timestamp", async () => {
  const f = fixture();
  const before = { type: "membershipStats" as const, memberCount: 60, newMembers: 2, cancellations: 0 };
  const after = { type: "membershipStats" as const, memberCount: 61, newMembers: 3, cancellations: 1 };
  await f.service.edit(period, before);
  await f.service.edit(period, after);
  assert.equal(f.state.updatedBy, "earnes-user");
  assert.deepEqual(f.state.audits[1], {
    actorId: "earnes-user", action: "UPDATE", entityType: "membershipStats", entityId: "entity-1",
    before, after, createdAt: fixedTime,
  });
});

test("role boundaries allow EARNES membership edits and ALBA financial edits only", async () => {
  const f = fixture();
  await assert.rejects(f.service.edit(period, { type: "revenueEntry", operation: "create", description: "Sales", amount: 10 }),
    (error: unknown) => error instanceof MonthlyOperationError && error.code === "UNAUTHORIZED");
  assert.equal(f.state.audits.length, 0);
  f.actor.current = { id: "alba-user", role: ROLES.ALBA_ADMIN };
  await f.service.edit(period, { type: "revenueEntry", operation: "create", description: "Sales", amount: 10 });
  assert.equal(f.state.audits[0]?.actorId, "alba-user");
});

test("ALBA_ADMIN can edit membership statistics", async () => {
  const f = fixture();
  f.actor.current = { id: "alba-user", role: ROLES.ALBA_ADMIN };
  await f.service.edit(period, { type: "membershipStats", memberCount: 1, newMembers: 0, cancellations: 0 });
  assert.equal((f.state.change as MonthlyChange | null)?.type, "membershipStats");
  assert.equal(f.state.audits.length, 1);
});

test("neither role can ordinarily edit a closed month", async () => {
  const cases = [
    { actor: { id: "alba-user", role: ROLES.ALBA_ADMIN }, change: { type: "revenueEntry", operation: "create", description: "Sales", amount: 1 } },
    { actor: { id: "earnes-user", role: ROLES.EARNES }, change: { type: "membershipStats", memberCount: 1, newMembers: 0, cancellations: 0 } },
  ] as const;
  for (const { actor, change } of cases) {
    const f = fixture({ closed: true });
    f.actor.current = actor;
    await assert.rejects(f.service.edit(period, change as MonthlyChange),
      (error: unknown) => error instanceof MonthlyOperationError && error.code === "CLOSED");
    assert.equal(f.state.audits.length, 0);
  }
});

test("caller-supplied actor or role fields cannot replace the authenticated server actor", async () => {
  const f = fixture();
  const forged = {
    type: "membershipStats", memberCount: 4, newMembers: 1, cancellations: 0,
    actorId: "forged-user", role: ROLES.ALBA_ADMIN,
  } as unknown as MonthlyChange;
  await f.service.edit(period, forged);
  assert.equal(f.state.audits[0]?.actorId, "earnes-user");
});

test("ordinary edits fail after closing and a mismatched month or zero target cannot succeed", async () => {
  const closed = fixture({ closed: true });
  await assert.rejects(closed.service.edit(period, { type: "membershipStats", memberCount: 1, newMembers: 0, cancellations: 0 }),
    (error: unknown) => error instanceof MonthlyOperationError && error.code === "CLOSED");
  const wrongPeriod = fixture();
  await assert.rejects(wrongPeriod.service.edit({ year: 2026, month: 7 }, { type: "membershipStats", memberCount: 1, newMembers: 0, cancellations: 0 }),
    (error: unknown) => error instanceof MonthlyOperationError && error.code === "NOT_FOUND");
  assert.equal(wrongPeriod.state.audits.length, 0);
  const noTarget = fixture({ missingTarget: true });
  noTarget.actor.current = { id: "alba-user", role: ROLES.ALBA_ADMIN };
  await assert.rejects(noTarget.service.edit(period, { type: "revenueEntry", operation: "update", id: "other-month-entry", amount: 3 }),
    (error: unknown) => error instanceof MonthlyOperationError && error.code === "NOT_FOUND");
  assert.equal(noTarget.state.change, null);
  assert.equal(noTarget.state.audits.length, 0);
});

test("only ALBA_ADMIN can unlock, and a nonblank reason is audited", async () => {
  const f = fixture({ closed: true });
  await assert.rejects(f.service.unlock(period, "Correction"),
    (error: unknown) => error instanceof MonthlyOperationError && error.code === "UNAUTHORIZED");
  f.actor.current = { id: "alba-user", role: ROLES.ALBA_ADMIN };
  await assert.rejects(f.service.unlock(period, "   "),
    (error: unknown) => error instanceof MonthlyOperationError && error.code === "INVALID_REASON");
  assert.equal(f.state.closed, true);
  await f.service.unlock(period, "  Correct the wrong entry  ");
  assert.equal(f.state.closed, false);
  assert.deepEqual(f.state.audits[0], {
    actorId: "alba-user", action: "UNLOCK", entityType: "MonthlyClosing", entityId: "monthly-record-1",
    before: { closedAt: fixedTime, closedByUserId: "closer-1" },
    after: { closed: false, reason: "Correct the wrong entry" }, createdAt: fixedTime,
  });
});

test("missing authentication rejects before repository access", async () => {
  let transactionStarted = false;
  const repository: MonthlyRepository = {
    async transaction() { transactionStarted = true; throw new Error("unexpected transaction"); },
  };
  const service = createMonthlyService({ currentUser: async () => { throw new Error("Authentication required"); }, repository });
  await assert.rejects(service.edit(period, { type: "membershipStats", memberCount: 1, newMembers: 0, cancellations: 0 }), /Authentication required/);
  assert.equal(transactionStarted, false);
});

test("audit failure rolls back both an edit and an unlock", async () => {
  const edit = fixture({ failAudit: true });
  await assert.rejects(edit.service.edit(period, { type: "membershipStats", memberCount: 2, newMembers: 0, cancellations: 0 }), /simulated audit failure/);
  assert.equal(edit.state.change, null);
  assert.equal(edit.state.updatedBy, null);
  const unlock = fixture({ closed: true, failAudit: true });
  unlock.actor.current = { id: "alba-user", role: ROLES.ALBA_ADMIN };
  await assert.rejects(unlock.service.unlock(period, "Correction"), /simulated audit failure/);
  assert.equal(unlock.state.closed, true);
  assert.equal(unlock.state.updatedBy, null);
});

test("transaction and serialization failures propagate instead of returning success", async () => {
  const repository: MonthlyRepository = {
    async transaction() { throw new Error("simulated serialization failure"); },
  };
  const service = createMonthlyService({
    currentUser: async () => ({ id: "earnes-user", role: ROLES.EARNES }),
    repository,
  });
  await assert.rejects(service.edit(period, { type: "membershipStats", memberCount: 1, newMembers: 0, cancellations: 0 }),
    /simulated serialization failure/);
});

test("ALBA_ADMIN finalizes persisted entries once with actor, time, period, and a full snapshot", async () => {
  const f = fixture();
  f.actor.current = { id: "alba-user", role: ROLES.ALBA_ADMIN };
  await f.service.finalize(period);
  assert.equal(f.state.closed, true);
  assert.equal(f.state.updatedBy, "alba-user");
  assert.equal(f.state.audits.length, 1);
  assert.deepEqual(f.state.audits[0], {
    actorId: "alba-user",
    action: "FINALIZE",
    entityType: "MonthlyClosing",
    entityId: "closing-1",
    before: null,
    after: {
      period: { year: 2026, month: 8 },
      closedAt: fixedTime,
      closedByUserId: "alba-user",
      revenueEntries: [{ id: "revenue-1", description: "Receipt", amount: 100 }],
      revenueTotal: 100,
      expenseEntries: [{ id: "expense-1", categoryId: "category-1", description: "Rent", amount: 25 }],
      expenseTotal: 25,
      membershipStats: { memberCount: 60, newMembers: 2, cancellations: 1 },
      metrics: {
        revenue: 100, expenses: 25, grossProfit: 75, albaReward: 100_000,
        earnesReward: -99_925, grossProfitRate: 75, earnesRate: -99_925,
      },
    },
    createdAt: fixedTime,
  });

  f.actor.current = { id: "alba-user", role: ROLES.ALBA_ADMIN };
  await assert.rejects(f.service.edit(period, { type: "revenueEntry", operation: "create", description: "More", amount: 1 }),
    (error: unknown) => error instanceof MonthlyOperationError && error.code === "CLOSED");
  f.actor.current = { id: "earnes-user", role: ROLES.EARNES };
  await assert.rejects(f.service.edit(period, { type: "membershipStats", memberCount: 60, newMembers: 2, cancellations: 1 }),
    (error: unknown) => error instanceof MonthlyOperationError && error.code === "CLOSED");
});

test("EARNES and missing authentication cannot finalize", async () => {
  const f = fixture();
  await assert.rejects(f.service.finalize(period),
    (error: unknown) => error instanceof MonthlyOperationError && error.code === "UNAUTHORIZED");
  assert.equal(f.state.closed, false);
  assert.equal(f.state.audits.length, 0);

  const wrongPeriod = fixture();
  wrongPeriod.actor.current = { id: "alba-user", role: ROLES.ALBA_ADMIN };
  await assert.rejects(wrongPeriod.service.finalize({ year: 2026, month: 7 }),
    (error: unknown) => error instanceof MonthlyOperationError && error.code === "NOT_FOUND");
  assert.equal(wrongPeriod.state.closed, false);
  assert.equal(wrongPeriod.state.audits.length, 0);

  let transactionStarted = false;
  const repository: MonthlyRepository = {
    async transaction() { transactionStarted = true; throw new Error("unexpected transaction"); },
  };
  const noSession = createMonthlyService({
    currentUser: async () => { throw new Error("Authentication required"); },
    repository,
  });
  await assert.rejects(noSession.finalize(period), /Authentication required/);
  assert.equal(transactionStarted, false);
});

test("finalization rejects each missing required input but permits explicit zero rows", async () => {
  const incomplete = [
    { revenueEntries: [] },
    { expenseEntries: [] },
    { membershipStats: null },
    { membershipStats: { memberCount: null, newMembers: 2, cancellations: 1 } },
    { membershipStats: { memberCount: 60, newMembers: null, cancellations: 1 } },
    { membershipStats: { memberCount: 60, newMembers: 2, cancellations: null } },
  ];
  for (const options of incomplete) {
    const f = fixture(options);
    f.actor.current = { id: "alba-user", role: ROLES.ALBA_ADMIN };
    await assert.rejects(f.service.finalize(period),
      (error: unknown) => error instanceof MonthlyOperationError && error.code === "INCOMPLETE_INPUTS");
    assert.equal(f.state.closed, false);
    assert.equal(f.state.audits.length, 0);
  }

  const zeros = fixture({
    revenueEntries: [{ id: "revenue-zero", description: "Cash receipt", amount: 0 }],
    expenseEntries: [{ id: "expense-zero", categoryId: "category-1", description: "Expense", amount: 0 }],
    membershipStats: { memberCount: 0, newMembers: 0, cancellations: 0 },
  });
  zeros.actor.current = { id: "alba-user", role: ROLES.ALBA_ADMIN };
  await zeros.service.finalize(period);
  assert.equal(zeros.state.audits.length, 1);
  assert.equal((zeros.state.audits[0]?.after as { revenueTotal: number }).revenueTotal, 0);
  assert.equal((zeros.state.audits[0]?.after as { expenseTotal: number }).expenseTotal, 0);
});

test("other income is accepted as a revenue entry without a source-specific condition", async () => {
  const f = fixture({
    revenueEntries: [{ id: "other-income", description: "Other income", amount: 25 }],
  });
  f.actor.current = { id: "alba-user", role: ROLES.ALBA_ADMIN };
  await f.service.finalize(period);
  const snapshot = f.state.audits[0]?.after as { revenueEntries: readonly { id: string }[] };
  assert.deepEqual(snapshot.revenueEntries, [{ id: "other-income", description: "Other income", amount: 25 }]);
});

test("finalization keeps the 59/60/61 reward thresholds", async () => {
  for (const [memberCount, reward] of [[59, 100_000], [60, 100_000], [61, 105_000]] as const) {
    const f = fixture({ membershipStats: { memberCount, newMembers: 0, cancellations: 0 } });
    f.actor.current = { id: "alba-user", role: ROLES.ALBA_ADMIN };
    await f.service.finalize(period);
    assert.equal((f.state.audits[0]?.after as { metrics: { albaReward: number } }).metrics.albaReward, reward);
  }
});

test("duplicate finalization adds no closing or audit; unlock then re-finalize creates one new pair", async () => {
  const f = fixture();
  f.actor.current = { id: "alba-user", role: ROLES.ALBA_ADMIN };
  await f.service.finalize(period);
  await assert.rejects(f.service.finalize(period),
    (error: unknown) => error instanceof MonthlyOperationError && error.code === "CLOSED");
  assert.equal(f.state.nextClosingId, 1);
  assert.equal(f.state.audits.filter(({ action }) => action === "FINALIZE").length, 1);

  await f.service.unlock(period, "Correct data");
  await f.service.finalize(period);
  assert.equal(f.state.closed, true);
  assert.equal(f.state.nextClosingId, 2);
  assert.deepEqual(f.state.audits.map(({ action }) => action), ["FINALIZE", "UNLOCK", "FINALIZE"]);
});

test("finalization transaction or audit failure rolls back and propagates", async () => {
  const auditFailure = fixture({ failAudit: true });
  auditFailure.actor.current = { id: "alba-user", role: ROLES.ALBA_ADMIN };
  await assert.rejects(auditFailure.service.finalize(period), /simulated audit failure/);
  assert.equal(auditFailure.state.closed, false);
  assert.equal(auditFailure.state.updatedBy, null);
  assert.equal(auditFailure.state.audits.length, 0);

  const repository: MonthlyRepository = {
    async transaction() { throw new Error("simulated serialization failure"); },
  };
  const service = createMonthlyService({
    currentUser: async () => ({ id: "alba-user", role: ROLES.ALBA_ADMIN }),
    repository,
  });
  await assert.rejects(service.finalize(period), /simulated serialization failure/);
});

test("zero-valued revenue and expense rows count as entered without a source-category condition", () => {
  assert.doesNotThrow(() => assertPersistedClosingInputs(ROLES.ALBA_ADMIN, {
    revenueEntryCount: 1,
    revenueTotal: 0,
    expenseEntryCount: 1,
    expenseTotal: 0,
    memberCountAtPreviousMonthEnd: 0,
    newMembers: 0,
    cancellations: 0,
  }));
});

test("every required persisted closing value rejects its missing state", () => {
  const complete = {
    revenueEntryCount: 1,
    revenueTotal: 0,
    expenseEntryCount: 1,
    expenseTotal: 0,
    memberCountAtPreviousMonthEnd: 0,
    newMembers: 0,
    cancellations: 0,
  };
  const incomplete = [
    { ...complete, revenueEntryCount: 0 },
    { ...complete, revenueTotal: null },
    { ...complete, expenseEntryCount: 0 },
    { ...complete, expenseTotal: null },
    { ...complete, memberCountAtPreviousMonthEnd: null },
    { ...complete, newMembers: null },
    { ...complete, cancellations: null },
  ];
  for (const inputs of incomplete) {
    assert.throws(() => assertPersistedClosingInputs(ROLES.ALBA_ADMIN, inputs),
      (error: unknown) => error instanceof MonthlyOperationError && error.code === "INCOMPLETE_INPUTS");
  }
});

test("closing input guard accepts refunds and reversals but requires ALBA_ADMIN", () => {
  const inputs = {
    revenueEntryCount: 2,
    revenueTotal: -10,
    expenseEntryCount: 2,
    expenseTotal: -5,
    memberCountAtPreviousMonthEnd: 1,
    newMembers: 0,
    cancellations: 0,
  };
  assert.doesNotThrow(() => assertPersistedClosingInputs(ROLES.ALBA_ADMIN, inputs));
  assert.throws(() => assertPersistedClosingInputs(ROLES.EARNES, inputs),
    (error: unknown) => error instanceof MonthlyOperationError && error.code === "UNAUTHORIZED");
});

test("monthly service exposes editing, finalization, and unlocking operations", async () => {
  const f = fixture();
  assert.deepEqual(Object.keys(f.service).sort(), ["edit", "finalize", "unlock"]);
});

test("configured update adapter is called once after role validation without a Prisma transaction", async () => {
  const change = { type: "membershipStats", memberCount: 0, newMembers: null, cancellations: 0 } as const;
  let calls = 0;
  let transactionCalls = 0;
  const service = createMonthlyService({
    currentUser: async () => ({ id: "earnes-user", role: ROLES.EARNES }),
    repository: { async transaction() { transactionCalls += 1; throw new Error("unexpected transaction"); } },
    async editChange(receivedPeriod, receivedChange) {
      calls += 1;
      assert.deepEqual(receivedPeriod, period);
      assert.deepEqual(receivedChange, change);
    },
  });
  await service.edit(period, change);
  assert.equal(calls, 1);
  assert.equal(transactionCalls, 0);
});

test("configured update adapter propagates its failure and is not called for the inverse role", async () => {
  let calls = 0;
  const failure = new Error("RPC rejected the update");
  const service = createMonthlyService({
    currentUser: async () => ({ id: "earnes-user", role: ROLES.EARNES }),
    repository: { async transaction() { throw new Error("unexpected transaction"); } },
    async editChange() { calls += 1; throw failure; },
  });
  await assert.rejects(service.edit(period, {
    type: "revenueEntry", operation: "create", description: "Sales", amount: 0,
  }), (error: unknown) => error instanceof MonthlyOperationError && error.code === "UNAUTHORIZED");
  assert.equal(calls, 0);
  await assert.rejects(service.edit(period, {
    type: "membershipStats", memberCount: 0, newMembers: 0, cancellations: 0,
  }), (error: unknown) => error === failure);
  assert.equal(calls, 1);
});

test("configured finalize and unlock adapters replace repository transactions", async () => {
  const calls: unknown[] = [];
  const failure = new Error("RPC audit failure");
  let failFinalize = false;
  const service = createMonthlyService({
    currentUser: async () => ({ id: "alba-user", role: ROLES.ALBA_ADMIN }),
    repository: { async transaction() { throw new Error("unexpected repository transaction"); } },
    async finalizePeriod(receivedPeriod) {
      calls.push(["finalize", receivedPeriod]);
      if (failFinalize) throw failure;
    },
    async unlockPeriod(receivedPeriod, reason) {
      calls.push(["unlock", receivedPeriod, reason]);
    },
  });
  await service.finalize(period);
  await service.unlock(period, "  unlock note  ");
  assert.deepEqual(calls, [
    ["finalize", period],
    ["unlock", period, "unlock note"],
  ]);
  failFinalize = true;
  await assert.rejects(service.finalize(period), (error: unknown) => error === failure);
});

test("configured closing RPCs are not called for unauthorized roles or a blank reason", async () => {
  let calls = 0;
  const service = createMonthlyService({
    currentUser: async () => ({ id: "earnes-user", role: ROLES.EARNES }),
    finalizePeriod: async () => { calls += 1; },
    unlockPeriod: async () => { calls += 1; },
  });
  await assert.rejects(service.finalize(period),
    (error: unknown) => error instanceof MonthlyOperationError && error.code === "UNAUTHORIZED");
  await assert.rejects(service.unlock(period, "   "),
    (error: unknown) => error instanceof MonthlyOperationError && error.code === "UNAUTHORIZED");
  assert.equal(calls, 0);

  const albaService = createMonthlyService({
    currentUser: async () => ({ id: "alba-user", role: ROLES.ALBA_ADMIN }),
    unlockPeriod: async () => { calls += 1; },
  });
  await assert.rejects(albaService.unlock(period, " \t "),
    (error: unknown) => error instanceof MonthlyOperationError && error.code === "INVALID_REASON");
  assert.equal(calls, 0);
});
