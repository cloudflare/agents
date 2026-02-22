import { nanoid } from "nanoid";
import { useState } from "react";

const STORAGE_KEY = "playground-user-id";

function getOrCreateUserId(): string {
  if (typeof window === "undefined") return "user-1";
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) return stored;
  const id = `user-${nanoid(6)}`;
  localStorage.setItem(STORAGE_KEY, id);
  return id;
}

export function useUserId(): string {
  const [id] = useState(getOrCreateUserId);
  return id;
}
