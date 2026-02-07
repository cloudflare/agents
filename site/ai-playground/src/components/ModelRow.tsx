import { Badge } from "@cloudflare/kumo";
import type { Model } from "../models";

const ModelRow = ({ model }: { model: Model }) => {
  const [_provider, _author, name] = model.name.split("/");
  const tags: string[] = model.properties
    .map(
      ({
        property_id,
        value
      }: {
        property_id: string;
        value: string;
      }): string | null => {
        if (property_id === "beta" && value === "true") return "Beta";
        if (property_id === "lora" && value === "true") return "LoRA";
        if (property_id === "function_calling" && value === "true")
          return "MCP";
        return null;
      }
    )
    .filter((val): val is string => val !== null);

  return (
    <div
      className="w-full items-center flex flex-wrap gap-1"
      title={model.description}
    >
      <span className="truncate">{name}</span>
      <div className="flex flex-wrap gap-1.5 ml-1.5">
        {tags.map((tag: string) =>
          tag === "MCP" ? (
            <span
              key={tag}
              className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-blue-500/15 text-blue-600 dark:text-blue-400 border border-blue-400/30"
            >
              {tag}
            </span>
          ) : (
            <Badge key={tag} variant={tag === "Beta" ? "beta" : "outline"}>
              {tag}
            </Badge>
          )
        )}
      </div>
    </div>
  );
};

export default ModelRow;
