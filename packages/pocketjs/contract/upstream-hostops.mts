import type { HostOps as PocketJs060HostOps } from "@pocketjs/framework";

import type { PocketTuiHostOps } from "../src/host.js";

// This deliberately compiles against the npm package's actual TypeScript
// source in a quarantined config. The normal workspace consumes the local
// declaration facade so PocketJS's compiler policy cannot leak into it.
declare const pocketTuiOps: PocketTuiHostOps;
const pocketJs060Ops: PocketJs060HostOps = pocketTuiOps;
void pocketJs060Ops;
