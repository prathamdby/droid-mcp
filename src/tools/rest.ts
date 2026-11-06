import { ciTools } from "./rest-ci.ts"
import { computerTools } from "./rest-computers.ts"
import { environmentTools } from "./rest-environments.ts"
import { mergeDomains } from "./rest-kit.ts"
import type { RestDomain } from "./rest-kit.ts"
import { organizationTools } from "./rest-organization.ts"
import { serviceAccountTools } from "./rest-service-accounts.ts"
import { remoteSessionTools } from "./rest-sessions.ts"
import { wikiTools } from "./rest-wiki.ts"

/**
 * Factory API tools. They call the hosted API (`/api/v0/...`) with
 * `FACTORY_API_KEY` through `RestService`, not the daemon.
 */
export const restTools = (): RestDomain =>
  mergeDomains([
    computerTools(),
    environmentTools(),
    remoteSessionTools(),
    wikiTools(),
    ciTools(),
    organizationTools(),
    serviceAccountTools(),
  ])
