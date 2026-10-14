"use client";

import { useState } from "react";
import { todayISO } from "@/lib/logic/dates";
import type { BacklogItem } from "@/lib/types";
import { Modal } from "../ui/modal";
import { WhenWhoRepeat } from "../schedule/add-chore-sheet";

/**
 * Plan a backlog job onto the calendar: the same "when / who" step as the Add chore sheet, so planning a
 * job from the Backlog tab and picking it while adding a chore are one and the same thing.
 */
export function ScheduleJobSheet({ job, onClose }: { job: BacklogItem | null; onClose: () => void }) {
  if (!job) return null;
  return (
    <Modal open onClose={onClose} title="Add to calendar" variant="sheet">
      <Form job={job} onClose={onClose} />
    </Modal>
  );
}

function Form({ job, onClose }: { job: BacklogItem; onClose: () => void }) {
  // Start on today. (Opened fresh each time, so "today" is never stale.)
  const [today] = useState(() => todayISO());
  return <WhenWhoRepeat draft={{ kind: "backlog", item: job }} date={today} onClose={onClose} onAdded={() => {}} />;
}
