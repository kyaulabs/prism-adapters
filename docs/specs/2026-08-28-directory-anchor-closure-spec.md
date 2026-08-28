# Directory anchor closure specification

**Date:** 2026-08-28
**Status:** Approved

## Purpose

Close the three Blocking findings recorded at review head
`da8b06c1cc4983868c460daf04b4f3d6d4f6d7cd`.

## Requirements

- Core range comparison must use exact arbitrary-precision integer components.
- Prepare and sign must open `.publisher` once with read-only, directory, and
  no-follow flags; validate the opened descriptor, mode `0700`, and identity
  against the repository path; retain it through payload I/O; and address
  `payload.json` through `/proc/self/fd/<fd>`.
- Prepare must write its temporary and final payload paths through the retained
  directory descriptor. Sign must read through the retained descriptor.
- Operations fail closed if Linux procfs descriptor paths, no-follow directory
  opens, or pathname/descriptor identity checks are unavailable.
- Tests use synthetic directories and ranges only. `catalogue.json` bytes must
  not change.

## Platform

Publisher operation now explicitly requires Linux procfs. No dependency is
added because Node.js does not expose portable `openat`-relative file I/O.

<!-- vim: ft=markdown sts=4 sw=4 ts=4 et : -->
