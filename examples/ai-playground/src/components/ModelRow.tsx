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
      className="w-full whitespace-nowrap items-center flex"
      title={model.description}
    >
      {name}
      <div className="ml-2">
        {tags.map((tag: string) => (
          <span
            key={tag}
            className={`text-xs mr-1 px-2 py-1 rounded-full ${
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
