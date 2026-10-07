# Worker operation

For source builds, prefix each command below with node apps/worker/dist/main.js. Packaged builds provide the excess-worker launcher.

| Command | Purpose |
| --- | --- |
| guide | Show onboarding steps based on local state. |
| doctor | Report host hardware and installed runtime inventory; it does not run a model. |
| models | List catalog workloads, local installation state, and fit estimates. |
| use <model-id> [--gpu] | Select a catalog model and backend policy. |
| model-plan [model-id] [--gpu] | Show the planned model/runtime install and disk estimate. |
| install-model [model-id] --accept-download --accept-licenses | Download and install after explicit consent. |
| import <model-id> <files...> --accept-licenses | Check and import exact local model files after license acceptance. |
| probe | Run the local installed-model execution check. |
| policy [file] | Read or replace local worker policy. |

Fit estimates are guidance. The worker's local checks decide whether it will attempt a model. Windows CUDA Qwen3-4B has exact signed-package execution evidence on the measured RTX3070Ti configuration with explicit6GiB host/6GiB combined GPU budgets; Linux GPU remains refused. See [current platform evidence](PLATFORMS.md).

## Pairing and offers

Run pair "<coordinator-origin>" "<device-label>", approve its displayed code and fingerprint in the matching coordinator interface, then run complete-pairing. Use heartbeat to send a device heartbeat after pairing.

Offer supports workload-specific prices, withdrawing one asset, price bands, and automatic pricing. Offers are local configuration sent to the coordinator while the worker runs. A locally configured offer is not evidence of a live market, buyer, or completed job.

## Run and stop

- run starts polling and executing assigned work.
- status reports local worker state.
- drain stops accepting new work and lets the current attempt finish.
- stop-now requests immediate shutdown.
- resume is an alias for run.
- On Linux, service install, service status, and service remove manage a systemd user service.

The worker uses local state and model directories. Set EXCESS_WORKER_HOME or EXCESS_MODEL_DIR before launching if the defaults do not fit the host. Keep the worker state directory private because it contains device identity material.

## Local controls

schedule configures local operating windows. thermal configures CPU and GPU temperature limits; a missing sensor reading means the corresponding limit cannot be enforced. These are local safeguards, not a substitute for an operating-system isolation boundary.
