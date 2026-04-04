export type Scenario = {
  id: string;
  category: string;
  section: string;
  route: string | null;
  testNumber: number | null;
  title: string;
  action: string[];
  expected: string[];
  notes: string[];
  flags: string[];
};
