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
        if (property_id === "beta" && value === "true") {
          return "Beta";
        }

        if (property_id === "lora" && value === "true") {
          return "LoRA";
        }

        if (property_id === "function_calling" && value === "true") {
          return "MCP";
        }

        return null;
      }
    )
    .filter((val): val is string => val !== null);

  // TODO: Update label for LoRA
  return (
    <div
      className="w-full items-center flex flex-wrap gap-1"
      title={model.description}
    >
      <span className="truncate">{name}</span>
      <div className="flex flex-wrap gap-1">
        {tags.map((tag: string) => (
          <span
            key={tag}
            className={`text-xs px-2 py-1 rounded-full whitespace-nowrap ${
              tag === "Beta"
                ? "bg-orange-200 border-orange-300"
                : tag === "MCP"
                  ? "bg-blue-100 border-blue-400"
                  : "bg-white"
            } border`}
          >
            {tag}
          </span>
        ))}
      </div>
    </div>
  );
};

export default ModelRow;
