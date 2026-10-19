import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountManager, isRateLimitedForFamily } from "../lib/accounts.js";
import { RATE_LIMIT_CACHE_TTL_MS } from "../lib/constants.js";
import { boundRateLimitCache } from "../lib/accounts/rate-limits.js";
import { PreemptiveQuotaScheduler } from "../lib/preemptive-quota-scheduler.js";
import { isQuotaCacheEntryExhausted } from "../lib/quota-readiness.js";
import type { AccountStorageV3 } from "../lib/storage.js";

afterEach(() => vi.useRealTimers());

describe("hourly rate-limit cache revalidation", () => {
	it("bounds legacy deadlines without extending shorter or already persisted bounds", () => {
		const now = 1_000_000;
		const old = { codex: now + 7 * 24 * RATE_LIMIT_CACHE_TTL_MS, "codex:model": now + 30_000 };
		const bounded = boundRateLimitCache(old, now);
		expect(bounded).toEqual({ codex: now + RATE_LIMIT_CACHE_TTL_MS, "codex:model": now + 30_000 });
		expect(boundRateLimitCache(bounded, now + 10_000)).toEqual(bounded);
		expect(old.codex).toBe(now + 7 * 24 * RATE_LIMIT_CACHE_TTL_MS);
	});

	it("keeps the deadline across a manager reload and retains independent auth blockers", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-19T00:00:00Z"));
		const now = Date.now();
		const stored: AccountStorageV3 = { version: 3, activeIndex: 0, accounts: [{
			refreshToken: "synthetic-refresh", addedAt: now, lastUsed: now,
			rateLimitResetTimes: { codex: now + 7 * 24 * RATE_LIMIT_CACHE_TTL_MS },
			authInvalidatedAt: now,
		}] };
		const manager = new AccountManager(undefined, stored);
		const snapshot = manager.buildStorageSnapshot();
		vi.advanceTimersByTime(RATE_LIMIT_CACHE_TTL_MS - 1);
		const restored = new AccountManager(undefined, snapshot);
		const account = restored.getAccountByIndex(0)!;
		expect(isRateLimitedForFamily(account, "codex")).toBe(true);
		vi.advanceTimersByTime(1);
		expect(isRateLimitedForFamily(account, "codex")).toBe(false);
		expect(account.authInvalidatedAt).toBe(now);
	});

	it.each([200, 429])("expires a %i snapshot at exactly an hour without sliding on reads", status => {
		const now = 1_000_000;
		const scheduler = new PreemptiveQuotaScheduler();
		const snapshot = { status, primary: { usedPercent: 100, resetAtMs: now + 7 * 24 * RATE_LIMIT_CACHE_TTL_MS }, secondary: {}, updatedAt: now };
		scheduler.update("account:model", snapshot);
		expect(scheduler.getDeferral("account:model", now + RATE_LIMIT_CACHE_TTL_MS - 1)).toMatchObject({ defer: true, waitMs: 1 });
		expect(scheduler.getDeferral("account:model", now + RATE_LIMIT_CACHE_TTL_MS)).toEqual({ defer: false, waitMs: 0 });
		expect(isQuotaCacheEntryExhausted(snapshot, now + RATE_LIMIT_CACHE_TTL_MS - 1)).toBe(true);
		expect(isQuotaCacheEntryExhausted(snapshot, now + RATE_LIMIT_CACHE_TTL_MS)).toBe(false);
	});
});
