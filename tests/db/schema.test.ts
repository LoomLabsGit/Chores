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
  await db.exec(read("supabase/migrations/0002_remove_completed_chore.sql"));
  await db.exec(read("supabase/migrations/0003_recurring_chores.sql"));
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

describe("remove_completed_chore", () => {
  const points = async (uid: string) =>
    (await as(uid, `select points from public.profiles where id = $1`, [uid]))[0].points as number;
  const count = async (sql: string, params: unknown[]) => (await admin(sql, params)).length;

  it("takes back both partners' points and deletes the chore, completion and its notifications", async () => {
    const [a0, b0] = [await points(ALEX), await points(BLAKE)];
    const id = await chore(ALEX, "Undo me", 10);
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
    admin<{ id: string; d: string; title: string; points: number; who: string | null; done: boolean; rule: string }>(
      `select id, scheduled_date::text d, title, points_assigned points, assigned_to who, is_completed done, recurrence_rule rule
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
    expect(rows.every((r) => r.title === "Weekly bins" && r.points === 4 && r.who === ALEX && !r.done)).toBe(true);
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

    await as(ALEX, `select public.update_chore_series($1, 'New name', 7, $2, 'weekly')`, [pivot.id, BLAKE]);

    const after = await occurrences(sid);
    for (const r of after) {
      if (r.d < pivot.d) expect(r).toMatchObject({ title: "Old name", points: 5, who: ALEX });
      else expect(r).toMatchObject({ title: "New name", points: 7, who: BLAKE });
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
    await as(ALEX, `select public.update_chore_series($1, 'Weekly to daily', 2, $2, 'daily')`, [pivot.id, ALEX]);
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
    await as(ALEX, `select public.update_chore_series($1, 'Stop me', 2, $2, 'none')`, [pivot.id, ALEX]);
    const stopped = await occurrences(sid);
    expect(stopped[stopped.length - 1].d).toBe(pivot.d);
    await as(ALEX, `select public.extend_recurring_chores(current_date + 300)`);
    expect(await occurrences(sid)).toHaveLength(stopped.length);
  });

  it("validates input and refuses invalid states", async () => {
    const id = await chore(ALEX, "Validate", 2, ALEX, await dayFromNow(1));
    await expect(as(ALEX, `select public.make_chore_recurring($1, 'hourly')`, [id])).rejects.toThrow(/how often/);
    await expect(as(ALEX, `select public.update_chore_series($1, 'x', 2, $2, 'weekly')`, [id, ALEX])).rejects.toThrow(/does not repeat/);
    await as(ALEX, `select public.make_chore_recurring($1, 'weekly')`, [id]);
    await expect(as(ALEX, `select public.make_chore_recurring($1, 'weekly')`, [id])).rejects.toThrow(/already repeats/);
    await expect(as(ALEX, `select public.update_chore_series($1, '  ', 2, $2, 'weekly')`, [id, ALEX])).rejects.toThrow(/name/);
    await expect(as(ALEX, `select public.update_chore_series($1, 'x', 11, $2, 'weekly')`, [id, ALEX])).rejects.toThrow(/between 1 and 10/);
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

  it("scheduled chores can now have their points edited, but not completion state", async () => {
    const id = await chore(ALEX, "Edit points", 3, ALEX, await dayFromNow(1));
    expect(await as(ALEX, `update public.chore_instances set points_assigned = 9 where id = $1 returning points_assigned`, [id])).toEqual([{ points_assigned: 9 }]);
    await expect(as(ALEX, `update public.chore_instances set is_completed = true where id = $1`, [id])).rejects.toThrow(/permission denied/);
    await expect(as(ALEX, `update public.chore_instances set points_assigned = 99 where id = $1`, [id])).rejects.toThrow(/check constraint/);
  });
});
