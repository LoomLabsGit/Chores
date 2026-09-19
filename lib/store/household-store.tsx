"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { useToast } from "@/components/toast";
import { friendlyError } from "@/lib/errors";
import { getSupabase } from "@/lib/supabase/client";
import { computeSplit } from "@/lib/logic/split";
import { addDays, parseISODate } from "@/lib/logic/dates";
import type { RepeatChoice } from "@/lib/logic/recurrence";
import { uuid } from "@/lib/uuid";
import type {
  AppNotification,
  Challenge,
  ChoreCompletion,
  ChoreInstance,
  ChoreLibraryItem,
  Household,
  Profile,
  Reward,
  RewardRedemption,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type State = {
  status: "loading" | "ready" | "error";
  error?: string;
  household: Household | null;
  members: Profile[];
  library: ChoreLibraryItem[];
  instances: Record<string, ChoreInstance>;
  /** Keyed by instance id. */
  completions: Record<string, ChoreCompletion>;
  challenges: Challenge[];
  rewards: Reward[];
  redemptions: RewardRedemption[];
  notifications: AppNotification[];
};

const initialState: State = {
  status: "loading",
  household: null,
  members: [],
  library: [],
  instances: {},
  completions: {},
  challenges: [],
  rewards: [],
  redemptions: [],
  notifications: [],
};

/** The array-shaped slices of state and the row type each one holds. */
type ListRows = {
  members: Profile;
  library: ChoreLibraryItem;
  challenges: Challenge;
  rewards: Reward;
  redemptions: RewardRedemption;
  notifications: AppNotification;
};
type ListKey = keyof ListRows;

type Action =
  | { type: "loaded"; payload: Omit<State, "status" | "error" | "instances" | "completions"> }
  | { type: "failed"; error: string }
  | { [K in ListKey]: { type: "upsert"; key: K; row: ListRows[K] } }[ListKey]
  | { type: "remove"; key: ListKey; id: string }
  | { type: "instance"; row: ChoreInstance }
  | { type: "instance-remove"; id: string }
  | { type: "instances-loaded"; from: string; to: string; rows: ChoreInstance[]; completions: ChoreCompletion[]; keep: string[] }
  | { type: "completion"; row: ChoreCompletion }
  | { type: "completion-remove"; instanceId: string }
  | { type: "points"; userId: string; delta: number }
  | { type: "mark-read" };

function upsertById<T extends { id: string }>(list: T[], row: T): T[] {
  const i = list.findIndex((x) => x.id === row.id);
  if (i === -1) return [...list, row];
  const next = list.slice();
  next[i] = row;
  return next;
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "loaded":
      return { ...state, ...action.payload, status: "ready", error: undefined };
    case "failed":
      return { ...state, status: state.status === "ready" ? "ready" : "error", error: action.error };
    case "upsert":
      return { ...state, [action.key]: upsertById(state[action.key] as { id: string }[], action.row) } as State;
    case "remove":
      return { ...state, [action.key]: (state[action.key] as { id: string }[]).filter((x) => x.id !== action.id) } as State;
    case "instance":
      return { ...state, instances: { ...state.instances, [action.row.id]: action.row } };
    case "instance-remove": {
      const { [action.id]: _gone, ...rest } = state.instances;
      void _gone;
      return { ...state, instances: rest };
    }
    case "instances-loaded": {
      // Replace everything inside the fetched date range so deletions made on the
      // other device disappear, but never drop rows we are still inserting.
      const keep = new Set(action.keep);
      const instances: Record<string, ChoreInstance> = {};
      for (const [id, inst] of Object.entries(state.instances)) {
        const inRange = inst.scheduled_date >= action.from && inst.scheduled_date <= action.to;
        if (!inRange || keep.has(id)) instances[id] = inst;
      }
      for (const row of action.rows) if (!keep.has(row.id)) instances[row.id] = row;
      const completions = { ...state.completions };
      for (const c of action.completions) if (c.instance_id) completions[c.instance_id] = c;
      return { ...state, instances, completions };
    }
    case "completion":
      return action.row.instance_id
        ? { ...state, completions: { ...state.completions, [action.row.instance_id]: action.row } }
        : state;
    case "completion-remove": {
      const { [action.instanceId]: _gone, ...rest } = state.completions;
      void _gone;
      return { ...state, completions: rest };
    }
    case "points":
      return {
        ...state,
        members: state.members.map((m) =>
          m.id === action.userId ? { ...m, points: Math.max(0, m.points + action.delta) } : m,
        ),
      };
    case "mark-read":
      return { ...state, notifications: state.notifications.map((n) => (n.is_read ? n : { ...n, is_read: true })) };
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export type NewChore = { title: string; points: number; minutes: number };

export type ChoreEdit = {
  title: string;
  points: number;
  assignedTo: string | null;
  date: string;
  repeat: RepeatChoice;
  /** For a repeating chore: change only this day, or this day and every later one. */
  scope: "this" | "future";
};

export type StatsData = { completions: ChoreCompletion[]; instances: ChoreInstance[] };

export type Actions = {
  loadWeek: (from: string, to: string) => Promise<void>;
  moveInstance: (id: string, patch: { scheduled_date?: string; assigned_to?: string | null }) => Promise<boolean>;
  scheduleChore: (chore: ChoreLibraryItem, date: string, assignedTo: string) => Promise<boolean>;
  createAndScheduleChore: (chore: NewChore, date: string, assignedTo: string) => Promise<boolean>;
  archiveChore: (id: string) => Promise<boolean>;
  removeInstance: (id: string) => Promise<boolean>;
  editChore: (instance: ChoreInstance, edit: ChoreEdit) => Promise<boolean>;
  completeChore: (instance: ChoreInstance, minutes: number, myPercent: number) => Promise<boolean>;
  createChallenge: (input: { title: string; assignedTo: string; target: number; reward: number }) => Promise<boolean>;
  respondToChallenge: (id: string, accept: boolean) => Promise<boolean>;
  /** Resolves to "completed" when this tap finished the challenge. */
  incrementChallenge: (id: string) => Promise<"ok" | "completed" | "failed">;
  redeemReward: (id: string) => Promise<boolean>;
  addReward: (input: { title: string; description: string; cost: number }) => Promise<boolean>;
  setRewardActive: (id: string, active: boolean) => Promise<boolean>;
  markAllRead: () => Promise<void>;
  loadStats: (startISO: string) => Promise<StatsData | null>;
  reload: () => Promise<void>;
  signOut: () => Promise<void>;
};

type Ctx = {
  state: State;
  me: Profile;
  partner: Profile | undefined;
  actions: Actions;
  /** Stable colour slot for a member: the household creator is "a", the partner "b". */
  tone: (userId: string | null | undefined) => "a" | "b";
  nameOf: (userId: string | null | undefined) => string;
};

const HouseholdContext = createContext<Ctx | null>(null);

export function useHousehold(): Ctx {
  const ctx = useContext(HouseholdContext);
  if (!ctx) throw new Error("useHousehold must be used inside <HouseholdProvider>");
  return ctx;
}

const PAGE = 1000; // PostgREST's default max rows per request

async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

type TableKey = "profiles" | "chore_library" | "chore_instances" | "challenges" | "rewards" | "reward_redemptions" | "notifications";

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function HouseholdProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { toast } = useToast();
  const supabase = useMemo(() => getSupabase(), []);

  // Latest state for actions/realtime handlers without re-subscribing.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const rangeRef = useRef<{ from: string; to: string } | null>(null);
  const pendingInsertsRef = useRef(new Set<string>());
  /** Repeating chores have been topped up as far as this date (this session). */
  const extendedThroughRef = useRef<string | null>(null);

  const loadWeek = useCallback(
    async (from: string, to: string) => {
      rangeRef.current = { from, to };

      // Repeating chores are created lazily: top them up a month past the week being viewed.
      // Errors are ignored on purpose (e.g. the migration has not been applied yet).
      const target = addDays(to, 28);
      if (!extendedThroughRef.current || target > extendedThroughRef.current) {
        const { error: extendError } = await supabase.rpc("extend_recurring_chores", { p_until: target });
        if (!extendError) extendedThroughRef.current = target;
      }

      const { data, error } = await supabase
        .from("chore_instances")
        .select("*")
        .gte("scheduled_date", from)
        .lte("scheduled_date", to);
      if (error) return void toast(friendlyError(error), "error");
      const rows = (data ?? []) as ChoreInstance[];
      const doneIds = rows.filter((r) => r.is_completed).map((r) => r.id);
      let completions: ChoreCompletion[] = [];
      if (doneIds.length) {
        const res = await supabase.from("chore_completions").select("*").in("instance_id", doneIds);
        if (res.error) toast(friendlyError(res.error), "error");
        completions = (res.data ?? []) as ChoreCompletion[];
      }
      // The user may have paged to another week while this was in flight.
      if (rangeRef.current?.from !== from) return;
      dispatch({ type: "instances-loaded", from, to, rows, completions, keep: [...pendingInsertsRef.current] });
    },
    [supabase, toast],
  );

  const loadCore = useCallback(async () => {
    try {
      const [profiles, household, library, challenges, rewards, redemptions, notifications] = await Promise.all([
        supabase.from("profiles").select("*").order("created_at"),
        supabase.from("households").select("*").single(),
        supabase.from("chore_library").select("*"),
        supabase.from("challenges").select("*").order("created_at", { ascending: false }),
        supabase.from("rewards").select("*").order("cost"),
        supabase.from("reward_redemptions").select("*").order("created_at", { ascending: false }).limit(200),
        supabase.from("notifications").select("*").order("created_at", { ascending: false }).limit(50),
      ]);
      const firstError = [profiles, household, library, challenges, rewards, redemptions, notifications].find((r) => r.error);
      if (firstError?.error) throw new Error(firstError.error.message);
      dispatch({
        type: "loaded",
        payload: {
          household: household.data as Household,
          members: (profiles.data ?? []) as Profile[],
          library: (library.data ?? []) as ChoreLibraryItem[],
          challenges: (challenges.data ?? []) as Challenge[],
          rewards: (rewards.data ?? []) as Reward[],
          redemptions: (redemptions.data ?? []) as RewardRedemption[],
          notifications: (notifications.data ?? []) as AppNotification[],
        },
      });
    } catch (e) {
      dispatch({ type: "failed", error: friendlyError(e as Error) });
    }
  }, [supabase]);

  const reload = useCallback(async () => {
    await loadCore();
    const r = rangeRef.current;
    if (r) await loadWeek(r.from, r.to);
  }, [loadCore, loadWeek]);

  // Initial load.
  useEffect(() => {
    void loadCore();
  }, [loadCore]);

  // Realtime: keep both devices in sync without pull-to-refresh.
  const householdId = state.household?.id;
  useEffect(() => {
    if (!householdId) return;

    const keyFor: Record<TableKey, ListKey | "instances"> = {
      profiles: "members",
      chore_library: "library",
      chore_instances: "instances",
      challenges: "challenges",
      rewards: "rewards",
      reward_redemptions: "redemptions",
      notifications: "notifications",
    };

    const fetchCompletion = async (instanceId: string) => {
      const { data } = await supabase.from("chore_completions").select("*").eq("instance_id", instanceId).maybeSingle();
      if (data) dispatch({ type: "completion", row: data as ChoreCompletion });
    };

    const onChange = (table: TableKey) => (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
      const key = keyFor[table];
      if (payload.eventType === "DELETE") {
        const id = (payload.old as { id?: string }).id;
        if (!id) return;
        if (key === "instances") dispatch({ type: "instance-remove", id });
        else dispatch({ type: "remove", key, id });
        return;
      }
      const row = payload.new as { id: string };
      if (key === "instances") {
        const inst = row as unknown as ChoreInstance;
        dispatch({ type: "instance", row: inst });
        if (inst.is_completed && !stateRef.current.completions[inst.id]) void fetchCompletion(inst.id);
        return;
      }
      // The realtime payload is untyped; `key` and `row` always pair up by table.
      dispatch({ type: "upsert", key, row } as Action);
      if (table === "notifications" && payload.eventType === "INSERT") {
        const n = row as unknown as AppNotification;
        if (n.recipient_id === userId) toast(n.message, "info");
      }
    };

    const channel = supabase.channel(`household:${householdId}`);
    (Object.keys(keyFor) as TableKey[]).forEach((table) => {
      channel.on("postgres_changes", { event: "*", schema: "public", table }, onChange(table));
    });

    let subscribedBefore = false;
    channel.subscribe((status: string) => {
      if (status === "SUBSCRIBED") {
        // Anything missed while the socket was down is recovered on reconnect.
        if (subscribedBefore) void reload();
        subscribedBefore = true;
      }
    });

    const onVisible = () => {
      if (document.visibilityState === "visible") void reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
      void supabase.removeChannel(channel);
    };
  }, [householdId, supabase, toast, userId, reload]);

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  const members = useMemo(
    () => [...state.members].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)),
    [state.members],
  );
  const me = members.find((m) => m.id === userId);
  const partner = members.find((m) => m.id !== userId);

  const tone = useCallback(
    (id: string | null | undefined): "a" | "b" => (members[1] && id === members[1].id ? "b" : "a"),
    [members],
  );
  const nameOf = useCallback(
    (id: string | null | undefined) => members.find((m) => m.id === id)?.display_name ?? "Someone",
    [members],
  );

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const actions = useMemo<Actions>(() => {
    const fail = (error: { message?: string } | null) => {
      toast(friendlyError(error), "error");
      return false;
    };
    /** Roll back by re-reading server truth (used where a manual revert would be fiddly). */
    const resync = () => void reload();

    const householdIdNow = () => stateRef.current.household!.id;

    const api: Actions = {
      loadWeek,
      reload,

      async moveInstance(id, patch) {
        const prev = stateRef.current.instances[id];
        if (!prev || prev.is_completed) return false;
        dispatch({ type: "instance", row: { ...prev, ...patch } });
        const { data, error } = await supabase.from("chore_instances").update(patch).eq("id", id).select("id");
        if (error || !data?.length) {
          dispatch({ type: "instance", row: prev });
          return fail(error ?? { message: "That chore can no longer be changed." });
        }
        return true;
      },

      async scheduleChore(chore, date, assignedTo) {
        const id = uuid();
        const row: ChoreInstance = {
          id,
          chore_id: chore.id,
          title: chore.title,
          household_id: householdIdNow(),
          assigned_to: assignedTo,
          scheduled_date: date,
          is_completed: false,
          completed_at: null,
          is_recurring: false,
          recurrence_rule: null,
          parent_recurrence_id: null,
          points_assigned: chore.default_points,
        };
        pendingInsertsRef.current.add(id);
        dispatch({ type: "instance", row });
        dispatch({ type: "upsert", key: "library", row: { ...chore, last_used_at: new Date().toISOString() } });
        const { error } = await supabase.from("chore_instances").insert({
          id,
          chore_id: chore.id,
          title: chore.title,
          household_id: row.household_id,
          assigned_to: assignedTo,
          scheduled_date: date,
          points_assigned: chore.default_points,
        });
        pendingInsertsRef.current.delete(id);
        if (error) {
          dispatch({ type: "instance-remove", id });
          return fail(error);
        }
        return true;
      },

      async createAndScheduleChore(input, date, assignedTo) {
        const title = input.title.trim();
        if (!title) return false;
        // Re-use an existing library chore with the same name instead of duplicating it.
        const existing = stateRef.current.library.find(
          (c) => !c.is_archived && c.title.toLowerCase() === title.toLowerCase(),
        );
        if (existing) return api.scheduleChore(existing, date, assignedTo);

        const libId = uuid();
        const lib: ChoreLibraryItem = {
          id: libId,
          household_id: householdIdNow(),
          title,
          category: "General",
          default_duration: input.minutes,
          default_points: input.points,
          is_archived: false,
          last_used_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        };
        dispatch({ type: "upsert", key: "library", row: lib });
        const { error } = await supabase.from("chore_library").insert({
          id: libId,
          household_id: lib.household_id,
          title,
          default_duration: input.minutes,
          default_points: input.points,
        });
        if (error) {
          dispatch({ type: "remove", key: "library", id: libId });
          return fail(error);
        }
        return api.scheduleChore(lib, date, assignedTo);
      },

      async archiveChore(id) {
        const prev = stateRef.current.library.find((c) => c.id === id);
        if (!prev) return false;
        dispatch({ type: "upsert", key: "library", row: { ...prev, is_archived: true } });
        const { error } = await supabase.from("chore_library").update({ is_archived: true }).eq("id", id);
        if (error) {
          dispatch({ type: "upsert", key: "library", row: prev });
          return fail(error);
        }
        return true;
      },

      async removeInstance(id) {
        const prev = stateRef.current.instances[id];
        if (!prev) return false;
        dispatch({ type: "instance-remove", id });

        if (prev.is_completed) {
          // Completed chores go through a server function that also takes the points back.
          const completion = stateRef.current.completions[id];
          if (completion) {
            dispatch({ type: "completion-remove", instanceId: id });
            dispatch({ type: "points", userId: completion.user_a_id, delta: -completion.user_a_points });
            if (completion.user_b_id !== completion.user_a_id) {
              dispatch({ type: "points", userId: completion.user_b_id, delta: -completion.user_b_points });
            }
          }
          const { error } = await supabase.rpc("remove_completed_chore", { p_instance_id: id });
          if (error) {
            dispatch({ type: "instance", row: prev });
            if (completion) dispatch({ type: "completion", row: completion });
            resync();
            return fail(error);
          }
          return true;
        }

        const { data, error } = await supabase.from("chore_instances").delete().eq("id", id).select("id");
        if (error || !data?.length) {
          dispatch({ type: "instance", row: prev });
          return fail(error ?? { message: "That chore can no longer be removed." });
        }
        return true;
      },

      async editChore(instance, edit) {
        const prev = stateRef.current.instances[instance.id];
        if (!prev || prev.is_completed) return false;
        const title = edit.title.trim();
        if (!title) return false;
        const inSeries = !!prev.parent_recurrence_id;

        const patch = {
          title,
          points_assigned: edit.points,
          assigned_to: edit.assignedTo,
          scheduled_date: edit.date,
        };
        dispatch({ type: "instance", row: { ...prev, ...patch } });
        const { data, error } = await supabase.from("chore_instances").update(patch).eq("id", prev.id).select("id");
        if (error || !data?.length) {
          dispatch({ type: "instance", row: prev });
          return fail(error ?? { message: "That chore can no longer be changed." });
        }

        let rpcError: { message?: string } | null = null;
        if (inSeries && edit.scope === "future") {
          ({ error: rpcError } = await supabase.rpc("update_chore_series", {
            p_instance_id: prev.id,
            p_title: title,
            p_points: edit.points,
            p_assigned_to: edit.assignedTo,
            p_frequency: edit.repeat,
          }));
        } else if (!inSeries && edit.repeat !== "none") {
          ({ error: rpcError } = await supabase.rpc("make_chore_recurring", {
            p_instance_id: prev.id,
            p_frequency: edit.repeat,
          }));
        } else {
          return true;
        }

        // Occurrences were created or removed on the server: re-read the visible week.
        const range = rangeRef.current;
        if (range) await loadWeek(range.from, range.to);
        if (rpcError) return fail(rpcError);
        return true;
      },

      async completeChore(instance, minutes, myPercent) {
        const s = stateRef.current;
        const other = s.members.find((m) => m.id !== userId);
        const split = computeSplit(minutes, instance.points_assigned, myPercent);
        const now = new Date().toISOString();

        const optimisticCompletion: ChoreCompletion = {
          id: `pending-${instance.id}`,
          instance_id: instance.id,
          total_duration_minutes: minutes,
          user_a_id: userId,
          user_a_duration: split.me.minutes,
          user_a_points: split.me.points,
          user_b_id: other?.id ?? userId,
          user_b_duration: split.partner.minutes,
          user_b_points: split.partner.points,
          created_at: now,
        };
        dispatch({ type: "instance", row: { ...instance, is_completed: true, completed_at: now } });
        dispatch({ type: "completion", row: optimisticCompletion });
        dispatch({ type: "points", userId, delta: split.me.points });
        if (other) dispatch({ type: "points", userId: other.id, delta: split.partner.points });

        const { data, error } = await supabase.rpc("complete_chore", {
          p_instance_id: instance.id,
          p_total_minutes: minutes,
          p_my_percent: myPercent,
        });
        if (error) {
          dispatch({ type: "instance", row: instance });
          dispatch({ type: "completion-remove", instanceId: instance.id });
          resync();
          return fail(error);
        }
        dispatch({ type: "completion", row: data as ChoreCompletion });
        return true;
      },

      async createChallenge({ title, assignedTo, target, reward }) {
        const { data, error } = await supabase.rpc("create_challenge", {
          p_title: title,
          p_assigned_to: assignedTo,
          p_target_count: target,
          p_reward_points: reward,
        });
        if (error) return fail(error);
        dispatch({ type: "upsert", key: "challenges", row: data as Challenge });
        return true;
      },

      async respondToChallenge(id, accept) {
        const { data, error } = await supabase.rpc("respond_to_challenge", {
          p_challenge_id: id,
          p_accept: accept,
        });
        if (error) {
          resync();
          return fail(error);
        }
        dispatch({ type: "upsert", key: "challenges", row: data as Challenge });
        stateRef.current.notifications
          .filter((n) => n.type === "challenge_proposed" && n.reference_id === id && !n.is_read)
          .forEach((n) => dispatch({ type: "upsert", key: "notifications", row: { ...n, is_read: true } }));
        return true;
      },

      async incrementChallenge(id) {
        const prev = stateRef.current.challenges.find((c) => c.id === id);
        if (!prev || prev.status !== "active") return "failed";
        const finishes = prev.current_count + 1 >= prev.target_count;
        dispatch({
          type: "upsert",
          key: "challenges",
          row: {
            ...prev,
            current_count: Math.min(prev.target_count, prev.current_count + 1),
            status: finishes ? "completed" : "active",
          },
        });
        if (finishes) dispatch({ type: "points", userId, delta: prev.reward_points });

        const { data, error } = await supabase.rpc("increment_challenge", { p_challenge_id: id });
        if (error) {
          resync();
          fail(error);
          return "failed";
        }
        const row = data as Challenge;
        dispatch({ type: "upsert", key: "challenges", row });
        return row.status === "completed" ? "completed" : "ok";
      },

      async redeemReward(id) {
        const reward = stateRef.current.rewards.find((r) => r.id === id);
        if (!reward) return false;
        dispatch({ type: "points", userId, delta: -reward.cost });
        const { data, error } = await supabase.rpc("redeem_reward", { p_reward_id: id });
        if (error) {
          resync();
          return fail(error);
        }
        dispatch({ type: "upsert", key: "redemptions", row: data as RewardRedemption });
        return true;
      },

      async addReward({ title, description, cost }) {
        const id = uuid();
        const { data, error } = await supabase
          .from("rewards")
          .insert({ id, household_id: householdIdNow(), title: title.trim(), description: description.trim() || null, cost })
          .select()
          .single();
        if (error) return fail(error);
        dispatch({ type: "upsert", key: "rewards", row: data as Reward });
        return true;
      },

      async setRewardActive(id, active) {
        const prev = stateRef.current.rewards.find((r) => r.id === id);
        if (!prev) return false;
        dispatch({ type: "upsert", key: "rewards", row: { ...prev, is_active: active } });
        const { error } = await supabase.from("rewards").update({ is_active: active }).eq("id", id);
        if (error) {
          dispatch({ type: "upsert", key: "rewards", row: prev });
          return fail(error);
        }
        return true;
      },

      async markAllRead() {
        if (!stateRef.current.notifications.some((n) => !n.is_read)) return;
        dispatch({ type: "mark-read" });
        const { error } = await supabase
          .from("notifications")
          .update({ is_read: true })
          .eq("recipient_id", userId)
          .eq("is_read", false);
        if (error) resync();
      },

      async loadStats(startISO) {
        try {
          const since = parseISODate(startISO).toISOString();
          const [completions, instances] = await Promise.all([
            fetchAll<ChoreCompletion>((from, to) =>
              supabase
                .from("chore_completions")
                .select("*")
                .gte("created_at", since)
                .order("created_at")
                .order("id")
                .range(from, to),
            ),
            fetchAll<ChoreInstance>((from, to) =>
              supabase
                .from("chore_instances")
                .select("*")
                .eq("is_completed", true)
                .gte("completed_at", since)
                .order("completed_at")
                .order("id")
                .range(from, to),
            ),
          ]);
          return { completions, instances };
        } catch (e) {
          toast(friendlyError(e as Error), "error");
          return null;
        }
      },

      async signOut() {
        await supabase.auth.signOut();
        window.location.assign("/login");
      },
    };
    return api;
  }, [supabase, toast, userId, reload, loadWeek]);

  // -------------------------------------------------------------------------

  if (state.status === "loading") return <FullScreenMessage title="Loading your household…" spinner />;
  if (state.status === "error" || !me) {
    return (
      <FullScreenMessage
        title="Couldn't load your household"
        detail={state.error ?? "Your profile could not be found."}
        action={{ label: "Try again", onClick: () => void loadCore() }}
      />
    );
  }

  return (
    <HouseholdContext.Provider value={{ state: { ...state, members }, me, partner, actions, tone, nameOf }}>
      {children}
    </HouseholdContext.Provider>
  );
}

function FullScreenMessage({
  title,
  detail,
  spinner,
  action,
}: {
  title: string;
  detail?: string;
  spinner?: boolean;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
      {spinner && (
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-line border-t-brand" aria-hidden />
      )}
      <p className="text-lg font-bold" role={spinner ? "status" : undefined}>
        {title}
      </p>
      {detail && <p className="max-w-sm text-sm text-muted">{detail}</p>}
      {action && (
        <button
          onClick={action.onClick}
          className="mt-2 min-h-11 rounded-full bg-brand px-6 font-bold text-brand-ink"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
