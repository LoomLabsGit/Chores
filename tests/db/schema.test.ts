import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

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

/** Schedules a chore. `tax` is the flat chore tax; `minutes` the estimate (points come from time + tax). */
async function chore(
  user: string, title: string, tax = 0, assignedTo: string | null = user, date = "2026-09-18", minutes = 15,
) {
  const [row] = await as<{ id: string }>(
    user,
    `insert into public.chore_instances (title, household_id, assigned_to, scheduled_date, estimated_duration, chore_tax)
     values ($1, public.current_household_id(), $2, $3, $5, $4) returning id`,
    [title, assignedTo, date, tax, minutes],
  );
  return row.id;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(read("tests/db/supabase-stub.sql"));
  await db.exec(read("supabase/migrations/0001_init.sql"));
  await db.exec(read("supabase/migrations/0002_remove_completed_chore.sql"));
  await db.exec(read("supabase/migrations/0003_recurring_chores.sql"));
  await db.exec(read("supabase/migrations/0004_uncheck_chore.sql"));
  await db.exec(read("supabase/migrations/0005_edit_completed_chore.sql"));
  await db.exec(read("supabase/migrations/0006_time_based_points.sql"));
  await db.exec(read("supabase/migrations/0007_credit_the_assignee.sql"));
  await db.exec(read("supabase/migrations/0008_manage_library.sql"));
  await db.exec(read("supabase/migrations/0009_dynamic_ledger.sql"));
  await db.exec(read("supabase/migrations/0010_challenge_controls.sql"));
  await db.exec(read("supabase/migrations/0011_point_ledger.sql"));
  await db.exec(read("supabase/migrations/0012_fixed_bounty_chores.sql"));
  await db.exec(read("supabase/migrations/0013_forfeit_and_joint_challenges.sql"));
  await db.exec(read("supabase/migrations/0014_everyone_is_equal.sql"));
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

  it("rewards: either partner can add one, but nobody can add to another household", async () => {
    await as(ALEX, `insert into public.rewards (household_id, title, cost) values (public.current_household_id(), 'Lie in', 60)`);
    await as(BLAKE, `insert into public.rewards (household_id, title, cost) values (public.current_household_id(), 'Breakfast out', 45)`);
    expect((await as(ALEX, `select title from public.rewards where title = 'Breakfast out'`))).toHaveLength(1);
    await as(DREW, `select * from public.create_household('Drew') `).catch(() => undefined);
    const drews = (await admin(`select household_id from public.profiles where id = $1`, [DREW]))[0]?.household_id;
    if (drews) {
      await expect(
        as(BLAKE, `insert into public.rewards (household_id, title, cost) values ($1, 'Cheat', 1)`, [drews]),
      ).rejects.toThrow(/row-level security/);
    }
  });

  it("there is no admin helper left to build a permission on", async () => {
    await expect(as(ALEX, `select public.is_household_admin()`)).rejects.toThrow(/does not exist/);
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

  it("rejects an out-of-range tax or a duration that is not a multiple of 5", async () => {
    await expect(chore(ALEX, "Huge tax", 51)).rejects.toThrow(/check constraint/);
    await expect(chore(ALEX, "Odd minutes", 0, ALEX, "2026-09-18", 7)).rejects.toThrow(/check constraint/);
    await expect(chore(ALEX, "Too short", 0, ALEX, "2026-09-18", 0)).rejects.toThrow(/check constraint/);
  });
});

describe("complete_chore", () => {
  it("solo completion credits the caller 100%", async () => {
    const id = await chore(ALEX, "Solo", 2); // 30 min = 6 base + 2 tax = 8
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
    const id = await chore(ALEX, "Split", 4); // 30 min = 6 base + 4 tax = 10
    const [c] = await as(ALEX, `select * from public.complete_chore($1, 30, 60)`, [id]);
    expect(c).toMatchObject({ user_a_duration: 18, user_a_points: 6, user_b_duration: 12, user_b_points: 4 });
    const [after] = await as(ALEX, `select (select points from public.profiles where id = $1) as a,
                                           (select points from public.profiles where id = $2) as b`, [ALEX, BLAKE]);
    expect(after.a - before.a).toBe(6);
    expect(after.b - before.b).toBe(4);

    const [note] = await as(BLAKE, `select message from public.notifications where type = 'chore_completed' and message like '%Split%'`);
    expect(note.message).toBe("Alex completed: Split (you earned 4 pts)");
  });

  it("rounds the caller's share and gives the partner the remainder (5 pts 50/50 -> 3 + 2)", async () => {
    const id = await chore(ALEX, "Odd", 4); // 5 min = 1 base + 4 tax = 5
    const [c] = await as(ALEX, `select * from public.complete_chore($1, 5, 50)`, [id]);
    expect(c).toMatchObject({ user_a_points: 3, user_b_points: 2, user_a_duration: 3, user_b_duration: 2 });
  });

  it("the two shares always add up to exactly the total, for every duration and split", async () => {
    // totals of 4, 5 (odd: the case naive rounding gets wrong), 6, 8 and 10
    for (const minutes of [5, 10, 15, 25, 35]) {
      for (const pct of [10, 30, 50, 70, 90]) {
        const id = await chore(ALEX, `Sum ${minutes}/${pct}`, 3);
        const [c] = await as(ALEX, `select * from public.complete_chore($1, $2, $3)`, [id, minutes, pct]);
        expect(c.user_a_points + c.user_b_points).toBe(minutes / 5 + 3);
        expect(c.user_a_duration + c.user_b_duration).toBe(minutes);
      }
    }
  });

  it("a 0% share is valid (partner did it all)", async () => {
    const id = await chore(ALEX, "Partner did it", 4); // 20 min = 4 base + 4 tax = 8
    const [c] = await as(ALEX, `select * from public.complete_chore($1, 20, 0)`, [id]);
    expect(c).toMatchObject({ user_a_points: 0, user_b_points: 8, user_a_duration: 0, user_b_duration: 20 });
  });

  it("rejects double completion, bad splits, bad durations and foreign chores", async () => {
    const id = await chore(ALEX, "Twice");
    await as(ALEX, `select * from public.complete_chore($1, 5, 100)`, [id]);
    await expect(as(ALEX, `select * from public.complete_chore($1, 5, 100)`, [id])).rejects.toThrow(/already completed/);

    const id2 = await chore(ALEX, "Bad");
    await expect(as(ALEX, `select * from public.complete_chore($1, 5, 55)`, [id2])).rejects.toThrow(/multiple of 10/);
    await expect(as(ALEX, `select * from public.complete_chore($1, -1, 100)`, [id2])).rejects.toThrow(/Duration/);
    await expect(as(ALEX, `select * from public.complete_chore($1, 0, 100)`, [id2])).rejects.toThrow(/multiple of 5/);
    await expect(as(ALEX, `select * from public.complete_chore($1, 7, 100)`, [id2])).rejects.toThrow(/multiple of 5/);
    await expect(as(ALEX, `select * from public.complete_chore($1, 1445, 100)`, [id2])).rejects.toThrow(/Duration/);

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

describe("remove_completed_chore", () => {
  const points = async (uid: string) =>
    (await as(uid, `select points from public.profiles where id = $1`, [uid]))[0].points as number;
  const count = async (sql: string, params: unknown[]) => (await admin(sql, params)).length;

  it("takes back both partners' points and deletes the chore, completion and its notifications", async () => {
    const [a0, b0] = [await points(ALEX), await points(BLAKE)];
    const id = await chore(ALEX, "Undo me", 4); // 30 min = 6 + 4 = 10
    await as(ALEX, `select * from public.complete_chore($1, 30, 60)`, [id]); // Alex +6, Blake +4
    expect(await points(ALEX)).toBe(a0 + 6);
    expect(await points(BLAKE)).toBe(b0 + 4);
    expect(await count(`select 1 from public.notifications where message like '%Undo me%'`, [])).toBeGreaterThan(0);

    await as(ALEX, `select public.remove_completed_chore($1)`, [id]);

    expect(await points(ALEX)).toBe(a0);
    expect(await points(BLAKE)).toBe(b0);
    expect(await count(`select 1 from public.chore_instances where id = $1`, [id])).toBe(0);
    expect(await count(`select 1 from public.chore_completions where instance_id = $1`, [id])).toBe(0);
    expect(await count(`select 1 from public.notifications where message like '%Undo me%'`, [])).toBe(0);
  });

  it("either partner can remove it", async () => {
    const id = await chore(ALEX, "Partner removes", 4);
    await as(ALEX, `select * from public.complete_chore($1, 10, 100)`, [id]);
    await as(BLAKE, `select public.remove_completed_chore($1)`, [id]);
    expect(await count(`select 1 from public.chore_instances where id = $1`, [id])).toBe(0);
  });

  it("floors a balance at zero if the points were already spent", async () => {
    const id = await chore(ALEX, "Already spent", 8);
    await as(ALEX, `select * from public.complete_chore($1, 10, 100)`, [id]);
    await admin(`update public.profiles set points = 2 where id = $1`, [ALEX]);
    await as(ALEX, `select public.remove_completed_chore($1)`, [id]);
    expect(await points(ALEX)).toBe(0);
  });

  it("also removes a not-yet-completed chore without touching points", async () => {
    const before = await points(ALEX);
    const id = await chore(ALEX, "Never done", 5);
    await as(ALEX, `select public.remove_completed_chore($1)`, [id]);
    expect(await points(ALEX)).toBe(before);
    expect(await count(`select 1 from public.chore_instances where id = $1`, [id])).toBe(0);
  });

  it("is limited to your own household and to signed-in users", async () => {
    const id = await chore(ALEX, "Not yours to remove", 3);
    await as(ALEX, `select * from public.complete_chore($1, 5, 100)`, [id]);
    await expect(as(DREW, `select public.remove_completed_chore($1)`, [id])).rejects.toThrow(/not found/i);
    await expect(asAnon(`select public.remove_completed_chore($1)`, [id])).rejects.toThrow(/permission denied/);
    expect(await count(`select 1 from public.chore_instances where id = $1`, [id])).toBe(1);
  });

  it("direct deletes of completed chores are still blocked (the function is the only way)", async () => {
    const id = await chore(ALEX, "Direct delete", 2);
    await as(ALEX, `select * from public.complete_chore($1, 5, 100)`, [id]);
    expect(await as(ALEX, `delete from public.chore_instances where id = $1 returning id`, [id])).toHaveLength(0);
  });
});

describe("recurring chores", () => {
  const dayFromNow = async (n: number) => (await admin(`select (current_date + $1::int)::text as d`, [n]))[0].d as string;
  const seriesOf = async (id: string) =>
    (await admin(`select parent_recurrence_id from public.chore_instances where id = $1`, [id]))[0].parent_recurrence_id as string;
  const occurrences = (sid: string) =>
    admin<{ id: string; d: string; title: string; minutes: number; tax: number; who: string | null; done: boolean; rule: string }>(
      `select id, scheduled_date::text d, title, estimated_duration minutes, chore_tax tax, assigned_to who, is_completed done, recurrence_rule rule
       from public.chore_instances where parent_recurrence_id = $1 order by scheduled_date`,
      [sid],
    );
  const gap = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;
  const noteCount = async (uid: string, like: string) =>
    (await as(uid, `select 1 from public.notifications where message like $1`, [like])).length;

  it("counts monthly occurrences from the anchor, so month-ends do not drift", async () => {
    const occ = (n: number) => admin(`select public.series_occurrence('2026-01-31', 'monthly', $1)::text as d`, [n]);
    expect((await occ(1))[0].d).toBe("2026-02-28");
    expect((await occ(2))[0].d).toBe("2026-03-31");
    expect((await occ(13))[0].d).toBe("2027-02-28");
  });

  it("make_chore_recurring links the chore to a series and fills 12 weeks ahead", async () => {
    const start = await dayFromNow(1);
    const id = await chore(ALEX, "Weekly bins", 4, ALEX, start);
    await as(ALEX, `select public.make_chore_recurring($1, 'weekly')`, [id]);
    const rows = await occurrences(await seriesOf(id));
    expect(rows).toHaveLength(13); // the original + 12 weekly repeats
    expect(rows[0]).toMatchObject({ id, d: start, rule: "FREQ=WEEKLY" });
    rows.slice(1).forEach((r, i) => expect(gap(rows[i].d, r.d)).toBe(7));
    expect(rows.every((r) => r.title === "Weekly bins" && r.minutes === 15 && r.tax === 4 && r.who === ALEX && !r.done)).toBe(true);
  });

  it("never back-fills a pile of overdue chores when the start date is in the past", async () => {
    const old = await dayFromNow(-20);
    const id = await chore(ALEX, "Old daily", 2, ALEX, old);
    await as(ALEX, `select public.make_chore_recurring($1, 'daily')`, [id]);
    const rows = await occurrences(await seriesOf(id));
    const earliest = await dayFromNow(-1);
    expect(rows[0].d).toBe(old);
    expect(rows.slice(1).every((r) => r.d >= earliest)).toBe(true);
  });

  it("a partner-assigned series sends one summary, not one alert per occurrence", async () => {
    const id = await chore(ALEX, "Blake weekly", 3, BLAKE, await dayFromNow(2));
    await as(ALEX, `select public.make_chore_recurring($1, 'weekly')`, [id]);
    // 1 for the original assignment + 1 "set to repeat" summary, not 13
    expect(await noteCount(BLAKE, "%Blake weekly%")).toBe(2);
    expect(await noteCount(BLAKE, '%set "Blake weekly" to repeat every week for you%')).toBe(1);
  });

  it("extend tops a series up without resurrecting occurrences you deleted", async () => {
    const id = await chore(ALEX, "Extend me", 3, ALEX, await dayFromNow(1));
    await as(ALEX, `select public.make_chore_recurring($1, 'weekly')`, [id]);
    const sid = await seriesOf(id);
    const before = await occurrences(sid);
    const deleted = before[2];
    expect(await as(ALEX, `delete from public.chore_instances where id = $1 returning id`, [deleted.id])).toHaveLength(1);

    await as(ALEX, `select public.extend_recurring_chores(current_date + 200)`);
    const after = await occurrences(sid);
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.some((r) => r.d === deleted.d)).toBe(false);

    await as(ALEX, `select public.extend_recurring_chores(current_date + 200)`); // idempotent
    expect(await occurrences(sid)).toHaveLength(after.length);
  });

  it("caps how far ahead it will generate", async () => {
    const id = await chore(ALEX, "Capped", 1, ALEX, await dayFromNow(1));
    await as(ALEX, `select public.make_chore_recurring($1, 'daily')`, [id]);
    await as(ALEX, `select public.extend_recurring_chores(current_date + 5000)`);
    const rows = await occurrences(await seriesOf(id));
    expect(rows[rows.length - 1].d <= (await dayFromNow(366))).toBe(true);
  });

  it("rejects moving an occurrence onto a day the series already uses", async () => {
    const id = await chore(ALEX, "No doubles", 2, ALEX, await dayFromNow(3));
    await as(ALEX, `select public.make_chore_recurring($1, 'weekly')`, [id]);
    const [first, second] = await occurrences(await seriesOf(id));
    await expect(
      as(ALEX, `update public.chore_instances set scheduled_date = $2 where id = $1`, [second.id, first.d]),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("this-and-future edits change later unfinished occurrences only", async () => {
    const id = await chore(ALEX, "Old name", 5, ALEX, await dayFromNow(1));
    await as(ALEX, `select public.make_chore_recurring($1, 'weekly')`, [id]);
    const sid = await seriesOf(id);
    const rows = await occurrences(sid);
    await as(ALEX, `select * from public.complete_chore($1, 10, 100)`, [rows[0].id]); // finished: stays as it was
    const pivot = rows[3];

    await as(ALEX, `select public.update_chore_series($1, 'New name', 30, 7, $2, 'weekly')`, [pivot.id, BLAKE]);

    const after = await occurrences(sid);
    for (const r of after) {
      if (r.d < pivot.d) expect(r).toMatchObject({ title: "Old name", minutes: 15, tax: 5, who: ALEX });
      else expect(r).toMatchObject({ title: "New name", minutes: 30, tax: 7, who: BLAKE });
    }
    expect(after[0].done).toBe(true);
    expect(after).toHaveLength(rows.length); // same frequency: nothing regenerated
    expect(await noteCount(BLAKE, "%assigned you the repeating chore: New name%")).toBe(1);
  });

  it("changing how often it repeats rebuilds the later occurrences", async () => {
    const id = await chore(ALEX, "Weekly to daily", 2, ALEX, await dayFromNow(1));
    await as(ALEX, `select public.make_chore_recurring($1, 'weekly')`, [id]);
    const sid = await seriesOf(id);
    const pivot = (await occurrences(sid))[2];
    await as(ALEX, `select public.update_chore_series($1, 'Weekly to daily', 15, 2, $2, 'daily')`, [pivot.id, ALEX]);
    const after = await occurrences(sid);
    const upTo = after.filter((r) => r.d <= pivot.d);
    const from = after.filter((r) => r.d >= pivot.d);
    expect(upTo.map((r) => r.d)).toEqual((await occurrences(sid)).slice(0, upTo.length).map((r) => r.d));
    from.slice(1).forEach((r, i) => expect(gap(from[i].d, r.d)).toBe(1));
    expect(from[from.length - 1].rule).toBe("FREQ=DAILY");
  });

  it("'none' stops the series and later top-ups add nothing", async () => {
    const id = await chore(ALEX, "Stop me", 2, ALEX, await dayFromNow(1));
    await as(ALEX, `select public.make_chore_recurring($1, 'weekly')`, [id]);
    const sid = await seriesOf(id);
    const pivot = (await occurrences(sid))[1];
    await as(ALEX, `select public.update_chore_series($1, 'Stop me', 15, 2, $2, 'none')`, [pivot.id, ALEX]);
    const stopped = await occurrences(sid);
    expect(stopped[stopped.length - 1].d).toBe(pivot.d);
    await as(ALEX, `select public.extend_recurring_chores(current_date + 300)`);
    expect(await occurrences(sid)).toHaveLength(stopped.length);
  });

  it("validates input and refuses invalid states", async () => {
    const id = await chore(ALEX, "Validate", 2, ALEX, await dayFromNow(1));
    await expect(as(ALEX, `select public.make_chore_recurring($1, 'hourly')`, [id])).rejects.toThrow(/how often/);
    await expect(as(ALEX, `select public.update_chore_series($1, 'x', 15, 2, $2, 'weekly')`, [id, ALEX])).rejects.toThrow(/does not repeat/);
    await as(ALEX, `select public.make_chore_recurring($1, 'weekly')`, [id]);
    await expect(as(ALEX, `select public.make_chore_recurring($1, 'weekly')`, [id])).rejects.toThrow(/already repeats/);
    await expect(as(ALEX, `select public.update_chore_series($1, '  ', 15, 2, $2, 'weekly')`, [id, ALEX])).rejects.toThrow(/name/);
    await expect(as(ALEX, `select public.update_chore_series($1, 'x', 7, 2, $2, 'weekly')`, [id, ALEX])).rejects.toThrow(/multiple of 5/);
    await expect(as(ALEX, `select public.update_chore_series($1, 'x', 15, 51, $2, 'weekly')`, [id, ALEX])).rejects.toThrow(/between 0 and 50/);
    const done = await chore(ALEX, "Already done", 2, ALEX, await dayFromNow(1));
    await as(ALEX, `select * from public.complete_chore($1, 5, 100)`, [done]);
    await expect(as(ALEX, `select public.make_chore_recurring($1, 'weekly')`, [done])).rejects.toThrow(/completed/);
  });

  it("is limited to your household and to signed-in users; clients cannot touch series directly", async () => {
    const id = await chore(ALEX, "Private", 2, ALEX, await dayFromNow(1));
    await expect(as(DREW, `select public.make_chore_recurring($1, 'weekly')`, [id])).rejects.toThrow(/not found/i);
    await expect(asAnon(`select public.extend_recurring_chores(current_date)`)).rejects.toThrow(/permission denied/);
    await expect(
      as(ALEX, `insert into public.chore_series (household_id, title, points, frequency, start_date, generated_through)
                values (public.current_household_id(), 'x', 1, 'daily', current_date, current_date)`),
    ).rejects.toThrow(/permission denied/);
    await expect(as(ALEX, `select public.generate_series_instances(gen_random_uuid(), current_date)`)).rejects.toThrow(/permission denied/);
    await as(ALEX, `select public.make_chore_recurring($1, 'weekly')`, [id]);
    expect(await as(DREW, `select 1 from public.chore_series`)).toHaveLength(0);
    expect((await as(BLAKE, `select 1 from public.chore_series`)).length).toBeGreaterThan(0);
  });

  it("scheduled chores can have their time estimate and tax edited, but not completion state", async () => {
    const id = await chore(ALEX, "Edit estimate", 3, ALEX, await dayFromNow(1));
    expect(await as(ALEX, `update public.chore_instances set estimated_duration = 30, chore_tax = 6 where id = $1 returning estimated_duration, chore_tax`, [id])).toEqual([{ estimated_duration: 30, chore_tax: 6 }]);
    await expect(as(ALEX, `update public.chore_instances set is_completed = true where id = $1`, [id])).rejects.toThrow(/permission denied/);
    await expect(as(ALEX, `update public.chore_instances set estimated_duration = 7 where id = $1`, [id])).rejects.toThrow(/check constraint/);
    await expect(as(ALEX, `update public.chore_instances set chore_tax = 51 where id = $1`, [id])).rejects.toThrow(/check constraint/);
  });
});

describe("uncomplete_chore (uncheck)", () => {
  const points = async (uid: string) =>
    (await as(uid, `select points from public.profiles where id = $1`, [uid]))[0].points as number;
  const admin1 = async (sql: string, params: unknown[]) => (await admin(sql, params)).length;

  it("takes back both partners' points and returns the chore to unfinished", async () => {
    const [a0, b0] = [await points(ALEX), await points(BLAKE)];
    const id = await chore(ALEX, "Uncheck me", 10);
    await as(ALEX, `select * from public.complete_chore($1, 30, 60)`, [id]); // Alex +6, Blake +4
    expect(await admin1(`select 1 from public.notifications where message like '%Uncheck me%'`, [])).toBeGreaterThan(0);

    await as(ALEX, `select public.uncomplete_chore($1)`, [id]);

    expect(await points(ALEX)).toBe(a0);
    expect(await points(BLAKE)).toBe(b0);
    const [inst] = await admin(`select is_completed, completed_at from public.chore_instances where id = $1`, [id]);
    expect(inst).toEqual({ is_completed: false, completed_at: null });
    expect(await admin1(`select 1 from public.chore_completions where instance_id = $1`, [id])).toBe(0);
    expect(await admin1(`select 1 from public.notifications where message like '%Uncheck me%' and type = 'chore_completed'`, [])).toBe(0);
  });

  it("the chore is fully usable again: editable, movable and completable with a different split", async () => {
    const [a0, b0] = [await points(ALEX), await points(BLAKE)];
    const id = await chore(ALEX, "Redo me", 10);
    await as(ALEX, `select * from public.complete_chore($1, 30, 100)`, [id]); // Alex +10
    await as(BLAKE, `select public.uncomplete_chore($1)`, [id]); // either partner may uncheck
    expect(await points(ALEX)).toBe(a0);

    expect(await as(ALEX, `update public.chore_instances set title = 'Redone', chore_tax = 2 where id = $1 returning id`, [id])).toHaveLength(1);
    await as(ALEX, `select * from public.complete_chore($1, 20, 50)`, [id]); // 20 min = 4 base + 2 tax = 6 -> 3 + 3
    expect(await points(ALEX)).toBe(a0 + 3);
    expect(await points(BLAKE)).toBe(b0 + 3);
    expect(await admin1(`select 1 from public.chore_completions where instance_id = $1`, [id])).toBe(1);
  });

  it("floors a balance at zero if the points were already spent", async () => {
    const id = await chore(ALEX, "Spent already", 8);
    await as(ALEX, `select * from public.complete_chore($1, 10, 100)`, [id]);
    await admin(`update public.profiles set points = 1 where id = $1`, [ALEX]);
    await as(ALEX, `select public.uncomplete_chore($1)`, [id]);
    expect(await points(ALEX)).toBe(0);
  });

  it("rejects unfinished chores, other households and signed-out callers", async () => {
    const open = await chore(ALEX, "Still open", 3);
    await expect(as(ALEX, `select public.uncomplete_chore($1)`, [open])).rejects.toThrow(/not completed/);
    const done = await chore(ALEX, "Not yours", 3);
    await as(ALEX, `select * from public.complete_chore($1, 5, 100)`, [done]);
    await expect(as(DREW, `select public.uncomplete_chore($1)`, [done])).rejects.toThrow(/not found/i);
    await expect(asAnon(`select public.uncomplete_chore($1)`, [done])).rejects.toThrow(/permission denied/);
    expect((await admin(`select is_completed from public.chore_instances where id = $1`, [done]))[0].is_completed).toBe(true);
  });
});

describe("edit_completed_chore", () => {
  const points = async (uid: string) =>
    (await as(uid, `select points from public.profiles where id = $1`, [uid]))[0].points as number;

  it("changing only the name or day never touches points or the logged time", async () => {
    const id = await chore(ALEX, "Typo chore", 10, ALEX, "2026-09-10");
    await as(ALEX, `select * from public.complete_chore($1, 30, 60)`, [id]); // Alex 6 pts/18m, Blake 4 pts/12m
    const [a0, b0] = [await points(ALEX), await points(BLAKE)];
    const before = (await admin(`select * from public.chore_completions where instance_id = $1`, [id]))[0];

    const result = await as(ALEX, `select * from public.edit_completed_chore($1, '  Fixed name  ', $2, '2026-09-11')`, [id, ALEX]);

    const [inst] = await admin(`select title, assigned_to, scheduled_date::text d, is_completed, chore_tax from public.chore_instances where id = $1`, [id]);
    expect(inst).toEqual({ title: "Fixed name", assigned_to: ALEX, d: "2026-09-11", is_completed: true, chore_tax: 10 });
    expect(result).toEqual([]); // nothing was re-priced
    expect(await points(ALEX)).toBe(a0);
    expect(await points(BLAKE)).toBe(b0);
    expect((await admin(`select * from public.chore_completions where instance_id = $1`, [id]))[0]).toEqual(before);
  });

  it("handing a finished chore to the other person moves the credit with it (see the ledger tests)", async () => {
    const id = await chore(ALEX, "Handover", 10, ALEX, "2026-09-10");
    await as(ALEX, `select * from public.complete_chore($1, 30, 60)`, [id]); // 16 pts: Alex 10 / Blake 6
    const [a0, b0] = [await points(ALEX), await points(BLAKE)];
    await as(ALEX, `select * from public.edit_completed_chore($1, 'Handover', $2, '2026-09-10')`, [id, BLAKE]);
    expect(await points(ALEX)).toBe(a0 - 10 + 6); // Alex now has the 40% share
    expect(await points(BLAKE)).toBe(b0 - 6 + 10); // Blake now has the 60% share
  });

  it("does not notify the partner that a finished chore was 'assigned' to them", async () => {
    const id = await chore(ALEX, "Quiet fix", 4);
    await as(ALEX, `select * from public.complete_chore($1, 5, 100)`, [id]);
    const before = (await as(BLAKE, `select 1 from public.notifications where message like '%assigned you: Quiet fix%' or message like '%assigned you: Renamed quietly%'`)).length;
    await as(ALEX, `select public.edit_completed_chore($1, 'Renamed quietly', $2, '2026-09-18')`, [id, BLAKE]);
    const after = (await as(BLAKE, `select 1 from public.notifications where message like '%assigned you: Renamed quietly%'`)).length;
    expect(after).toBe(0);
    expect(before).toBe(0);
  });

  it("either partner can fix it; input is validated", async () => {
    const id = await chore(ALEX, "Validate done", 2);
    await as(ALEX, `select * from public.complete_chore($1, 5, 100)`, [id]);
    await as(BLAKE, `select public.edit_completed_chore($1, 'Blake fixed', $2, '2026-09-18')`, [id, ALEX]);
    await expect(as(ALEX, `select public.edit_completed_chore($1, '   ', $2, '2026-09-18')`, [id, ALEX])).rejects.toThrow(/name/);
    await expect(as(ALEX, `select public.edit_completed_chore($1, 'x', $2, null)`, [id, ALEX])).rejects.toThrow(/day/);
    await expect(as(ALEX, `select public.edit_completed_chore($1, 'x', $2, '2026-09-18')`, [id, DREW])).rejects.toThrow(/not in your household/);
  });

  it("refuses unfinished chores, other households and signed-out callers", async () => {
    const open = await chore(ALEX, "Not done", 2);
    await expect(as(ALEX, `select public.edit_completed_chore($1, 'x', $2, '2026-09-18')`, [open, ALEX])).rejects.toThrow(/not completed yet/);
    const done = await chore(ALEX, "Private done", 2);
    await as(ALEX, `select * from public.complete_chore($1, 5, 100)`, [done]);
    await expect(as(DREW, `select public.edit_completed_chore($1, 'x', null, '2026-09-18')`, [done])).rejects.toThrow(/not found/i);
    await expect(asAnon(`select public.edit_completed_chore($1, 'x', null, '2026-09-18')`, [done])).rejects.toThrow(/permission denied/);
  });

  it("direct updates of a completed chore are still blocked (the function is the only way)", async () => {
    const id = await chore(ALEX, "Locked direct", 2);
    await as(ALEX, `select * from public.complete_chore($1, 5, 100)`, [id]);
    expect(await as(ALEX, `update public.chore_instances set title = 'sneaky' where id = $1 returning id`, [id])).toHaveLength(0);
  });
});

describe("time-based points and chore tax", () => {
  const points = async (uid: string) =>
    (await as(uid, `select points from public.profiles where id = $1`, [uid]))[0].points as number;

  it("chore_points: 12 points per hour (1 per 5 minutes) plus a flat tax", async () => {
    const pts = async (m: number, t: number) => (await admin(`select public.chore_points($1, $2) as p`, [m, t]))[0].p as number;
    expect(await pts(5, 0)).toBe(1); // the minimum: 1 base point
    expect(await pts(60, 0)).toBe(12); // 12 points per hour
    expect(await pts(25, 0)).toBe(5);
    expect(await pts(25, 4)).toBe(9);
  });

  it("the tax is a flat bonus that does not depend on how long it took", async () => {
    const [a0] = [await points(ALEX)];
    const quick = await chore(ALEX, "Quick nasty", 6);
    const [q] = await as(ALEX, `select * from public.complete_chore($1, 5, 100)`, [quick]);
    expect(q.user_a_points).toBe(1 + 6);
    const slow = await chore(ALEX, "Slow nasty", 6);
    const [l] = await as(ALEX, `select * from public.complete_chore($1, 60, 100)`, [slow]);
    expect(l.user_a_points).toBe(12 + 6);
    expect(await points(ALEX)).toBe(a0 + 7 + 18);
  });

  it("matches the worked example: 25 min, tax 4, split 60/40 -> total 9 = 5 + 4", async () => {
    const id = await chore(ALEX, "Worked example", 4);
    const [c] = await as(ALEX, `select * from public.complete_chore($1, 25, 60)`, [id]);
    expect(c).toMatchObject({ user_a_duration: 15, user_a_points: 5, user_b_duration: 10, user_b_points: 4, total_duration_minutes: 25 });
  });

  it("uses the logged time, not the estimate", async () => {
    const id = await chore(ALEX, "Estimate 15", 0, ALEX, "2026-09-18", 15);
    const [c] = await as(ALEX, `select * from public.complete_chore($1, 45, 100)`, [id]);
    expect(c.user_a_points).toBe(9);
  });
});

describe("unassigned chore pool", () => {
  const points = async (uid: string) =>
    (await as(uid, `select points from public.profiles where id = $1`, [uid]))[0].points as number;

  it("an unassigned chore can be created, adjusted and claimed by either partner", async () => {
    const id = await chore(ALEX, "Open task", 0, null);
    expect((await admin(`select assigned_to from public.chore_instances where id = $1`, [id]))[0].assigned_to).toBeNull();
    // before claiming: tweak the estimate and tax
    await as(BLAKE, `update public.chore_instances set estimated_duration = 30, chore_tax = 5 where id = $1`, [id]);
    // claim
    expect(await as(BLAKE, `update public.chore_instances set assigned_to = $2 where id = $1 returning assigned_to`, [id, BLAKE])).toEqual([{ assigned_to: BLAKE }]);
  });

  it("creating an unassigned chore does not notify anyone", async () => {
    const before = (await as(BLAKE, `select 1 from public.notifications`)).length;
    await chore(ALEX, "Silent open task", 0, null);
    expect((await as(BLAKE, `select 1 from public.notifications`)).length).toBe(before);
  });

  it("completing an unassigned chore claims it for you and gives you 100% by default", async () => {
    const [b0, a0] = [await points(BLAKE), await points(ALEX)];
    const id = await chore(ALEX, "Grab and go", 4, null); // 30 min = 6 + 4 = 10
    const [c] = await as(BLAKE, `select * from public.complete_chore($1, 30, 100)`, [id]);
    expect(c).toMatchObject({ user_a_id: BLAKE, user_a_points: 10, user_a_duration: 30, user_b_id: ALEX, user_b_points: 0 });
    expect(await points(BLAKE)).toBe(b0 + 10);
    expect(await points(ALEX)).toBe(a0);
    expect((await admin(`select assigned_to from public.chore_instances where id = $1`, [id]))[0].assigned_to).toBe(BLAKE);
  });

  it("an unassigned chore can still be completed with a split", async () => {
    const id = await chore(ALEX, "Team effort", 0, null); // 20 min = 4
    const [c] = await as(ALEX, `select * from public.complete_chore($1, 20, 50)`, [id]);
    expect(c).toMatchObject({ user_a_points: 2, user_b_points: 2 });
  });

  it("other households cannot see or complete it", async () => {
    const id = await chore(ALEX, "Not for Drew", 0, null);
    await expect(as(DREW, `select * from public.complete_chore($1, 5, 100)`, [id])).rejects.toThrow(/not found/);
    expect(await as(DREW, `select 1 from public.chore_instances where id = $1`, [id])).toHaveLength(0);
  });

  it("you can hand a claimed chore back to the pool", async () => {
    const id = await chore(ALEX, "Unclaim", 0, ALEX);
    expect(await as(ALEX, `update public.chore_instances set assigned_to = null where id = $1 returning id`, [id])).toHaveLength(1);
  });
});

describe("completing a chore assigned to your partner", () => {
  const points = async (uid: string) =>
    (await as(uid, `select points from public.profiles where id = $1`, [uid]))[0].points as number;
  const assignee = async (id: string) =>
    (await admin(`select assigned_to from public.chore_instances where id = $1`, [id]))[0].assigned_to;

  it("keeps the assignee and credits them 100%, whoever taps Complete", async () => {
    const [a0, b0] = [await points(ALEX), await points(BLAKE)];
    const id = await chore(ALEX, "Blake's job", 4, BLAKE); // 30 min = 6 + 4 = 10
    const [c] = await as(ALEX, `select * from public.complete_chore($1, 30, 100)`, [id]);
    expect(c).toMatchObject({ user_a_id: BLAKE, user_a_points: 10, user_a_duration: 30, user_b_id: ALEX, user_b_points: 0 });
    expect(await points(BLAKE)).toBe(b0 + 10);
    expect(await points(ALEX)).toBe(a0); // the completer earns nothing for someone else's chore
    expect(await assignee(id)).toBe(BLAKE); // and does not take the chore over
  });

  it("works the same the other way round", async () => {
    const id = await chore(BLAKE, "Alex's job", 0, ALEX); // 15 min = 3
    const [c] = await as(BLAKE, `select * from public.complete_chore($1, 15, 100)`, [id]);
    expect(c).toMatchObject({ user_a_id: ALEX, user_a_points: 3, user_b_id: BLAKE, user_b_points: 0 });
    expect(await assignee(id)).toBe(ALEX);
  });

  it("splits between the assignee (their share first) and the person who did the work", async () => {
    const [a0, b0] = [await points(ALEX), await points(BLAKE)];
    const id = await chore(ALEX, "Shared job", 3, BLAKE); // 25 min = 5 + 3 = 8
    const [c] = await as(ALEX, `select * from public.complete_chore($1, 25, 60)`, [id]);
    expect(c).toMatchObject({ user_a_id: BLAKE, user_a_points: 5, user_a_duration: 15, user_b_id: ALEX, user_b_points: 3, user_b_duration: 10 });
    expect(await points(BLAKE)).toBe(b0 + 5);
    expect(await points(ALEX)).toBe(a0 + 3);
    expect(await assignee(id)).toBe(BLAKE);
  });

  it("tells the assignee it was done for them and what they earned", async () => {
    const id = await chore(ALEX, "Notify me", 0, BLAKE); // 20 min = 4
    await as(ALEX, `select * from public.complete_chore($1, 20, 100)`, [id]);
    const notes = await as(BLAKE, `select message from public.notifications where reference_id = $1 and type = 'chore_completed'`, [id]);
    expect(notes).toEqual([{ message: "Alex completed: Notify me for you (you earned 4 pts)" }]);
    expect(await as(ALEX, `select 1 from public.notifications where reference_id = $1 and type = 'chore_completed'`, [id])).toHaveLength(0);
  });

  it("uncheck takes the points back from the assignee", async () => {
    const b0 = await points(BLAKE);
    const id = await chore(ALEX, "Undo me", 0, BLAKE);
    await as(ALEX, `select * from public.complete_chore($1, 20, 100)`, [id]);
    expect(await points(BLAKE)).toBe(b0 + 4);
    await as(ALEX, `select public.uncomplete_chore($1)`, [id]);
    expect(await points(BLAKE)).toBe(b0);
    expect(await assignee(id)).toBe(BLAKE);
  });
});

describe("manage library (create, edit across the board, delete)", () => {
  const dayFromNow = async (n: number) => (await admin(`select (current_date + $1::int)::text as d`, [n]))[0].d as string;
  let n = 0;

  /** A library chore made the way the Manage screen makes it. */
  async function lib(user: string, title = `Managed ${++n}`, category = "Kitchen", minutes = 15, tax = 2) {
    const [row] = await as(user, `select * from public.create_library_chore($1, $2, $3, $4)`, [title, category, minutes, tax]);
    return row as { id: string; title: string; category: string; default_duration: number; chore_tax: number; last_used_at: string | null };
  }
  /** A scheduled copy of a library chore. */
  async function copy(user: string, chore: { id: string; title: string }, date: string, minutes = 15, tax = 2, who: string | null = user) {
    const [row] = await as(
      user,
      `insert into public.chore_instances (chore_id, title, household_id, assigned_to, scheduled_date, estimated_duration, chore_tax)
       values ($1, $2, public.current_household_id(), $3, $4, $5, $6) returning id`,
      [chore.id, chore.title, who, date, minutes, tax],
    );
    return row.id as string;
  }
  const inst = async (id: string) =>
    (await admin(`select title, estimated_duration as minutes, chore_tax as tax, is_completed as done from public.chore_instances where id = $1`, [id]))[0];
  const update = (user: string, id: string, title: string, category: string, minutes: number, tax: number) =>
    as(user, `select * from public.update_library_chore($1, $2, $3, $4, $5)`, [id, title, category, minutes, tax]);

  it("creates a chore that is not 'recent' until it is scheduled, and tidies the input", async () => {
    const c = await lib(ALEX, "  Clean oven  ", "  ", 45, 5);
    expect(c).toMatchObject({ title: "Clean oven", category: "General", default_duration: 45, chore_tax: 5, last_used_at: null });
  });

  it("rejects duplicates (any case), blanks and out-of-range values; another household may reuse a name", async () => {
    await lib(ALEX, "Unique name");
    await expect(lib(BLAKE, "unique NAME")).rejects.toThrow(/already have a chore called/);
    await expect(lib(ALEX, "   ")).rejects.toThrow(/name/);
    await expect(lib(ALEX, "Bad time", "x", 7, 0)).rejects.toThrow(/multiple of 5/);
    await expect(lib(ALEX, "Bad tax", "x", 15, 51)).rejects.toThrow(/between 0 and 50/);
    await expect(lib(ALEX, "x".repeat(61))).rejects.toThrow(/60 characters/);
    expect((await lib(DREW, "Unique name")).title).toBe("Unique name");
  });

  it("a renamed chore can be reused once the old holder is deleted", async () => {
    const a = await lib(ALEX, "Recycle me");
    await as(ALEX, `select public.delete_library_chore($1, false)`, [a.id]);
    expect((await lib(ALEX, "Recycle me")).title).toBe("Recycle me");
  });

  it("pushes a new time and tax to unfinished copies; finished ones are re-priced and balances adjusted", async () => {
    const c = await lib(ALEX, undefined, "Kitchen", 15, 2);
    const open = await copy(ALEX, c, await dayFromNow(2));
    const done = await copy(ALEX, c, await dayFromNow(-3));
    await as(ALEX, `select * from public.complete_chore($1, 15, 100)`, [done]); // 15 min = 3 + tax 2 = 5
    const a0 = (await admin(`select points from public.profiles where id = $1`, [ALEX]))[0].points;

    const [r] = await update(ALEX, c.id, c.title, "Kitchen", 30, 5);
    expect(r).toMatchObject({ n_open: 1, n_series: 0, n_done: 1, my_delta: 3, their_delta: 0 });
    expect(await inst(open)).toMatchObject({ minutes: 30, tax: 5 });
    // The finished copy keeps the time actually logged (15) but its tax follows: 3 + 5 = 8.
    expect(await inst(done)).toMatchObject({ minutes: 30, tax: 5, done: true });
    const [comp] = await admin(`select total_duration_minutes m, user_a_points p from public.chore_completions where instance_id = $1`, [done]);
    expect(comp).toEqual({ m: 15, p: 8 });
    expect((await admin(`select points from public.profiles where id = $1`, [ALEX]))[0].points).toBe(a0 + 3);
    expect((await admin(`select default_duration, chore_tax from public.chore_library where id = $1`, [c.id]))[0]).toEqual({ default_duration: 30, chore_tax: 5 });
  });

  it("can leave finished chores alone when told not to re-price them", async () => {
    const c = await lib(ALEX, undefined, "Kitchen", 15, 2);
    const done = await copy(ALEX, c, await dayFromNow(-3));
    await as(ALEX, `select * from public.complete_chore($1, 15, 100)`, [done]);
    const a0 = (await admin(`select points from public.profiles where id = $1`, [ALEX]))[0].points;
    const [r] = await as(ALEX, `select * from public.update_library_chore($1, $2, 'Kitchen', 15, 9, false)`, [c.id, c.title]);
    expect(r).toMatchObject({ n_done: 0, my_delta: 0 });
    expect((await inst(done)).tax).toBe(2);
    expect((await admin(`select user_a_points p from public.chore_completions where instance_id = $1`, [done]))[0].p).toBe(5);
    expect((await admin(`select points from public.profiles where id = $1`, [ALEX]))[0].points).toBe(a0);
  });

  it("a new name reaches every copy, finished ones too", async () => {
    const c = await lib(ALEX, "Old name");
    const open = await copy(ALEX, c, await dayFromNow(1));
    const done = await copy(ALEX, c, await dayFromNow(-2));
    await as(ALEX, `select * from public.complete_chore($1, 15, 100)`, [done]);
    await update(ALEX, c.id, "Shiny new name", "Kitchen", 15, 2);
    expect((await inst(open)).title).toBe("Shiny new name");
    expect((await inst(done)).title).toBe("Shiny new name");
  });

  it("pushes only what changed: a tax change keeps a one-off time, a category change touches no copy", async () => {
    const c = await lib(ALEX, undefined, "Kitchen", 15, 2);
    const id = await copy(ALEX, c, await dayFromNow(1), 45, 2); // a one-off long day
    await as(ALEX, `update public.chore_instances set title = 'One-off name' where id = $1`, [id]);

    await update(ALEX, c.id, c.title, "Kitchen", 15, 8); // tax only
    expect(await inst(id)).toMatchObject({ title: "One-off name", minutes: 45, tax: 8 });

    const [r] = await update(ALEX, c.id, c.title, "Cleaning", 15, 8); // category only
    expect(r).toMatchObject({ n_open: 0, n_series: 0 });
    expect(await inst(id)).toMatchObject({ title: "One-off name", minutes: 45, tax: 8 });
    expect((await admin(`select category from public.chore_library where id = $1`, [c.id]))[0].category).toBe("Cleaning");
  });

  it("updates a repeating chore, including days generated later", async () => {
    const c = await lib(ALEX, undefined, "Kitchen", 15, 2);
    const first = await copy(ALEX, c, await dayFromNow(1));
    await as(ALEX, `select public.make_chore_recurring($1, 'weekly')`, [first]);
    const sid = (await admin(`select parent_recurrence_id from public.chore_instances where id = $1`, [first]))[0].parent_recurrence_id;

    const [r] = await update(ALEX, c.id, "Weekly renamed", "Kitchen", 20, 6);
    expect(r.n_series).toBe(1);
    expect(r.n_open).toBeGreaterThan(1);
    const rows = await admin(`select title, estimated_duration m, chore_tax t from public.chore_instances where parent_recurrence_id = $1`, [sid]);
    expect(new Set(rows.map((x) => `${x.title}|${x.m}|${x.t}`))).toEqual(new Set(["Weekly renamed|20|6"]));

    await as(ALEX, `select public.extend_recurring_chores(current_date + 400)`); // generates days beyond the first 12 weeks
    const later = await admin(`select title, estimated_duration m, chore_tax t from public.chore_instances where parent_recurrence_id = $1`, [sid]);
    expect(later.length).toBeGreaterThan(rows.length);
    expect(new Set(later.map((x) => `${x.title}|${x.m}|${x.t}`))).toEqual(new Set(["Weekly renamed|20|6"]));
  });

  it("rejects a rename onto an existing name, other households' chores, and deleted chores", async () => {
    const a = await lib(ALEX, "Name A");
    const b = await lib(ALEX, "Name B");
    await expect(update(ALEX, b.id, "name a", "Kitchen", 15, 2)).rejects.toThrow(/already have a chore called/);
    expect(await update(ALEX, a.id, "Name A", "Other", 15, 2)).toHaveLength(1); // keeping its own name is fine
    await expect(update(DREW, a.id, "Hijack", "x", 15, 2)).rejects.toThrow(/not found/);
    await expect(update(ALEX, a.id, "Name A", "x", 12, 2)).rejects.toThrow(/multiple of 5/);
    await as(ALEX, `select public.delete_library_chore($1, false)`, [b.id]);
    await expect(update(ALEX, b.id, "Name B", "x", 15, 2)).rejects.toThrow(/not found/);
  });

  it("does not notify anyone when it rewrites assigned chores", async () => {
    const c = await lib(ALEX, undefined, "Kitchen", 15, 2);
    await copy(ALEX, c, await dayFromNow(1), 15, 2, BLAKE);
    const before = (await as(BLAKE, `select 1 from public.notifications`)).length;
    await update(ALEX, c.id, `${c.title} v2`, "Kitchen", 25, 4);
    expect((await as(BLAKE, `select 1 from public.notifications`)).length).toBe(before);
  });

  it("delete archives the chore and stops it repeating but keeps calendar copies when asked to", async () => {
    const c = await lib(ALEX);
    const first = await copy(ALEX, c, await dayFromNow(1));
    await as(ALEX, `select public.make_chore_recurring($1, 'weekly')`, [first]);
    const sid = (await admin(`select parent_recurrence_id from public.chore_instances where id = $1`, [first]))[0].parent_recurrence_id;
    const before = (await admin(`select count(*)::int c from public.chore_instances where parent_recurrence_id = $1`, [sid]))[0].c;

    expect((await as(ALEX, `select public.delete_library_chore($1, false) as removed`, [c.id]))[0].removed).toBe(0);
    expect((await admin(`select is_archived from public.chore_library where id = $1`, [c.id]))[0].is_archived).toBe(true);
    await as(ALEX, `select public.extend_recurring_chores(current_date + 400)`);
    expect((await admin(`select count(*)::int c from public.chore_instances where parent_recurrence_id = $1`, [sid]))[0].c).toBe(before); // nothing new
    expect((await inst(first)).done).toBe(false); // still on the calendar
  });

  it("delete can also remove unfinished copies, but never finished ones or their points", async () => {
    const c = await lib(ALEX, undefined, "Kitchen", 15, 2);
    const open = await copy(ALEX, c, await dayFromNow(1));
    const done = await copy(ALEX, c, await dayFromNow(-1));
    await as(ALEX, `select * from public.complete_chore($1, 15, 100)`, [done]);

    expect((await as(ALEX, `select public.delete_library_chore($1, true) as removed`, [c.id]))[0].removed).toBe(1);
    expect(await admin(`select 1 from public.chore_instances where id = $1`, [open])).toHaveLength(0);
    expect(await admin(`select 1 from public.chore_instances where id = $1`, [done])).toHaveLength(1);
    expect(await admin(`select 1 from public.chore_completions where instance_id = $1`, [done])).toHaveLength(1);
  });

  it("only your own household can delete, and a chore cannot be deleted twice", async () => {
    const c = await lib(ALEX);
    await expect(as(DREW, `select public.delete_library_chore($1, true)`, [c.id])).rejects.toThrow(/not found/);
    await as(BLAKE, `select public.delete_library_chore($1, false)`, [c.id]); // either partner may
    await expect(as(ALEX, `select public.delete_library_chore($1, false)`, [c.id])).rejects.toThrow(/not found/);
  });

  it("library_usage counts open, finished and repeating copies for live chores of your household only", async () => {
    const c = await lib(ALEX, "Usage counted", "Kitchen", 15, 2);
    const a = await copy(ALEX, c, await dayFromNow(1));
    await copy(ALEX, c, await dayFromNow(9));
    const d = await copy(ALEX, c, await dayFromNow(-1));
    await as(ALEX, `select * from public.complete_chore($1, 15, 100)`, [d]);
    await as(ALEX, `select public.make_chore_recurring($1, 'weekly')`, [a]);
    const gone = await lib(ALEX, "Usage gone");
    await as(ALEX, `select public.delete_library_chore($1, false)`, [gone.id]);

    const rows = await as(BLAKE, `select * from public.library_usage()`);
    const mine = rows.find((r) => r.library_id === c.id)!;
    expect(mine.done_count).toBe(1);
    expect(mine.repeating_count).toBe(1);
    expect(mine.open_count).toBeGreaterThanOrEqual(2);
    expect(rows.find((r) => r.library_id === gone.id)).toBeUndefined();
    expect((await as(DREW, `select * from public.library_usage()`)).find((r) => r.library_id === c.id)).toBeUndefined();
  });

  it("the new functions are closed to anonymous callers", async () => {
    await expect(asAnon(`select * from public.library_usage()`)).rejects.toThrow(/permission denied/);
    await expect(asAnon(`select * from public.create_library_chore('x', 'x', 15, 0)`)).rejects.toThrow(/permission denied/);
    await expect(asAnon(`select * from public.update_library_chore(gen_random_uuid(), 'x', 'x', 15, 0)`)).rejects.toThrow(/permission denied/);
    await expect(asAnon(`select public.delete_library_chore(gen_random_uuid(), true)`)).rejects.toThrow(/permission denied/);
  });
});

describe("dynamic ledger: editing a finished chore re-prices it and adjusts balances", () => {
  const bal = async (uid: string) => (await admin(`select points from public.profiles where id = $1`, [uid]))[0].points as number;
  const compOf = async (id: string) => (await admin(`select * from public.chore_completions where instance_id = $1`, [id]))[0];
  const edit = (user: string, id: string, args: { title?: string; who: string; minutes?: number | null; tax?: number | null; pct?: number | null }) =>
    as(
      user,
      `select * from public.edit_completed_chore($1, $2, $3, '2026-09-18', $4, $5, $6)`,
      [id, args.title ?? "Ledger chore", args.who, args.minutes ?? null, args.tax ?? null, args.pct ?? null],
    );
  const done = async (owner: string, tax: number, minutes: number, pct: number, who = owner) => {
    const id = await chore(owner, "Ledger chore", tax, who, "2026-09-10");
    await as(owner, `select * from public.complete_chore($1, $2, $3)`, [id, minutes, pct]);
    return id;
  };

  it("a higher tax credits the difference straight away", async () => {
    const a0 = await bal(ALEX);
    const id = await done(ALEX, 4, 30, 100); // 6 + 4 = 10
    expect(await bal(ALEX)).toBe(a0 + 10);
    const rows = await edit(ALEX, id, { who: ALEX, tax: 10 }); // 6 + 10 = 16
    expect(rows.find((r) => r.o_user === ALEX)).toMatchObject({ o_delta: 6 });
    expect(await bal(ALEX)).toBe(a0 + 16);
    expect(await compOf(id)).toMatchObject({ user_a_points: 16, total_duration_minutes: 30 });
    expect((await admin(`select chore_tax from public.chore_instances where id = $1`, [id]))[0].chore_tax).toBe(10);
  });

  it("a lower tax or shorter time debits the difference", async () => {
    const a0 = await bal(ALEX);
    const id = await done(ALEX, 4, 60, 100); // 12 + 4 = 16
    await edit(ALEX, id, { who: ALEX, tax: 0, minutes: 30 }); // 6 + 0 = 6
    expect(await bal(ALEX)).toBe(a0 + 6);
    expect(await compOf(id)).toMatchObject({ user_a_points: 6, user_a_duration: 30, total_duration_minutes: 30 });
  });

  it("re-prices a split exactly: shares stay whole and add up, and both balances move by their own difference", async () => {
    const [a0, b0] = [await bal(ALEX), await bal(BLAKE)];
    const id = await done(ALEX, 4, 30, 60); // total 10: Alex 6 / Blake 4
    expect([await bal(ALEX) - a0, await bal(BLAKE) - b0]).toEqual([6, 4]);
    const rows = await edit(ALEX, id, { who: ALEX, minutes: 45 }); // total 9 + 4 = 13: Alex round(7.8)=8 / Blake 5
    const c = await compOf(id);
    expect(c).toMatchObject({ user_a_points: 8, user_b_points: 5, user_a_duration: 27, user_b_duration: 18, owner_percent: 60 });
    expect(c.user_a_points + c.user_b_points).toBe(13);
    expect(Object.fromEntries(rows.map((r) => [r.o_user, r.o_delta]))).toEqual({ [ALEX]: 2, [BLAKE]: 1 });
    expect([await bal(ALEX) - a0, await bal(BLAKE) - b0]).toEqual([8, 5]);
  });

  it("changing the split moves points between the two people", async () => {
    const [a0, b0] = [await bal(ALEX), await bal(BLAKE)];
    const id = await done(ALEX, 4, 30, 60); // Alex 6 / Blake 4
    await edit(ALEX, id, { who: ALEX, pct: 100 });
    expect([await bal(ALEX) - a0, await bal(BLAKE) - b0]).toEqual([10, 0]);
    expect(await compOf(id)).toMatchObject({ owner_percent: 100, user_b_points: 0 });
  });

  it("handing the chore over moves the credit, keeping the split", async () => {
    const [a0, b0] = [await bal(ALEX), await bal(BLAKE)];
    const id = await done(ALEX, 4, 30, 60); // Alex 6 / Blake 4
    await edit(ALEX, id, { who: BLAKE });
    expect(await compOf(id)).toMatchObject({ user_a_id: BLAKE, user_a_points: 6, user_b_id: ALEX, user_b_points: 4 });
    expect([await bal(ALEX) - a0, await bal(BLAKE) - b0]).toEqual([4, 6]);
  });

  it("uncheck and delete after an edit take back exactly the edited amount", async () => {
    const a0 = await bal(ALEX);
    const id = await done(ALEX, 4, 30, 100);
    await edit(ALEX, id, { who: ALEX, tax: 10 }); // 16
    await as(ALEX, `select public.uncomplete_chore($1)`, [id]);
    expect(await bal(ALEX)).toBe(a0);

    const id2 = await done(ALEX, 0, 20, 100); // 4
    await edit(ALEX, id2, { who: ALEX, minutes: 40 }); // 8
    await as(ALEX, `select public.remove_completed_chore($1)`, [id2]);
    expect(await bal(ALEX)).toBe(a0);
  });

  it("tells the other person when their balance changed, and only then", async () => {
    const id = await done(ALEX, 4, 30, 60); // Alex 6 / Blake 4
    await edit(ALEX, id, { who: ALEX, minutes: 45 }); // Blake +1
    const notes = await as(BLAKE, `select message from public.notifications where type = 'points_adjusted' and reference_id = $1`, [id]);
    expect(notes).toEqual([{ message: "Alex updated Ledger chore: your balance went up by 1 pts" }]);
    expect(await as(ALEX, `select 1 from public.notifications where type = 'points_adjusted' and reference_id = $1`, [id])).toHaveLength(0);

    const solo = await done(ALEX, 4, 30, 100);
    await edit(ALEX, solo, { who: ALEX, tax: 9 }); // only Alex's own balance changes
    expect(await as(BLAKE, `select 1 from public.notifications where type = 'points_adjusted' and reference_id = $1`, [solo])).toHaveLength(0);
  });

  it("a balance stops at 0 if the points were already spent, and reports the real change", async () => {
    const id = await done(ALEX, 0, 60, 100); // 12
    await admin(`update public.profiles set points = 5 where id = $1`, [ALEX]); // spent most of it
    const rows = await edit(ALEX, id, { who: ALEX, minutes: 30 }); // should debit 6, only 5 left
    expect(rows.find((r) => r.o_user === ALEX)).toMatchObject({ o_delta: -5 });
    expect(await bal(ALEX)).toBe(0);
    expect(await compOf(id)).toMatchObject({ user_a_points: 6 });
  });

  it("does nothing when nothing that affects points changed", async () => {
    const id = await done(ALEX, 4, 30, 60);
    const before = await compOf(id);
    expect(await edit(ALEX, id, { who: ALEX, minutes: 30, tax: 4, pct: 60 })).toEqual([]);
    expect(await compOf(id)).toEqual(before);
  });

  it("validates its inputs and will not un-assign a finished chore", async () => {
    const id = await done(ALEX, 4, 30, 100);
    await expect(edit(ALEX, id, { who: ALEX, minutes: 7 })).rejects.toThrow(/multiple of 5/);
    await expect(edit(ALEX, id, { who: ALEX, tax: 51 })).rejects.toThrow(/between 0 and 50/);
    await expect(edit(ALEX, id, { who: ALEX, pct: 55 })).rejects.toThrow(/multiple of 10/);
    await expect(as(ALEX, `select * from public.edit_completed_chore($1, 'x', null, '2026-09-18')`, [id])).rejects.toThrow(/stay assigned/);
    await expect(edit(DREW, id, { who: DREW })).rejects.toThrow(/not found/);
  });

  it("the internal calculation cannot be called directly", async () => {
    const id = await done(ALEX, 0, 30, 100);
    await expect(as(ALEX, `select * from public.reprice_completion($1, 60, 50, null, null)`, [id])).rejects.toThrow(/permission denied/);
    await expect(as(ALEX, `select public.apply_points($1, 1000, 'free points', null)`, [ALEX])).rejects.toThrow(/permission denied/);
  });

  it("a completion's split is stored, and the migration backfills older rows sensibly", async () => {
    const id = await done(ALEX, 4, 30, 70);
    expect((await compOf(id)).owner_percent).toBe(70);

    // Re-run the migration's own backfill over rows that pre-date the column.
    const sql = read("supabase/migrations/0009_dynamic_ledger.sql");
    const backfill = sql.slice(sql.indexOf("update public.chore_completions c"), sql.indexOf("alter table public.chore_completions\n  alter column"));
    await admin(`alter table public.chore_completions alter column owner_percent drop not null`);
    const legacy = async (total: number, aMin: number, aPts: number, bPts: number) => {
      const inst = await chore(ALEX, `Legacy ${Math.random()}`, 0, ALEX, "2026-09-10");
      await admin(
        `insert into public.chore_completions (instance_id, total_duration_minutes, owner_percent, user_a_id, user_a_duration, user_a_points, user_b_id, user_b_duration, user_b_points)
         values ($1, $2, null, $3, $4, $5, $6, $7, $8)`,
        [inst, total, ALEX, aMin, aPts, BLAKE, total - aMin, bPts],
      );
      return inst;
    };
    const exact = await legacy(30, 18, 6, 4); // 60% reproduces both minutes and points
    const noMinutes = await legacy(0, 0, 3, 0); // nothing logged
    const oddPoints = await legacy(20, 8, 1, 2); // points that no split reproduces: use the minutes (40%)
    await admin(backfill);
    await admin(`alter table public.chore_completions alter column owner_percent set not null`);
    expect((await compOf(exact)).owner_percent).toBe(60);
    expect((await compOf(noMinutes)).owner_percent).toBe(100);
    expect((await compOf(oddPoints)).owner_percent).toBe(40);
  });
});

describe("remove_chore_series ('Just this one' vs 'All')", () => {
  const dayFromNow = async (n: number) => (await admin(`select (current_date + $1::int)::text as d`, [n]))[0].d as string;
  const seriesOf = async (id: string) =>
    (await admin(`select parent_recurrence_id from public.chore_instances where id = $1`, [id]))[0].parent_recurrence_id as string;
  const count = async (sid: string, done?: boolean) =>
    (await admin(
      `select count(*)::int c from public.chore_instances where parent_recurrence_id = $1 ${done === undefined ? "" : done ? "and is_completed" : "and not is_completed"}`,
      [sid],
    ))[0].c as number;

  async function repeating(who: string | null = ALEX) {
    const id = await chore(ALEX, "Every week", 2, who, await dayFromNow(1));
    await as(ALEX, `select public.make_chore_recurring($1, 'weekly')`, [id]);
    return { id, sid: await seriesOf(id) };
  }

  it("removes every unfinished day, stops the series, and keeps finished days", async () => {
    const { id, sid } = await repeating();
    const finished = (await admin(`select id from public.chore_instances where parent_recurrence_id = $1 order by scheduled_date limit 1 offset 2`, [sid]))[0].id;
    await as(ALEX, `select * from public.complete_chore($1, 15, 100)`, [finished]);
    const total = await count(sid);

    const [{ removed }] = await as(ALEX, `select public.remove_chore_series($1) as removed`, [id]);
    expect(removed).toBe(total - 1);
    expect(await count(sid)).toBe(1); // just the finished day
    expect(await count(sid, true)).toBe(1);
    expect(await admin(`select 1 from public.chore_completions where instance_id = $1`, [finished])).toHaveLength(1);

    await as(ALEX, `select public.extend_recurring_chores(current_date + 400)`);
    expect(await count(sid)).toBe(1); // nothing comes back
  });

  it("'Just this one' (a normal delete) leaves the rest of the series running", async () => {
    const { id, sid } = await repeating();
    const before = await count(sid);
    expect(await as(ALEX, `delete from public.chore_instances where id = $1 returning id`, [id])).toHaveLength(1);
    expect(await count(sid)).toBe(before - 1);
  });

  it("clears the assignment notifications of the removed days", async () => {
    const { id, sid } = await repeating(BLAKE);
    expect((await as(BLAKE, `select 1 from public.notifications where type = 'chore_assigned' and reference_id in (select id from public.chore_instances where parent_recurrence_id = $1)`, [sid])).length).toBeGreaterThan(0);
    await as(ALEX, `select public.remove_chore_series($1)`, [id]);
    expect(await as(BLAKE, `select 1 from public.notifications where type = 'chore_assigned' and reference_id in ($1)`, [id])).toHaveLength(0);
  });

  it("only applies to unfinished repeating chores in your household", async () => {
    const plain = await chore(ALEX, "Not repeating", 0, ALEX, await dayFromNow(1));
    await expect(as(ALEX, `select public.remove_chore_series($1)`, [plain])).rejects.toThrow(/does not repeat/);
    const { id, sid } = await repeating();
    await expect(as(DREW, `select public.remove_chore_series($1)`, [id])).rejects.toThrow(/not found/);
    await as(ALEX, `select * from public.complete_chore($1, 5, 100)`, [id]);
    await expect(as(ALEX, `select public.remove_chore_series($1)`, [id])).rejects.toThrow(/finished chore/);
    expect(await count(sid)).toBeGreaterThan(1);
    await expect(asAnon(`select public.remove_chore_series(gen_random_uuid())`)).rejects.toThrow(/permission denied/);
  });
});

describe("challenge controls", () => {
  const bal = async (uid: string) => (await admin(`select points from public.profiles where id = $1`, [uid]))[0].points as number;
  const row = async (id: string) => (await admin(`select * from public.challenges where id = $1`, [id]))[0];
  const make = async (creator: string, who: string, target = 3, reward = 20, title = "Gym") =>
    (await as(creator, `select * from public.create_challenge($1, $2, $3, $4)`, [title, who, target, reward]))[0].id as string;
  const setP = (user: string, id: string, n: number) => as(user, `select * from public.set_challenge_progress($1, $2)`, [id, n]);
  const upd = (user: string, id: string, a: { title?: string; target?: number; reward?: number; who: string }) =>
    as(user, `select * from public.update_challenge($1, $2, $3, $4, $5)`, [id, a.title ?? "Gym", a.target ?? 3, a.reward ?? 20, a.who]);
  const notes = (uid: string, id: string, type: string) =>
    as(uid, `select message from public.notifications where reference_id = $1 and type = $2`, [id, type]);

  it("progress can go up (for the person it is for) and down (for either partner)", async () => {
    const id = await make(ALEX, ALEX, 5);
    expect((await setP(ALEX, id, 3))[0]).toMatchObject({ current_count: 3, status: "active" });
    expect((await setP(BLAKE, id, 2))[0]).toMatchObject({ current_count: 2 }); // partner can correct downwards
    await expect(setP(BLAKE, id, 4)).rejects.toThrow(/Only the person/);
    await expect(setP(ALEX, id, 6)).rejects.toThrow(/between 0 and 5/);
    await expect(setP(ALEX, id, -1)).rejects.toThrow(/between 0 and 5/);
    await expect(setP(DREW, id, 1)).rejects.toThrow(/not found/);
  });

  it("only running challenges have progress", async () => {
    const pending = await make(ALEX, BLAKE);
    await expect(setP(BLAKE, pending, 1)).rejects.toThrow(/not running/);
  });

  it("reaching the target completes it and pays once; lowering it reopens it and takes the reward back", async () => {
    const a0 = await bal(ALEX);
    const id = await make(ALEX, ALEX, 3, 20);
    expect((await setP(ALEX, id, 3))[0]).toMatchObject({ current_count: 3, status: "completed" });
    expect((await row(id)).completed_at).not.toBeNull();
    expect(await bal(ALEX)).toBe(a0 + 20);

    const reopened = (await setP(ALEX, id, 2))[0]; // the "undo" / "-" on a completed challenge
    expect(reopened).toMatchObject({ current_count: 2, status: "active", completed_at: null });
    expect(await bal(ALEX)).toBe(a0);

    await setP(ALEX, id, 3); // finishing again pays again, once
    expect(await bal(ALEX)).toBe(a0 + 20);
    expect((await setP(ALEX, id, 3))[0].status).toBe("completed"); // no double pay for a no-op
    expect(await bal(ALEX)).toBe(a0 + 20);
  });

  it("the partner can undo it, and is told what happened to the balance", async () => {
    const id = await make(ALEX, ALEX, 2, 15);
    await setP(ALEX, id, 2);
    const b = await bal(ALEX);
    await setP(BLAKE, id, 1);
    expect(await bal(ALEX)).toBe(b - 15);
    expect(await notes(ALEX, id, "points_adjusted")).toEqual([{ message: 'Blake reopened "Gym": your balance went down by 15 pts' }]);
  });

  it("taking the reward back stops at 0 if it was already spent", async () => {
    const id = await make(ALEX, ALEX, 1, 30);
    await setP(ALEX, id, 1);
    await admin(`update public.profiles set points = 10 where id = $1`, [ALEX]);
    await setP(ALEX, id, 0);
    expect(await bal(ALEX)).toBe(0);
  });

  it("edits the name, target and reward of a running challenge", async () => {
    const id = await make(ALEX, ALEX, 5, 20);
    await setP(ALEX, id, 2);
    expect((await upd(BLAKE, id, { title: "  Gym time ", target: 8, reward: 40, who: ALEX }))[0]).toMatchObject({
      title: "Gym time", target_count: 8, reward_points: 40, current_count: 2, status: "active",
    });
    await expect(upd(ALEX, id, { target: 1, who: ALEX })).rejects.toThrow(/Progress is already 2/);
    await expect(upd(ALEX, id, { title: " ", who: ALEX })).rejects.toThrow(/name/);
    await expect(upd(ALEX, id, { reward: 501, who: ALEX })).rejects.toThrow(/between 1 and 500/);
    await expect(upd(ALEX, id, { who: DREW })).rejects.toThrow(/not in your household/);
    await expect(upd(DREW, id, { who: DREW })).rejects.toThrow(/not found/);
  });

  it("lowering the target to the current progress finishes it and pays", async () => {
    const a0 = await bal(ALEX);
    const id = await make(ALEX, ALEX, 5, 25);
    await setP(ALEX, id, 3);
    expect((await upd(ALEX, id, { target: 3, reward: 25, who: ALEX }))[0].status).toBe("completed");
    expect(await bal(ALEX)).toBe(a0 + 25);
  });

  it("reassigning keeps the progress, makes the new person accept it, and notifies them", async () => {
    const id = await make(ALEX, ALEX, 5);
    await setP(ALEX, id, 2);
    const moved = (await upd(ALEX, id, { who: BLAKE, target: 5 }))[0];
    expect(moved).toMatchObject({ assigned_to: BLAKE, creator_id: ALEX, status: "pending", current_count: 2 });
    expect(await notes(BLAKE, id, "challenge_proposed")).toHaveLength(1);
    await as(BLAKE, `select * from public.respond_to_challenge($1, true)`, [id]);
    expect((await row(id)).status).toBe("active");

    // ...and back to the other person straight from their side: it becomes theirs at once.
    const back = (await upd(BLAKE, id, { who: BLAKE, target: 5 }))[0];
    expect(back.status).toBe("active");
    const again = (await upd(BLAKE, id, { who: ALEX, target: 5 }))[0];
    expect(again).toMatchObject({ assigned_to: ALEX, creator_id: BLAKE, status: "pending" });
    expect(await notes(BLAKE, id, "challenge_proposed")).toHaveLength(0); // the stale request is gone
  });

  it("a declined challenge can be handed straight to yourself", async () => {
    const id = await make(ALEX, BLAKE);
    await as(BLAKE, `select * from public.respond_to_challenge($1, false)`, [id]);
    expect((await row(id)).status).toBe("rejected");
    expect((await upd(ALEX, id, { who: ALEX }))[0]).toMatchObject({ status: "active", assigned_to: ALEX });
  });

  it("a completed challenge: changing the reward or the person adjusts balances; the target is locked", async () => {
    const [a0, b0] = [await bal(ALEX), await bal(BLAKE)];
    const id = await make(ALEX, ALEX, 2, 20);
    await setP(ALEX, id, 2);
    expect(await bal(ALEX)).toBe(a0 + 20);

    await upd(ALEX, id, { target: 2, reward: 35, who: ALEX }); // +15
    expect(await bal(ALEX)).toBe(a0 + 35);
    await expect(upd(ALEX, id, { target: 3, reward: 35, who: ALEX })).rejects.toThrow(/Reduce the progress first/);

    await upd(ALEX, id, { target: 2, reward: 35, who: BLAKE }); // the payout moves with it
    expect(await bal(ALEX)).toBe(a0);
    expect(await bal(BLAKE)).toBe(b0 + 35);
    expect((await row(id)).status).toBe("completed");
    expect((await notes(BLAKE, id, "points_adjusted")).length).toBeGreaterThan(0);
  });

  it("deleting removes it, and a completed one has its reward taken back", async () => {
    const a0 = await bal(ALEX);
    const running = await make(ALEX, ALEX, 4, 20);
    expect((await as(ALEX, `select public.delete_challenge($1) as taken`, [running]))[0].taken).toBe(0);
    expect(await admin(`select 1 from public.challenges where id = $1`, [running])).toHaveLength(0);
    expect(await bal(ALEX)).toBe(a0);

    const finished = await make(ALEX, ALEX, 1, 30);
    await setP(ALEX, finished, 1);
    expect(await bal(ALEX)).toBe(a0 + 30);
    expect((await as(BLAKE, `select public.delete_challenge($1) as taken`, [finished]))[0].taken).toBe(30); // either partner may
    expect(await bal(ALEX)).toBe(a0);
    expect(await notes(ALEX, finished, "points_adjusted")).toEqual([{ message: 'Blake deleted "Gym": your balance went down by 30 pts' }]);
  });

  it("delete also clears its proposal notifications, and other households cannot touch it", async () => {
    const id = await make(ALEX, BLAKE);
    expect(await notes(BLAKE, id, "challenge_proposed")).toHaveLength(1);
    await expect(as(DREW, `select public.delete_challenge($1)`, [id])).rejects.toThrow(/not found/);
    await as(ALEX, `select public.delete_challenge($1)`, [id]);
    expect(await notes(BLAKE, id, "challenge_proposed")).toHaveLength(0);
    await expect(as(ALEX, `select public.delete_challenge($1)`, [id])).rejects.toThrow(/not found/);
  });

  it("the new functions are closed to anonymous callers and helpers are internal", async () => {
    await expect(asAnon(`select * from public.set_challenge_progress(gen_random_uuid(), 1)`)).rejects.toThrow(/permission denied/);
    await expect(asAnon(`select * from public.update_challenge(gen_random_uuid(), 'x', 1, 1, gen_random_uuid())`)).rejects.toThrow(/permission denied/);
    await expect(asAnon(`select public.delete_challenge(gen_random_uuid())`)).rejects.toThrow(/permission denied/);
    await expect(as(ALEX, `select public.notify_points_adjusted($1, $1, null, 'x', 5)`, [BLAKE])).rejects.toThrow(/permission denied/);
  });
});

// ===========================================================================
// 0011 - the point ledger
// ===========================================================================
describe("point ledger", () => {
  const bal = async (uid: string) => (await admin(`select points from public.profiles where id = $1`, [uid]))[0].points as number;
  /** A marker for "rows written after this point": the newest sequence number so far. */
  const now = async () => (await admin(`select coalesce(max(seq), 0)::int as s from public.point_ledger`))[0].s as number;
  const rows = (uid: string, since: number) =>
    admin<{ delta: number; balance_after: number; reason: string; reference_id: string | null }>(
      `select delta, balance_after, reason, reference_id from public.point_ledger where profile_id = $1 and seq > $2 order by seq`,
      [uid, since],
    );
  /** Every row's balance_after follows from the one before it, and the last one is the real balance. */
  async function expectChain(uid: string, since: number, startBalance: number) {
    const r = await rows(uid, since);
    let running = startBalance;
    for (const row of r) {
      running += row.delta;
      expect(row.balance_after).toBe(running);
    }
    expect(running).toBe(await bal(uid));
    return r;
  }

  it("records each balance change with who, how much, the balance after, why and what it relates to", async () => {
    const t0 = await now();
    const a0 = await bal(ALEX);
    const id = await chore(ALEX, "Ledgered", 4, ALEX, "2026-09-10"); // 30 min = 6 + 4
    const [c] = await as(ALEX, `select * from public.complete_chore($1, 30, 100)`, [id]);
    const r = await expectChain(ALEX, t0, a0);
    expect(r).toEqual([{ delta: 10, balance_after: a0 + 10, reason: "Chore completed: Ledgered", reference_id: c.id }]);
  });

  it("keeps an unbroken chain through completing, editing, unchecking and deleting", async () => {
    const [a0, b0] = [await bal(ALEX), await bal(BLAKE)];
    const t0 = await now();
    const id = await chore(ALEX, "Chain", 4, ALEX, "2026-09-10");
    await as(ALEX, `select * from public.complete_chore($1, 30, 60)`, [id]); // Alex 6 / Blake 4
    await as(ALEX, `select * from public.edit_completed_chore($1, 'Chain', $2, '2026-09-10', 45, null, null)`, [id, ALEX]); // 13: 8 / 5
    await as(ALEX, `select public.uncomplete_chore($1)`, [id]);
    const id2 = await chore(ALEX, "Chain 2", 0, ALEX, "2026-09-10");
    await as(ALEX, `select * from public.complete_chore($1, 20, 100)`, [id2]);
    await as(ALEX, `select public.remove_completed_chore($1)`, [id2]);
    const ra = await expectChain(ALEX, t0, a0);
    await expectChain(BLAKE, t0, b0);
    expect(ra.map((x) => x.reason)).toEqual([
      "Chore completed: Chain", "Chore edited: Chain", "Chore unchecked: Chain", "Chore completed: Chain 2", "Chore deleted: Chain 2",
    ]);
    expect(await bal(ALEX)).toBe(a0);
  });

  it("logs redeeming a reward against the reward, and refuses when the balance is short", async () => {
    await admin(`update public.profiles set points = 100 where id = $1`, [ALEX]);
    const t0 = await now();
    const [reward] = await as(ALEX, `select id, title, cost from public.rewards where is_active order by cost limit 1`);
    await as(ALEX, `select * from public.redeem_reward($1)`, [reward.id]);
    const r = await expectChain(ALEX, t0, 100);
    expect(r).toEqual([{ delta: -reward.cost, balance_after: 100 - reward.cost, reason: `Reward redeemed: ${reward.title}`, reference_id: reward.id }]);
    await admin(`update public.profiles set points = 0 where id = $1`, [ALEX]);
    await expect(as(ALEX, `select * from public.redeem_reward($1)`, [reward.id])).rejects.toThrow(/Not enough points/);
  });

  it("a debit that hits the floor records the REAL change, so the chain still adds up", async () => {
    const id = await chore(ALEX, "Floor", 0, ALEX, "2026-09-10");
    await as(ALEX, `select * from public.complete_chore($1, 60, 100)`, [id]); // +12
    await admin(`update public.profiles set points = 5 where id = $1`, [ALEX]);
    const t0 = await now();
    await as(ALEX, `select public.uncomplete_chore($1)`, [id]); // would take 12, only 5 left
    const r = await expectChain(ALEX, t0, 5);
    expect(r).toEqual([expect.objectContaining({ delta: -5, balance_after: 0 })]);
  });

  it("partners can read the household's ledger; nobody can read another household's or write to it", async () => {
    const id = await chore(ALEX, "Visible", 0, ALEX, "2026-09-10");
    await as(ALEX, `select * from public.complete_chore($1, 10, 100)`, [id]);
    const seenByBlake = await as(BLAKE, `select profile_id, reason from public.point_ledger where reason = 'Chore completed: Visible'`);
    expect(seenByBlake).toEqual([{ profile_id: ALEX, reason: "Chore completed: Visible" }]);
    expect(await as(DREW, `select 1 from public.point_ledger where reason = 'Chore completed: Visible'`)).toHaveLength(0);
    await expect(as(ALEX, `insert into public.point_ledger (profile_id, delta, balance_after, reason) values ($1, 999, 999, 'x')`, [ALEX])).rejects.toThrow(/permission denied/);
    await expect(as(ALEX, `update public.point_ledger set delta = 0`)).rejects.toThrow(/permission denied/);
    await expect(as(ALEX, `delete from public.point_ledger`)).rejects.toThrow(/permission denied/);
    await expect(asAnon(`select * from public.point_ledger`)).rejects.toThrow(/permission denied/);
  });

  it("gives balances that already existed an opening row (the migration's own backfill)", async () => {
    await admin(`delete from public.point_ledger where profile_id = $1`, [DREW]);
    await admin(`update public.profiles set points = 42 where id = $1`, [DREW]);
    const sql = read("supabase/migrations/0011_point_ledger.sql");
    const backfill = sql.slice(sql.indexOf("insert into public.point_ledger (profile_id, delta, balance_after, reason)\nselect"), sql.indexOf("-- ---", sql.indexOf("insert into public.point_ledger (profile_id, delta")));
    await admin(backfill.replace(/;\s*$/, "") + " on conflict do nothing");
    const drew = await admin(`select delta, balance_after, reason from public.point_ledger where profile_id = $1`, [DREW]);
    expect(drew).toEqual([{ delta: 42, balance_after: 42, reason: "Opening balance (before the ledger)" }]);
  });

  it("the balance helper is internal", async () => {
    await expect(as(ALEX, `select public.apply_points($1, 5, 'x', null)`, [ALEX])).rejects.toThrow(/permission denied/);
  });
});

// ===========================================================================
// 0012 - fixed-bounty chores
// ===========================================================================
describe("fixed-bounty chores", () => {
  const bal = async (uid: string) => (await admin(`select points from public.profiles where id = $1`, [uid]))[0].points as number;
  const dayFromNow = async (n: number) => (await admin(`select (current_date + $1::int)::text as d`, [n]))[0].d as string;

  /** A scheduled mission: fixed bounty, with an estimate that must play no part in the points. */
  async function mission(user: string, title: string, bounty: number, who: string | null = user, date = "2026-09-10", tax = 0) {
    const [row] = await as(
      user,
      `insert into public.chore_instances (title, household_id, assigned_to, scheduled_date, estimated_duration, chore_tax, pricing_type, fixed_bounty_points)
       values ($1, public.current_household_id(), $2, $3, 15, $4, 'fixed_bounty', $5) returning id`,
      [title, who, date, tax, bounty],
    );
    return row.id as string;
  }
  const comp = async (id: string) => (await admin(`select * from public.chore_completions where instance_id = $1`, [id]))[0];

  it("pays the bounty whatever the time logged, and still records the minutes for Stats", async () => {
    const a0 = await bal(ALEX);
    const id = await mission(ALEX, "Video editing", 25);
    const [c] = await as(ALEX, `select * from public.complete_chore($1, 180, 100)`, [id]); // three hours
    expect(c).toMatchObject({ total_duration_minutes: 180, user_a_duration: 180, user_a_points: 25, user_b_points: 0 });
    expect(await bal(ALEX)).toBe(a0 + 25);
    const id2 = await mission(ALEX, "Video editing 2", 25);
    const [c2] = await as(ALEX, `select * from public.complete_chore($1, 5, 100)`, [id2]); // five minutes
    expect(c2.user_a_points).toBe(25);
  });

  it("matches the spec's worked example: 45 min, 20 pts, 70/30 -> 32 min / 14 pts and 13 min / 6 pts", async () => {
    const [a0, b0] = [await bal(ALEX), await bal(BLAKE)];
    const id = await mission(ALEX, "Video Editing", 20);
    const [c] = await as(ALEX, `select * from public.complete_chore($1, 45, 70)`, [id]);
    expect(c).toMatchObject({ user_a_duration: 32, user_a_points: 14, user_b_duration: 13, user_b_points: 6, total_duration_minutes: 45, owner_percent: 70 });
    expect([await bal(ALEX) - a0, await bal(BLAKE) - b0]).toEqual([14, 6]);
  });

  it("splits exactly for every bounty and share, and ignores any chore tax on a mission", async () => {
    for (const bounty of [1, 7, 15, 25, 99]) {
      for (const pct of [0, 10, 30, 50, 70, 100]) {
        const id = await mission(ALEX, `Sum ${bounty}/${pct}`, bounty, ALEX, "2026-09-10", 9); // tax 9 must not count
        const [c] = await as(ALEX, `select * from public.complete_chore($1, 35, $2)`, [id, pct]);
        expect(c.user_a_points + c.user_b_points).toBe(bounty);
        expect(c.user_a_points).toBe(Math.round((bounty * pct) / 100));
        expect(c.user_a_duration + c.user_b_duration).toBe(35);
      }
    }
  });

  it("still validates the logged time and the split", async () => {
    const id = await mission(ALEX, "Validate mission", 20);
    await expect(as(ALEX, `select * from public.complete_chore($1, 7, 100)`, [id])).rejects.toThrow(/multiple of 5/);
    await expect(as(ALEX, `select * from public.complete_chore($1, 30, 55)`, [id])).rejects.toThrow(/multiple of 10/);
  });

  it("rejects an out-of-range bounty", async () => {
    await expect(mission(ALEX, "Zero", 0)).rejects.toThrow(/check constraint/);
    await expect(mission(ALEX, "Huge", 501)).rejects.toThrow(/check constraint/);
  });

  it("re-pricing a finished mission: time changes only redistribute minutes; a bounty change moves the balance", async () => {
    const [a0, b0] = [await bal(ALEX), await bal(BLAKE)];
    const id = await mission(ALEX, "Reprice mission", 20);
    await as(ALEX, `select * from public.complete_chore($1, 45, 70)`, [id]); // 14 / 6
    const timeOnly = await as(ALEX, `select * from public.edit_completed_chore($1, 'Reprice mission', $2, '2026-09-10', 90, null, null, null)`, [id, ALEX]);
    expect(timeOnly.every((r) => r.o_delta === 0)).toBe(true); // re-priced, but nobody's balance moves
    expect(await comp(id)).toMatchObject({ total_duration_minutes: 90, user_a_points: 14, user_b_points: 6, user_a_duration: 63 });

    const rows = await as(ALEX, `select * from public.edit_completed_chore($1, 'Reprice mission', $2, '2026-09-10', null, null, null, 30)`, [id, ALEX]);
    expect(Object.fromEntries(rows.map((r) => [r.o_user, r.o_delta]))).toEqual({ [ALEX]: 7, [BLAKE]: 3 }); // 30 -> 21 / 9
    expect(await comp(id)).toMatchObject({ user_a_points: 21, user_b_points: 9 });
    expect([await bal(ALEX) - a0, await bal(BLAKE) - b0]).toEqual([21, 9]);
    expect((await admin(`select fixed_bounty_points from public.chore_instances where id = $1`, [id]))[0].fixed_bounty_points).toBe(30);
  });

  it("the wrong kind of value never re-prices: a tax on a mission and a bounty on a time-based chore are ignored", async () => {
    const m = await mission(ALEX, "Ignore tax", 20);
    await as(ALEX, `select * from public.complete_chore($1, 30, 100)`, [m]);
    expect(await as(ALEX, `select * from public.edit_completed_chore($1, 'Ignore tax', $2, '2026-09-10', null, 50, null, null)`, [m, ALEX])).toEqual([]);
    expect((await comp(m)).user_a_points).toBe(20);

    const t = await chore(ALEX, "Ignore bounty", 4, ALEX, "2026-09-10"); // 30 min = 6 + 4
    await as(ALEX, `select * from public.complete_chore($1, 30, 100)`, [t]);
    expect(await as(ALEX, `select * from public.edit_completed_chore($1, 'Ignore bounty', $2, '2026-09-10', null, null, null, 400)`, [t, ALEX])).toEqual([]);
    expect((await comp(t)).user_a_points).toBe(10);
  });

  it("the library remembers the model; a mission has no chore tax", async () => {
    const [row] = await as(ALEX, `select * from public.create_library_chore('Detail the car', 'Car', 60, 9, 'fixed_bounty', 40)`);
    expect(row).toMatchObject({ pricing_type: "fixed_bounty", fixed_bounty_points: 40, chore_tax: 0, default_duration: 60 });
    const [plain] = await as(ALEX, `select * from public.create_library_chore('Plain new', 'Car', 15, 3)`);
    expect(plain).toMatchObject({ pricing_type: "time_based", fixed_bounty_points: 15, chore_tax: 3 });
    await expect(as(ALEX, `select * from public.create_library_chore('Bad bounty', 'x', 15, 0, 'fixed_bounty', 0)`)).rejects.toThrow(/between 1 and 500/);
  });

  it("a library bounty change reaches unfinished copies and re-prices finished missions, leaving time-based history alone", async () => {
    const [lib] = await as(ALEX, `select * from public.create_library_chore('Bounty push', 'x', 15, 0, 'fixed_bounty', 20)`);
    const copy = async (date: string) =>
      (await as(ALEX, `insert into public.chore_instances (chore_id, title, household_id, assigned_to, scheduled_date, pricing_type, fixed_bounty_points)
                       values ($1, 'Bounty push', public.current_household_id(), $2, $3, 'fixed_bounty', 20) returning id`, [lib.id, ALEX, date]))[0].id as string;
    const open = await copy(await dayFromNow(3));
    const finished = await copy("2026-09-10");
    await as(ALEX, `select * from public.complete_chore($1, 30, 100)`, [finished]); // 20
    // A time-based finished copy of the same library chore (history from before it became a mission).
    const oldStyle = (await as(ALEX, `insert into public.chore_instances (chore_id, title, household_id, assigned_to, scheduled_date, estimated_duration, chore_tax, pricing_type)
                                      values ($1, 'Bounty push', public.current_household_id(), $2, '2026-09-09', 15, 2, 'time_based') returning id`, [lib.id, ALEX]))[0].id as string;
    await as(ALEX, `select * from public.complete_chore($1, 30, 100)`, [oldStyle]); // 6 + 2
    const a0 = await bal(ALEX);

    const [r] = await as(ALEX, `select * from public.update_library_chore($1, 'Bounty push', 'x', 15, 0, true, null, 35)`, [lib.id]);
    expect(r).toMatchObject({ n_open: 1, n_done: 1, my_delta: 15 });
    expect((await admin(`select fixed_bounty_points p from public.chore_instances where id = $1`, [open]))[0].p).toBe(35);
    expect((await comp(finished)).user_a_points).toBe(35);
    expect((await comp(oldStyle)).user_a_points).toBe(8); // untouched
    expect(await bal(ALEX)).toBe(a0 + 15);
  });

  it("switching a library chore's model changes what is planned, never what was paid", async () => {
    const [lib] = await as(ALEX, `select * from public.create_library_chore('Switch model', 'x', 30, 4)`); // time-based
    const inst = async (date: string) =>
      (await as(ALEX, `insert into public.chore_instances (chore_id, title, household_id, assigned_to, scheduled_date, estimated_duration, chore_tax)
                       values ($1, 'Switch model', public.current_household_id(), $2, $3, 30, 4) returning id`, [lib.id, ALEX, date]))[0].id as string;
    const open = await inst(await dayFromNow(2));
    const finished = await inst("2026-09-10");
    await as(ALEX, `select * from public.complete_chore($1, 30, 100)`, [finished]); // 6 + 4
    const a0 = await bal(ALEX);

    const [r] = await as(ALEX, `select * from public.update_library_chore($1, 'Switch model', 'x', 30, 4, true, 'fixed_bounty', 50)`, [lib.id]);
    expect(r).toMatchObject({ n_open: 1, n_done: 0, my_delta: 0 });
    expect((await admin(`select pricing_type, fixed_bounty_points from public.chore_instances where id = $1`, [open]))[0]).toEqual({ pricing_type: "fixed_bounty", fixed_bounty_points: 50 });
    expect((await admin(`select pricing_type from public.chore_instances where id = $1`, [finished]))[0].pricing_type).toBe("time_based");
    expect((await comp(finished)).user_a_points).toBe(10);
    expect(await bal(ALEX)).toBe(a0);
  });

  it("can leave finished missions alone when told not to re-price", async () => {
    const [lib] = await as(ALEX, `select * from public.create_library_chore('No reprice', 'x', 15, 0, 'fixed_bounty', 20)`);
    const id = (await as(ALEX, `insert into public.chore_instances (chore_id, title, household_id, assigned_to, scheduled_date, pricing_type, fixed_bounty_points)
                                values ($1, 'No reprice', public.current_household_id(), $2, '2026-09-10', 'fixed_bounty', 20) returning id`, [lib.id, ALEX]))[0].id as string;
    await as(ALEX, `select * from public.complete_chore($1, 30, 100)`, [id]);
    const [r] = await as(ALEX, `select * from public.update_library_chore($1, 'No reprice', 'x', 15, 0, false, null, 60)`, [lib.id]);
    expect(r).toMatchObject({ n_done: 0, my_delta: 0 });
    expect((await comp(id)).user_a_points).toBe(20);
  });

  it("repeating missions keep their bounty on every generated day, and this-and-future can change it", async () => {
    const start = await dayFromNow(1);
    const id = await mission(ALEX, "Weekly mission", 25, ALEX, start);
    await as(ALEX, `select public.make_chore_recurring($1, 'weekly')`, [id]);
    const sid = (await admin(`select parent_recurrence_id from public.chore_instances where id = $1`, [id]))[0].parent_recurrence_id;
    const shape = () => admin(`select distinct pricing_type::text p, fixed_bounty_points b from public.chore_instances where parent_recurrence_id = $1`, [sid]);
    expect(await shape()).toEqual([{ p: "fixed_bounty", b: 25 }]);

    await as(ALEX, `select public.extend_recurring_chores(current_date + 300)`); // generated later on
    expect(await shape()).toEqual([{ p: "fixed_bounty", b: 25 }]);

    await as(ALEX, `select public.update_chore_series($1, 'Weekly mission', 15, 0, $2, 'weekly', 'fixed_bounty', 40)`, [id, ALEX]);
    expect(await shape()).toEqual([{ p: "fixed_bounty", b: 40 }]);
    await as(ALEX, `select public.extend_recurring_chores(current_date + 500)`);
    expect(await shape()).toEqual([{ p: "fixed_bounty", b: 40 }]);
  });

  it("an old-style series call (no pricing) keeps the series' model", async () => {
    const id = await mission(ALEX, "Keep model", 25, ALEX, await dayFromNow(1));
    await as(ALEX, `select public.make_chore_recurring($1, 'weekly')`, [id]);
    await as(ALEX, `select public.update_chore_series($1, 'Keep model 2', 15, 0, $2, 'weekly')`, [id, ALEX]);
    const sid = (await admin(`select parent_recurrence_id from public.chore_instances where id = $1`, [id]))[0].parent_recurrence_id;
    expect(await admin(`select distinct pricing_type::text p, fixed_bounty_points b, title from public.chore_instances where parent_recurrence_id = $1`, [sid])).toEqual([{ p: "fixed_bounty", b: 25, title: "Keep model 2" }]);
  });

  it("uncheck takes back exactly a mission's bounty", async () => {
    const a0 = await bal(ALEX);
    const id = await mission(ALEX, "Undo mission", 33);
    await as(ALEX, `select * from public.complete_chore($1, 60, 100)`, [id]);
    await as(ALEX, `select public.uncomplete_chore($1)`, [id]);
    expect(await bal(ALEX)).toBe(a0);
  });
});

// ===========================================================================
// 0013 - joint and forfeit challenges, and settlement of deadlines
// ===========================================================================
describe("joint challenges", () => {
  const bal = async (uid: string) => (await admin(`select points from public.profiles where id = $1`, [uid]))[0].points as number;
  const row = async (id: string) => (await admin(`select * from public.challenges where id = $1`, [id]))[0];
  const joint = async (creator: string, target = 3, reward = 20, title = "Walk together", deadline: string | null = null) =>
    (await as(creator, `select * from public.create_challenge($1, $2, $3, $4, 'reward', true, $5, 0)`, [title, creator, target, reward, deadline]))[0].id as string;
  const tap = (user: string, id: string) => as(user, `select * from public.increment_challenge($1)`, [id]);
  const setP = (user: string, id: string, n: number) => as(user, `select * from public.set_challenge_progress($1, $2)`, [id, n]);
  const notes = (uid: string, id: string, type: string) =>
    as(uid, `select message from public.notifications where reference_id = $1 and type = $2`, [id, type]);

  it("starts active for both partners at once, with no acceptance step, and tells the partner", async () => {
    const id = await joint(ALEX);
    expect(await row(id)).toMatchObject({ is_joint: true, status: "active", type: "reward", assigned_to: ALEX, creator_id: ALEX, completed_by_a_count: 0, completed_by_b_count: 0 });
    expect(await as(BLAKE, `select 1 from public.challenges where id = $1`, [id])).toHaveLength(1);
    expect(await notes(BLAKE, id, "challenge_proposed")).toEqual([{ message: "Alex started a joint challenge with you: Walk together" }]);
    await expect(as(BLAKE, `select * from public.respond_to_challenge($1, true)`, [id])).rejects.toThrow(/No pending challenge/); // nothing to accept
  });

  it("needs a partner", async () => {
    await expect(as(DREW, `select * from public.create_challenge('Solo joint', $1, 3, 20, 'reward', true, null, 0)`, [DREW])).rejects.toThrow(/Invite your partner/);
  });

  it("either partner can log a repetition, and each one's contribution is tracked", async () => {
    const id = await joint(ALEX, 5);
    await tap(ALEX, id); await tap(BLAKE, id); await tap(BLAKE, id);
    expect(await row(id)).toMatchObject({ current_count: 3, completed_by_a_count: 1, completed_by_b_count: 2, status: "active" });
    await expect(as(DREW, `select * from public.increment_challenge($1)`, [id])).rejects.toThrow(/not active for you/);
  });

  it("completing pays each partner round(reward / 2), through the ledger, and tells the partner", async () => {
    const [a0, b0] = [await bal(ALEX), await bal(BLAKE)];
    const id = await joint(ALEX, 2, 15); // odd reward: 15 -> 8 each (the spec's round(reward/2))
    await tap(ALEX, id);
    const done = (await tap(BLAKE, id))[0];
    expect(done).toMatchObject({ status: "completed", current_count: 2, completed_by_a_count: 1, completed_by_b_count: 1 });
    expect([await bal(ALEX) - a0, await bal(BLAKE) - b0]).toEqual([8, 8]);
    const ledger = await admin(`select profile_id, delta, reason from public.point_ledger where reference_id = $1 order by seq`, [id]);
    expect(ledger).toEqual([
      { profile_id: ALEX, delta: 8, reason: "Challenge completed: Walk together" },
      { profile_id: BLAKE, delta: 8, reason: "Challenge completed: Walk together" },
    ].sort((x, y) => ledger.findIndex((l) => l.profile_id === x.profile_id) - ledger.findIndex((l) => l.profile_id === y.profile_id)));
    expect(await notes(ALEX, id, "challenge_completed")).toEqual([{ message: "Blake finished your joint challenge: Walk together - you each earn 8 pts" }]);
    expect(await notes(BLAKE, id, "challenge_completed")).toHaveLength(0); // the one who finished it is not told about their own tap
  });

  it("an even reward splits exactly in half", async () => {
    const [a0, b0] = [await bal(ALEX), await bal(BLAKE)];
    const id = await joint(BLAKE, 1, 20);
    await tap(BLAKE, id);
    expect([await bal(ALEX) - a0, await bal(BLAKE) - b0]).toEqual([10, 10]);
  });

  it("the - button takes progress off the person pressing it first, then their partner, and reopening takes both halves back", async () => {
    const [a0, b0] = [await bal(ALEX), await bal(BLAKE)];
    const id = await joint(ALEX, 3, 20);
    await tap(ALEX, id); await tap(ALEX, id); await tap(BLAKE, id); // a=2, b=1 -> done
    expect(await row(id)).toMatchObject({ status: "completed", completed_by_a_count: 2, completed_by_b_count: 1 });
    expect([await bal(ALEX) - a0, await bal(BLAKE) - b0]).toEqual([10, 10]);

    const reopened = (await setP(BLAKE, id, 2))[0]; // Blake presses -
    expect(reopened).toMatchObject({ status: "active", current_count: 2, completed_by_a_count: 2, completed_by_b_count: 0, completed_at: null });
    expect([await bal(ALEX) - a0, await bal(BLAKE) - b0]).toEqual([0, 0]);

    const lower = (await setP(BLAKE, id, 1))[0]; // Blake has nothing left of their own: comes off Alex's
    expect(lower).toMatchObject({ current_count: 1, completed_by_a_count: 1, completed_by_b_count: 0 });
    const reset = (await setP(ALEX, id, 0))[0];
    expect(reset).toMatchObject({ current_count: 0, completed_by_a_count: 0, completed_by_b_count: 0 });
  });

  it("either partner can add progress with the set function on a joint challenge, and a finished one is not paid twice", async () => {
    const a0 = await bal(ALEX);
    const id = await joint(ALEX, 2, 20);
    await setP(BLAKE, id, 1);
    expect(await row(id)).toMatchObject({ completed_by_b_count: 1, completed_by_a_count: 0 });
    await setP(BLAKE, id, 2);
    expect(await bal(ALEX)).toBe(a0 + 10);
    await setP(ALEX, id, 2); // already done: no change
    expect(await bal(ALEX)).toBe(a0 + 10);
  });

  it("a joint challenge cannot be handed to one person; changing the reward adjusts both by the difference in halves", async () => {
    const [a0, b0] = [await bal(ALEX), await bal(BLAKE)];
    const id = await joint(ALEX, 1, 20);
    await tap(ALEX, id);
    await expect(as(ALEX, `select * from public.update_challenge($1, 'x', 1, 20, $2)`, [id, BLAKE])).rejects.toThrow(/belongs to both/);
    await as(BLAKE, `select * from public.update_challenge($1, 'Walk together', 1, 30, $2)`, [id, ALEX]); // 10 each -> 15 each
    expect([await bal(ALEX) - a0, await bal(BLAKE) - b0]).toEqual([15, 15]);
    expect(await notes(ALEX, id, "points_adjusted")).toHaveLength(1);
  });

  it("deleting a finished joint challenge takes both halves back", async () => {
    const [a0, b0] = [await bal(ALEX), await bal(BLAKE)];
    const id = await joint(ALEX, 1, 20);
    await tap(ALEX, id);
    expect((await as(BLAKE, `select public.delete_challenge($1) as taken`, [id]))[0].taken).toBe(20);
    expect([await bal(ALEX) - a0, await bal(BLAKE) - b0]).toEqual([0, 0]);
  });

  it("joint and forfeit cannot be combined", async () => {
    await expect(as(ALEX, `select * from public.create_challenge('x', $1, 3, 0, 'forfeit', true, current_date + 5, 10)`, [ALEX])).rejects.toThrow(/one person/);
  });
});

describe("forfeit challenges and settlement", () => {
  // Earlier tests leave expired-but-unsettled challenges behind; settle them first so each test starts clean.
  beforeEach(async () => {
    await as(ALEX, `select public.settle_my_challenges()`);
    await as(DREW, `select public.settle_my_challenges()`);
  });
  const bal = async (uid: string) => (await admin(`select points from public.profiles where id = $1`, [uid]))[0].points as number;
  const setBal = (uid: string, n: number) => admin(`update public.profiles set points = $2 where id = $1`, [uid, n]);
  const row = async (id: string) => (await admin(`select * from public.challenges where id = $1`, [id]))[0];
  const today = async (tz = "Europe/London") => (await admin(`select (now() at time zone $1)::date::text as d`, [tz]))[0].d as string;
  const addDays = async (d: string, n: number) => (await admin(`select ($1::date + $2::int)::text as d`, [d, n]))[0].d as string;
  const forfeit = async (creator: string, who: string, opts: { target?: number; penalty?: number; days?: number; title?: string } = {}) =>
    (await as(
      creator,
      `select * from public.create_challenge($1, $2, $3, 0, 'forfeit', false, $4::date, $5)`,
      [opts.title ?? "Wash up before bed", who, opts.target ?? 3, await addDays(await today(), opts.days ?? 3), opts.penalty ?? 10],
    ))[0].id as string;
  /** Pretend the deadline has just passed (creation refuses a deadline in the past). */
  const expire = async (id: string, daysAgo = 1, tz = "Europe/London") =>
    admin(`update public.challenges set deadline_date = ($2::date - $3::int) where id = $1`, [id, await today(tz), daysAgo]);
  const settle = (user: string) => as(user, `select public.settle_my_challenges() as n`);
  const notes = (uid: string, id: string) =>
    as(uid, `select type, message from public.notifications where reference_id = $1 and type = 'challenge_expired'`, [id]);
  const ledger = (id: string) =>
    admin(`select profile_id, delta, balance_after, reason from public.point_ledger where reference_id = $1 order by seq`, [id]);

  it("needs a deadline and a penalty, earns nothing, and the deadline cannot already have passed", async () => {
    const id = await forfeit(ALEX, ALEX);
    expect(await row(id)).toMatchObject({ type: "forfeit", reward_points: 0, penalty_points: 10, is_joint: false, status: "active" });
    await expect(as(ALEX, `select * from public.create_challenge('x', $1, 3, 0, 'forfeit', false, null, 10)`, [ALEX])).rejects.toThrow(/needs a deadline/);
    await expect(as(ALEX, `select * from public.create_challenge('x', $1, 3, 0, 'forfeit', false, current_date + 3, 0)`, [ALEX])).rejects.toThrow(/between 1 and 500/);
    await expect(as(ALEX, `select * from public.create_challenge('x', $1, 3, 0, 'forfeit', false, current_date + 3, 501)`, [ALEX])).rejects.toThrow(/between 1 and 500/);
    await expect(as(ALEX, `select * from public.create_challenge('x', $1, 3, 0, 'forfeit', false, current_date - 5, 10)`, [ALEX])).rejects.toThrow(/has not passed/);
    // a reward number sent along with a forfeit is ignored
    const [sneaky] = await as(ALEX, `select * from public.create_challenge('Sneaky', $1, 3, 400, 'forfeit', false, current_date + 3, 10)`, [ALEX]);
    expect(sneaky.reward_points).toBe(0);
  });

  it("the database refuses a forfeit without a deadline or penalty even if something writes one directly", async () => {
    const insert = (extra: string) =>
      admin(
        `insert into public.challenges (household_id, creator_id, assigned_to, title, target_count, reward_points, type, status, ${extra.split("|")[0]})
         values ((select household_id from public.profiles where id = $1), $1, $1, 'x', 3, 0, 'forfeit', 'active', ${extra.split("|")[1]})`,
        [ALEX],
      );
    await expect(insert("penalty_points|10")).rejects.toThrow(/challenges_forfeit_shape/); // no deadline
    await expect(insert("deadline_date|current_date + 3")).rejects.toThrow(/challenges_forfeit_shape/); // no penalty
    await expect(insert("deadline_date, penalty_points, is_joint|current_date + 3, 10, true")).rejects.toThrow(/challenges_forfeit_shape/); // joint
    await insert("deadline_date, penalty_points|current_date + 3, 10"); // a valid one is accepted
  });

  it("a forfeit set for your partner has to be accepted first, and says it is a forfeit", async () => {
    const id = await forfeit(ALEX, BLAKE);
    expect(await row(id)).toMatchObject({ status: "pending" });
    expect((await as(BLAKE, `select message from public.notifications where reference_id = $1 and type = 'challenge_proposed'`, [id]))[0].message)
      .toBe("Alex set a forfeit challenge for you: Wash up before bed");
    expect((await settle(ALEX))[0].n).toBeGreaterThanOrEqual(0);
    expect((await row(id)).status).toBe("pending"); // before its deadline nothing happens
    await as(BLAKE, `select * from public.respond_to_challenge($1, true)`, [id]);
    expect((await row(id)).status).toBe("active");
  });

  it("holding the line: reaching the target in time completes it with no points and no ledger entry", async () => {
    const a0 = await bal(ALEX);
    const id = await forfeit(ALEX, ALEX, { target: 2 });
    await as(ALEX, `select * from public.increment_challenge($1)`, [id]);
    expect((await as(ALEX, `select * from public.increment_challenge($1)`, [id]))[0].status).toBe("completed");
    expect(await bal(ALEX)).toBe(a0);
    expect(await ledger(id)).toEqual([]);
    await expire(id); // even once the deadline passes, a completed forfeit is left alone
    expect((await settle(ALEX))[0].n).toBe(0);
    expect((await row(id)).status).toBe("completed");
  });

  it("a partner is told when their forfeit was held", async () => {
    const id = await forfeit(ALEX, BLAKE, { target: 1 });
    await as(BLAKE, `select * from public.respond_to_challenge($1, true)`, [id]);
    await as(BLAKE, `select * from public.increment_challenge($1)`, [id]);
    expect((await as(ALEX, `select message from public.notifications where reference_id = $1 and type = 'challenge_completed'`, [id]))[0].message)
      .toBe("Blake held the line on your forfeit challenge: Wash up before bed");
  });

  it("missing the deadline docks the penalty from the assignee only, logs it, notifies them and marks it expired_penalized", async () => {
    await setBal(ALEX, 50); await setBal(BLAKE, 50);
    const id = await forfeit(ALEX, ALEX, { target: 3, penalty: 10 });
    await as(ALEX, `select * from public.increment_challenge($1)`, [id]); // 1 of 3: not enough
    await expire(id);
    expect((await settle(ALEX))[0].n).toBeGreaterThanOrEqual(1);
    expect((await row(id)).status).toBe("expired_penalized");
    expect([await bal(ALEX), await bal(BLAKE)]).toEqual([40, 50]);
    expect(await ledger(id)).toEqual([{ profile_id: ALEX, delta: -10, balance_after: 40, reason: "Missed deadline for challenge: Wash up before bed" }]);
    expect(await notes(ALEX, id)).toEqual([{ type: "challenge_expired", message: "Deadline passed: Wash up before bed. 10 points were deducted." }]);
    expect(await notes(BLAKE, id)).toHaveLength(0);
  });

  it("a forfeit your partner set for you docks YOU when missed, never the person who set it", async () => {
    await setBal(ALEX, 50); await setBal(BLAKE, 50);
    const id = await forfeit(ALEX, BLAKE, { penalty: 15 }); // Alex sets it; Blake accepts
    await as(BLAKE, `select * from public.respond_to_challenge($1, true)`, [id]);
    await expire(id);
    await settle(ALEX); // either partner opening the app settles it
    expect([await bal(ALEX), await bal(BLAKE)]).toEqual([50, 35]);
    expect((await ledger(id)).map((l) => [l.profile_id, l.delta])).toEqual([[BLAKE, -15]]);
    expect(await notes(BLAKE, id)).toHaveLength(1);
    expect(await notes(ALEX, id)).toHaveLength(0);
  });

  it("is idempotent: settling again does not dock twice", async () => {
    await setBal(ALEX, 50);
    const id = await forfeit(ALEX, ALEX, { penalty: 7 });
    await expire(id);
    await settle(ALEX);
    expect(await bal(ALEX)).toBe(43);
    expect((await settle(ALEX))[0].n).toBe(0);
    expect((await settle(BLAKE))[0].n).toBe(0);
    expect(await bal(ALEX)).toBe(43);
    expect(await ledger(id)).toHaveLength(1);
  });

  it("settles only once the deadline day is over: on the deadline day itself the challenge is still open", async () => {
    await setBal(ALEX, 50);
    const id = await forfeit(ALEX, ALEX, { penalty: 10 });
    await expire(id, 0); // deadline = today
    expect((await row(id)).status).toBe("active");
    await settle(ALEX);
    expect((await row(id)).status).toBe("active");
    expect(await bal(ALEX)).toBe(50);
    await as(ALEX, `select * from public.increment_challenge($1)`, [id]); // still loggable on the day
    await expire(id, 1);
    await settle(ALEX);
    expect((await row(id)).status).toBe("expired_penalized");
  });

  it("never takes a balance below zero, and says what really happened", async () => {
    await setBal(ALEX, 3);
    const short = await forfeit(ALEX, ALEX, { penalty: 10, title: "Short" });
    await expire(short);
    await settle(ALEX);
    expect(await bal(ALEX)).toBe(0);
    expect(await ledger(short)).toEqual([{ profile_id: ALEX, delta: -3, balance_after: 0, reason: "Missed deadline for challenge: Short" }]);
    expect(await notes(ALEX, short)).toEqual([{ type: "challenge_expired", message: "Deadline passed: Short. 3 points were deducted." }]);

    const empty = await forfeit(ALEX, ALEX, { penalty: 10, title: "Empty" });
    await expire(empty);
    await settle(ALEX);
    expect(await ledger(empty)).toEqual([{ profile_id: ALEX, delta: 0, balance_after: 0, reason: "Missed deadline for challenge: Empty" }]); // still on record
    expect(await notes(ALEX, empty)).toEqual([{ type: "challenge_expired", message: "Deadline passed: Empty. Your balance was already 0, so nothing was deducted." }]);

    await setBal(ALEX, 5);
    const one = await forfeit(ALEX, ALEX, { penalty: 1, title: "One" });
    await expire(one);
    await settle(ALEX);
    expect((await notes(ALEX, one))[0].message).toBe("Deadline passed: One. 1 point was deducted.");
  });

  it("progress, acceptance and reopening all stop once the deadline has passed", async () => {
    const running = await forfeit(ALEX, ALEX);
    await expire(running);
    await expect(as(ALEX, `select * from public.increment_challenge($1)`, [running])).rejects.toThrow(/deadline .* has passed/);
    await expect(as(ALEX, `select * from public.set_challenge_progress($1, 2)`, [running])).rejects.toThrow(/deadline .* has passed/);
    await as(ALEX, `select * from public.set_challenge_progress($1, 0)`, [running]); // taking progress away is still fine

    const proposal = await forfeit(ALEX, BLAKE);
    await expire(proposal);
    await expect(as(BLAKE, `select * from public.respond_to_challenge($1, true)`, [proposal])).rejects.toThrow(/deadline .* passed/);

    // A forfeit that was held must not be reopened into a penalty after the deadline.
    const held = await forfeit(ALEX, ALEX, { target: 1 });
    await as(ALEX, `select * from public.increment_challenge($1)`, [held]);
    await expire(held);
    await expect(as(ALEX, `select * from public.set_challenge_progress($1, 0)`, [held])).rejects.toThrow(/deadline .* has passed/);
    expect((await row(held)).status).toBe("completed");
  });

  it("an unanswered proposal past its deadline just lapses, quietly", async () => {
    const id = await forfeit(ALEX, BLAKE);
    await expire(id);
    await settle(BLAKE);
    expect((await row(id)).status).toBe("expired");
    expect(await as(BLAKE, `select 1 from public.notifications where reference_id = $1`, [id])).toHaveLength(0);
  });

  it("a reward challenge that ran out of time just ends: no penalty, and the person is told", async () => {
    const a0 = await bal(ALEX);
    const [ch] = await as(ALEX, `select * from public.create_challenge('Read a book', $1, 3, 40, 'reward', false, current_date + 4, 0)`, [ALEX]);
    await expire(ch.id);
    await settle(ALEX);
    expect((await row(ch.id)).status).toBe("expired");
    expect(await bal(ALEX)).toBe(a0);
    expect(await notes(ALEX, ch.id)).toEqual([{ type: "challenge_expired", message: "Deadline passed: Read a book. It was not finished in time." }]);
    expect(await ledger(ch.id)).toEqual([]);
  });

  it("a joint challenge that ran out of time tells both partners", async () => {
    const [ch] = await as(ALEX, `select * from public.create_challenge('Tidy together', $1, 3, 40, 'reward', true, current_date + 4, 0)`, [ALEX]);
    await expire(ch.id);
    await settle(BLAKE);
    expect((await row(ch.id)).status).toBe("expired");
    expect(await notes(ALEX, ch.id)).toHaveLength(1);
    expect(await notes(BLAKE, ch.id)).toHaveLength(1);
  });

  it("the app's settle call only touches the caller's own household", async () => {
    await as(DREW, `select * from public.create_household('Drew') `).catch(() => undefined);
    const mine = await forfeit(ALEX, ALEX, { title: "Mine" });
    const theirs = (await as(DREW, `select * from public.create_challenge('Theirs', $1, 3, 0, 'forfeit', false, current_date + 3, 5)`, [DREW]))[0].id as string;
    await expire(mine); await expire(theirs);
    await settle(ALEX);
    expect((await row(mine)).status).toBe("expired_penalized");
    expect((await row(theirs)).status).toBe("active"); // Drew's household is settled on Drew's own call
    await settle(DREW);
    expect((await row(theirs)).status).toBe("expired_penalized");
  });

  it("midnight is the household's own midnight, not the server's", async () => {
    const hh = (await admin(`select household_id from public.profiles where id = $1`, [ALEX]))[0].household_id;
    try {
      for (const tz of ["Pacific/Kiritimati", "Etc/GMT+12"]) { // 26 hours apart: their dates always differ
        await admin(`update public.households set timezone = $2 where id = $1`, [hh, tz]);
        await setBal(ALEX, 50);
        const ended = await forfeit(ALEX, ALEX, { title: `Ended in ${tz}`, penalty: 5 });
        const open = await forfeit(ALEX, ALEX, { title: `Open in ${tz}`, penalty: 5 });
        // creation accepted "today + 3" in this timezone; now move one to yesterday and one to today, on ITS clock
        await admin(`update public.challenges set deadline_date = ($2::date - 1) where id = $1`, [ended, await today(tz)]);
        await admin(`update public.challenges set deadline_date = $2::date where id = $1`, [open, await today(tz)]);
        await settle(ALEX);
        expect((await row(ended)).status).toBe("expired_penalized");
        expect((await row(open)).status).toBe("active");
      }
    } finally {
      await admin(`update public.households set timezone = 'Europe/London' where id = $1`, [hh]);
    }
  });

  it("deleting a missed forfeit gives back exactly what was docked", async () => {
    await setBal(ALEX, 50);
    const id = await forfeit(ALEX, ALEX, { penalty: 10 });
    await expire(id); await settle(ALEX);
    expect(await bal(ALEX)).toBe(40);
    expect((await as(BLAKE, `select public.delete_challenge($1) as taken`, [id]))[0].taken).toBe(-10); // negative = refunded
    expect(await bal(ALEX)).toBe(50);
    expect((await as(ALEX, `select message from public.notifications where reference_id = $1 and type = 'points_adjusted'`, [id]))[0].message)
      .toBe('Blake deleted "Wash up before bed" and refunded the penalty: your balance went up by 10 pts');

    await setBal(ALEX, 3); // the floor case: only 3 was really docked, so only 3 comes back
    const short = await forfeit(ALEX, ALEX, { penalty: 10 });
    await expire(short); await settle(ALEX);
    await as(ALEX, `select public.delete_challenge($1)`, [short]);
    expect(await bal(ALEX)).toBe(3);
  });

  it("an ended challenge cannot be edited or logged, but can be deleted", async () => {
    const id = await forfeit(ALEX, ALEX);
    await expire(id); await settle(ALEX);
    await expect(as(ALEX, `select * from public.update_challenge($1, 'x', 3, 0, $2)`, [id, ALEX])).rejects.toThrow(/has ended/);
    await expect(as(ALEX, `select * from public.increment_challenge($1)`, [id])).rejects.toThrow(/not active for you/);
    await expect(as(ALEX, `select * from public.set_challenge_progress($1, 1)`, [id])).rejects.toThrow(/not running/);
    await as(ALEX, `select public.delete_challenge($1)`, [id]);
    expect(await admin(`select 1 from public.challenges where id = $1`, [id])).toHaveLength(0);
  });

  it("the penalty and deadline of a running forfeit can be edited, but not removed or set in the past", async () => {
    const id = await forfeit(ALEX, ALEX, { penalty: 10 });
    const later = await addDays(await today(), 10);
    const [ch] = await as(ALEX, `select * from public.update_challenge($1, 'Wash up before bed', 3, 0, $2, $3::date, 25)`, [id, ALEX, later]);
    expect(ch).toMatchObject({ penalty_points: 25, reward_points: 0, type: "forfeit" });
    expect((await admin(`select deadline_date::text as d from public.challenges where id = $1`, [id]))[0].d).toBe(later);
    await expect(as(ALEX, `select * from public.update_challenge($1, 'x', 3, 0, $2, null, 25)`, [id, ALEX])).rejects.toThrow(/needs a deadline/);
    await expect(as(ALEX, `select * from public.update_challenge($1, 'x', 3, 0, $2, $3::date, 25)`, [id, ALEX, await addDays(await today(), -3)])).rejects.toThrow(/has not passed/);
    await expect(as(ALEX, `select * from public.update_challenge($1, 'x', 3, 0, $2, $3::date, 0)`, [id, ALEX, later])).rejects.toThrow(/between 1 and 500/);
  });

  it("keeps an unbroken ledger chain through a penalty", async () => {
    await setBal(BLAKE, 30);
    const id = await forfeit(BLAKE, BLAKE, { penalty: 12 });
    await expire(id); await settle(BLAKE);
    const [r] = await ledger(id);
    expect(r.balance_after).toBe(await bal(BLAKE));
    expect(r.balance_after).toBe(30 - 12);
  });

  it("settlement helpers are internal; the app-facing call is closed to anonymous users", async () => {
    await expect(as(ALEX, `select public.settle_challenges_core(null)`)).rejects.toThrow(/permission denied/);
    await expect(as(ALEX, `select public.household_today(public.current_household_id())`)).rejects.toThrow(/permission denied/);
    await expect(as(ALEX, `select public.pay_challenge(c, 1, 'x', $1) from public.challenges c limit 1`, [ALEX])).rejects.toThrow(/permission denied/);
    await expect(asAnon(`select public.settle_my_challenges()`)).rejects.toThrow(/permission denied/);
    await expect(asAnon(`select * from public.create_challenge('x', gen_random_uuid(), 1, 1)`)).rejects.toThrow(/permission denied/);
  });
});

// ===========================================================================
// Both partners have exactly the same access. Nobody is "the admin".
// Every scenario below runs twice: once as the household creator and once as the partner.
// ===========================================================================
describe.each([
  ["the household creator", ALEX, BLAKE],
  ["the partner", BLAKE, ALEX],
] as const)("full access for %s", (_who, me, other) => {
  const tag = me === ALEX ? "creator" : "partner";
  const dayFromNow = async (n: number) => (await admin(`select (current_date + $1::int)::text as d`, [n]))[0].d as string;

  it("manages the chore library: create, edit (pushed to the calendar), see usage, delete", async () => {
    const [lib] = await as(me, `select * from public.create_library_chore($1, 'Access', 30, 3)`, [`Library ${tag}`]);
    const inst = (await as(me, `insert into public.chore_instances (chore_id, title, household_id, assigned_to, scheduled_date, estimated_duration, chore_tax)
                                values ($1, $2, public.current_household_id(), $3, $4, 30, 3) returning id`, [lib.id, lib.title, me, await dayFromNow(2)]))[0].id;
    const [r] = await as(me, `select * from public.update_library_chore($1, $2, 'Access', 45, 7)`, [lib.id, `Library ${tag} v2`]);
    expect(r.n_open).toBe(1);
    expect((await admin(`select title, estimated_duration d, chore_tax t from public.chore_instances where id = $1`, [inst]))[0]).toEqual({ title: `Library ${tag} v2`, d: 45, t: 7 });
    expect((await as(me, `select * from public.library_usage()`)).some((u) => u.library_id === lib.id)).toBe(true);
    await as(me, `select public.delete_library_chore($1, true)`, [lib.id]);
    expect(await admin(`select 1 from public.chore_instances where id = $1`, [inst])).toHaveLength(0);
  });

  it("schedules, completes, edits, unchecks, repeats and removes chores", async () => {
    const id = await chore(me, `Chore ${tag}`, 2, me, "2026-09-10");
    await as(me, `select * from public.complete_chore($1, 30, 100)`, [id]);
    await as(me, `select * from public.edit_completed_chore($1, $2, $3, '2026-09-10', 45, null, null, null)`, [id, `Chore ${tag}`, me]);
    await as(me, `select public.uncomplete_chore($1)`, [id]);
    const rep = await chore(me, `Repeats ${tag}`, 0, me, await dayFromNow(1));
    await as(me, `select public.make_chore_recurring($1, 'weekly')`, [rep]);
    expect((await as(me, `select public.remove_chore_series($1) as n`, [rep]))[0].n).toBeGreaterThan(1);
    expect(await as(me, `delete from public.chore_instances where id = $1 returning id`, [id])).toHaveLength(1);
  });

  it("creates, logs, reduces, edits and deletes every kind of challenge", async () => {
    // individual, for yourself
    const solo = (await as(me, `select * from public.create_challenge($1, $2, 3, 20)`, [`Solo ${tag}`, me]))[0];
    expect(solo.status).toBe("active");
    await as(me, `select * from public.increment_challenge($1)`, [solo.id]);
    await as(me, `select * from public.increment_challenge($1)`, [solo.id]);
    expect((await as(me, `select * from public.set_challenge_progress($1, 1)`, [solo.id]))[0].current_count).toBe(1); // "-"
    await as(me, `select * from public.update_challenge($1, $2, 4, 25, $3)`, [solo.id, `Solo ${tag} v2`, me]);
    await as(me, `select public.delete_challenge($1)`, [solo.id]);

    // for your partner: they see it, accept it, and can manage it too
    const gift = (await as(me, `select * from public.create_challenge($1, $2, 2, 10)`, [`For partner ${tag}`, other]))[0];
    expect(gift.status).toBe("pending");
    await as(other, `select * from public.respond_to_challenge($1, true)`, [gift.id]);
    await as(me, `select * from public.set_challenge_progress($1, 0)`, [gift.id]); // reduce someone else's
    await as(me, `select public.delete_challenge($1)`, [gift.id]);

    // joint: assigned to both, active at once, visible and loggable by both
    const joint = (await as(me, `select * from public.create_challenge($1, $2, 2, 20, 'reward', true, null, 0)`, [`Joint ${tag}`, me]))[0];
    expect(joint).toMatchObject({ is_joint: true, status: "active" });
    expect(await as(other, `select id from public.challenges where id = $1`, [joint.id])).toHaveLength(1);
    await as(me, `select * from public.increment_challenge($1)`, [joint.id]);
    await as(other, `select * from public.increment_challenge($1)`, [joint.id]);
    expect((await admin(`select status from public.challenges where id = $1`, [joint.id]))[0].status).toBe("completed");
    await as(other, `select * from public.set_challenge_progress($1, 1)`, [joint.id]); // either can reopen it
    await as(me, `select public.delete_challenge($1)`, [joint.id]);

    // forfeit
    const ff = (await as(me, `select * from public.create_challenge($1, $2, 2, 0, 'forfeit', false, current_date + 3, 5)`, [`Forfeit ${tag}`, me]))[0];
    expect(ff.type).toBe("forfeit");
    await as(me, `select public.delete_challenge($1)`, [ff.id]);
    await as(me, `select public.settle_my_challenges()`);
  });

  it("adds, edits, retires and redeems shop rewards", async () => {
    await admin(`update public.profiles set points = 500 where id = $1`, [me]);
    const [reward] = await as(
      me,
      `insert into public.rewards (id, household_id, title, description, cost)
       values (gen_random_uuid(), public.current_household_id(), $1, 'from ${tag}', 25) returning *`,
      [`Reward ${tag}`],
    );
    expect(reward.title).toBe(`Reward ${tag}`);
    // the other partner sees it and can change it
    expect(await as(other, `select 1 from public.rewards where id = $1`, [reward.id])).toHaveLength(1);
    expect(await as(other, `update public.rewards set cost = 30 where id = $1 returning cost`, [reward.id])).toEqual([{ cost: 30 }]);
    await as(me, `select * from public.redeem_reward($1)`, [reward.id]);
    expect(await as(me, `update public.rewards set is_active = false where id = $1 returning is_active`, [reward.id])).toEqual([{ is_active: false }]);
  });

  it("can still not touch another household's data", async () => {
    const [theirs] = await as(DREW, `select id from public.chore_library limit 1`);
    await expect(as(me, `select public.delete_library_chore($1, true)`, [theirs.id])).rejects.toThrow(/not found/);
    const theirHousehold = (await admin(`select household_id from public.profiles where id = $1`, [DREW]))[0].household_id;
    await expect(as(me, `insert into public.rewards (id, household_id, title, cost) values (gen_random_uuid(), $1, 'x', 5)`, [theirHousehold]))
      .rejects.toThrow(/row-level security/);
    // ...and cannot retire or edit their rewards either
    expect(await as(me, `update public.rewards set is_active = false where household_id = $1 returning id`, [theirHousehold])).toEqual([]);
  });
});
