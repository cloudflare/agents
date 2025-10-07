import type { Disk } from "../types";

interface DiskCardProps {
  disk: Disk;
  onDelete?: (diskName: string) => void;
  onExport?: (diskName: string) => void;
}

export function DiskCard({ disk, onDelete, onExport }: DiskCardProps) {
  const handleDelete = () => {
    if (onDelete) {
      onDelete(disk.name);
    }
  };

  const handleExport = () => {
    if (onExport) {
      onExport(disk.name);
    }
  };

  return (
    <div className="disk-card" box-="square" shear-="top">
      <div className="delete-disk">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: dont care */}
        <span
          style={{
            background: "var(--background0)",
            margin: "0 1ch",
            cursor: "pointer"
          }}
          onClick={handleExport}
          title="Export disk"
        >
          ↓
        </span>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: dont care */}
        <span
          style={{
            background: "var(--background0)",
            margin: "0 1ch",
            cursor: "pointer"
          }}
          onClick={handleDelete}
          title="Delete disk"
        >
          x
        </span>
      </div>
      <div className="disk-name">{disk.name || "Unnamed Disk"}</div>
      <div className="disk-size">
        {disk.size || 0} {disk.size === 1 ? "entry" : "entries"}
      </div>
      {disk.description && (
        <div className="disk-description">{disk.description}</div>
      )}
    </div>
  );
}
