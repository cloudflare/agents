import React from "react";
import { useState, useRef } from "react";
import { DiskCard } from "./DiskCard";
import type { Disk, MemoryEntry } from "../types";

interface DisksSectionProps {
  agentBase: string;
  disks: Disk[];
}

export function DisksSection({ agentBase, disks }: DisksSectionProps) {
  const [isImporting, setIsImporting] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [diskName, setDiskName] = useState("");
  const [diskDescription, setDiskDescription] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importDialogRef = useRef<HTMLDialogElement>(null);

  const sanitizeDiskName = (name: string) => {
    // Replace non-alphanumeric characters (except underscores) with underscores for SQLite compatibility
    return name.replace(/[^a-zA-Z0-9_]/g, "_");
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setPendingFile(file);
    const baseName = file.name.replace(/\.(idz|json)$/i, "");
    setDiskName(sanitizeDiskName(baseName));
    setDiskDescription("");
    importDialogRef.current?.showModal();
  };

  const handleCancelImport = () => {
    setPendingFile(null);
    setDiskName("");
    setDiskDescription("");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    importDialogRef.current?.close();
  };

  const handleConfirmImport = async () => {
    if (!pendingFile || !diskName.trim()) {
      return;
    }

    importDialogRef.current?.close();
    setIsImporting(true);

    try {
      const text = await pendingFile.text();
      let parsed: any;

      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("File is not valid JSON.");
      }

      const entries: MemoryEntry[] = Array.isArray(parsed)
        ? parsed
        : parsed?.entries;

      if (!Array.isArray(entries)) {
        throw new Error("Expected an array of entries or { entries: [...] }.");
      }

      const payload: {
        name: string;
        entries: MemoryEntry[];
        description?: string;
      } = {
        name: diskName.trim(),
        entries
      };

      if (diskDescription.trim()) {
        payload.description = diskDescription.trim();
      }

      const res = await fetch(`${agentBase}/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errorData = (await res.json()) as { error?: string };
        throw new Error(errorData.error || `HTTP ${res.status}`);
      }

      const json = (await res.json()) as { result?: string };

      // Clear the file input and state
      setPendingFile(null);
      setDiskName("");
      setDiskDescription("");
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      // Clear the file input on error too
      setPendingFile(null);
      setDiskName("");
      setDiskDescription("");
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } finally {
      setIsImporting(false);
    }
  };

  const [diskToDelete, setDiskToDelete] = useState<string | null>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);

  const handleDeleteClick = (diskName: string) => {
    setDiskToDelete(diskName);
    deleteDialogRef.current?.showModal();
  };

  const handleCancelDelete = () => {
    setDiskToDelete(null);
    deleteDialogRef.current?.close();
  };

  const handleConfirmDelete = async () => {
    if (!diskToDelete) return;

    deleteDialogRef.current?.close();

    try {
      const res = await fetch(`${agentBase}/delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: diskToDelete })
      });

      if (!res.ok) {
        const errorData = (await res.json()) as { error?: string };
        throw new Error(errorData.error || `HTTP ${res.status}`);
      }

      const json = (await res.json()) as { result?: string };
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
    } finally {
      setDiskToDelete(null);
    }
  };

  const handleExportDisk = async (diskName: string) => {
    try {
      const res = await fetch(`${agentBase}/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: diskName })
      });

      if (!res.ok) {
        const errorData = (await res.json()) as { error?: string };
        throw new Error(errorData.error || `HTTP ${res.status}`);
      }

      const data = (await res.json()) as {
        name: string;
        description?: string;
        entries: MemoryEntry[];
      };

      // Create a downloadable file
      const blob = new Blob([JSON.stringify(data.entries, null, 2)], {
        type: "application/json"
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${diskName}.idz`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      console.error("Export error:", errorMsg);
    }
  };

  const totalMemories = disks.reduce((sum, disk) => sum + (disk.size || 0), 0);

  return (
    <div
      className="content"
      style={{ flexDirection: "column", alignItems: "flex-start" }}
    >
      <div
        className="row"
        style={{
          width: "100%",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center"
        }}
      >
        <span style={{ margin: 0 }}>
          {disks.length === 0
            ? "No disks loaded yet."
            : `${totalMemories} ${totalMemories === 1 ? "memory" : "memories"} across ${disks.length} ${disks.length === 1 ? "disk" : "disks"}.`}
        </span>
        <label
          box-="round"
          style={{
            cursor: isImporting ? "not-allowed" : "pointer",
            opacity: isImporting ? 0.6 : 1
          }}
        >
          <span is-="badge" variant-="background0">
            {isImporting ? "Importing…" : "Import new disk"}
          </span>
          <input
            ref={fileInputRef}
            className="hidden"
            type="file"
            accept=".idz,.json"
            onChange={handleFileChange}
            disabled={isImporting}
          />
        </label>
      </div>

      {disks.length > 0 && (
        <div id="disk-cards" className="disk-cards">
          {disks.map((disk, index) => (
            <DiskCard
              key={`${disk.name}-${index}`}
              disk={disk}
              onDelete={handleDeleteClick}
              onExport={handleExportDisk}
            />
          ))}
        </div>
      )}

      {/* Import Dialog */}
      <dialog
        ref={importDialogRef}
        onKeyDown={(e) => {
          if (e.key === "Escape") handleCancelImport();
          if (e.key === "Enter" && e.ctrlKey) handleConfirmImport();
        }}
      >
        <div box-="round" className="dialog-content">
          <h3 style={{ margin: 0 }}>Import Identity Disk</h3>
          <label>
            <span>Name:</span>
            <input
              type="text"
              value={diskName}
              onChange={(e) => setDiskName(sanitizeDiskName(e.target.value))}
              placeholder="Disk name (alphanumeric and _ only)"
              autoFocus
            />
          </label>
          <label>
            <span>Description (optional):</span>
            <textarea
              value={diskDescription}
              onChange={(e) => setDiskDescription(e.target.value)}
              placeholder="A brief description of this disk"
            />
          </label>
          <div className="dialog-buttons">
            <button box-="round" onClick={handleCancelImport}>
              Cancel
            </button>
            <button box-="round" onClick={handleConfirmImport}>
              Import
            </button>
          </div>
        </div>
      </dialog>

      {/* Delete Confirmation Dialog */}
      <dialog
        ref={deleteDialogRef}
        onKeyDown={(e) => {
          if (e.key === "Escape") handleCancelDelete();
          if (e.key === "Enter") handleConfirmDelete();
        }}
      >
        <div box-="round" className="dialog-content">
          <p>Are you sure you want to delete disk "{diskToDelete}"?</p>
          <div className="dialog-buttons">
            <button box-="round" onClick={handleCancelDelete} autoFocus>
              Cancel
            </button>
            <button box-="round" onClick={handleConfirmDelete}>
              Delete
            </button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
