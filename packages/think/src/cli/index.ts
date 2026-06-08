#!/usr/bin/env node

import { createCli } from "./create";

console.warn(
  "The `think` CLI is part of the experimental @cloudflare/think framework " +
    "layer and may change or be removed in any release."
);

void createCli().parse();
