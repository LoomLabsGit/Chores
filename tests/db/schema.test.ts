import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

const ALEX = "00000000-0000-4000-8000-00000000000a";
const BLAKE = "00000000-0000-4000-8000-00000000000b";
const CASEY = "00000000-0000-4000-8000-00000000000c"; // outsider, no household yet
const DREW = "00000000-0000-4000-8000-00000000000d"; // second household owner

let db: PGlite;
let inviteCode: string;

type Row = Record<string, any>;

/** Run SQL as an authenticated user (RLS + column grants apply). */
async function as<T extends Row = Row>(user: string, sql: string, params: unknown[] = []) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${user}', false);`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}

async function asAnon<T extends Row = Row>(sql: string, params: unknown[] = []) {
  await db.exec(`set role anon;`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec(`reset role;`);
  }
}

const admin = async <T extends Row = Row>(sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows;

async function chore(user: string, title: string, points = 5, assignedTo = user, date = "2026-09-18") {
  const [row] = await as<{ id: string }>(
    user,
    `insert into public.chore_instances (title, household_id, assigned_to, scheduled_date, points_assigned)
     values ($1, public.current_household_id(), $2, $3, $4) returning id`,
    [title, assignedTo, date, points],
  );
  return row.id;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(read("tests/db/supabase-stub.sql"));
  await db.exec(read("supabase/migrations/0001_init.sql"));
  for (const id of [ALEX, BLAKE, CASEY, DREW]) {
    await admin(`insert into auth.users (id, email) values ($1, $2)`, [id, `${id}@example.com`]);
  }
});

describe("household onboarding", () => {
  it("create_household makes an admin profile and seeds chores + rewards", async () => {
    const [hh] = await as(ALEX, `select * from public.create_household('Alex', 'The Flat')`);
    inviteCode = hh.invite_code;
    expect(inviteCode).toMatch(/^[0-9A-F]{6}$/);

    const [me] = await as(ALEX, `select * from public.profiles where id = $1`, [ALEX]);
    expect(me).toMatchObject({ display_name: "Alex", is_admin: true, points: 0 });

    const lib = await as(ALEX, `select title, default_points, last_used_at from public.chore_library order by title`);
    expect(lib.map((c) => c.title)).toEqual([
      "Cooking dinner", "Dirty laundry", "Hanging laundry", "Hoovering", "Washing up", "Watering plants",
    ]);
    expect(lib.find((c) => c.title === "Washing up")!.default_points).toBe(3);
    expect(lib.find((c) => c.title === "Hanging laundry")!.default_points).toBe(5);
    expect(lib.find((c) => c.title === "Hoovering")!.default_points).toBe(8);
    expect(lib.every((c) => c.last_used_at === null)).toBe(true);

    const rewards = await as(ALEX, `select cost from public.rewards where is_active`);
    expect(rewards.length).toBeGreaterThan(0);
  });

  it("cannot create a second household", async () => {
    await expect(as(ALEX, `select * from public.create_household('Alex again')`)).rejects.toThrow(/already belong/);
  });

  it("join_household validates the code, is case-insensitive, and caps at two members", async () => {
    await expect(as(BLAKE, `select * from public.join_household('Blake', 'NOPE00')`)).rejects.toThrow(/not found/);
    await as(BLAKE, `select * from public.join_household('Blake', $1)`, [` ${inviteCode.toLowerCase()} `]);
    const [me] = await as(BLAKE, `select * from public.profiles where id = $1`, [BLAKE]);
    expect(me).toMatchObject({ display_name: "Blake", is_admin: false });

    await expect(as(CASEY, `select * from public.join_household('Casey', $1)`, [inviteCode])).rejects.toThrow(/two members/);
  });
});

