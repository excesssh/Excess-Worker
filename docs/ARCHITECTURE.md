# Architecture and scope

This repository isolates the supplier-side worker packages from the larger EXCESS service. It is not a complete coordinator or marketplace.

    Separately operated coordinator <-> apps/worker
                                         |
                                         v
                                  packages/adapters
                                         |
                                         v
                              Local model runtime/files

    packages/protocol defines contracts used by the worker and adapters.
    Database, object storage, market, buyer interface, and settlement are external.

apps/worker owns the CLI, device pairing and identity, local policy, offers, polling, execution, result delivery, and shutdown. packages/adapters describes catalog entries, installs pinned runtimes and model files after explicit consent, supervises local inference processes, parses streaming text, and handles buffered media outputs. packages/protocol defines the signed message and request/result shapes shared at that boundary.

The coordinator, PostgreSQL, object storage, buyer interface, scheduler, and settlement signer are not shipped here. A production deployment composes those as separate services and independent workers. Settlement signing remains outside the worker process.

The worker's device key authenticates the device protocol. The worker sends completed results to the separately operated coordinator. This repository does not define the coordinator's retention, access, or deletion behavior, so review that service's data handling before sending real inputs or outputs.
