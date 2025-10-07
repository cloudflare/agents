export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface Disk {
  name: string;
  size: number;
  description?: string;
}

export interface AgentStatus {
  connected: boolean;
  initialized: boolean;
  agentName: string;
}

export interface ImportData {
  entries: MemoryEntry[];
}

export interface MemoryEntry {
  [key: string]: any;
}

export interface DiskSearchNotification {
  diskName: string;
  query: string;
  timestamp: number;
}

export interface DiskAddNotification {
  diskName: string;
  entry: MemoryEntry;
  timestamp: number;
}
