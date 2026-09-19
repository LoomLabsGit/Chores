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
  is_admin: boolean;
  created_at: string;
};

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
  created_at: string;
};

export type ChallengeStatus = "pending" | "active" | "completed" | "rejected";

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
};

export type Reward = {
  id: string;
  household_id: string;
  title: string;
  description: string | null;
  cost: number;
  is_active: boolean;
  created_at: string;
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
  | "reward_redeemed";

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