describe("row level security + privileges", () => {
  it("members see each other; outsiders see nothing", async () => {
    const seenByAlex = await as(ALEX, `select id from public.profiles order by display_name`);
    expect(seenByAlex.map((r) => r.id)).toEqual([ALEX, BLAKE]);

    await as(DREW, `select * from public.create_household('Drew')`);
    const seenByDrew = await as(DREW, `select id from public.profiles`);
    expect(seenByDrew.map((r) => r.id)).toEqual([DREW]);
    expect(await as(DREW, `select id from public.chore_library where household_id <> public.current_household_id()`)).toEqual([]);
    // Alex cannot see Drew's library either
    const alexLib = await as(ALEX, `select household_id from public.chore_library group by 1`);
    expect(alexLib).toHaveLength(1);
  });

  it("nobody can write points directly", async () => {
    await expect(as(ALEX, `update public.profiles set points = 999 where id = $1`, [ALEX])).rejects.toThrow(/permission denied/);
    await expect(as(ALEX, `update public.profiles set is_admin = true where id = $1`, [BLAKE])).rejects.toThrow(/permission denied/);
  });

  it("a user cannot rename their partner", async () => {
    const rows = await as(ALEX, `update public.profiles set display_name = 'Hax' where id = $1 returning id`, [BLAKE]);
    expect(rows).toHaveLength(0);
  });

  it("clients cannot insert pre-completed instances or completions/redemptions/notifications", async () => {
    await expect(
      as(ALEX, `insert into public.chore_instances (title, household_id, scheduled_date, is_completed)
                values ('x', public.current_household_id(), '2026-09-18', true)`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(ALEX, `insert into public.notifications (recipient_id, type, message) values ($1, 'chore_completed', 'hi')`, [BLAKE]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(ALEX, `insert into public.reward_redemptions (redeemed_by, cost) values ($1, 1)`, [ALEX]),
    ).rejects.toThrow(/permission denied/);
    await expect(as(ALEX, `update public.challenges set status = 'completed'`)).rejects.toThrow(/permission denied/);
  });

  it("cannot assign a chore to someone outside the household", async () => {
    await expect(
      as(ALEX, `insert into public.chore_instances (title, household_id, assigned_to, scheduled_date)
                values ('x', public.current_household_id(), $1, '2026-09-18')`, [DREW]),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot schedule another household's library chore", async () => {
    const [drewChore] = await as(DREW, `select id from public.chore_library limit 1`);
    await expect(
      as(ALEX, `insert into public.chore_instances (chore_id, title, household_id, scheduled_date)
                values ($1, 'x', public.current_household_id(), '2026-09-18')`, [drewChore.id]),
    ).rejects.toThrow(/row-level security/);
  });

  it("anon cannot read tables or call RPCs", async () => {
    await expect(asAnon(`select * from public.profiles`)).rejects.toThrow(/permission denied/);
    await expect(asAnon(`select * from public.redeem_reward(gen_random_uuid())`)).rejects.toThrow(/permission denied/);
  });

  it("rewards: only the admin can add", async () => {
    await as(ALEX, `insert into public.rewards (household_id, title, cost) values (public.current_household_id(), 'Lie in', 60)`);
    await expect(
      as(BLAKE, `insert into public.rewards (household_id, title, cost) values (public.current_household_id(), 'Cheat', 1)`),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("chore scheduling", () => {
  it("scheduling a library chore stamps last_used_at; assigning to partner notifies them", async () => {
    const [lib] = await as(ALEX, `select id from public.chore_library where title = 'Washing up'`);
    await as(ALEX, `insert into public.chore_instances (chore_id, title, household_id, assigned_to, scheduled_date, points_assigned)
                    values ($1, 'Washing up', public.current_household_id(), $2, '2026-09-18', 3)`, [lib.id, BLAKE]);
    const [after] = await as(ALEX, `select last_used_at from public.chore_library where id = $1`, [lib.id]);
    expect(after.last_used_at).not.toBeNull();

    const notes = await as(BLAKE, `select type, message, actor_id from public.notifications where type = 'chore_assigned'`);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ message: "Alex assigned you: Washing up", actor_id: ALEX });
  });

  it("drag-reassigning notifies; self-assigning does not", async () => {
    const id = await chore(ALEX, "Bins");
    expect(await as(BLAKE, `select 1 from public.notifications where message like '%Bins'`)).toHaveLength(0);
    await as(ALEX, `update public.chore_instances set assigned_to = $2 where id = $1`, [id, BLAKE]);
    expect(await as(BLAKE, `select 1 from public.notifications where message like '%Bins'`)).toHaveLength(1);
    await as(ALEX, `update public.chore_instances set assigned_to = $2 where id = $1`, [id, ALEX]);
    expect(await as(ALEX, `select 1 from public.notifications where message like '%Bins'`)).toHaveLength(0);
  });

  it("accepts client-generated ids (optimistic inserts)", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    await as(ALEX, `insert into public.chore_instances (id, title, household_id, scheduled_date)
                    values ($1, 'Optimistic', public.current_household_id(), '2026-09-18')`, [id]);
    expect(await as(ALEX, `select 1 from public.chore_instances where id = $1`, [id])).toHaveLength(1);
  });

  it("rejects out-of-range points", async () => {
    await expect(chore(ALEX, "Huge", 11)).rejects.toThrow(/check constraint/);
  });
});

describe("complete_chore", () => {
  it("solo completion credits the caller 100%", async () => {
    const id = await chore(ALEX, "Solo", 8);
    const [c] = await as(ALEX, `select * from public.complete_chore($1, 30, 100)`, [id]);
    expect(c).toMatchObject({
      total_duration_minutes: 30, user_a_id: ALEX, user_a_duration: 30, user_a_points: 8,
      user_b_id: BLAKE, user_b_duration: 0, user_b_points: 0,
    });
    const [inst] = await as(ALEX, `select is_completed, completed_at from public.chore_instances where id = $1`, [id]);
    expect(inst.is_completed).toBe(true);
    expect(inst.completed_at).not.toBeNull();
  });

  it("splits minutes and points 60/40 and credits both balances", async () => {
    const [before] = await as(ALEX, `select (select points from public.profiles where id = $1) as a,
                                            (select points from public.profiles where id = $2) as b`, [ALEX, BLAKE]);
    const id = await chore(ALEX, "Split", 10);
    const [c] = await as(ALEX, `select * from public.complete_chore($1, 30, 60)`, [id]);
    expect(c).toMatchObject({ user_a_duration: 18, user_a_points: 6, user_b_duration: 12, user_b_points: 4 });
    const [after] = await as(ALEX, `select (select points from public.profiles where id = $1) as a,
                                           (select points from public.profiles where id = $2) as b`, [ALEX, BLAKE]);
    expect(after.a - before.a).toBe(6);
    expect(after.b - before.b).toBe(4);

    const [note] = await as(BLAKE, `select message from public.notifications where type = 'chore_completed' and message like '%Split%'`);
    expect(note.message).toBe("Alex completed: Split (you earned 4 pts)");
  });

  it("uses the spec's round-to-nearest rule on both sides (5 pts 50/50 -> 3 + 3)", async () => {
    const id = await chore(ALEX, "Odd", 5);
    const [c] = await as(ALEX, `select * from public.complete_chore($1, 5, 50)`, [id]);
    expect(c).toMatchObject({ user_a_points: 3, user_b_points: 3, user_a_duration: 3, user_b_duration: 3 });
  });

  it("a 0% share is valid (partner did it all)", async () => {
    const id = await chore(ALEX, "Partner did it", 4);
    const [c] = await as(ALEX, `select * from public.complete_chore($1, 20, 0)`, [id]);
    expect(c).toMatchObject({ user_a_points: 0, user_b_points: 4, user_a_duration: 0, user_b_duration: 20 });
  });

  it("rejects double completion, bad splits, bad durations and foreign chores", async () => {
    const id = await chore(ALEX, "Twice");
    await as(ALEX, `select * from public.complete_chore($1, 5, 100)`, [id]);
    await expect(as(ALEX, `select * from public.complete_chore($1, 5, 100)`, [id])).rejects.toThrow(/already completed/);

    const id2 = await chore(ALEX, "Bad");
    await expect(as(ALEX, `select * from public.complete_chore($1, 5, 55)`, [id2])).rejects.toThrow(/multiple of 10/);
    await expect(as(ALEX, `select * from public.complete_chore($1, -1, 100)`, [id2])).rejects.toThrow(/Duration/);

    await expect(as(DREW, `select * from public.complete_chore($1, 5, 100)`, [id2])).rejects.toThrow(/not found/);
  });

  it("completed chores are history: cannot be moved or deleted", async () => {
    const id = await chore(ALEX, "History");
    await as(ALEX, `select * from public.complete_chore($1, 5, 100)`, [id]);
    expect(await as(ALEX, `update public.chore_instances set scheduled_date = '2026-01-01' where id = $1 returning id`, [id])).toHaveLength(0);
    expect(await as(ALEX, `delete from public.chore_instances where id = $1 returning id`, [id])).toHaveLength(0);
  });

  it("incomplete chores can be deleted", async () => {
    const id = await chore(ALEX, "Delete me");
    expect(await as(ALEX, `delete from public.chore_instances where id = $1 returning id`, [id])).toHaveLength(1);
  });

  it("completions are readable by the household only", async () => {
    expect((await as(BLAKE, `select 1 from public.chore_completions`)).length).toBeGreaterThan(0);
    expect(await as(DREW, `select 1 from public.chore_completions`)).toHaveLength(0);
  });
});

describe("challenges", () => {
  it("self-assigned challenges start active and notify nobody", async () => {
    const [c] = await as(ALEX, `select * from public.create_challenge('Gym', $1, 3, 20)`, [ALEX]);
    expect(c.status).toBe("active");
    expect(await as(BLAKE, `select 1 from public.notifications where type = 'challenge_proposed'`)).toHaveLength(0);
  });

  it("partner-assigned challenges start pending, notify, and gate on acceptance", async () => {
    const [c] = await as(ALEX, `select * from public.create_challenge('No sugar', $1, 2, 15)`, [BLAKE]);
    expect(c.status).toBe("pending");
    const [note] = await as(BLAKE, `select message, reference_id from public.notifications where type = 'challenge_proposed'`);
    expect(note).toEqual({ message: "Alex set a challenge for you: No sugar", reference_id: c.id });

    await expect(as(BLAKE, `select * from public.increment_challenge($1)`, [c.id])).rejects.toThrow(/not active/);
    await expect(as(ALEX, `select * from public.respond_to_challenge($1, true)`, [c.id])).rejects.toThrow(/No pending/);

    const [accepted] = await as(BLAKE, `select * from public.respond_to_challenge($1, true)`, [c.id]);
    expect(accepted.status).toBe("active");
    expect(await as(BLAKE, `select is_read from public.notifications where reference_id = $1`, [c.id])).toEqual([{ is_read: true }]);
    expect((await as(ALEX, `select message from public.notifications where type = 'challenge_accepted'`))[0].message)
      .toBe("Blake accepted your challenge: No sugar");

    // Only the assignee can tick progress
    await expect(as(ALEX, `select * from public.increment_challenge($1)`, [c.id])).rejects.toThrow(/not active/);

    const [before] = await as(BLAKE, `select points from public.profiles where id = $1`, [BLAKE]);
    const [step1] = await as(BLAKE, `select * from public.increment_challenge($1)`, [c.id]);
    expect(step1).toMatchObject({ current_count: 1, status: "active" });
    const [step2] = await as(BLAKE, `select * from public.increment_challenge($1)`, [c.id]);
    expect(step2).toMatchObject({ current_count: 2, status: "completed" });
    expect(step2.completed_at).not.toBeNull();
    const [after] = await as(BLAKE, `select points from public.profiles where id = $1`, [BLAKE]);
    expect(after.points - before.points).toBe(15);
    expect((await as(ALEX, `select message from public.notifications where type = 'challenge_completed'`))[0].message)
      .toBe("Blake completed your challenge: No sugar");

    // Completed challenges are frozen and cannot be farmed
    await expect(as(BLAKE, `select * from public.increment_challenge($1)`, [c.id])).rejects.toThrow(/not active/);
  });

  it("declining marks it rejected and tells the creator", async () => {
    const [c] = await as(ALEX, `select * from public.create_challenge('Run 5k', $1, 4, 30)`, [BLAKE]);
    const [r] = await as(BLAKE, `select * from public.respond_to_challenge($1, false)`, [c.id]);
    expect(r.status).toBe("rejected");
    expect((await as(ALEX, `select message from public.notifications where type = 'challenge_declined'`))[0].message)
      .toBe("Blake declined your challenge: Run 5k");
    await expect(as(BLAKE, `select * from public.increment_challenge($1)`, [c.id])).rejects.toThrow(/not active/);
  });

  it("validates input and assignee", async () => {
    await expect(as(ALEX, `select * from public.create_challenge('  ', $1, 3, 20)`, [ALEX])).rejects.toThrow(/name/);
    await expect(as(ALEX, `select * from public.create_challenge('x', $1, 0, 20)`, [ALEX])).rejects.toThrow(/Target/);
    await expect(as(ALEX, `select * from public.create_challenge('x', $1, 3, 0)`, [ALEX])).rejects.toThrow(/Reward/);
    await expect(as(ALEX, `select * from public.create_challenge('x', $1, 3, 20)`, [DREW])).rejects.toThrow(/not in your household/);
  });
});

describe("rewards shop", () => {
  it("rejects redeeming without enough points and leaves the balance alone", async () => {
    await admin(`update public.profiles set points = 10 where id = $1`, [BLAKE]);
    const [reward] = await as(BLAKE, `select id from public.rewards where title = '10 min massage'`);
    await expect(as(BLAKE, `select * from public.redeem_reward($1)`, [reward.id])).rejects.toThrow(/Not enough points/);
    const [b] = await as(BLAKE, `select points from public.profiles where id = $1`, [BLAKE]);
    expect(b.points).toBe(10);
    expect(await as(BLAKE, `select 1 from public.reward_redemptions`)).toHaveLength(0);
  });

  it("deducts the cost, records the redemption and notifies the partner", async () => {
    await admin(`update public.profiles set points = 145 where id = $1`, [BLAKE]);
    const [reward] = await as(BLAKE, `select id from public.rewards where title = '10 min massage'`);
    const [red] = await as(BLAKE, `select * from public.redeem_reward($1)`, [reward.id]);
    expect(red).toMatchObject({ redeemed_by: BLAKE, cost: 50, reward_id: reward.id });
    expect((await as(BLAKE, `select points from public.profiles where id = $1`, [BLAKE]))[0].points).toBe(95);
    expect((await as(ALEX, `select message from public.notifications where type = 'reward_redeemed'`))[0].message)
      .toBe("Blake redeemed: 10 min massage");
    // Both partners can see the audit trail
    expect(await as(ALEX, `select 1 from public.reward_redemptions`)).toHaveLength(1);
  });

  it("inactive rewards cannot be redeemed", async () => {
    const [reward] = await as(ALEX, `select id from public.rewards where title = 'Lie in'`);
    await as(ALEX, `update public.rewards set is_active = false where id = $1`, [reward.id]);
    await admin(`update public.profiles set points = 500 where id = $1`, [ALEX]);
    await expect(as(ALEX, `select * from public.redeem_reward($1)`, [reward.id])).rejects.toThrow(/no longer available/);
  });
});

describe("notifications", () => {
  it("are private to the recipient and can only be marked read", async () => {
    expect(await as(DREW, `select 1 from public.notifications`)).toHaveLength(0);
    const rows = await as(ALEX, `update public.notifications set is_read = true where recipient_id = $1 returning id`, [BLAKE]);
    expect(rows).toHaveLength(0); // RLS hides partner's rows from update
    await expect(as(ALEX, `update public.notifications set message = 'x' where recipient_id = $1`, [ALEX])).rejects.toThrow(/permission denied/);
    const mine = await as(BLAKE, `update public.notifications set is_read = true where recipient_id = $1 returning id`, [BLAKE]);
    expect(mine.length).toBeGreaterThan(0);
  });
});
