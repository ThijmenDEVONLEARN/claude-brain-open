#!/usr/bin/env node
// Start de TypeScript-bronnen direct via tsx, zodat er geen aparte buildstap nodig is.
import { register } from "tsx/esm/api";

register();
await import("../src/cli.ts");
