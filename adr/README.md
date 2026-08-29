# Architecture Decision Records

This repository uses Nygard-style Architecture Decision Records for durable publisher decisions. Name records `NNNN-kebab-case-title.md`, use the next zero-padded sequence, and start from `0000-template.md`.

Accepted records are immutable. Correct or replace a decision by adding a new ADR and marking the prior record as superseded without rewriting its body.

The signed catalogue publication architecture originates in `kyaulabs/prism`. Local records adopt immutable upstream authority by reference and state which part this repository owns. A later upstream change does not silently alter local architecture; it requires explicit local review and, when necessary, a new or superseding ADR.

<!-- vim: ft=markdown sts=4 sw=4 ts=4 et : -->
