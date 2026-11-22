# @cpg/watch

Pipeline stage 1. Watches the filesystem, coalesces and debounces change events, and numbers each `ChangeBatch` per session. The delta `seq` is allocated by SINK (F-1), not here.
