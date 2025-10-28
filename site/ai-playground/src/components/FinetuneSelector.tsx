import { useSelect } from "downshift";
import { useState } from "react";
import type { FineTune } from "../models";

const FinetuneSelector = ({
  models,
  onSelection
}: {
  models: (FineTune | null)[];
  model: string | null;
  onSelection: (model: FineTune | null) => void;
}) => {
  const [selectedItem, setSelectedItem] = useState<FineTune | null>(null);

  const {
    isOpen,
    getToggleButtonProps,
    getLabelProps,
    getMenuProps,
    highlightedIndex,
    getItemProps
  } = useSelect({
    items: models,
    itemToString: (item) => item?.name || "",
    onSelectedItemChange: ({ selectedItem: newSelectedItem }) => {
      // Update parent state
      onSelection(newSelectedItem);

      // Update local state
      setSelectedItem(newSelectedItem);
    },
    selectedItem
  });

  return (
    <div className="relative">
      {/* biome-ignore lint/a11y/noLabelWithoutControl: it's fine */}
      <label
        {...getLabelProps()}
        className="font-semibold text-sm block mb-1 md:block"
      >
        Finetune
      </label>
      <div
        {...getToggleButtonProps()}
        className="bg-white flex justify-between cursor-pointer w-full border border-gray-200 p-3 rounded-md relative"
      >
        <div className="w-full whitespace-nowrap items-center flex">
          {selectedItem ? selectedItem.name : "None"}
        </div>
        <span className="px-2">{isOpen ? <>&#8593;</> : <>&#8595;</>}</span>
      </div>

      {selectedItem && (
        <span className="mt-2 block text-gray-400 text-sm">
          {selectedItem.description}
        </span>
      )}

      <ul
        className={`absolute left-0 right-0 bg-white mt-1 border border-gray-200 px-2 py-2 rounded-md shadow-lg max-h-80 overflow-scroll z-10 ${
          !isOpen && "hidden"
        }`}
        {...getMenuProps()}
      >
        {isOpen &&
          models.map((item, index) => (
            <li
              className={`py-2 px-3 flex flex-col rounded-md ${
                selectedItem === item && "font-bold"
              } ${highlightedIndex === index && "bg-gray-100"}`}
              key={item?.id || null}
              {...getItemProps({ index, item })}
            >
              {item?.name || "None"}
            </li>
          ))}
      </ul>
    </div>
  );
};

export default FinetuneSelector;
