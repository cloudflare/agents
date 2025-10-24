export type Model = {
  id: string;
  source: number;
  name: keyof AiModels;
  description: string;
  task: {
    id: string;
    name: string;
    description: string;
  };
  created_at: string;
  tags: string[];
  properties: {
    property_id: string;
    value: string;
  }[];
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
