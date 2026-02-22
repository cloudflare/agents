// these fields exist on the AiModelsSearchObject type, but are not typed in the workers-types package. We should fix it there, but for now we'll add them here.
export type Model = AiModelsSearchObject & {
  created_at: number;
  finetunes?: FineTune[];
};

export type FineTune = {
  id: string;
  name: string;
  description: string;
  created_at: string;
  modified_at: string;
  public: number;
  model: keyof AiModels;
};
