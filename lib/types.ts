// Row shapes mirror supabase/migrations/0001_init.sql.

export type Household = {
  id: string;
  name: string;
  invite_code: string;
  created_at: string;
};

export type Profile = {
  id: string;
  display_name: string;
  avatar_url: string | null;
  household_id: string;
  points: number;
  /** Marks who created the household (colour A; side "a" of a joint challenge). Grants no extra rights. */
  is_admin: boolean;
  created_at: string;
};

/** How a chore is priced: by the time it takes (plus a chore tax), or a fixed bounty whatever the time. */
export type PricingType = "time_based" | "fixed_bounty";

export type ChoreLibraryItem = {
  id: string;
  household_id: string;
  title: string;
  category: string;
  default_duration: number;
  /** LEGACY: superseded by time + chore_tax. Kept for old rows; nothing reads it. */
  default_points: number;
  /** Flat bonus points for dirty or unpleasant jobs (0-50). */
  chore_tax: number;
  pricing_type: PricingType;
  /** Points a fixed-bounty chore pays. Only used when pricing_type is "fixed_bounty". */
  fixed_bounty_points: number;
  is_archived: boolean;
  last_used_at: string | null;
  created_at: string;
};

export type ChoreInstance = {
  id: string;
  chore_id: string | null;
  title: string;
  household_id: string;
  assigned_to: string | null;
  scheduled_date: string; // YYYY-MM-DD
  is_completed: boolean;
  completed_at: string | null;
  is_recurring: boolean;
  recurrence_rule: string | null;
  parent_recurrence_id: string | null;
  /** LEGACY: superseded by estimated_duration + chore_tax. Kept for old rows; nothing reads it. */
  points_assigned: number;
  /** Estimated minutes (multiple of 5). Points are worked out from this until the real time is logged. */
  estimated_duration: number;
  chore_tax: number;
  pricing_type: PricingType;
  fixed_bounty_points: number;
};

export type ChoreCompletion = {
  id: string;
  instance_id: string | null;
  total_duration_minutes: number;
  user_a_id: string;
  user_a_duration: number;
  user_a_points: number;
  user_b_id: string;
  user_b_duration: number;
  user_b_points: number;
  /** The owner's (user A's) share of the effort, 0-100. Lets the completion be re-priced exactly. */
  owner_percent: number;
  created_at: string;
};

export type ChallengeStatus =
  | "pending"
  | "active"
  | "completed"
  | "rejected"
  /** Ran out of time without a penalty (a reward challenge, or a proposal nobody accepted). */
  | "expired"
  /** A forfeit challenge that missed its deadline and was docked. */
  | "expired_penalized";

/** A reward challenge pays on success; a forfeit challenge costs points if the deadline is missed. */
export type ChallengeType = "reward" | "forfeit";

export type Challenge = {
  id: string;
  household_id: string;
  creator_id: string;
  assigned_to: string;
  title: string;
  target_count: number;
  current_count: number;
  reward_points: number;
  status: ChallengeStatus;
  created_at: string;
  completed_at: string | null;
  type: ChallengeType;
  /** Shared by both partners: either can log progress and the reward is split 50/50. */
  is_joint: boolean;
  /** YYYY-MM-DD; settled after this day ends (on the household's clock). Required for a forfeit. */
  deadline_date: string | null;
  /** Points docked if a forfeit's deadline is missed. 0 for a reward challenge. */
  penalty_points: number;
  /** Joint challenges: each partner's contribution ("a" is the household creator). */
  completed_by_a_count: number;
  completed_by_b_count: number;
};

/** A new reward is "pending" until the other person signs it off; they can also decline it. */
export type RewardStatus = "pending" | "approved" | "declined";

export type Reward = {
  id: string;
  household_id: string;
  title: string;
  description: string | null;
  cost: number;
  is_active: boolean;
  created_at: string;
  status: RewardStatus;
  /** Who added it. The OTHER person is the one who can sign it off. */
  created_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
};

export type RewardRedemption = {
  id: string;
  reward_id: string | null;
  redeemed_by: string;
  cost: number;
  created_at: string;
};

export type NotificationType =
  | "chore_assigned"
  | "chore_completed"
  | "challenge_proposed"
  | "challenge_accepted"
  | "challenge_declined"
  | "challenge_completed"
  | "reward_redeemed"
  | "points_adjusted"
  | "challenge_expired"
  | "reward_proposed"
  | "reward_approved"
  | "reward_declined";

export type AppNotification = {
  id: string;
  recipient_id: string;
  actor_id: string | null;
  type: NotificationType;
  reference_id: string | null;
  message: string;
  is_read: boolean;
  created_at: string;
};
