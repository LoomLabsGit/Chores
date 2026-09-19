"use client";

import type { ChoreInstance } from "@/lib/types";
import { ActionMenu, type MenuItem } from "../ui/action-menu";

export type CardActions = {
  onEdit: (i: ChoreInstance) => void;
  onChangeDate: (i: ChoreInstance) => void;
  onUncheck: (i: ChoreInstance) => void;
  onDelete: (i: ChoreInstance) => void;
};

/**
 * The "..." menu on a chore card. What it offers depends on the chore:
 * unfinished -> Edit, Change date, Delete; finished -> Edit, Change date, Uncheck, Delete.
 * (Editing a finished chore re-prices it: see the dynamic ledger.)
 */
export function CardMenu({ instance, actions }: { instance: ChoreInstance; actions: CardActions }) {
  const items: MenuItem[] = instance.is_completed
    ? [
        { key: "edit", label: "Edit", icon: "pencil", run: () => actions.onEdit(instance) },
        { key: "date", label: "Change date", icon: "calendar", run: () => actions.onChangeDate(instance) },
        { key: "uncheck", label: "Uncheck", icon: "undo", run: () => actions.onUncheck(instance) },
        { key: "delete", label: "Delete", icon: "trash", danger: true, run: () => actions.onDelete(instance) },
      ]
    : [
        { key: "edit", label: "Edit", icon: "pencil", run: () => actions.onEdit(instance) },
        { key: "date", label: "Change date", icon: "calendar", run: () => actions.onChangeDate(instance) },
        { key: "delete", label: "Delete", icon: "trash", danger: true, run: () => actions.onDelete(instance) },
      ];
  return <ActionMenu label={instance.title} items={items} />;
}
