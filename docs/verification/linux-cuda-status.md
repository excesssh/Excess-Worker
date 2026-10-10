# Linux CUDA status

The published Worker 0.2.0, sequence 26, has a confirmed Linux CUDA installation defect: the pinned runtime tar archives contain root-level regular files, while the installer expects one enclosing directory. Installing a CUDA model therefore refuses the archive. This does not affect the recorded CPU configurations.

The source correction accepts flat regular-file layout only for the exact pinned Linux CUDA runtime archives. Traversal, nested entries, links, duplicate names, special files and archive-size limits remain enforced. A private candidate completed actual model installation, pinned runtime verification and specialised model inspection. It is not a new signed release.

The same test also identified a memory-monitor defect: the non-dumpable runtime is hidden by the controller's private procfs. Source now samples the read-only kernel cgroup memory counter, including service processes and charged cache. This conservative aggregate is distinct from process RSS; unavailable RSS is reported as zero. The existing hard cgroup ceiling and sampled whole-device GPU budget remain in force.

Confined CUDA startup still failed. Device detection outside confinement succeeded, but the worker observed no GPU residency or complete layer offload and refused execution. Subsequent source changes permit four exact read-only CUDA discovery files and the exact NVIDIA NUMA-information ioctl encoding. Other encodings, NUMA mutations and Unix socket creation remain denied. These changes require a fresh hardware run; software fixtures do not establish GPU inference.

No Linux CUDA buyer execution, cancellation, settlement or receipt lifecycle is verified for this corrected source. Do not treat catalogue availability, completed downloads, device detection or a software test as that evidence. No changed GPU binary has been published, and previous releases, signed manifests and assets remain unchanged.

See [recorded platform evidence](../../README.md#your-machine-your-controls), [security boundaries](../../SECURITY.md#model-runtime-boundaries) and the [remaining coverage checklist](remaining-work-checklist.md).
